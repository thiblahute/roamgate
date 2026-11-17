import { describe, expect, test } from "bun:test";

/**
 * The review's search, at the behavior level: `/`, n and N, the search
 * line, the file list's marks, and where a search goes when this view has
 * no match. Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review search in an isolated DOM runtime", async () => {
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
  const { reviewSurfacesWith, testWith } = await import(
    "./reviewSurfaces.testkit"
  );

  /** A file of added lines. */
  const added = (path: string, lines: string[]) =>
    file(
      path,
      hunk(
        1,
        1,
        lines.map((line) => `+${line}`),
      ),
    );

  for (const surface of reviewSurfacesWith("search"))
    describe(surface.name, () => {
      const { mount } = surface;
      test("n and N go to the next and previous match, wrapping, counted on the search line; Esc ends the search", async () => {
        const review = await mount({
          files: [
            added("a.ts", ["const foo = 1;", "bar();", "foo();", "baz();"]),
            added("b.ts", ["return foo;"]),
          ],
        });
        const at = () => {
          const line = review.cursorLine();
          return `${line?.path}:${line?.new}`;
        };
        await review.search("foo");
        expect(at()).toBe("a.ts:1");
        expect(review.searchLine()).toBe(
          "Search foo  match 1 of 3 · n / N next / previous · Esc clears",
        );
        await review.press("n");
        expect(at()).toBe("a.ts:3");
        expect(review.searchLine()).toContain("match 2 of 3");
        await review.press("n");
        expect(at()).toBe("b.ts:1");
        expect(review.searchLine()).toContain("match 3 of 3");
        // Past the last match, back to the first.
        await review.press("n");
        expect(at()).toBe("a.ts:1");
        await review.press("N");
        expect(at()).toBe("b.ts:1");
        await review.press("N");
        expect(at()).toBe("a.ts:3");
        // Esc ends the search: no search line, n no longer searches.
        await review.press("<Esc>");
        expect(review.searchLine()).toBeNull();
        await review.press("n");
        expect(at()).toBe("a.ts:3");
        await review.unmount();
      });

      test("a search is smart-case: lower case finds any case, a capital only itself", async () => {
        const review = await mount({
          files: [added("a.ts", ["Foo here", "foo there", "FOO everywhere"])],
        });
        // The first match after the cursor: the one under it is passed.
        await review.search("foo");
        expect(review.cursorLine()?.text).toBe("foo there");
        expect(review.searchLine()).toContain("match 2 of 3");
        await review.press("<Esc>");
        await review.search("Foo");
        expect(review.searchLine()).toContain("of 1");
        expect(review.cursorLine()?.text).toBe("Foo here");
        await review.unmount();
      });

      test("a file whose path matches is a match at its first line, marked in the file list", async () => {
        const review = await mount({
          files: [
            added("a.ts", ["one", "two"]),
            added("lib/widget.ts", ["three", "four"]),
          ],
        });
        await review.search("widget");
        expect(review.cursorLine()).toMatchObject({
          path: "lib/widget.ts",
          text: "three",
        });
        expect(review.searchLine()).toContain("match 1 of 1");
        expect(review.filesMatching()).toEqual(["lib/widget.ts"]);
        await review.press("<Esc>");
        expect(review.filesMatching()).toEqual([]);
        await review.unmount();
      });

      test("a pattern found nowhere says so, and the cursor stays", async () => {
        const review = await mount({
          files: [added("a.ts", ["one", "two", "three"])],
        });
        await review.press("j");
        await review.search("nowhere");
        expect(review.searchLine()).toBe("Pattern not found: nowhere");
        expect(review.cursorLine()?.text).toBe("two");
        // n then goes on as without a search.
        await review.press("n");
        expect(review.cursorLine()?.text).toBe("two");
        await review.unmount();
      });

      test("past the last match, n says it went back to the top; past the first, N to the bottom", async () => {
        const review = await mount({
          files: [added("a.ts", ["foo one", "bar", "foo two"])],
        });
        await review.search("foo");
        expect(review.cursorLine()?.text).toBe("foo two");
        expect(review.searchLine()).toContain("match 2 of 2");
        expect(review.searchLine()).not.toContain("wrapped");
        await review.press("n");
        expect(review.cursorLine()?.text).toBe("foo one");
        expect(review.searchLine()).toContain(
          "match 1 of 2 · wrapped to the top",
        );
        expect(review.notices()).toContain(
          "Search hit the bottom, continuing at the top",
        );
        await review.press("N");
        expect(review.cursorLine()?.text).toBe("foo two");
        expect(review.searchLine()).toContain(
          "match 2 of 2 · wrapped to the bottom",
        );
        expect(review.notices()).toContain(
          "Search hit the top, continuing at the bottom",
        );
        // Not past an end: no word of a wrap.
        await review.press("N");
        expect(review.searchLine()).toContain("match 1 of 2 ·");
        expect(review.searchLine()).not.toContain("wrapped");
        await review.unmount();
      });

      test("a match in a folded reviewed chunk is counted, and n opens the chunk on it", async () => {
        const review = await mount({
          files: [
            file(
              "a.ts",
              hunk(1, 1, [" a 1", "+foo folded", " a 3"]),
              hunk(20, 20, [" a 20", "+foo open", " a 22"]),
            ),
          ],
        });
        // The first chunk reviewed: it folds to one line.
        await review.press("r");
        expect(review.lines("a.ts").map((line) => line.text)).not.toContain(
          "foo folded",
        );
        await review.press("G");
        await review.search("foo");
        // From the last line: round to the top, into the folded chunk.
        expect(review.searchLine()).toContain("match 1 of 2");
        expect(review.cursorLine()?.text).toBe("foo folded");
        expect(review.lines("a.ts").map((line) => line.text)).toContain(
          "foo folded",
        );
        await review.press("n");
        expect(review.cursorLine()?.text).toBe("foo open");
        expect(review.searchLine()).toContain("match 2 of 2");
        await review.unmount();
      });

      test("a match in a folded reviewed file is counted, and n shows the file on it", async () => {
        const review = await mount({
          files: [added("a.ts", ["a", "foo a"]), added("b.ts", ["foo b"])],
        });
        await review.press("]");
        await review.press("<A-v>");
        expect(review.fileReviewed("b.ts")).toBe(true);
        await review.press("gg");
        await review.search("foo");
        expect(review.searchLine()).toContain("match 1 of 2");
        await review.press("n");
        expect(review.cursorLine()).toMatchObject({
          path: "b.ts",
          text: "foo b",
        });
        expect(review.searchLine()).toContain("match 2 of 2");
        expect(review.lines("b.ts").map((line) => line.text)).toContain(
          "foo b",
        );
        await review.unmount();
      });

      testWith(surface, "commits")(
        "a commit's message is searched first, in the order it is drawn, then its files",
        async () => {
          const review = await mount({
            files: [added("a.ts", ["call foo();"])],
            commits: [
              {
                sha: "a".repeat(40),
                subject: "Add foo",
                body: "Every caller gets foo now.",
                files: [added("a.ts", ["call foo();"])],
              },
            ],
          });
          expect(review.view()).toBe("1/1 aaaaaaaa Add foo");
          await review.press("gg");
          await review.search("foo");
          expect(review.searchLine()).toContain("match 1 of 3");
          expect(review.cursorLine()?.text).toBe("Add foo");
          await review.press("n");
          expect(review.searchLine()).toContain("match 2 of 3");
          expect(review.cursorLine()?.text).toBe("Every caller gets foo now.");
          await review.press("n");
          expect(review.searchLine()).toContain("match 3 of 3");
          expect(review.cursorLine()).toMatchObject({
            path: "a.ts",
            text: "call foo();",
          });
          // Round to the message's subject again.
          await review.press("n");
          expect(review.cursorLine()?.text).toBe("Add foo");
          expect(review.searchLine()).toContain(
            "match 1 of 3 · wrapped to the top",
          );
          await review.unmount();
        },
      );

      test("every match drawn is marked, the cursor's one more strongly", async () => {
        const marked = new Map<string, { ranges: Range[]; priority: number }>();
        const globals = globalThis as {
          CSS?: { highlights?: unknown };
          Highlight?: unknown;
        };
        const highlight = globals.Highlight;
        const put = (key: "CSS" | "Highlight", value: unknown) =>
          Object.defineProperty(globalThis, key, {
            value,
            writable: true,
            configurable: true,
          });
        put(
          "Highlight",
          class {
            ranges: Range[];
            priority = 0;
            constructor(...ranges: Range[]) {
              this.ranges = ranges;
            }
          },
        );
        try {
          const review = await mount({
            files: [added("a.ts", ["foo and foo", "bar", "foo again"])],
          });
          // The page's highlights (the kit's CSS has none).
          put("CSS", { ...(globals.CSS ?? {}), highlights: marked });
          await review.search("foo");
          const words = (name: string) =>
            marked.get(name)?.ranges.map((range) => range.toString()) ?? [];
          expect(words("roamgate-diff-search")).toEqual(["foo", "foo", "foo"]);
          // The cursor is on the first line's second foo.
          expect(review.cursorLine()?.text).toBe("foo and foo");
          const current = marked.get("roamgate-diff-search-current");
          expect(current?.ranges).toHaveLength(1);
          expect(current?.ranges[0]?.toString()).toBe("foo");
          expect(current?.ranges[0]?.startOffset).toBe(8);
          expect(current!.priority).toBeGreaterThan(
            marked.get("roamgate-diff-search")!.priority,
          );
          await review.press("n");
          expect(review.cursorLine()?.text).toBe("foo again");
          expect(
            marked.get("roamgate-diff-search-current")?.ranges[0]?.toString(),
          ).toBe("foo");
          // Esc ends the search: nothing marked.
          await review.press("<Esc>");
          expect(marked.has("roamgate-diff-search")).toBe(false);
          expect(marked.has("roamgate-diff-search-current")).toBe(false);
          await review.unmount();
        } finally {
          put("Highlight", highlight);
        }
      });

      test("a match goes below the file's stuck header, with lines to spare, never under it", async () => {
        const foo = new Set([6, 33, 36]);
        const lines = Array.from({ length: 60 }, (_, index) =>
          foo.has(index + 1) ? `foo ${index + 1}` : `line ${index + 1}`,
        );
        const review = await mount({
          files: [added("a.ts", lines)],
          viewport: 16,
        });
        // The file's header stays stuck atop the screen, four lines tall.
        for (const head of document.querySelectorAll<HTMLElement>(
          ".diff-file-section-head",
        )) {
          head.style.position = "sticky";
          head.style.top = "0px";
          Object.defineProperty(head, "offsetHeight", {
            configurable: true,
            get: () => 4 * 20,
          });
        }
        /** The cursor's line on the screen, 0 at its top. */
        const row = () =>
          review
            .screenLines()
            .findIndex((line) => line.text === review.cursorLine()?.text);
        await review.search("foo");
        expect(review.cursorLine()?.text).toBe("foo 6");
        expect(row()).toBeGreaterThanOrEqual(4);
        // Far down: centred in what the header leaves.
        await review.press("n");
        expect(review.cursorLine()?.text).toBe("foo 33");
        expect(row()).toBe(9);
        // In sight with three lines to spare: the screen stays.
        await review.press("n");
        expect(review.cursorLine()?.text).toBe("foo 36");
        expect(row()).toBe(12);
        // zt: the line right below the header, not under it.
        await review.press("zt");
        expect(row()).toBe(4);
        // Back up to a match under the header: below it, three lines spare.
        await review.press("N");
        expect(review.cursorLine()?.text).toBe("foo 33");
        expect(row()).toBe(4 + 3);
        // Round to the top: the first match in sight below the header.
        await review.press("nn");
        expect(review.cursorLine()?.text).toBe("foo 6");
        expect(review.searchLine()).toContain("wrapped to the top");
        expect(row()).toBeGreaterThanOrEqual(4);
        await review.unmount();
      });

      testWith(surface, "commits")(
        "a search with no match in this commit finds a file of another commit by its path, and goes there",
        async () => {
          const review = await mount({
            files: [
              added("a.ts", ["first commit"]),
              added("b.ts", ["second commit"]),
            ],
            commits: [
              {
                sha: "a".repeat(40),
                subject: "First",
                files: [added("a.ts", ["first commit"])],
              },
              {
                sha: "b".repeat(40),
                subject: "Second",
                files: [added("b.ts", ["second commit"])],
              },
            ],
          });
          expect(review.view()).toBe("1/2 aaaaaaaa First");
          await review.search("b.ts");
          expect(review.view()).toBe("2/2 bbbbbbbb Second");
          expect(review.cursorLine()).toMatchObject({
            path: "b.ts",
            text: "second commit",
          });
          expect(review.notices()).toContain("b.ts: in commit 2/2");
          // Text is not looked for elsewhere, only paths.
          await review.search("first commit");
          expect(review.view()).toBe("2/2 bbbbbbbb Second");
          expect(review.searchLine()).toBe("Pattern not found: first commit");
          await review.unmount();
        },
      );

      testWith(surface, "commits")(
        "from a commit, a path found only in all the changes goes to all the changes",
        async () => {
          const review = await mount({
            files: [added("a.ts", ["one"]), added("later.ts", ["two"])],
            commits: [
              {
                sha: "a".repeat(40),
                subject: "First",
                files: [added("a.ts", ["one"])],
              },
            ],
          });
          expect(review.view()).toBe("1/1 aaaaaaaa First");
          await review.search("later");
          expect(review.view()).toBe("All changes 1 commit");
          expect(review.cursorLine()).toMatchObject({ path: "later.ts" });
          expect(review.notices()).toContain("later.ts: in all changes");
          await review.unmount();
        },
      );
    });
}
