import { inIsolatedChild } from "../testIsolated";
import { describe, expect } from "bun:test";
import type { ReviewThread } from "../../../shared/review";

/**
 * The review's head, at the behavior level: GitLab mode (the More menu's
 * checkbox and the Local / GitLab switch show which review this is, and
 * turn to the other one), the agent's menu (Go to its pane; none on a
 * security merge request, kept from agents) and a thread's view once its
 * commit is rewritten out of the review. Hiding the switch at 1100 px and
 * below is CSS: the e2e width check (tools/e2e-review-width.ts) covers it.
 * Runs against every review surface (reviewSurfaces.testkit.ts).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the review's head in an isolated DOM runtime",
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

  const MR_URL = "https://gitlab.example/group/project/-/merge_requests/7";
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
  const link = { url: MR_URL, title: "Fix the parser", number: 7 };

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

  const commit = (sha: string, subject: string) => ({
    sha: sha.repeat(40),
    parent: null,
    author: "T",
    date: "2026-11-05",
    subject,
    body: "",
  });

  for (const surface of ALL_REVIEW_SURFACES)
    describe(surface.name, () => {
      const { mount } = surface;
      testWith(surface, "forge")(
        "a local review: GitLab mode unchecked, Local on; checking it opens the merge request's review",
        async () => {
          const opened = {
            session: { id: "s2", target: { kind: "mr", url: MR_URL } },
            threads: [],
          };
          const review = await mount({
            files,
            hostCallbacks: true,
            answers: {
              "review.gitlab.find": () => ({ mergeRequest: link }),
              "review.gitlab.open": () => ({
                mergeRequest: link,
                snapshot: opened,
              }),
            },
          });
          expect(review.modeSwitch()).toEqual([
            { label: "Local", on: true },
            { label: "GitLab", on: false },
          ]);
          const more = await review.menu("more");
          expect(more.find((item) => item.label === "GitLab mode")).toEqual({
            label: "GitLab mode",
            checked: false,
            disabled: false,
          });
          // No merge request read in a local review: nothing to open on it.
          expect(more.map((item) => item.label)).not.toContain(
            "Open the merge request on GitLab",
          );
          await review.chooseMenu("more", "GitLab mode");
          expect(review.calls("review.gitlab.open")).toHaveLength(1);
          expect(review.hostCalls("showReview")).toEqual([
            { name: "showReview", args: [opened] },
          ]);
          // The switch's GitLab side does the same.
          await review.clickButton("GitLab");
          expect(review.calls("review.gitlab.open")).toHaveLength(2);
          await review.unmount();

          // No merge request for the branch: said, nothing opened.
          const none = await mount({
            files,
            hostCallbacks: true,
            answers: {
              "review.gitlab.open": () => ({ mergeRequest: null }),
            },
          });
          await none.chooseMenu("more", "GitLab mode");
          expect(none.notices()).toContain(
            "No open GitLab merge request found for this branch.",
          );
          expect(none.hostCalls("showReview")).toEqual([]);
          await none.unmount();
        },
      );

      testWith(surface, "forge")(
        "a merge request's review: GitLab mode checked, GitLab on; unchecking it opens the checkout's local review",
        async () => {
          const mr = {
            session: {
              target: { kind: "mr" as const, url: MR_URL },
              gitlab: true,
            },
            mergeRequest: {
              url: MR_URL,
              title: "Fix the parser",
              state: "opened",
              headSha: "h",
              security: false,
            },
          };
          const review = await mount({
            files,
            ...mr,
            hostCallbacks: true,
            answers: {
              "review.gitlab.find": (params) =>
                params.local
                  ? { mergeRequest: link, localReviews: ["l1", "l2"] }
                  : { mergeRequest: link },
            },
          });
          expect(review.modeSwitch()).toEqual([
            { label: "Local", on: false },
            { label: "GitLab", on: true },
          ]);
          const more = await review.menu("more");
          expect(
            more.find((item) => item.label === "GitLab mode")?.checked,
          ).toBe(true);
          expect(more.map((item) => item.label)).toContain(
            "Open the merge request on GitLab",
          );
          await review.chooseMenu("more", "GitLab mode");
          expect(review.hostCalls("openLocal")).toEqual([
            { name: "openLocal", args: ["/repo", ["l1", "l2"]] },
          ]);
          await review.unmount();

          // The checkout is not on its branch: said, nothing opened.
          const away = await mount({
            files,
            ...mr,
            hostCallbacks: true,
            answers: {
              "review.gitlab.find": () => ({ mergeRequest: null }),
            },
          });
          await away.clickButton("Local");
          expect(away.notices()).toContain(
            "The checkout is not on this merge request's branch.",
          );
          expect(away.hostCalls("openLocal")).toEqual([]);
          await away.unmount();
        },
      );
      testWith(
        surface,
        "forge",
        "agent-menu",
      )(
        "a security merge request is kept from agents: no agent controls, C refused, comments are drafts",
        async () => {
          const agent = { name: "Claude", paneId: "p1" };
          const review = await mount({
            files: [added("a.ts", 3)],
            ...mrReview(true),
            session: { ...mrReview(true).session, agent },
            hostCallbacks: true,
          });
          expect(review.text()).toContain(
            "Security merge request: not shared with agents.",
          );
          await expect(review.menu("agent")).rejects.toThrow("no agent menu");
          await review.press("C");
          expect(review.notices()).toContain(
            "This security merge request is not shared with agents.",
          );
          expect(review.editorPlaceholder()).toBeNull();
          // c writes a comment of the review, not one for the agent.
          await review.press("c");
          expect(review.editorPlaceholder()).toBe(
            "Your comment on this line (Cmd+Enter saves, Esc closes)",
          );
          await review.unmount();

          // Before GitLab tells whether it is confidential, agents wait.
          const unknown = await mount({
            files: [added("a.ts", 3)],
            session: { ...mrReview().session, agent },
            hostCallbacks: true,
          });
          await expect(unknown.menu("agent")).rejects.toThrow("no agent menu");
          await unknown.press("C");
          expect(unknown.notices()).toContain(
            "Agents wait until GitLab tells whether this merge request is confidential.",
          );
          await unknown.unmount();

          // Not confidential: the agent is there.
          const shared = await mount({
            files: [added("a.ts", 3)],
            ...mrReview(false),
            session: { ...mrReview(false).session, agent },
            hostCallbacks: true,
          });
          expect(
            (await shared.menu("agent")).map((item) => item.label),
          ).toContain("Ask Claude about this line");
          await shared.unmount();
        },
      );

      testWith(
        surface,
        "commits",
        "gone-commits",
      )(
        "a commit rewritten out of the review shows as no longer in the review",
        async () => {
          const review = await mount({
            files: [added("a.ts", 4)],
            commits: [commit("a", "First"), commit("b", "Second")],
            threads: [
              {
                id: "t1",
                sessionId: "s1",
                kind: "discussion",
                anchor: {
                  path: "a.ts",
                  line: 2,
                  side: "new",
                  commit: "z".repeat(40),
                  commitSubject: "Dropped",
                },
                comments: [
                  {
                    id: "t1c",
                    author: "you",
                    body: "On a commit since rewritten",
                    createdAt: "2026-11-04T14:11:18Z",
                    updatedAt: "2026-11-04T14:11:18Z",
                  },
                ],
                resolved: false,
                createdAt: "2026-11-04T14:11:18Z",
                updatedAt: "2026-11-04T14:11:18Z",
              } as unknown as ReviewThread,
            ],
          });
          expect(review.commitBar()?.head).toBe("1/2 aaaaaaaa");
          // gn goes to the thread, in the view it was written on.
          await review.press("gn");
          expect(review.commitBar()).toEqual({
            head: "zzzzzzzz",
            subject: "Dropped (no longer in the review)",
          });
          expect(review.text()).toContain("On a commit since rewritten");
          await review.unmount();
        },
      );

      testWith(surface, "agent-menu")(
        "Go to the agent's pane is in the agent's menu when the host can show it; the review is kept",
        async () => {
          const agent = { name: "Claude", paneId: "p1" };
          const review = await mount({
            files: [added("a.ts", 2)],
            session: { agent },
            hostCallbacks: true,
          });
          const items = await review.menu("agent");
          expect(items.map((item) => item.label)).toContain(
            "Go to Claude's pane",
          );
          await review.chooseMenu("agent", "Go to Claude's pane");
          expect(review.hostCalls("focusAgentPane")).toEqual([
            { name: "focusAgentPane", args: ["p1"] },
          ]);
          expect(review.hostCalls("close")).toEqual([]);
          await review.unmount();

          // The workspace's agent pane when the review has none bound.
          const found = await mount({
            files: [added("a.ts", 2)],
            agentPanes: [{ paneId: "p9", agent: "codex" }],
            hostCallbacks: true,
          });
          await found.chooseMenu("agent", "Go to Codex's pane");
          expect(found.hostCalls("focusAgentPane")[0]?.args).toEqual(["p9"]);
          await found.unmount();

          // No host to show it: no such entry.
          const alone = await mount({
            files: [added("a.ts", 2)],
            session: { agent },
          });
          expect(
            (await alone.menu("agent")).map((item) => item.label),
          ).not.toContain("Go to Claude's pane");
          await alone.unmount();
        },
      );
    });
}
