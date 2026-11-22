import { expect, spyOn, test } from "bun:test";
import { inIsolatedChild } from "./testIsolated";

/**
 * The board is two of the workspace inspector's tabs, at the app level:
 * Alt+W opens the focused workspace's inspector on Work, Alt+M on Reviews,
 * either again on its own tab closes it; a notification's item link opens
 * Work on that item; the board stepping aside hides the inspector.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the board's inspector tabs, at the app level, in an isolated DOM runtime",
    "ROAMGATE_APP_BOARD_TABS_TEST",
    30_000,
  )
) {
  const { installAppReviewDom, mountAppWithReviews } = await import(
    "./App.review.testkit"
  );
  await installAppReviewDom("http://localhost/");
  const React = await import("react");
  const { bridge } = await import("./api");
  spyOn(bridge, "call").mockImplementation(async (method: string) =>
    method === "bridge.work.board" ? { projects: [], items: [] } : {},
  );
  spyOn(bridge, "onWork").mockImplementation(() => () => {});
  spyOn(bridge, "onStatus").mockImplementation(() => () => {});
  const { openWork } = await import("./workOpen");
  const { pendingBoardOpen } = await import("./mrReviewsOpen");

  test("Alt+W and Alt+M open the inspector on Work and Reviews, switch between them and close it; an item link opens Work on it", async () => {
    const app = await mountAppWithReviews({ reviews: [] });
    try {
      await app.settle(50);
      const alt = (key: string) =>
        app.key({ key, code: `Key${key.toUpperCase()}`, altKey: true });
      await alt("w");
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "work" });
      expect(app.inspector()?.scope.workspaceId).toBe("w1");
      // The other tab's shortcut switches; its own closes.
      await alt("m");
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "reviews" });
      await alt("m");
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
      // A notification's link: Work, the item kept for the board to take.
      await React.act(async () => openWork("1234567890abcdef"));
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "work" });
      expect(pendingBoardOpen()?.item).toBe("1234567890abcdef");
      // A tab the inspector shows is remembered for the workspace: Alt+W
      // again closes it, the inspector's toggle brings Work back.
      await alt("w");
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
      await alt("w");
      await app.settle(50);
      // The board stepping aside (a session opened over the window).
      await React.act(async () => app.inspectorProps().onStepAside?.());
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
    } finally {
      await app.unmount();
    }
  });
}
