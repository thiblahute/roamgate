import { describe, expect, jest, test } from "bun:test";

/**
 * Where a review is kept: its place (file, line, side) back after a page
 * reload and in each review apart, the 50 reviews remembered, damaged
 * storage read as empty, the preferences (side by side, file list, Vim),
 * and a review put away and shown again kept exactly, the keys back on it.
 * Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review place and preferences in an isolated DOM runtime", async () => {
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
  }, 60_000);
} else {
  const { installReviewDom, file, hunk, numbered } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

  /** `count` added lines `${path} line N`. */
  const added = (path: string, count: number) =>
    file(
      path,
      hunk(
        1,
        1,
        numbered(`${path} line`, count).map((line) => `+${line}`),
      ),
    );
  /** A file whose lines 3 and 4 were replaced by two new ones. */
  const changed = file(
    "c.ts",
    hunk(1, 1, [
      " c.ts 1",
      " c.ts 2",
      "-c.ts old 3",
      "-c.ts old 4",
      "+c.ts new 3",
      "+c.ts new 4",
      " c.ts 5",
    ]),
  );

  for (const { name, mount } of reviewSurfacesWith("place"))
    describe(name, () => {
      /**
       * A review that loads its own diff: in Changes a review of a commit
       * (its Working scope is git's, loaded and retried by the inspector).
       */
      const ownLoad =
        name === "changes"
          ? { commits: [{ sha: "c".repeat(40), subject: "One" }] }
          : {};
      test("a reload puts the cursor back on its file and line, a removed line by its old number", async () => {
        const files = [added("a.ts", 6), changed];
        const review = await mount({ files });
        await review.click({ path: "c.ts", text: "c.ts new 4" });
        await review.reload();
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          old: null,
          new: 4,
          text: "c.ts new 4",
        });
        // A removed line has only its old number: that side is restored.
        await review.click({ path: "c.ts", text: "c.ts old 3" });
        expect(review.cursorLine()).toMatchObject({ old: 3, new: null });
        await review.reload();
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          old: 3,
          new: null,
          text: "c.ts old 3",
        });
        // In another file, on an unchanged line too.
        await review.click({ path: "c.ts", text: "c.ts 5" });
        await review.reload();
        expect(review.cursorLine()).toMatchObject({
          path: "c.ts",
          old: 5,
          new: 5,
        });
        await review.unmount();
        // Opened again later in the same browser: the same place.
        const again = await mount({ files, storage: "keep" });
        expect(again.cursorLine()).toMatchObject({ path: "c.ts", new: 5 });
        await again.unmount();
      });

      test("each review keeps its own place, as each repository of a series does", async () => {
        const first = await mount({
          files: [added("a.ts", 9)],
          sessionId: "a",
        });
        await first.press("5j");
        await first.unmount();
        const second = await mount({
          files: [added("b.ts", 9)],
          sessionId: "b",
          storage: "keep",
        });
        expect(second.cursorLine()?.text).toBe("b.ts line 1");
        await second.press("2j");
        await second.unmount();
        const firstAgain = await mount({
          files: [added("a.ts", 9)],
          sessionId: "a",
          storage: "keep",
        });
        expect(firstAgain.cursorLine()?.text).toBe("a.ts line 6");
        await firstAgain.unmount();
        const secondAgain = await mount({
          files: [added("b.ts", 9)],
          sessionId: "b",
          storage: "keep",
        });
        expect(secondAgain.cursorLine()?.text).toBe("b.ts line 3");
        await secondAgain.unmount();
      });

      test("the places of the last 50 reviews are kept, older ones forgotten", async () => {
        const files = [added("a.ts", 9)];
        // 51 reviews, each left on its own line.
        for (let index = 0; index < 51; index++) {
          const review = await mount({
            files,
            sessionId: `p${index}`,
            storage: index ? "keep" : {},
          });
          await review.press(`${1 + (index % 7)}j`);
          await review.unmount();
        }
        // The first one is forgotten: it opens on its first line.
        const oldest = await mount({ files, sessionId: "p0", storage: "keep" });
        expect(oldest.cursorLine()?.text).toBe("a.ts line 1");
        await oldest.unmount();
        // The next ones kept theirs (p0 opening again pushed out p1).
        for (const index of [2, 9, 50]) {
          const kept = await mount({
            files,
            sessionId: `p${index}`,
            storage: "keep",
          });
          expect(kept.cursorLine()?.text).toBe(`a.ts line ${2 + (index % 7)}`);
          await kept.unmount();
        }
        const pushedOut = await mount({
          files,
          sessionId: "p1",
          storage: "keep",
        });
        expect(pushedOut.cursorLine()?.text).toBe("a.ts line 1");
        await pushedOut.unmount();
      });

      test("damaged place and preferences in storage read as empty, and are written anew", async () => {
        const files = [added("a.ts", 9)];
        const review = await mount({
          files,
          storage: { reviewPlace: "{not json", reviewPrefs: "[1," },
        });
        expect(review.cursorLine()?.text).toBe("a.ts line 1");
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);
        await review.press("4j");
        await review.press("S");
        await review.reload();
        expect(review.cursorLine()?.text).toBe("a.ts line 5");
        expect(review.sideBySide()).toBe(true);
        await review.unmount();
        // A place store that is not a record of reviews: empty too.
        const listed = await mount({
          files,
          storage: { reviewPlace: "[]" },
        });
        expect(listed.cursorLine()?.text).toBe("a.ts line 1");
        await listed.unmount();
      });

      test("preferences stored as JSON that is no record (null) read as empty, and are written anew", async () => {
        const files = [added("a.ts", 9)];
        const review = await mount({
          files,
          storage: { reviewPrefs: "null" },
        });
        expect(review.cursorLine()?.text).toBe("a.ts line 1");
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);
        await review.press("S");
        await review.reload();
        expect(review.sideBySide()).toBe(true);
        await review.unmount();
      });

      test("side by side, the file list hidden and Vim off are remembered across a reload", async () => {
        const files = [added("a.ts", 4)];
        const review = await mount({ files });
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);
        await review.press("S");
        await review.press("f");
        expect(review.sideBySide()).toBe(true);
        expect(review.filesShown()).toBe(false);
        await review.reload();
        expect(review.sideBySide()).toBe(true);
        expect(review.filesShown()).toBe(false);
        await review.command(":files");
        await review.command(":diff");
        await review.reload();
        expect(review.sideBySide()).toBe(false);
        expect(review.filesShown()).toBe(true);

        // Vim on (the default): Esc in a comment leaves insert mode, the
        // editor stays.
        await review.press("c");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(false);
        await review.command(":novim");
        await review.reload();
        // Vim off, remembered: one Esc closes the comment.
        await review.press("c");
        expect(review.editorOpen()).toBe(true);
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(false);
        await review.command(":set vim");
        await review.reload();
        await review.press("c");
        await review.press("<Esc>");
        expect(review.editorOpen()).toBe(true);
        await review.unmount();
      });

      test("a review put away and shown again is exactly as it was: cursor, folds, comment being written", async () => {
        const review = await mount({
          files: [added("a.ts", 9), added("b.ts", 3)],
        });
        await review.press("3j");
        // The chunk of b.ts reviewed: it folds to one line.
        await review.goToFile("b.ts");
        await review.press("r");
        expect(review.fileReviewed("b.ts")).toBe(true);
        await review.click({ path: "a.ts", text: "a.ts line 4" });
        await review.press("c");
        await review.typeInEditor("half written");
        const drawn = review.lines();
        // The reviewed file is folded away, its lines not drawn.
        expect(drawn.some((line) => line.path === "b.ts")).toBe(false);
        await review.setHidden(true);
        expect(review.hasFocus()).toBe(false);
        await review.setHidden(false);
        expect(review.editorText()).toBe("half written");
        expect(review.cursorLine()?.text).toBe("a.ts line 4");
        expect(review.fileReviewed("b.ts")).toBe(true);
        expect(review.lines()).toEqual(drawn);
        await review.unmount();
      });

      test("shown, the review takes the keys, and takes them back from a terminal for 800 ms", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        expect(review.hasFocus()).toBe(true);
        // A terminal (xterm) of the workspace arriving takes the focus.
        const terminal = document.createElement("div");
        terminal.className = "xterm";
        const input = document.createElement("textarea");
        terminal.append(input);
        document.body.append(terminal);
        const other = document.createElement("textarea");
        document.body.append(other);
        await review.setHidden(true);
        input.focus();
        expect(review.hasFocus()).toBe(false);
        jest.useFakeTimers();
        try {
          await review.setHidden(false);
          expect(review.hasFocus()).toBe(true);
          await review.advance(700);
          input.focus();
          expect(review.hasFocus()).toBe(true);
          // Anything but a terminal keeps the focus it took. In Changes the
          // review toggle holds the keys against anything for 1.5 s (until
          // a click or a key elsewhere): plan section 10's focus rule.
          const changes = name === "changes";
          other.focus();
          expect(review.hasFocus()).toBe(changes);
          await review.setHidden(true);
          await review.setHidden(false);
          expect(review.hasFocus()).toBe(true);
          // Past 800 ms (1.5 s in Changes) the terminal keeps it.
          await review.advance(changes ? 1500 : 800);
          input.focus();
          expect(review.hasFocus()).toBe(false);
        } finally {
          jest.useRealTimers();
          terminal.remove();
          other.remove();
          await review.unmount();
        }
      });

      test("a review the lost connection failed loads again once it is back, on the same commit and line", async () => {
        const review = await mount({
          files: [added("all.ts", 2)],
          commits: [
            {
              sha: "a".repeat(40),
              subject: "First",
              files: [added("a.ts", 3)],
            },
            {
              sha: "b".repeat(40),
              subject: "Second",
              files: [added("b.ts", 5)],
            },
          ],
        });
        await review.stepCommitBar(1);
        await review.click({ path: "b.ts", text: "b.ts line 4" });
        await review.setConnected(false);
        await review.command("reload");
        expect(review.status()).toContain("bridge hello is unavailable");
        expect(review.buttons()).toContain("Retry");
        const diffs = review.calls("review.diff").length;
        await review.setConnected(true);
        expect(review.calls("review.diff").length).toBeGreaterThan(diffs);
        expect(review.view()).toBe("2/2 bbbbbbbb Second");
        expect(review.cursorLine()).toMatchObject({
          path: "b.ts",
          text: "b.ts line 4",
        });
        expect(review.status()).not.toContain("bridge hello is unavailable");
        expect(review.buttons()).not.toContain("Retry");
        await review.unmount();
      });

      test("a review opened while the connection is down loads once it is back, where it was left", async () => {
        const files = [added("a.ts", 6)];
        const first = await mount({ files, ...ownLoad });
        await first.click({ path: "a.ts", text: "a.ts line 5" });
        await first.unmount();
        const review = await mount({ files, storage: "keep", ...ownLoad });
        await review.setConnected(false);
        await review.reload();
        expect(review.status()).toBe(
          "Cannot load the diff: bridge hello is unavailableRetry",
        );
        await review.setConnected(true);
        expect(review.cursorLine()).toMatchObject({
          path: "a.ts",
          text: "a.ts line 5",
        });
        expect(review.status()).toBe("");
        await review.unmount();
      });

      test("a review whose code is gone from its checkout tells the host, once; another failure does not", async () => {
        const { RpcError } = await import("../api");
        const review = await mount({ files: [added("a.ts", 3)], ...ownLoad });
        review.failBridge(
          ["review.diff", "review.commits"],
          "fatal: bad object",
        );
        await review.command("reload");
        expect(review.status()).toContain("fatal: bad object");
        expect(review.hostCalls("reviewGone")).toEqual([]);
        review.failBridge(
          ["review.diff", "review.commits"],
          new RpcError(
            "The review's base c0ffee^ is gone from this checkout",
            "base-gone",
          ),
        );
        await review.command("reload");
        expect(review.status()).toContain("is gone from this checkout");
        expect(review.hostCalls("reviewGone")).toHaveLength(1);
        expect(review.hostCalls("reviewGone")[0]!.args[0]).toBe("s1");
        review.failBridge([]);
        await review.unmount();
      });

      test("Retry loads a review that failed, and another failure is not tried again on its own", async () => {
        const files = [added("a.ts", 3)];
        const review = await mount({ files, ...ownLoad });
        await review.click({ path: "a.ts", text: "a.ts line 2" });
        review.failBridge(
          ["review.diff", "review.commits"],
          "fatal: bad object",
        );
        await review.command("reload");
        expect(review.status()).toBe(
          "Cannot load the diff: fatal: bad objectRetry",
        );
        const tries = review.calls("review.diff").length;
        // The connection going down and back does not retry it either.
        await review.setConnected(false);
        await review.setConnected(true);
        expect(review.calls("review.diff").length).toBe(tries);
        review.failBridge([]);
        await review.clickButton("Retry");
        expect(review.calls("review.diff").length).toBeGreaterThan(tries);
        expect(review.cursorLine()).toMatchObject({
          path: "a.ts",
          text: "a.ts line 2",
        });
        expect(review.buttons()).not.toContain("Retry");
        await review.unmount();
      });

      test("a load the connection fails while it is up is tried once again, not in a loop", async () => {
        const review = await mount({ files: [added("a.ts", 3)], ...ownLoad });
        review.failBridge(
          ["review.diff", "review.commits"],
          "bridge hello is unavailable",
        );
        const tries = review.calls("review.diff").length;
        await review.command("reload");
        const after = review.calls("review.diff").length;
        // The reload's own read, then a single try again.
        expect(after - tries).toBeLessThanOrEqual(4);
        await review.setConnected(true);
        expect(review.calls("review.diff").length).toBe(after);
        expect(review.buttons()).toContain("Retry");
        await review.unmount();
      });

      test("the code it opens on is read with its commits, once", async () => {
        const one = { sha: "c".repeat(40), subject: "One" };
        // The commits answer only once the test lets them.
        let answerCommits: () => void = () => {};
        const commitsAsked = new Promise<void>((resolve) => {
          answerCommits = resolve;
        });
        const review = await mount({
          files: [added("a.ts", 3)],
          commits: [one],
          answers: {
            "review.commits": async () => {
              await commitsAsked;
              return {
                commits: [
                  {
                    ...one,
                    parent: null,
                    author: "T",
                    date: "2026-11-05",
                    body: "",
                  },
                ],
              };
            },
          },
        });
        expect(review.calls("review.commits")).toHaveLength(1);
        // Read with its commits, not after them: the view it opens on (the
        // oldest commit, the server says), its files listed.
        const views = () =>
          review
            .calls("review.diff")
            .filter((call) => call.params.files === undefined)
            .map((call) => call.params);
        expect(views()).toEqual([
          { session_id: "s1", summary: true, first: true },
        ]);
        answerCommits();
        await review.press("<Esc>");
        // Its answer shows: no second read of the same view; its file's
        // patch read on its own.
        expect(views()).toHaveLength(1);
        expect(
          review
            .calls("review.diff")
            .filter((call) => call.params.files !== undefined)
            .map((call) => call.params.files),
        ).toEqual([[{ path: "a.ts", oldPath: "a.ts" }]]);
        expect(review.lines("a.ts").map((line) => line.text)).toContain(
          "a.ts line 1",
        );
        await review.press("j");
        expect(views()).toHaveLength(1);
        await review.unmount();
      });

      test("a reload stays on the commit reviewed, or on what a rebase made of it", async () => {
        const commit = (sha: string, subject: string) => ({
          sha: sha.repeat(40),
          parent: null,
          author: "T",
          date: "2026-11-05",
          subject,
          body: "",
        });
        let answer: {
          commits: ReturnType<typeof commit>[];
          patchIds?: Record<string, string>;
        } = {
          commits: [
            commit("a", "First"),
            commit("b", "Second"),
            commit("c", "Third"),
          ],
        };
        const review = await mount({
          files: [added("a.ts", 30)],
          commits: answer.commits,
          answers: { "review.commits": () => answer },
        });
        const head = () => review.commitBar()?.head ?? "";
        const follows = () =>
          review.calls("review.commits").map((call) => call.params.follow);
        const cursorText = () => review.cursorLine()?.text ?? "";
        expect(head()).toBe("1/3 aaaaaaaa");
        await review.press(">");
        expect(head()).toBe("2/3 bbbbbbbb");
        await review.click({ path: "a.ts", text: "a.ts line 12" });
        expect(cursorText()).toBe("a.ts line 12");

        // Reloaded as it is: the same commit and line. R reloads as gr does.
        const reads = follows().length;
        await review.press("R");
        expect(follows()).toHaveLength(reads + 1);
        expect(follows()[follows().length - 1]).toBe("b".repeat(40));
        expect(head()).toBe("2/3 bbbbbbbb");
        expect(cursorText()).toBe("a.ts line 12");

        // Rebased with the second commit reworded: its patch id finds it.
        answer = {
          commits: [
            commit("d", "First"),
            commit("e", "Third"),
            commit("f", "Second, reworded"),
          ],
          patchIds: {
            ["b".repeat(40)]: "1".repeat(40),
            ["d".repeat(40)]: "2".repeat(40),
            ["e".repeat(40)]: "3".repeat(40),
            ["f".repeat(40)]: "1".repeat(40),
          },
        };
        await review.press("gr");
        expect(head()).toBe("3/3 ffffffff");
        expect(cursorText()).toBe("a.ts line 12");

        // Amended (new patch id): found by its subject.
        answer = {
          commits: [
            commit("1", "First"),
            commit("2", "Second, reworded"),
            commit("3", "Third"),
          ],
        };
        await review.press("gr");
        expect(head()).toBe("2/3 22222222");

        // Gone: the nearest commit by place.
        answer = { commits: [commit("4", "Other")] };
        await review.press("gr");
        expect(head()).toBe("1/1 44444444");

        // All changes stays all changes.
        answer = { commits: [commit("4", "Other"), commit("5", "More")] };
        await review.press("gr");
        await review.press("<");
        expect(head()).toBe("All changes");
        await review.press("gr");
        expect(follows()[follows().length - 1]).toBeUndefined();
        expect(head()).toBe("All changes");
        await review.unmount();
      });
    });
}
