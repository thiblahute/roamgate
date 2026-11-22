import { afterEach, describe, expect, jest, test } from "bun:test";
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
  workDescriptionThread,
} from "../../../shared/work";
import { reviewServiceForTest } from "../review/testkit";
import { handleWorkRpc, isWorkMethod } from "./rpc";
import {
  createWorkService,
  decisionDecided,
  type WorkGit,
  type WorkReviews,
  type WorkServiceDeps,
  WORK_PLACE_MS,
} from "./service";
import { openWorkStore, WorkError } from "./store";
import { WORK_USER_WRITING, workTool, workUserTool } from "./tools";

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
    setAnchor: (input) =>
      review.setThreadAnchor({
        sessionId: input.sessionId,
        threadId: input.threadId,
        anchor: input.anchor,
      }),
    editComment: (input) => review.edit(input),
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
      { item: item.id, state: "you", ask: "Try the keys on the phone." },
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
    expect((await service.list({ open: true })).map((i) => i.id)).toEqual([
      item.id,
    ]);
    expect((await service.list({ tags: ["phone"] })).map((i) => i.id)).toEqual([
      item.id,
    ]);
    expect(await service.list({ tags: ["voice"] })).toEqual([]);
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
    expect(await service.list({ project: "roamgate" })).toEqual([]);
    expect((await service.list({ project: "gst2" })).map((i) => i.id)).toEqual([
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
    await service.linkRootsFilled();
    // No deployed build known: nothing moves.
    expect(await service.check()).toEqual({
      landed: [],
      recorded: [],
      checked: 3,
    });
    deployed = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const result = await service.check();
    // The one in verify waits on the user: its landing is only recorded.
    expect(result.landed).toEqual([rebased.id]);
    expect(result.recorded).toEqual([landed.id]);
    const after = service.board().items;
    const landedNow = after.find((i) => i.id === landed.id)!;
    expect(landedNow.state).toBe("verify");
    expect(landedNow.doneAt).toBeUndefined();
    expect(landedNow.links).toEqual([
      // The server found its checkout (Roamgate's own).
      { kind: "commit", sha: "aaaa1111", root: "/home/me/roamgate" },
      { kind: "deploy", sha: deployed },
    ]);
    expect(after.find((i) => i.id === rebased.id)!.state).toBe("done");
    expect(after.find((i) => i.id === unrelated.id)!.state).toBe("open");
    expect(after.find((i) => i.id === lost.id)!.state).toBe("open");
    expect(
      pushes.filter((p) => p.summary?.includes("landed")).map((p) => p.summary),
    ).toEqual([
      "Landed landed (landed aaaa1111aa), still to verify",
      "Rebased landed (landed aaaa1111aa)",
    ]);
    // Recorded once: a later deploy adds no other landing.
    deployed = "eeee1111eeee1111eeee1111eeee1111eeee1111";
    expect((await service.check()).recorded).toEqual([]);
    expect(service.store.item(landed.id)!.links.length).toBe(2);
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
    // In verify: recorded, not done (the branch rule's root is asked).
    expect(result.landed).toEqual([]);
    expect(result.recorded).toEqual([item.id]);
    expect(service.store.item(item.id)!.state).toBe("verify");
    expect(calls.find((call) => call.args[0] === "merge-base")).toEqual({
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

  test("a commit or branch link opens in the checkout that holds it: its root, else the project's roots; else a plain error", async () => {
    // Two checkouts: the commit is in the second, the branch in the first.
    const has: Record<string, string[]> = {
      "/g/2.0/gstreamer": ["refs:feature"],
      "/g/gstreamer2.worktrees/caps": ["abcd1234"],
    };
    const calls: { root: string; args: string[]; connectionId?: string }[] = [];
    const git: WorkGit = async (root, args, connectionId) => {
      calls.push({ root, args, connectionId });
      const held = has[root] ?? [];
      if (args[0] === "cat-file")
        return {
          code: held.some((sha) => args[2] === `${sha}^{commit}`) ? 0 : 128,
          stdout: "",
        };
      if (args[0] === "rev-parse" && args[1] === "--verify")
        return {
          code: held.includes(`refs:${args[3]!.replace("^{commit}", "")}`)
            ? 0
            : 1,
          stdout: "",
        };
      return { code: 1, stdout: "" };
    };
    const { service } = setup({ git });
    service.projectSet(
      {
        name: "gst2",
        roots: [
          { connectionId: "desktop", path: "/g/2.0/gstreamer" },
          { connectionId: "desktop", path: "/g/gstreamer2.worktrees/caps" },
          { connectionId: "desktop", path: "/g/not-a-repo" },
        ],
        done: { kind: "branch", root: "/g/2.0/gstreamer", branch: "main" },
      },
      { by: "user" },
    );
    // Added by an agent without roots: the server fills them in, quietly.
    const item = await service.add(
      {
        project: "gst2",
        title: "Caps",
        state: "doing",
        links: [
          { kind: "commit", sha: "abcd1234", subject: "caps: fix" },
          { kind: "branch", name: "feature" },
          { kind: "commit", sha: "eeee9999" },
        ],
      },
      { by: "agent" },
    );
    await service.linkRootsFilled();
    expect(service.store.item(item.id)!.links).toEqual([
      {
        kind: "commit",
        sha: "abcd1234",
        subject: "caps: fix",
        root: "/g/gstreamer2.worktrees/caps",
      },
      { kind: "branch", name: "feature", root: "/g/2.0/gstreamer" },
      // In none of them: left as it was, not looked for again.
      { kind: "commit", sha: "eeee9999" },
    ]);
    const lookups = calls.filter(
      (call) => call.args.join(" ") === "cat-file -e eeee9999^{commit}",
    ).length;
    expect(lookups).toBe(3);
    await service.update({ item: item.id, add_tags: ["x"] }, { by: "agent" });
    await service.linkRootsFilled();
    expect(
      calls.filter(
        (call) => call.args.join(" ") === "cat-file -e eeee9999^{commit}",
      ).length,
    ).toBe(lookups);
    // Opening them: the checkout, on its connection.
    const links = service.store.item(item.id)!.links;
    expect(await service.linkTarget({ item: item.id, link: links[0] })).toEqual(
      { connectionId: "desktop", root: "/g/gstreamer2.worktrees/caps" },
    );
    // A link without a root (an old one) is found among the roots too.
    expect(
      await service.linkTarget({
        item: item.id,
        link: { kind: "commit", sha: "abcd1234" },
      }),
    ).toEqual({
      connectionId: "desktop",
      root: "/g/gstreamer2.worktrees/caps",
    });
    expect(
      await service.linkTarget({
        item: item.id,
        link: { kind: "deploy", sha: "abcd1234", branch: "main" },
      }),
    ).toEqual({
      connectionId: "desktop",
      root: "/g/gstreamer2.worktrees/caps",
    });
    expect(
      await service.linkTarget({
        item: item.id,
        link: { kind: "branch", name: "feature" },
      }),
    ).toEqual({ connectionId: "desktop", root: "/g/2.0/gstreamer" });
    // In none: said plainly, never git's own words.
    await expect(
      service.linkTarget({ item: item.id, link: links[2] }),
    ).rejects.toThrow(
      "This commit is not in any of the project's repositories",
    );
    await expect(
      service.linkTarget({
        item: item.id,
        link: { kind: "branch", name: "gone" },
      }),
    ).rejects.toThrow(
      "The branch gone is not in any of the project's repositories",
    );
    await expect(
      service.linkTarget({
        item: item.id,
        link: { kind: "pr", url: "https://x/1" },
      }),
    ).rejects.toThrow(/only commit, branch and landing links/);
    // Through the RPC as the board asks.
    expect(
      await handleWorkRpc(service, "bridge.work.link_target", {
        item: item.id,
        link: { kind: "branch", name: "feature" },
      }),
    ).toEqual({
      target: { connectionId: "desktop", root: "/g/2.0/gstreamer" },
    });
  });

  test("a file link gets the project's checkout that has it, and opens there on its connection", async () => {
    const files: Record<string, string[]> = {
      "/g/2.0/gstreamer": [],
      "/g/meta": ["plans/agent-prompts.md"],
    };
    const reads: string[] = [];
    const { service } = setup({
      readFile: async (root, path, connectionId) => {
        reads.push(`${connectionId}:${root}/${path}`);
        return files[root]?.includes(path) ? "# Plan" : null;
      },
    });
    service.projectSet(
      {
        name: "gst2",
        roots: [
          { connectionId: "desktop", path: "/g/2.0/gstreamer" },
          { connectionId: "mac", path: "/g/meta" },
        ],
        done: { kind: "deployed" },
      },
      { by: "user" },
    );
    const item = await service.add(
      {
        project: "gst2",
        title: "Prompts",
        links: [
          { kind: "file", path: "plans/agent-prompts.md", line: 4 },
          { kind: "file", path: "plans/gone.md" },
          { kind: "file", path: "/g/2.0/gstreamer/README.md" },
        ],
      },
      { by: "agent" },
    );
    await service.linkRootsFilled();
    const links = service.store.item(item.id)!.links;
    expect(links).toEqual([
      {
        kind: "file",
        path: "plans/agent-prompts.md",
        line: 4,
        root: "/g/meta",
      },
      // In none of them: left as it was.
      { kind: "file", path: "plans/gone.md" },
      // Absolute: nothing to fill.
      { kind: "file", path: "/g/2.0/gstreamer/README.md" },
    ]);
    expect(reads).toContain("mac:/g/meta/plans/agent-prompts.md");
    expect(await service.linkTarget({ item: item.id, link: links[0] })).toEqual(
      { connectionId: "mac", root: "/g/meta", path: "plans/agent-prompts.md" },
    );
    // Not found: the project's first checkout, where Files says it is missing.
    expect(await service.linkTarget({ item: item.id, link: links[1] })).toEqual(
      {
        connectionId: "desktop",
        root: "/g/2.0/gstreamer",
        path: "plans/gone.md",
      },
    );
    expect(await service.linkTarget({ item: item.id, link: links[2] })).toEqual(
      {
        connectionId: "desktop",
        root: "/g/2.0/gstreamer",
        path: "/g/2.0/gstreamer/README.md",
      },
    );
  });

  test("existing items' commit links without a root get one when the service starts (the deployed rule: this Roamgate's checkout)", async () => {
    const directory = dir();
    const before = createWorkService({
      store: openWorkStore(directory),
      defaultConnection: () => "desktop",
      ownRoot: () => "/home/me/roamgate",
    });
    // Written before roots were filled (no git then): the gaming item.
    const old = await before.add(
      {
        title: "Gaming",
        state: "done",
        links: [
          {
            kind: "commit",
            sha: "85bbb76eafbcb5973af4f8070bbebb500dcdded5",
          },
          { kind: "branch", name: "up/voice-setup" },
        ],
      },
      { by: "agent" },
    );
    const git: WorkGit = async (root, args) => ({
      code: root === "/home/me/roamgate" && args[0] !== "merge-base" ? 0 : 1,
      stdout: "",
    });
    const after = createWorkService({
      store: openWorkStore(directory),
      defaultConnection: () => "desktop",
      ownRoot: () => "/home/me/roamgate",
      git,
    });
    await after.backfillLinkRoots();
    expect(after.store.item(old.id)!.links).toEqual([
      {
        kind: "commit",
        sha: "85bbb76eafbcb5973af4f8070bbebb500dcdded5",
        root: "/home/me/roamgate",
      },
      { kind: "branch", name: "up/voice-setup", root: "/home/me/roamgate" },
    ]);
    // Its time and author kept: a repair, not a change.
    expect(after.store.item(old.id)!.updatedAt).toBe(old.updatedAt);
  });

  test("an item for you whose commit lands stays for you, its landing recorded; an open one goes done", async () => {
    const git: WorkGit = async (_root, args) => ({
      code: args[0] === "merge-base" || args[0] === "cat-file" ? 0 : 1,
      stdout: "",
    });
    const deployed = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const { service } = setup({ git, deployed: () => deployed });
    const asked = await service.add(
      {
        title: "Try it",
        state: "you",
        ask: "Try the light voice",
        links: [{ kind: "commit", sha: "aaaa1111" }],
      },
      { by: "user" },
    );
    const open = await service.add(
      {
        title: "Plain",
        state: "open",
        links: [{ kind: "commit", sha: "aaaa1111" }],
      },
      { by: "user" },
    );
    const result = await service.check();
    expect(result).toEqual({
      landed: [open.id],
      recorded: [asked.id],
      checked: 2,
    });
    const kept = service.store.item(asked.id)!;
    expect(kept.state).toBe("you");
    // Its ask stays: the user still has to answer.
    expect(kept.ask).toBe("Try the light voice");
    expect(kept.links.at(-1)).toEqual({ kind: "deploy", sha: deployed });
    expect(service.store.item(open.id)!.state).toBe("done");
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

  test("the design doc is the item's description: set whole, revised in place, its questions asked on its parts, its versions kept", async () => {
    const kit = reviewServiceForTest({});
    const service = createWorkService({
      store: openWorkStore(dir()),
      reviews: realReviews(kit.service),
      defaultConnection: () => "desktop",
      ownRoot: () => "/home/me/roamgate",
      now: () => "2026-11-22T12:00:00.000Z",
    });
    const item = await service.add(
      { title: "Data history", text: "Keep everything in git" },
      { by: "user" },
    );
    const sessionId = service.threads({ item: item.id })!.session.id;
    const users = service.threads({ item: item.id })!.threads[0]!;
    // A comment of the user's on a part of their words.
    await kit.service.addThread({
      sessionId,
      author: "you",
      text: "Not too often",
      anchor: {
        work: { item: item.id },
        message: {
          thread: users.id,
          comment: users.comments[0]!.id,
          quote: "Keep everything",
        },
      },
    });
    // A doc longer than a comment may be, its questions not in it.
    const filler = "Some long words of the design. ".repeat(1000);
    const doc = `# Data history\n\n${filler}\n\n## Approach\n\nA copy in **git** of every store.\n\n## Scope\n\nEvery area.\n`;
    expect(doc.length).toBeGreaterThan(20_000);
    const meta = {
      by: "agent" as const,
      caller: "Claude in roamgate",
      address: "desktop/w35:p1",
    };
    const set = await service.update({ item: item.id, text: doc }, meta);
    expect(set.questions).toBeUndefined();
    let threads = service.threads({ item: item.id })!.threads;
    // The user's words stay theirs, an ordinary thread now; the doc is the
    // agent's description.
    const description = workDescriptionThread(threads, set)!;
    expect(description.id).not.toBe(users.id);
    expect(description.comments[0]!.author).toBe("Claude");
    expect(description.comments[0]!.body).toBe(doc.trim());
    expect(threads.find((t) => t.id === users.id)!.anchor.work).toEqual({
      item: item.id,
    });
    // The agent asks each open question on the part it is about (review_add
    // on_comment): the description's anchor, the words as they read.
    const comment = description.comments[0]!.id;
    const anchor = kit.service.messagePartAnchor({
      sessionId,
      commentId: comment,
      quote: "A copy in **git** of every store.",
    });
    expect(anchor).toEqual({
      work: { item: item.id },
      message: {
        thread: description.id,
        comment,
        quote: "A copy in git of every store.",
      },
    });
    expect(() =>
      kit.service.messagePartAnchor({
        sessionId,
        commentId: comment,
        quote: "Words it does not have",
      }),
    ).toThrow(/the quote is not in that comment/);
    const asked = await kit.service.addThread({
      sessionId,
      author: "Claude",
      text: "Copy every store, or the board only? Recommendation: every store.",
      anchor,
    });
    await kit.service.addThread({
      sessionId,
      author: "Claude",
      text: "Every area, or Work and reviews first?",
      anchor: kit.service.messagePartAnchor({
        sessionId,
        commentId: comment,
        quote: "Every area.",
      }),
    });
    // Its card counts them, as the review's changes reach the board.
    service.questionsSeen(item.id, service.threads({ item: item.id })!.threads);
    expect(service.store.item(item.id)!.questions).toBe(2);
    // The user answers the first; the agent writes the decision into the
    // text and resolves the thread.
    const decided = doc.replace(
      "A copy in **git** of every store.",
      'A copy in **git** of every store (decided 2026-11-22: "every store").',
    );
    const ticked = await service.update({ item: item.id, text: decided }, meta);
    kit.service.resolve({ sessionId, commentId: asked.id, resolved: true });
    service.questionsSeen(item.id, service.threads({ item: item.id })!.threads);
    expect(service.store.item(item.id)!.questions).toBe(1);
    threads = service.threads({ item: item.id })!.threads;
    const same = workDescriptionThread(threads, ticked)!;
    // Its own description: rewritten in place, its id kept.
    expect(same.id).toBe(description.id);
    expect(same.comments[0]!.body).toContain(
      '(decided 2026-11-22: "every store")',
    );
    // Every version is in the history, newest first.
    const versions = service.descriptionVersions(service.store.item(item.id)!);
    expect(versions.map((each) => each.text)).toEqual([
      doc.trim(),
      "Keep everything in git",
    ]);
    const listed = JSON.parse(
      (
        await workTool(
          service,
          "work_list",
          { item: item.id, versions: true },
          "Claude in roamgate",
        )
      ).split("\n")[1]!,
    );
    expect(listed.item.open_questions).toBe(1);
    expect(listed.description).toContain("Every area.");
    expect(listed.description_versions).toHaveLength(2);
    // The same text again changes nothing.
    const again = await service.change(
      { item: item.id, text: same.comments[0]!.body },
      meta,
    );
    expect(again.changed).toEqual({});
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
    // The header names the item once; a later delivery has the short line.
    expect(prompt).toContain(`[Roamgate work item ${item.id.slice(0, 8)} "`);
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
    expect(kit.prompts[0]!.text).toStartWith(
      `[Roamgate work item ${item.id.slice(0, 8)} "`,
    );
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
  // The header says the title once, with the item's id.
  expect(kit.prompts[0]!.text).toStartWith(
    `[Roamgate work item ${item.id.slice(0, 8)} "Copy a picture" (yours)]\n`,
  );
  expect(kit.prompts[0]!.text.split("Copy a picture")).toHaveLength(2);
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

test("free text the user adds from a session's chat is that session's to sort, not the coordinator's", async () => {
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
    panes: async () => [
      { pane_id: "w35:p1", workspace_id: "w35" },
      { pane_id: "w36:p2", workspace_id: "w36" },
    ],
    generation: () => 4,
  });
  service.projectSet(
    { name: "roamgate", coordinator: "desktop/w35:p1" },
    { by: "user" },
  );
  const item = await service.add(
    {
      text: "> the header scrolls away\n\nkeep it put",
      owner: { session: "desktop/w36:p2" },
      links: [
        {
          kind: "chat",
          session: "desktop/w36:p2",
          chat: "c0ffee",
          entry: "msg-7",
        },
      ],
    },
    { by: "user" },
  );
  expect(item.owner).toEqual({ session: "desktop/w36:p2" });
  expect(item.needsTriage).toBe(true);
  expect(item.links).toEqual([
    { kind: "chat", session: "desktop/w36:p2", chat: "c0ffee", entry: "msg-7" },
  ]);
  await Bun.sleep(80);
  expect(kit.prompts.length).toBe(1);
  expect(kit.prompts[0]!.paneId).toBe("w36:p2");
  const prompt = kit.prompts[0]!.text;
  expect(prompt).toContain("the header scrolls away");
  expect(prompt).toContain("yours to sort");
  expect(prompt).toContain("needs_triage: false");
  // The chat's message: where the session finds it again, and the page.
  expect(await service.sessionTarget({ session: "desktop/w36:p2" })).toEqual({
    connectionId: "desktop",
    runtimeGeneration: 4,
    workspaceId: "w36",
    paneId: "w36:p2",
  });
  expect(await service.sessionTarget({ session: "desktop/w99:p9" })).toBeNull();
  await expect(
    service.add(
      { text: "x", links: [{ kind: "chat", session: "not an address" }] },
      { by: "user" },
    ),
  ).rejects.toThrow(/session's address/);
});

describe("work tools and rpc", () => {
  test("a call's description is for the user's chat: taken, never kept", async () => {
    const { service } = setup();
    const json = (answer: string) => JSON.parse(answer.split("\n")[1]!);
    const added = json(
      await workTool(
        service,
        "work_add",
        { title: "Fix the bar", description: "Add the bar fix" },
        "Claude",
      ),
    );
    const moved = json(
      await workTool(
        service,
        "work_update",
        {
          item: added.item.id,
          state: "doing",
          description: "Take the bar fix",
        },
        "Claude",
      ),
    );
    expect(moved.item).toMatchObject({ title: "Fix the bar", state: "doing" });
    await workTool(
      service,
      "work_done",
      { item: added.item.id, description: "Mark it done" },
      "Claude",
    );
    await workTool(
      service,
      "work_reopen",
      { item: added.item.id, description: "Take it back" },
      "Claude",
    );
    const item = service.store.item(added.item.id)!;
    expect(JSON.stringify(item)).not.toContain("Take it back");
    expect(JSON.stringify(item)).not.toContain("Add the bar fix");
    // Still checked: too long is refused.
    await expect(
      workTool(
        service,
        "work_update",
        { item: added.item.id, description: "x".repeat(201) },
        "Claude",
      ),
    ).rejects.toThrow(/invalid work_update/);
  });

  test("the user's tools write in their name: words for its owner to sort, comments and answers that reach it", async () => {
    const { service, reviews } = setup();
    service.projectSet(
      { name: "roamgate", coordinator: "desktop/w35:p1" },
      { by: "user" },
    );
    const json = (answer: string) => JSON.parse(answer.split("\n")[1]!);
    // An item added from a call: the user's words as its text, never a
    // title, so the coordinator sorts it; where it came from said.
    const added = json(
      await workUserTool(
        service,
        "work_add",
        { text: "Call drops when the car starts" },
        "voice 2026-11-21 10:00:00",
      ),
    );
    expect(added.item.owner_session).toBe("desktop/w35:p1");
    expect(added.item.needs_triage).toBe(true);
    expect(added.item.source).toBe("voice 2026-11-21 10:00:00");
    expect(service.store.item(added.item.id)?.by).toBe("user");
    expect(reviews.added.at(-1)).toMatchObject({
      author: "you",
      text: "Call drops when the car starts",
    });
    // A title is the sorting session's to give.
    await expect(
      workUserTool(service, "work_add", { title: "x", text: "y" }),
    ).rejects.toThrow(/invalid work_add/);
    // The user's moves are never refused for a missing ask.
    const moved = json(
      await workUserTool(service, "work_update", {
        item: added.item.id,
        state: "you",
        ask: "Choose: drop the car link or keep it",
        answers: ["Drop it", "Keep it"],
      }),
    );
    expect(moved.item.state).toBe("you");
    // An answer must be one of the item's, whatever its case.
    await expect(
      workUserTool(service, "work_answer", {
        item: added.item.id,
        answer: "Maybe",
      }),
    ).rejects.toThrow(/"Drop it", "Keep it"/);
    const answered = json(
      await workUserTool(service, "work_answer", {
        item: added.item.id,
        answer: "keep it",
      }),
    );
    expect(answered.told).toBeTruthy();
    expect(reviews.added.at(-1)).toMatchObject({
      author: "you",
      text: "Keep it",
    });
    await workUserTool(service, "work_comment", {
      item: added.item.id,
      text: "Et vérifie avec le téléphone",
    });
    expect(reviews.added.at(-1)).toMatchObject({
      author: "you",
      text: "Et vérifie avec le téléphone",
    });
    const done = json(
      await workUserTool(service, "work_done", { item: added.item.id }),
    );
    expect(done.item.state).toBe("done");
    const listed = json(
      await workUserTool(service, "work_list", { state: "done" }),
    );
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([
      added.item.id,
    ]);
    // Only the user's tools: no project changes, no other's comments.
    await expect(
      workUserTool(service, "work_project", { name: "x" }),
    ).rejects.toThrow(/unknown tool/);
    expect(WORK_USER_WRITING).not.toContain("work_list");
  });

  test("the tools take an ask and answers, list them, and say how to give one", async () => {
    const { service } = setup();
    const made = JSON.parse(
      (
        await workTool(service, "work_add", { title: "Car audio" }, "Claude")
      ).split("\n")[1]!,
    );
    await expect(
      workTool(
        service,
        "work_update",
        { item: made.item.id, state: "you" },
        "Claude",
      ),
    ).rejects.toThrow(/give ask/);
    const moved = JSON.parse(
      (
        await workTool(
          service,
          "work_update",
          {
            item: made.item.id,
            state: "you",
            ask: "Choose: media or no music",
            answers: ["Media", "No music"],
          },
          "Claude",
        )
      ).split("\n")[1]!,
    );
    expect(moved.item.ask).toBe("Choose: media or no music");
    expect(moved.item.answers).toEqual(["Media", "No music"]);
    await expect(
      workTool(
        service,
        "work_update",
        { item: made.item.id, answers: ["x".repeat(81)] },
        "Claude",
      ),
    ).rejects.toThrow(/invalid work_update/);
    const help = JSON.parse(await workTool(service, "help", {}, "Claude"));
    const update = help.tools.find(
      (tool: { name: string }) => tool.name === "work_update",
    );
    expect(update.description).toMatch(/ask/);
    expect(update.params.properties.ask).toBeTruthy();
    expect(update.params.properties.answers).toBeTruthy();
  });

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

  test("an item in For you or Verify says what the user has to do", async () => {
    const { service } = setup();
    const store = service.store;
    const agent = { by: "agent" as const, caller: "Claude" };
    const item = await service.add({ title: "Car audio" }, agent);
    // An agent moving it there without an ask is refused, saying why.
    await expect(
      service.update({ item: item.id, state: "you" }, agent),
    ).rejects.toThrow(/give ask/);
    await expect(
      service.add({ title: "Dictation", state: "verify" }, agent),
    ).rejects.toThrow(/says what the user has to do/);
    expect(store.item(item.id)!.state).toBe("open");

    const asked = await service.update(
      {
        item: item.id,
        state: "you",
        ask: "  Choose: media to the car\nwith the phone mic, or no music  ",
        answers: ["Media, phone mic", " No music ", "no music", ""],
      },
      agent,
    );
    expect(asked.ask).toBe(
      "Choose: media to the car with the phone mic, or no music",
    );
    expect(asked.answers).toEqual(["Media, phone mic", "No music"]);
    // A move between the two keeps it; other changes need none.
    const verify = await service.update(
      { item: item.id, state: "verify", add_tags: ["car"] },
      agent,
    );
    expect(verify.ask).toBe(asked.ask);
    // Clearing it while there is refused for an agent.
    await expect(
      service.update({ item: item.id, ask: null }, agent),
    ).rejects.toThrow(/give ask/);
    // Leaving clears it, unless given.
    const doing = await service.update(
      { item: item.id, state: "doing" },
      agent,
    );
    expect(doing.ask).toBeUndefined();
    expect(doing.answers).toBeUndefined();
    const kept = await service.update(
      { item: item.id, state: "you", ask: "Pick one.", answers: ["A", "B"] },
      agent,
    );
    expect(kept.answers).toEqual(["A", "B"]);
    const done = service.done({ item: item.id }, agent);
    expect(done.ask).toBeUndefined();
    expect(done.answers).toBeUndefined();
    // Reopened there by an agent: it needs one again.
    await expect(
      service.reopen({ item: item.id, state: "verify" }, agent),
    ).rejects.toThrow(/give ask/);
    const reopened = await service.reopen(
      { item: item.id, state: "verify", ask: "Dictate once; text appears." },
      agent,
    );
    expect(reopened.ask).toBe("Dictate once; text appears.");
    // The user's own moves are never refused.
    const plain = await service.add({ title: "Mine" }, { by: "user" });
    const mine = await service.update(
      { item: plain.id, state: "you" },
      { by: "user" },
    );
    expect(mine.state).toBe("you");
    expect(mine.ask).toBeUndefined();
    // An item added there with its ask keeps it; too many answers refused.
    const added = await service.add(
      { title: "Try it", state: "verify", ask: "Try it once." },
      agent,
    );
    expect(store.item(added.id)!.ask).toBe("Try it once.");
    await expect(
      service.update(
        { item: added.id, answers: ["1", "2", "3", "4", "5", "6", "7"] },
        agent,
      ),
    ).rejects.toThrow(/at most 6 answers/);
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
      ask: "Say which.",
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

describe("projects of projects and workspace tags", () => {
  /** A desktop with the GStreamer workspaces: a coordinator, a worktree. */
  function gstreamer(over: Partial<WorkServiceDeps> = {}) {
    const made = setup({
      sessions: async () => ["desktop/w32:p1", "desktop/w36:p1"],
      panes: async () => [
        { pane_id: "w32:p1", workspace_id: "w32", cwd: "/g/2.0" },
        { pane_id: "w36:p1", workspace_id: "w36", cwd: "/g/2.0/gst2-video" },
        { pane_id: "w3E:p1", workspace_id: "w3E", cwd: "/g/upstreaming" },
        { pane_id: "w35:p1", workspace_id: "w35", cwd: "/home/me/roamgate" },
      ],
      workspaces: async () => [
        { workspace_id: "w32", label: "gst2" },
        { workspace_id: "w36", label: "gst2-video" },
        {
          workspace_id: "w3E",
          label: "gst-upstreaming",
          worktree: { checkout_path: "/g/upstreaming/ocio" },
        },
        { workspace_id: "w35", label: "roamgate" },
      ],
      ...over,
    });
    const meta = { by: "user" as const };
    made.service.projectSet(
      { name: "gstreamer", roots: ["/g/gstreamer", "/g"] },
      meta,
    );
    made.service.projectSet(
      {
        name: "gst2",
        roots: ["/g/2.0"],
        coordinator: "desktop/w32:p1",
        parent: "gstreamer",
      },
      meta,
    );
    return made;
  }

  test("a parent's list holds its subprojects' items; cycles are refused", async () => {
    const { service } = gstreamer();
    const meta = { by: "user" as const };
    const own = await service.add(
      { project: "gstreamer", title: "Upstream OCIO" },
      meta,
    );
    const sub = await service.add({ project: "gst2", title: "Caps" }, meta);
    expect(service.store.project("gst2")?.parent).toBe("gstreamer");
    expect(
      (await service.list({ project: "gstreamer" })).map((i) => i.id).sort(),
    ).toEqual([own.id, sub.id].sort());
    expect((await service.list({ project: "gst2" })).map((i) => i.id)).toEqual([
      sub.id,
    ]);
    expect(() =>
      service.projectSet({ name: "gstreamer", parent: "gst2" }, meta),
    ).toThrow(/cannot be part of it/);
    expect(() =>
      service.projectSet({ name: "gst2", parent: "nope" }, meta),
    ).toThrow(/no project nope/);
    // Changing another field keeps the parent; null clears it.
    expect(
      service.projectSet({ name: "gst2", tags: ["caps"] }, meta).parent,
    ).toBe("gstreamer");
    expect(
      service.projectSet({ name: "gst2", parent: null }, meta).parent,
    ).toBeUndefined();
  });

  test("an item added from a workspace gets its tag, besides the auto-tags", async () => {
    const { service } = gstreamer();
    const fromForm = await service.add(
      {
        project: "gst2",
        title: "Fix the caps negotiation on the phone",
        workspace: { connectionId: "desktop", workspaceId: "w36" },
      },
      { by: "user" },
    );
    expect(fromForm.tags).toContain("ws:gst2-video");
    expect(fromForm.tags).toContain("phone");
    // A conversation says its pane.
    const fromChat = await service.add(
      {
        project: "gst2",
        title: "From a chat",
        tags: ["caps"],
        workspace: { connectionId: "desktop", paneId: "w36:p1" },
      },
      { by: "user" },
    );
    expect(fromChat.tags).toEqual(["caps", "ws:gst2-video"]);
    // An agent is where its session is.
    const fromAgent = JSON.parse(
      (
        await workTool(
          service,
          "work_add",
          {
            project: "gst2",
            title: "Agent item",
            owner: { session: "desktop/w36:p1" },
          },
          "Claude in gst2-video",
          "desktop/w36:p1",
        )
      )
        .split("\n")
        .slice(1)
        .join("\n"),
    ) as { item: { tags: string[] } };
    expect(fromAgent.item.tags).toContain("ws:gst2-video");
    // workspace: false leaves it out.
    const opted = await service.add(
      { project: "gst2", title: "Not about here", workspace: false },
      { by: "agent", address: "desktop/w36:p1" },
    );
    expect(opted.tags).not.toContain("ws:gst2-video");
  });

  test("no tag from the coordinator's workspace, nor for another tree", async () => {
    const { service } = gstreamer();
    service.projectSet(
      { name: "roamgate", roots: ["/home/me/roamgate"] },
      { by: "user" },
    );
    const coordinator = await service.add(
      { project: "gst2", title: "Plan the next phase" },
      { by: "agent", address: "desktop/w32:p1" },
    );
    expect(coordinator.tags.some((t) => t.startsWith("ws:"))).toBe(false);
    const elsewhere = await service.add(
      {
        project: "roamgate",
        title: "Unrelated",
        workspace: { connectionId: "desktop", workspaceId: "w36" },
      },
      { by: "user" },
    );
    expect(elsewhere.tags.some((t) => t.startsWith("ws:"))).toBe(false);
    // A subproject's workspace tags its parent's items too: one tree.
    const parent = await service.add(
      {
        project: "gstreamer",
        title: "Shared",
        workspace: { connectionId: "desktop", workspaceId: "w36" },
      },
      { by: "user" },
    );
    expect(parent.tags).toContain("ws:gst2-video");
    // The parent's own worktree workspace: its checkout decides.
    const upstreaming = await service.add(
      {
        project: "gstreamer",
        title: "OCIO",
        workspace: { connectionId: "desktop", workspaceId: "w3E" },
      },
      { by: "user" },
    );
    expect(upstreaming.tags).toContain("ws:gst-upstreaming");
  });

  test("a connection that does not answer adds the item untagged", async () => {
    const { service } = gstreamer({
      panes: () => new Promise(() => {}),
    });
    jest.useFakeTimers();
    try {
      const added = service.add(
        {
          project: "gst2",
          title: "Slow",
          workspace: { connectionId: "desktop", workspaceId: "w36" },
        },
        { by: "user" },
      );
      // The add waits on the connection, then gives up on the tag.
      await Promise.resolve();
      jest.advanceTimersByTime(WORK_PLACE_MS);
      const item = await added;
      expect(item.tags.some((t) => t.startsWith("ws:"))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("work_list keeps a workspace's items: its name, its tag, or self", async () => {
    const { service } = gstreamer();
    const here = await service.add(
      {
        project: "gst2",
        title: "Here",
        workspace: { connectionId: "desktop", workspaceId: "w36" },
      },
      { by: "user" },
    );
    await service.add({ project: "gst2", title: "Not here" }, { by: "user" });
    const ids = async (params: Record<string, unknown>, address?: string) =>
      (await service.list(params, address)).map((i) => i.id);
    expect(await ids({ workspace: "gst2-video" })).toEqual([here.id]);
    expect(await ids({ workspace: "ws:gst2-video" })).toEqual([here.id]);
    expect(await ids({ workspace: "self" }, "desktop/w36:p1")).toEqual([
      here.id,
    ]);
    await expect(service.list({ workspace: "self" })).rejects.toThrow(
      /not known/,
    );
  });
});

test("with the rules and the work tools, a triage, a task and a comment each end with one line naming the tool and ids", async () => {
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
    agentTools: () => true,
    agentWorkTools: () => true,
    agentRules: () => true,
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
  const free = await service.add(
    { text: "the phone header scrolls away" },
    { by: "user" },
  );
  await Bun.sleep(80);
  const id = free.id.slice(0, 8);
  const triage = kit.prompts[0]!.text;
  expect(triage).toStartWith(
    `[Roamgate work item ${id} "the phone header scrolls away" (yours, needs triage)]\n`,
  );
  const thread = /- \[([0-9a-f]{8})\]/.exec(triage)![1];
  expect(triage).toEndWith(
    `Triage: mcp__roamgate__work_update item=${id} (title, tags, state); extra tasks: mcp__roamgate__work_add with links [{"kind":"item","id":"${id}"}]. Then mcp__roamgate__review_reply comment_id=${thread}.`,
  );
  expect(triage).not.toContain("yours to sort");
  // Left unanswered at the turn's end: the check names the item to triage.
  const freeReview = service.threads({ item: free.id, open: true })!.session.id;
  expect(kit.service.agentDue(freeReview)).toMatchObject({
    triageItem: free.id,
  });
  expect(kit.service.agentDue(freeReview).threads).toEqual([]);
  // A task given to it, and a comment on it.
  const task = await service.add(
    { title: "Fold the header", text: "Fold it on scroll." },
    { by: "user" },
  );
  await Bun.sleep(80);
  const todo = kit.prompts[1]!.text;
  expect(todo).toMatch(
    new RegExp(
      `Take it: mcp__roamgate__work_update item=${task.id.slice(0, 8)} state=doing owner=<your address or subagent>; or give it to another session\\. Answer: mcp__roamgate__review_reply comment_id=[0-9a-f]{8}\\.$`,
    ),
  );
  const snapshot = service.threads({ item: task.id, open: true })!;
  await kit.service.addThread({
    sessionId: snapshot.session.id,
    author: "you",
    text: "Any news?",
    anchor: { work: { item: task.id } },
    kind: "discussion",
  });
  await Bun.sleep(80);
  expect(kit.prompts[2]!.text).toMatch(
    new RegExp(
      `Answer: mcp__roamgate__review_reply comment_id=[0-9a-f]{8}\\. Move the item: mcp__roamgate__work_update item=${task.id.slice(0, 8)} \\(or work_done, work_reopen\\)\\.$`,
    ),
  );
  // Each far shorter than the paragraph it replaces.
  for (const prompt of kit.prompts)
    expect(prompt.text.length).toBeLessThan(600);
});

test("the owner's first new title clears needs_triage; another's, the user's or the same title do not", async () => {
  const { service } = setup({
    panes: async () => [{ pane_id: "w35:p1", workspace_id: "w35" }],
  });
  service.projectSet(
    { name: "roamgate", coordinator: "desktop/w35:p1" },
    { by: "user" },
  );
  const owner = {
    by: "agent" as const,
    caller: "Claude in roamgate",
    address: "desktop/w35:p1",
  };
  const item = await service.add({ text: "words to sort" }, { by: "user" });
  expect(item.needsTriage).toBe(true);
  // Tags alone, or another agent's title: still marked.
  const tagged = await service.update(
    { item: item.id, add_tags: ["board"] },
    owner,
  );
  expect(tagged.needsTriage).toBe(true);
  const other = await service.update(
    { item: item.id, title: "Someone else's" },
    { by: "agent", caller: "Codex", address: "desktop/w9:p1" },
  );
  expect(other.needsTriage).toBe(true);
  const user = await service.update(
    { item: item.id, title: "The user's" },
    { by: "user" },
  );
  expect(user.needsTriage).toBe(true);
  // The owner's own title: sorted.
  const sorted = await service.update(
    { item: item.id, title: "Words, sorted" },
    owner,
  );
  expect(sorted.needsTriage).toBeUndefined();
  // Said as a change, as a cleared mark is.
  const again = await service.add(
    { text: "more words to sort" },
    { by: "user" },
  );
  const kept = await service.update(
    { item: again.id, title: "Sorted, still marked", needs_triage: true },
    owner,
  );
  expect(kept.needsTriage).toBe(true);
});
