import { inIsolatedChild } from "../testIsolated";
import { describe, expect } from "bun:test";
import type { ReviewThread } from "../../../shared/review";

/**
 * Comments written in a merge request's review shown in Changes, at the
 * behavior level: they are written in that review (never in a review of
 * the checkout opened for them), a question for the agent bound to it by
 * default, `C` for the forge's draft; a draft the agent answered shows the
 * answer. Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "comments in a merge request's review in an isolated DOM runtime",
    "ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom, file, hunk, numbered } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { ALL_REVIEW_SURFACES, testWith } = await import(
    "./reviewSurfaces.testkit"
  );

  const MR_URL = "https://gitlab.example/group/project/-/merge_requests/4";
  /** A merge request's review on GitLab, its agent bound to it. */
  const requestReview = (agent = true) => ({
    session: {
      target: { kind: "mr" as const, url: MR_URL },
      gitlab: true,
      title: "uridecodepool",
      ...(agent ? { agent: { name: "Claude", paneId: "w29:p1" } } : {}),
    },
    mergeRequest: {
      url: MR_URL,
      title: "uridecodepool",
      state: "opened",
      headSha: "h",
      security: false,
    },
  });
  const files = [
    file(
      "a.ts",
      hunk(
        1,
        1,
        numbered("a.ts line", 4).map((line) => `+${line}`),
      ),
    ),
  ];
  const at = "2026-11-19T12:19:55Z";

  for (const surface of ALL_REVIEW_SURFACES) {
    const { name, mount } = surface;
    describe(name, () => {
      testWith(surface, "forge")(
        "a comment in a merge request's review is written in it, a question for its agent; C writes the forge's draft",
        async () => {
          const review = await mount({ files, ...requestReview() });
          await review.click({ path: "a.ts", new: 2 });
          await review.press("c");
          await review.type("Is a new decoder that expensive?");
          await review.editorButton("Save");
          // In the review shown: read, not a review of the checkout opened
          // for it (the branch against a base picked in Changes).
          expect(review.calls("review.open")).toEqual([]);
          const [asked] = review.calls("review.thread.add");
          expect(asked?.params).toMatchObject({
            session_id: "s1",
            kind: "discussion",
            text: "Is a new decoder that expensive?",
            anchor: { path: "a.ts", line: 2 },
          });
          expect(
            JSON.parse(
              String(
                asked?.params.anchor &&
                  (asked.params.anchor as { feedback: string }).feedback,
              ),
            ),
          ).toMatchObject({ review: "s1" });
          // C: your draft for GitLab instead.
          await review.click({ path: "a.ts", new: 3 });
          await review.press("C");
          await review.type("Typo in the subject");
          await review.editorButton("Save");
          expect(review.calls("review.open")).toEqual([]);
          expect(review.calls("review.thread.add")[1]?.params).toMatchObject({
            session_id: "s1",
            kind: "draft",
            text: "Typo in the subject",
          });
          await review.unmount();
        },
      );

      testWith(surface, "forge")(
        "with no agent bound to the merge request's review, c writes the forge's draft as before",
        async () => {
          const review = await mount({ files, ...requestReview(false) });
          await review.click({ path: "a.ts", new: 2 });
          await review.press("c");
          await review.type("Typo in the subject");
          await review.editorButton("Save");
          expect(review.calls("review.open")).toEqual([]);
          expect(review.calls("review.thread.add")[0]?.params).toMatchObject({
            session_id: "s1",
            kind: "draft",
          });
          await review.unmount();
        },
      );

      testWith(surface, "forge")(
        "a draft the agent answered shows the answer under it",
        async () => {
          const draft = {
            id: "d1",
            sessionId: "s1",
            kind: "draft",
            anchor: {
              path: "a.ts",
              line: 2,
              side: "new",
              text: "a.ts line 2",
              // Written in Changes: the note it was written from.
              feedback: JSON.stringify({
                source: "diff",
                path: "a.ts",
                kind: "branch",
                side: "new",
                line: 2,
                quote: "a.ts line 2",
                hunk: "",
                review: "s1",
              }),
            },
            comments: [
              {
                id: "d1a",
                author: "you",
                body: "Did Luke write a decoder pool?",
                createdAt: at,
                updatedAt: at,
              },
              {
                id: "d1b",
                author: "Claude",
                body: "Yes: an NVDEC decoder pool in nvcodec.",
                createdAt: at,
                updatedAt: at,
              },
            ],
            resolved: false,
            createdAt: at,
            updatedAt: at,
          } as unknown as ReviewThread;
          const review = await mount({
            files,
            ...requestReview(),
            threads: [draft],
          });
          const [shown] = review
            .shownThreads()
            .filter((each) => each.id === "d1");
          expect(shown?.messages.map((message) => message.text)).toEqual([
            expect.stringContaining("Did Luke write a decoder pool?"),
            expect.stringContaining("Yes: an NVDEC decoder pool in nvcodec."),
          ]);
          await review.unmount();
        },
      );

      testWith(surface, "forge")(
        "a draft on a commit's message the agent answered shows the answer under it, on that commit",
        async () => {
          const a = file("a.ts", hunk(1, 1, ["+a"]));
          const b = file("b.ts", hunk(1, 1, ["+b"]));
          const second = "b".repeat(40);
          const draft = {
            id: "d1",
            sessionId: "s1",
            kind: "draft",
            anchor: {
              path: ":commit-message",
              line: 1,
              side: "new",
              text: "Second",
              commit: second,
              commitSubject: "Second",
              commitParent: "a".repeat(40),
            },
            comments: [
              {
                id: "d1a",
                author: "you",
                body: "Did Luke write a decoder pool?",
                createdAt: at,
                updatedAt: at,
              },
              {
                id: "d1b",
                author: "Claude",
                body: "Yes: an NVDEC decoder pool in nvcodec.",
                createdAt: at,
                updatedAt: at,
              },
            ],
            resolved: false,
            createdAt: at,
            updatedAt: at,
          } as unknown as ReviewThread;
          const review = await mount({
            files: [a, b],
            commits: [
              { sha: "a".repeat(40), subject: "First", files: [a] },
              { sha: second, subject: "Second", files: [b] },
            ],
            ...requestReview(),
            threads: [draft],
          });
          if (!review.view().includes("Second")) await review.press(">");
          expect(review.view()).toContain("Second");
          const [shown] = review
            .shownThreads()
            .filter((each) => each.id === "d1");
          expect(shown?.messages.map((message) => message.text)).toEqual([
            expect.stringContaining("Did Luke write a decoder pool?"),
            expect.stringContaining("Yes: an NVDEC decoder pool in nvcodec."),
          ]);
          await review.unmount();
        },
      );

      testWith(surface, "forge")(
        "a local review's draft for the merge request the agent answered shows the answer under it",
        async () => {
          const draft = {
            id: "d1",
            sessionId: "branch",
            kind: "draft",
            anchor: { path: "a.ts", line: 2, side: "new", text: "a.ts line 2" },
            comments: [
              {
                id: "d1a",
                author: "you",
                body: "Did Luke write a decoder pool?",
                createdAt: at,
                updatedAt: at,
              },
              {
                id: "d1b",
                author: "Claude",
                body: "Yes: an NVDEC decoder pool in nvcodec.",
                createdAt: at,
                updatedAt: at,
              },
            ],
            resolved: false,
            createdAt: at,
            updatedAt: at,
          } as unknown as ReviewThread;
          const review = await mount({
            files,
            ...requestReview(),
            otherReviews: [
              {
                id: "branch",
                root: "/repo",
                title: "main..HEAD",
                target: { kind: "range", base: "main", head: "HEAD" },
                gitlab: false,
                summary: "",
                agent: { name: "Claude", paneId: "w29:p1" },
                createdAt: at,
                updatedAt: at,
              },
            ],
            shared: [draft],
          });
          const [shown] = review
            .shownThreads()
            .filter((each) => each.id === "d1");
          expect(shown?.messages.map((message) => message.text)).toEqual([
            expect.stringContaining("Did Luke write a decoder pool?"),
            expect.stringContaining("Yes: an NVDEC decoder pool in nvcodec."),
          ]);
          await review.unmount();
        },
      );
    });
  }
}
