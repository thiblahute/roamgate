import { describe, expect, test } from "bun:test";

/**
 * When the review's comment editor saves, keeps or drops what is written
 * (the save policy), and its keys and commands: keys and text in, what is
 * written to the bridge and what shows out. Runs against every review
 * surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review comment save policy in an isolated DOM runtime", async () => {
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
  const { installReviewDom, file, hunk, settle, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

  const code = () =>
    file("a.ts", hunk(1, 1, [" one", "-two", "+deux", "+trois", " four"]));
  const block = "```suggestion:-0+0\ndeux\n```\n";

  for (const { name, mount } of reviewSurfacesWith("editor"))
    describe(name, () => {
      test("a suggestion left as the line reads saves as nothing; with words or a change it saves as written", async () => {
        const review = await mount({ files: [code()] });
        await review.click({ path: "a.ts", new: 2 });
        await review.press("s");
        expect(review.editorText()).toBe(block);
        await review.editorButton("Save");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.thread.add")).toHaveLength(0);
        // Esc on one, in a local review, keeps nothing either (as Save, and
        // as in a GitLab review): s on the line then opens one block again.
        await review.press("s");
        await review.editorPress("<Esc><Esc>");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.thread.add")).toHaveLength(0);
        expect(review.notices()).not.toContain(
          "Not sent: reopen it to go on, Cmd+Enter or Save sends it.",
        );
        await review.press("s");
        expect(review.editorText()).toBe(block);
        await review.editorCommand(":q");
        await review.press("s");
        await review.type("And lowercase");
        await review.editorButton("Save");
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "draft",
          text: `${block}And lowercase`,
        });
        await review.unmount();
        // In a GitLab review a suggestion is a draft like any: Esc saves it,
        // and one that changes nothing is nothing.
        const gitlab = await mount({
          files: [code()],
          session: { gitlab: true },
        });
        await gitlab.click({ path: "a.ts", new: 2 });
        await gitlab.press("s");
        await gitlab.editorPress("<Esc><Esc>");
        expect(gitlab.editorText()).toBeNull();
        expect(gitlab.calls("review.thread.add")).toHaveLength(0);
        await gitlab.click({ path: "a.ts", new: 3 });
        await gitlab.press("s");
        expect(gitlab.editorText()).toBe("```suggestion:-0+0\ntrois\n```\n");
        await gitlab.editorCommand(":q");
        await gitlab.press("s");
        await gitlab.type("Not this");
        await gitlab.editorPress("<Esc><Esc>");
        expect(gitlab.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "draft",
          anchor: { path: "a.ts", line: 3 },
          text: "```suggestion:-0+0\ntrois\n```\nNot this",
        });
        await gitlab.unmount();
      });

      test("a new comment under 3 characters closed by Esc is a stray key, not saved; Save or 3 characters save it", async () => {
        const review = await mount({ files: [code()] });
        await review.click({ path: "a.ts", new: 2 });
        await review.press("c");
        await review.type("ab");
        await review.editorPress("<Esc><Esc>");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.thread.add")).toHaveLength(0);
        expect(review.notices()).toContain(
          'Not sent: "ab" looks like a stray key. Cmd+Enter or Save sends it.',
        );
        await review.press("c");
        expect(review.editorText()).toBe("");
        await review.type("ab");
        await review.editorButton("Save");
        expect(review.calls("review.thread.add")[0]?.params.text).toBe("ab");
        await review.click({ path: "a.ts", new: 3 });
        await review.press("c");
        await review.type("abc");
        await review.editorPress("<Esc><Esc>");
        expect(review.calls("review.thread.add")[1]?.params).toMatchObject({
          anchor: { line: 3 },
          text: "abc",
        });
        await review.unmount();
      });

      test("Esc keeps what goes to the agent as a draft, back when the editor reopens, even after a reload; :q drops it", async () => {
        const review = await mount({ files: [code()] });
        await review.click({ path: "a.ts", new: 2 });
        await review.press("C");
        await review.type("Is this right?");
        await review.editorPress("<Esc><Esc>");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.thread.add")).toHaveLength(0);
        expect(review.notices()).toContain(
          "Not sent: reopen it to go on, Cmd+Enter or Save sends it.",
        );
        await review.press("C");
        expect(review.editorText()).toBe("Is this right?");
        expect(review.notices()).toContain(
          "Your unsent text is back. Cmd+Enter sends it.",
        );
        await review.editorPress("<Esc><Esc>");
        await review.reload();
        expect(review.text()).toContain(
          "1 unsent draft kept: reopen the comment to go on.",
        );
        // (A click on the line the cursor is on would open an editor.)
        await review.press("gg");
        await review.click({ path: "a.ts", new: 2 });
        await review.press("C");
        expect(review.editorText()).toBe("Is this right?");
        await review.editorCommand(":q");
        await review.press("C");
        expect(review.editorText()).toBe("");
        await review.type("Now send it");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")).toHaveLength(1);
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "discussion",
          text: "Now send it",
        });
        await review.unmount();
      });

      test("nothing is saved while a pasted image uploads, by any key; once it is in, it saves", async () => {
        const review = await mount({ files: [code()] });
        await review.click({ path: "a.ts", new: 2 });
        await review.press("c");
        const release = review.holdImageUploads();
        await review.pasteImage("shot.png");
        expect(review.editorText()).toMatch(
          /^!\[Adding image \d+\.\.\.\]\(\)$/,
        );
        const uploading = "An image is still uploading: save once it is in.";
        await review.editorPress("<C-Enter>");
        await review.editorButton("Save");
        await review.editorCommand(":w");
        await review.editorPress("<Esc><Esc>");
        expect(review.editorText()).toMatch(
          /^!\[Adding image \d+\.\.\.\]\(\)$/,
        );
        // Each of the four said why.
        expect(
          review.notices().filter((notice) => notice === uploading),
        ).toHaveLength(4);
        expect(review.calls("review.thread.add")).toHaveLength(0);
        await release();
        expect(review.editorText()).toMatch(
          /^!\[shot\.png\]\(<\/reviews\/images\/\d+\.png>\)$/,
        );
        await review.editorButton("Save");
        expect(review.editorText()).toBeNull();
        expect(review.calls("review.thread.add")[0]?.params.text).toMatch(
          /^!\[shot\.png\]\(<\/reviews\/images\/\d+\.png>\)$/,
        );
        await review.unmount();
      });

      test("writing a comment shows the hidden comments again; a stray key does not", async () => {
        const review = await mount({
          files: [code()],
          threads: [thread("t1", "a.ts", 3, "Look here")],
        });
        expect(review.text()).toContain("Look here");
        await review.press("t");
        expect(review.text()).not.toContain("Look here");
        await review.click({ path: "a.ts", new: 2 });
        await review.press("c");
        await review.type("ab");
        await review.editorPress("<Esc><Esc>");
        expect(review.text()).not.toContain("Look here");
        await review.press("c");
        await review.type("My note");
        await review.editorButton("Save");
        expect(review.text()).toContain("Look here");
        expect(review.text()).toContain("My note");
        await review.unmount();
      });

      test("in the editor :w, :wq, :x, Cmd+Enter and Esc Esc save, :q drops; without Vim one Esc saves", async () => {
        const review = await mount({ files: [code()] });
        const saved = () =>
          review.calls("review.thread.add").map((call) => call.params.text);
        const write = async (line: number, text: string, keys: string) => {
          await review.click({ path: "a.ts", new: line });
          await review.press("c");
          await review.type(text);
          if (keys.startsWith(":")) await review.editorCommand(keys);
          else await review.editorPress(keys);
          expect(review.editorText()).toBeNull();
        };
        // Saved explicitly, even a word of two letters.
        await write(1, "w1", ":w");
        await write(2, "w2", ":wq");
        await write(3, "w3", ":x");
        await write(4, "w4", "<C-Enter>");
        expect(saved()).toEqual(["w1", "w2", "w3", "w4"]);
        await review.press("gg");
        await review.click({ path: "a.ts", old: 2 });
        await review.press("c");
        await review.type("dropped");
        await review.editorCommand(":q");
        expect(review.editorText()).toBeNull();
        await review.press("c");
        expect(review.editorText()).toBe("");
        await review.editorCommand(":q");
        // Esc leaves insert mode, a second Esc saves.
        await review.press("c");
        await review.type("kept as written");
        await review.editorPress("<Esc>");
        expect(review.editorText()).toBe("kept as written");
        await review.editorPress("<Esc>");
        expect(review.editorText()).toBeNull();
        expect(saved()).toEqual(["w1", "w2", "w3", "w4", "kept as written"]);
        await review.unmount();
        const plain = await mount({ files: [code()], vim: false });
        await plain.click({ path: "a.ts", new: 2 });
        await plain.press("c");
        await plain.type("No Vim here");
        await plain.editorPress("<Esc>");
        expect(plain.editorText()).toBeNull();
        expect(
          plain.calls("review.thread.add").map((call) => call.params.text),
        ).toEqual(["No Vim here"]);
        await plain.unmount();
      });

      test("Vim keys turned off elsewhere (Configuration, another device) make the open review's next comment plain", async () => {
        const review = await mount({ files: [code()] });
        (await import("../vimKeys")).setVimKeys(false);
        await settle();
        await review.click({ path: "a.ts", new: 2 });
        await review.press("c");
        await review.type("Plain now");
        await review.editorPress("<Esc>");
        expect(review.editorText()).toBeNull();
        expect(
          review.calls("review.thread.add").map((call) => call.params.text),
        ).toEqual(["Plain now"]);
        await review.unmount();
      });

      test("a pasted image goes in as Markdown linking the file stored with the review", async () => {
        const review = await mount({ files: [code()] });
        await review.click({ path: "a.ts", new: 2 });
        await review.press("c");
        await review.type("See ");
        await review.pasteImage("diagram.png");
        const [upload] = review.calls("review.image.add");
        expect(upload?.params).toMatchObject({
          type: "image/png",
          data: "iVBORw==",
        });
        expect(review.editorText()).toMatch(
          /^See !\[diagram\.png\]\(<\/reviews\/images\/\d+\.png>\)$/,
        );
        // A screenshot pasted has no name of its own.
        await review.pasteImage("image.png");
        expect(review.editorText()).toMatch(
          /!\[diagram\.png\]\(<[^>]+>\)!\[screenshot\]\(<\/reviews\/images\/\d+\.png>\)$/,
        );
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")[0]?.params.text).toMatch(
          /^See !\[diagram\.png\]\(<[^>]+>\)!\[screenshot\]\(<[^>]+>\)$/,
        );
        await review.unmount();
      });
    });
}
