import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/**
 * The checkout's git actions from the review (:stage, gs, :discard): they
 * act on the inspector's checkout, so a review of another repository (a
 * series repository, a merge request's review worktree, one from
 * elsewhere) refuses them, saying why (plan: review into the inspector,
 * section 2, phase 7). Runs against the surfaces with git actions
 * (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "git actions from the review in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom, file, hunk, numbered } = await import(
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
        numbered("a.ts line", 3).map((line) => `+${line}`),
      ),
    ),
  ];
  const refusal =
    "Not on this review: it is of other, not this checkout; stage and discard act on the checkout's files.";

  for (const surface of reviewSurfacesWith("git-actions"))
    test(`${surface.name} > the checkout's own review stages the file at the cursor; another repository's refuses :stage, gs and :discard, saying why`, async () => {
      const own = await surface.mount({ files });
      await own.press("j");
      await own.command(":stage");
      expect(own.hostCalls("gitAction")).toEqual([
        { name: "gitAction", args: ["stage", "a.ts"] },
      ]);
      // gs too; s alone is not staging (it starts a suggestion).
      await own.press("gs");
      expect(own.hostCalls("gitAction")).toHaveLength(2);
      expect(own.hostCalls("gitAction")[1]?.args).toEqual(["stage", "a.ts"]);
      await own.press("s");
      expect(own.hostCalls("gitAction")).toHaveLength(2);
      await own.unmount();

      const url = "https://gitlab.example/group/project/-/merge_requests/7";
      const other = await surface.mount({
        files,
        session: {
          root: "/other",
          target: { kind: "mr", url },
          gitlab: true,
        },
        mergeRequest: {
          url,
          title: "Fix",
          state: "opened",
          headSha: "h",
          security: false,
        },
      });
      await other.press("j");
      await other.command(":stage");
      await other.command(":discard");
      await other.press("gs");
      expect(other.hostCalls("gitAction")).toEqual([]);
      expect(
        other.notices().filter((notice) => notice === refusal),
      ).toHaveLength(3);
      await other.unmount();
    });
}
