import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReviewSession,
  ReviewSnapshot,
  ReviewThread,
} from "../../../shared/review";
import {
  WORK_NO_OWNER,
  WORK_SESSION_PREFIX,
  type WorkItem,
  type WorkPush,
} from "../../../shared/work";
import { reviewServiceForTest } from "../review/testkit";
import { handleWorkRpc, isWorkMethod } from "./rpc";
import {
  createWorkService,
  decisionDecided,
  type WorkGit,
  type WorkReviews,
  type WorkServiceDeps,
} from "./service";
import { openWorkStore, WorkError } from "./store";
import { workTool } from "./tools";

const dirs: string[] = [];
function dir() {
  const made = mkdtempSync(join(tmpdir(), "roamgate-work-"));
  dirs.push(made);
  return made;
}
afterEach(() => {
  for (const each of dirs.splice(0))
    rmSync(each, { recursive: true, force: true });
});

/** An in-memory review store with just what the work service asks of it. */
function fakeReviews(): WorkReviews & {
  sessions: Map<string, ReviewSnapshot>;
  added: { sessionId: string; author: string; text: string }[];
} {
  const sessions = new Map<string, ReviewSnapshot>();
  const added: { sessionId: string; author: string; text: string }[] = [];
  let n = 0;
  const id = () => (++n).toString(16).padStart(16, "0");
  const find = (itemId: string) =>
    [...sessions.values()].find(
      (s) =>
        s.session.target.kind === "work" && s.session.target.item === itemId,
    ) ?? null;
  return {
    sessions,
    added,
    find,
    open(input) {
      const found = find(input.item);
      if (found) return found;
      const session: ReviewSession = {
        id: id(),
        connectionId: input.connectionId,
        root: input.root,
        title: input.title,
        target: { kind: "work", item: input.item },
        gitlab: false,
        summary: "",
        agent: { name: "Claude" },
        createdAt: "2026-11-20T10:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
      };
      const snapshot = { session, threads: [] };
      sessions.set(session.id, snapshot);
      return snapshot;
    },
    get(reviewId) {
      return (
        [...sessions.values()].find((s) => s.session.id.startsWith(reviewId)) ??
        null
      );
    },
    sessionOfComment(ref) {
      for (const snapshot of sessions.values())
        for (const thread of snapshot.threads)
          if (
            thread.id.startsWith(ref) ||
            thread.comments.some((c) => c.id.startsWith(ref))
          )
            return snapshot.session;
      return null;
    },
    async addThread(input) {
      added.push({
        sessionId: input.sessionId,
        author: input.author,
        text: input.text,
      });
      const snapshot = sessions.get(input.sessionId)!;
      const thread: ReviewThread = {
        id: id(),
        sessionId: input.sessionId,
        kind: "discussion",
        anchor: input.anchor,
        comments: [
          {
            id: id(),
            author: input.author,
            body: input.text,
            createdAt: "2026-11-20T10:01:00.000Z",
            updatedAt: "2026-11-20T10:01:00.000Z",
          },
        ],
        resolved: false,
        createdAt: "2026-11-20T10:01:00.000Z",
        updatedAt: "2026-11-20T10:01:00.000Z",
      };
      snapshot.threads.push(thread);
      return thread;
    },
    moveThread(input) {
      for (const snapshot of sessions.values()) {
        const at = snapshot.threads.findIndex(
          (t) => t.id === input.threadId || t.id.startsWith(input.threadId),
        );
        if (at < 0) continue;
        const [thread] = snapshot.threads.splice(at, 1);
        const moved: ReviewThread = {
          ...thread!,
          sessionId: input.sessionId,
          anchor: input.anchor,
          handedAt: "2026-11-20T10:02:00.000Z",
        };
        sessions.get(input.sessionId)!.threads.push(moved);
        return moved;
      }
      throw new Error("no such thread");
    },
    // As the review service: only the comment's author rewrites or deletes.
    async editComment(input) {
      const snapshot = sessions.get(input.sessionId)!;
      for (const thread of snapshot.threads) {
        const comment = thread.comments.find((c) => c.id === input.commentId);
        if (!comment) continue;
        if (comment.author !== input.author)
          throw new Error("an agent can only edit its own comments");
        comment.body = input.text;
        return thread;
      }
      throw new Error("no such comment");
    },
    async deleteComment(input) {
      const snapshot = sessions.get(input.sessionId)!;
      for (const [at, thread] of snapshot.threads.entries()) {
        const index = thread.comments.findIndex(
          (c) => c.id === input.commentId,
        );
        if (index < 0) continue;
        if (thread.comments[index]!.author !== input.author)
          throw new Error("an agent can only delete its own comments");
        if (index === 0) {
          snapshot.threads.splice(at, 1);
          return { deleted: thread.id, thread: null };
        }
        thread.comments.splice(index, 1);
        return { deleted: input.commentId, thread };
      }
      throw new Error("no such comment");
    },
  };
}

/** The real review service, as the server gives it to the work service. */
function realReviews(
  review: ReturnType<typeof reviewServiceForTest>["service"],
): WorkReviews {
  return {
    find: (itemId) =>
      review
        .list({ chats: true })
        .find(
          ({ session }) =>
            session.target.kind === "work" && session.target.item === itemId,
        ) ?? null,
    open: (input) =>
      review.open({
        connectionId: input.connectionId,
        root: input.root,
        target: { kind: "work", item: input.item },
        title: input.title,
        agent: "Claude",
        raise: false,
      }),
    get: (reviewId) =>
      review
        .list({ chats: true })
        .find(({ session }) => session.id.startsWith(reviewId)) ?? null,
    sessionOfComment: (ref) =>
      review
        .list({ chats: true })
        .find(({ threads }) =>
          threads.some(
            (thread) =>
              thread.id === ref ||
              thread.id.startsWith(ref) ||
              thread.comments.some(
                (comment) => comment.id === ref || comment.id.startsWith(ref),
              ),
          ),
        )?.session ?? null,
    addThread: (input) =>
      review.addThread({
        sessionId: input.sessionId,
        author: input.author,
        text: input.text,
        anchor: input.anchor,
        kind: "discussion",
      }),
    moveThread: (input) =>
      review.moveThread({
        sessionId: input.sessionId,
        threadId: input.threadId,
        anchor: input.anchor,
      }),
  };
}

function setup(over: Partial<WorkServiceDeps> = {}) {
  const pushes: WorkPush[] = [];
  const notified: string[] = [];
  const cleared: string[] = [];
  const reviews = fakeReviews();
  let clock = 0;
  const service = createWorkService({
    store: openWorkStore(dir()),
    now: () => new Date(Date.UTC(2026, 10, 20, 10, 0, clock++)).toISOString(),
    publish: (push) => pushes.push(push),
    reviews,
    notifications: {
      publish: (item) => notified.push(item.id),
      clear: (item) => cleared.push(item.id),
    },
    defaultConnection: () => "desktop",
    ownRoot: () => "/home/me/roamgate",
    ...over,
  });
  return { service, pushes, notified, cleared, reviews };
}

/** A TODO file's review with one thread, as the coordinator kept them. */
function todoReview(resolved = false): ReviewSnapshot {
  return {
    session: {
      id: "d22a2f86bc540f34",
      connectionId: "desktop",
      root: "/home/me/roamgate.worktrees",
      title: "Roamgate TODO",
      target: { kind: "rendered", path: "plans/todo.md" },
      gitlab: false,
      summary: "",
      agent: { name: "Claude", paneId: "w35:p1" },
      createdAt: "2026-11-20T09:00:00.000Z",
      updatedAt: "2026-11-20T09:00:00.000Z",
    },
    threads: [
      {
        id: "b057f8a2129c74bc",
        sessionId: "d22a2f86bc540f34",
        kind: "discussion",
        anchor: {
          path: "plans/todo.md",
          line: 14,
          text: "## Reviews and Files",
          render: { quote: "Reviews and Files" },
        },
        comments: [
          {
            id: "c1c1c1c1c1c1c1c1",
            author: "you",
            body: "**doing** Fold a reviewed chunk again\n\nDetails here.",
            createdAt: "2026-11-20T09:01:00.000Z",
            updatedAt: "2026-11-20T09:01:00.000Z",
          },
          {
            id: "c2c2c2c2c2c2c2c2",
            author: "Claude",
            body: "Taken.",
            createdAt: "2026-11-20T09:02:00.000Z",
            updatedAt: "2026-11-20T09:02:00.000Z",
          },
        ],
        resolved,
        createdAt: "2026-11-20T09:01:00.000Z",
        updatedAt: "2026-11-20T09:02:00.000Z",
      },
    ],
  };
}

