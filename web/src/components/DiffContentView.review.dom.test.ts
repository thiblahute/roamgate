import { describe, expect, test } from "bun:test";

/**
 * The review's comment editor, thread keys and thread placing in Changes
 * (plan: review into the inspector, phase 4), "in Changes" with Vim keys
 * on (`reviewCursor`). On classic, Changes keeps its popover and its keys
 * (DiffContentView.cursor.dom.test.ts).
 */
if (process.env.ROAMGATE_CHANGES_REVIEW_DOM_TEST !== "1") {
  test("Changes' review editor and thread keys in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHANGES_REVIEW_DOM_TEST: "1" },
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
  const { installChangesDom, mountChangesDiff, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const { act } = await import("react");
  const { EditorView } = await import("@codemirror/view");
  const { store } = await import("../store");
  const { roamgateLocalStorage } = await import("../browserStorage");
  // One column: j / k go through every line, as the tests count them.
  roamgateLocalStorage.setItem("diffViewMode", "unified");
  const { feedbackNote } = await import("../workspaceFeedback");
  type Thread = import("../../../shared/review").ReviewThread;
  type NewNote = import("../annotations").NewReviewAnnotation;

  const a = entry("a.ts", "unstaged", "M");
  const patches = {
    "unstaged:a.ts":
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,4 @@\n one\n-two\n+deux\n three\n four\n",
    "staged:a.ts":
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n zero\n+one\n two\n",
  };

  const view = () => document.querySelector<HTMLElement>(".diff-content-view")!;
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const target = view();
    target.focus();
    await act(async () => {
      target.dispatchEvent(
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
  const editor = () => {
    const content = document.querySelector<HTMLElement>(
      ".diff-review-composer .cm-content",
    );
    return content ? EditorView.findFromDOM(content) : null;
  };
  const waitForEditor = async (diff: { settle: () => Promise<void> }) => {
    for (let i = 0; i < 50 && !editor(); i++) await diff.settle();
    return editor();
  };
  const write = async (text: string) => {
    const box = editor()!;
    await act(async () =>
      box.dispatch({
        changes: { from: 0, to: box.state.doc.length, insert: text },
      }),
    );
  };
  const notices: string[] = [];
  const realNotify = store.notify.bind(store);
  store.notify = ((notice: { message: string }) => {
    notices.push(notice.message);
    return realNotify(notice as Parameters<typeof store.notify>[0]);
  }) as typeof store.notify;

  const thread = (
    id: string,
    note: Partial<NewNote> & { kind: "staged" | "unstaged"; line: number },
    text: string,
    resolved = false,
  ): Thread => {
    const full = {
      source: "diff",
      path: "a.ts",
      side: "new",
      quote: text,
      hunk: "",
      ...note,
    };
    return {
      id,
      sessionId: "s1",
      kind: "discussion",
      anchor: {
        path: "a.ts",
        line: note.line,
        side: "new",
        text,
        feedback: JSON.stringify(full),
      },
      comments: [
        {
          id: `${id}c`,
          author: "you",
          body: `About ${text}`,
          createdAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:00Z",
        },
      ],
      resolved,
      createdAt: `2026-11-10T10:00:0${id.length}Z`,
      updatedAt: "2026-11-10T10:00:00Z",
    } as unknown as Thread;
  };

  describe("the review's comment editor in Changes", () => {
    test("c opens the review's editor under the cursor's line, not the popover; Save sends it as a comment on that line", async () => {
      const notes: NewNote[] = [];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: (note) => notes.push(note),
      });
      try {
        await keys("jj");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        await press("c");
        expect(await waitForEditor(diff)).not.toBeNull();
        expect(
          document.querySelector(".annotation-composer-popover"),
        ).toBeNull();
        expect(diff.composer()?.title).toBe("unstaged:a.ts");
        await write("Why two?");
        await diff.save();
        await diff.settle();
        expect(notes).toMatchObject([
          {
            source: "diff",
            path: "a.ts",
            kind: "unstaged",
            side: "new",
            line: 2,
            comment: "Why two?",
          },
        ]);
        expect(editor()).toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("Esc keeps the words as a draft that comes back, and sends nothing; a key or two is a stray, dropped", async () => {
      const notes: NewNote[] = [];
      notices.length = 0;
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: (note) => notes.push(note),
      });
      try {
        await keys("jj");
        await press("c");
        await waitForEditor(diff);
        await write("Keep me, please");
        await act(async () => {
          document
            .querySelector<HTMLElement>(".diff-review-composer .cm-content")!
            .dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
              }),
            );
        });
        // Vim's first Esc leaves insert mode, the second closes the box.
        await act(async () => {
          document
            .querySelector<HTMLElement>(".diff-review-composer .cm-content")!
            .dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
              }),
            );
        });
        await diff.settle();
        expect(editor()).toBeNull();
        expect(notes).toEqual([]);
        expect(
          notices.some((each) => each.startsWith("Not sent: reopen it")),
        ).toBe(true);
        // Kept apart from every review session's drafts: the review pane
        // and Changes never take each other's text.
        const kept = JSON.parse(
          roamgateLocalStorage.getItem("reviewDrafts") ?? "{}",
        ) as Record<string, unknown>;
        expect(Object.keys(kept).every((id) => id.startsWith("changes:"))).toBe(
          true,
        );
        expect(Object.keys(kept)).toHaveLength(1);
        await press("c");
        await waitForEditor(diff);
        expect(editor()!.state.doc.toString()).toBe("Keep me, please");
        expect(notices).toContain(
          "Your unsent text is back. Cmd+Enter sends it.",
        );
      } finally {
        await diff.unmount();
      }
    });

    test("V then c comments the lines selected, ending where the selection ends; s starts a suggestion with the line as it reads", async () => {
      const notes: NewNote[] = [];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: (note) => notes.push(note),
      });
      try {
        await keys("jjjV");
        await press("j");
        await press("c");
        await waitForEditor(diff);
        await write("these two");
        await act(async () => {
          const { getCM, Vim } = await import("@replit/codemirror-vim");
          (
            Vim as unknown as { handleEx: (cm: unknown, c: string) => void }
          ).handleEx(getCM(editor()!)!, "w");
        });
        await diff.settle();
        expect(notes).toMatchObject([
          { side: "new", line: 3, endLine: 4, comment: "these two" },
        ]);
        await press("k");
        await press("s");
        await waitForEditor(diff);
        expect(editor()!.state.doc.toString()).toBe(
          "```suggestion\nthree\n```",
        );
      } finally {
        await diff.unmount();
      }
    });

    test("on classic, c is nothing and a second click opens upstream's popover", async () => {
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: false,
        onCreateAnnotation: () => {},
      });
      try {
        await press("c");
        await diff.settle();
        expect(editor()).toBeNull();
        expect(diff.composer()).toBeNull();
      } finally {
        await diff.unmount();
      }
    });
  });

  describe("git actions from the diff", () => {
    test("gs stages the file at the cursor; s alone is not staging; on classic gs does nothing", async () => {
      const done: string[] = [];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        onGitAction: (action, path) => {
          done.push(`${action} ${path}`);
          return true;
        },
      });
      try {
        await keys("jj");
        await press("g");
        await press("s");
        expect(done).toEqual(["stage a.ts"]);
        await press("s");
        await diff.settle();
        expect(done).toEqual(["stage a.ts"]);
      } finally {
        await diff.unmount();
      }
      const classic = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: false,
        onCreateAnnotation: () => {},
        onGitAction: (action, path) => {
          done.push(`${action} ${path}`);
          return true;
        },
      });
      try {
        await press("g");
        await press("s");
        expect(done).toEqual(["stage a.ts"]);
      } finally {
        await classic.unmount();
      }
    });
  });

  describe("the review's threads in Changes", () => {
    const open = thread(
      "t1",
      { kind: "unstaged", line: 2, side: "new" },
      "deux",
    );
    const second = thread(
      "t2",
      { kind: "unstaged", line: 4, side: "new" },
      "four",
    );
    const done = thread(
      "t3",
      { kind: "unstaged", line: 3, side: "new" },
      "three",
      true,
    );

    test("gn goes to the next unresolved thread's line, gN back, skipping resolved ones, and says where it is", async () => {
      notices.length = 0;
      const threads = [open, done, second];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads,
        annotations: threads.map((each) => feedbackNote(each)),
      });
      try {
        await press("g");
        await press("n");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        expect(notices[notices.length - 1]).toBe("1 of 2 unresolved");
        await press("g");
        await press("n");
        expect(cursorAt()).toBe("unstaged:a.ts:context:4");
        await press("g");
        await press("N");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
      } finally {
        await diff.unmount();
      }
    });

    test("gH shows the unresolved only; t hides every comment and shows them again", async () => {
      const threads = [open, done];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads,
        annotations: threads.map((each) => feedbackNote(each)),
      });
      try {
        expect(diff.comments("unstaged:a.ts")).toHaveLength(2);
        await press("g");
        await press("H");
        await diff.settle();
        expect(diff.comments("unstaged:a.ts")).toHaveLength(1);
        await press("g");
        await press("H");
        await press("t");
        await diff.settle();
        expect(diff.comments("unstaged:a.ts")).toHaveLength(0);
        await press("t");
        await diff.settle();
        expect(diff.comments("unstaged:a.ts")).toHaveLength(2);
      } finally {
        await diff.unmount();
      }
    });

    test("c on a line being discussed answers there; C asks anew", async () => {
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads: [open],
        annotations: [feedbackNote(open)],
      });
      try {
        await keys("jj");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        await press("c");
        await diff.settle();
        expect(editor()).toBeNull();
        expect(
          document.querySelector(
            ".diff-review-thread textarea, .diff-review-thread .cm-content",
          ),
        ).not.toBeNull();
        await press("Escape");
        await press("C");
        expect(await waitForEditor(diff)).not.toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("a thread written on a staged entry is drawn where its line is read now: under the unstaged entry's, found by its text", async () => {
      // Written on the staged entry (line 2 there read "one"): the staged
      // diff is not loaded here, the unstaged one has "one" on line 1.
      const moved = thread(
        "m1",
        { kind: "staged", line: 2, side: "new" },
        "one",
      );
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads: [moved],
        annotations: [feedbackNote(moved)],
      });
      try {
        // Its own (staged) entry is not shown: its comment is listed with
        // the path's, and drawn on the line that reads the same.
        expect(diff.comments("unstaged:a.ts")).toHaveLength(1);
      } finally {
        await diff.unmount();
      }
    });
  });
}
