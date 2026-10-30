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
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");

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

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
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

      test("a search with no match in this commit finds a file of another commit by its path, and goes there", async () => {
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
      });

      test("from a commit, a path found only in all the changes goes to all the changes", async () => {
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
      });
    });
}
