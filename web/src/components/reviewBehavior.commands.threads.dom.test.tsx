import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * The `:` commands of the review's threads (the unresolved ones only), at
 * the behavior level. They come with the chat threads; the review's other
 * commands are in reviewBehavior.commands.dom.test.tsx. Runs against every
 * review surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review thread commands in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
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

  for (const surface of reviewSurfacesWith("threads")) {
    const { name, mount } = surface;
    describe(name, () => {
      test(":unresolved and :openonly show only the unresolved threads, and all again", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          threads: [thread("t1", "a.ts", 2, "Why a second parser?")],
        });
        await review.command(":unresolved");
        expect(review.notice()).toBe(
          "Only the unresolved threads (gH shows them all)",
        );
        await review.command(":openonly");
        expect(review.notice()).toBe("All the threads, resolved ones folded");
        await review.unmount();
      });

      test("Tab completes :unresolved, listed with what it does", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.typeCommand("unres");
        expect(review.prompt()?.completions).toEqual([
          {
            name: "unresolved",
            description: "show only the unresolved threads, or all again (gH)",
            on: false,
          },
        ]);
        await review.unmount();
      });
    });
  }
}
