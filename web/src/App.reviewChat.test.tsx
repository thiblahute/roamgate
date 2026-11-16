import { expect, test } from "bun:test";

/**
 * The review and an agent's chat, at the app level: closing the review in
 * Changes gives the focus back to the chat message box it was taken from
 * (App.review.testkit.tsx).
 */
if (process.env.ROAMGATE_APP_REVIEW_CHAT_TEST !== "1") {
  test("the review and the chat composer, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_REVIEW_CHAT_TEST: "1" },
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
  const { installAppReviewDom, mountAppWithReviews, reviewOf } = await import(
    "./App.review.testkit"
  );
  await installAppReviewDom();

  test("closing the review in Changes gives the focus back to the chat message box it came from", async () => {
    const app = await mountAppWithReviews({
      reviews: [reviewOf("r1", "w1")],
    });
    // An agent chat's message box, as the chat pane draws it.
    const composer = document.createElement("div");
    composer.className = "agent-history-composer";
    const box = document.createElement("textarea");
    composer.append(box);
    app.container.append(composer);
    // Laid out, as in a browser (happy-dom draws no boxes).
    box.getClientRects = () =>
      [{ x: 0, y: 0, width: 200, height: 40 }] as unknown as DOMRectList;
    const focused = () => document.activeElement === box;
    const inChanges = () =>
      document.activeElement?.closest(".workspace-inspector-slot") != null;
    try {
      box.focus();
      app.setNextOpened("r1");
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()).toMatchObject({ open: true, view: "changes" });
      expect(focused()).toBe(false);
      expect(inChanges()).toBe(true);
      await app.toggleReview();
      await app.settle(50);
      expect(app.inspector()?.open).toBe(false);
      expect(focused()).toBe(true);
      // Closed by its own close too (Esc, :q).
      await app.toggleReview();
      await app.settle(50);
      expect(focused()).toBe(false);
      await app.run(() => app.inspectorProps().onCloseReview?.("escape"));
      await app.settle(50);
      expect(focused()).toBe(true);
      // Focus last outside a chat (another control, clicked): the keys go
      // back there, not to the chat.
      const other = document.createElement("button");
      app.container.append(other);
      other.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      other.focus();
      await app.toggleReview();
      await app.settle(50);
      await app.toggleReview();
      await app.settle(50);
      expect(document.activeElement === other).toBe(true);
      expect(focused()).toBe(false);
    } finally {
      composer.remove();
      await app.unmount();
    }
  });
}
