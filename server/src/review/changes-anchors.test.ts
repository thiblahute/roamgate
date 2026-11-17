import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReviewRpc } from "./rpc";
import { reviewServiceForTest } from "./testkit";
import { combinedAnchor } from "./changes-anchors";
import { parseUnifiedDiff } from "./patch";
import { readReviewPatch } from "../workspace/review-patch";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import type { ReviewSnapshot, ReviewThread } from "../../../shared/review";
import type { ReviewAnnotation } from "../../../web/src/annotations";
import {
  feedbackNote,
  feedbackThreadId,
  writeFeedback,
} from "../../../web/src/workspaceFeedback";

/*
 * Plan D13: threads written on Changes' staged and unstaged entries, moved
 * onto the worktree review's combined `git diff HEAD` by their line's
 * text, against the real review service and a real checkout (as
 * feedback-migration.test.ts writes notes).
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/**
 * HEAD a..f; the index adds S on top (staged); the working tree turns f
 * into F (unstaged) and has an untracked new.txt. The staged entry numbers
 * its new side in the index, the unstaged one its old side in the index:
 * the combined diff numbers old in HEAD, new in the working tree.
 */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "roamgate-anchors-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\nb\nc\nd\ne\nf\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base");
  writeFileSync(join(root, "a.txt"), "S\na\nb\nc\nd\ne\nf\n");
  git(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "S\na\nb\nc\nd\ne\nF\n");
  writeFileSync(join(root, "new.txt"), "one\ntwo\n");
  return root;
}

function server(root: string) {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-anchors-store-"));
  const loads: (readonly string[] | undefined)[] = [];
  const { service } = reviewServiceForTest({
    dir,
    loadDiff: async (session, _commit, options) => {
      loads.push(options?.paths);
      return readReviewPatch({
        root: session.root,
        target: session.target,
        paths: options?.paths,
        shQuote,
        runProcessWithCodeTimeout,
      });
    },
    deliveryDelayMs: 5,
  });
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const connection = {
    id: "local",
    resolveRoot: async () => root,
    readRoot: async () => root,
    readDefaultBase: async () => "main",
  };
  const call = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> =>
    (await handleReviewRpc(service, connection as never, method, params)) as T;
  return { service, call, loads, dir };
}

const note = (
  id: string,
  kind: "staged" | "unstaged" | "untracked" | "branch",
  side: "old" | "new",
  line: number,
  quote: string,
  path = "a.txt",
): ReviewAnnotation => ({
  id,
  source: "diff",
  path,
  kind,
  side,
  line,
  hunk: "@@",
  quote,
  comment: `On ${quote}`,
  createdAt: line,
});

async function threadsOf(
  call: ReturnType<typeof server>["call"],
  sessionId: string,
): Promise<Map<string, ReviewThread>> {
  const snapshot = await call<ReviewSnapshot>("review.get", {
    session_id: sessionId,
  });
  return new Map(snapshot.threads.map((thread) => [thread.id, thread]));
}

