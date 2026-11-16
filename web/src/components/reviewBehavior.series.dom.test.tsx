import { describe, expect, test } from "bun:test";

/**
 * A workspace's series of repositories, at the behavior level: where they
 * are found (the panes' directories and the agents'), the chooser, `(` and
 * `)` from one to the next, `p` with a single one. Runs against every review
 * surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("a workspace's repositories in an isolated DOM runtime", async () => {
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

  for (const surface of ALL_REVIEW_SURFACES)
    describe(surface.name, () => {
      const { mount } = surface;
      // Each test its own directories: the bridge's scans are reused for a
      // minute per set of directories.
      testWith(surface, "series")(
        "the repositories come from the review's root, the panes' directories and the agents'",
        async () => {
          const review = await mount({
            files,
            session: { root: "/w/app" },
            repoDirs: ["/w/app/src", "/w/lib"],
            agentDirs: ["/w/agent"],
            repos: [
              { root: "/w/app", branch: "fix", ahead: 2 },
              { root: "/w/lib", branch: "main", dirty: true },
            ],
          });
          expect(
            review.calls("review.repos").map((call) => call.params),
          ).toEqual([
            {
              paths: ["/w/app", "/w/app/src", "/w/lib"],
              agent_paths: ["/w/agent"],
            },
          ]);
          expect(review.repoChooser()).toEqual({
            choices: ["app · fix, 2 ahead", "lib · main, uncommitted"],
            value: "/w/app",
          });
          expect(review.text()).toContain(
            "2 repositories in this workspace; p searches, ( ) switch",
          );
          await review.unmount();
        },
      );

      testWith(surface, "series")(
        "( and ) go to the previous and next repository, by path, without wrapping",
        async () => {
          const review = await mount({
            files,
            session: { root: "/s/m" },
            repoDirs: ["/s/a", "/s/z"],
            repos: [
              { root: "/s/z", ahead: 1 },
              { root: "/s/a", dirty: true },
              { root: "/s/m", ahead: 3 },
            ],
            hostCallbacks: true,
          });
          expect(review.repoChooser()?.choices).toEqual([
            "a · uncommitted",
            "m · 3 ahead",
            "z · 1 ahead",
          ]);
          await review.press(")");
          await review.press("(");
          // Only uncommitted work: its worktree review.
          expect(review.hostCalls("openRepo")).toEqual([
            { name: "openRepo", args: ["/s/z", false] },
            { name: "openRepo", args: ["/s/a", true] },
          ]);
          await review.unmount();

          const last = await mount({
            files,
            session: { root: "/t/z" },
            repoDirs: ["/t/a"],
            repos: [{ root: "/t/a" }, { root: "/t/z" }],
            hostCallbacks: true,
          });
          await last.press(")");
          expect(last.hostCalls("openRepo")).toEqual([]);
          await last.press("(");
          expect(last.hostCalls("openRepo")).toHaveLength(1);
          await last.unmount();
        },
      );

      testWith(surface, "series")(
        "p with a single repository says so; no chooser is shown",
        async () => {
          const review = await mount({
            files,
            session: { root: "/u/only" },
            repoDirs: ["/u/only/src"],
            repos: [{ root: "/u/only", ahead: 1 }],
            hostCallbacks: true,
          });
          expect(review.repoChooser()).toBeNull();
          await review.press("p");
          expect(review.notices()).toContain(
            "This workspace has a single repository here.",
          );
          await review.press(")");
          expect(review.hostCalls("openRepo")).toEqual([]);
          await review.unmount();
        },
      );
    });
}
