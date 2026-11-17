import { inIsolatedChild } from "../testIsolated";
import { describe, expect } from "bun:test";

/**
 * The review's keys and the app's (reviewKeys.ts): the app's shortcuts that
 * work over the review (the review toggle, the overlay tab) and those
 * leaving for another workspace, tab or pane reach the app; the review
 * keeps its own. reviewKeys.test.ts holds the routing itself. Changes'
 * cursor leaves such keys to the app (this test).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the review's keys and the app's, in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    120_000,
  )
) {
  const { installReviewDom, file, hunk, numbered } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { ALL_REVIEW_SURFACES, testWith } = await import(
    "./reviewSurfaces.testkit"
  );
  const { updateShortcut } = await import("../shortcutPreferences");

  const files = [
    file(
      "a.ts",
      hunk(
        1,
        1,
        numbered("a.ts line", 40).map((line) => `+${line}`),
      ),
    ),
  ];

  for (const surface of ALL_REVIEW_SURFACES)
    describe(surface.name, () => {
      testWith(surface, "cursor")(
        "the app's shortcuts over the review and those leaving it are the app's; the review keeps its own",
        async () => {
          // Bound as a Mac binds the pane switcher: Ctrl+K, which is also
          // the cursor's half page up.
          updateShortcut("panes.search", ["Ctrl+K"]);
          const review = await surface.mount({ files });
          try {
            await review.press("5j");
            expect(review.cursorLine()?.text).toBe("a.ts line 6");
            // Leaving for another pane: the app's, the cursor stays.
            expect(await review.keyTaken("<C-k>")).toBe(false);
            expect(review.cursorLine()?.text).toBe("a.ts line 6");
            // The review toggle and the overlay tab work over it.
            expect(await review.keyTaken("<C-A-r>")).toBe(false);
            expect(await review.keyTaken("<A-f>")).toBe(false);
            expect(review.cursorLine()?.text).toBe("a.ts line 6");
            // Its own keys stay its own.
            expect(await review.keyTaken("j")).toBe(true);
            expect(review.cursorLine()?.text).toBe("a.ts line 7");
          } finally {
            updateShortcut("panes.search", ["Alt+K"]);
            await review.unmount();
          }
        },
      );
    });
}
