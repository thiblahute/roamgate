import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReviewPush, threadNeedsAnswer } from "../../../shared/review";
import {
  createReviewService,
  type ReviewService,
  reviewsBranch,
} from "./service";
import { openReviewStorage } from "./storage";
import { ReviewGoneError } from "../workspace/review-patch";

const directories: string[] = [];
const services: ReviewService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(directory?: string) {
  const dir =
    directory ??
    (() => {
      const path = mkdtempSync(join(tmpdir(), "roamgate-review-"));
      directories.push(path);
      return path;
    })();
  const pushes: ReviewPush[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: (push) => pushes.push(push),
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  services.push(service);
  return { dir, service, pushes };
}

function openSession(service: ReviewService) {
  return service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "HEAD" },
    agent: "Claude",
    paneId: "w1:p2",
  }).session;
}

test("open finds the existing session for the same checkout and target", async () => {
  const { service, pushes } = setup();
  const first = openSession(service);
  const second = openSession(service);
  expect(second.id).toBe(first.id);
  expect(first.title).toBe("main..HEAD");
  expect(first.gitlab).toBe(false);
  expect(pushes.filter((push) => push.type === "open")).toHaveLength(2);
  const other = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "worktree" },
    raise: false,
  });
  expect(other.session.id).not.toBe(first.id);
  expect(pushes.at(-1)?.type).toBe("session");
});

test("targets refuse option-like or multi-word refs and non-MR URLs", async () => {
  const { service } = setup();
  const open = (target: unknown) =>
    service.open({ connectionId: "local", root: "/repo", target });
  expect(() =>
    open({ kind: "range", base: "--output=x", head: "HEAD" }),
  ).toThrow();
  expect(() =>
    open({ kind: "range", base: "main HEAD", head: "HEAD" }),
  ).toThrow();
  expect(() =>
    open({ kind: "mr", url: "http://gitlab.example/x/-/merge_requests/1" }),
  ).toThrow();
  const mr = open({
    kind: "mr",
    url: "https://gitlab.example/group/project/-/merge_requests/7#note_1",
  });
  expect(mr.session.target).toEqual({
    kind: "mr",
    url: "https://gitlab.example/group/project/-/merge_requests/7",
  });
  expect(mr.session.gitlab).toBe(true);
});

test("threads, replies and the needs-an-answer rule", async () => {
  const { service } = setup();
  const session = openSession(service);
  const thread = await service.addThread({
    sessionId: session.id,
    anchor: { path: "src/a.ts", line: 3, side: "new", text: "let x = 1;" },
    text: "Why a let?",
  });
  expect(thread.comments[0]!.author).toBe("you");

  const first = await service.watch({ sessionId: session.id, agent: "Claude" });
  expect(first.outcome).toBe("unanswered");
  expect(first.threads.map((t) => t.id)).toEqual([thread.id]);

  // The agent answers by comment id prefix; the thread no longer waits on it.
  await service.reply({
    sessionId: session.id,
    commentId: thread.comments[0]!.id.slice(0, 6),
    author: "Claude",
    text: "Fixed in abc123",
  });
  const waiting = service.watch({
    sessionId: session.id,
    agent: "Claude",
    timeoutMs: 1_000,
  });
  await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    text: "Thanks",
  });
  const woke = await waiting;
  expect(woke.outcome).toBe("unanswered");
  expect(woke.threads[0]!.comments.map((c) => c.author)).toEqual([
    "you",
    "Claude",
    "you",
  ]);
});

test("a handoff wakes the agent even with nothing to answer", async () => {
  const { service } = setup();
  const session = openSession(service);
  const waiting = service.watch({
    sessionId: session.id,
    agent: "Claude",
    timeoutMs: 1_000,
  });
  service.handoff({ sessionId: session.id });
  expect((await waiting).outcome).toBe("handoff");
});

test("watch times out and reports a removed review as gone", async () => {
  const { service } = setup();
  const session = openSession(service);
  expect(
    (
      await service.watch({
        sessionId: session.id,
        agent: "Claude",
        timeoutMs: 5,
      })
    ).outcome,
  ).toBe("timeout");
  const waiting = service.watch({
    sessionId: session.id,
    agent: "Claude",
    mode: "any",
    timeoutMs: 1_000,
  });
  service.remove({ sessionId: session.id });
  expect((await waiting).outcome).toBe("gone");
});

test("agents edit and delete only their own comments; the user takes over drafts", async () => {
  const { service } = setup();
  const session = openSession(service);
  const draft = await service.addThread({
    sessionId: session.id,
    kind: "draft",
    anchor: { path: "a.c", line: 1 },
    author: "Claude",
    text: "Leaks on error",
  });
  const mine = await service.addThread({
    sessionId: session.id,
    anchor: { path: "a.c", line: 2 },
    text: "Mine",
  });
  await expect(
    service.edit({
      sessionId: session.id,
      commentId: mine.id,
      author: "Claude",
      text: "Changed",
    }),
  ).rejects.toThrow("only edit its own");
  const edited = await service.edit({
    sessionId: session.id,
    commentId: draft.comments[0]!.id,
    text: "Leaks the buffer on error",
  });
  expect(edited.comments[0]!.author).toBe("you");
  await expect(
    service.deleteComment({
      sessionId: session.id,
      commentId: mine.id,
      author: "Claude",
    }),
  ).rejects.toThrow("only delete its own");
  expect(
    (await service.deleteComment({ sessionId: session.id, commentId: mine.id }))
      .thread,
  ).toBeNull();
  expect(service.get({ sessionId: session.id }).threads).toHaveLength(1);
});

test("an agent reply keeps a resolved thread resolved; the user's reopens it", async () => {
  const { service } = setup();
  const session = openSession(service);
  const thread = await service.addThread({
    sessionId: session.id,
    text: "Overall?",
  });
  service.resolve({ sessionId: session.id, commentId: thread.id });
  expect(
    (
      await service.reply({
        sessionId: session.id,
        commentId: thread.id,
        author: "Claude",
        text: "Noted",
      })
    ).resolved,
  ).toBe(true);
  expect(
    (
      await service.reply({
        sessionId: session.id,
        commentId: thread.id,
        text: "Wait",
      })
    ).resolved,
  ).toBe(false);
});

test("reviews survive a restart, and a deleted thread can be restored", async () => {
  const first = setup();
  const session = openSession(first.service);
  const thread = await first.service.addThread({
    sessionId: session.id,
    kind: "draft",
    anchor: { path: "a.c", line: 4, side: "old", endLine: 6 },
    text: "Range",
  });
  await first.service.update({ sessionId: session.id, summary: "Looks good" });
  await first.service.deleteComment({
    sessionId: session.id,
    commentId: thread.id,
  });
  await first.service.restoreThread({ sessionId: session.id, thread });
  first.service.close();
  services.splice(services.indexOf(first.service), 1);

  const second = setup(first.dir);
  const restored = second.service.get({ sessionId: session.id });
  expect(restored.session.summary).toBe("Looks good");
  expect(restored.threads).toHaveLength(1);
  expect(restored.threads[0]!.anchor).toEqual({
    path: "a.c",
    line: 4,
    endLine: 6,
    side: "old",
  });
});

