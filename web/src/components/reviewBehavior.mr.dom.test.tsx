import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ReviewThread } from "../../../shared/review";

/**
 * Merge request reviews and a review's commits, at the behavior level: a
 * GitLab discussion found again in today's file, the GitLab section while
 * the merge request loads, opening it (O, :open), the poll of the code's
 * state while shown, and the commits' strip in Review only. Runs against
 * every review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("merge request reviews and commits in an isolated DOM runtime", async () => {
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
  const { installReviewDom, file, hunk, numbered } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { ALL_REVIEW_SURFACES, testWith } = await import(
    "./reviewSurfaces.testkit"
  );

  const MR_URL = "https://gitlab.example/group/project/-/merge_requests/7";
  /** A merge request's review on GitLab, its merge request read. */
  const mrReview = (security = false) => ({
    session: {
      target: { kind: "mr" as const, url: MR_URL },
      gitlab: true,
      title: "Fix the parser",
    },
    mergeRequest: {
      url: MR_URL,
      title: "Fix the parser",
      state: "opened",
      headSha: "h",
      security,
    },
  });

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

  /** A GitLab discussion: on a line, or on the whole request (no path). */
  const discussion = (
    id: string,
    where: { path?: string; line?: number; headSha?: string },
    body: string,
    resolved = false,
  ): ReviewThread =>
    ({
      id,
      sessionId: "s1",
      kind: "merge-request",
      anchor: where.path
        ? { path: where.path, line: where.line, side: "new" }
        : {},
      comments: [
        {
          id: `${id}c`,
          author: "@ana",
          body,
          createdAt: "2026-11-04T14:11:18Z",
          updatedAt: "2026-11-04T14:11:18Z",
        },
      ],
      resolved,
      gitlab: { discussionId: `d-${id}`, headSha: where.headSha ?? "h" },
      createdAt: "2026-11-04T14:11:18Z",
      updatedAt: "2026-11-04T14:11:18Z",
    }) as unknown as ReviewThread;

  const commit = (sha: string, subject: string) => ({
    sha: sha.repeat(40),
    parent: null,
    author: "T",
    date: "2026-11-05",
    subject,
    body: "",
  });

  // A test failing before its unmount leaves no fake clock behind.
  afterEach(() => {
    jest.useRealTimers();
  });

  for (const surface of ALL_REVIEW_SURFACES)
    describe(surface.name, () => {
      const { mount } = surface;
      testWith(surface, "forge")(
        "a forge discussion on an older head is found again in today's file, folded, outdated (was line N)",
        async () => {
          const review = await mount({
            files: [
              file(
                "a.ts",
                hunk(1, 1, ["+new 1", "+new 2", " keep", " target", " tail"]),
              ),
            ],
            fileAt: {
              "old:a.ts": "keep\ntarget\ntail\n",
              "h:a.ts": "new 1\nnew 2\nkeep\ntarget\ntail\n",
            },
            threads: [
              discussion(
                "m1",
                { path: "a.ts", line: 2, headSha: "old" },
                "Is target right?",
              ),
            ],
            ...mrReview(),
          });
          // Both versions of the file are read, by their commits.
          expect(
            review
              .calls("review.file")
              .map((call) => `${call.params.rev}:${call.params.path}`)
              .sort(),
          ).toEqual(["h:a.ts", "old:a.ts"]);
          const [card] = review.forgeThreads();
          expect(card?.head).toContain("outdated (was line 2)");
          expect(card?.open).toBe(false);
          await review.toggleForgeThread("m1");
          expect(review.forgeThreads()[0]?.open).toBe(true);
          expect(review.forgeThreads()[0]?.text).toContain("Is target right?");
          await review.unmount();
        },
      );

      testWith(surface, "forge")(
        "a forge discussion on an older head found nowhere in today's file is looked for once, not again and again",
        async () => {
          const review = await mount({
            files: [file("a.ts", hunk(1, 1, ["+new 1", " keep"]))],
            fileAt: {
              "old:a.ts": "gone\nother\n",
              "h:a.ts": "new 1\nkeep\n",
            },
            threads: [
              discussion(
                "m1",
                { path: "a.ts", line: 2, headSha: "old" },
                "Where did this go?",
              ),
            ],
            ...mrReview(),
          });
          // Read once each, however long the review stays open.
          await review.press("j");
          await review.press("k");
          expect(
            review
              .calls("review.file")
              .map((call) => `${call.params.rev}:${call.params.path}`)
              .sort(),
          ).toEqual(["h:a.ts", "old:a.ts"]);
          await review.unmount();
        },
      );

      testWith(surface, "forge")(
        "the GitLab section says when the merge request is loading or cannot be read",
        async () => {
          const loading = await mount({
            files: [added("a.ts", 2)],
            session: mrReview().session,
          });
          expect(loading.text()).toContain(
            "Loading the merge request comments...",
          );
          await loading.unmount();
          const failed = await mount({
            files: [added("a.ts", 2)],
            session: mrReview().session,
            gitlabError: "401 Unauthorized",
          });
          expect(failed.text()).toContain(
            "GitLab comments unavailable: 401 Unauthorized",
          );
          await failed.unmount();
        },
      );

      testWith(surface, "reload-offer")(
        "the code's state is checked every 5 s while shown; a change offers a reload",
        async () => {
          let state = "one";
          const review = await mount({
            files: [added("a.ts", 2)],
            // In Changes a review of commits is checked so; its Working
            // scope is git's, read again by the inspector.
            ...(surface.name === "changes"
              ? { commits: [{ sha: "a".repeat(40), subject: "One" }] }
              : {}),
            fakeTimers: true,
            answers: { "review.state": () => ({ state }) },
          });
          const checks = () => review.calls("review.state").length;
          const first = checks();
          expect(review.banner()).toBeNull();
          await review.advance(5_000);
          expect(checks()).toBe(first + 1);
          expect(review.banner()).toBeNull();
          // Out of view, nothing is asked.
          await review.setPageHidden(true);
          state = "two";
          await review.advance(15_000);
          expect(checks()).toBe(first + 1);
          expect(review.banner()).toBeNull();
          await review.setPageHidden(false);
          await review.advance(5_000);
          expect(checks()).toBe(first + 2);
          expect(review.banner()).toBe(
            "The code changed since this review was loaded.",
          );
          // Reload reads the review again and the offer goes.
          const diffs = review.calls("review.diff").length;
          await review.clickButton("Reload");
          expect(review.calls("review.diff").length).toBeGreaterThan(diffs);
          expect(review.banner()).toBeNull();
          await review.unmount();
        },
      );

      testWith(surface, "commits")(
        "Review only keeps the commits in a strip at the bottom, which steps through them",
        async () => {
          const review = await mount({
            files: [added("a.ts", 4)],
            commits: [
              commit("a", "First"),
              commit("b", "Second"),
              commit("c", "Third"),
            ],
          });
          await review.press("o");
          expect(review.commitBar()).toEqual({
            head: "1/3 aaaaaaaa",
            subject: "First",
          });
          await review.stepCommitBar(1);
          expect(review.commitBar()).toEqual({
            head: "2/3 bbbbbbbb",
            subject: "Second",
          });
          await review.stepCommitBar(-1);
          await review.stepCommitBar(-1);
          expect(review.commitBar()).toEqual({
            head: "All changes",
            subject: "3 commits",
          });
          await review.press("o");
          expect(review.commitBar()?.head).toBe("All changes");
          await review.unmount();

          // Nothing to step through: no strip.
          const single = await mount({ files: [added("a.ts", 2)] });
          await single.press("o");
          expect(single.commitBar()).toBeNull();
          await single.unmount();
        },
      );

      testWith(surface, "forge")(
        "O and :open open the merge request's changes in a new tab; a local review has none to open",
        async () => {
          const review = await mount({
            files: [added("a.ts", 2)],
            ...mrReview(),
          });
          await review.press("O");
          expect(review.opened()).toEqual([`${MR_URL}/diffs`]);
          await review.command(":open");
          await review.command(":gitlab");
          expect(review.opened()).toEqual([
            `${MR_URL}/diffs`,
            `${MR_URL}/diffs`,
            `${MR_URL}/diffs`,
          ]);
          await review.unmount();
          const local = await mount({ files: [added("a.ts", 2)] });
          await local.press("O");
          expect(local.opened()).toEqual([]);
          expect(local.notices()).toContain(
            "This review is not about a GitLab merge request.",
          );
          await local.unmount();
        },
      );
    });
}