test("Changes' entry anchors move onto the combined diff by their line's text", async () => {
  const root = checkout();
  const { service, call, loads } = server(root);
  const place = { workspaceId: "w1", root };
  const notes = [
    // The staged entry's new side counts in the index: S is line 1 there
    // and in the working tree; c is line 4 in both.
    note("staged-new", "staged", "new", 1, "S"),
    note("staged-ctx", "staged", "new", 4, "c"),
    // Its old side is HEAD's, as the combined diff's.
    note("staged-old", "staged", "old", 6, "f"),
    // The unstaged entry's old side counts in the index: f is line 7 there,
    // line 6 in HEAD.
    note("unstaged-old", "unstaged", "old", 7, "f"),
    // Its new side is the working tree's, as the combined diff's.
    note("unstaged-new", "unstaged", "new", 7, "F"),
    note("untracked", "untracked", "new", 2, "two", "new.txt"),
    // Its words are nowhere in the diff now.
    note("gone", "unstaged", "old", 3, "no such line"),
  ];
  let held = 1;
  let sessionId = "";
  for (const each of notes)
    sessionId = (await writeFeedback(call, each, place, held++)).snapshot
      .session.id;
  // The first read (review.open by the first comment) migrates.
  await service.migrateEntryAnchors({ sessionId });
  const threads = await threadsOf(call, sessionId);
  const at = (id: string) => {
    const thread = threads.get(feedbackThreadId(id))!;
    const fed = feedbackNote(thread) as Extract<
      ReviewAnnotation,
      { source: "diff" }
    >;
    return {
      anchor: [thread.anchor.side, thread.anchor.line, thread.anchor.text],
      note: [fed.kind, fed.side, fed.line],
    };
  };
  expect(at("staged-new")).toEqual({
    anchor: ["new", 1, "S"],
    note: ["combined", "new", 1],
  });
  expect(at("staged-ctx")).toEqual({
    anchor: ["new", 4, "c"],
    note: ["combined", "new", 4],
  });
  expect(at("staged-old")).toEqual({
    anchor: ["old", 6, "f"],
    note: ["combined", "old", 6],
  });
  expect(at("unstaged-old")).toEqual({
    anchor: ["old", 6, "f"],
    note: ["combined", "old", 6],
  });
  expect(at("unstaged-new")).toEqual({
    anchor: ["new", 7, "F"],
    note: ["combined", "new", 7],
  });
  expect(at("untracked")).toEqual({
    anchor: ["new", 2, "two"],
    note: ["combined", "new", 2],
  });
  // Not found: kept as written, on its entry (listed, not drawn).
  expect(at("gone")).toEqual({
    anchor: ["old", 3, "no such line"],
    note: ["unstaged", "old", 3],
  });
  // Only the threads' files were read (each read of the review, as the
  // comments were written, looked at the threads it had then).
  expect(loads.length).toBeGreaterThan(0);
  for (const paths of loads)
    expect(paths?.every((path) => ["a.txt", "new.txt"].includes(path))).toBe(
      true,
    );
  // The words and the rest of the note are as written.
  const moved = threads.get(feedbackThreadId("unstaged-old"))!;
  expect(moved.comments[0]!.body).toBe("On f");
  expect(JSON.parse(moved.anchor.feedback!)).toMatchObject({
    id: "unstaged-old",
    source: "diff",
    path: "a.txt",
    quote: "f",
  });
});

test("the migration runs once: a second read writes nothing, a migrated thread is not read again", async () => {
  const root = checkout();
  const { service, call, loads } = server(root);
  const place = { workspaceId: "w1", root };
  const { snapshot } = await writeFeedback(
    call,
    note("u", "unstaged", "old", 7, "f"),
    place,
    1,
  );
  const sessionId = snapshot.session.id;
  await service.migrateEntryAnchors({ sessionId });
  const first = (await threadsOf(call, sessionId)).get(feedbackThreadId("u"))!;
  const updatedAt = first.updatedAt;
  await service.migrateEntryAnchors({ sessionId });
  service.list({ connectionId: "local" });
  await service.migrateEntryAnchors({ sessionId });
  const again = (await threadsOf(call, sessionId)).get(feedbackThreadId("u"))!;
  expect(again.anchor).toEqual(first.anchor);
  // Not a user edit.
  expect(again.updatedAt).toBe(updatedAt);
  expect(loads.filter(Boolean)).toHaveLength(1);
});

test("the migrated anchors are kept across a restart of the server", async () => {
  const root = checkout();
  const { service, call, dir } = server(root);
  const { snapshot } = await writeFeedback(
    call,
    note("u", "unstaged", "old", 7, "f"),
    { workspaceId: "w1", root },
    1,
  );
  await service.migrateEntryAnchors({ sessionId: snapshot.session.id });
  const { service: reopened } = reviewServiceForTest({
    dir,
    loadDiff: async () => {
      throw new Error("not read again");
    },
  });
  const thread = reopened
    .get({ sessionId: snapshot.session.id })
    .threads.find((each) => each.id === feedbackThreadId("u"))!;
  expect([thread.anchor.side, thread.anchor.line]).toEqual(["old", 6]);
});

test("a branch review's threads and a range review are left alone", async () => {
  const root = checkout();
  const { service, call, loads } = server(root);
  const { snapshot } = await writeFeedback(
    call,
    note("b", "branch", "new", 7, "F"),
    { workspaceId: "w1", root },
    1,
  );
  await service.migrateEntryAnchors({ sessionId: snapshot.session.id });
  expect(snapshot.session.target.kind).toBe("range");
  const thread = (await threadsOf(call, snapshot.session.id)).get(
    feedbackThreadId("b"),
  )!;
  expect(JSON.parse(thread.anchor.feedback!).kind).toBe("branch");
  expect(loads.filter(Boolean)).toEqual([]);
});

