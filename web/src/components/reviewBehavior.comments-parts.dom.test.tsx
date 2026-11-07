import { describe, expect, test } from "bun:test";

/**
 * Commenting on a part of a message in the review (its margin +), at the
 * behavior level. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review comments on message parts in an isolated DOM runtime", async () => {
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

  const code = () =>
    file("a.ts", hunk(1, 1, [" one", "-two", "+deux", "+trois", " four"]));

  /** A thread with one message, by you unless said. */
  const mine = (
    id: string,
    anchor: Record<string, unknown>,
    body: string,
    options: {
      kind?: "draft" | "discussion";
      author?: string;
      updatedAt?: string;
    } = {},
  ) =>
    ({
      id,
      sessionId: "s1",
      kind: options.kind ?? "draft",
      anchor,
      comments: [
        {
          id: `${id}c`,
          author: options.author ?? "you",
          body,
          createdAt: "2026-11-04T14:11:18Z",
          updatedAt: options.updatedAt ?? "2026-11-04T14:11:18Z",
        },
      ],
      resolved: false,
      createdAt: "2026-11-04T14:11:18Z",
      updatedAt: options.updatedAt ?? "2026-11-04T14:11:18Z",
    }) as unknown as import("../../../shared/review").ReviewThread;

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("+ in the margin of a message's part comments on that part", async () => {
        const review = await mount({
          files: [code()],
          threads: [
            mine(
              "t1",
              { path: "a.ts", line: 2, side: "new" },
              "First point.\n\nSecond point.",
              { author: "Claude", kind: "discussion" },
            ),
          ],
        });
        await review.commentOnPart("Second point.");
        expect(review.editorText()).toBe("");
        await review.type("Agreed");
        await review.editorPress("<C-Enter>");
        expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
          kind: "discussion",
          anchor: {
            path: "a.ts",
            message: { thread: "t1", comment: "t1c", quote: "Second point." },
          },
          text: "Agreed",
        });
        await review.unmount();
      });
    });
}