test("agent status: working, update and done", async () => {
  const { service } = setup();
  const session = openSession(service);
  service.agentStatus({
    sessionId: session.id,
    state: "working",
    message: "Fixing the leak",
  });
  expect(
    service.get({ sessionId: session.id }).session.agent.working?.message,
  ).toBe("Fixing the leak");
  service.agentStatus({
    sessionId: session.id,
    state: "update",
    message: "Pushed",
  });
  const after = service.get({ sessionId: session.id }).session.agent;
  expect(after.working).toBeUndefined();
  expect(after.update?.message).toBe("Pushed");
});

test("agent status on one thread lasts until the agent answers it", async () => {
  const { service } = setup();
  const session = openSession(service);
  const thread = await service.addThread({
    sessionId: session.id,
    anchor: { path: "src/a.ts", line: 3, side: "new" },
    text: "Free it on error",
  });
  service.agentStatus({
    sessionId: session.id,
    state: "working",
    commentId: thread.comments[0]!.id.slice(0, 6),
    message: "Freeing the buffer",
  });
  expect(service.get({ sessionId: session.id }).session.agent.working).toEqual({
    at: expect.any(String),
    message: "Freeing the buffer",
    threadId: thread.id,
  });
  // The user's own reply does not end it; the agent's does.
  await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    text: "Thanks",
  });
  expect(
    service.get({ sessionId: session.id }).session.agent.working?.threadId,
  ).toBe(thread.id);
  await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    author: "Claude",
    text: "Freed in abc123",
  });
  expect(
    service.get({ sessionId: session.id }).session.agent.working,
  ).toBeUndefined();
  expect(() =>
    service.agentStatus({
      sessionId: session.id,
      state: "working",
      commentId: "nope",
    }),
  ).toThrow("no such comment");
});

test("activity tells which branches moved since their diff was seen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  let head = "aaaaaaa1";
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false, headSha: head }),
    loadHeads: async (_connection, entries) => entries.map(() => head),
  });
  services.push(service);
  const session = openSession(service);
  await service.diff({ sessionId: session.id });
  expect((await service.activity({ connectionId: "local" })).activity).toEqual([
    { sessionId: session.id, headSha: "aaaaaaa1", newCommits: false },
  ]);
  head = "bbbbbbb2";
  expect(
    (await service.activity({ connectionId: "local" })).activity[0]!.newCommits,
  ).toBe(true);
  await service.diff({ sessionId: session.id });
  expect(
    (await service.activity({ connectionId: "local" })).activity[0]!.newCommits,
  ).toBe(false);
});

test("a removed checkout is remembered, not asked of the host each poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  let now = Date.parse("2026-10-30T10:00:00Z");
  const calls: string[] = [];
  const goneError = () =>
    new ReviewGoneError(
      "checkout-gone",
      "This checkout no longer exists: /repo",
    );
  let removed = true;
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    now: () => new Date(now),
    loadDiff: async () => {
      calls.push("diff");
      if (removed) throw goneError();
      return { files: [], truncated: false };
    },
    loadCommits: async () => {
      calls.push("commits");
      if (removed) throw goneError();
      return [];
    },
    loadState: async () => {
      calls.push("state");
      if (removed) throw goneError();
      return "s";
    },
    loadHeads: async (_connection, entries) => {
      calls.push(`heads ${entries.length}`);
      return entries.map(() => null);
    },
  });
  services.push(service);
  const session = openSession(service);
  const sessionId = session.id;
  await expect(service.commits({ sessionId })).rejects.toThrow(
    "This checkout no longer exists: /repo",
  );
  await expect(service.diff({ sessionId })).rejects.toBeInstanceOf(
    ReviewGoneError,
  );
  await expect(service.state({ sessionId })).rejects.toThrow(
    "no longer exists",
  );
  // The list says so, without asking the host about that review.
  expect((await service.activity({ connectionId: "local" })).activity).toEqual([
    { sessionId, newCommits: false, gone: "checkout-gone" },
  ]);
  expect(calls).toEqual(["commits"]);
  // Opening the overlay again checks again.
  await expect(
    service.commits({ sessionId, recheck: true }),
  ).rejects.toBeInstanceOf(ReviewGoneError);
  expect(calls).toEqual(["commits", "commits"]);
  // After a while, the host is asked again; the checkout is back.
  removed = false;
  now += 6 * 60_000;
  expect(await service.state({ sessionId })).toEqual({ state: "s" });
  expect((await service.activity({ connectionId: "local" })).activity).toEqual([
    { sessionId, newCommits: false },
  ]);
  expect(calls.slice(2)).toEqual(["state", "heads 1"]);
});

test("a merge request's review is never given up for its checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  let calls = 0;
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => {
      calls++;
      throw new ReviewGoneError("checkout-gone", "gone");
    },
  });
  services.push(service);
  // Its loader falls back to GitLab; what still fails is not remembered.
  const { session } = service.open({
    connectionId: "local",
    root: "/gone",
    target: {
      kind: "mr",
      url: "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
    },
  });
  await expect(service.diff({ sessionId: session.id })).rejects.toThrow("gone");
  await expect(service.diff({ sessionId: session.id })).rejects.toThrow("gone");
  expect(calls).toBe(2);
});

test("a range whose base is gone can compare against another", async () => {
  const { service } = setup();
  const session = openSession(service);
  const sibling = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "origin/main", head: "HEAD" },
    raise: false,
  }).session;
  await expect(
    service.update({ sessionId: session.id, base: "origin/main" }),
  ).rejects.toThrow("another review already compares origin/main..HEAD");
  service.remove({ sessionId: sibling.id });
  const moved = await service.update({
    sessionId: session.id,
    base: "origin/main",
  });
  expect(moved.session.target).toEqual({
    kind: "range",
    base: "origin/main",
    head: "HEAD",
  });
  expect(moved.session.title).toBe("origin/main..HEAD");
  await expect(
    service.update({ sessionId: session.id, base: "--bad" }),
  ).rejects.toThrow("invalid base");
  const worktree = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "worktree" },
    raise: false,
  }).session;
  await expect(
    service.update({ sessionId: worktree.id, base: "main" }),
  ).rejects.toThrow("only a range review has a base");
});

