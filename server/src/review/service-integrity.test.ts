import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_LIMITS,
  type ReviewSession,
  type ReviewSnapshot,
} from "../../../shared/review";
import { handleReviewRpc } from "./rpc";
import { createReviewService, type ReviewService } from "./service";
import { openReviewStorage } from "./storage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix = "roamgate-review-integrity-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(
  dir = tempDir(),
  extra: Partial<Parameters<typeof createReviewService>[0]> = {},
) {
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    ...extra,
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    service.close();
  };
  cleanups.push(close);
  return { dir, service, close };
}

function openSession(service: ReviewService) {
  return service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "HEAD" },
  }).session;
}

const local = { id: "local", resolveRoot: async () => "/repo" };

/**
 * A service whose images and database live in REVIEW_DIR, under a temp
 * folder with a sentinel file next to it.
 */
function setupWithReviewDir() {
  const base = tempDir("roamgate-review-rpc-dir-");
  const dir = join(base, "reviews");
  mkdirSync(dir);
  const sentinel = join(base, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");
  const previous = process.env.ROAMGATE_REVIEW_DIR;
  process.env.ROAMGATE_REVIEW_DIR = dir;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.ROAMGATE_REVIEW_DIR;
    else process.env.ROAMGATE_REVIEW_DIR = previous;
  });
  const { service } = setup(dir);
  return { service, dir, sentinel };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

test("an imported review id cannot walk out of the review folder", async () => {
  const { service, sentinel } = setupWithReviewDir();
  const at = new Date().toISOString();
  const snapshot = {
    session: {
      id: "../..",
      connectionId: local.id,
      root: "/repo",
      title: "Escape",
      target: { kind: "worktree" },
      summary: "",
      agent: {},
      createdAt: at,
      updatedAt: at,
    },
    threads: [],
  };
  const imported = await handleReviewRpc(service, local, "review.import", {
    snapshot,
  }).then(
    () => "imported",
    () => "refused",
  );
  // Removing it next must not reach outside either.
  const removed = await handleReviewRpc(service, local, "review.remove", {
    session_id: "../..",
  }).then(
    () => "removed",
    () => "refused",
  );
  expect(imported).toBe("refused");
  expect(removed).toBe("refused");
  expect(service.list()).toEqual([]);
  expect(existsSync(sentinel)).toBe(true);
});

test("removing a review keeps its images for the list's undo", async () => {
  const { service, dir } = setupWithReviewDir();
  const opened = (await handleReviewRpc(service, local, "review.open", {
    workspace_id: "w1",
    target: { kind: "worktree" },
  })) as ReviewSnapshot;
  const id = opened.session.id;
  const { path } = (await handleReviewRpc(service, local, "review.image.add", {
    session_id: id,
    type: "image/png",
    data: PNG.toString("base64"),
  })) as { path: string };
  expect(path.startsWith(join(dir, "images", id))).toBe(true);
  const snapshot = (await handleReviewRpc(service, local, "review.get", {
    session_id: id,
  })) as ReviewSnapshot;

  await handleReviewRpc(service, local, "review.remove", { session_id: id });
  expect(existsSync(path)).toBe(true);
  // The undo imports the review again, and its image is still there.
  await handleReviewRpc(service, local, "review.import", { snapshot });
  expect(service.list().map((s) => s.session.id)).toEqual([id]);
  expect(existsSync(path)).toBe(true);
});

test("an import is rebuilt field by field: ids that are not ours are refused", () => {
  const { service } = setup();
  const snapshot = (session: Record<string, unknown>) => ({
    connectionId: "local",
    snapshot: {
      session: {
        connectionId: "local",
        root: "/repo",
        title: "t",
        target: { kind: "worktree" },
        ...session,
      },
      threads: [],
    },
  });
  for (const id of ["../..", "", 42, undefined, "ABCDEF0123456789"])
    expect(() => service.importSession(snapshot({ id }))).toThrow();
  expect(() =>
    service.importSession(snapshot({ id: "0123456789abcdef", root: "-L" })),
  ).toThrow("invalid root");
  expect(() =>
    service.importSession(snapshot({ id: "0123456789abcdef", root: 7 })),
  ).toThrow();
  expect(service.list()).toHaveLength(0);
  const restored = service.importSession(
    snapshot({
      id: "0123456789abcdef",
      seenHeadSha: { not: "a sha" },
      holdComments: "yes",
      reviewed: { "diff:a.txt": "f1" },
    }),
  );
  expect(restored.session.id).toBe("0123456789abcdef");
  expect(restored.session.seenHeadSha).toBeUndefined();
  expect(restored.session.holdComments).toBeUndefined();
  expect(restored.session.reviewed).toEqual({ "diff:a.txt": "f1" });
  // A Windows root is a root.
  const windows = service.importSession(
    snapshot({ id: "fedcba9876543210", root: "C:/work/repo" }),
  );
  expect(windows.session.root).toBe("C:/work/repo");
});