describe("work service", () => {
  test("seeds the roamgate project and adds, moves, finishes and reopens items", async () => {
    const { service, pushes, notified, cleared } = setup();
    const board = service.board();
    expect(board.projects.map((p) => p.id)).toEqual(["roamgate"]);
    expect(board.projects[0]!.done).toEqual({ kind: "deployed" });

    const item = await service.add(
      { title: "  Fix the keys  ", tags: ["Reviews"], owner: "desktop/w35:p1" },
      { by: "agent", caller: "Claude in roamgate" },
    );
    expect(item.state).toBe("open");
    expect(item.tags).toEqual(["reviews"]);
    expect(item.owner).toEqual({ session: "desktop/w35:p1" });
    expect(pushes.find((push) => push.summary)).toMatchObject({
      changed: ["items"],
      item: item.id,
      by: "agent",
      summary: 'Claude in roamgate added "Fix the keys"',
    });
    expect(notified).toEqual([]);

    const forYou = await service.update(
      { item: item.id, state: "you" },
      { by: "agent" },
    );
    expect(forYou.state).toBe("you");
    expect(notified).toEqual([item.id]);
    const doing = await service.update(
      { item: item.id.slice(0, 8), state: "doing", add_tags: ["phone"] },
      { by: "user" },
    );
    expect(doing.tags).toEqual(["reviews", "phone"]);
    expect(cleared).toEqual([item.id]);
    // Back to For you notifies again: once per entry.
    await service.update({ item: item.id, state: "you" }, { by: "user" });
    expect(notified).toEqual([item.id, item.id]);

    const done = service.done(
      {
        item: item.id,
        landed: { commit: "abcdef1234", subject: "Fix the keys" },
      },
      { by: "agent" },
    );
    expect(done.state).toBe("done");
    expect(done.doneAt).toBeTruthy();
    expect(done.links).toEqual([
      { kind: "commit", sha: "abcdef1234", subject: "Fix the keys" },
    ]);
    const back = await service.reopen(
      { item: item.id, state: "verify" },
      { by: "user" },
    );
    expect(back.state).toBe("verify");
    expect(back.doneAt).toBeUndefined();
    await expect(
      service.reopen({ item: item.id, state: "done" }, { by: "user" }),
    ).rejects.toThrow(WorkError);
    await expect(
      service.update({ item: "ffffffff", state: "open" }, { by: "user" }),
    ).rejects.toThrow(/no work item/);
    expect(service.list({ open: true }).map((i) => i.id)).toEqual([item.id]);
    expect(service.list({ tags: ["phone"] }).map((i) => i.id)).toEqual([
      item.id,
    ]);
    expect(service.list({ tags: ["voice"] })).toEqual([]);
  });

  test("an import keeps its dates and its source, and the same source changes the item", async () => {
    const { service } = setup();
    const first = await service.add(
      {
        title: "Headset muting after each turn",
        state: "done",
        tags: ["voice"],
        source: "imported from plans/todo.md line 107",
        created_at: "2026-11-19T08:00:00Z",
        done_at: "2026-11-19T18:30:00.000Z",
      },
      { by: "agent" },
    );
    expect(first.createdAt).toBe("2026-11-19T08:00:00.000Z");
    expect(first.doneAt).toBe("2026-11-19T18:30:00.000Z");
    expect(first.source).toBe("imported from plans/todo.md line 107");
    // Run again with a tag more: the same item, changed, and said so.
    const again = await service.addOrUpdate(
      {
        title: "Headset muting after each turn",
        state: "done",
        tags: ["voice", "calls"],
        text: "A description the item already has",
        source: "imported from plans/todo.md line 107",
        created_at: "2026-11-19T08:00:00Z",
      },
      { by: "agent" },
    );
    expect(again.item.id).toBe(first.id);
    expect(again.updated).toBe(true);
    expect(again.changed).toEqual({ tags: ["voice", "calls"] });
    expect(again.ignored).toEqual(["text"]);
    expect(again.item.doneAt).toBe("2026-11-19T18:30:00.000Z");
    expect(service.board().items.length).toBe(1);
    // A different title is never slipped in: refused, unless asked.
    await expect(
      service.add(
        {
          title: "Headset (boom mic) muting after each turn",
          source: "imported from plans/todo.md line 107",
        },
        { by: "agent" },
      ),
    ).rejects.toThrow(/exists in roamgate: .* replace: true/);
    expect(service.store.item(first.id)!.title).toBe(
      "Headset muting after each turn",
    );
    const retitled = await service.addOrUpdate(
      {
        title: "Headset (boom mic) muting after each turn",
        source: "imported from plans/todo.md line 107",
        replace: true,
      },
      { by: "agent" },
    );
    expect(retitled.updated).toBe(true);
    expect(retitled.changed).toEqual({
      title: "Headset (boom mic) muting after each turn",
    });
    expect(retitled.item.tags).toEqual(["voice", "calls"]);
    // Nothing new: updated, nothing changed.
    const same = await service.addOrUpdate(
      {
        title: "Headset (boom mic) muting after each turn",
        source: "imported from plans/todo.md line 107",
      },
      { by: "agent" },
    );
    expect(same).toMatchObject({ updated: true, changed: {} });
    expect(service.board().items.length).toBe(1);
    // Another project may hold the same source: its own item.
    service.projectSet({ name: "gst2", roots: ["/g"] }, { by: "user" });
    const other = await service.add(
      {
        project: "gst2",
        title: "Other",
        source: "imported from plans/todo.md line 107",
      },
      { by: "agent" },
    );
    expect(other.id).not.toBe(first.id);
    await expect(
      service.add({ title: "x", created_at: "yesterday" }, { by: "user" }),
    ).rejects.toThrow(/created_at/);
  });

  test("declares a project with a branch rule and scopes items to it", async () => {
    const { service } = setup();
    const project = service.projectSet(
      {
        name: "gst2",
        roots: [
          "/home/me/gstreamer/2.0",
          { connectionId: "desktop", path: "/home/me/gstreamer/2.0/gstreamer" },
        ],
        done: {
          kind: "branch",
          root: "/home/me/gstreamer/2.0/gstreamer",
          branch: "main",
        },
        tags: ["rfc-0052"],
      },
      { by: "user" },
    );
    expect(project.id).toBe("gst2");
    expect(project.roots).toEqual([
      { connectionId: "desktop", path: "/home/me/gstreamer/2.0" },
      { connectionId: "desktop", path: "/home/me/gstreamer/2.0/gstreamer" },
    ]);
    expect(project.done).toEqual({
      kind: "branch",
      root: "/home/me/gstreamer/2.0/gstreamer",
      branch: "main",
      connectionId: "desktop",
    });
    const item = await service.add(
      {
        project: "gst2",
        title: "Phase 6: landing-review fixes",
        tags: ["rfc-0047", "p6"],
        links: [
          { kind: "branch", name: "task/control-task-p6" },
          {
            kind: "decision",
            path: "rfcs/0052-transactional-pipeline-edits.md",
            id: "D13",
          },
        ],
      },
      { by: "user" },
    );
    expect(item.project).toBe("gst2");
    expect(service.list({ project: "roamgate" })).toEqual([]);
    expect(service.list({ project: "gst2" }).map((i) => i.id)).toEqual([
      item.id,
    ]);
    await expect(
      service.add({ project: "nope", title: "x" }, { by: "user" }),
    ).rejects.toThrow(/no project nope/);
  });

  test("the done rule: a commit on the deployed build finishes the item, a rebased one by its subject", async () => {
    const calls: string[][] = [];
    const git: WorkGit = async (root, args) => {
      calls.push([root, ...args]);
      if (args[0] === "merge-base") {
        // deployed holds "aaaa..."; "bbbb..." was rewritten (unknown sha).
        if (args[2]!.startsWith("aaaa")) return { code: 0, stdout: "" };
        return { code: 128, stdout: "" };
      }
      if (args[0] === "log" && args.some((a) => a === "--grep=Rebased fix"))
        return {
          code: 0,
          stdout: "cccccccccccccccccccccccccccccccccccccccc\n",
        };
      return { code: 0, stdout: "" };
    };
    let deployed: string | null = null;
    const { service, pushes } = setup({ git, deployed: () => deployed });
    const landed = await service.add(
      {
        title: "Landed",
        state: "verify",
        links: [{ kind: "commit", sha: "aaaa1111" }],
      },
      { by: "user" },
    );
    const rebased = await service.add(
      {
        title: "Rebased",
        state: "doing",
        links: [{ kind: "commit", sha: "bbbb2222", subject: "Rebased fix" }],
      },
      { by: "user" },
    );
    const unrelated = await service.add(
      {
        title: "No commit",
        state: "open",
        links: [{ kind: "pr", url: "https://x/1" }],
      },
      { by: "user" },
    );
    const lost = await service.add(
      {
        title: "Lost",
        state: "open",
        links: [{ kind: "commit", sha: "dddd3333" }],
      },
      { by: "user" },
    );
    // No deployed build known: nothing moves.
    expect(await service.check()).toEqual({ landed: [], checked: 3 });
    deployed = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const result = await service.check();
    expect(result.landed.sort()).toEqual([landed.id, rebased.id].sort());
    const after = service.board().items;
    const landedNow = after.find((i) => i.id === landed.id)!;
    expect(landedNow.state).toBe("done");
    expect(landedNow.links).toEqual([
      { kind: "commit", sha: "aaaa1111" },
      { kind: "deploy", sha: deployed },
    ]);
    expect(after.find((i) => i.id === rebased.id)!.state).toBe("done");
    expect(after.find((i) => i.id === unrelated.id)!.state).toBe("open");
    expect(after.find((i) => i.id === lost.id)!.state).toBe("open");
    expect(pushes.filter((p) => p.summary?.includes("landed")).length).toBe(2);
    expect(
      calls.some((c) => c[0] === "/home/me/roamgate" && c[1] === "merge-base"),
    ).toBe(true);
  });

  test("the branch rule asks the project's root on its connection", async () => {
    const calls: { root: string; args: string[]; connectionId?: string }[] = [];
    const git: WorkGit = async (root, args, connectionId) => {
      calls.push({ root, args, connectionId });
      return { code: 0, stdout: "" };
    };
    const { service } = setup({ git });
    service.projectSet(
      {
        name: "gst2",
        roots: [{ connectionId: "mac", path: "/Users/me/2.0/gstreamer" }],
        done: {
          kind: "branch",
          root: "/Users/me/2.0/gstreamer",
          branch: "origin/main",
        },
      },
      { by: "user" },
    );
    const item = await service.add(
      {
        project: "gst2",
        title: "P6",
        state: "verify",
        links: [{ kind: "commit", sha: "abcd1234" }],
      },
      { by: "user" },
    );
    const result = await service.check();
    expect(result.landed).toEqual([item.id]);
    expect(calls[0]).toEqual({
      root: "/Users/me/2.0/gstreamer",
      args: ["merge-base", "--is-ancestor", "abcd1234", "origin/main"],
      connectionId: "mac",
    });
    expect(service.store.item(item.id)!.links.at(-1)).toEqual({
      kind: "deploy",
      sha: "abcd1234",
      branch: "origin/main",
    });
  });

  test("a decision link is done once its box is ticked on the project's branch", async () => {
    const git: WorkGit = async (_root, args) => {
      if (args[0] === "show")
        return {
          code: 0,
          stdout:
            "## Decisions\n\n- [x] **D1** Plain first.\n- [ ] **D13** The staged add.\n",
        };
      return { code: 1, stdout: "" };
    };
    const { service } = setup({ git });
    service.projectSet(
      {
        name: "gst2",
        roots: [{ connectionId: "desktop", path: "/g/2.0" }],
        done: { kind: "branch", root: "/g/2.0", branch: "main" },
      },
      { by: "user" },
    );
    const ticked = await service.add(
      {
        project: "gst2",
        title: "D1",
        links: [{ kind: "decision", path: "/g/2.0/rfcs/0052.md", id: "D1" }],
      },
      { by: "user" },
    );
    const open = await service.add(
      {
        project: "gst2",
        title: "D13",
        links: [{ kind: "decision", path: "rfcs/0052.md", id: "D13" }],
      },
      { by: "user" },
    );
    expect((await service.check()).landed).toEqual([ticked.id]);
    expect(service.store.item(open.id)!.state).toBe("open");
    expect(service.store.item(ticked.id)!.links.at(-1)).toEqual({
      kind: "deploy",
      sha: "decision",
      branch: "ticked",
    });
  });

  test("a decision is decided by its ticked box, or by its heading's Answered line (RFC-0053)", () => {
    const rfc = [
      "## Decisions",
      "",
      "### D1. Crates and the sink's name",
      "",
      '> **Answered 2026-11-11:** "Follow gst-plugins-rs".',
      "",
      "### D2. Formats",
      "",
      "Open: packed RGB only?",
      "",
      "### D3: Timestamps",
      "",
      "> **Decided:** none.",
      "",
      "## Later",
      "",
      "- [ ] **D13** The staged add.",
      "- [x] **D14** Plain first.",
    ].join("\n");
    expect(decisionDecided(rfc, "D1")).toBe(true);
    expect(decisionDecided(rfc, "D2")).toBe(false);
    expect(decisionDecided(rfc, "D3")).toBe(true);
    expect(decisionDecided(rfc, "D13")).toBe(false);
    expect(decisionDecided(rfc, "D14")).toBe(true);
    // D1 is not D13's heading, nor D14's box.
    expect(
      decisionDecided("### D13. Staged\n\n> **Answered:** yes", "D1"),
    ).toBe(false);
    expect(decisionDecided("- [x] **D14** done", "D1")).toBe(false);
  });

  test("a tick in the working tree of the rule's checkout counts, said uncommitted; another branch checked out does not", async () => {
    const files = new Map<string, string>();
    let head = "main";
    const git: WorkGit = async (_root, args) => {
      if (args[0] === "show")
        return { code: 0, stdout: "- [ ] **D5** Not on main yet.\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n` };
      return { code: 1, stdout: "" };
    };
    const { service } = setup({
      git,
      readFile: async (root, path) => files.get(`${root}/${path}`) ?? null,
    });
    service.projectSet(
      {
        name: "gst2",
        roots: [{ connectionId: "desktop", path: "/g/2.0" }],
        done: { kind: "branch", root: "/g/2.0", branch: "main" },
      },
      { by: "user" },
    );
    const item = await service.add(
      {
        project: "gst2",
        title: "D5",
        links: [{ kind: "decision", path: "rfcs/0052.md", id: "D5" }],
      },
      { by: "user" },
    );
    // Unticked everywhere: open.
    expect((await service.check()).landed).toEqual([]);
    // Ticked in the working tree, but another branch is checked out there.
    files.set("/g/2.0/rfcs/0052.md", "- [x] **D5** Ticked locally.\n");
    head = "feature";
    expect((await service.check()).landed).toEqual([]);
    head = "main";
    expect((await service.check()).landed).toEqual([item.id]);
    const done = service.store.item(item.id)!;
    expect(done.state).toBe("done");
    expect(done.links.at(-1)).toEqual({
      kind: "deploy",
      sha: "decision",
      branch: "ticked, uncommitted",
    });
    // The deployed rule reads this Roamgate's own checkout the same way.
    const own = setup({
      git: async (_root, args) =>
        args[0] === "show"
          ? { code: 0, stdout: "### D2. Formats\n\nOpen.\n" }
          : { code: 1, stdout: "" },
      readFile: async () =>
        "### D2. Formats\n\n> **Answered 2026-11-20:** RGB.\n",
    });
    own.service.projectSet(
      { name: "roamgate", roots: ["/home/me/roamgate"] },
      { by: "user" },
    );
    const mine = await own.service.add(
      {
        title: "D2",
        links: [{ kind: "decision", path: "plans/x.md", id: "D2" }],
      },
      { by: "user" },
    );
    expect((await own.service.check()).landed).toEqual([mine.id]);
  });

  test("an owner's session must be one Roamgate manages; its task is taken as given", async () => {
    const { service } = setup({
      sessions: async () => ["desktop/w35:p1", "mac/w2:p4"],
    });
    await expect(
      service.add(
        { title: "Nobody's", owner: { session: "desktop/w99:p9" } },
        { by: "agent" },
      ),
    ).rejects.toThrow(
      /no agent session Roamgate manages is at desktop\/w99:p9; agent_sessions .* such as desktop\/w35:p1/,
    );
    const item = await service.add(
      {
        title: "A subagent's",
        owner: { session: "mac/w2:p4", task: "a0a5b2a0a1e034112" },
      },
      { by: "agent" },
    );
    expect(item.owner).toEqual({
      session: "mac/w2:p4",
      task: "a0a5b2a0a1e034112",
    });
    await expect(
      service.update(
        { item: item.id, owner: { session: "gone/w1:p1" } },
        { by: "agent" },
      ),
    ).rejects.toThrow(/no agent session Roamgate manages is at gone\/w1:p1/);
    // Another task of the same session: no session to check again.
    const moved = await service.update(
      { item: item.id, owner: { session: "mac/w2:p4", task: "ffff" } },
      { by: "agent" },
    );
    expect(moved.owner?.task).toBe("ffff");
    // Without the sessions, nothing is checked (an older Roamgate).
    const loose = setup();
    const any = await loose.service.add(
      { title: "Any", owner: { session: "x/y:z" } },
      { by: "agent" },
    );
    expect(any.owner?.session).toBe("x/y:z");
  });

  test("an agent rewrites or deletes its own comments on an item, not the user's nor another agent's", async () => {
    const { service, reviews } = setup();
    const item = await service.add(
      {
        title: "Comments",
        owner: { session: "desktop/w35:p1" },
        text: "First words",
      },
      { by: "agent", caller: "Claude in roamgate", address: "desktop/w35:p1" },
    );
    const sessionId = service.threads({ item: item.id })!.session.id;
    const mine = reviews.sessions.get(sessionId)!.threads[0]!.comments[0]!;
    expect(mine.author).toBe("Claude");
    const users = await reviews.addThread({
      sessionId,
      author: "you",
      text: "Please look",
      anchor: { work: { item: item.id } },
    });
    // Signed with the caller line, as a comment told to another session is.
    const told = await reviews.addThread({
      sessionId,
      author: "Codex in gst2",
      text: "Taken.",
      anchor: { work: { item: item.id } },
    });
    const meta = { by: "agent" as const, caller: "Claude in roamgate" };
    const edited = await service.commentEdit(
      { comment: mine.id, text: "Better words" },
      meta,
    );
    expect(edited.item.id).toBe(item.id);
    expect(edited.thread?.comments[0]?.body).toBe("Better words");
    await expect(
      service.commentEdit(
        { comment: users.comments[0]!.id, text: "Mine now" },
        meta,
      ),
    ).rejects.toThrow(/only edit its own comments \(this one is by you\)/);
    await expect(
      service.commentDelete({ comment: told.comments[0]!.id }, meta),
    ).rejects.toThrow(/only delete its own comments/);
    // Its caller line signs some of its comments: those are its own too.
    const theirs = await service.commentEdit(
      { comment: told.comments[0]!.id, text: "Done." },
      { by: "agent", caller: "Codex in gst2" },
    );
    expect(theirs.thread?.comments[0]?.body).toBe("Done.");
    // A thread's id names no comment; a comment of no item is refused.
    await expect(
      service.commentEdit({ comment: told.id, text: "x" }, meta),
    ).rejects.toThrow(/give the comment's own id/);
    const gone = await service.commentDelete({ comment: mine.id }, meta);
    expect(gone.deleted).toBe(edited.thread!.id);
    expect(gone.thread).toBeNull();
    expect(reviews.sessions.get(sessionId)!.threads.length).toBe(2);
  });

  test("an item's threads are a review of the item, its comments going to the owner's pane", async () => {
    const { service, reviews } = setup();
    // An agent's own item: no review until someone comments.
    const own = await service.add(
      { title: "Mine", owner: "desktop/w35:p1" },
      { by: "agent", caller: "Claude in roamgate", address: "desktop/w35:p1" },
    );
    expect(service.threads({ item: own.id })).toBeNull();
    // The user's item for a session: its review, with the item as a thread
    // by the user, so that the session hears of it.
    const item = await service.add(
      { title: "Talk", owner: { session: "desktop/w35:p1", task: "a1b2c3" } },
      { by: "user" },
    );
    const snapshot = service.threads({ item: item.id })!;
    expect(snapshot.session.target).toEqual({ kind: "work", item: item.id });
    expect(snapshot.session.connectionId).toBe("desktop");
    expect(service.store.item(item.id)!.review).toBe(snapshot.session.id);
    expect(reviews.added).toEqual([
      { sessionId: snapshot.session.id, author: "you", text: "Talk" },
    ]);
    expect(snapshot.threads[0]!.anchor.work).toEqual({ item: item.id });
    // The same review again.
    expect(service.threads({ item: item.id, open: true })!.session.id).toBe(
      snapshot.session.id,
    );
    expect(await service.ownerPane(item.id, "desktop")).toBe("w35:p1");
    expect(await service.ownerPane(item.id, "mac")).toBeNull();
    const thread = await service.comment(
      { item: item.id, text: "Take it" },
      "Claude",
    );
    expect(reviews.added.at(-1)).toEqual({
      sessionId: snapshot.session.id,
      author: "Claude",
      text: "Take it",
    });
    expect(thread.anchor.work).toEqual({ item: item.id });
    expect(await service.ownerTarget({ item: item.id })).toBeNull();
    const withPanes = setup({
      panes: async () => [{ pane_id: "w35:p1", workspace_id: "w35" }],
      generation: () => 3,
    });
    const owned = await withPanes.service.add(
      { title: "Owned", owner: { session: "desktop/w35:p1", task: "a1b2c3" } },
      { by: "user" },
    );
    expect(await withPanes.service.ownerTarget({ item: owned.id })).toEqual({
      connectionId: "desktop",
      runtimeGeneration: 3,
      workspaceId: "w35",
      paneId: "w35:p1",
      task: "a1b2c3",
    });
  });

  test("a thread on an item's comment is kept under it, listed with its parent, and delivered with its quote", async () => {
    const panes = new Map([["w35:p1", "w35:p1"]]);
    const kit = reviewServiceForTest({
      deliveryDelayMs: 1,
      retryDelayMs: 1,
      agentSearchMs: 600_000,
      sessionPane: async (connectionId, sessionId) => {
        if (!sessionId.startsWith(WORK_SESSION_PREFIX)) return null;
        const paneId = await service.ownerPane(
          sessionId.slice(WORK_SESSION_PREFIX.length),
          connectionId,
        );
        return paneId && panes.has(paneId) ? paneId : null;
      },
      paneSession: async () => null,
    });
    const service = createWorkService({
      store: openWorkStore(dir()),
      reviews: realReviews(kit.service),
      defaultConnection: () => "desktop",
      ownRoot: () => "/home/me/roamgate",
    });
    const item = await service.add({ title: "Nest me" }, { by: "user" });
    await service.update(
      { item: item.id, owner: "desktop/w35:p1" },
      { by: "user" },
    );
    const sessionId = service.threads({ item: item.id, open: true })!.session
      .id;
    const parent = await kit.service.addThread({
      sessionId,
      author: "you",
      text: "Please look",
      anchor: { work: { item: item.id } },
      kind: "discussion",
    });
    await Bun.sleep(80);
    expect(kit.prompts.length).toBe(1);
    const answered = await kit.service.reply({
      sessionId,
      commentId: parent.id,
      author: "Claude",
      text: "Done: the box opens.\n\nThe words go with it.",
    });
    const said = answered.comments[1]!;
    // The user answers a part of the agent's comment, then the whole of
    // it: threads on that comment, in the item's review.
    const quoted = await kit.service.addThread({
      sessionId,
      author: "you",
      text: "Which box?",
      anchor: {
        work: { item: item.id },
        message: {
          thread: parent.id,
          comment: said.id,
          quote: "the box opens",
        },
      },
      kind: "discussion",
    });
    const whole = await kit.service.addThread({
      sessionId,
      author: "you",
      text: "Thanks",
      anchor: {
        work: { item: item.id },
        message: { thread: parent.id, comment: said.id },
      },
      kind: "discussion",
    });
    expect(quoted.anchor).toEqual({
      work: { item: item.id },
      message: { thread: parent.id, comment: said.id, quote: "the box opens" },
    });
    expect(whole.anchor.message).toEqual({
      thread: parent.id,
      comment: said.id,
    });
    // Delivered to the owner as comments on the item, with the words.
    await Bun.sleep(80);
    const prompt = kit.prompts
      .slice(1)
      .map((each) => each.text)
      .join("\n");
    expect(kit.prompts.slice(1).every((each) => each.paneId === "w35:p1")).toBe(
      true,
    );
    expect(prompt).toContain("work item you own");
    expect(prompt).toContain(
      `on a part of a message in thread [${parent.id.slice(0, 8)}] (on the work item):`,
    );
    expect(prompt).toContain("  > the box opens");
    expect(prompt).toContain("Which box?");
    expect(prompt).toContain(
      `on a message in thread [${parent.id.slice(0, 8)}] (on the work item):`,
    );
    expect(prompt).toContain("Thanks");
    // work_list lists them under the comment they answer, not beside it.
    const listed = JSON.parse(
      (await workTool(service, "work_list", { item: item.id }, "Claude")).split(
        "\n",
      )[1]!,
    );
    expect(
      listed.comments.map((each: { thread: string }) => each.thread),
    ).toEqual([parent.id]);
    expect(listed.comments[0].comments[0].threads).toBeUndefined();
    const under = listed.comments[0].comments[1];
    expect(under.id).toBe(said.id);
    expect(
      under.threads.map((each: { thread: string }) => each.thread),
    ).toEqual([quoted.id, whole.id]);
    expect(under.threads[0].on).toEqual({
      comment: said.id,
      quote: "the box opens",
    });
    expect(
      under.threads[0].comments.map((c: { text: string }) => c.text),
    ).toEqual(["Which box?"]);
    expect(under.threads[1].on).toEqual({ comment: said.id });
    // The owner answers in the nested thread, by its id.
    const replied = await kit.service.reply({
      sessionId,
      commentId: quoted.id,
      author: "Claude",
      text: "The reply box.",
    });
    expect(replied.comments.map((comment) => comment.body)).toEqual([
      "Which box?",
      "The reply box.",
    ]);
  });

  test("the real review service delivers an item's comment to its owner, and waits without one", async () => {
    const panes = new Map<string, string>();
    const kit = reviewServiceForTest({
      deliveryDelayMs: 1,
      retryDelayMs: 1,
      agentSearchMs: 600_000,
      sessionPane: async (connectionId, sessionId) => {
        if (!sessionId.startsWith(WORK_SESSION_PREFIX)) return null;
        const paneId = await service.ownerPane(
          sessionId.slice(WORK_SESSION_PREFIX.length),
          connectionId,
        );
        return paneId && panes.has(paneId) ? paneId : null;
      },
      paneSession: async () => null,
    });
    const service = createWorkService({
      store: openWorkStore(dir()),
      reviews: realReviews(kit.service),
      defaultConnection: () => "desktop",
      ownRoot: () => "/home/me/roamgate",
    });
    const item = await service.add({ title: "Deliver me" }, { by: "user" });
    const snapshot = service.threads({ item: item.id, open: true })!;
    // The user comments: no owner yet, the comment waits and says why.
    await kit.service.addThread({
      sessionId: snapshot.session.id,
      author: "you",
      text: "Please look",
      anchor: { work: { item: item.id } },
      kind: "discussion",
    });
    await Bun.sleep(80);
    expect(kit.prompts).toEqual([]);
    const waiting = kit.service.get({ sessionId: snapshot.session.id });
    expect(waiting.session.deliveryError).toBe(WORK_NO_OWNER);
    // An owner appears: a retry sends the comment to its pane, naming the item.
    await service.update(
      { item: item.id, owner: "desktop/w35:p1" },
      { by: "user" },
    );
    panes.set("w35:p1", "w35:p1");
    await kit.service.retry({ sessionId: snapshot.session.id });
    await Bun.sleep(80);
    expect(kit.prompts.length).toBe(1);
    expect(kit.prompts[0]!.paneId).toBe("w35:p1");
    expect(kit.prompts[0]!.text).toContain("work item you own");
    expect(kit.prompts[0]!.text).toContain("Please look");
    // No mod with the work tools in that pane: the client's work command.
    expect(kit.prompts[0]!.text).toContain(
      `roamgate-review work work_list '{"item": "${item.id.slice(0, 8)}"}'`,
    );
    expect(kit.prompts[0]!.text).toContain("work_update");

    // A TODO thread adopted through the real service: moved with its ids,
    // anchored on the item, nothing delivered again.
    const todo = kit.service.open({
      connectionId: "desktop",
      root: "/home/me/roamgate.worktrees",
      target: { kind: "rendered", path: "plans/todo.md" },
      title: "Roamgate TODO",
      agent: "Claude",
      raise: false,
    });
    const old = await kit.service.addThread({
      sessionId: todo.session.id,
      author: "you",
      text: "**open** An old TODO item",
      anchor: { path: "plans/todo.md", line: 3, text: "## For you" },
      kind: "discussion",
    });
    const promoted = await service.promote({ thread: old.id }, { by: "user" });
    expect(promoted.title).toBe("An old TODO item");
    expect(promoted.source).toBe(`thread ${old.id}`);
    const own = kit.service.get({ sessionId: promoted.review! });
    expect(own.threads.map((t) => t.id)).toEqual([old.id]);
    expect(own.threads[0]!.anchor).toEqual({
      work: {
        item: promoted.id,
        from: { review: todo.session.id, thread: old.id },
      },
    });
    expect(own.threads[0]!.handedAt).toBeTruthy();
    expect(kit.service.get({ sessionId: todo.session.id }).threads).toEqual([]);
    await Bun.sleep(80);
    expect(kit.prompts.length).toBe(1);
  });

  test("promotes a review thread into an item that adopts it: title and state from the first line, ids kept", async () => {
    const { service, reviews } = setup();
    const todo = todoReview();
    reviews.sessions.set(todo.session.id, todo);
    const item = await service.promote({ thread: "b057f8a2" }, { by: "user" });
    expect(item.title).toBe("Fold a reviewed chunk again");
    expect(item.state).toBe("doing");
    expect(item.source).toBe("thread b057f8a2129c74bc");
    expect(item.createdAt).toBe("2026-11-20T09:01:00.000Z");
    expect(item.links).toEqual([
      { kind: "review", id: "d22a2f86bc540f34", thread: "b057f8a2129c74bc" },
    ]);
    const own = reviews.find(item.id)!;
    expect(own.threads.map((t) => t.id)).toEqual(["b057f8a2129c74bc"]);
    expect(
      own.threads[0]!.comments.map((c) => [c.id, c.author, c.createdAt]),
    ).toEqual([
      ["c1c1c1c1c1c1c1c1", "you", "2026-11-20T09:01:00.000Z"],
      ["c2c2c2c2c2c2c2c2", "Claude", "2026-11-20T09:02:00.000Z"],
    ]);
    expect(own.threads[0]!.anchor.work).toEqual({
      item: item.id,
      from: { review: "d22a2f86bc540f34", thread: "b057f8a2129c74bc" },
      quote: "Reviews and Files",
    });
    expect(todo.threads).toEqual([]);
    // Promoting the thread again answers the same item (it is the item's now).
    expect(
      (await service.promote({ thread: "b057f8a2129c74bc" }, { by: "user" }))
        .id,
    ).toBe(item.id);
    await expect(
      service.promote({ thread: "nope0000" }, { by: "user" }),
    ).rejects.toThrow(/no such thread/);
    // A resolved thread makes a done item with the thread's dates.
    reviews.sessions.set("d22a2f86bc540f34", todoReview(true));
    const done = await service.promote(
      { thread: "b057f8a2129c74bc", project: "roamgate" },
      { by: "user" },
    );
    expect(done.id).toBe(item.id);
  });

  test("adopts a thread into an existing item, once", async () => {
    const { service, reviews, pushes } = setup();
    const todo = todoReview();
    reviews.sessions.set(todo.session.id, todo);
    const item = await service.add({ title: "Already here" }, { by: "user" });
    const adopted = service.adopt(
      { item: item.id, thread: "c2c2c2c2" },
      { by: "agent", caller: "Claude" },
    );
    expect(adopted.links).toEqual([
      { kind: "review", id: "d22a2f86bc540f34", thread: "b057f8a2129c74bc" },
    ]);
    expect(reviews.find(item.id)!.threads.map((t) => t.id)).toEqual([
      "b057f8a2129c74bc",
    ]);
    expect(pushes.at(-1)?.summary).toMatch(/took thread b057f8a2/);
    const before = pushes.length;
    service.adopt(
      { item: item.id, thread: "b057f8a2129c74bc" },
      { by: "user" },
    );
    expect(pushes.length).toBe(before);
    // work_add with adopt_thread does both at once.
    reviews.sessions.set("d22a2f86bc540f34", todoReview());
    const added = await service.add(
      { title: "Imported", adopt_thread: "b057f8a2129c74bc" },
      { by: "agent" },
    );
    expect(reviews.find(added.id)!.threads.length).toBe(1);
  });
});

test("an item nobody owns is the project's coordinator's, told of it as a review comment", async () => {
  const panes = [{ pane_id: "w35:p1", workspace_id: "w35" }];
  const stored: { sessionId: string; type: string; bytes: number }[] = [];
  const { service, reviews, pushes } = setup({
    panes: async () => panes,
  });
  reviews.addImage = (sessionId, type, data) => {
    stored.push({ sessionId, type, bytes: data.length });
    return `/images/${sessionId}/${stored.length}.png`;
  };
  // The coordinator: set and changed by work_project, kept.
  const project = service.projectSet(
    { name: "roamgate", coordinator: "desktop/w35:p1" },
    { by: "user" },
  );
  expect(project.coordinator).toEqual({ session: "desktop/w35:p1" });
  expect(
    service.projectSet({ name: "roamgate", tags: ["voice"] }, { by: "user" })
      .coordinator,
  ).toEqual({ session: "desktop/w35:p1" });
  expect(() =>
    service.projectSet(
      { name: "roamgate", coordinator: "w35" },
      { by: "user" },
    ),
  ).toThrow(/address/);

  // The user's item, no owner: the coordinator's, and a thread by the
  // user holds its text (its description) with its images stored.
  const png = Buffer.from("fakepng");
  const item = await service.add(
    {
      title: "Copy a picture",
      text: "Like this one: ![shot](<work-image:1>)",
      images: [
        {
          token: "<work-image:1>",
          type: "image/png",
          data: png.toString("base64"),
        },
      ],
    },
    { by: "user" },
  );
  expect(item.owner).toEqual({ session: "desktop/w35:p1" });
  expect(item.review).toBeTruthy();
  expect(stored).toEqual([
    { sessionId: item.review!, type: "image/png", bytes: png.length },
  ]);
  expect(reviews.added).toEqual([
    {
      sessionId: item.review!,
      author: "you",
      text: `Like this one: ![shot](/images/${item.review}/1.png)`,
    },
  ]);
  const thread = reviews.sessions.get(item.review!)!.threads[0]!;
  expect(thread.anchor.work).toEqual({ item: item.id, description: true });
  expect(pushes.find((push) => push.changed.includes("items"))).toMatchObject({
    item: item.id,
    by: "user",
  });
  // Its comments go to the coordinator's pane.
  expect(await service.ownerPane(item.id, "desktop")).toBe("w35:p1");

  // Nothing but a title: the title is the thread, no description.
  const bare = await service.add({ title: "Just a title" }, { by: "user" });
  expect(bare.owner).toEqual({ session: "desktop/w35:p1" });
  expect(reviews.added.at(-1)).toEqual({
    sessionId: bare.review!,
    author: "you",
    text: "Just a title",
  });
  expect(reviews.sessions.get(bare.review!)!.threads[0]!.anchor.work).toEqual({
    item: bare.id,
  });

  // The user's own For you item: nobody's, nothing told, its comments
  // wait for nobody.
  const mine = await service.add(
    { title: "Remember the milk", state: "you" },
    { by: "user" },
  );
  expect(mine.owner).toBeUndefined();
  expect(mine.review).toBeUndefined();
  expect(reviews.added.length).toBe(2);
  expect(await service.ownerPane(mine.id, "desktop")).toBeNull();

  // An agent's item for another session, with its text: told to it as
  // the agent, by name.
  const given = await service.add(
    { title: "For the coordinator", text: "Please do this." },
    { by: "agent", caller: "Claude in gst2", address: "desktop/w32:p1" },
  );
  expect(given.owner).toEqual({ session: "desktop/w35:p1" });
  expect(reviews.added.at(-1)).toEqual({
    sessionId: given.review!,
    author: "Claude in gst2",
    text: "Please do this.",
  });
  // The agent's own item with text: its own words, as itself.
  const own = await service.add(
    { title: "My own", text: "Notes.", owner: "desktop/w32:p1" },
    { by: "agent", caller: "Claude in gst2", address: "desktop/w32:p1" },
  );
  expect(reviews.added.at(-1)).toEqual({
    sessionId: own.review!,
    author: "Claude",
    text: "Notes.",
  });

  // An owner whose pane is gone: the coordinator's pane; a coordinator
  // gone too: nobody.
  const orphan = await service.add(
    { title: "Orphan", owner: "desktop/w9:p1" },
    { by: "user" },
  );
  expect(await service.ownerPane(orphan.id, "desktop")).toBe("w35:p1");
  panes.splice(0, 1);
  expect(await service.ownerPane(orphan.id, "desktop")).toBeNull();
  panes.push({ pane_id: "w35:p1", workspace_id: "w35" });

  // A done item nobody owns, reopened: the coordinator's, told so.
  const old = await service.add(
    { title: "Old one", state: "done", done_at: "2026-11-01T10:00:00Z" },
    { by: "agent", caller: "Claude in roamgate" },
  );
  expect(old.owner).toBeUndefined();
  expect(reviews.added.length).toBe(5);
  const back = await service.reopen({ item: old.id }, { by: "user" });
  expect(back.owner).toEqual({ session: "desktop/w35:p1" });
  expect(reviews.added.at(-1)).toEqual({
    sessionId: back.review!,
    author: "you",
    text: "Reopened.",
  });
  // Too many images, or a bad one.
  await expect(
    service.add(
      { title: "x", text: "y", images: [{ token: "t", type: "image/png" }] },
      { by: "user" },
    ),
  ).rejects.toThrow(/an image is/);
});

test("the real review service tells the coordinator of the user's new item, and sends it the comments of an item whose owner is gone", async () => {
  let panes = ["w35:p1"];
  const kit = reviewServiceForTest({
    deliveryDelayMs: 1,
    retryDelayMs: 1,
    agentSearchMs: 600_000,
    sessionPane: async (connectionId, sessionId) => {
      if (!sessionId.startsWith(WORK_SESSION_PREFIX)) return null;
      return service.ownerPane(
        sessionId.slice(WORK_SESSION_PREFIX.length),
        connectionId,
      );
    },
    paneSession: async () => null,
  });
  const service = createWorkService({
    store: openWorkStore(dir()),
    reviews: realReviews(kit.service),
    defaultConnection: () => "desktop",
    ownRoot: () => "/home/me/roamgate",
    panes: async () => panes.map((pane_id) => ({ pane_id })),
  });
  service.projectSet(
    { name: "roamgate", coordinator: "desktop/w35:p1" },
    { by: "user" },
  );
  const item = await service.add(
    { title: "Copy a picture", text: "When adding a task, paste one." },
    { by: "user" },
  );
  expect(item.owner).toEqual({ session: "desktop/w35:p1" });
  await Bun.sleep(80);
  expect(kit.prompts.length).toBe(1);
  expect(kit.prompts[0]!.paneId).toBe("w35:p1");
  expect(kit.prompts[0]!.text).toContain("work item you own");
  expect(kit.prompts[0]!.text).toContain("Copy a picture");
  expect(kit.prompts[0]!.text).toContain(item.id);
  expect(kit.prompts[0]!.text).toContain("its text when it was added");
  expect(kit.prompts[0]!.text).toContain("When adding a task, paste one.");
  expect(kit.prompts[0]!.text).toContain("yours to do");
  expect(kit.prompts[0]!.text).toContain("work_update");

  // An item whose owner's pane is gone: the user's comment goes to the
  // coordinator instead of waiting.
  const orphan = await service.add(
    { title: "Orphan", owner: "desktop/w9:p1" },
    { by: "agent", caller: "Claude in roamgate", address: "desktop/w9:p1" },
  );
  const snapshot = service.threads({ item: orphan.id, open: true })!;
  await kit.service.addThread({
    sessionId: snapshot.session.id,
    author: "you",
    text: "Anyone there?",
    anchor: { work: { item: orphan.id } },
    kind: "discussion",
  });
  await Bun.sleep(80);
  expect(kit.prompts.length).toBe(2);
  expect(kit.prompts[1]!.paneId).toBe("w35:p1");
  expect(kit.prompts[1]!.text).toContain("Anyone there?");
  // The user's own For you item: its comment waits for nobody to answer.
  panes = [];
  const mine = await service.add(
    { title: "Remember", state: "you" },
    { by: "user" },
  );
  const own = service.threads({ item: mine.id, open: true })!;
  await kit.service.addThread({
    sessionId: own.session.id,
    author: "you",
    text: "A note to myself",
    anchor: { work: { item: mine.id } },
    kind: "discussion",
  });
  await Bun.sleep(80);
  expect(kit.prompts.length).toBe(2);
  expect(
    kit.service.get({ sessionId: own.session.id }).session.deliveryError,
  ).toBe(WORK_NO_OWNER);
});

test("free text from the board: a provisional title from its first line, the coordinator's to sort, needs_triage until it clears it", async () => {
  const { service, reviews } = setup({
    panes: async () => [{ pane_id: "w35:p1", workspace_id: "w35" }],
  });
  service.projectSet(
    { name: "roamgate", coordinator: "desktop/w35:p1" },
    { by: "user" },
  );
  const long = `${"word ".repeat(30).trim()} end`;
  const item = await service.add(
    { text: `## ${long}\nand the details\n- a second task` },
    { by: "user" },
  );
  expect(item.title.length).toBe(80);
  expect(item.title.endsWith("\u2026")).toBe(true);
  expect(item.title.startsWith("word word")).toBe(true);
  expect(item.state).toBe("open");
  expect(item.tags).toEqual([]);
  expect(item.owner).toEqual({ session: "desktop/w35:p1" });
  expect(item.needsTriage).toBe(true);
  // Its text, whole, is its description, delivered marked for triage.
  expect(reviews.added.at(-1)!.text).toBe(
    `## ${long}\nand the details\n- a second task`,
  );
  expect(reviews.sessions.get(item.review!)!.threads[0]!.anchor.work).toEqual({
    item: item.id,
    description: true,
    triage: true,
  });
  // A short first line is the title as it is; an image is not words.
  const short = await service.add(
    { text: "![shot](<work-image:1>)\nFix the header\nmore" },
    { by: "user" },
  );
  expect(short.title).toBe("Fix the header");
  // Kept across a restart of the store; listed by the tools.
  expect(
    openWorkStore(service.store.path.replace(/[/\\]work\.json$/, "")).item(
      item.id,
    )!.needsTriage,
  ).toBe(true);
  const listed = JSON.parse(
    (
      await workTool(
        service,
        "work_list",
        { item: item.id },
        "Claude in roamgate",
      )
    )
      .split("\n")
      .slice(1)
      .join("\n"),
  );
  expect(listed.item.needs_triage).toBe(true);
  // The coordinator sorts it: a title, tags, a state, and clears the mark.
  const sorted = await service.update(
    {
      item: item.id,
      title: "Words, sorted",
      add_tags: ["board"],
      state: "doing",
      needs_triage: false,
    },
    { by: "agent", caller: "Claude in roamgate" },
  );
  expect(sorted.needsTriage).toBeUndefined();
  expect(sorted.title).toBe("Words, sorted");
  expect(sorted.tags).toEqual(["board"]);
  await expect(
    service.update(
      { item: item.id, needs_triage: "no" },
      { by: "agent", caller: "Claude" },
    ),
  ).rejects.toThrow(/needs_triage/);
  // An item with a title, as agents add them, is not one to sort; nor is
  // free text with nobody to sort it.
  const titled = await service.add(
    { title: "Has a title", text: "Body." },
    { by: "user" },
  );
  expect(titled.needsTriage).toBeUndefined();
  expect(titled.title).toBe("Has a title");
  service.projectSet({ name: "roamgate", coordinator: null }, { by: "user" });
  const alone = await service.add({ text: "Nobody here" }, { by: "user" });
  expect(alone.title).toBe("Nobody here");
  expect(alone.needsTriage).toBeUndefined();
  // Neither a title nor text: refused.
  await expect(service.add({}, { by: "user" })).rejects.toThrow(/title/);
});

test("an item given no tags gets them from its words: the project's own and the app's areas; given ones stand", async () => {
  const { service } = setup();
  service.projectSet({ name: "roamgate", tags: ["mobile"] }, { by: "user" });
  await service.add(
    { title: "Earlier", tags: ["rfc-0052"] },
    { by: "agent", caller: "Claude" },
  );
  // The user's free text.
  const free = await service.add(
    { text: "On my phone the MR header scrolls away\nsee RFC-0052" },
    { by: "user" },
  );
  expect(free.tags).toEqual(["mobile", "reviews", "rfc-0052"]);
  // An agent's work_add without tags: its title and text.
  const agent = await service.add(
    { title: "Voice starts late", text: "In a call, TTS lags." },
    { by: "agent", caller: "Claude" },
  );
  expect(agent.tags).toEqual(["voice"]);
  // Tags given (even none, as a list) stand as given.
  const given = await service.add(
    { title: "Voice again", tags: ["x"] },
    { by: "agent", caller: "Claude" },
  );
  expect(given.tags).toEqual(["x"]);
  const none = await service.add(
    { title: "Voice once more", tags: [] },
    { by: "agent", caller: "Claude" },
  );
  expect(none.tags).toEqual([]);
});

test("the real review service asks the coordinator to triage the user's free-text item", async () => {
  const kit = reviewServiceForTest({
    deliveryDelayMs: 1,
    retryDelayMs: 1,
    agentSearchMs: 600_000,
    sessionPane: async (connectionId, sessionId) =>
      sessionId.startsWith(WORK_SESSION_PREFIX)
        ? service.ownerPane(
            sessionId.slice(WORK_SESSION_PREFIX.length),
            connectionId,
          )
        : null,
    paneSession: async () => null,
  });
  const service = createWorkService({
    store: openWorkStore(dir()),
    reviews: realReviews(kit.service),
    defaultConnection: () => "desktop",
    ownRoot: () => "/home/me/roamgate",
    panes: async () => [{ pane_id: "w35:p1" }],
  });
  service.projectSet(
    { name: "roamgate", coordinator: "desktop/w35:p1" },
    { by: "user" },
  );
  const item = await service.add(
    { text: "the phone header scrolls away\nand also the files pane" },
    { by: "user" },
  );
  await Bun.sleep(80);
  expect(kit.prompts.length).toBe(1);
  const prompt = kit.prompts[0]!.text;
  expect(prompt).toContain("the phone header scrolls away");
  expect(prompt).toContain("yours to sort");
  expect(prompt).toContain("clear short title");
  expect(prompt).toContain("tags");
  expect(prompt).toContain("work_add");
  expect(prompt).toContain(`"kind": "item", "id": "${item.id}"`);
  expect(prompt).toContain("needs_triage: false");
  expect(prompt).not.toContain("yours to do");
});

describe("work tools and rpc", () => {
  test("the tools validate their parameters and answer JSON after the untrusted line", async () => {
    const { service, pushes } = setup();
    const added = await workTool(
      service,
      "work_add",
      {
        title: "From a tool",
        tags: ["voice"],
        owner: { session: "desktop/w35:p1" },
        text: "First words",
        source: "voice job 12",
      },
      "Claude in roamgate",
      "desktop/w35:p1",
    );
    const [note, json] = added.split("\n");
    expect(note).toMatch(/written by other people/);
    const parsed = JSON.parse(json!);
    expect(parsed.item.title).toBe("From a tool");
    expect(parsed.item.owner).toBe("desktop/w35:p1");
    expect(parsed.item.source).toBe("voice job 12");
    expect(parsed.thread).toBeTruthy();
    expect(parsed.review).toBe(parsed.item.review);
    expect(parsed.updated).toBeUndefined();
    expect(pushes.find((p) => p.summary)?.summary).toBe(
      'Claude in roamgate added "From a tool"',
    );
    // The same source again: changed, and the answer says so and what.
    const again = JSON.parse(
      (
        await workTool(
          service,
          "work_add",
          {
            title: "From a tool",
            tags: ["voice", "calls"],
            text: "Other words",
            source: "voice job 12",
          },
          "Claude in roamgate",
          "desktop/w35:p1",
        )
      ).split("\n")[1]!,
    );
    expect(again.item.id).toBe(parsed.item.id);
    expect(again.updated).toBe(true);
    expect(again.changed).toEqual({ tags: ["voice", "calls"] });
    expect(again.ignored).toEqual(["text"]);
    expect(again.note).toMatch(/changed, not added/);
    expect(again.thread).toBe(parsed.thread);
    await expect(
      workTool(
        service,
        "work_add",
        { title: "Another title", source: "voice job 12" },
        "Claude in roamgate",
      ),
    ).rejects.toThrow(/replace: true/);
    // An adopted thread: its id answered beside the description's.
    const other = await service.add(
      { title: "Other", text: "Adopt me" },
      { by: "user" },
    );
    const adoptable = service.threads({ item: other.id })!.threads[0]!;
    const adopted = JSON.parse(
      (
        await workTool(
          service,
          "work_add",
          {
            title: "Adopting",
            text: "Own words",
            adopt_thread: adoptable.id,
            links: [{ kind: "commit", sha: "abcdef1234", subject: "Fix" }],
          },
          "Claude in roamgate",
        )
      ).split("\n")[1]!,
    );
    expect(adopted.adopted_thread).toBe(adoptable.id);
    expect(adopted.thread).toBeUndefined();
    expect(adopted.review).toBeTruthy();
    expect(adopted.item.done_when).toMatch(
      /^its commit reaches this Roamgate's deployed build$/,
    );
    const listed = JSON.parse(
      (
        await workTool(service, "work_list", { tags: ["voice"] }, "Claude")
      ).split("\n")[1]!,
    );
    expect(listed.count).toBe(1);
    expect(listed.projects[0].name).toBe("roamgate");
    const one = JSON.parse(
      (
        await workTool(service, "work_list", { item: parsed.item.id }, "Claude")
      ).split("\n")[1]!,
    );
    expect(one.description).toBe("First words");
    expect(one.comments[0].comments[0].author).toBe("Claude");
    expect(one.comments[0].comments[0].text).toBe("First words");
    // The project's coordinator, set and shown by work_project.
    const project = JSON.parse(
      (
        await workTool(
          service,
          "work_project",
          { name: "roamgate", coordinator: { session: "desktop/w35:p1" } },
          "Claude",
        )
      ).split("\n")[1]!,
    );
    expect(project.project.coordinator).toBe("desktop/w35:p1");
    expect(
      JSON.parse(
        (
          await workTool(
            service,
            "work_project",
            { name: "roamgate", coordinator: null },
            "Claude",
          )
        ).split("\n")[1]!,
      ).project.coordinator,
    ).toBeUndefined();
    await expect(
      workTool(service, "work_update", { item: "x" }, "Claude"),
    ).rejects.toThrow(/invalid work_update/);
    await expect(workTool(service, "work_nope", {}, "Claude")).rejects.toThrow(
      /unknown tool/,
    );
    const help = JSON.parse(await workTool(service, "help", {}, "Claude"));
    expect(help.tools.map((t: { name: string }) => t.name)).toEqual([
      "work_list",
      "work_add",
      "work_update",
      "work_done",
      "work_reopen",
      "work_adopt",
      "work_comment_edit",
      "work_comment_delete",
      "work_project",
    ]);
    expect(help.tools[0].description).toContain("roamgate-review work TOOL");
    const done = JSON.parse(
      (
        await workTool(
          service,
          "work_done",
          {
            item: parsed.item.id,
            landed: { pr: "https://gitlab/x/-/merge_requests/1" },
          },
          "Claude",
        )
      ).split("\n")[1]!,
    );
    expect(done.item.state).toBe("done");
    expect(done.item.links.at(-1).kind).toBe("pr");
  });

  test("the bridge RPCs route to the service and say who wrote", async () => {
    const { service, pushes } = setup();
    expect(isWorkMethod("bridge.work.list")).toBe(true);
    expect(isWorkMethod("bridge.mr_reviews.list")).toBe(false);
    const added = (await handleWorkRpc(service, "bridge.work.add", {
      title: "RPC",
    })) as { item: WorkItem };
    expect(added.item.by).toBe("user");
    const moved = (await handleWorkRpc(service, "bridge.work.update", {
      item: added.item.id,
      state: "you",
      by: "agent",
      summary: "moved it",
    })) as { item: WorkItem };
    expect(moved.item.state).toBe("you");
    expect(pushes.at(-1)).toMatchObject({ by: "agent", summary: "moved it" });
    const board = (await handleWorkRpc(service, "bridge.work.board", {})) as {
      items: WorkItem[];
    };
    expect(board.items.length).toBe(1);
    await expect(
      handleWorkRpc(service, "bridge.work.nope", {}),
    ).rejects.toThrow(/unknown method/);
    const removed = (await handleWorkRpc(service, "bridge.work.remove", {
      item: added.item.id,
    })) as { item: WorkItem };
    expect(removed.item.id).toBe(added.item.id);
    expect(service.board().items).toEqual([]);
  });
});