test("a review read publishes it again once its threads moved", async () => {
  const root = checkout();
  const pushes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "roamgate-anchors-store-"));
  const { service } = reviewServiceForTest({
    dir,
    publish: (push) => {
      if (push.type === "session")
        pushes.push(
          push.snapshot.threads.map((thread) => thread.anchor.line).join(","),
        );
    },
    loadDiff: (session, _commit, options) =>
      readReviewPatch({
        root: session.root,
        target: session.target,
        paths: options?.paths,
        shQuote,
        runProcessWithCodeTimeout,
      }),
  });
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const opened = service.open({
    connectionId: "local",
    root,
    target: { kind: "worktree" },
  });
  await service.addThread({
    sessionId: opened.session.id,
    anchor: {
      path: "a.txt",
      line: 7,
      side: "old",
      text: "f",
      feedback: JSON.stringify(note("u", "unstaged", "old", 7, "f")),
    },
    text: "On f",
  });
  pushes.length = 0;
  service.get({ sessionId: opened.session.id });
  await service.migrateEntryAnchors({ sessionId: opened.session.id });
  expect(pushes).toEqual(["6"]);
});

test("combinedAnchor: a comment on the file keeps no line, a range keeps its length", () => {
  const [file] = parseUnifiedDiff(
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n+top\n a\n-b\n+B\n c\n",
  );
  const thread = (anchor: ReviewThread["anchor"]): ReviewThread => ({
    id: "t",
    sessionId: "s",
    kind: "discussion",
    anchor,
    comments: [],
    resolved: false,
    createdAt: "",
    updatedAt: "",
  });
  const onFile = combinedAnchor(
    thread({
      path: "f",
      feedback: JSON.stringify({ source: "diff", kind: "staged", path: "f" }),
    }),
    undefined,
  );
  expect(onFile?.line).toBeUndefined();
  expect(JSON.parse(onFile!.feedback!).kind).toBe("combined");
  // An unstaged entry's old side (the index) from a to b, lines 1 to 2:
  // HEAD numbers them alike here, the end follows the start.
  const range = combinedAnchor(
    thread({
      path: "f",
      line: 1,
      endLine: 2,
      side: "old",
      text: "a",
      feedback: JSON.stringify({
        source: "diff",
        kind: "unstaged",
        path: "f",
        side: "old",
        line: 1,
        endLine: 2,
        endSide: "old",
      }),
    }),
    file,
  );
  expect([range?.side, range?.line, range?.endLine]).toEqual(["old", 1, 2]);
  // A staged entry's new side (the index) on B, line 2 there: the working
  // tree's line 3.
  const moved = combinedAnchor(
    thread({
      path: "f",
      line: 2,
      side: "new",
      text: "B",
      feedback: JSON.stringify({
        source: "diff",
        kind: "staged",
        path: "f",
        side: "new",
        line: 2,
      }),
    }),
    file,
  );
  expect([moved?.side, moved?.line]).toEqual(["new", 3]);
  // Already combined: nothing to do.
  expect(
    combinedAnchor(
      thread({
        path: "f",
        line: 3,
        side: "new",
        text: "B",
        feedback: JSON.stringify({ source: "diff", kind: "combined" }),
      }),
      file,
    ),
  ).toBeNull();
});

test("a checkout not readable yet (a connection not ready, at startup) is asked again later", async () => {
  const root = checkout();
  let ready = false;
  let now = Date.parse("2026-11-15T10:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "roamgate-anchors-store-"));
  const { service } = reviewServiceForTest({
    dir,
    now: () => new Date(now),
    loadDiff: async (session, _commit, options) => {
      if (!ready) throw new Error("connection not ready");
      return readReviewPatch({
        root: session.root,
        target: session.target,
        paths: options?.paths,
        shQuote,
        runProcessWithCodeTimeout,
      });
    },
  });
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const opened = service.open({
    connectionId: "local",
    root,
    target: { kind: "worktree" },
  });
  const thread = await service.addThread({
    sessionId: opened.session.id,
    anchor: {
      path: "a.txt",
      line: 7,
      side: "old",
      text: "f",
      feedback: JSON.stringify(note("u", "unstaged", "old", 7, "f")),
    },
    text: "On f",
  });
  const line = () =>
    service
      .get({ sessionId: opened.session.id })
      .threads.find((each) => each.id === thread.id)!.anchor.line;
  await service.migrateEntryAnchors({ sessionId: opened.session.id });
  expect(line()).toBe(7);
  ready = true;
  // Not at once: 5 s later.
  await service.migrateEntryAnchors({ sessionId: opened.session.id });
  expect(line()).toBe(7);
  now += 6_000;
  await service.migrateEntryAnchors({ sessionId: opened.session.id });
  expect(line()).toBe(6);
});