test("an import never takes over another connection's review", () => {
  const { service } = setup();
  const theirs = openSession(service);
  expect(() =>
    service.importSession({
      connectionId: "other",
      snapshot: {
        session: {
          id: theirs.id,
          connectionId: "other",
          root: "/repo",
          title: "t",
          target: { kind: "worktree" },
        },
        threads: [],
      },
    }),
  ).toThrow("invalid review id");
});

test("an import with too many threads is refused before anything is kept", () => {
  const { service } = setup();
  const id = "0123456789abcdef";
  const thread = { sessionId: id, comments: [{ author: "you", body: "x" }] };
  expect(() =>
    service.importSession({
      connectionId: "local",
      snapshot: {
        session: {
          id,
          connectionId: "local",
          root: "/repo",
          title: "t",
          target: { kind: "worktree" },
        },
        threads: Array.from({ length: 2001 }, () => thread),
      },
    }),
  ).toThrow("too many comments");
  expect(service.list()).toHaveLength(0);
});

test("an import with an invalid thread keeps nothing", () => {
  const { dir, service, close } = setup();
  const id = "0123456789abcdef";
  expect(() =>
    service.importSession({
      connectionId: "local",
      snapshot: {
        session: {
          id,
          connectionId: "local",
          root: "/repo",
          title: "t",
          target: { kind: "worktree" },
        },
        threads: [
          { sessionId: id, comments: [{ author: "you", body: "fine" }] },
          { sessionId: id, comments: [{ author: "you", body: "   " }] },
        ],
      },
    }),
  ).toThrow("text is empty");
  expect(service.list()).toHaveLength(0);
  close();
  expect(setup(dir).service.list()).toHaveLength(0);
});

test("an import keeps only the review's own threads", () => {
  const { service } = setup();
  const id = "0123456789abcdef";
  const back = service.importSession({
    connectionId: "local",
    snapshot: {
      session: {
        id,
        connectionId: "local",
        root: "/repo",
        title: "t",
        target: { kind: "worktree" },
      },
      threads: [
        { sessionId: id, comments: [{ author: "you", body: "Mine" }] },
        // A merge request's snapshot shows GitLab's threads and the
        // pending drafts of other reviews: those are not this review's.
        {
          sessionId: id,
          gitlab: { draftId: 3 },
          comments: [{ author: "you", body: "On GitLab" }],
        },
        {
          sessionId: "fedcba9876543210",
          comments: [{ author: "you", body: "Another review's" }],
        },
      ],
    },
  });
  expect(back.threads.map((thread) => thread.comments[0]!.body)).toEqual([
    "Mine",
  ]);
});

test("a review past the limit is not imported", () => {
  const { service } = setup(undefined, { sessionLimit: 3 });
  for (let index = 0; index < 3; index++)
    service.open({
      connectionId: "local",
      root: `/repo/${index}`,
      target: { kind: "worktree" },
      raise: false,
    });
  expect(() =>
    service.importSession({
      connectionId: "local",
      snapshot: {
        session: {
          id: "0123456789abcdef",
          connectionId: "local",
          root: "/repo",
          title: "t",
          target: { kind: "worktree" },
        },
        threads: [],
      },
    }),
  ).toThrow("too many reviews (3, the limit is 3)");
});

test("a new review past the limit is refused, saying how to make room", () => {
  const { service } = setup(undefined, { sessionLimit: 2 });
  for (let index = 0; index < 2; index++)
    service.open({
      connectionId: "local",
      root: `/repo/${index}`,
      target: { kind: "worktree" },
      raise: false,
    });
  expect(() =>
    service.open({
      connectionId: "local",
      root: "/repo/2",
      target: { kind: "worktree" },
      raise: false,
    }),
  ).toThrow(
    "too many reviews (2, the limit is 2); delete old ones in the reviews list to make room",
  );
  // An existing review still opens.
  expect(
    service.open({
      connectionId: "local",
      root: "/repo/0",
      target: { kind: "worktree" },
      raise: false,
    }).session.root,
  ).toBe("/repo/0");
});

