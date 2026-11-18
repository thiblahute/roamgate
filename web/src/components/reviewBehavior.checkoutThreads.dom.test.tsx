import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * A checkout's one review: the threads of every review of its code (its
 * working tree, its branch against any base, an agent's range) shown
 * together in Changes, whatever scope is shown, each where it is found and
 * listed with where it was written when not. Runs against every review
 * surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "review checkout threads in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    60_000,
  )
) {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { reviewSurfacesWith } = await import("./reviewSurfaces.testkit");
  type ReviewThread = import("../../../shared/review").ReviewThread;

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
  /** A thread of a review, its anchor's fields over the kit's. */
  const of = (
    sessionId: string,
    id: string,
    path: string,
    line: number,
    body: string,
    anchor: Record<string, unknown> = {},
  ): ReviewThread => {
    const base = thread(id, path, line, body);
    return {
      ...base,
      sessionId,
      anchor: { ...base.anchor, ...anchor },
    } as ReviewThread;
  };
  const review = (id: string, target: Record<string, unknown>) => ({
    id,
    root: "/repo",
    title: id,
    target,
    gitlab: false,
    summary: "",
    agent: { name: "Claude", paneId: "w1:p1" },
    createdAt: "2026-11-18T20:00:00Z",
    updatedAt: "2026-11-18T20:00:00Z",
  });

  for (const surface of reviewSurfacesWith("threads-panel")) {
    const { name, mount } = surface;
    describe(name, () => {
      test("the threads of the checkout's other code reviews are listed and drawn here, a compare's not", async () => {
        const shown = await mount({
          files: [added("a.ts", 6)],
          otherReviews: [
            // An agent's range of the branch, the branch against a base
            // Automatic once took, and a compare of two versions.
            review("agents", { kind: "range", base: "main", head: "topic" }),
            review("branch", {
              kind: "range",
              base: "origin/entire/checkpoints/v1",
              head: "HEAD",
            }),
            review("compare", {
              kind: "range",
              base: "topic-before",
              head: "topic",
              compare: true,
            }),
          ],
          shared: [
            // On a file this view does not change: under Other files.
            of("agents", "naming", "NAMING.md", 1, "Belongs in a design doc"),
            // Written by the agent, on a line here (no note of a view).
            of("branch", "logging", "a.ts", 3, "Logging?", {
              commit: "acd7920f82",
              commitSubject: "gst-c: futures",
              text: "a.ts line 3",
            }),
            of("compare", "compared", "OTHER.md", 1, "Between versions"),
            // On a commit, on a file this view does not change.
            of("branch", "oncommit", "play.c", 144, "On the commit", {
              commit: "acd7920f82",
              commitSubject: "gst-c: futures",
              text: "die (",
            }),
            // Its commit rewritten and its line not found again.
            of("branch", "stale", "a.ts", 5, "Was here", {
              commit: "f00d",
              text: "a line no longer here",
              outdated: true,
            }),
          ],
        });
        await shown.press("T");
        const panel = shown.threadsPanel();
        expect(panel?.ids).toContain("naming");
        expect(panel?.ids).toContain("logging");
        expect(panel?.ids).toContain("oncommit");
        expect(panel?.ids).not.toContain("compared");
        // Listed where it was written, said outdated.
        expect(panel?.ids).toContain("stale");
        expect(panel?.text).toContain("a.ts:5 (outdated)");
        // Counted on the chip as open threads.
        expect(shown.threadsChip()).toContain("4");
        await shown.unmount();
      });

      test("with no change in the working tree, the other reviews' threads are under Other files", async () => {
        const shown = await mount({
          files: [],
          // The inspector names the checkout: no file says it.
          session: { root: "/repo" },
          otherReviews: [
            review("branch", { kind: "range", base: "main", head: "HEAD" }),
          ],
          shared: [
            of("branch", "oncommit", "play.c", 144, "On the commit", {
              commit: "acd7920f82",
              text: "die (",
            }),
          ],
          threads: [of("s1", "naming", "NAMING.md", 1, "In Files")],
        });
        expect(shown.threadsChip()).toContain("2");
        await shown.clickThreadsChip();
        expect(shown.threadsPanel()?.ids.sort()).toEqual([
          "naming",
          "oncommit",
        ]);
        await shown.unmount();
      });
    });
  }
}
