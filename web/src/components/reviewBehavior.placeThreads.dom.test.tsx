import { describe, expect, test } from "bun:test";

/**
 * The choice to show only the unresolved threads (gH) is remembered in the
 * browser, across a reload. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review thread preferences in an isolated DOM runtime", async () => {
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
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");

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

  for (const { name, mount } of REVIEW_SURFACES)
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
    });
}
