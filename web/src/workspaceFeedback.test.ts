import { describe, expect, test } from "bun:test";
import type {
  ReviewSession,
  ReviewSnapshot,
  ReviewThread,
} from "../../shared/review";
import type { ReviewAnnotation } from "./annotations";
import {
  feedbackRoute,
  feedbackThreadId,
  paneChat,
  workspaceFeedback,
  writeFeedback,
} from "./workspaceFeedback";

/*
 * Where a comment written in the inspector goes (`feedbackRoute`): which
 * review it opens and where in it the thread is anchored. Characterization
 * tests of today's routing (plan: review into the inspector, phase A); the
 * Last step route changes on purpose in phase 6.
 */

const place = { workspaceId: "w1", root: "/repo" };

function session(target: ReviewSession["target"]): ReviewSession {
  return {
    id: "s1",
    connectionId: "local",
    workspaceId: "w1",
    root: "/repo",
    title: "Review",
    target,
    gitlab: false,
    summary: "",
    agent: {},
    reviewed: {},
    createdAt: "2026-11-10",
    updatedAt: "2026-11-10",
  } as unknown as ReviewSession;
}

const diffNote = (
  kind: "unstaged" | "staged" | "untracked" | "branch" | "last-step",
  extra: Partial<Extract<ReviewAnnotation, { source: "diff" }>> = {},
): Extract<ReviewAnnotation, { source: "diff" }> => ({
  id: `note-${kind}`,
  source: "diff",
  path: "src/one.ts",
  kind,
  side: "new",
  line: 4,
  quote: "const a = 1;\nconst b = 2;",
  hunk: "@@ -1,3 +1,5 @@",
  comment: "Why?",
  createdAt: 1,
  ...extra,
});

describe("feedbackRoute", () => {
  test("a diff comment in Working opens the worktree review; in Branch, the branch review", () => {
    for (const kind of ["unstaged", "staged", "untracked"] as const) {
      const route = feedbackRoute(diffNote(kind), place);
      expect(route.held).toBe(false);
      expect(route.open).toEqual({
        path: "/repo",
        target: { kind: "worktree" },
      });
    }
    // Branch: no target, the branch against its default base.
    const branch = feedbackRoute(diffNote("branch"), place);
    expect(branch.held).toBe(false);
    expect(branch.open).toEqual({ path: "/repo" });
    // Anchored on the line, its first line of text kept to find it again.
    expect(branch.anchor(session({ kind: "branch" } as never))).toEqual({
      path: "src/one.ts",
      line: 4,
      side: "new",
      text: "const a = 1;",
    });
  });

  test("a Last step comment opens the worktree review (today)", () => {
    const route = feedbackRoute(diffNote("last-step"), place);
    expect(route.held).toBe(false);
    expect(route.open).toEqual({
      path: "/repo",
      target: { kind: "worktree" },
    });
  });

  test("a range on one side keeps its end; across sides, or ending before it starts, only its first line", () => {
    const anchor = (
      extra: Partial<Extract<ReviewAnnotation, { source: "diff" }>>,
    ) =>
      feedbackRoute(diffNote("unstaged", extra), place).anchor(
        session({ kind: "worktree" } as never),
      );
    expect(anchor({ endLine: 7 })).toMatchObject({
      line: 4,
      endLine: 7,
      side: "new",
    });
    expect(anchor({ endLine: 7, endSide: "new" })).toMatchObject({
      endLine: 7,
    });
    // Across sides: the end is dropped, the start side kept.
    const across = anchor({ side: "old", endLine: 7, endSide: "new" });
    expect(across).toMatchObject({ line: 4, side: "old" });
    expect(across).not.toHaveProperty("endLine");
    // An end that is not after the start is no range.
    expect(anchor({ endLine: 4 })).not.toHaveProperty("endLine");
    expect(anchor({ endLine: 2 })).not.toHaveProperty("endLine");
  });

  test("a site URL comment opens the rendered review of that URL, anchored on what it shows", () => {
    const note: ReviewAnnotation = {
      id: "site",
      source: "file",
      anchor: "quote",
      path: "https://example.org/docs/page",
      section: ["Intro"],
      quote: "the words",
      comment: "Typo",
      createdAt: 1,
    };
    const route = feedbackRoute(note, place);
    expect(route.held).toBe(false);
    expect(route.open).toEqual({
      target: { kind: "rendered", url: "https://example.org/docs/page" },
      title: "https://example.org/docs/page",
    });
    expect(route.anchor(session({ kind: "rendered" } as never))).toEqual({
      render: { quote: "the words" },
    });
    // HTTP and any case count as a site; a relative path is a file.
    expect(
      feedbackRoute({ ...note, path: "HTTP://host/x" }, place).open,
    ).toMatchObject({ target: { kind: "rendered", url: "HTTP://host/x" } });
  });

  test("a file comment opens the rendered review of the file; a terminal comment is held in its chat review", () => {
    const file: ReviewAnnotation = {
      id: "file",
      source: "file",
      anchor: "line",
      path: "docs/guide.md",
      line: 3,
      endLine: 5,
      quote: "# Title\nmore",
      comment: "Clearer?",
      createdAt: 1,
    };
    const route = feedbackRoute(file, place);
    expect(route.open).toEqual({
      file: "/repo/docs/guide.md",
      target: { kind: "rendered" },
      title: "guide.md",
    });
    expect(
      route.anchor(
        session({ kind: "rendered", path: "docs/guide.md" } as never),
      ),
    ).toEqual({
      path: "docs/guide.md",
      line: 3,
      endLine: 5,
      side: "new",
      text: "# Title",
    });
    const terminal = feedbackRoute(
      {
        source: "terminal",
        anchor: "quote",
        paneId: "p1",
        title: "shell",
        quote: "$ ls",
        comment: "?",
      },
      place,
    );
    expect(terminal.held).toBe(true);
    expect(terminal.open).toEqual({
      path: "/repo",
      target: { kind: "chat", chat: "p1" },
      title: "Terminal: shell",
    });
  });
});