test("a discarded review comes back with its threads", async () => {
  const { service } = setup();
  const session = openSession(service);
  await service.addThread({
    sessionId: session.id,
    kind: "draft",
    text: "Keep me",
  });
  await service.update({ sessionId: session.id, summary: "Summary" });
  const saved = service.get({ sessionId: session.id });
  service.remove({ sessionId: session.id });
  expect(() => service.get({ sessionId: session.id })).toThrow();
  const back = service.importSession({
    connectionId: "local",
    snapshot: saved,
  });
  expect(back.session.id).toBe(session.id);
  expect(back.session.summary).toBe("Summary");
  expect(back.threads.map((t) => t.comments[0]!.body)).toEqual(["Keep me"]);
  expect(() =>
    service.importSession({ connectionId: "remote", snapshot: saved }),
  ).toThrow();
});

test("a merge request's review: drafts are draft notes; agents write only here", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const posted: string[][] = [];
  let project = "gst/gstreamer";
  let at = Date.parse("2026-10-29T10:00:00Z");
  let nextDraft = 11;
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    now: () => new Date(at),
    gitlab: {
      checkout: async () => checkoutOn("fix", "a1"),
      find: async () => ({
        url: `https://gitlab.example/${project}/-/merge_requests/3`,
        title: "Fix",
        number: 3,
        state: "opened",
        branch: "fix",
      }),
      context: () => ({
        root: "/repo",
        shQuote: (value) => value,
        runProcessWithCodeTimeout: async (argv) => {
          const method = argv[argv.indexOf("--method") + 1];
          const path = argv.find((arg) => arg.startsWith("projects/"))!;
          if (method !== "GET") posted.push(argv);
          const body = path.endsWith("/discussions?per_page=100")
            ? [
                {
                  id: "d1",
                  notes: [{ id: 1, body: "Hm", author: { username: "x" } }],
                },
              ]
            : path.endsWith("/draft_notes?per_page=100")
              ? []
              : path.endsWith("/draft_notes")
                ? {
                    id: nextDraft++,
                    note:
                      argv.find((arg) => arg.startsWith("note="))?.slice(5) ??
                      "",
                    position: { new_path: "a.c", new_line: 2 },
                  }
                : {
                    web_url: "u",
                    diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
                  };
          return { code: 0, stdout: JSON.stringify(body), stderr: "" };
        },
      }),
    },
  });
  services.push(service);
  const local = service.open({
    connectionId: "local",
    root: "/repo",
    workspaceId: "w1",
    target: { kind: "range", base: "main", head: "HEAD" },
    agent: "Claude",
  }).session;
  // GitLab is the merge request's own review, opened from the local one.
  const opened = await service.openGitlab({ sessionId: local.id });
  expect(opened.mergeRequest?.number).toBe(3);
  const session = opened.snapshot!.session;
  expect(session.target).toEqual({
    kind: "mr",
    url: "https://gitlab.example/gst/gstreamer/-/merge_requests/3",
  });
  expect(session).toMatchObject({ gitlab: true, workspaceId: "w1" });
  expect(session.agent.name).toBe("Claude");
  expect(
    (await service.openGitlab({ sessionId: local.id })).snapshot?.session.id,
  ).toBe(session.id);
  await service.refreshGitlab({ sessionId: session.id });
  const draft = await service.addThread({
    sessionId: session.id,
    kind: "draft",
    anchor: { path: "a.c", line: 2, side: "new" },
    text: "Leak",
  });
  expect(draft.id).toBe("gldraft:11");
  expect(posted).toHaveLength(1);
  const snapshot = service.get({ sessionId: session.id });
  expect(snapshot.threads.map((t) => t.id)).toEqual(["gl:d1", "gldraft:11"]);
  expect(snapshot.mergeRequest?.security).toBe(false);
  // An agent's answer to a discussion, and its review comment, stay here
  // as the user's review comments: nothing reaches GitLab.
  const reply = await service.reply({
    sessionId: session.id,
    commentId: "gl:d1",
    author: "Claude",
    text: "I agree",
  });
  expect(reply).toMatchObject({ kind: "draft", gitlabReplyTo: "d1" });
  expect(reply.id).not.toMatch(/^gl/);
  const comment = await service.addThread({
    sessionId: session.id,
    kind: "draft",
    anchor: { path: "a.c", line: 2, side: "new" },
    author: "Claude",
    text: "Also here",
  });
  expect(comment.gitlab).toBeUndefined();
  await service.agentSummary({
    sessionId: session.id,
    author: "Claude",
    text: "Fine overall",
  });
  expect(service.get({ sessionId: session.id }).session.summaryUnsent).toBe(
    true,
  );
  expect(posted).toHaveLength(1);
  // The user sends them: a draft reply in the discussion, a draft note and
  // the overall comment.
  await service.pushLocalDrafts({ sessionId: session.id });
  expect(posted).toHaveLength(4);
  expect(posted[3]).toContain("note=Fine overall");
  expect(
    service.get({ sessionId: session.id }).session.summaryUnsent,
  ).toBeUndefined();
  expect(posted[1]).toContain("in_reply_to_discussion_id=d1");
  expect(posted[1]).toContain("note=I agree");
  expect(posted[2]).not.toContain("in_reply_to_discussion_id=d1");
  expect(posted[2]).toContain("note=Also here");
  const sent = service.get({ sessionId: session.id }).threads;
  expect(sent.some((t) => !t.gitlab)).toBe(false);
  expect(sent.find((t) => t.id === "gl:d1")?.comments.at(-1)).toMatchObject({
    gitlabDraftId: 12,
    body: "I agree",
  });
  await expect(
    service.edit({
      sessionId: session.id,
      commentId: "gldraft:11",
      author: "Claude",
      text: "Mine now",
    }),
  ).rejects.toThrow("only your own draft notes");
  // The user rewords their draft reply on GitLab.
  await service.edit({
    sessionId: session.id,
    commentId: "gldraft:12",
    text: "Agreed",
  });
  expect(posted).toHaveLength(5);
  expect(posted[4]?.join(" ")).toContain("/draft_notes/12");

  // The local review shows none of it.
  expect(service.get({ sessionId: local.id }).threads).toEqual([]);
  expect(service.get({ sessionId: local.id }).mergeRequest).toBeUndefined();

  // The branch's merge request is looked up again after a while: another
  // merge request is another review, a security one kept from agents.
  project = "gst/security";
  at += 6 * 60_000;
  const secure = (await service.openGitlab({ sessionId: local.id })).snapshot!
    .session;
  expect(secure.id).not.toBe(session.id);
  await service.refreshGitlab({ sessionId: secure.id });
  expect(service.get({ sessionId: secure.id }).mergeRequest?.security).toBe(
    true,
  );
  expect(() =>
    service.assertAgentAllowed({ sessionId: secure.id, author: "Claude" }),
  ).toThrow("security merge request");
});

