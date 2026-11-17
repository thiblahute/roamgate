import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * A rendered file's header in the review, at the behavior level: Rendered
 * opens it as the Files preview renders it. Runs against every review
 * surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review's Rendered button in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    30_000,
  )
) {
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

  for (const { name, mount } of reviewSurfacesWith("open-files"))
    describe(name, () => {
      test("Open and Rendered on a file's header open it in the Files preview, at the cursor line when it is in that file", async () => {
        const review = await mount({
          files: [added("a.ts", 4), added("doc.md", 4)],
          openFiles: true,
        });
        expect(review.fileButtons("a.ts")).toEqual(["Open"]);
        expect(review.fileButtons("doc.md")).toEqual(["Open", "Rendered"]);
        await review.press("j");
        await review.clickFileHeader("a.ts", "Open");
        await review.clickFileHeader("doc.md", "Open");
        await review.clickFileHeader("doc.md", "Rendered");
        await review.goToFile("doc.md");
        await review.press("2j");
        await review.clickFileHeader("doc.md", "Rendered");
        expect(review.openedFiles()).toEqual([
          { path: "/repo/a.ts", line: 2 },
          { path: "/repo/doc.md" },
          { path: "/repo/doc.md", rendered: true },
          { path: "/repo/doc.md", line: 3, rendered: true },
        ]);
        await review.unmount();
      });
    });
}
