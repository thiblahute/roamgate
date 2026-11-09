import { describe, expect, spyOn, test } from "bun:test";
import type { ReviewMergeRequest } from "../../../shared/review";

/**
 * The review's `:` command line and its shortcut list, at the behavior
 * level: a command typed in, what the review shows or asks for out. Every
 * alias of `parseReviewCommand` is typed here, plus Tab completion and the
 * unknown command message. Runs against every review surface
 * (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review commands in an isolated DOM runtime", async () => {
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
  const claude = [{ paneId: "p1", agent: "claude" }];
  const commits = [
    {
      sha: "aaaaaaaa1",
      parent: null,
      author: "Ann",
      date: "2026-11-01T10:00:00Z",
      subject: "Add the parser",
      body: "",
    },
    {
      sha: "bbbbbbbb2",
      parent: "aaaaaaaa1",
      author: "Bob",
      date: "2026-11-02T10:00:00Z",
      subject: "Fix the lexer",
      body: "",
    },
  ];
  const unknown = (text: string) =>
    `Not a review command: :${text} (try :q, :w, :diff, :files)`;

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("an unknown command says so and names a few; :help and :set with another option are unknown", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.command(":frob");
        expect(review.notice()).toBe(unknown("frob"));
        await review.command(":frob now");
        expect(review.notice()).toBe(unknown("frob now"));
        // `?` is the shortcut list; there is no :help command.
        await review.command(":help");
        expect(review.notice()).toBe(unknown("help"));
        expect(review.shortcuts()).toBeNull();
        await review.command(":set number");
        expect(review.notice()).toBe(unknown("set number"));
        await review.command(":set");
        expect(review.notice()).toBe(unknown("set"));
        // The review and its cursor are where they were.
        expect(review.closes()).toBe(0);
        expect(review.cursorLine()?.text).toBe("a.ts line 1");
        await review.unmount();
      });

      test(":q :q! :quit :close :wq :x :xit close the review, which is kept", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        let closes = 0;
        for (const alias of [":q", ":q!", ":quit", ":close", ":wq", ":x"]) {
          await review.command(alias);
          expect(review.closes()).toBe(++closes);
        }
        await review.command(":xit");
        expect(review.closes()).toBe(closes + 1);
        // Closing only hides: nothing is removed or forgotten.
        expect(review.calls("review.remove")).toEqual([]);
        await review.unmount();
      });

      test(":w and :write save the review, saying so", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.command(":w");
        expect(review.notice()).toBe("Review saved");
        expect(review.closes()).toBe(0);
        await review.command(":frob");
        await review.command(":write");
        expect(review.notice()).toBe("Review saved");
        await review.unmount();
      });

      test(":s :split :diff :unified switch side by side and unified", async () => {
        const review = await mount({
          files: [file("a.ts", hunk(1, 1, ["-old", "+new"]))],
        });
        expect(review.sideBySide()).toBe(false);
        let shown = false;
        for (const alias of [":s", ":split", ":diff", ":unified"]) {
          await review.command(alias);
          shown = !shown;
          expect(review.sideBySide()).toBe(shown);
        }
        await review.unmount();
      });

      test(":files shows and hides the file list", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        expect(review.filesShown()).toBe(true);
        await review.command(":files");
        expect(review.filesShown()).toBe(false);
        await review.command(":files");
        expect(review.filesShown()).toBe(true);
        await review.unmount();
      });

      test(":only :o :diffonly show the diff only, and back", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        expect(review.diffOnly()).toBe(false);
        await review.command(":only");
        expect(review.diffOnly()).toBe(true);
        await review.command(":o");
        expect(review.diffOnly()).toBe(false);
        await review.command(":diffonly");
        expect(review.diffOnly()).toBe(true);
        await review.command(":only");
        expect(review.diffOnly()).toBe(false);
        await review.unmount();
      });

      test(":comments and :hidecomments hide every comment, and show them again", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          threads: [thread("t1", "a.ts", 2, "Why a second parser?")],
        });
        expect(review.commentsShown()).toBe(true);
        await review.command(":comments");
        expect(review.commentsShown()).toBe(false);
        await review.command(":comments");
        expect(review.commentsShown()).toBe(true);
        await review.command(":hidecomments");
        expect(review.commentsShown()).toBe(false);
        await review.command(":hidecomments");
        expect(review.commentsShown()).toBe(true);
        await review.unmount();
      });

      test(":ask :chat :discuss open a discussion with the agent on the line", async () => {
        for (const alias of [":ask", ":chat", ":discuss"]) {
          const review = await mount({
            files: [added("a.ts", 4)],
            agentPanes: claude,
          });
          await review.press("j");
          expect(review.editor()).toBeNull();
          await review.command(alias);
          expect(review.editor()).toEqual({
            placeholder:
              "For Claude: sent as you save (Cmd+Enter saves, Esc closes)",
            text: "",
          });
          // On the line of the cursor.
          expect(review.cursorLine()?.text).toBe("a.ts line 2");
          await review.unmount();
        }
        // No agent pane: the discussion waits for Send in the workspace's
        // threads.
        const alone = await mount({ files: [added("a.ts", 4)] });
        await alone.command(":ask");
        expect(alone.editor()?.placeholder).toBe(
          "Waiting for Send in the workspace's threads (Cmd+Enter saves, Esc closes)",
        );
        await alone.unmount();
      });

      test(":review asks the agent for a review, with a focus or without; :review alone opens the focus bar", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          agentPanes: claude,
        });
        await review.command(":review locking and error paths");
        expect(
          review.calls("review.agent.review").slice(-1)[0]?.params,
        ).toEqual({
          session_id: "s1",
          pane_id: "p1",
          agent: "Claude",
          focus: "locking and error paths",
        });
        // Alone, it opens the focus bar, as the menu's entry does; Start
        // there asks with no focus.
        await review.command(":review");
        expect(review.calls("review.agent.review")).toHaveLength(1);
        expect(review.focusBar()).toBe("");
        await review.clickButton("Start");
        expect(review.calls("review.agent.review")).toHaveLength(2);
        expect(
          review.calls("review.agent.review").slice(-1)[0]?.params,
        ).toEqual({
          session_id: "s1",
          pane_id: "p1",
          agent: "Claude",
          focus: undefined,
        });
        expect(review.focusBar()).toBeNull();
        await review.unmount();

        // No agent pane in the workspace: nothing is asked.
        const alone = await mount({ files: [added("a.ts", 4)] });
        await alone.command(":review");
        await alone.clickButton("Start");
        expect(alone.calls("review.agent.review")).toEqual([]);
        expect(alone.status()).toBe(
          "Agent could not review: no agent pane in this workspace",
        );
        await alone.unmount();
      });

      test(":send and :handoff hand the review to the agent and say what went", async () => {
        for (const alias of [":send", ":handoff"]) {
          const review = await mount({
            files: [added("a.ts", 4)],
            agentPanes: claude,
          });
          await review.command(alias);
          expect(review.calls("review.handoff")).toHaveLength(1);
          expect(review.status()).toBe("Sent to Claude: 0 open discussions.");
          await review.unmount();
        }
      });

      test(":hold holds comments until :send, and :hold again sends them as written; without an agent it says comments do not go to one", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          agentPanes: claude,
        });
        await review.command(":hold");
        expect(review.calls("review.update").slice(-1)[0]?.params).toEqual({
          session_id: "s1",
          holdComments: true,
        });
        expect(review.status()).toBe(
          "Your comments wait until you Send them to Claude (:send).",
        );
        await review.unmount();

        const held = await mount({
          files: [added("a.ts", 4)],
          agentPanes: claude,
          session: { holdComments: true },
        });
        await held.command(":hold");
        expect(held.calls("review.update").slice(-1)[0]?.params).toEqual({
          session_id: "s1",
          holdComments: false,
        });
        expect(held.status()).toBe(
          "Your comments go to Claude as you write them.",
        );
        await held.unmount();

        const alone = await mount({ files: [added("a.ts", 4)] });
        await alone.command(":hold");
        expect(alone.calls("review.update")).toEqual([]);
        expect(alone.notice()).toBe("Comments are not going to Agent.");
        await alone.unmount();
      });

      test(":overall and :summary open the overall comment, with what it says", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.command(":overall");
        expect(review.editor()).toEqual({
          placeholder:
            "Your overall comment on the review (Cmd+Enter saves, Esc closes)",
          text: "",
        });
        await review.unmount();

        const written = await mount({
          files: [added("a.ts", 4)],
          session: { summary: "Looks good overall." },
        });
        await written.command(":summary");
        expect(written.editor()?.text).toBe("Looks good overall.");
        await written.unmount();
      });

      test(":conversations :threads :conv list every conversation; Esc closes the list", async () => {
        for (const alias of [":conversations", ":threads", ":conv"]) {
          const review = await mount({
            files: [added("a.ts", 4)],
            threads: [thread("t1", "a.ts", 2, "Why a second parser?")],
          });
          expect(review.conversationsShown()).toBe(false);
          await review.command(alias);
          expect(review.conversationsShown()).toBe(true);
          await review.press("<Esc>");
          expect(review.conversationsShown()).toBe(false);
          await review.unmount();
        }
      });

      test(":unreviewed goes to the next chunk not reviewed", async () => {
        const review = await mount({
          files: [added("a.ts", 3), added("b.ts", 3)],
          agentPanes: claude,
        });
        // The first chunk reviewed: the cursor goes on to b.ts.
        await review.press("r");
        await review.press("gg");
        await review.command(":unreviewed");
        expect(review.cursorLine()).toMatchObject({
          path: "b.ts",
          text: "b.ts line 1",
        });
        await review.unmount();
      });

      test(":suggest opens a suggestion of the line in a comment; nothing on a removed line", async () => {
        const review = await mount({
          files: [file("a.ts", hunk(1, 1, ["-old one", "+new one", " same"]))],
        });
        await review.press("j");
        expect(review.cursorLine()?.text).toBe("new one");
        await review.command(":suggest");
        expect(review.editor()?.text).toBe(
          "```suggestion:-0+0\nnew one\n```\n",
        );
        await review.unmount();

        const removed = await mount({
          files: [file("a.ts", hunk(1, 1, ["-old one", "+new one"]))],
        });
        expect(removed.cursorLine()?.text).toBe("old one");
        await removed.command(":suggest");
        expect(removed.editor()).toBeNull();
        await removed.unmount();
      });

      test(":open :gitlab :mr open the merge request's changes; a review of no merge request says so", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        for (const alias of [":open", ":gitlab", ":mr"]) {
          await review.command(":frob");
          await review.command(alias);
          expect(review.notice()).toBe(
            "This review is not about a GitLab merge request.",
          );
        }
        expect(review.opened()).toEqual([]);
        await review.unmount();

        const url = "https://gitlab.example/group/project/-/merge_requests/7";
        const mr = await mount({
          files: [added("a.ts", 4)],
          // Only what :open reads of a merge request.
          mergeRequest: {
            url,
            title: "Add the parser",
            number: 7,
          } as unknown as ReviewMergeRequest,
        });
        for (const alias of [":open", ":gitlab", ":mr"])
          await mr.command(alias);
        expect(mr.opened()).toEqual([
          `${url}/diffs`,
          `${url}/diffs`,
          `${url}/diffs`,
        ]);
        await mr.unmount();
      });

      test(":switch looks up the branch's merge request and shows its review; none found says so", async () => {
        const review = await mount({
          files: [added("a.ts", 4)],
          answers: {
            "review.gitlab.open": () => ({ mergeRequest: null }),
          },
        });
        await review.command(":switch");
        expect(review.calls("review.gitlab.open")).toHaveLength(1);
        expect(review.notice()).toBe(
          "No open GitLab merge request found for this branch.",
        );
        expect(review.reviewsShown()).toEqual([]);
        await review.unmount();

        const opened = {
          session: { id: "s2", gitlab: true },
          threads: [],
        };
        const found = await mount({
          files: [added("a.ts", 4)],
          answers: {
            "review.gitlab.open": () => ({
              mergeRequest: {
                url: "https://gitlab.example/g/p/-/merge_requests/7",
                title: "Add the parser",
                number: 7,
              },
              snapshot: opened,
            }),
          },
        });
        await found.command(":switch");
        expect(found.reviewsShown()).toEqual([opened]);
        await found.unmount();
      });

      test(":commit N, :commit words, :all and :commit alone pick the view; :commits opens the picker, searched", async () => {
        const review = await mount({ files: [added("a.ts", 4)], commits });
        // One commit at a time, oldest first.
        expect(review.view()).toBe("1/2 aaaaaaaa Add the parser");
        await review.command(":commit 2");
        expect(review.view()).toBe("2/2 bbbbbbbb Fix the lexer");
        await review.command(":all");
        expect(review.view()).toBe("All changes 2 commits");
        await review.command(":commit 1");
        expect(review.view()).toBe("1/2 aaaaaaaa Add the parser");
        await review.command(":commit");
        expect(review.view()).toBe("All changes 2 commits");
        // Past the last commit: nothing moves.
        await review.command(":commit 9");
        expect(review.view()).toBe("All changes 2 commits");

        await review.command(":commits");
        expect(review.commitPicker()).toEqual({
          query: "",
          choices: [
            "All changes (2 commits)",
            "1/2 aaaaaaaa Add the parser",
            "2/2 bbbbbbbb Fix the lexer",
          ],
        });
        await review.press("<Esc>");
        expect(review.commitPicker()).toBeNull();

        // One match goes there; several open the picker on them.
        await review.command(":commits lexer");
        expect(review.commitPicker()).toBeNull();
        expect(review.view()).toBe("2/2 bbbbbbbb Fix the lexer");
        await review.command(":commit parser");
        expect(review.view()).toBe("1/2 aaaaaaaa Add the parser");
        await review.command(":commits the");
        expect(review.commitPicker()).toEqual({
          query: "the",
          choices: [
            "1/2 aaaaaaaa Add the parser",
            "2/2 bbbbbbbb Fix the lexer",
          ],
        });
        await review.unmount();

        // A review of uncommitted work has no commits to pick.
        const single = await mount({ files: [added("a.ts", 4)] });
        await single.command(":commits");
        expect(single.commitPicker()).toBeNull();
        expect(single.notice()).toBe("This review has a single commit.");
        await single.unmount();
      });

      test(":e :edit :reload read the diff again, on the same line", async () => {
        const review = await mount({ files: [added("a.ts", 6)] });
        await review.press("3j");
        let reads = review.calls("review.diff").length;
        for (const alias of [":e", ":edit", ":reload"]) {
          await review.command(alias);
          expect(review.calls("review.diff").length).toBeGreaterThan(reads);
          reads = review.calls("review.diff").length;
          expect(review.cursorLine()?.text).toBe("a.ts line 4");
        }
        await review.unmount();
      });

      test(":reviews shows the reviews list", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.command(":reviews");
        expect(review.listsShown()).toBe(1);
        expect(review.closes()).toBe(0);
        await review.unmount();
      });

      test(":vim toggles Vim keys in comments (on at first), :novim and :set novim turn them off, :set vim on; remembered", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        // Vim keys are on until turned off.
        expect(review.vimPreference()).toBeUndefined();
        await review.command(":vim");
        expect(review.vimPreference()).toBe(false);
        await review.command(":vim");
        expect(review.vimPreference()).toBe(true);
        await review.command(":novim");
        await review.command(":set vim");
        expect(review.vimPreference()).toBe(true);
        await review.command(":novim");
        expect(review.vimPreference()).toBe(false);
        await review.command(":set vim");
        await review.command(":set novim");
        expect(review.vimPreference()).toBe(false);
        // Remembered across a reload.
        await review.command(":set vim");
        await review.reload();
        await review.command(":vim");
        expect(review.vimPreference()).toBe(false);
        await review.unmount();
      });

      test("Tab completes the command typed, Shift+Tab goes back, Enter runs it", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.typeCommand("co");
        expect(review.prompt()?.completions.map((each) => each.name)).toEqual([
          "comments",
          "conversations",
          "commit",
          "commits",
        ]);
        expect(review.prompt()?.completions[0]?.description).toBe(
          "show / hide all comments",
        );
        expect(
          review.prompt()?.completions.some((each) => each.on),
        ).toBeFalsy();
        await review.press("<Tab>");
        expect(review.prompt()?.text).toBe("comments");
        expect(
          review.prompt()?.completions.filter((each) => each.on)[0]?.name,
        ).toBe("comments");
        await review.press("<Tab><Tab>");
        expect(review.prompt()?.text).toBe("commit");
        await review.press("<S-Tab>");
        expect(review.prompt()?.text).toBe("conversations");
        // The list stays the one of what was typed; it wraps.
        await review.press("<Tab><Tab><Tab>");
        expect(review.prompt()?.text).toBe("comments");
        await review.press("<S-Tab>");
        expect(review.prompt()?.text).toBe("commits");
        await review.press("<S-Tab><S-Tab>");
        expect(review.prompt()?.text).toBe("conversations");
        await review.press("<Enter>");
        expect(review.prompt()).toBeNull();
        expect(review.conversationsShown()).toBe(true);
        await review.unmount();

        const run = await mount({ files: [added("a.ts", 4)] });
        await run.typeCommand("fil");
        await run.press("<Tab>");
        expect(run.prompt()?.text).toBe("files");
        await run.press("<Enter>");
        expect(run.prompt()).toBeNull();
        expect(run.filesShown()).toBe(false);
        // Nothing matches: Tab does nothing.
        await run.typeCommand("zz");
        expect(run.prompt()?.completions).toEqual([]);
        await run.press("<Tab>");
        expect(run.prompt()?.text).toBe("zz");
        // Esc leaves the prompt without running it.
        await run.press("<Esc>");
        expect(run.prompt()).toBeNull();
        expect(run.notice()).toBeNull();
        await run.unmount();
      });

      test("? opens the shortcut list, which takes the keys until Esc closes it", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.press("?");
        const shortcuts = review.shortcuts();
        expect(shortcuts?.length).toBeGreaterThan(40);
        expect(shortcuts).toContainEqual({ keys: "?", label: "this list" });
        expect(shortcuts).toContainEqual({
          keys: ":",
          label: "command line; Tab / Shift+Tab complete",
        });
        await review.press("<Esc>");
        expect(review.shortcuts()).toBeNull();
        await review.press("j");
        expect(review.cursorLine()?.text).toBe("a.ts line 2");
        await review.unmount();
      });

      test("a shortcut row holding a key twice (Esc Esc) draws both, with no React key warning", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        const errors = spyOn(console, "error");
        try {
          await review.press("?");
          expect(
            review.shortcuts()?.some((row) => row.keys.startsWith("Esc Esc")),
          ).toBe(true);
          expect(
            errors.mock.calls.some((call) =>
              String(call[0]).includes("same key"),
            ),
          ).toBe(false);
        } finally {
          errors.mockRestore();
        }
        await review.unmount();
      });

      test("the shortcut list filters: a single key lists its row and the rows holding it, words must all match, accents ignored", async () => {
        const review = await mount({ files: [added("a.ts", 4)] });
        await review.press("?");
        const keys = () => review.shortcuts()?.map((row) => row.keys);
        await review.filterShortcuts("?");
        expect(keys()).toEqual(["?"]);
        await review.filterShortcuts("{");
        expect(keys()).toEqual(["{ }"]);
        await review.filterShortcuts("zz");
        expect(keys()).toEqual(["zz zt zb"]);
        await review.filterShortcuts("GitLab");
        expect(keys()).toEqual(["s", "O :open", "gm :switch"]);
        // "gg" is also in "suggest".
        await review.filterShortcuts("gg");
        expect(keys()).toEqual(["gg G", "s"]);
        // One key: the rows holding it, not every row whose words hold
        // the letter.
        await review.filterShortcuts("V");
        expect(keys()).toEqual(["V"]);
        await review.filterShortcuts("side line");
        expect(keys()).toEqual(["j k ↓ ↑", "← →"]);
        await review.filterShortcuts("comment hunk");
        expect(keys()).toEqual([]);
        expect(review.text()).toContain("Nothing matches.");
        await review.filterShortcuts("é");
        const accented = keys();
        await review.filterShortcuts("e");
        expect(keys()).toEqual(accented);
        await review.filterShortcuts("");
        expect(keys()?.length).toBeGreaterThan(40);
        await review.unmount();
      });
    });
}