test("agent review: the previous pass goes, the prompt reaches the pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: { pane: string; text: string }[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    promptAgent: async (_connection, pane, text) => {
      prompts.push({ pane, text });
    },
  });
  services.push(service);
  const session = openSession(service);
  await service.addThread({
    sessionId: session.id,
    kind: "draft",
    author: "Claude",
    text: "old pass",
  });
  const kept = await service.addThread({
    sessionId: session.id,
    kind: "draft",
    author: "Claude",
    text: "edited by me",
  });
  await service.edit({
    sessionId: session.id,
    commentId: kept.id,
    text: "mine now",
  });
  await service.requestAgentReview({
    sessionId: session.id,
    focus: "locking",
  });
  const after = service.get({ sessionId: session.id });
  expect(after.threads.map((t) => t.comments[0]!.body)).toEqual(["mine now"]);
  expect(after.session.agent.working?.message).toBe("reviewing");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.pane).toBe("w1:p2");
  expect(prompts[0]!.text).toContain("Focus on: locking");
  expect(prompts[0]!.text).toContain(`--session ${session.id.slice(0, 8)}`);

  // The summary is the agent's only while the user has none.
  expect(
    await service.agentSummary({
      sessionId: session.id,
      author: "Claude",
      text: "Looks right",
    }),
  ).toEqual({ kept: true });
  await service.update({ sessionId: session.id, summary: "My words" });
  expect(
    await service.agentSummary({
      sessionId: session.id,
      author: "Claude",
      text: "Override",
    }),
  ).toEqual({ kept: false });

  // A handoff prompts the pane only when no watch is waiting.
  await service.handoff({ sessionId: session.id });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]!.text).toContain("My words");
  const waiting = service.watch({
    sessionId: session.id,
    agent: "Claude",
    mode: "any",
    timeoutMs: 1_000,
  });
  await service.handoff({ sessionId: session.id });
  expect((await waiting).outcome).toBe("handoff");
  expect(prompts).toHaveLength(2);
});

test("the overall comment goes to the agent with a handoff, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  await service.update({ sessionId: session.id, summary: "All good" });
  await service.handoff({ sessionId: session.id });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("My overall comment on the review:\n  All good");
  // Sent once: the next handoff only points at the discussions.
  await service.handoff({ sessionId: session.id });
  expect(prompts[1]).not.toContain("All good");

  // A watching agent gets it in the handoff instead.
  await service.update({ sessionId: session.id, summary: "Ship it" });
  const waiting = service.watch({
    sessionId: session.id,
    agent: "Claude",
    mode: "any",
    timeoutMs: 1_000,
  });
  await service.handoff({ sessionId: session.id });
  const woke = await waiting;
  expect(woke.outcome).toBe("handoff");
  expect(woke.summary).toBe("Ship it");
  expect(prompts).toHaveLength(2);

  // The agent's own summary is not handed back to it.
  await service.update({ sessionId: session.id, summary: "" });
  await service.agentSummary({
    sessionId: session.id,
    author: "Claude",
    text: "Looks right",
  });
  await service.handoff({ sessionId: session.id });
  expect(prompts[2]).not.toContain("Looks right");
});

test("held comments wait for the user's handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 20,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  await service.update({ sessionId: session.id, holdComments: true });
  await service.addThread({ sessionId: session.id, text: "First" });
  await service.addThread({ sessionId: session.id, text: "Second" });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(0);
  // A watching agent does not wake for them either.
  const watching = service.watch({
    sessionId: session.id,
    agent: "Claude",
    timeoutMs: 60,
  });
  expect((await watching).outcome).toBe("timeout");
  // Send hands them over in one prompt.
  await service.handoff({ sessionId: session.id });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("2 comments from me");
  // Letting go of the hold sends what was held.
  await Bun.sleep(5);
  await service.addThread({ sessionId: session.id, text: "Third" });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(1);
  await service.update({ sessionId: session.id, holdComments: false });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Third");
});

test("the user's comments reach the agent by themselves, batched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 20,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  expect(session.autoSend).toBe(true);
  await service.addThread({
    sessionId: session.id,
    anchor: { path: "a.c", line: 3, side: "new", text: "x = 1;" },
    text: "Why 1?",
  });
  await service.addThread({ sessionId: session.id, text: "And the tests?" });
  // A review comment for the MR is not a message to the agent.
  await service.addThread({
    sessionId: session.id,
    kind: "draft",
    text: "Not for the agent",
  });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("2 comments from me");
  expect(prompts[0]).toContain("on a.c:3 (`x = 1;`)");
  expect(prompts[0]).toContain("Why 1?");
  expect(prompts[0]).toContain("And the tests?");
  expect(prompts[0]).not.toContain("Not for the agent");
  // Comments come by themselves: the agent is not told to wait for them.
  expect(prompts[0]).not.toContain("watch");

  // Delivered comments are not sent twice; a new reply is.
  const first = service
    .get({ sessionId: session.id })
    .threads.find((t) => t.comments[0]!.body === "Why 1?")!;
  await service.reply({
    sessionId: session.id,
    commentId: first.id,
    author: "Claude",
    text: "Fixed",
  });
  await service.reply({
    sessionId: session.id,
    commentId: first.id,
    text: "Thanks, and line 4?",
  });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("A comment from me");
  expect(prompts[1]).toContain("line 4?");
  expect(prompts[1]).not.toContain("And the tests?");

  // A watching agent wakes instead of being typed at. It answers first, so
  // nothing is waiting on it when it starts watching.
  for (const thread of service.get({ sessionId: session.id }).threads)
    if (thread.kind === "discussion")
      await service.reply({
        sessionId: session.id,
        commentId: thread.id,
        author: "Claude",
        text: "Done",
      });
  const waiting = service.watch({
    sessionId: session.id,
    agent: "Claude",
    timeoutMs: 1_000,
  });
  await service.addThread({ sessionId: session.id, text: "One more" });
  expect((await waiting).outcome).toBe("unanswered");
  await Bun.sleep(80);
  expect(prompts).toHaveLength(2);

  // Auto-send off: nothing is typed until the user sends.
  await service.update({ sessionId: session.id, autoSend: false });
  await service.addThread({ sessionId: session.id, text: "Held back" });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(2);
  await service.handoff({ sessionId: session.id });
  expect(prompts).toHaveLength(3);
  expect(prompts[2]).toContain("Held back");
});

test("a comment on a commit message reaches the agent as such", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 10,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  await service.addThread({
    sessionId: session.id,
    anchor: {
      path: ":commit-message",
      line: 1,
      side: "new",
      text: "cuda: fix",
      commit: "a".repeat(40),
      commitSubject: "cuda: fix",
    },
    text: "Say what it fixes",
  });
  await Bun.sleep(60);
  expect(prompts[0]).toContain(
    'on line 1 of the commit message in "cuda: fix"',
  );
});

