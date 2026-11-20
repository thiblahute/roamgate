import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * The choice to show only the unresolved threads (gH) is remembered in the
 * browser, across a reload. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review thread preferences in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");

  const files = [
    file(
      "a.ts",
      hunk(
        1,
        1,
        numbered("a.ts line", 8).map((line) => `+${line}`),
      ),
    ),
  ];
  const threads = [
    thread("t1", "a.ts", 2, "Still open here"),
    { ...thread("t2", "a.ts", 5, "Settled long ago"), resolved: true },
  ];

  for (const surface of reviewSurfacesWith("threads")) {
    const { name, mount } = surface;
    describe(name, () => {
      test("gH shows only the unresolved threads, remembered across a reload, and all again", async () => {
        const review = await mount({ files, threads });
        // Resolved ones start folded: their first line shows.
        expect(review.text()).toContain("Still open here");
        expect(review.text()).toContain("Settled long ago");
        await review.press("gH");
        expect(review.text()).toContain("Still open here");
        expect(review.text()).not.toContain("Settled long ago");
        await review.reload();
        expect(review.text()).toContain("Still open here");
        expect(review.text()).not.toContain("Settled long ago");
        await review.press("gH");
        expect(review.text()).toContain("Settled long ago");
        await review.reload();
        expect(review.text()).toContain("Settled long ago");
        await review.unmount();
        // Another review in the same browser follows the same choice.
        const other = await mount({ files, threads, sessionId: "s2" });
        await other.press("gH");
        await other.unmount();
        const later = await mount({
          files,
          threads,
          sessionId: "s3",
          storage: "keep",
        });
        expect(later.text()).toContain("Still open here");
        expect(later.text()).not.toContain("Settled long ago");
        await later.unmount();
      });

      test("on a phone, More hides the resolved threads, those on the whole review too, with no thread on a line to step through", async () => {
        const general = {
          ...thread("t3", "", 0, "Settled on the whole review"),
          anchor: {},
          resolved: true,
        } as (typeof threads)[number];
        const review = await mount({ files, threads: [general], phone: true });
        expect(review.text()).toContain("Settled on the whole review");
        const item = (await review.menu("more")).find(
          (each) => each.label === "Hide resolved threads",
        );
        expect(item?.checked).toBe(false);
        await review.chooseMenu("more", "Hide resolved threads");
        expect(review.text()).not.toContain("Settled on the whole review");
        expect(
          (await review.menu("more")).find(
            (each) => each.label === "Hide resolved threads",
          )?.checked,
        ).toBe(true);
        // The same choice as gH's.
        await review.press("gH");
        expect(review.text()).toContain("Settled on the whole review");
        await review.unmount();
      });
    });
  }
}
