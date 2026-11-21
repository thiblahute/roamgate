import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewService } from "./service";
import { handleReviewRpc } from "./rpc";
import { openReviewStorage } from "./storage";
import type { ReviewSnapshot } from "../../../shared/review";
import {
  compileReviewFeedback,
  type ReviewAnnotation,
} from "../../../web/src/annotations";
import {
  feedbackRoute,
  feedbackThreadId,
  feedbackThreadsTrailer,
  heldFeedback,
  migrateFeedback,
  workspaceFeedback,
  writeFeedback,
} from "../../../web/src/workspaceFeedback";

/** Review feedback as review threads, against the real review service. */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function server() {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-feedback-"));
  const prompts: string[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
    deliveryDelayMs: 5,
    promptAgent: async (_connection, _pane, text) => {
      prompts.push(text);
    },
  });
  cleanups.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const refused = new Set<string>();
  const connection = {
    id: "local",
    resolveRoot: async () => "/repo",
    readRoot: async () => "/repo",
    readDefaultBase: async () => "main",
  };
  const call = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    if (method === "review.thread.add" && refused.has(String(params.text)))
      throw new Error("the server refuses this one");
    return (await handleReviewRpc(
      service,
      connection as never,
      method,
      params,
    )) as T;
  };
  const snapshots = () => service.list({ connectionId: "local", chats: true });
  return { service, call, refused, snapshots, prompts };
}

const place = { workspaceId: "w1", root: "/repo" };

function fileNote(id: string, comment: string): ReviewAnnotation {
  return {
    id,
    source: "file",
    anchor: "line",
    path: "docs/plan.md",
    line: 3,
    quote: "the line",
    comment,
    createdAt: 1,
  };
}

const diffNote: ReviewAnnotation = {
  id: "d1",
  source: "diff",
  path: "src/a.c",
  kind: "unstaged",
  side: "new",
  line: 7,
  hunk: "@@ -1 +1 @@",
  quote: "int x;",
  comment: "Why int?",
  createdAt: 2,
};

const terminalNote: ReviewAnnotation = {
  id: "t1",
  source: "terminal",
  anchor: "quote",
  paneId: "w1:p2",
  title: "build",
  quote: "error: nope",
  comment: "Fix this",
  createdAt: 3,
};

test("each note goes to the review of what it is on", () => {
  expect(feedbackRoute(diffNote, place).open).toEqual({
    path: "/repo",
    target: { kind: "worktree" },
  });
  expect(
    feedbackRoute({ ...diffNote, kind: "branch" } as ReviewAnnotation, place)
      .open,
  ).toEqual({ path: "/repo" });
  expect(feedbackRoute(fileNote("f", "x"), place).open).toMatchObject({
    file: "/repo/docs/plan.md",
    target: { kind: "rendered" },
  });
  expect(feedbackRoute(terminalNote, place).open).toMatchObject({
    target: { kind: "chat", chat: "w1:p2" },
  });
});

test("thread ids are 16 hexadecimal digits, the same for the same note", () => {
  expect(feedbackThreadId("a")).toMatch(/^[0-9a-f]{16}$/);
  expect(feedbackThreadId("a")).toBe(feedbackThreadId("a"));
  expect(feedbackThreadId("a")).not.toBe(feedbackThreadId("b"));
});

test("a note read back compiles word for word as it did", async () => {
  const { call, snapshots } = server();
  const notes = [fileNote("f1", "On the file"), diffNote, terminalNote];
  let held = 100;
  // Written a millisecond apart, as the user wrote them: in the same one,
  // threads of different reviews would read back in the reviews' order.
  let now = Date.parse("2026-01-01T00:00:00Z");
  try {
    for (const note of notes) {
      setSystemTime(new Date(now++));
      await writeFeedback(call, note, place, held++);
    }
  } finally {
    setSystemTime();
  }
  // The view's threads, and the terminal's held one.
  const read = [
    ...workspaceFeedback(snapshots(), "local", "w1").map(
      (entry) => entry.annotation,
    ),
    ...heldFeedback(snapshots(), "local", "w1").map(
      (entry) => entry.annotation,
    ),
  ].sort((a, b) => a.createdAt - b.createdAt);
  expect(compileReviewFeedback(read)).toBe(compileReviewFeedback(notes));
});

