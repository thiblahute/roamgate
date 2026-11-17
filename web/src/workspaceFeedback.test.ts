import { describe, expect, test } from "bun:test";
import type {
  ReviewSession,
  ReviewSnapshot,
  ReviewThread,
} from "../../shared/review";
import { parseReviewAnnotation, type ReviewAnnotation } from "./annotations";
import {
  addFeedbackImage,
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

  test("a Branch comment under a base picked in Compare against opens that base's review, kept with the note", () => {
    const route = feedbackRoute(diffNote("branch", { base: "develop" }), place);
    expect(route.open).toEqual({
      path: "/repo",
      target: { kind: "range", base: "develop", head: "HEAD" },
    });
    // The base survives the note's record (anchor.feedback) and is only a
    // branch name: nothing else is kept.
    expect(
      parseReviewAnnotation({ ...diffNote("branch"), base: "origin/develop" }),
    ).toMatchObject({ base: "origin/develop" });
    for (const base of ["--help", "a..b", "HEAD~1", "x y", ""])
      expect(
        parseReviewAnnotation({ ...diffNote("branch"), base }),
      ).not.toHaveProperty("base");
    expect(
      parseReviewAnnotation({ ...diffNote("unstaged"), base: "develop" }),
    ).not.toHaveProperty("base");
  });

  test("a Last step comment opens the worktree review (today)", () => {
    const route = feedbackRoute(diffNote("last-step"), place);
    expect(route.held).toBe(false);
    expect(route.open).toEqual({
      path: "/repo",
      target: { kind: "worktree" },
    });
  });

  test("a Last step comment opens that step's review (plan D15); with no step known, the worktree review", () => {
    const step = {
      kind: "step" as const,
      step: "1763200000000-abcdef01",
      before: "a".repeat(40),
      after: "b".repeat(40),
      at: "2026-11-15T10:02:00.000Z",
    };
    const route = feedbackRoute(diffNote("last-step", { target: step }), place);
    expect(route.held).toBe(false);
    expect(route.open).toEqual({ path: "/repo", target: step });
    expect(route.anchor(session(step as never))).toMatchObject({
      path: "src/one.ts",
      line: 4,
      side: "new",
    });
    // The note keeps its step through the review's store and back.
    expect(
      parseReviewAnnotation({ ...diffNote("last-step"), target: step }),
    ).toMatchObject({ target: step });
    expect(feedbackRoute(diffNote("last-step"), place).open).toEqual({
      path: "/repo",
      target: { kind: "worktree" },
    });
  });

  test("a comment on a range shown as a review scope goes to that range; one on a commit's diff names the commit", () => {
    const range = { kind: "range" as const, base: "abc1234", head: "topic" };
    const commit = {
      sha: "c".repeat(40),
      subject: "Fix the lexer",
      parent: "d".repeat(40),
    };
    const route = feedbackRoute(
      diffNote("branch", { target: range, commit }),
      place,
    );
    expect(route.open).toEqual({ path: "/repo", target: range });
    expect(route.anchor(session(range as never))).toMatchObject({
      path: "src/one.ts",
      line: 4,
      commit: commit.sha,
      commitSubject: "Fix the lexer",
      commitParent: commit.parent,
    });
    expect(
      parseReviewAnnotation({ ...diffNote("branch"), target: range, commit }),
    ).toMatchObject({ target: range, commit });
    // What is not a range or a step, or a commit that is no sha, is dropped.
    for (const bad of [
      { kind: "worktree" },
      { kind: "range", base: "--output=x", head: "HEAD" },
      { kind: "step", step: "x", before: "HEAD", after: "b".repeat(40) },
    ])
      expect(
        parseReviewAnnotation({ ...diffNote("branch"), target: bad }),
      ).not.toHaveProperty("target");
    expect(
      parseReviewAnnotation({
        ...diffNote("branch"),
        commit: { sha: "not a sha" },
      }),
    ).not.toHaveProperty("commit");
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

describe("one review across Files and Changes (D16)", () => {
  const rendered: ReviewAnnotation = {
    id: "rendered",
    source: "file",
    anchor: "quote",
    path: "docs/guide.md",
    section: ["Title"],
    line: 3,
    endLine: 4,
    quote: "the words",
    render: { quote: "the words" },
    comment: "Clearer?",
    createdAt: 1,
  };
  test("reviews in Changes: a file comment opens the checkout's worktree review, its rendered anchor kept", () => {
    const route = feedbackRoute(rendered, { ...place, oneReview: true });
    // The file's directory: the server finds the repository holding it.
    expect(route.open).toEqual({
      path: "/repo/docs",
      target: { kind: "worktree" },
    });
    expect(route.anchor(session({ kind: "worktree" } as never))).toEqual({
      path: "docs/guide.md",
      line: 3,
      endLine: 4,
      side: "new",
      text: "the words",
      render: { quote: "the words" },
    });
  });
  test("the path is the repository's, when the checkout is a directory of it", () => {
    const route = feedbackRoute(
      { ...rendered, path: "guide.md" },
      { ...place, root: "/repo/docs/", oneReview: true },
    );
    expect(route.open).toEqual({
      path: "/repo/docs",
      target: { kind: "worktree" },
    });
    expect(route.anchor(session({ kind: "worktree" } as never)).path).toBe(
      "docs/guide.md",
    );
  });
  test("a workspace whose directory is not a repository: the file's own repository's worktree review", async () => {
    // A workspace in the home directory, a page of a checkout under it.
    const home = { ...place, root: "/home/me", oneReview: true };
    const page = {
      ...rendered,
      path: "/home/me/blog/public/post/index.html",
    } as ReviewAnnotation;
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method !== "review.open") return {} as T;
      // As the server's readReviewRoot answers: the home directory is in
      // no repository, the page's directory is in the blog's.
      const path = String(params.path);
      if (path !== "/home/me/blog" && !path.startsWith("/home/me/blog/"))
        throw new Error(
          "fatal: not a git repository (or any of the parent directories): .git",
        );
      return {
        session: {
          ...session({ kind: "worktree" } as never),
          root: "/home/me/blog",
        },
        threads: [],
      } as T;
    };
    await writeFeedback(call, page, home, 1);
    expect(calls[0]!.params).toEqual({
      workspace_id: "w1",
      path: "/home/me/blog/public/post",
      target: { kind: "worktree" },
    });
    expect(calls[1]!.params.anchor).toMatchObject({
      path: "public/post/index.html",
    });
  });
  test("a file in no repository at all: its own rendered review, not a failed comment", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method !== "review.open") return {} as T;
      if (
        params.target &&
        (params.target as { kind: string }).kind !== "rendered"
      )
        throw new Error(
          "fatal: not a git repository (or any of the parent directories): .git",
        );
      return {
        session: {
          ...session({ kind: "rendered", path: "notes.md" } as never),
          root: "/home/me",
        },
        threads: [],
      } as T;
    };
    await writeFeedback(
      call,
      { ...rendered, path: "/home/me/notes.md" } as ReviewAnnotation,
      { ...place, root: "/home/me", oneReview: true },
      1,
    );
    expect(calls.map((each) => each.params.target)).toEqual([
      { kind: "worktree" },
      { kind: "rendered" },
    ]);
    expect(calls[1]!.params.file).toBe("/home/me/notes.md");
    expect(calls[2]!.method).toBe("review.thread.add");
    expect(calls[2]!.params.anchor).toMatchObject({ path: "notes.md" });
  });
  test("any other refusal is the caller's to keep the comment", async () => {
    const call = async <T>(): Promise<T> => {
      throw new Error("review store is read-only");
    };
    await expect(
      writeFeedback(call, rendered, { ...place, oneReview: true }, 1),
    ).rejects.toThrow("read-only");
  });
  test("a file outside the checkout, and a site, keep their rendered review", () => {
    expect(
      feedbackRoute(
        { ...rendered, path: "/elsewhere/notes.md" },
        { ...place, oneReview: true },
      ).open,
    ).toEqual({
      file: "/elsewhere/notes.md",
      target: { kind: "rendered" },
      title: "notes.md",
    });
    expect(
      feedbackRoute(
        { ...rendered, path: "https://example.com/page" },
        { ...place, oneReview: true },
      ).open,
    ).toEqual({
      target: { kind: "rendered", url: "https://example.com/page" },
      title: "https://example.com/page",
    });
  });
  test("writeFeedback writes it in the worktree review, as the review's settings say", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return (
        method === "review.open"
          ? {
              session: {
                ...session({ kind: "worktree" } as never),
                agent: { paneId: "p1", name: "claude" },
              },
              threads: [],
            }
          : {}
      ) as T;
    };
    await writeFeedback(
      call,
      { ...rendered, anchor: "line", line: 3 } as ReviewAnnotation,
      { ...place, oneReview: true },
      1,
      { lineText: "the source line" },
    );
    expect(calls[0]!.params).toEqual({
      workspace_id: "w1",
      path: "/repo/docs",
      target: { kind: "worktree" },
    });
    const added = calls[1]!.params;
    expect(added.session_id).toBe("s1");
    // Sent to the review's agent, as a comment written in Changes is.
    expect(added.kind).toBe("discussion");
    expect(added.anchor).toMatchObject({
      path: "docs/guide.md",
      line: 3,
      side: "new",
      text: "the source line",
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

describe("an image pasted in a comment in Changes", () => {
  test("is stored with the checkout's worktree review, opened for it, and linked as Markdown", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const call = async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return (
        method === "review.open"
          ? { session: { id: "s9" } }
          : { path: "/store/shot.png" }
      ) as T;
    };
    const file = new File([new Uint8Array([1, 2, 3])], "shot one.png", {
      type: "image/png",
    });
    const markdown = await addFeedbackImage(
      call,
      { ...place, agent: { paneId: "p1", name: "Claude" } },
      file,
    );
    expect(markdown).toBe("![shot one.png](</store/shot.png>)");
    expect(calls).toEqual([
      {
        method: "review.open",
        params: {
          workspace_id: "w1",
          path: "/repo",
          target: { kind: "worktree" },
          agent_pane: "p1",
          agent: "Claude",
        },
      },
      {
        method: "review.image.add",
        params: { session_id: "s9", type: "image/png", data: "AQID" },
      },
    ]);
  });

  test("a screenshot pasted without a name is called screenshot; one over 10 MiB is refused before anything is opened", async () => {
    const calls: string[] = [];
    const call = async <T>(method: string) => {
      calls.push(method);
      return (
        method === "review.open"
          ? { session: { id: "s9" } }
          : { path: "/p.png" }
      ) as T;
    };
    expect(
      await addFeedbackImage(
        call,
        place,
        new File([new Uint8Array([1])], "image.png", { type: "image/png" }),
      ),
    ).toBe("![screenshot](</p.png>)");
    calls.length = 0;
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    await expect(addFeedbackImage(call, place, big)).rejects.toThrow(
      "at most 10 MiB",
    );
    expect(calls).toEqual([]);
  });
});
