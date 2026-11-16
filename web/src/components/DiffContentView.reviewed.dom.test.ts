import { describe, expect, test } from "bun:test";
import type { ReviewSnapshot } from "../../../shared/review";

/**
 * Reviewed chunks and files in Changes (plan: review into the inspector,
 * phase 5), "in Changes" with Vim keys on: `r` marks the chunk (a thread on
 * the line is resolved first), V covers several, `v` and Option+V the file,
 * `gu` / `gU` jump to the chunks not reviewed, and every chunk carries its
 * staged marker and its reviewed mark in the margin.
 */
if (process.env.ROAMGATE_CHANGES_REVIEWED_DOM_TEST !== "1") {
  test("Changes' reviewed marks in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_REVIEWED_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 60_000);
} else {
  const { mock } = await import("bun:test");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let marks: Record<string, string> = {};
  let opened = true;
  const snapshot = () =>
    ({
      session: {
        id: "s1",
        connectionId: "c",
        workspaceId: "workspace",
        root: "/repo",
        updatedAt: "2026-11-10T10:00:00Z",
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: {},
        reviewed: marks,
      },
      threads: [],
    }) as unknown as ReviewSnapshot;
  // The bridge's state as the page holds it: a new one each update.
  let version = 0;
  const listeners = new Set<() => void>();
  const bump = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const { useSyncExternalStore } = await import("react");
  const held = new Map<number, Map<string, ReviewSnapshot>>();
  const sessionsNow = () => {
    let sessions = held.get(version);
    if (!sessions) {
      sessions = new Map(opened ? [["s1", snapshot()]] : []);
      held.clear();
      held.set(version, sessions);
    }
    return sessions;
  };
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      if (method === "review.update") {
        const changes = (params.reviewed ?? {}) as Record<
          string,
          string | null
        >;
        const next = { ...marks };
        for (const [key, value] of Object.entries(changes))
          if (value === null) delete next[key];
          else next[key] = value;
        marks = next;
      }
      opened = true;
      return snapshot();
    },
    rememberReviewSnapshot: () => bump(),
    useReviewState: () => {
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => version,
      );
      return { sessions: sessionsNow(), openRequest: null };
    },
  }));
  const { installChangesDom, mountChangesDiff, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const { act } = await import("react");
  const { store } = await import("../store");
  const { roamgateLocalStorage } = await import("../browserStorage");
  roamgateLocalStorage.setItem("diffViewMode", "unified");
  const notices: string[] = [];
  const realNotify = store.notify.bind(store);
  store.notify = ((notice: { message: string }) => {
    notices.push(notice.message);
    return realNotify(notice as Parameters<typeof store.notify>[0]);
  }) as typeof store.notify;

  const a = entry("a.ts", "unstaged", "M");
  const b = entry("b.ts", "unstaged", "M");
  const patch = (path: string, ...hunks: string[]) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      ...hunks,
    ]
      .join("\n")
      .concat("\n");
  const patches = {
    "unstaged:a.ts": patch(
      "a.ts",
      "@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three",
      "@@ -20,3 +20,3 @@\n x\n-y\n+z\n w",
    ),
    "unstaged:b.ts": patch("b.ts", "@@ -1,2 +1,2 @@\n p\n-q\n+r"),
  };

  const view = () => document.querySelector<HTMLElement>(".diff-content-view")!;
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    view().focus();
    await act(async () => {
      view().dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
  };
  const keys = async (text: string) => {
    for (const key of text) await press(key);
  };
  const cursorAt = () => {
    for (const section of document.querySelectorAll<HTMLElement>(
      "[data-diff-entry-key]",
    )) {
      const line = section
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector(
          "[data-content] [data-line][data-editor-active-line]",
        );
      if (line)
        return `${section.dataset.diffEntryKey}:${line.getAttribute("data-line-type")}:${line.getAttribute("data-line")}`;
    }
    return null;
  };
  const marked = (key: string) =>
    [
      ...(document
        .querySelector(`[data-diff-entry-key="${key}"]`)
        ?.querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll("[data-line][data-chunk-stage]") ?? []),
    ].map(
      (line) =>
        `${line.getAttribute("data-line")}:${line.getAttribute("data-chunk-stage")}${line.hasAttribute("data-chunk-reviewed") ? ":reviewed" : ""}`,
    );
  const reset = () => {
    calls.length = 0;
    marks = {};
    opened = true;
    notices.length = 0;
    bump();
  };
  const mount = (over: Record<string, unknown> = {}) =>
    mountChangesDiff({
      entries: [a, b],
      patches,
      reviewCursor: true,
      connectionId: "c",
      onCreateAnnotation: () => {},
      ...over,
    });

  describe("reviewed chunks in Changes", () => {
    test("r marks the chunk at the cursor and goes on to the next one not reviewed; r again unmarks it", async () => {
      reset();
      const diff = await mount();
      try {
        await keys("jj");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        await press("r");
        await diff.settle();
        expect(calls.filter((c) => c.method === "review.update")).toHaveLength(
          1,
        );
        const written = calls.find((c) => c.method === "review.update")!.params
          .reviewed as Record<string, string>;
        expect(Object.values(written)).toEqual(["1"]);
        expect(notices).toContain("Chunk reviewed (1/2 in the file)");
        // The cursor went on to the file's second chunk.
        expect(cursorAt()).toBe("unstaged:a.ts:context:20");
        await diff.settle();
        expect(marked("unstaged:a.ts")).toContain("2:unstaged:reviewed");
        expect(marked("unstaged:a.ts")).toContain("21:unstaged");
        // Back on the first chunk, r unmarks it.
        await keys("gU".split("").join(""));
        await diff.settle();
        expect(cursorAt()).toBe("unstaged:b.ts:context:1");
      } finally {
        await diff.unmount();
      }
    });

    test("a reviewed chunk folds to one line saying so; the cursor steps over it, za shows it and folds it back", async () => {
      reset();
      const diff = await mount();
      const shadowOf = () =>
        document
          .querySelector('[data-diff-entry-key="unstaged:a.ts"]')
          ?.querySelector("diffs-container")?.shadowRoot;
      const folded = () =>
        [
          ...(shadowOf()?.querySelectorAll(
            "[data-content] [data-line][data-chunk-folded]",
          ) ?? []),
        ].map(
          (line) =>
            `${line.getAttribute("data-line")}${line.hasAttribute("data-chunk-fold-head") ? `:${line.getAttribute("data-chunk-fold-label")}` : ""}`,
        );
      try {
        await keys("jj");
        await press("r");
        for (let i = 0; i < 3; i++) await diff.settle();
        // The chunk's lines are folded under its first, which says so.
        const lines = folded();
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.some((line) => line.includes("za shows them"))).toBe(true);
        // The cursor went on; k comes back onto the folded line only.
        expect(cursorAt()).toBe("unstaged:a.ts:context:20");
        await press("k");
        expect(cursorAt()).toBe("unstaged:a.ts:context:1");
        // j from the folded line goes past the chunk.
        await press("j");
        expect(cursorAt()).toBe("unstaged:a.ts:context:20");
        // za on it shows the chunk, still reviewed; za folds it back.
        await press("k");
        await keys("za");
        for (let i = 0; i < 3; i++) await diff.settle();
        expect(folded()).toEqual([]);
        expect(marked("unstaged:a.ts")).toContain("2:unstaged:reviewed");
        await keys("za");
        for (let i = 0; i < 3; i++) await diff.settle();
        expect(folded().length).toBeGreaterThan(1);
      } finally {
        await diff.unmount();
      }
    });

    test("v marks the file reviewed, every chunk of it; v again unmarks it and its chunks", async () => {
      reset();
      const diff = await mount();
      try {
        await press("v");
        await diff.settle();
        const first = calls.find((c) => c.method === "review.update")!.params
          .reviewed as Record<string, string>;
        // The file's mark and its two chunks'.
        expect(Object.keys(first)).toHaveLength(3);
        expect(notices).toContain("Reviewed (1/2)");
        await diff.settle();
        // Folded to its header, as in the review pane; the cursor goes on
        // to what is left to review, and gg too.
        const section = document.querySelector<HTMLElement>(
          '[data-diff-entry-key="unstaged:a.ts"]',
        )!;
        expect(section.textContent).toContain("✓ reviewed");
        expect(
          section.querySelector<HTMLElement>(".diff-file-section-body")?.hidden,
        ).toBe(true);
        expect(cursorAt()?.startsWith("unstaged:b.ts")).toBe(true);
        await keys("gg");
        expect(cursorAt()?.startsWith("unstaged:b.ts")).toBe(true);
        // Shown again, v unmarks it.
        await act(async () =>
          section
            .querySelector<HTMLButtonElement>(".diff-file-show-reviewed")!
            .click(),
        );
        await diff.settle();
        expect(
          section.querySelector<HTMLElement>(".diff-file-section-body")?.hidden,
        ).toBe(false);
        await keys("kkkk");
        expect(cursorAt()?.startsWith("unstaged:a.ts")).toBe(true);
        await press("v");
        await diff.settle();
        expect(notices).toContain("No longer reviewed, nor its chunks");
        // Unmarked here (kept as ""), none reviewed.
        expect(Object.values(marks).every((value) => value === "")).toBe(true);
      } finally {
        await diff.unmount();
      }
    });

    test("gn to a thread in a folded reviewed file shows the file", async () => {
      reset();
      const { feedbackNote } = await import("../workspaceFeedback");
      const note = {
        source: "diff",
        path: "a.ts",
        kind: "unstaged",
        side: "new",
        line: 2,
        quote: "deux",
        hunk: "",
      };
      const thread = {
        id: "t1",
        sessionId: "s1",
        kind: "discussion",
        anchor: {
          path: "a.ts",
          line: 2,
          side: "new",
          text: "deux",
          feedback: JSON.stringify(note),
        },
        comments: [
          {
            id: "t1c",
            author: "you",
            body: "Why deux?",
            createdAt: "2026-11-10T10:00:00Z",
            updatedAt: "2026-11-10T10:00:00Z",
          },
        ],
        resolved: false,
        createdAt: "2026-11-10T10:00:00Z",
        updatedAt: "2026-11-10T10:00:00Z",
      } as unknown as import("../../../shared/review").ReviewThread;
      const diff = await mount({
        threads: [thread],
        annotations: [feedbackNote(thread)],
      });
      try {
        await press("v");
        await diff.settle();
        const body = () =>
          document.querySelector<HTMLElement>(
            '[data-diff-entry-key="unstaged:a.ts"] .diff-file-section-body',
          );
        expect(body()?.hidden).toBe(true);
        await press("g");
        await press("n");
        await diff.settle();
        expect(body()?.hidden).toBe(false);
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
      } finally {
        await diff.unmount();
      }
    });

    test("a file folded reviewed, picked in the tree, unfolds with the cursor on it", async () => {
      reset();
      const diff = await mount({ entry: a, selectionRevision: 1 });
      const body = () =>
        document.querySelector<HTMLElement>(
          '[data-diff-entry-key="unstaged:a.ts"] .diff-file-section-body',
        );
      try {
        await press("v");
        for (let i = 0; i < 3; i++) await diff.settle();
        expect(body()?.hidden).toBe(true);
        expect(cursorAt()?.startsWith("unstaged:b.ts")).toBe(true);
        // Picked in the tree again: the file opens, the cursor on its
        // first line, and it stays reviewed.
        await diff.update({ entry: a, selectionRevision: 2 });
        for (let i = 0; i < 3; i++) await diff.settle();
        expect(body()?.hidden).toBe(false);
        expect(cursorAt()?.startsWith("unstaged:a.ts")).toBe(true);
        expect(
          document.querySelector('[data-diff-entry-key="unstaged:a.ts"]')
            ?.textContent,
        ).not.toContain("✓ reviewed");
        expect(marked("unstaged:a.ts")).toContain("2:unstaged:reviewed");
        // The same pick again (no new revision) changes nothing.
        await press("j");
        const at = cursorAt();
        await diff.update({ entry: a, selectionRevision: 2 });
        await diff.settle();
        expect(cursorAt()).toBe(at);
      } finally {
        await diff.unmount();
      }
    });

    test("Option+V marks the file as v does", async () => {
      reset();
      const diff = await mount();
      try {
        await press("√", { altKey: true, code: "KeyV" });
        await diff.settle();
        expect(notices).toContain("Reviewed (1/2)");
      } finally {
        await diff.unmount();
      }
    });

    test("gu and gU jump to the next and previous chunk not reviewed, wrapping", async () => {
      reset();
      const diff = await mount();
      try {
        await press("g");
        await press("u");
        expect(cursorAt()).toBe("unstaged:a.ts:context:20");
        await press("g");
        await press("u");
        expect(cursorAt()).toBe("unstaged:b.ts:context:1");
        await press("g");
        await press("u");
        expect(cursorAt()).toBe("unstaged:a.ts:context:1");
        await press("g");
        await press("U");
        expect(cursorAt()).toBe("unstaged:b.ts:context:1");
      } finally {
        await diff.unmount();
      }
    });

    test("with no review yet, the first mark opens the checkout's review", async () => {
      reset();
      opened = false;
      bump();
      const diff = await mount();
      try {
        await keys("jj");
        await press("r");
        await diff.settle();
        expect(calls.map((c) => c.method)).toEqual([
          "review.open",
          "review.update",
        ]);
        expect(calls[0]!.params).toMatchObject({
          workspace_id: "workspace",
          path: "/repo",
          target: { kind: "worktree" },
        });
      } finally {
        await diff.unmount();
      }
    });

    test("a staged entry's chunks carry the staged marker, the unstaged ones theirs", async () => {
      reset();
      const diff = await mount({
        entries: [entry("a.ts", "staged", "M"), entry("a.ts", "unstaged", "M")],
        patches: {
          "staged:a.ts": patches["unstaged:a.ts"]!.split("@@ -20")[0]!,
          "unstaged:a.ts": patch("a.ts", "@@ -20,3 +20,3 @@\n x\n-y\n+z\n w"),
        },
      });
      try {
        await diff.settle();
        expect(marked("staged:a.ts").every((m) => m.includes(":staged"))).toBe(
          true,
        );
        expect(marked("unstaged:a.ts").length).toBeGreaterThan(0);
        expect(
          marked("unstaged:a.ts").every((m) => m.includes(":unstaged")),
        ).toBe(true);
      } finally {
        await diff.unmount();
      }
    });

    test("a combined diff's chunks carry staged, unstaged or partly staged, told exactly by the server", async () => {
      reset();
      const combined = entry("a.ts", "combined", "M");
      const diff = await mount({
        entries: [combined, entry("b.ts", "combined", "M")],
        patches: {
          "combined:a.ts": patch(
            "a.ts",
            "@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three",
            "@@ -20,3 +20,4 @@\n x\n-y\n+z\n+zz\n w",
            "@@ -40,3 +41,3 @@\n k\n-l\n+m\n n",
          ),
          "combined:b.ts": patch("b.ts", "@@ -1,2 +1,2 @@\n p\n-q\n+r"),
        },
        staged: {
          // The first chunk all in the index, the second its removal and
          // one of its two lines, the third none of it.
          "combined:a.ts": {
            old: [
              [2, 2],
              [21, 21],
            ],
            new: [
              [2, 2],
              [21, 21],
            ],
          },
          // Untracked or unknown: no staged lines.
        },
      });
      try {
        await diff.settle();
        // One section per file.
        expect(diff.sections().map((section) => section.key)).toEqual([
          "combined:a.ts",
          "combined:b.ts",
        ]);
        const a = marked("combined:a.ts");
        expect(a).toContain("2:staged");
        expect(a).toContain("21:partly");
        expect(a).toContain("22:partly");
        expect(a).toContain("42:unstaged");
        expect(a.some((m) => m.startsWith("2:") && !m.includes("staged"))).toBe(
          false,
        );
        expect(
          marked("combined:b.ts").every((m) => m.endsWith(":unstaged")),
        ).toBe(true);
        expect(marked("combined:b.ts").length).toBeGreaterThan(0);
      } finally {
        await diff.unmount();
      }
    });

    test("a combined chunk keeps its reviewed mark when it is staged: its id is the same", async () => {
      reset();
      const combined = entry("b.ts", "combined", "M");
      const body = patch("b.ts", "@@ -1,2 +1,2 @@\n p\n-q\n+r");
      const diff = await mount({
        entries: [combined],
        patches: { "combined:b.ts": body },
      });
      try {
        await keys("jj");
        await press("r");
        await diff.settle();
        expect(marked("combined:b.ts")).toContain("2:unstaged:reviewed");
        // Staged: the same combined diff, the index now holds its lines.
        await diff.update({
          staged: { "combined:b.ts": { old: [[2, 2]], new: [[2, 2]] } },
        });
        await diff.settle();
        expect(marked("combined:b.ts")).toContain("2:staged:reviewed");
      } finally {
        await diff.unmount();
      }
    });

    test("without the review (a commit's diff in Commits, Files' changes), r, v and gu do nothing and nothing is marked", async () => {
      reset();
      const diff = await mount({ reviewCursor: false });
      try {
        await keys("rv");
        await diff.settle();
        expect(calls).toEqual([]);
        expect(marked("unstaged:a.ts")).toEqual([]);
      } finally {
        await diff.unmount();
      }
    });
  });
}