const agentPlace = {
  ...place,
  agent: { paneId: "w1:p1", name: "Claude" },
};

test("a comment is its review's thread, and goes to the workspace's agent as the review pane's do", async () => {
  const { call, snapshots, prompts } = server();
  const written = await writeFeedback(call, diffNote, agentPlace, 1);
  expect(written.held).toBe(false);
  // Held for nothing: a thread of the review, which has the agent.
  expect(heldFeedback(snapshots(), "local", "w1")).toEqual([]);
  const [entry] = workspaceFeedback(snapshots(), "local", "w1");
  expect(entry?.thread.kind).toBe("discussion");
  expect(entry?.annotation).toMatchObject({ source: "diff", kind: "unstaged" });
  expect(written.snapshot.session.agent.paneId).toBe("w1:p1");
  await Bun.sleep(30);
  expect(prompts.join("\n")).toContain("Why int?");
});

test("a review held until Send holds the comments written in the views too", async () => {
  const { service, call, prompts } = server();
  const opened = service.open({
    connectionId: "local",
    root: "/repo",
    workspaceId: "w1",
    target: { kind: "worktree" },
    agent: "Claude",
    paneId: "w1:p1",
  });
  await call("review.update", {
    session_id: opened.session.id,
    holdComments: true,
  });
  await writeFeedback(call, diffNote, agentPlace, 1);
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  // Let go, as the review pane's hold is: what waits goes.
  await call("review.update", {
    session_id: opened.session.id,
    holdComments: false,
  });
  await Bun.sleep(30);
  expect(prompts.join("\n")).toContain("Why int?");
});

test("a review that does not send to the agent takes a review comment", async () => {
  const { service, call, snapshots, prompts } = server();
  const opened = service.open({
    connectionId: "local",
    root: "/repo",
    workspaceId: "w1",
    target: { kind: "worktree" },
  });
  await call("review.update", {
    session_id: opened.session.id,
    autoSend: false,
  });
  await writeFeedback(call, diffNote, agentPlace, 1);
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  expect(workspaceFeedback(snapshots(), "local", "w1")[0]?.thread.kind).toBe(
    "draft",
  );
});

test("a terminal comment still waits in Review feedback", async () => {
  const { call, snapshots, prompts } = server();
  const written = await writeFeedback(call, terminalNote, agentPlace, 1);
  expect(written.held).toBe(true);
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  expect(
    heldFeedback(snapshots(), "local", "w1").map((entry) => entry.threadId),
  ).toEqual([written.threadId]);
  expect(workspaceFeedback(snapshots(), "local", "w1")).toEqual([]);
});

test("comments held before wait for Send with a terminal's, and the hand-off delivers nothing twice", async () => {
  const { call, snapshots, prompts } = server();
  // As the panel held them: a review without an agent, the thread held.
  const opened = await call<ReviewSnapshot>("review.open", {
    workspace_id: "w1",
    path: "/repo",
    target: { kind: "worktree" },
  });
  await call("review.thread.add", {
    session_id: opened.session.id,
    kind: "discussion",
    anchor: {
      path: "src/a.c",
      line: 7,
      side: "new",
      feedback: JSON.stringify({ ...diffNote, comment: undefined }),
    },
    text: "Why int?",
    held: 1,
  });
  await writeFeedback(call, terminalNote, place, 2);
  // Nothing lets them go by itself: both wait in the workspace's threads.
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  const held = heldFeedback(snapshots(), "local", "w1");
  expect(held.map((entry) => entry.annotation.source)).toEqual([
    "diff",
    "terminal",
  ]);
  expect(workspaceFeedback(snapshots(), "local", "w1")).toEqual([]);
  // Send: the prompt typed into the agent's pane told them; their reviews
  // only mark them handed.
  for (const entry of held)
    await call("review.thread.release", {
      session_id: entry.sessionId,
      comment_id: entry.threadId,
      handed: true,
    });
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  expect(heldFeedback(snapshots(), "local", "w1")).toEqual([]);
  expect(
    allThreads(snapshots())
      .map((thread) => !!thread.handedAt)
      .every(Boolean),
  ).toBe(true);
});