test("a comment on a part of a message reaches the agent with its quote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 10,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  const anchor = { path: "plan.md", line: 3, side: "new" as const };
  const plan = await service.addThread({
    sessionId: session.id,
    author: "Claude",
    anchor,
    text: "Option A.\n\nOption B, which I lean to.",
  });
  const message = {
    thread: plan.id,
    comment: plan.comments[0]!.id,
    quote: "Option B, which I lean to.",
  };
  const part = await service.addThread({
    sessionId: session.id,
    anchor: { ...anchor, message },
    text: "Why B?",
  });
  expect(part.anchor.message).toEqual(message);
  await Bun.sleep(60);
  const prompt = prompts.join("\n");
  expect(prompt).toContain(
    `on a part of a message in thread [${plan.id.slice(0, 8)}] (on plan.md:3)`,
  );
  expect(prompt).toContain("  > Option B, which I lean to.");
  expect(prompt).toContain("Why B?");
  await expect(
    service.addThread({
      sessionId: session.id,
      anchor: { ...anchor, message: { ...message, quote: " " } },
      text: "No quote",
    }),
  ).rejects.toThrow("a message part needs its thread, comment and quote");
});

test("attaching an agent delivers what was written; failures are reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: { pane: string; text: string }[] = [];
  let failing = false;
  const errors: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 10,
    onDeliveryError: (_session, reason) => errors.push(reason),
    retryDelayMs: 30,
    promptAgent: async (_connection, pane, text) => {
      if (failing) throw new Error("agent_blocked: busy");
      prompts.push({ pane, text });
    },
  });
  services.push(service);
  // A review opened from the browser before any agent was attached.
  const session = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "HEAD" },
    raise: false,
  }).session;
  await service.addThread({ sessionId: session.id, text: "Written before" });
  await Bun.sleep(40);
  expect(prompts).toHaveLength(0);
  await service.update({
    sessionId: session.id,
    agent: "Claude",
    paneId: "w2:p1",
  });
  await Bun.sleep(40);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.pane).toBe("w2:p1");
  expect(prompts[0]!.text).toContain("Written before");
  // An attached agent is not replaced by a later attach.
  await service.update({
    sessionId: session.id,
    agent: "Other",
    paneId: "w9:p9",
  });
  expect(service.get({ sessionId: session.id }).session.agent.paneId).toBe(
    "w2:p1",
  );

  failing = true;
  await service.addThread({ sessionId: session.id, text: "Lost?" });
  await Bun.sleep(40);
  expect(errors).toEqual(["agent_blocked: busy"]);
  expect(
    service.get({ sessionId: session.id }).session.deliveryError,
  ).toContain("agent_blocked");
  // A blocked agent gets them once it is free, without the user resending.
  failing = false;
  await Bun.sleep(80);
  expect(prompts.at(-1)!.text).toContain("Lost?");
  expect(
    service.get({ sessionId: session.id }).session.deliveryError,
  ).toBeUndefined();
});

test("an edit to an answered comment reaches the agent again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 10,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  const thread = await service.addThread({
    sessionId: session.id,
    text: "Do you see me?",
  });
  await Bun.sleep(40);
  expect(prompts).toHaveLength(1);
  const answered = await service.reply({
    sessionId: session.id,
    commentId: thread.id,
    author: "Claude",
    text: "Yes",
  });
  expect(threadNeedsAnswer(answered, "Claude")).toBe(false);

  await Bun.sleep(5);
  const edited = await service.edit({
    sessionId: session.id,
    commentId: thread.comments[0]!.id,
    text: "Do you see me now?",
  });
  expect(threadNeedsAnswer(edited, "Claude")).toBe(true);
  await Bun.sleep(40);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("I edited my comment");
  expect(prompts[1]).toContain("Do you see me now?");

  // The agent rewrites its own answer; that settles the thread again.
  await Bun.sleep(5);
  const rewritten = await service.edit({
    sessionId: session.id,
    commentId: answered.comments[1]!.id,
    author: "Claude",
    text: "Yes, now too",
  });
  expect(threadNeedsAnswer(rewritten, "Claude")).toBe(false);
});

test("an agent watching one repository hears about the workspace's others", async () => {
  const { service } = setup();
  const open = (root: string, workspaceId: string) =>
    service.open({
      connectionId: "local",
      root,
      workspaceId,
      target: { kind: "range", base: "main", head: "HEAD" },
      agent: "Claude",
    }).session;
  const app = open("/work/app", "w1");
  const lib = open("/work/lib", "w1");
  const elsewhere = open("/work/other", "w2");

  const waiting = service.watch({
    sessionId: app.id,
    agent: "Claude",
    timeoutMs: 1_000,
  });
  // Another workspace's comment does not wake it; the library's does.
  await service.addThread({ sessionId: elsewhere.id, text: "Not yours" });
  const thread = await service.addThread({
    sessionId: lib.id,
    text: "Why this API?",
  });
  const result = await waiting;
  expect(result.outcome).toBe("unanswered");
  expect(result.threads.map((t) => t.id)).toEqual([thread.id]);
  expect(result.threads[0]!.sessionId).toBe(lib.id);

  // A comment id is enough to find its review.
  expect(
    service.sessionOfComment({ connectionId: "local", commentId: thread.id }),
  ).toBe(lib.id);
  expect(
    service.sessionOfComment({ connectionId: "local", commentId: "nope" }),
  ).toBeNull();
});

test("in a local review a suggested change goes to the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 20,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  services.push(service);
  const session = openSession(service);
  // A plain review comment stays the user's, for the merge request.
  await service.addThread({
    sessionId: session.id,
    kind: "draft",
    anchor: { path: "a.c", line: 3, side: "new", text: "x = 1;" },
    text: "Nit: naming",
  });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(0);
  await service.addThread({
    sessionId: session.id,
    kind: "draft",
    anchor: { path: "a.c", line: 4, side: "new", text: "y = 2;" },
    text: "```suggestion:-0+0\ny = 3;\n```",
  });
  await Bun.sleep(80);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("y = 3;");
  expect(prompts[0]).toContain("A suggested change: apply it");
  expect(prompts[0]).not.toContain("Nit: naming");
});

function checkoutOn(branch: string | null, head: string | null) {
  return {
    branch,
    head,
    defaultBranch: "main",
    remoteHeads: {},
    upstream: null,
    pushRemote: null,
    remotes: {},
    gitlabHost: "gitlab.example",
    gitlabLogins: [],
  };
}

type Found = {
  url: string;
  title: string;
  number: number;
  state: string;
  branch: string;
} | null;