describe("terminal comments", () => {
  const note: ReviewAnnotation = {
    id: "t1",
    source: "terminal",
    anchor: "quote",
    paneId: "p2",
    title: "claude",
    quote: "error: nope",
    comment: "Fix this",
    createdAt: 1,
  };
  const chat = {
    chat: "session-7",
    path: "/repo/sub",
    agent: "claude",
    paneId: "p2",
  };

  test("a terminal comment goes to the chat review of the agent in its pane, held, opened as its chat threads open it", () => {
    const route = feedbackRoute(note, { ...place, chat });
    expect(route.held).toBe(true);
    expect(route.open).toEqual({
      path: "/repo/sub",
      target: { kind: "chat", chat: "session-7" },
      title: "Chat with claude",
      agent: "claude",
      agent_pane: "p2",
    });
    expect(route.anchor(session({ kind: "chat", chat: "session-7" }))).toEqual({
      terminal: { pane: "p2", title: "claude", quote: "error: nope" },
    });
    // Another pane's chat is not this comment's.
    expect(
      feedbackRoute(note, { ...place, chat: { ...chat, paneId: "p9" } }).open,
    ).toEqual({
      path: "/repo",
      target: { kind: "chat", chat: "p2" },
      title: "Terminal: claude",
    });
  });

  test("a terminal comment is held in its agent's chat review, never given the workspace's agent", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return (
        method === "review.open"
          ? {
              session: {
                ...session({ kind: "chat", chat: "session-7" }),
                agent: { name: "claude", paneId: "p2" },
              },
              threads: [],
            }
          : {}
      ) as T;
    };
    const written = await writeFeedback(
      call,
      note,
      { ...place, agent: { paneId: "p1", name: "Codex" }, chat },
      42,
    );
    expect(written.held).toBe(true);
    expect(calls[0]!.params).toEqual({
      workspace_id: "w1",
      path: "/repo/sub",
      target: { kind: "chat", chat: "session-7" },
      title: "Chat with claude",
      agent: "claude",
      agent_pane: "p2",
    });
    expect(calls[1]!.params).toMatchObject({
      kind: "discussion",
      held: 42,
      new_thread_id: feedbackThreadId("t1"),
      text: "Fix this",
    });
  });

  test("hold keeps any comment for Send, given the workspace's agent", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return (
        method === "review.open"
          ? { session: session({ kind: "worktree" } as never), threads: [] }
          : {}
      ) as T;
    };
    const written = await writeFeedback(
      call,
      diffNote("unstaged"),
      { ...place, agent: { paneId: "p1", name: "claude" } },
      7,
      undefined,
      true,
    );
    expect(written.held).toBe(true);
    expect(calls[0]!.params).toMatchObject({ agent_pane: "p1" });
    expect(calls[1]!.params).toMatchObject({ kind: "discussion", held: 7 });
  });

  test("paneChat: the pane's agent session names the chat, in the directory of its review when it has one; no agent or no session, none", async () => {
    const reads: unknown[][] = [];
    const read =
      (summary: unknown) => async (paneId: string, agent: string) => {
        reads.push([paneId, agent]);
        return summary;
      };
    const pane = {
      pane_id: "p2",
      agent: "claude",
      cwd: "/repo",
      foreground_cwd: "/repo/sub",
    };
    const ok = {
      status: "ok",
      path: "/t/x.jsonl",
      session: { value: "session-7" },
    };
    expect(await paneChat(read(ok), pane, [], "local")).toEqual({
      chat: "session-7",
      path: "/repo/sub",
      agent: "claude",
      paneId: "p2",
    });
    expect(reads).toEqual([["p2", "claude"]]);
    // No session id: its transcript names it, as the chat's threads do.
    expect(
      (
        await paneChat(
          read({ status: "ok", path: "/t/x.jsonl" }),
          pane,
          [],
          "local",
        )
      )?.chat,
    ).toBe("/t/x.jsonl");
    // The chat's review exists: its directory, so the comment joins it.
    const existing = {
      session: {
        ...session({ kind: "chat", chat: "session-7" }),
        root: "/elsewhere",
      },
      threads: [],
    } as unknown as ReviewSnapshot;
    expect((await paneChat(read(ok), pane, [existing], "local"))?.path).toBe(
      "/elsewhere",
    );
    expect((await paneChat(read(ok), pane, [existing], "remote"))?.path).toBe(
      "/repo/sub",
    );
    expect(
      await paneChat(
        read({ status: "missing_session", path: "" }),
        pane,
        [],
        "local",
      ),
    ).toBeUndefined();
    reads.length = 0;
    expect(
      await paneChat(read(ok), { ...pane, agent: null }, [], "local"),
    ).toBeUndefined();
    expect(reads).toEqual([]);
    // A read that fails is the caller's: it keeps the comment.
    await expect(
      paneChat(
        async () => {
          throw new Error("offline");
        },
        pane,
        [],
        "local",
      ),
    ).rejects.toThrow("offline");
  });
});