/** The agent in pane w1:p2, and its chat as the chat's threads open it. */
const chatPlace = {
  ...agentPlace,
  chat: { chat: "session-7", path: "/repo", agent: "claude", paneId: "w1:p2" },
};

test("a terminal comment on an agent's pane is held in that agent's chat review, the one its chat threads use", async () => {
  const { call, snapshots, prompts } = server();
  // The chat's threads opened its review first (ChatThreads).
  const chat = await call<ReviewSnapshot>("review.open", {
    workspace_id: "w1",
    path: "/repo",
    target: { kind: "chat", chat: "session-7" },
    title: "Chat with claude",
    agent: "claude",
    agent_pane: "w1:p2",
  });
  const written = await writeFeedback(call, terminalNote, chatPlace, 5);
  expect(written.held).toBe(true);
  expect(written.snapshot.session.id).toBe(chat.session.id);
  const [entry] = heldFeedback(snapshots(), "local", "w1");
  expect(entry?.sessionId).toBe(chat.session.id);
  expect(entry?.annotation).toMatchObject({
    source: "terminal",
    paneId: "w1:p2",
    quote: "error: nope",
  });
  const thread = allThreads(snapshots()).find(
    (each) => each.id === written.threadId,
  );
  expect(thread?.anchor.terminal).toEqual({
    pane: "w1:p2",
    title: "build",
    quote: "error: nope",
  });
  // Held: the agent hears nothing until Send.
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  // Written first, it opens the chat's review as the chat's threads would.
  const { call: call2, snapshots: snapshots2 } = server();
  const first = await writeFeedback(call2, terminalNote, chatPlace, 1);
  expect(first.snapshot.session.target).toEqual({
    kind: "chat",
    chat: "session-7",
  });
  expect(first.snapshot.session.agent.paneId).toBe("w1:p2");
  const reopened = await call2<ReviewSnapshot>("review.open", {
    workspace_id: "w1",
    path: "/repo",
    target: { kind: "chat", chat: "session-7" },
    title: "Chat with claude",
    agent: "claude",
    agent_pane: "w1:p2",
  });
  expect(reopened.session.id).toBe(first.snapshot.session.id);
  expect(snapshots2()).toHaveLength(1);
});

test("a file an agent opened hears comments at once", async () => {
  const { service, call, snapshots, prompts } = server();
  service.open({
    connectionId: "local",
    root: "/repo",
    workspaceId: "w1",
    target: { kind: "rendered", path: "docs/plan.md" },
    agent: "Claude",
    paneId: "w1:p1",
  });
  const written = await writeFeedback(call, fileNote("f", "Direct"), place, 1);
  expect(written.held).toBe(false);
  await Bun.sleep(30);
  expect(prompts.join("\n")).toContain("Direct");
  expect(heldFeedback(snapshots(), "local", "w1")).toEqual([]);
});

/** A note store as the page keeps it. */
function localNotes(notes: ReviewAnnotation[]) {
  let kept = notes;
  return {
    get: () => kept,
    forget: (id: string) => {
      kept = kept.filter((note) => note.id !== id);
    },
  };
}

const allThreads = (snapshots: ReviewSnapshot[]) =>
  snapshots.flatMap((snapshot) => snapshot.threads);

test("migration: a note the server refuses stays", async () => {
  const { call, refused, snapshots } = server();
  refused.add("refused text");
  const store = localNotes([
    fileNote("n1", "first"),
    fileNote("n2", "refused text"),
    fileNote("n3", "third"),
  ]);
  const result = await migrateFeedback({
    notes: store.get(),
    write: (note, held) => writeFeedback(call, note, place, held),
    forget: store.forget,
    base: 1000,
  });
  expect(result.moved).toEqual(["n1", "n3"]);
  expect(result.kept).toEqual([
    { id: "n2", reason: "the server refuses this one" },
  ]);
  expect(store.get().map((note) => note.id)).toEqual(["n2"]);
  expect(allThreads(snapshots()).map((t) => t.comments[0]!.body)).toEqual(
    expect.arrayContaining(["first", "third"]),
  );
  expect(allThreads(snapshots())).toHaveLength(2);
});