function findSetup(
  find: () => Promise<Found>,
  options: {
    /** Answers glab's API calls; without it glab must not run. */
    glab?: (argv: string[]) => unknown;
    dir?: string;
    pushes?: ReviewPush[];
  } = {},
) {
  const dir =
    options.dir ??
    (() => {
      const path = mkdtempSync(join(tmpdir(), "roamgate-review-"));
      directories.push(path);
      return path;
    })();
  const clock = {
    at: Date.parse("2026-10-29T10:00:00Z"),
    head: "a1",
    branch: "fix" as string | null,
    unreadable: false,
    checkouts: 0,
  };
  const calls: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: (push) => options.pushes?.push(push),
    loadDiff: async () => ({ files: [], truncated: false }),
    loadHeads: async (_connection, entries) => entries.map(() => clock.head),
    now: () => new Date(clock.at),
    gitlab: {
      checkout: async () => {
        clock.checkouts++;
        if (clock.unreadable) throw new Error("ssh: host unreachable");
        return checkoutOn(clock.branch, clock.head);
      },
      find: async () => {
        calls.push("find");
        return find();
      },
      // Detection never reaches glab itself.
      context: () => ({
        root: "/repo",
        shQuote: (value) => value,
        runProcessWithCodeTimeout: async (argv) => {
          if (!options.glab) throw new Error("glab must not run");
          return {
            code: 0,
            stdout: JSON.stringify(options.glab(argv)),
            stderr: "",
          };
        },
      }),
    },
  });
  services.push(service);
  return { service, clock, calls };
}

const fixRequest = {
  url: "https://gitlab.example/gst/gstreamer/-/merge_requests/10046",
  title: "Fix the leak",
  number: 10046,
  state: "opened",
  branch: "fix",
};

test("a local review finds its branch's merge request, cached until the head moves", async () => {
  const { service, clock, calls } = findSetup(async () => fixRequest);
  const session = openSession(service);
  const find = () => service.findGitlab({ sessionId: session.id });
  expect(await find()).toEqual({
    mergeRequest: {
      url: fixRequest.url,
      title: "Fix the leak",
      number: 10046,
    },
  });
  await Promise.all([find(), find()]);
  expect(calls).toHaveLength(1);
  // A new commit, or a while later: asked again.
  clock.head = "b2";
  await find();
  expect(calls).toHaveLength(2);
  clock.at += 6 * 60_000;
  await find();
  expect(calls).toHaveLength(3);
  // Finding it changes nothing in the review.
  expect(service.get({ sessionId: session.id }).session.gitlab).toBe(false);
});

test("no merge request, another branch, or a failure: none, quietly", async () => {
  let answer: () => Promise<typeof fixRequest | null> = async () => null;
  const { service, clock, calls } = findSetup(() => answer());
  const session = openSession(service);
  const find = () => service.findGitlab({ sessionId: session.id });
  expect((await find()).mergeRequest).toBeNull();
  answer = async () => {
    throw new Error("glab: network down");
  };
  clock.head = "b2";
  expect((await find()).mergeRequest).toBeNull();
  // A failure is retried sooner than an answer.
  clock.at += 61_000;
  answer = async () => fixRequest;
  expect((await find()).mergeRequest?.number).toBe(10046);
  expect(calls).toHaveLength(3);

  // A range up to another branch is not the checkout's.
  const other = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "feature" },
    raise: false,
  }).session;
  expect(
    (await service.findGitlab({ sessionId: other.id })).mergeRequest,
  ).toBeNull();

  // Without GitLab there is nothing to find.
  const { service: plain } = setup();
  const alone = openSession(plain);
  expect(
    (await plain.findGitlab({ sessionId: alone.id })).mergeRequest,
  ).toBeNull();
});

test("a merge request review is offered locally only on its own branch", async () => {
  const request = fixRequest;
  const { service } = findSetup(async () => request);
  const mr = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "mr", url: `${fixRequest.url}/diffs` },
    raise: false,
  }).session;
  expect(
    (await service.findGitlab({ sessionId: mr.id })).mergeRequest?.number,
  ).toBe(10046);
  const other = service.open({
    connectionId: "local",
    root: "/repo",
    target: {
      kind: "mr",
      url: "https://gitlab.example/gst/gstreamer/-/merge_requests/7",
    },
    raise: false,
  }).session;
  expect(
    (await service.findGitlab({ sessionId: other.id })).mergeRequest,
  ).toBeNull();
});

test("the checkout's branch is the one of a range up to HEAD or that branch", () => {
  const range = (head: string) => ({
    kind: "range" as const,
    base: "main",
    head,
  });
  expect(reviewsBranch(range("HEAD"), "fix")).toBe(true);
  expect(reviewsBranch(range("fix"), "fix")).toBe(true);
  expect(reviewsBranch(range("refs/heads/fix"), "fix")).toBe(true);
  expect(reviewsBranch(range("other"), "fix")).toBe(false);
  expect(reviewsBranch({ kind: "worktree" }, "fix")).toBe(true);
});

test("another branch at the same commit is looked up again", async () => {
  const { service, clock, calls } = findSetup(async () => ({
    ...fixRequest,
    branch: clock.branch ?? "",
  }));
  const session = openSession(service);
  await service.findGitlab({ sessionId: session.id });
  await service.findGitlab({ sessionId: session.id });
  expect(calls).toHaveLength(1);
  clock.branch = "fix-v2";
  await service.findGitlab({ sessionId: session.id });
  expect(calls).toHaveLength(2);
});

test("GitLab is the merge request's review: the local review stays local", async () => {
  const { service, calls } = findSetup(async () => fixRequest);
  const session = openSession(service);
  await service.findGitlab({ sessionId: session.id });
  // The flag no longer mixes the merge request into a local review.
  await expect(
    service.update({ sessionId: session.id, gitlab: true }),
  ).rejects.toThrow("open the merge request's review");
  const { mergeRequest, snapshot } = await service.openGitlab({
    sessionId: session.id,
  });
  expect(mergeRequest?.number).toBe(10046);
  expect(snapshot?.session).toMatchObject({
    target: { kind: "mr", url: fixRequest.url },
    gitlab: true,
    root: "/repo",
  });
  await expect(
    service.update({ sessionId: snapshot!.session.id, gitlab: false }),
  ).rejects.toThrow("open the local review instead");
  // An MR review opened by an agent with another spelling of its URL is
  // the same one.
  const agent = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "mr", url: `${fixRequest.url}/diffs` },
    raise: false,
  }).session;
  expect(agent.id).toBe(snapshot!.session.id);
  expect(service.get({ sessionId: session.id }).session.gitlab).toBe(false);
  expect(
    (await service.findGitlab({ sessionId: session.id })).mergeRequest?.number,
  ).toBe(10046);
  expect(calls).toHaveLength(1);
});