test("a work item's review is opened past the limit", () => {
  const { service } = setup(undefined, { sessionLimit: 1 });
  service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "worktree" },
    raise: false,
  });
  const work = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "work", item: "0123abcd" },
    raise: false,
  });
  expect(work.session.target).toEqual({ kind: "work", item: "0123abcd" });
  expect(() =>
    service.open({
      connectionId: "local",
      root: "/repo/other",
      target: { kind: "worktree" },
      raise: false,
    }),
  ).toThrow("too many reviews");
});

test("a work item's review is found without listing every review", async () => {
  let at = Date.parse("2026-11-22T10:00:00Z");
  const { service } = setup(undefined, {
    now: () => new Date((at += 1_000)),
  });
  const workOn = (connectionId: string, item: string) =>
    service.open({
      connectionId,
      root: "/repo",
      target: { kind: "work", item },
      raise: false,
    }).session;
  const first = workOn("a", "0123abcd");
  const second = workOn("b", "0123abcd");
  workOn("a", "4567cdef");
  const ofItem = (session: ReviewSession) =>
    session.target.kind === "work" && session.target.item === "0123abcd";
  // The newest of the item's reviews, as the list would answer.
  expect(service.newest(ofItem)?.session.id).toBe(second.id);
  await service.addThread({
    sessionId: first.id,
    anchor: {},
    text: "Newer now",
  });
  const found = service.newest(ofItem);
  expect(found?.session.id).toBe(first.id);
  expect(found).toEqual(
    service.list({ chats: true }).find(({ session }) => ofItem(session)) ??
      null,
  );
  // By an id's prefix, and none.
  expect(
    service.newest((session) => session.id.startsWith(second.id.slice(0, 8)))
      ?.session.id,
  ).toBe(second.id);
  expect(service.newest(() => false)).toBeNull();
});

test("the store keeps thousands of reviews", () => {
  expect(REVIEW_LIMITS.sessions).toBeGreaterThanOrEqual(10_000);
});

test("a restored thread cannot overwrite another review's thread", async () => {
  const { dir, service, close } = setup();
  const mine = openSession(service);
  const theirs = service.open({
    connectionId: "other",
    root: "/srv",
    target: { kind: "worktree" },
  }).session;
  const original = await service.addThread({
    sessionId: theirs.id,
    text: "Theirs",
  });
  const restored = service.restoreThread({
    sessionId: mine.id,
    thread: { id: original.id, comments: [{ author: "you", body: "Mine" }] },
  });
  expect(restored.id).not.toBe(original.id);
  close();
  const kept = setup(dir).service.get({ sessionId: theirs.id }).threads;
  expect(kept.map((thread) => thread.comments[0]!.body)).toEqual(["Theirs"]);
  expect(kept[0]!.sessionId).toBe(theirs.id);
});

test("restoring threads past the limit is refused", async () => {
  const { service } = setup();
  const session = openSession(service);
  const thread = { comments: [{ author: "you", body: "x" }] };
  for (let index = 0; index < 2000; index++)
    service.restoreThread({ sessionId: session.id, thread });
  expect(() =>
    service.restoreThread({ sessionId: session.id, thread }),
  ).toThrow("too many comments");
  expect(service.get({ sessionId: session.id }).threads).toHaveLength(2000);
}, 30_000);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Loaded = { files: []; truncated: false; headSha: string };

test("a review removed while its diff loads stays removed", async () => {
  const load = deferred<Loaded>();
  const { dir, service, close } = setup(undefined, {
    loadDiff: () => load.promise,
  });
  const session = openSession(service);
  const loading = service.diff({ sessionId: session.id });
  service.remove({ sessionId: session.id });
  load.resolve({ files: [], truncated: false, headSha: "a".repeat(40) });
  await loading;
  close();
  expect(setup(dir).service.list()).toHaveLength(0);
});

test("an older diff answering late does not overwrite the head last seen", async () => {
  const loads: ReturnType<typeof deferred<Loaded>>[] = [];
  const { service } = setup(undefined, {
    loadDiff: () => {
      const load = deferred<Loaded>();
      loads.push(load);
      return load.promise;
    },
  });
  const session = openSession(service);
  const first = service.diff({ sessionId: session.id });
  const second = service.diff({ sessionId: session.id });
  loads[1]!.resolve({ files: [], truncated: false, headSha: "b".repeat(40) });
  await second;
  loads[0]!.resolve({ files: [], truncated: false, headSha: "a".repeat(40) });
  await first;
  expect(service.get({ sessionId: session.id }).session.seenHeadSha).toBe(
    "b".repeat(40),
  );
  // A retarget during a load: the old range's head is not recorded.
  const third = service.diff({ sessionId: session.id });
  await service.update({ sessionId: session.id, base: "develop" });
  loads[2]!.resolve({ files: [], truncated: false, headSha: "c".repeat(40) });
  await third;
  expect(
    service.get({ sessionId: session.id }).session.seenHeadSha,
  ).toBeUndefined();
});