test("migration: a note with no words stays the user's draft", async () => {
  const { call } = server();
  const store = localNotes([fileNote("n1", "   ")]);
  const result = await migrateFeedback({
    notes: store.get(),
    write: (note, held) => writeFeedback(call, note, place, held),
    forget: store.forget,
    base: 1,
  });
  expect(result.moved).toEqual([]);
  expect(store.get()).toHaveLength(1);
});

test("migration: a page closed mid-way loses nothing and writes nothing twice", async () => {
  const { call, snapshots } = server();
  const notes = [
    fileNote("n1", "first"),
    fileNote("n2", "second"),
    fileNote("n3", "third"),
  ];
  const store = localNotes(notes);
  // The page goes after the server wrote n2 and before it was forgotten.
  const closed = new Error("page closed");
  const halted = migrateFeedback({
    notes: store.get(),
    write: async (note, held) => {
      if (note.id === "n3") throw closed;
      await writeFeedback(call, note, place, held);
    },
    forget: (id) => {
      if (id === "n2") throw closed;
      store.forget(id);
    },
    base: 1,
  });
  await halted.catch((error) => expect(error).toBe(closed));
  expect(store.get().map((note) => note.id)).toEqual(["n2", "n3"]);

  // The next load finds what is left.
  const again = await migrateFeedback({
    notes: store.get(),
    write: (note, held) => writeFeedback(call, note, place, held),
    forget: store.forget,
    base: 1,
  });
  expect(again.moved).toEqual(["n2", "n3"]);
  expect(store.get()).toEqual([]);
  const bodies = allThreads(snapshots())
    .map((t) => t.comments[0]!.body)
    .sort();
  expect(bodies).toEqual(["first", "second", "third"]);
});

test("migration: each note becomes a held thread of its review, a terminal's in its agent's chat review", async () => {
  const { call, snapshots, prompts } = server();
  const store = localNotes([fileNote("n1", "first"), diffNote, terminalNote]);
  const result = await migrateFeedback({
    notes: store.get(),
    write: (note, held) =>
      writeFeedback(call, note, chatPlace, held, undefined, true),
    forget: store.forget,
    base: 10,
  });
  expect(result.moved).toEqual(["n1", "d1", "t1"]);
  expect(store.get()).toEqual([]);
  const held = heldFeedback(snapshots(), "local", "w1");
  // In their order, each in the review of what it is on.
  expect(held.map((entry) => entry.threadId)).toEqual(
    ["n1", "d1", "t1"].map(feedbackThreadId),
  );
  const targets = new Map(
    snapshots().map((snapshot) => [
      snapshot.session.id,
      snapshot.session.target.kind,
    ]),
  );
  expect(held.map((entry) => targets.get(entry.sessionId))).toEqual([
    "rendered",
    "worktree",
    "chat",
  ]);
  // Waiting for the user's Send: no agent hears them yet.
  await Bun.sleep(30);
  expect(prompts).toHaveLength(0);
  expect(workspaceFeedback(snapshots(), "local", "w1")).toEqual([]);
});

test("the hand-off names the threads and the region's picture", () => {
  const trailer = feedbackThreadsTrailer([
    { index: 1, threadId: "aaaaaaaa11112222" },
    { index: 2, threadId: "bbbbbbbb33334444", snapshot: "/r/images/x/y.png" },
  ]);
  expect(trailer).toContain("(1: [aaaaaaaa], 2: [bbbbbbbb])");
  expect(trailer).toContain("2: what I saw there: /r/images/x/y.png");
  expect(feedbackThreadsTrailer([])).toBe("");
});