test("only an open merge request is found, for the chip and GitLab", async () => {
  let state = "merged";
  const { service, clock } = findSetup(async () => ({ ...fixRequest, state }));
  const session = openSession(service);
  expect(
    (await service.findGitlab({ sessionId: session.id })).mergeRequest,
  ).toBeNull();
  // Its draft notes would land on a merged merge request: nothing opens.
  expect(await service.openGitlab({ sessionId: session.id })).toEqual({
    mergeRequest: null,
  });
  expect(service.list()).toHaveLength(1);
  state = "opened";
  clock.at += 6 * 60_000;
  expect(
    (await service.openGitlab({ sessionId: session.id })).mergeRequest?.number,
  ).toBe(10046);
  expect(service.list()).toHaveLength(2);
});

test("a failed lookup: no chip, GitLab says why and waits to retry", async () => {
  let fail = true;
  const { service, clock, calls } = findSetup(async () => {
    if (fail) throw new Error("GitLab: 502 Bad Gateway");
    return fixRequest;
  });
  const session = openSession(service);
  expect(
    (await service.findGitlab({ sessionId: session.id })).mergeRequest,
  ).toBeNull();
  await expect(service.openGitlab({ sessionId: session.id })).rejects.toThrow(
    "GitLab: 502 Bad Gateway",
  );
  clock.at += 30_000;
  await expect(service.openGitlab({ sessionId: session.id })).rejects.toThrow(
    "GitLab: 502 Bad Gateway",
  );
  expect(calls).toHaveLength(1);
  fail = false;
  clock.at += 31_000;
  expect(
    (await service.findGitlab({ sessionId: session.id })).mergeRequest?.number,
  ).toBe(10046);
  expect(calls).toHaveLength(2);
});

test("an unreadable checkout is not asked again before the retry delay", async () => {
  const { service, clock, calls } = findSetup(async () => fixRequest);
  const session = openSession(service);
  clock.unreadable = true;
  expect(
    (await service.findGitlab({ sessionId: session.id })).mergeRequest,
  ).toBeNull();
  clock.at += 30_000;
  await expect(service.openGitlab({ sessionId: session.id })).rejects.toThrow(
    "ssh: host unreachable",
  );
  expect(clock.checkouts).toBe(1);
  clock.unreadable = false;
  clock.at += 31_000;
  expect(
    (await service.findGitlab({ sessionId: session.id })).mergeRequest?.number,
  ).toBe(10046);
  expect(clock.checkouts).toBe(2);
  expect(calls).toHaveLength(1);
});

/** GitLab's side of a merge request with one discussion and no drafts. */
function mergeRequestApi(posted: string[][]) {
  let nextDraft = 21;
  return (argv: string[]) => {
    const method = argv[argv.indexOf("--method") + 1];
    const path = argv.find((arg) => arg.startsWith("projects/"))!;
    if (method !== "GET") posted.push(argv);
    if (path.endsWith("/discussions?per_page=100"))
      return [
        {
          id: "d1",
          notes: [{ id: 1, body: "Hm", author: { username: "x" } }],
        },
      ];
    if (path.endsWith("/draft_notes?per_page=100")) return [];
    if (path.endsWith("/draft_notes"))
      return {
        id: nextDraft++,
        note: argv.find((arg) => arg.startsWith("note="))?.slice(5) ?? "",
      };
    return {
      web_url: fixRequest.url,
      diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
    };
  };
}

test("the local review's review comments wait in the merge request's review", async () => {
  const posted: string[][] = [];
  const pushes: ReviewPush[] = [];
  const { service, clock } = findSetup(async () => fixRequest, {
    glab: mergeRequestApi(posted),
    pushes,
  });
  const local = openSession(service);
  const discussion = await service.addThread({
    sessionId: local.id,
    anchor: { path: "a.c", line: 1, side: "new" },
    text: "Why this?",
  });
  const draft = await service.addThread({
    sessionId: local.id,
    kind: "draft",
    anchor: { path: "a.c", line: 2, side: "new" },
    text: "Leak",
  });
  const onMessage = await service.addThread({
    sessionId: local.id,
    kind: "draft",
    anchor: {
      path: ":commit-message",
      line: 1,
      side: "new",
      commit: "abcdef0123456789",
      commitSubject: "Fix it",
      text: "Fix it",
    },
    text: "Say why",
  });
  // A local review of another branch is not the merge request's.
  const other = service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "feature" },
    raise: false,
  }).session;
  await service.addThread({
    sessionId: other.id,
    kind: "draft",
    anchor: { path: "b.c", line: 1, side: "new" },
    text: "Elsewhere",
  });
  const mr = (await service.openGitlab({ sessionId: local.id })).snapshot!;
  // Pending before the merge request is even read.
  expect(mr.threads.map((t) => t.id)).toEqual([draft.id, onMessage.id]);
  const shown = await service.refreshGitlab({ sessionId: mr.session.id });
  expect(shown.threads.map((t) => t.id)).toEqual([
    draft.id,
    onMessage.id,
    "gl:d1",
  ]);
  expect(shown.threads.some((t) => t.id === discussion.id)).toBe(false);
  // The local review shows neither the merge request nor its discussions.
  expect(service.get({ sessionId: local.id }).threads.map((t) => t.id)).toEqual(
    [discussion.id, draft.id, onMessage.id],
  );

  // Rewording one from the merge request's review changes the local
  // review's comment, and both reviews hear of it.
  pushes.length = 0;
  await service.edit({
    sessionId: mr.session.id,
    commentId: draft.comments[0]!.id,
    text: "Leak here",
  });
  expect(
    service.get({ sessionId: local.id }).threads.find((t) => t.id === draft.id)
      ?.comments[0]?.body,
  ).toBe("Leak here");
  const heard = pushes.flatMap((push) =>
    push.type === "session" ? [push.snapshot.session.id] : [],
  );
  expect(heard).toContain(local.id);
  expect(heard).toContain(mr.session.id);

  // GitLab draft (N) sends them: a draft note, and a general note for the
  // commit message; the local review keeps its discussion only.
  clock.at += 1000;
  await service.pushLocalDrafts({ sessionId: mr.session.id });
  expect(posted).toHaveLength(2);
  expect(posted[0]).toContain("note=Leak here");
  expect(posted[1]?.join(" ")).toContain("On the commit message of abcdef0123");
  expect(service.get({ sessionId: local.id }).threads.map((t) => t.id)).toEqual(
    [discussion.id],
  );
  expect(
    service.get({ sessionId: other.id }).threads.map((t) => t.anchor.path),
  ).toEqual(["b.c"]);
  const after = service.get({ sessionId: mr.session.id }).threads;
  expect(after.filter((t) => t.gitlab?.draftId !== undefined)).toHaveLength(2);
  expect(after.some((t) => !t.gitlab)).toBe(false);
});