test("a refused update changes nothing", async () => {
  const { dir, service, close } = setup();
  const session = openSession(service);
  await expect(
    service.update({
      sessionId: session.id,
      summary: "Overall",
      title: 42,
    }),
  ).rejects.toThrow("title is required");
  await expect(
    service.update({
      sessionId: session.id,
      autoSend: false,
      title: "Renamed",
      holdComments: "yes",
    }),
  ).rejects.toThrow("invalid hold flag");
  await expect(
    service.update({
      sessionId: session.id,
      reviewed: { "diff:a.txt": "f1" },
      base: "--bad",
    }),
  ).rejects.toThrow("invalid base");
  const now = service.get({ sessionId: session.id }).session;
  expect(now.summary).toBe("");
  expect(now.title).toBe("main..HEAD");
  expect(now.autoSend).toBe(true);
  expect(now.reviewed).toBeUndefined();
  close();
  const reopened = setup(dir).service.get({ sessionId: session.id }).session;
  expect(reopened.summary).toBe("");
  expect(reopened.autoSend).toBe(true);
});

test("the browser opens a review of a Windows path it picked", async () => {
  const { service } = setup();
  const asked: string[] = [];
  const windows = {
    id: "local",
    resolveRoot: async () => "C:/workspace",
    readRoot: async (path: string) => {
      asked.push(path);
      return "C:/work/repo";
    },
  };
  const opened = (await handleReviewRpc(service, windows, "review.open", {
    workspace_id: "w1",
    path: "C:\\work\\repo",
    target: { kind: "worktree" },
  })) as ReviewSnapshot;
  expect(asked).toEqual(["C:\\work\\repo"]);
  expect(opened.session.root).toBe("C:/work/repo");
});

test("a review's diff asked as a summary reads its files' list, and its files a few at a time against the summary's commits", async () => {
  const calls: string[] = [];
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const { service } = setup(undefined, {
    loadDiff: async () => {
      calls.push("whole");
      return { files: [], truncated: false, headSha: head };
    },
    loadSummary: async (_session, commit) => {
      calls.push(`summary ${commit ?? "all"}`);
      return {
        files: [
          { path: "a.ts", oldPath: "a.ts", hunks: [], status: "modified" },
        ],
        baseSha: base,
        headSha: head,
        truncated: false,
        summary: true,
      };
    },
    loadFiles: async (_session, ends, files) => {
      calls.push(
        `files ${ends.base.slice(0, 1)}..${ends.head.slice(0, 1)} ${files.map((f) => `${f.oldPath ?? ""}>${f.path}`).join(",")}`,
      );
      return files.map((f) => ({
        path: f.path,
        oldPath: f.oldPath ?? f.path,
        hunks: [],
      }));
    },
  });
  const session = openSession(service);
  const summary = await service.diff({ sessionId: session.id, summary: true });
  expect(summary.summary).toBe(true);
  // The head the user saw is recorded from the summary too.
  expect(service.get({ sessionId: session.id }).session.seenHeadSha).toBe(head);
  await service.diff({
    sessionId: session.id,
    summary: true,
    commit: "c0ffee1",
  });
  const read = await service.diff({
    sessionId: session.id,
    base,
    head,
    files: [{ path: "a.ts" }, { path: "b.ts", oldPath: "old/b.ts" }],
  });
  expect(read.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  // Without `summary`, the whole diff as before.
  await service.diff({ sessionId: session.id });
  expect(calls).toEqual([
    "summary all",
    "summary c0ffee1",
    "files a..b >a.ts,old/b.ts>b.ts",
    "whole",
  ]);
  // Paths out of the checkout, names that are not commits, too many files.
  for (const bad of [
    { base, head, files: [{ path: "../x" }] },
    { base: "main", head, files: [{ path: "a.ts" }] },
    { base, head, files: [] },
    {
      base,
      head,
      files: Array.from({ length: 33 }, (_, i) => ({ path: `f${i}` })),
    },
  ])
    await expect(
      service.diff({ sessionId: session.id, ...bad }),
    ).rejects.toThrow();
  expect(calls).toHaveLength(4);
});