describe("writeFeedback", () => {
  test("a diff comment is written as a thread of its review, the note kept on its anchor, a stable id", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return (
        method === "review.open"
          ? { session: session({ kind: "worktree" } as never), threads: [] }
          : {}
      ) as T;
    };
    const note = diffNote("unstaged", { endLine: 5 });
    const written = await writeFeedback(
      call,
      note,
      { ...place, agent: { paneId: "p1", name: "claude" } },
      1,
    );
    expect(written.held).toBe(false);
    expect(written.threadId).toBe(feedbackThreadId(note.id));
    expect(feedbackThreadId(note.id)).toBe(feedbackThreadId(note.id));
    expect(calls.map((each) => each.method)).toEqual([
      "review.open",
      "review.thread.add",
    ]);
    expect(calls[0]!.params).toEqual({
      workspace_id: "w1",
      path: "/repo",
      target: { kind: "worktree" },
      agent_pane: "p1",
      agent: "claude",
    });
    const kept: Partial<typeof note> = { ...note };
    delete kept.comment;
    expect(calls[1]!.params).toEqual({
      session_id: "s1",
      // The review has no agent: a review comment, not a discussion.
      kind: "draft",
      anchor: {
        path: "src/one.ts",
        line: 4,
        endLine: 5,
        side: "new",
        text: "const a = 1;",
        feedback: JSON.stringify(kept),
      },
      new_thread_id: feedbackThreadId(note.id),
      text: "Why?",
    });
  });

  test("a refused write throws, so the caller can keep the comment", async () => {
    const call = async <T>(method: string): Promise<T> => {
      if (method === "review.open") throw new Error("offline");
      return {} as T;
    };
    await expect(
      writeFeedback(call, diffNote("unstaged"), place, 1),
    ).rejects.toThrow("offline");
  });
});

describe("workspaceFeedback", () => {
  const thread = (
    id: string,
    anchor: ReviewThread["anchor"],
    held?: number,
  ): ReviewThread =>
    ({
      id,
      sessionId: "s1",
      kind: "discussion",
      anchor,
      comments: [
        {
          id: `${id}c`,
          author: "you",
          body: "Why?",
          createdAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:00Z",
        },
      ],
      resolved: false,
      ...(held === undefined ? {} : { held }),
      createdAt: "2026-11-10T10:00:00Z",
      updatedAt: "2026-11-10T10:00:00Z",
    }) as ReviewThread;

  test("only threads written from a view (with anchor.feedback), not held, of the workspace are shown", () => {
    const kept: Partial<ReturnType<typeof diffNote>> = diffNote("unstaged");
    delete kept.comment;
    const feedback = JSON.stringify(kept);
    const snapshot = (
      workspaceId: string,
      threads: ReviewThread[],
    ): ReviewSnapshot =>
      ({
        session: { ...session({ kind: "worktree" } as never), workspaceId },
        threads,
      }) as ReviewSnapshot;
    const sessions = [
      snapshot("w1", [
        thread("from-changes", { path: "src/one.ts", line: 4, feedback }),
        // Written in the review pane: no note behind it.
        thread("from-review", { path: "src/one.ts", line: 4, side: "new" }),
        thread("held", { path: "src/one.ts", line: 4, feedback }, 5),
      ]),
      snapshot("w2", [
        thread("other-workspace", { path: "src/one.ts", line: 4, feedback }),
      ]),
    ];
    const shown = workspaceFeedback(sessions, "local", "w1");
    expect(shown.map((each) => each.thread.id)).toEqual(["from-changes"]);
    // The note is read back from the anchor, under the thread's id.
    expect(shown[0]!.annotation).toMatchObject({
      id: "from-changes",
      source: "diff",
      path: "src/one.ts",
      kind: "unstaged",
      line: 4,
      comment: "Why?",
    });
    expect(workspaceFeedback(sessions, "other", "w1")).toEqual([]);
    expect(workspaceFeedback(sessions, null, "w1")).toEqual([]);
    expect(workspaceFeedback(sessions, "local", undefined)).toEqual([]);
  });
});
