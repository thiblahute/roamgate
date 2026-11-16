import { describe, expect, test } from "bun:test";

/**
 * The review's comment editor, thread keys and thread placing in Changes
 * (plan: review into the inspector, phase 4), with the review's cursor
 * (`reviewCursor`). Without the review (a commit's diff, Files' changes),
 * the diff keeps its popover and its keys (DiffContentView.cursor.dom).
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

  describe("the Last step in Changes (plan D15)", () => {
    test("a step's untracked files left out of its snapshots are named above its diff", async () => {
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        reviewScope: {
          kind: "step",
          step: {
            step: "1763200000000-abcdef01",
            before: "a".repeat(40),
            after: "b".repeat(40),
            skipped: ["huge.bin", "dump.sql"],
          },
        },
      });
      try {
        expect(
          document.querySelector(".diff-review-views [role=note]")?.textContent,
        ).toBe(
          "Left out of this step (untracked, over 50 MB): huge.bin, dump.sql",
        );
      } finally {
        await diff.unmount();
      }
      // A step with nothing left out says nothing.
      const whole = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        reviewScope: {
          kind: "step",
          step: {
            step: "1763200000000-abcdef01",
            before: "a".repeat(40),
            after: "b".repeat(40),
          },
        },
      });
      try {
        expect(
          document.querySelector(".diff-review-views [role=note]"),
        ).toBeNull();
      } finally {
        await whole.unmount();
      }
    });
  });

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
          "```suggestion:-0+0\nthree\n```\n",
        );
      } finally {
        await diff.unmount();
      }
    });

    test("without the review (a commit's diff in Commits, Files' changes), c is nothing and a second click opens upstream's popover", async () => {
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

  describe("the review's comment editor in Changes, as you type", () => {
    test("typing a comment renders the editor alone, not the review", async () => {
      const big = entry("big.ts", "unstaged", "A");
      const added = Array.from(
        { length: 40 },
        (_, i) => `+const line${i} = ${i};`,
      );
      let commits = 0;
      const diff = await mountChangesDiff({
        entries: [big],
        patches: {
          "unstaged:big.ts": `diff --git a/big.ts b/big.ts\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,40 @@\n${added.join("\n")}\n`,
        },
        reviewCursor: true,
        onCreateAnnotation: () => {},
        onRender: () => {
          commits++;
        },
      });
      try {
        expect(diff.lines("unstaged:big.ts").length).toBeGreaterThanOrEqual(40);
        await press("c");
        const box = await waitForEditor(diff);
        expect(box).not.toBeNull();
        await diff.settle();
        // The Profiler sees the diff's renders: opening the editor was one.
        expect(commits).toBeGreaterThan(0);
        commits = 0;
        for (const key of "Looks good")
          await act(async () =>
            box!.dispatch({
              changes: { from: box!.state.doc.length, insert: key },
            }),
          );
        await diff.settle();
        // Each key re-rendered every diff line and thread before.
        expect(commits).toBe(0);
        // What was typed is still what the editor keeps and saves.
        expect(editor()?.state.doc.toString()).toBe("Looks good");
      } finally {
        await diff.unmount();
      }
    });
  });

  describe("git actions from the diff", () => {
    test("gs stages the file at the cursor; s alone is not staging; without the review (a commit's diff in Commits, Files' changes) gs does nothing", async () => {
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

    test("another repository's thread on a file of the same path is not drawn, walked, counted or listed", async () => {
      const { rememberReviewSnapshot } = await import("../review");
      const session = (id: string, root: string) =>
        ({
          session: {
            id,
            connectionId: "repos-diff",
            workspaceId: "workspace",
            root,
            title: root,
            target: { kind: "worktree" },
            gitlab: false,
            summary: "",
            agent: {},
            createdAt: "2026-11-10T10:00:00Z",
            updatedAt: "2026-11-10T10:00:00Z",
          },
          threads: [],
        }) as unknown as import("../../../shared/review").ReviewSnapshot;
      rememberReviewSnapshot(session("in-a", "/w/a"));
      const onA = {
        ...thread("ta", { kind: "unstaged", line: 2 }, "deux"),
        sessionId: "in-a",
      };
      notices.length = 0;
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads: [onA],
        annotations: [feedbackNote(onA)],
        connectionId: "repos-diff",
        repo: { root: "/w/b", own: false },
      });
      try {
        // Repository b shown: a's thread on its own a.ts stays off b's.
        expect(diff.comments("unstaged:a.ts")).toHaveLength(0);
        expect(document.querySelector(".diff-threads-chip")).toBeNull();
        await press("g");
        await press("n");
        expect(notices[notices.length - 1]).toBe("No unresolved comment here.");
        // Repository a shown: drawn, counted and walked.
        await diff.update({ repo: { root: "/w/a", own: true } });
        expect(diff.comments("unstaged:a.ts")).toHaveLength(1);
        expect(document.querySelector(".diff-threads-chip")).not.toBeNull();
        await press("g");
        await press("n");
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

    test("c and C on a line being discussed answer there, as the review pane's do", async () => {
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
        await diff.settle();
        await press("C");
        await diff.settle();
        expect(editor()).toBeNull();
        expect(
          document.querySelector(
            ".diff-review-thread textarea, .diff-review-thread .cm-content",
          ),
        ).not.toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("j and k step into the messages drawn under a line before the next line; n and N go message to message, gl to the last, and c on a message answers", async () => {
      const talk = {
        ...open,
        comments: [
          ...open.comments,
          {
            id: "t1d",
            author: "agent",
            body: "Because of the cache",
            createdAt: "2026-11-10T10:05:00Z",
            updatedAt: "2026-11-10T10:05:00Z",
          },
          {
            id: "t1e",
            author: "you",
            body: "Thanks",
            createdAt: "2026-11-10T10:06:00Z",
            updatedAt: "2026-11-10T10:06:00Z",
          },
        ],
      } as Thread;
      const focusedMessage = () =>
        document
          .querySelector<HTMLElement>(".diff-review-thread .is-focused")
          ?.getAttribute("data-chat-stop") ?? null;
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads: [talk],
        annotations: [feedbackNote(talk)],
      });
      try {
        await keys("jj");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        expect(focusedMessage()).toBeNull();
        // j goes into the thread, message by message, then on down.
        await press("j");
        expect(focusedMessage()).toBe("m:t1c");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        await press("j");
        expect(focusedMessage()).toBe("m:t1d");
        await press("k");
        expect(focusedMessage()).toBe("m:t1c");
        // k off the first message is back on the line.
        await press("k");
        expect(focusedMessage()).toBeNull();
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        await press("g");
        await press("l");
        expect(focusedMessage()).toBe("m:t1e");
        await press("N");
        expect(focusedMessage()).toBe("m:t1d");
        await press("n");
        expect(focusedMessage()).toBe("m:t1e");
        // Past the last message, j goes on to the next line.
        await press("j");
        expect(cursorAt()).toBe("unstaged:a.ts:context:3");
        expect(focusedMessage()).toBeNull();
        // k comes up onto the thread's last message.
        await press("k");
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        expect(focusedMessage()).toBe("m:t1e");
        await press("c");
        await diff.settle();
        expect(
          document.querySelector(
            ".diff-review-thread textarea, .diff-review-thread .cm-content",
          ),
        ).not.toBeNull();
      } finally {
        await diff.unmount();
      }
    });

    test("zz, zt, zb and z. reach the diff's cursor on a line, and place the message j / k are on when one is", async () => {
      const placed: string[] = [];
      const realScroll = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = function (
        this: HTMLElement,
        options?: boolean | ScrollIntoViewOptions,
      ) {
        const stop = this.getAttribute("data-chat-stop");
        // The cursor's own "nearest" steps are not placements.
        if (stop && typeof options === "object" && options.block !== "nearest")
          placed.push(`${stop}:${options.block}`);
      };
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
        // On a line: the cursor's scroll, no message moved, keys taken.
        for (const pair of ["zz", "zt", "zb", "z."]) {
          const events: KeyboardEvent[] = [];
          const record = (event: Event) => events.push(event as KeyboardEvent);
          document.addEventListener("keydown", record);
          await keys(pair);
          document.removeEventListener("keydown", record);
          expect(events.every((event) => event.defaultPrevented)).toBe(true);
        }
        expect(placed).toEqual([]);
        expect(cursorAt()).toBe("unstaged:a.ts:change-addition:2");
        // On a message: that message is placed.
        await press("j");
        await keys("zz");
        await keys("zt");
        await keys("zb");
        expect(placed).toEqual(["m:t1c:center", "m:t1c:start", "m:t1c:end"]);
      } finally {
        HTMLElement.prototype.scrollIntoView = realScroll;
        await diff.unmount();
      }
    });

    test("Files' Review puts the cursor on that file's line, the nearest one shown, centered", async () => {
      const b = entry("b.ts", "unstaged", "M");
      const diff = await mountChangesDiff({
        entries: [a, b],
        entry: b,
        patches: {
          ...patches,
          "unstaged:b.ts":
            "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -8,4 +8,4 @@\n eight\n-nine\n+neuf\n ten\n eleven\n",
        },
        reviewCursor: true,
        onCreateAnnotation: () => {},
        cursorGoTo: { path: "/repo/b.ts", line: 10, at: Date.now() },
      });
      try {
        for (let i = 0; i < 5; i++) await diff.settle();
        expect(cursorAt()).toBe("unstaged:b.ts:context:10");
      } finally {
        await diff.unmount();
      }
    });

    test("a focus the cursor's key did not ask for comes back to the diff; a press elsewhere keeps it where it went", async () => {
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
      });
      const outside = document.createElement("button");
      document.body.prepend(outside);
      try {
        await keys("zz");
        // The browser hands the focus to the page's first control.
        outside.focus();
        await diff.settle();
        expect(document.activeElement).toBe(view());
        // A press there is the user's: it stays.
        await keys("zz");
        outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        outside.focus();
        await diff.settle();
        expect(document.activeElement).toBe(outside);
      } finally {
        outside.remove();
        await diff.unmount();
      }
    });

    test("a comment on its way is drawn under its line as Sending..., then Not saved with Retry and Discard", async () => {
      const { pendingFeedback } = await import("../feedbackPending");
      const note = {
        id: "n-wait",
        source: "diff",
        path: "a.ts",
        kind: "unstaged",
        side: "new",
        line: 2,
        hunk: "",
        quote: "deux",
        comment: "Why two?",
        createdAt: 1,
      } as unknown as NewNote & { id: string };
      const calls: string[] = [];
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
      });
      try {
        await act(async () =>
          pendingFeedback.start(note as never, {
            retry: () => calls.push("retry"),
            discard: () => calls.push("discard"),
          }),
        );
        await diff.settle();
        const bar = () =>
          document.querySelector(".diff-review-pending")?.textContent ?? "";
        expect(bar()).toContain("Why two?");
        expect(bar()).toContain("Sending...");
        await act(async () => pendingFeedback.fail("n-wait", "offline"));
        await diff.settle();
        expect(bar()).toContain("Not saved: offline");
        const button = (label: string) =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              ".diff-review-pending button",
            ),
          ].find((each) => each.textContent === label)!;
        await act(async () => button("Retry").click());
        await act(async () => button("Discard").click());
        expect(calls).toEqual(["retry", "discard"]);
        await act(async () => pendingFeedback.done("n-wait"));
        await diff.settle();
        expect(document.querySelector(".diff-review-pending")).toBeNull();
      } finally {
        pendingFeedback.done("n-wait");
        await diff.unmount();
      }
    });

    test("a comment whose code is nowhere in the diff, and one on the whole review, are drawn above the diff; the forge's under GitLab", async () => {
      const lost = thread(
        "t9",
        { kind: "unstaged", line: 90, side: "new" },
        "gone line",
      );
      const whole = {
        ...thread("t8", { kind: "unstaged", line: 1, side: "new" }, "x"),
        anchor: { feedback: "{}" },
      } as unknown as Thread;
      const forge = {
        ...thread("t7", { kind: "unstaged", line: 1, side: "new" }, "x"),
        kind: "merge-request",
        anchor: { feedback: "{}" },
      } as unknown as Thread;
      const diff = await mountChangesDiff({
        entries: [a],
        patches,
        reviewCursor: true,
        onCreateAnnotation: () => {},
        threads: [lost, whole, forge],
        annotations: [feedbackNote(lost)],
      });
      try {
        const block = document.querySelector(".diff-review-general");
        expect(block).not.toBeNull();
        const text = block!.textContent ?? "";
        expect(text).toContain("About gone line");
        expect(text).toContain("GitLab");
        expect(
          [...block!.querySelectorAll("[data-thread-id]")].map(
            (each) => (each as HTMLElement).dataset.threadId,
          ),
        ).toEqual(expect.arrayContaining(["t9", "t8", "t7"]));
        // gH leaves only the unresolved ones: none resolved here, all stay.
        expect(diff.comments("unstaged:a.ts")).toHaveLength(0);
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
