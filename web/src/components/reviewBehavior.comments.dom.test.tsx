import { describe, expect, test } from "bun:test";

/**
 * Writing comments in the review, at the behavior level: keys in, the
 * editor, what is written to the bridge and what shows out. Runs against
 * every review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review comments in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST: "1" },
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
  }, 30_000);
} else {
  const { installReviewDom, file, hunk } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

  const code = () =>
    file("a.ts", hunk(1, 1, [" one", "-two", "+deux", "+trois", " four"]));

  /** A thread with one message, by you unless said. */
  const mine = (
    id: string,
    anchor: Record<string, unknown>,
    body: string,
    options: {
      kind?: "draft" | "discussion";
      author?: string;
      updatedAt?: string;
    } = {},
  ) =>
    ({
      id,
      sessionId: "s1",
      kind: options.kind ?? "draft",
      anchor,
      comments: [
        {
          id: `${id}c`,
          author: options.author ?? "you",
          body,
          createdAt: "2026-11-04T14:11:18Z",
          updatedAt: options.updatedAt ?? "2026-11-04T14:11:18Z",
        },
      ],
      resolved: false,
      createdAt: "2026-11-04T14:11:18Z",
      updatedAt: options.updatedAt ?? "2026-11-04T14:11:18Z",
    }) as unknown as import("../../../shared/review").ReviewThread;

  /** An agent the comments go to as they are written. */
  const agent = { agent: { name: "Claude", paneId: "p1" } };

  for (const { name, mount } of reviewSurfacesWith("editor"))
    describe(name, () => {
      test("c, Enter, i and a open an editor on the cursor line; saved, it is a comment on that line", async () => {
        const review = await mount({ files: [code()] });
        expect(review.editorText()).toBeNull();
        // Each key opens an editor; :q leaves it, nothing written.
        for (const key of ["c", "<Enter>", "i", "a"]) {
          await review.press("j");
          await review.press(key);
          expect(review.editorText()).toBe("");
          await review.editorCommand(":q");
          expect(review.editorText()).toBeNull();
        }
        expect(review.calls("review.thread.add")).toHaveLength(0);
        await review.click({ path: "a.ts", new: 2 });
        expect(review.cursorLine()?.text).toBe("deux");
        await review.press("c");
        expect(review.editorText()).toBe("");
        expect(review.editorPlaceholder()).toBe(
          "Your comment on this line (Cmd+Enter saves, Esc closes)",
        );
        await review.type("Say it in English");
        await review.editorPress("<C-Enter>");
        expect(review.editorText()).toBeNull();
        const [write] = review.calls("review.thread.add");
        expect(write?.params).toMatchObject({
          kind: "draft",
          anchor: { path: "a.ts", line: 2, side: "new", text: "deux" },
          text: "Say it in English",
        });
        expect(review.commentTexts().join("\n")).toContain("Say it in English");
        // c again on that line edits your comment there.
        await review.press("c");
        expect(review.editorText()).toBe("Say it in English");
        await review.editorCommand(":q");
        // A removed line: the comment is on the old side.
        await review.click({ path: "a.ts", old: 2 });
        await review.press("c");
        await review.type("Why remove it?");
        await review.editorButton("Save");
        expect(review.calls("review.thread.add")[1]?.params).toMatchObject({
          anchor: { path: "a.ts", line: 2, side: "old", text: "two" },
          text: "Why remove it?",
        });
        await review.unmount();
      });

      test("with the editor or the : prompt focused every key is theirs: the diff and the inspector take none, keep none pending, and the focus stays", async () => {
        const review = await mount({ files: [code()] });
        // Where 2j and then j go, without anything in between.
        await review.press("2j");
        const at = review.cursorLine();
        await review.press("j");
        const next = review.cursorLine();
        await review.press("k");
        expect(review.cursorLine()).toEqual(at);
        expect(next).not.toEqual(at);
        await review.press("c");
        expect(review.editorText()).toBe("");
        // A count, the g / z / d / [ prefixes, Enter, a colon, ?, a motion:
        // each the diff's, out of the editor.
        const keys = "2gzd[<Enter>g:?jG";
        const typed = await review.keysInFocus(keys);
        expect(typed.length).toBe(11);
        expect(typed.filter((each) => !each.untouched || !each.stayed)).toEqual(
          [],
        );
        expect(review.cursorLine()).toEqual(at);
        await review.editorCommand(":q");
        expect(review.editorText()).toBeNull();
        // Nothing kept: g waits alone (no gg), then j goes one line (no 2).
        await review.press("g");
        expect(review.cursorLine()).toEqual(at);
        await review.press("j");
        expect(review.cursorLine()).toEqual(next);
        await review.press("k");
        // The same in the `:` prompt.
        await review.press(":");
        expect(review.prompt()?.kind).toBe(":");
        const prompted = await review.keysInFocus("2gzdjG?");
        expect(
          prompted.filter((each) => !each.untouched || !each.stayed),
        ).toEqual([]);
        expect(review.cursorLine()).toEqual(at);
        await review.press("<Esc>");
        expect(review.prompt()).toBeNull();
        await review.press("g");
        expect(review.cursorLine()).toEqual(at);
        await review.press("j");
        expect(review.cursorLine()).toEqual(next);
        await review.unmount();
      });

      test("the editor under a line is the page's, not the diff's: its root is the document, its caret drawn, its words the review's", async () => {
        const review = await mount({ files: [code()] });
        await review.press("jc");
        const content = document.querySelector<HTMLElement>(
          "[data-review-editor] .cm-content",
        );
        expect(content).not.toBeNull();
        const { EditorView } = await import("@codemirror/view");
        const view = EditorView.findFromDOM(content!);
        // Slotted into the diff's shadow DOM, CodeMirror took the diff's
        // shadow root: never focused there, its caret stayed behind after
        // Enter and its theme (caret, font, box) styled nothing.
        expect(view?.root).toBe(document);
        expect(view?.hasFocus).toBe(true);
        expect(
          content!.closest("[data-review-editor]")?.closest("[slot]"),
        ).not.toBeNull();
        // The caret is drawn by the editor (a bar while typing).
        expect(view?.dom.querySelector(".cm-cursorLayer")).not.toBeNull();
        await review.editorCommand(":q");
        await review.unmount();
      });

      test("V then C asks the agent about the lines selected, as one discussion; with no agent it is held for Send in the workspace's threads", async () => {
        const review = await mount({ files: [code()] });
        await review.press("2jVj");
        expect(review.selection().map((line) => line.text)).toEqual([
          "deux",
          "trois",
        ]);
        await review.press("C");
        expect(review.selection()).toEqual([]);
        // No agent to ask: not a thread nobody receives, but one held in
        // the workspace's threads (To send), as a terminal's comment is.
        expect(review.editorPlaceholder()).toBe(
          "Waiting for Send in the workspace's threads (Cmd+Enter saves, Esc closes)",
        );
        await review.type("Why both?");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "discussion",
          anchor: { path: "a.ts", line: 2, endLine: 3, side: "new" },
          text: "Why both?",
          held: expect.any(Number),
        });
        expect(review.notices()).toContain(
          "Waiting for Send in the workspace's threads",
        );
        await review.unmount();
        // Held, it says so where it is; once sent, that it was.
        const shown = await mount({
          files: [code()],
          threads: [
            {
              ...mine("t1", { path: "a.ts", line: 2, side: "new" }, "Why?", {
                kind: "discussion",
              }),
              held: 1,
            },
            {
              ...mine("t2", { path: "a.ts", line: 3, side: "new" }, "And?", {
                kind: "discussion",
              }),
              handedAt: "2026-11-05T10:00:00Z",
            },
          ],
        });
        const marks = Object.fromEntries(
          shown
            .shownThreads()
            .map((thread) => [thread.id, thread.messages[0]?.marks]),
        );
        expect(marks.t1).toContain(
          "Waiting for Send in the workspace's threads",
        );
        expect(marks.t2).toContain("sent from the workspace's threads");
        await shown.unmount();
      });

      test("C and :ask ask the agent on the line; on a line it already discusses, the answer goes there", async () => {
        const review = await mount({
          files: [code()],
          session: agent,
          threads: [
            mine(
              "t1",
              { path: "a.ts", line: 3, side: "new" },
              "Is trois right?",
              { kind: "discussion" },
            ),
          ],
        });
        await review.press("2j");
        await review.press("C");
        expect(review.editorPlaceholder()).toBe(
          "For Claude: sent as you save (Cmd+Enter saves, Esc closes)",
        );
        await review.type("And deux?");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "discussion",
          anchor: { path: "a.ts", line: 2, side: "new" },
          text: "And deux?",
        });
        await review.click({ path: "a.ts", new: 3 });
        await review.command(":ask");
        expect(review.editorPlaceholder()).toBe(
          "Your reply (Cmd+Enter saves, Esc closes)",
        );
        await review.type("Yes it is");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.reply")[0]?.params).toMatchObject({
          comment_id: "t1",
          text: "Yes it is",
        });
        // With an agent the comments go to, c talks to it too.
        await review.click({ path: "a.ts", new: 1 });
        await review.press("c");
        expect(review.editorPlaceholder()).toBe(
          "For Claude: sent as you save (Cmd+Enter saves, Esc closes)",
        );
        await review.unmount();
      });

      test("s and :suggest open a GitLab suggestion of the new line; :sugg and Suggest add another; a removed line has none", async () => {
        const review = await mount({ files: [code()] });
        const block = "```suggestion:-0+0\ndeux\n```\n";
        await review.press("2js");
        expect(review.editorText()).toBe(block);
        await review.editorCommand(":sugg");
        expect(review.editorText()).toBe(`${block}${block}`);
        await review.editorButton("Suggest");
        expect(review.editorText()).toBe(`${block}${block}${block}`);
        await review.editorCommand(":q");
        await review.press("j");
        await review.command(":suggest");
        expect(review.editorText()).toBe("```suggestion:-0+0\ntrois\n```\n");
        await review.editorCommand(":q");
        await review.press("2k");
        expect(review.cursorLine()?.text).toBe("two");
        await review.press("s");
        expect(review.editorText()).toBeNull();
        expect(review.notices()).toContain(
          "Suggestions apply to lines of the new version.",
        );
        await review.unmount();
      });

      test("a suggestion shows the lines it replaces, read from the new version in the diff", async () => {
        const review = await mount({
          files: [code()],
          threads: [
            mine(
              "t1",
              { path: "a.ts", line: 2, side: "new" },
              "```suggestion:-0+0\nDEUX\n```",
            ),
            mine("t2", {}, "```suggestion:-0+0\nnothing\n```"),
          ],
        });
        const texts = review.text();
        expect(texts).toContain("Suggested change2-deux+DEUX");
        expect(texts).toContain(
          "Suggested change (the lines it replaces are not shown)+nothing",
        );
        await review.unmount();
      });

      test("e edits the message selected, else your last on the line, else your latest anywhere", async () => {
        const review = await mount({
          files: [code()],
          threads: [
            mine("t1", { path: "a.ts", line: 2, side: "new" }, "First"),
            mine("t2", { path: "a.ts", line: 3, side: "new" }, "Latest", {
              updatedAt: "2026-11-05T09:00:00Z",
            }),
            mine("t3", { path: "a.ts", line: 4, side: "new" }, "Agent says", {
              author: "Claude",
              kind: "discussion",
            }),
          ],
        });
        // On no comment: your latest, the cursor going to it.
        await review.press("e");
        expect(review.editorText()).toBe("Latest");
        expect(review.cursorLine()?.text).toBe("trois");
        await review.editorCommand(":q");
        // On a line with yours: that one.
        await review.press("k");
        await review.press("e");
        expect(review.editorText()).toBe("First");
        await review.type(" again");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.edit")[0]?.params).toMatchObject({
          comment_id: "t1c",
          text: "First again",
        });
        // A message selected that is the agent's: said, not edited.
        await review.press("Gn");
        await review.press("e");
        expect(review.editorText()).toBeNull();
        expect(review.notices()).toContain(
          "That message is Claude's; e edits yours.",
        );
        await review.unmount();
        const none = await mount({ files: [code()] });
        await none.press("e");
        expect(none.editorText()).toBeNull();
        expect(none.notices()).toContain(
          "You have not written anything here yet.",
        );
        await none.unmount();
      });

      test("dd deletes your comment on the line, u brings it back; on no comment it says so", async () => {
        const review = await mount({
          files: [code()],
          threads: [
            mine("t1", { path: "a.ts", line: 2, side: "new" }, "Drop me"),
            mine("t2", { path: "a.ts", line: 3, side: "new" }, "The agent's", {
              author: "Claude",
              kind: "discussion",
            }),
          ],
        });
        await review.press("dd");
        expect(review.calls("review.delete")).toHaveLength(0);
        expect(review.notices()).toContain("No comment on this line.");
        await review.press("2jdd");
        expect(review.calls("review.delete")[0]?.params).toMatchObject({
          comment_id: "t1",
        });
        expect(review.notices()).toContain("Comment deleted (u undoes)");
        await review.press("u");
        expect(review.calls("review.restore")[0]?.params).toMatchObject({
          thread: { id: "t1", comments: [{ body: "Drop me" }] },
        });
        // The agent's discussion is not yours to delete.
        await review.click({ path: "a.ts", new: 3 });
        await review.press("dd");
        expect(review.calls("review.delete")).toHaveLength(1);
        expect(review.notices()).toContain("No comment on this line.");
        await review.unmount();
      });

      test("Overall comment writes the review's overall comment, saved as you leave it", async () => {
        const review = await mount({ files: [code()] });
        await review.clickButton("Overall comment");
        expect(review.editorText()).toBe("");
        expect(review.editorPlaceholder()).toBe(
          "Your overall comment on the review (Cmd+Enter saves, Esc closes)",
        );
        await review.type("Ship it");
        await review.editorButton("Save");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.update")[0]?.params).toMatchObject({
          summary: "Ship it",
        });
        // Esc saves it too: nothing of it is sent anywhere.
        await review.clickButton("Overall comment");
        await review.type("Fine");
        await review.editorPress("<Esc><Esc>");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.update")[1]?.params).toMatchObject({
          summary: "Fine",
        });
        await review.unmount();
        // One written shows, and Edit opens it.
        const written = await mount({
          files: [code()],
          session: { summary: "Mostly fine" },
        });
        expect(written.text()).toContain("Mostly fine\nOverall comment");
        await written.clickButton("Edit");
        expect(written.editorText()).toBe("Mostly fine");
        await written.unmount();
      });

      test("selected words of a message offer Comment, a discussion quoting them", async () => {
        const review = await mount({
          files: [code()],
          threads: [
            mine(
              "t1",
              { path: "a.ts", line: 2, side: "new" },
              "Use a map here instead of a list",
              { author: "Claude", kind: "discussion" },
            ),
          ],
        });
        await review.selectWords("a map");
        await review.clickButton("Comment");
        expect(review.editorText()).toBe("");
        await review.type("Which map?");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "discussion",
          anchor: {
            path: "a.ts",
            line: 2,
            message: { thread: "t1", comment: "t1c", quote: "a map" },
          },
          text: "Which map?",
        });
        await review.unmount();
      });

      test("a comment on a file and no line shows at the file's head, above its lines", async () => {
        const review = await mount({
          files: [code(), file("b.ts", hunk(1, 1, ["+b"]))],
          threads: [
            mine("t1", { path: "b.ts" }, "The whole file is new"),
            mine("t2", { path: "b.ts", line: 0, side: "new" }, "Line 0 too"),
          ],
        });
        expect(review.fileComments("a.ts")).toEqual([]);
        const comments = review.fileComments("b.ts");
        expect(comments).toHaveLength(2);
        expect(comments[0]).toContain("The whole file is new");
        expect(comments[1]).toContain("Line 0 too");
        await review.unmount();
      });
    });
}
