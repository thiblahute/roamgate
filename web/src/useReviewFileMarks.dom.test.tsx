import { inIsolatedChild } from "./testIsolated";
import { expect, test } from "bun:test";
import type { ReviewSnapshot, ReviewThread } from "../../shared/review";
import { mockReviewStore } from "./reviewState.testkit";

/**
 * The checkout's review as Files shows it: a changed file's tick read from
 * its combined diff, as Changes reads it; a file with no change in the review
 * by a comment or its tick ("Other files"); the tick toggled from Files
 * written to the worktree review, opened for a first mark.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "Files' review marks in an isolated DOM runtime",
    "ROAMGATE_REVIEW_FILE_MARKS_TEST",
    30_000,
  )
) {
  const { mock } = await import("bun:test");
  const { useSyncExternalStore } = await import("react");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let sessions = new Map<string, ReviewSnapshot>();
  const listeners = new Set<() => void>();
  const remember = (snapshot: ReviewSnapshot) => {
    sessions = new Map(sessions).set(snapshot.session.id, snapshot);
    for (const listener of listeners) listener();
  };
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "",
  ].join("\n");
  let marks: Record<string, string> = {};
  let opened = false;
  const worktree = (threads: ReviewThread[] = []): ReviewSnapshot =>
    ({
      session: {
        id: "s1",
        connectionId: "c",
        workspaceId: "w1",
        root: "/repo",
        target: { kind: "worktree" },
        agent: {},
        reviewed: marks,
        updatedAt: "2026-11-15",
      },
      threads,
    }) as unknown as ReviewSnapshot;
  mock.module("./review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      calls.push({ method, params });
      if (method === "review.open") {
        opened = true;
        return worktree();
      }
      if (method === "review.update") {
        const next = { ...marks };
        for (const [key, value] of Object.entries(
          params.reviewed as Record<string, string | null>,
        ))
          if (value === null) delete next[key];
          else next[key] = value;
        marks = next;
        return worktree(sessions.get("s1")?.threads ?? []);
      }
      throw new Error(`unexpected ${method}`);
    },
    rememberReviewSnapshot: remember,
    ...mockReviewStore(() => {
      const current = useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => sessions,
      );
      return { sessions: current, openRequest: null };
    }),
  }));
  const summary = {
    root: "/repo",
    entries: [
      {
        path: "a.ts",
        kind: "unstaged",
        status: "M",
        additions: 1,
        deletions: 1,
      },
    ],
  };
  mock.module("./gitDiffSummaryStore", () => ({
    useGitDiffSummaryState: (
      _client: unknown,
      workspaceId: string | undefined,
    ) => ({ summary: workspaceId ? summary : null, loading: false }),
  }));
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useReviewFileMarks } = await import("./useReviewFileMarks");
  const { reviewedFileOf } = await import("./reviewFiles");

  const client = {
    connectionId: "c",
    generation: 1,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "git.diff_file") return { diff: patch };
      throw new Error(`unexpected ${method}`);
    },
  };
  let result: ReturnType<typeof useReviewFileMarks> | null = null;
  const Probe = ({ threads }: { threads: ReviewThread[] }) => {
    result = useReviewFileMarks({
      client: client as never,
      workspaceId: "w1",
      resourceKey: "w1",
      threads,
      enabled: true,
    });
    return null;
  };
  const settle = async () => {
    for (let round = 0; round < 6; round++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
  };
  const onNotes: ReviewThread = {
    id: "t1",
    sessionId: "s1",
    kind: "discussion",
    anchor: { path: "notes.md", line: 2, side: "new", feedback: "{}" },
    comments: [],
    resolved: false,
    createdAt: "2026-11-15",
    updatedAt: "2026-11-15",
  } as unknown as ReviewThread;

  test("no review yet: nothing marked; a tick from Files opens the worktree review and writes the tick-only mark", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { threads: [] })));
    await settle();
    expect(result!.root).toBe("/repo");
    expect([...result!.marks]).toEqual([]);
    await act(async () => result!.toggle("notes.md"));
    expect(opened).toBe(true);
    expect(calls.find((each) => each.method === "review.open")?.params).toEqual(
      { workspace_id: "w1", path: "/repo", target: { kind: "worktree" } },
    );
    expect(marks).toEqual({ "all:notes.md": "unchanged" });
    await settle();
    expect(result!.marks.get("notes.md")).toEqual({
      reviewed: true,
      other: true,
    });
    await act(async () => root.unmount());
    host.remove();
  });

  test("a tick written in Changes shows in Files, though the review changes again while the file's diff is read", async () => {
    marks = {};
    remember(worktree());
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { threads: [] })));
    await settle();
    expect(result!.marks.has("a.ts")).toBe(false);
    // Changes' v: the whole-file mark, then another change at once.
    marks = { "all:a.ts": reviewedFileOf("a.ts", patch)!.fingerprint };
    await act(async () => {
      remember(worktree());
      remember(worktree());
    });
    await settle();
    expect(result!.marks.get("a.ts")).toEqual({
      reviewed: true,
      other: false,
    });
    await act(async () => root.unmount());
    host.remove();
  });

  test("a changed file's tick is read from its combined diff; a thread on an unchanged file puts it in the review; ticked and unticked from Files", async () => {
    marks = {};
    remember(worktree([onNotes]));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(Probe, { threads: [onNotes] })),
    );
    await settle();
    expect(result!.marks.get("notes.md")).toEqual({
      reviewed: false,
      other: true,
    });
    expect(result!.marks.has("a.ts")).toBe(false);
    expect(result!.changed("a.ts")).toBe(true);
    calls.length = 0;
    await act(async () => result!.toggle("a.ts"));
    expect(calls.map((each) => each.method)).toEqual([
      "git.diff_file",
      "review.update",
    ]);
    expect(calls[0]!.params).toEqual({
      workspace_id: "w1",
      mode: "working",
      path: "a.ts",
      kind: "combined",
    });
    expect(marks["all:a.ts"]).toBe(reviewedFileOf("a.ts", patch)!.fingerprint);
    await settle();
    expect(result!.marks.get("a.ts")).toEqual({
      reviewed: true,
      other: false,
    });
    await act(async () => result!.toggle("a.ts"));
    await settle();
    expect(result!.marks.has("a.ts")).toBe(false);
    await act(async () => root.unmount());
    host.remove();
  });
}
