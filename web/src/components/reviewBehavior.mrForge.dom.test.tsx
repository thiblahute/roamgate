import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ReviewThread } from "../../../shared/review";

/**
 * A request's review and its forge, at the behavior level: replies to a
 * forge discussion are drafts there, never published from the review; a
 * pull request's conversation comments show, answered on GitHub; the
 * user's drafts on the forge are counted and linked; an agent's comment
 * becomes the user's draft with Make it mine; `r` on a forge discussion
 * resolves nothing; the GitLab section's counts; GitLab read again every
 * minute while shown. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("a request's review and its forge in an isolated DOM runtime", async () => {
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
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");

  const MR_URL = "https://gitlab.example/group/project/-/merge_requests/7";
  const PR_URL = "https://github.com/owner/project/pull/3";
  /** A request's review on its forge, the request read. */
  const requestReview = (url = MR_URL) => ({
    session: {
      target: { kind: "mr" as const, url },
      gitlab: true,
      title: "Fix the parser",
    },
    mergeRequest: {
      url,
      title: "Fix the parser",
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
  const at = "2026-11-04T14:11:18Z";
  const note = (id: string, author: string, body: string, extra = {}) => ({
    id,
    author,
    body,
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
  /** A thread on a.ts line 2. */
  const thread = (
    id: string,
    kind: ReviewThread["kind"],
    comments: ReturnType<typeof note>[],
    extra: Partial<ReviewThread> = {},
  ): ReviewThread =>
    ({
      id,
      sessionId: "s1",
      kind,
      anchor: { path: "a.ts", line: 2, side: "new" },
      comments,
      resolved: false,
      createdAt: at,
      updatedAt: at,
      ...extra,
    }) as unknown as ReviewThread;

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

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("a reply to a forge discussion is a draft there: written with review.reply, never published from the review", async () => {
        const review = await mount({
          files,
          ...requestReview(),
          threads: [
            thread("m1", "merge-request", [note("m1a", "@ana", "Why?")], {
              gitlab: { discussionId: "d1", headSha: "h" },
            }),
          ],
        });
        await review.clickButton("Draft reply");
        expect(review.editorPlaceholder()).toBe(
          "Your draft reply, published with your review when you submit it on GitLab (Cmd+Enter saves, Esc closes)",
        );
        await review.writeInEditor("Because the input can repeat.");
        await review.clickButton("Save");
        expect(review.calls("review.reply")).toEqual([
          {
            method: "review.reply",
            params: {
              session_id: "s1",
              comment_id: "m1",
              text: "Because the input can repeat.",
            },
          },
        ]);
        // Nothing else written, nothing pushed or submitted to the forge.
        const methods = new Set(review.calls().map((call) => call.method));
        expect(methods.has("review.gitlab.push")).toBe(false);
        expect(methods.has("review.thread.add")).toBe(false);
        await review.unmount();

        // The draft reply the forge holds: yours, not submitted, editable.
        const drafted = await mount({
          files,
          ...requestReview(),
          threads: [
            thread(
              "m1",
              "merge-request",
              [
                note("m1a", "@ana", "Why?"),
                note("m1b", "you", "Because.", { gitlabDraftId: 11 }),
              ],
              { gitlab: { discussionId: "d1", headSha: "h" } },
            ),
          ],
        });
        const [card] = drafted.forgeThreads();
        expect(card?.text).toContain("Your draft reply, not submitted");
        expect(card?.text).toContain("Because.");
        await drafted.clickButton("Delete");
        expect(drafted.calls("review.delete")).toEqual([
          {
            method: "review.delete",
            params: { session_id: "s1", comment_id: "m1b" },
          },
        ]);
        await drafted.unmount();
      });

      test("a pull request's conversation comments show, answered on GitHub: no draft reply", async () => {
        const review = await mount({
          files,
          ...requestReview(PR_URL),
          threads: [
            thread(
              "c1",
              "merge-request",
              [note("c1a", "@bob", "Looks good overall")],
              { anchor: {}, gitlab: { headSha: "h" } } as Partial<ReviewThread>,
            ),
            thread("m1", "merge-request", [note("m1a", "@ana", "Why?")], {
              gitlab: { discussionId: "d1", headSha: "h" },
            }),
          ],
        });
        const cards = new Map(
          review.forgeThreads().map((card) => [card.id, card]),
        );
        expect(cards.get("c1")?.head.startsWith("GitHub")).toBe(true);
        expect(cards.get("c1")?.text).toContain("Looks good overall");
        expect(cards.get("c1")?.text).toContain(
          "Conversation comment: reply on GitHub",
        );
        expect(cards.get("c1")?.text).not.toContain("Draft reply");
        // A review discussion's has one.
        expect(cards.get("m1")?.text).toContain("Draft reply");
        expect(review.text()).toContain("GitHub: 2 discussions");
        await review.unmount();
      });

      test("your drafts on the forge are counted in a link to the request", async () => {
        const review = await mount({
          files,
          ...requestReview(),
          threads: [
            thread("t1", "draft", [note("t1a", "you", "Rename it")], {
              gitlab: { draftId: 4 },
            }),
            thread(
              "m1",
              "merge-request",
              [
                note("m1a", "@ana", "Why?"),
                note("m1b", "you", "Because.", { gitlabDraftId: 11 }),
              ],
              { gitlab: { discussionId: "d1", headSha: "h" } },
            ),
          ],
        });
        expect(review.linkHref("2 drafts on GitLab")).toBe(MR_URL);
        await review.unmount();

        // None yet: no link.
        const none = await mount({ files, ...requestReview() });
        expect(
          none.buttons().some((label) => /drafts? on GitLab/.test(label)),
        ).toBe(false);
        await none.unmount();
      });

      test("Make it mine turns an agent's comment into your forge draft (review.adopt)", async () => {
        const agentDraft = thread("t1", "draft", [
          note("t1a", "Claude", "This loop never ends"),
        ]);
        const mine = thread("t2", "draft", [note("t2a", "you", "Typo")], {
          anchor: { path: "a.ts", line: 3, side: "new" },
        } as Partial<ReviewThread>);
        const review = await mount({
          files,
          ...requestReview(),
          threads: [agentDraft, mine],
        });
        expect(
          review.buttons().filter((label) => label === "Make it mine"),
        ).toHaveLength(1);
        await review.clickButton("Make it mine");
        expect(review.calls("review.adopt")).toEqual([
          {
            method: "review.adopt",
            params: { session_id: "s1", thread_id: "t1" },
          },
        ]);
        // Read back once written.
        expect(review.calls("review.get").length).toBeGreaterThan(0);
        await review.unmount();

        // A local review keeps an agent's comment where it is.
        const local = await mount({ files, threads: [agentDraft] });
        expect(local.buttons()).not.toContain("Make it mine");
        await local.unmount();
      });
      test("Make it mine that fails says why, on its thread", async () => {
        const agentDraft = thread("t1", "draft", [
          note("t1a", "Claude", "This loop never ends"),
        ]);
        const review = await mount({
          files,
          ...requestReview(),
          threads: [agentDraft],
        });
        review.failBridge(["review.adopt"], "no such thread of an agent");
        await review.clickButton("Make it mine");
        expect(review.calls("review.adopt")).toHaveLength(1);
        expect(review.text()).toContain(
          "Not made yours: no such thread of an agent",
        );
        await review.unmount();
      });
      test("r on a selected forge discussion only folds it: nothing is resolved on the forge", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          threads: [
            discussion("m1", { path: "a.ts", line: 2 }, "Why a loop here?"),
          ],
          ...mrReview(),
        });
        expect(review.forgeThreads()).toMatchObject([{ id: "m1", open: true }]);
        // n selects its message; r on it says where it is resolved.
        await review.press("n");
        await review.press("r");
        expect(review.calls("review.resolve")).toEqual([]);
        expect(review.notices()).toContain(
          "Folded here; GitLab discussions are resolved on GitLab.",
        );
        expect(review.forgeThreads()[0]?.open).toBe(false);
        await review.press("<Esc>");
        // On its line, with no message selected, r is the discussion's, as
        // for any thread on the line: it unfolds it, never resolved, and
        // the chunk is not marked reviewed.
        await review.press("gg");
        await review.press("j");
        await review.press("r");
        expect(review.calls("review.resolve")).toEqual([]);
        expect(review.forgeThreads()[0]?.open).toBe(true);
        expect(
          Object.keys(review.reviewedMarks()).some((key) =>
            key.startsWith("all:a.ts\n"),
          ),
        ).toBe(false);
        await review.unmount();
      });

      test("the GitLab section counts the discussions, links those outside this commit, and keeps the resolved ones collapsed", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          commits: [commit("a", "First"), commit("b", "Second")],
          // Each commit's file, where all the changes find their lines
          // again.
          fileAt: Object.fromEntries(
            ["a".repeat(40), "b".repeat(40), "h"].map((rev) => [
              `${rev}:a.ts`,
              `${numbered("a.ts line", 4).join("\n")}\n`,
            ]),
          ),
          threads: [
            discussion(
              "m1",
              { path: "a.ts", line: 2, headSha: "a".repeat(40) },
              "On the first commit",
            ),
            discussion(
              "m2",
              { path: "a.ts", line: 3, headSha: "b".repeat(40) },
              "On the second commit",
            ),
            discussion("m3", {}, "On the whole request"),
            discussion("m4", {}, "Settled already", true),
          ],
          ...mrReview(),
        });
        expect(review.commitBar()?.head).toBe("1/2 aaaaaaaa");
        // m1 on its line, m2 outside this commit, m3 and m4 on the request.
        expect(review.text()).toContain(
          "GitLab: 3 discussions (2 on the whole request); 1 shown on their lines below, 1 on code outside this commit (all changes).",
        );
        expect(review.text()).toContain("Open discussions (1)");
        expect(review.text()).toContain("Resolved (1)");
        const byId = new Map(
          review.forgeThreads().map((card) => [card.id, card]),
        );
        expect(byId.get("m4")?.open).toBe(false);
        expect(byId.get("m3")?.open).toBe(true);
        expect(byId.has("m2")).toBe(false);
        // The link shows all the changes, where every one is.
        await review.clickButton("all changes");
        expect(review.commitBar()?.head).toBe("All changes");
        expect(review.forgeThreads().map((card) => card.id)).toContain("m2");
        expect(review.text()).not.toContain("outside this commit");
        await review.unmount();
      });

      test("GitLab is read again every minute while shown, not while the page is out of view, and at once when it is back", async () => {
        const review = await mount({
          files: [added("a.ts", 2)],
          ...mrReview(),
          fakeTimers: true,
        });
        const polls = () =>
          review
            .calls("review.gitlab.refresh")
            .filter((call) => call.params.poll === true).length;
        expect(polls()).toBe(1);
        await review.advance(59_000);
        expect(polls()).toBe(1);
        await review.advance(1_000);
        expect(polls()).toBe(2);
        await review.setPageHidden(true);
        await review.advance(60_000);
        expect(polls()).toBe(2);
        // Back in view: asked at once, the last ask being a minute old.
        await review.setPageHidden(false);
        expect(polls()).toBe(3);
        // Back again soon after: nothing asked.
        await review.setPageHidden(true);
        await review.setPageHidden(false);
        expect(polls()).toBe(3);
        await review.unmount();

        // A local review asks GitLab nothing.
        const local = await mount({
          files: [added("a.ts", 2)],
          fakeTimers: true,
        });
        await local.advance(120_000);
        expect(local.calls("review.gitlab.refresh")).toEqual([]);
        await local.unmount();
      });
    });
}
