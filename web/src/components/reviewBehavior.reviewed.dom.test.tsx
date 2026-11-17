import { describe, expect, test } from "bun:test";

/**
 * Reviewed chunks and files, at the behavior level: keys in, what is folded,
 * ticked and remembered out. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review reviewed chunks in an isolated DOM runtime", async () => {
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
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

  /** a.ts: two chunks; b.ts and c.ts: one each. */
  const files = () => [
    file(
      "a.ts",
      hunk(1, 1, [" a 1", "+a 2", "+a 3", " a 4"]),
      hunk(20, 22, [" a 22", "-a 23", "+a twenty-three", " a 24"]),
    ),
    file("b.ts", hunk(1, 1, ["+b 1", "+b 2"])),
    file("c.ts", hunk(1, 1, ["+c 1"])),
  ];
  const texts = (review: { lines(path?: string): { text: string }[] }) =>
    review.lines().map((line) => line.text);

  for (const { name, mount } of reviewSurfacesWith("reviewed"))
    describe(name, () => {
      test("v marks the file under the cursor reviewed, every chunk folded with it; v again unmarks it", async () => {
        const review = await mount({ files: files() });
        expect(review.fileReviewed("a.ts")).toBe(false);
        await review.press("v");
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(review.reviewedMarks()["all:a.ts"]).toBeTruthy();
        // The file's mark and its two chunks'.
        expect(Object.keys(review.reviewedMarks())).toHaveLength(3);
        expect(review.notices()).toContain("Reviewed (1/3)");
        expect(texts(review)).not.toContain("a 2");
        expect(texts(review)).not.toContain("a twenty-three");
        expect(review.text()).toContain("✓ reviewed");
        // The cursor goes on to what is left to review.
        expect(review.cursorLine()?.path).toBe("b.ts");
        // Folded whole: gg goes to the first line left to review.
        await review.press("gg");
        expect(review.cursorLine()?.path).toBe("b.ts");
        // Picked in the file list, it shows, still reviewed, and v
        // unmarks it.
        await review.goToFile("a.ts");
        expect(review.cursorLine()?.path).toBe("a.ts");
        expect(review.text()).not.toContain("✓ reviewed");
        expect(review.chunkMarkers("a.ts").length).toBeGreaterThan(0);
        expect(review.chunkMarkers("a.ts").every((m) => m.reviewed)).toBe(true);
        // The same pick drawn again (no new pick) leaves the cursor be.
        await review.press("j");
        const at = review.cursorLine();
        await review.push({});
        expect(review.cursorLine()).toEqual(at);
        await review.press("v");
        expect(review.fileReviewed("a.ts")).toBe(false);
        expect(review.reviewedMarks()["all:a.ts"]).toBe("");
        expect(review.notices()).toContain(
          "No longer reviewed, nor its chunks",
        );
        // Unmarked (kept as ""), none reviewed.
        expect(
          Object.values(review.reviewedMarks()).every((value) => value === ""),
        ).toBe(true);
        expect(texts(review)).toContain("a 2");
        await review.unmount();
      });

      test("V then r marks every chunk the selection touches reviewed", async () => {
        const review = await mount({ files: files() });
        // From the first chunk of a.ts to its second.
        await review.press("jV}j");
        expect(review.selection().map((line) => line.text)).toEqual([
          "a 2",
          "a 3",
          "a 4",
          "a 22",
          "a 23",
        ]);
        await review.press("r");
        expect(review.selection()).toEqual([]);
        // Both chunks: the file is reviewed.
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(texts(review)).not.toContain("a 2");
        expect(texts(review)).not.toContain("a twenty-three");
        expect(review.fileReviewed("b.ts")).toBe(false);
        await review.unmount();
      });

      test("V then r on part of a file marks its chunk, and the list counts it", async () => {
        const review = await mount({ files: files() });
        await review.press("jVj");
        await review.press("r");
        expect(review.fileReviewed("a.ts")).toBe(false);
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(texts(review)).not.toContain("a 3");
        expect(texts(review)).toContain("a twenty-three");
        await review.unmount();
      });

      test("a reviewed chunk shows again on a click or za, and za folds it back", async () => {
        const review = await mount({ files: files() });
        await review.press("r");
        const folded = () =>
          review.lines("a.ts").filter((line) => line.kind === "reviewed");
        expect(folded()).toHaveLength(1);
        expect(texts(review)).not.toContain("a 3");
        // The cursor went on to the next chunk; back on the folded one.
        await review.press("gg");
        expect(review.cursorLine()?.kind).toBe("reviewed");
        await review.press("za");
        expect(texts(review)).toContain("a 3");
        expect(folded()).toHaveLength(0);
        // Still reviewed: shown, not unmarked.
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        await review.press("za");
        expect(texts(review)).not.toContain("a 3");
        await review.click({ path: "a.ts", kind: "reviewed" });
        expect(texts(review)).toContain("a 3");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        await review.unmount();
      });

      test("a chunk with comments stays open when reviewed", async () => {
        const review = await mount({
          files: files(),
          threads: [thread("t1", "a.ts", 3, "Why a 3?")],
        });
        expect(review.text()).toContain("Why a 3?");
        // r on a line with a thread resolves it: mark from the chunk's
        // first line.
        await review.press("j");
        expect(review.cursorLine()?.text).toBe("a 2");
        await review.press("r");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(texts(review)).toContain("a 2");
        expect(texts(review)).toContain("a 3");
        expect(review.text()).toContain("Why a 3?");
        expect(
          review.lines("a.ts").filter((line) => line.kind === "reviewed"),
        ).toHaveLength(0);
        await review.unmount();
      });

      test("reviewed chunks and files are ticked and counted in the file list", async () => {
        const review = await mount({ files: files() });
        expect(review.chunkProgress("a.ts")).toBeNull();
        expect(review.text()).toContain("0/3 reviewed");
        await review.press("r");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(review.fileReviewed("a.ts")).toBe(false);
        await review.press("r");
        // Whole: ticked, no count.
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(review.chunkProgress("a.ts")).toBeNull();
        expect(review.text()).toContain("1/3 reviewed");
        await review.press("<A-v>");
        expect(review.fileReviewed("b.ts")).toBe(true);
        expect(review.text()).toContain("2/3 reviewed");
        await review.unmount();
      });

      test("reviewed marks are kept across a reload", async () => {
        const review = await mount({ files: files() });
        await review.press("r");
        await review.press("]]v");
        expect(review.fileReviewed("c.ts")).toBe(true);
        const marks = review.reviewedMarks();
        await review.reload();
        expect(review.reviewedMarks()).toEqual(marks);
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(review.fileReviewed("c.ts")).toBe(true);
        expect(texts(review)).not.toContain("a 3");
        expect(texts(review)).not.toContain("c 1");
        // A new review opened with those marks shows the same.
        await review.unmount();
        const again = await mount({ files: files(), reviewed: marks });
        expect(again.chunkProgress("a.ts")).toBe("1/2");
        expect(again.fileReviewed("c.ts")).toBe(true);
        expect(texts(again)).not.toContain("a 3");
        await again.unmount();
      });

      test("r marks the chunk under the cursor reviewed, folded to a line; Option+V the file", async () => {
        const numberedAdded = (path: string, from: number, count: number) =>
          numbered(`${path} line`, count, from).map((line) => `+${line}`);
        const review = await mount({
          files: [
            file(
              "a.ts",
              hunk(1, 1, numberedAdded("a.ts", 1, 3)),
              hunk(10, 20, numberedAdded("a.ts", 20, 3)),
            ),
            file("b.ts", hunk(1, 1, numberedAdded("b.ts", 1, 2))),
          ],
        });
        const cursorText = () => review.cursorLine()?.text ?? "";
        const updates = () => review.calls("review.update").length;

        expect(cursorText()).toBe("a.ts line 1");
        await review.press("r");
        const written = Object.keys(review.reviewedMarks());
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/^all:a\.ts\nh3\./);
        // Folded to one line; the cursor on the next chunk; 1/2 in the list.
        expect(texts(review)).not.toContain("a.ts line 3");
        const folded = review
          .lines("a.ts")
          .filter((line) => line.kind === "reviewed");
        expect(folded).toHaveLength(1);
        expect(folded[0]?.text).toBe("\u2713 reviewed: 3 lines, za shows them");
        expect(cursorText()).toBe("a.ts line 20");
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        expect(review.notices()).toContain("Chunk reviewed (1/2 in the file)");
        // The margin marks the chunk's lines reviewed, the next chunk's not.
        expect(review.chunkMarkers("a.ts")).toContainEqual({
          line: 1,
          stage: "unstaged",
          reviewed: true,
        });
        expect(review.chunkMarkers("a.ts")).toContainEqual({
          line: 20,
          stage: "unstaged",
          reviewed: false,
        });
        // k comes back onto the folded line only; j from it goes past it.
        await review.press("k");
        expect(review.cursorLine()?.kind).toBe("reviewed");
        await review.press("j");
        expect(cursorText()).toBe("a.ts line 20");

        // A click on it shows it again, za folds it back.
        await review.click({ path: "a.ts", kind: "reviewed" });
        expect(texts(review)).toContain("a.ts line 3");
        await review.press("za");
        expect(texts(review)).not.toContain("a.ts line 3");
        // r on it unmarks it; r again marks it and goes on.
        await review.press("r");
        expect(texts(review)).toContain("a.ts line 3");
        expect(Object.values(review.reviewedMarks())).toEqual([""]);
        expect(review.chunkProgress("a.ts")).toBeNull();
        await review.press("r");
        expect(cursorText()).toBe("a.ts line 20");

        // gU goes back over the reviewed one: b.ts is the previous not reviewed.
        await review.press("gU");
        expect(cursorText()).toBe("b.ts line 1");
        await review.press("gu");
        expect(cursorText()).toBe("a.ts line 20");

        // The second chunk: the file is reviewed, folded, ticked.
        await review.press("r");
        expect(texts(review)).not.toContain("a.ts line 20");
        expect(review.fileReviewed("a.ts")).toBe(true);
        expect(Object.values(review.reviewedMarks())).toContain("1");
        expect(Object.keys(review.reviewedMarks())).toContain("all:a.ts");

        // Shown again, the reviewed file shows its chunks.
        expect(review.fileFolded("a.ts")).toBe(true);
        await review.clickFileHeader("a.ts", "Show");
        expect(texts(review)).toContain("a.ts line 3");

        // Option+V on b.ts marks it whole: a Mac types "\u221a", its code is KeyV.
        await review.goToFile("b.ts");
        expect(cursorText()).toBe("b.ts line 1");
        expect(await review.keyTaken("<A-v>")).toBe(true);
        expect(review.reviewedMarks()["all:b.ts"]).toBeTruthy();
        expect(texts(review)).not.toContain("b.ts line 1");
        // Shown again from the file list, Option+V on it unmarks it.
        await review.goToFile("b.ts");
        expect(cursorText()).toBe("b.ts line 1");
        await review.press("<A-v>");
        expect(review.reviewedMarks()["all:b.ts"]).toBe("");
        expect(texts(review)).toContain("b.ts line 1");

        // In a comment it types, and the file stays as it is.
        await review.goToFile("b.ts");
        await review.press("c");
        expect(review.editorOpen()).toBe(true);
        const before = updates();
        expect(await review.keyTaken("<A-v>")).toBe(false);
        expect(updates()).toBe(before);
        expect(texts(review)).toContain("b.ts line 1");
        await review.unmount();
      });

      test("gu and gU jump to the next and previous chunk not reviewed, wrapping", async () => {
        const review = await mount({ files: files() });
        const at = () => review.cursorLine()?.text;
        expect(at()).toBe("a 1");
        await review.press("gu");
        expect(at()).toBe("a 22");
        await review.press("gu");
        expect(at()).toBe("b 1");
        await review.press("gu");
        expect(at()).toBe("c 1");
        await review.press("gu");
        expect(at()).toBe("a 1");
        await review.press("gU");
        expect(at()).toBe("c 1");
        await review.unmount();
      });

      test("with no review yet, the first mark opens the checkout's review", async () => {
        const review = await mount({ files: files(), unopened: true });
        await review.press("r");
        expect(
          review
            .calls()
            .map((call) => call.method)
            .filter((method) => /^review\.(open|update)$/.test(method)),
        ).toEqual(["review.open", "review.update"]);
        expect(review.calls("review.open")[0]?.params).toMatchObject({
          workspace_id: "workspace",
          path: "/repo",
          target: { kind: "worktree" },
        });
        expect(review.chunkProgress("a.ts")).toBe("1/2");
        await review.unmount();
      });

      test("a staged entry's chunks carry the staged marker, the working tree's theirs", async () => {
        const review = await mount({
          stagedFiles: [file("a.ts", hunk(1, 1, [" one", "-two", "+deux"]))],
          files: [file("a.ts", hunk(20, 20, [" x", "-y", "+z", " w"]))],
        });
        const staged = review.chunkMarkers("a.ts", "staged");
        expect(staged.length).toBeGreaterThan(0);
        expect(staged.every((m) => m.stage === "staged")).toBe(true);
        const unstaged = review.chunkMarkers("a.ts");
        expect(unstaged.length).toBeGreaterThan(0);
        expect(unstaged.every((m) => m.stage === "unstaged")).toBe(true);
        await review.unmount();
      });

      test("a combined diff's chunks carry staged, unstaged or partly staged, as the index holds them", async () => {
        const review = await mount({
          changes: "combined",
          files: [
            file(
              "a.ts",
              hunk(1, 1, [" one", "-two", "+deux", " three"]),
              hunk(20, 20, [" x", "-y", "+z", "+zz", " w"]),
              hunk(40, 41, [" k", "-l", "+m", " n"]),
            ),
            file("b.ts", hunk(1, 1, [" p", "-q", "+r"])),
          ],
          // The first chunk all in the index, the second its removal and
          // one of its two lines, the third none of it; b.ts none.
          staged: {
            "a.ts": {
              old: [
                [2, 2],
                [21, 21],
              ],
              new: [
                [2, 2],
                [21, 21],
              ],
            },
          },
        });
        const a = review.chunkMarkers("a.ts");
        const stageOf = (line: number) => [
          ...new Set(a.filter((m) => m.line === line).map((m) => m.stage)),
        ];
        expect(stageOf(2)).toEqual(["staged"]);
        expect(stageOf(21)).toContain("partly");
        expect(stageOf(22)).toContain("partly");
        expect(stageOf(42)).toContain("unstaged");
        const b = review.chunkMarkers("b.ts");
        expect(b.length).toBeGreaterThan(0);
        expect(b.every((m) => m.stage === "unstaged")).toBe(true);
        await review.unmount();
      });

      test("a combined chunk keeps its reviewed mark when it is staged: its id is the same", async () => {
        const review = await mount({
          changes: "combined",
          files: [file("b.ts", hunk(1, 1, [" p", "-q", "+r"]))],
        });
        await review.press("r");
        expect(review.chunkMarkers("b.ts")).toContainEqual({
          line: 2,
          stage: "unstaged",
          reviewed: true,
        });
        // Staged: the same combined diff, the index now holds its lines.
        await review.setStaged({ "b.ts": { old: [[2, 2]], new: [[2, 2]] } });
        expect(review.chunkMarkers("b.ts")).toContainEqual({
          line: 2,
          stage: "staged",
          reviewed: true,
        });
        await review.unmount();
      });
    });
}