test("a local review left in the old GitLab mode is local again, threads kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-"));
  directories.push(dir);
  const storage = openReviewStorage(dir);
  const at = "2026-10-29T10:00:00.000Z";
  storage.saveSession({
    id: "s1",
    connectionId: "local",
    root: "/repo",
    title: "Old",
    target: { kind: "range", base: "main", head: "HEAD" },
    gitlab: true,
    summary: "Overall, fine",
    summaryUnsent: true,
    autoSend: false,
    agent: {},
    createdAt: at,
    updatedAt: at,
  });
  storage.saveThread({
    id: "t1",
    sessionId: "s1",
    kind: "draft",
    anchor: { path: "a.c", line: 2, side: "new" },
    comments: [
      {
        id: "c1",
        author: "Claude",
        body: "Agreed",
        createdAt: at,
        updatedAt: at,
      },
    ],
    resolved: false,
    createdAt: at,
    updatedAt: at,
    gitlabReplyTo: "d1",
  });
  storage.close();
  const posted: string[][] = [];
  const { service } = findSetup(async () => fixRequest, {
    dir,
    glab: mergeRequestApi(posted),
  });
  const old = service.get({ sessionId: "s1" });
  expect(old.session.gitlab).toBe(false);
  // The user's comments reach the agent again, as in any local review.
  expect(old.session.autoSend).toBeUndefined();
  expect(old.threads.map((t) => t.id)).toEqual(["t1"]);
  // Its agent's reply to a discussion waits in the merge request's review
  // and goes there as a draft reply; its agent's overall comment, waiting
  // for GitLab, is the merge request review's.
  const mr = (await service.openGitlab({ sessionId: "s1" })).snapshot!;
  const shown = await service.refreshGitlab({ sessionId: mr.session.id });
  expect(shown.session.summary).toBe("Overall, fine");
  expect(shown.session.summaryUnsent).toBe(true);
  expect(service.get({ sessionId: "s1" }).session.summaryUnsent).toBe(
    undefined,
  );
  await service.pushLocalDrafts({ sessionId: mr.session.id });
  expect(posted).toHaveLength(2);
  expect(posted[0]).toContain("in_reply_to_discussion_id=d1");
  expect(posted[1]).toContain("note=Overall, fine");
  expect(service.get({ sessionId: "s1" }).threads).toEqual([]);
  expect(
    service.get({ sessionId: mr.session.id }).session.summaryUnsent,
  ).toBeUndefined();
});

/** Lets background work (a review comment learning its merge request) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a review comment waits for the merge request of the branch it was written on", async () => {
  const posted: string[][] = [];
  let answer: Found = fixRequest;
  const { service, clock } = findSetup(async () => answer, {
    glab: mergeRequestApi(posted),
  });
  const local = openSession(service);
  const onFix = await service.addThread({
    sessionId: local.id,
    kind: "draft",
    anchor: { path: "a.c", line: 1, side: "new" },
    text: "On fix",
  });
  await settle();
  const mr = (await service.openGitlab({ sessionId: local.id })).snapshot!;
  await service.refreshGitlab({ sessionId: mr.session.id });
  // A branch without a merge request yet: that comment follows the link.
  clock.branch = "wip";
  answer = null;
  const onWip = await service.addThread({
    sessionId: local.id,
    kind: "draft",
    anchor: { path: "w.c", line: 1, side: "new" },
    text: "On wip",
  });
  await settle();
  // Another branch's merge request: that one's.
  clock.branch = "other";
  answer = {
    ...fixRequest,
    url: "https://gitlab.example/gst/gstreamer/-/merge_requests/10047",
    number: 10047,
    branch: "other",
  };
  const onOther = await service.addThread({
    sessionId: local.id,
    kind: "draft",
    anchor: { path: "b.c", line: 1, side: "new" },
    text: "On other",
  });
  await settle();
  const shown = service
    .get({ sessionId: mr.session.id })
    .threads.map((t) => t.id);
  expect(shown).toContain(onFix.id);
  expect(shown).not.toContain(onOther.id);
  // Sending asks again which local reviews are on the branch: only the
  // comment written on it goes.
  clock.at += 1000;
  await service.pushLocalDrafts({ sessionId: mr.session.id });
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("note=On fix");
  expect(
    service
      .get({ sessionId: local.id })
      .threads.map((t) => t.id)
      .sort(),
  ).toEqual([onWip.id, onOther.id].sort());
});

test("a pending review comment is reached by an id prefix from the merge request's review", async () => {
  const posted: string[][] = [];
  const { service } = findSetup(async () => fixRequest, {
    glab: mergeRequestApi(posted),
  });
  const local = openSession(service);
  const draft = await service.addThread({
    sessionId: local.id,
    kind: "draft",
    anchor: { path: "a.c", line: 1, side: "new" },
    text: "Leak",
    author: "Claude",
  });
  const mr = (await service.openGitlab({ sessionId: local.id })).snapshot!;
  await service.edit({
    sessionId: mr.session.id,
    commentId: draft.comments[0]!.id.slice(0, 8),
    text: "Leak here",
    author: "Claude",
  });
  expect(
    service.get({ sessionId: local.id }).threads[0]?.comments[0]?.body,
  ).toBe("Leak here");
  await service.resolve({
    sessionId: mr.session.id,
    commentId: draft.id.slice(0, 8),
  });
  expect(service.get({ sessionId: local.id }).threads[0]?.resolved).toBe(true);
});

test("a refresh that works again forgets the earlier failure", async () => {
  const posted: string[][] = [];
  const api = mergeRequestApi(posted);
  let down = true;
  const { service } = findSetup(async () => fixRequest, {
    glab: (argv) => {
      if (down) throw new Error("GitLab: 502");
      return api(argv);
    },
  });
  const local = openSession(service);
  const mr = (await service.openGitlab({ sessionId: local.id })).snapshot!;
  const failed = await service.refreshGitlab({ sessionId: mr.session.id });
  expect(failed.gitlabError).toContain("502");
  down = false;
  const back = await service.refreshGitlab({ sessionId: mr.session.id });
  expect(back.gitlabError).toBeUndefined();
  expect(back.mergeRequest?.url).toBe(fixRequest.url);
});

test("Local from a merge request's review is a local review of its branch", async () => {
  const { service } = findSetup(async () => fixRequest);
  const local = openSession(service);
  const mr = (await service.openGitlab({ sessionId: local.id })).snapshot!;
  // A later review of another branch in the same checkout is not it.
  service.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "feature" },
    raise: false,
  });
  const found = await service.findGitlab({
    sessionId: mr.session.id,
    local: true,
  });
  expect(found.mergeRequest?.number).toBe(10046);
  expect(found.localReviews).toEqual([local.id]);
});
