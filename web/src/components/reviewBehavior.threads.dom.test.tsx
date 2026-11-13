import { describe, expect, test } from "bun:test";

/**
 * The review's comment threads, at the behavior level: their cards and
 * folds, the writes on their way, the delivery to the agent, the status
 * line, hidden comments and n / N between messages. Runs against every
 * review surface (reviewSurfaces.testkit.ts).
 */
if (process.env.ROAMGATE_REVIEW_BEHAVIOR_DOM_TEST !== "1") {
  test("review threads in an isolated DOM runtime", async () => {
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
  }, 60_000);
} else {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { REVIEW_SURFACES } = await import("./reviewSurfaces.testkit");
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

  /**
   * A thread with these messages: [author, body, written at?, rewritten
   * at?, comment id?].
   */
  const conversation = (
    id: string,
    line: number | null,
    messages: [string, string, string?, string?, string?][],
    extra: Partial<ReviewThread> = {},
  ): ReviewThread => {
    const base = thread(id, "a.ts", line ?? 1, "");
    return {
      ...base,
      anchor: line === null ? {} : base.anchor,
      comments: messages.map(([author, body, at, editedAt, commentId], i) => {
        const createdAt = at ?? `2026-11-04T14:1${i}:00Z`;
        return {
          id: commentId ?? `${id}c${i}`,
          author,
          body,
          createdAt,
          updatedAt: editedAt ?? createdAt,
        };
      }),
      ...extra,
    } as ReviewThread;
  };

  type Surface = Awaited<ReturnType<(typeof REVIEW_SURFACES)[0]["mount"]>>;
  /** A thread as shown, or null when it is not. */
  const shown = (review: Surface, id: string) =>
    review.shownThreads().find((each) => each.id === id) ?? null;
  /** The texts of a thread's messages, or null when it is not shown. */
  const texts = (review: Surface, id: string) =>
    shown(review, id)?.messages.map((message) => message.text) ?? null;
  /** The message n / N selected. */
  const selected = (review: Surface) =>
    review
      .shownThreads()
      .flatMap((each) => each.messages)
      .find((message) => message.selected)?.text ?? null;
  /** The last call the bridge had of a method. */
  const lastCall = (review: Surface, method: string) => {
    const calls = review.calls(method);
    return calls[calls.length - 1];
  };
  /** The agent the comments go to: Claude, in the workspace's pane. */
  const claude = { agent: { name: "Claude", paneId: "w1:p1" } };

  for (const { name, mount } of REVIEW_SURFACES)
    describe(name, () => {
      test("resolved threads start folded to a line; za and a click fold and unfold a thread", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two."],
            ]),
            conversation("t2", 5, [["you", "Done here\nsecond line"]], {
              resolved: true,
            }),
          ],
        });
        expect(shown(review, "t1")).toMatchObject({
          folded: false,
          resolved: false,
        });
        // Folded to its first line, said resolved.
        expect(shown(review, "t2")).toMatchObject({
          folded: true,
          resolved: true,
          summary: "Done here",
        });
        expect(review.text()).toContain("✓ Resolved");
        expect(review.text()).toContain("1 message");

        // za on its line unfolds it, still resolved; Fold folds it back.
        await review.command(":5");
        expect(review.cursorLine()?.text).toBe("a.ts line 5");
        await review.press("za");
        expect(shown(review, "t2")).toMatchObject({
          folded: false,
          resolved: true,
        });
        expect(texts(review, "t2")?.[0]).toContain("second line");
        expect(shown(review, "t2")?.buttons).toEqual([
          "Reply",
          "Reopen",
          "Fold",
        ]);
        await review.threadButton("t2", "Fold");
        expect(shown(review, "t2")?.folded).toBe(true);
        // A click on the folded line unfolds it; za folds it again.
        await review.clickThread("t2");
        expect(shown(review, "t2")?.folded).toBe(false);
        await review.press("za");
        expect(shown(review, "t2")?.folded).toBe(true);

        // An open thread folds too, without being resolved.
        await review.command(":3");
        await review.press("za");
        expect(shown(review, "t1")).toMatchObject({
          folded: true,
          resolved: false,
          summary: "Why one?",
        });
        expect(review.text()).toContain("▸ Folded");
        expect(review.text()).toContain("2 messages");
        expect(review.calls("review.resolve")).toEqual([]);
        await review.press("za");
        expect(shown(review, "t1")?.folded).toBe(false);

        // No thread on the line: nothing to fold.
        await review.press("gg");
        await review.press("za");
        expect(review.notice()).toBe("No comment to fold on this line.");
        await review.unmount();
      });

      test("a thread's buttons reply, resolve and reopen, edit your message and delete it, u undoing the delete", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two."],
            ]),
            conversation("d1", 6, [["you", "A review note"]], {
              kind: "draft",
            }),
          ],
        });
        const t1 = shown(review, "t1")!;
        // The agent's message is neither edited nor deleted (dd leaves it
        // too); yours is edited; the thread is answered or resolved.
        expect(t1.messages.map((message) => message.buttons)).toEqual([
          [],
          ["Edit"],
        ]);
        expect(t1.buttons).toEqual(["Reply", "Resolve"]);
        // A review comment (a draft) is edited or deleted, not answered.
        expect(shown(review, "d1")?.messages[0]?.buttons).toEqual([
          "Edit",
          "Delete",
        ]);
        expect(shown(review, "d1")?.buttons).toEqual([]);

        await review.threadButton("t1", "Reply");
        expect(review.editorOpen()).toBe(true);
        await review.writeInEditor("Three, then.");
        await review.editorButton("Save");
        expect(lastCall(review, "review.reply")?.params).toMatchObject({
          comment_id: "t1",
          text: "Three, then.",
        });

        await review.threadButton("t1", "Resolve");
        expect(lastCall(review, "review.resolve")?.params).toMatchObject({
          comment_id: "t1",
          resolved: true,
        });
        await review.push({
          threads: [
            conversation(
              "t1",
              3,
              [
                ["Claude", "Why one?"],
                ["you", "Two."],
              ],
              { resolved: true },
            ),
          ],
        });
        await review.clickThread("t1");
        await review.threadButton("t1", "Reopen");
        expect(lastCall(review, "review.resolve")?.params).toMatchObject({
          comment_id: "t1",
          resolved: false,
        });

        await review.push({
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two."],
            ]),
            conversation("d1", 6, [["you", "A review note"]], {
              kind: "draft",
            }),
          ],
        });
        // Unfolded while resolved, it stays open once reopened, as any
        // open thread.
        expect(shown(review, "t1")).toMatchObject({
          folded: false,
          resolved: false,
        });
        await review.threadButton("t1", "Edit", 1);
        expect(review.editorOpen()).toBe(true);
        expect(review.text()).toContain("Two.");
        await review.writeInEditor("Two, really.");
        await review.editorButton("Save");
        expect(lastCall(review, "review.edit")?.params).toMatchObject({
          comment_id: "t1c1",
          text: "Two, really.",
        });

        await review.threadButton("d1", "Delete", 0);
        expect(lastCall(review, "review.delete")?.params).toMatchObject({
          comment_id: "d1",
        });
        expect(review.notice()).toBe("Comment deleted (u undoes)");
        await review.press("u");
        expect(lastCall(review, "review.restore")?.params).toMatchObject({
          thread: { id: "d1" },
        });
        await review.unmount();
      });

      test("a message is marked edited, a forge draft, and how it goes to the agent", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          session: { ...claude, deliveredAt: "2026-11-04T14:20:00Z" },
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two.", "2026-11-04T14:11:00Z", "2026-11-04T14:15:00Z"],
            ]),
            conversation("t2", 5, [["you", "Later", "2026-11-04T14:30:00Z"]]),
            conversation("d1", 8, [["you", "On GitLab"]], {
              kind: "draft",
              gitlab: { draftId: 7 },
            } as Partial<ReviewThread>),
          ],
        });
        const t1 = shown(review, "t1")!;
        // Rewritten after it was written: edited. Before deliveredAt: gone
        // to the agent.
        expect(t1.messages[1]?.marks).toEqual(["→ Claude", "edited"]);
        expect(t1.messages[0]?.marks).toEqual([]);
        expect(review.text()).toContain("You");
        // Written after: on its way.
        expect(shown(review, "t2")?.messages[0]?.marks).toEqual([
          "→ Claude...",
        ]);
        expect(shown(review, "d1")?.messages[0]?.marks).toEqual([
          "GitLab draft",
        ]);
        await review.unmount();
      });

      test("each thread says how your comments go to the agent: sent, on its way, held, not delivered with Retry, not sent", async () => {
        const mine = (updatedAt: string) =>
          conversation("t1", 3, [
            ["Claude", "Why one?"],
            ["you", "Two.", "2026-11-04T14:11:00Z", updatedAt],
          ]);
        const review = await mount({
          files: [added("a.ts", 12)],
          session: claude,
          threads: [mine("2026-11-04T14:11:00Z")],
        });
        const marks = () => shown(review, "t1")?.messages[1]?.marks;
        // The agent has its pane: on its way.
        expect(marks()).toEqual(["→ Claude..."]);
        await review.push({ session: { deliveredAt: "2026-11-04T14:12:00Z" } });
        expect(marks()).toEqual(["→ Claude"]);
        // Rewritten since: on its way again.
        await review.push({ threads: [mine("2026-11-04T14:13:00Z")] });
        expect(marks()).toEqual(["→ Claude...", "edited"]);
        // Held for Send.
        await review.push({ session: { holdComments: true } });
        expect(marks()).toEqual(["held for Claude", "edited"]);
        // Not delivered: why, with Retry, which sends again (the pane known).
        await review.push({
          session: {
            holdComments: false,
            deliveryError: "herdr: pane not found",
          },
        });
        expect(marks()).toEqual([
          "not delivered: herdr: pane not found",
          "edited",
        ]);
        expect(shown(review, "t1")?.messages[1]?.buttons).toEqual([
          "Retry",
          "Edit",
        ]);
        await review.threadButton("t1", "Retry", 1);
        expect(review.calls("review.handoff")).toHaveLength(1);
        // An agent busy with a question in its pane is retried by the
        // bridge: not a failure on the comment.
        await review.push({
          session: { deliveryError: "agent_blocked: a question is open" },
        });
        expect(marks()).toEqual(["→ Claude...", "edited"]);
        // No comments go out as written (autoSend off): for the agent, not
        // sent.
        await review.push({
          session: { deliveryError: undefined, autoSend: false },
        });
        expect(marks()).toEqual(["for Claude, not sent", "edited"]);
        await review.unmount();
      });

      test("a merge request's review sends your discussions with the agent as written; held back, each says not sent with a Send, and the head has one", async () => {
        const url = "https://gitlab.example/group/project/-/merge_requests/7";
        const mr = {
          target: { kind: "mr" as const, url },
          gitlab: true,
          ...claude,
        };
        const mergeRequest = {
          url,
          title: "Fix",
          state: "opened",
          headSha: "h",
          security: false,
        };
        const review = await mount({
          files: [added("a.ts", 12)],
          session: mr as never,
          mergeRequest,
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two.", "2026-11-04T14:11:00Z"],
            ]),
          ],
        });
        const marks = () => shown(review, "t1")?.messages[1]?.marks;
        // As in a branch's review: on its way to the agent.
        expect(marks()).toEqual(["→ Claude..."]);
        // Held back (sending off, as these reviews once started): not sent,
        // with a Send on the comment and one in the head.
        await review.push({ session: { autoSend: false } });
        expect(marks()).toEqual(["for Claude, not sent"]);
        expect(shown(review, "t1")?.messages[1]?.buttons).toEqual([
          "Send to Claude",
          "Edit",
        ]);
        expect(review.buttons()).toContain("Send 1 to Claude");
        await review.threadButton("t1", "Send to Claude", 1);
        expect(review.calls("review.handoff")).toHaveLength(1);
        await review.unmount();
      });

      test("a merge request's review with no agent in its workspace says so on a comment not sent, with no Send", async () => {
        const url = "https://gitlab.example/group/project/-/merge_requests/7";
        const review = await mount({
          files: [added("a.ts", 12)],
          session: {
            target: { kind: "mr" as const, url },
            gitlab: true,
            agent: {},
          } as never,
          mergeRequest: {
            url,
            title: "Fix",
            state: "opened",
            headSha: "h",
            security: false,
          },
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two.", "2026-11-04T14:11:00Z"],
            ]),
          ],
        });
        expect(shown(review, "t1")?.messages[1]?.marks).toEqual([
          "No agent in this workspace: Copy or pick one",
        ]);
        expect(shown(review, "t1")?.messages[1]?.buttons).toEqual(["Edit"]);
        expect(review.buttons().some((label) => label.startsWith("Send"))).toBe(
          false,
        );
        await review.unmount();
      });

      test("a write on its way says Sending...; failed, Not saved with Retry and Discard, the text kept", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [conversation("t1", 3, [["Claude", "Why one?"]])],
        });
        const sending = review.holdBridge("review.reply");
        await review.threadButton("t1", "Reply");
        await review.writeInEditor("Because.");
        await review.editorButton("Save");
        const reply = () => shown(review, "t1")?.messages[1];
        expect(reply()).toMatchObject({
          text: "Because.",
          pending: "sending",
          marks: ["Sending..."],
          buttons: [],
        });
        // The thread can still be answered and resolved meanwhile.
        expect(shown(review, "t1")?.buttons).toEqual(["Reply", "Resolve"]);
        await sending.release("timeout: review.reply");
        expect(reply()).toMatchObject({
          text: "Because.",
          pending: "failed",
          marks: ["Not saved: timeout: review.reply"],
          buttons: ["Retry", "Discard"],
        });
        // Retry sends it again, with the same id.
        review.failBridge(["review.reply"], "still down");
        await review.threadButton("t1", "Retry", 1);
        const sent = review.calls("review.reply");
        expect(sent).toHaveLength(2);
        expect(sent[1]?.params.new_comment_id).toBe(
          sent[0]?.params.new_comment_id,
        );
        expect(reply()?.marks).toEqual(["Not saved: still down"]);
        // Discard forgets it; its text waits in the reply's editor.
        review.failBridge([]);
        await review.threadButton("t1", "Discard", 1);
        expect(texts(review, "t1")).toEqual(["Why one?"]);
        expect(review.notice()).toBe(
          "Not sent. Reopen the comment to find your text.",
        );
        await review.threadButton("t1", "Reply");
        expect(review.notice()).toBe(
          "Your unsent text is back. Cmd+Enter sends it.",
        );
        expect(review.text()).toContain("Because.");
        await review.unmount();
      });

      test("after each write the review is read back, so a lost push loses no comment", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [["Claude", "Why one?"]]),
            conversation("t2", 8, [["you", "Mine"]]),
          ],
        });
        // The bridge has the answer, under the id it was sent with, but
        // its push never comes.
        review.bridgeHolds(() => ({
          threads: [
            conversation("t2", 8, [["you", "Mine"]]),
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              [
                "you",
                "Because.",
                undefined,
                undefined,
                String(review.calls("review.reply")[0]?.params.new_comment_id),
              ],
            ]),
          ],
        }));
        await review.threadButton("t1", "Reply");
        await review.writeInEditor("Because.");
        await review.editorButton("Save");
        expect(review.calls("review.get")).toHaveLength(1);
        expect(shown(review, "t1")?.messages).toMatchObject([
          { text: "Why one?", pending: null },
          { text: "Because.", pending: null },
        ]);
        // Every write is read back; other calls are not.
        await review.threadButton("t1", "Resolve");
        expect(review.calls("review.get")).toHaveLength(2);
        await review.threadButton("t2", "Delete", 0);
        expect(review.calls("review.get")).toHaveLength(3);
        await review.press("v");
        expect(review.calls("review.update").length).toBeGreaterThan(0);
        expect(review.calls("review.get")).toHaveLength(3);
        await review.unmount();
      });

      test("t and :comments hide every comment, their lines still marked; n / N then go line to line, a click on one shows them", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [["Claude", "Why one?"]]),
            conversation("t2", 8, [["you", "Here too"]]),
          ],
        });
        expect(review.shownThreads().map((each) => each.id)).toEqual([
          "t1",
          "t2",
        ]);
        expect(review.markedLines().map((line) => line.new)).toEqual([3, 8]);
        expect(review.commentsHidden()).toBe(false);
        await review.press("t");
        expect(review.commentsHidden()).toBe(true);
        expect(review.shownThreads()).toEqual([]);
        // The margin still says where they are, and the button how many.
        expect(review.markedLines().map((line) => line.new)).toEqual([3, 8]);
        expect(review.hiddenBadge()).toBe(2);
        await review.press("n");
        expect(review.cursorLine()?.new).toBe(3);
        await review.press("n");
        expect(review.cursorLine()?.new).toBe(8);
        await review.press("N");
        expect(review.cursorLine()?.new).toBe(3);
        await review.press("t");
        expect(review.commentsHidden()).toBe(false);
        expect(review.shownThreads()).toHaveLength(2);
        await review.command(":comments");
        expect(review.commentsHidden()).toBe(true);
        await review.command(":comments");
        expect(review.commentsHidden()).toBe(false);
        // Hidden, a click on a commented line shows them rather than
        // writing a new comment.
        await review.press("t");
        await review.click({ path: "a.ts", new: 8 });
        expect(review.commentsHidden()).toBe(false);
        expect(review.editorOpen()).toBe(false);
        await review.unmount();
      });

      test("hidden comments are not remembered, and show again on a new answer of the agent or as you write one", async () => {
        const first = conversation("t1", 3, [["Claude", "Why one?"]]);
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [first],
        });
        await review.press("t");
        expect(review.commentsHidden()).toBe(true);
        await review.reload();
        expect(review.commentsHidden()).toBe(false);

        // The agent answers: shown, never missed.
        await review.press("t");
        await review.push({
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two."],
              ["Claude", "Fine."],
            ]),
          ],
        });
        expect(review.commentsHidden()).toBe(false);
        // Your own message does not.
        await review.press("t");
        await review.push({
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two."],
              ["Claude", "Fine."],
              ["you", "Ok."],
            ]),
          ],
        });
        expect(review.commentsHidden()).toBe(true);

        // Writing a new comment shows them.
        await review.press("4jc");
        expect(review.editorOpen()).toBe(true);
        await review.writeInEditor("A new one here");
        await review.editorButton("Save");
        expect(review.commentsHidden()).toBe(false);
        await review.unmount();
      });

      test("n and N go message by message through the threads; Tab and Shift+Tab too, even while n follows a search", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [
              ["Claude", "Why one?"],
              ["you", "Two."],
            ]),
            conversation("t2", 8, [["you", "Here too"]]),
          ],
        });
        expect(selected(review)).toBeNull();
        await review.press("n");
        expect(selected(review)).toBe("Why one?");
        expect(review.cursorLine()?.new).toBe(3);
        await review.press("n");
        expect(selected(review)).toBe("Two.");
        await review.press("n");
        expect(selected(review)).toBe("Here too");
        expect(review.cursorLine()?.new).toBe(8);
        // Past the last one, n wraps around to the first; N back.
        await review.press("n");
        expect(selected(review)).toBe("Why one?");
        expect(review.cursorLine()?.new).toBe(3);
        await review.press("N");
        expect(selected(review)).toBe("Here too");
        await review.press("N");
        expect(selected(review)).toBe("Two.");
        await review.press("<S-Tab>");
        expect(selected(review)).toBe("Why one?");
        await review.press("<Tab>");
        expect(selected(review)).toBe("Two.");

        // A search: n / N go to its matches, Tab still to the messages.
        // * looks for the word under the cursor ("a", of a.ts), from the
        // next one on.
        await review.press("gg*");
        expect(review.text()).toContain("match 2 of 12");
        await review.press("n");
        expect(review.text()).toContain("match 3 of 12");
        await review.press("<Tab>");
        expect(selected(review)).toBe("Why one?");
        await review.unmount();
      });

      test("N before the first message wraps around to the last, and n past the last to the first; hidden, line to line too", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [["Claude", "Why one?"]]),
            conversation("t2", 8, [
              ["you", "Here too"],
              ["Claude", "Done."],
            ]),
          ],
        });
        expect(review.cursorLine()?.new).toBe(1);
        // Nothing before the cursor: N goes around to the last message.
        await review.press("N");
        expect(selected(review)).toBe("Done.");
        expect(review.cursorLine()?.new).toBe(8);
        await review.press("N");
        expect(selected(review)).toBe("Here too");
        await review.press("N");
        expect(selected(review)).toBe("Why one?");
        await review.press("N");
        expect(selected(review)).toBe("Done.");
        await review.press("n");
        expect(selected(review)).toBe("Why one?");
        expect(review.cursorLine()?.new).toBe(3);
        // Hidden, from line to line, around too.
        await review.press("t");
        expect(review.commentsHidden()).toBe(true);
        await review.press("N");
        expect(review.cursorLine()?.new).toBe(8);
        await review.press("n");
        expect(review.cursorLine()?.new).toBe(3);
        await review.unmount();
      });

      test("comments on the whole review show above the diff; n past the last wraps to them, N and k reach them, message by message", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          threads: [
            conversation("t1", 3, [["Claude", "On a line"]]),
            conversation("g1", null, [
              ["you", "Overall, fine"],
              ["Claude", "Thanks"],
            ]),
          ],
        });
        expect(
          review.shownThreads().map((each) => [each.id, each.general]),
        ).toEqual([
          ["g1", true],
          ["t1", false],
        ]);
        // Above the first line: n goes on from the cursor, to the lines'
        // threads, and past the last wraps around to the review's.
        await review.press("n");
        expect(selected(review)).toBe("On a line");
        expect(review.cursorLine()?.new).toBe(3);
        await review.press("n");
        expect(selected(review)).toBe("Overall, fine");
        await review.press("n");
        expect(selected(review)).toBe("Thanks");
        await review.press("n");
        expect(selected(review)).toBe("On a line");
        // N comes back up to the review's, message by message.
        await review.press("N");
        expect(selected(review)).toBe("Thanks");
        await review.press("N");
        expect(selected(review)).toBe("Overall, fine");
        // j goes down from there, through the review's messages to the
        // first line.
        await review.press("j");
        expect(selected(review)).toBe("Thanks");
        await review.press("j");
        expect(selected(review)).toBeNull();
        expect(review.cursorLine()?.new).toBe(1);
        await review.unmount();
      });

      test("the status line says when the agent waits for an answer, could not get the comments, reviews, works, and unsent drafts kept", async () => {
        const review = await mount({
          files: [added("a.ts", 12)],
          session: claude,
        });
        expect(review.status()).toBe("");
        await review.push({
          session: { deliveryError: "agent_blocked: a question is open" },
        });
        expect(review.status()).toBe(
          "Claude is waiting for an answer in its pane; your comments go to it once it is free.",
        );
        await review.push({
          session: { deliveryError: "herdr: pane not found" },
        });
        expect(review.status()).toBe(
          "Your comments were not delivered to Claude: herdr: pane not found (Retry on a comment, or Send)",
        );
        await review.push({
          session: {
            deliveryError: undefined,
            agent: {
              ...claude.agent,
              working: {
                message: "reading a.ts",
                at: new Date().toISOString(),
              },
            },
          },
        });
        expect(review.status()).toBe("Claude is working: reading a.ts");
        await review.push({
          session: {
            agent: { ...claude.agent, update: { message: "Done, 2 notes" } },
          },
        });
        expect(review.status()).toBe("Claude: Done, 2 notes");
        await review.push({
          session: {
            agent: {
              ...claude.agent,
              working: {
                message: "reviewing",
                at: new Date(Date.now() - 12_000).toISOString(),
              },
            },
          },
        });
        expect(review.status()).toMatch(
          /^Claude is reviewing, reading the code where needed \(1[23] s\)\.\.\.$/,
        );
        // The pass is over: what it left.
        await review.push({
          session: {
            agent: { ...claude.agent, update: { message: "All good." } },
          },
        });
        expect(review.status()).toBe(
          "Claude found nothing to comment on. All good.",
        );
        // Said until the agent works again: its status then shows.
        await review.push({
          session: {
            agent: {
              ...claude.agent,
              working: {
                message: "reading b.ts",
                at: new Date().toISOString(),
              },
            },
          },
        });
        expect(review.status()).toBe("Claude is working: reading b.ts");

        // Text left in an editor as the review went away: said once back.
        await review.push({ session: { agent: claude.agent } });
        await review.press("4jc");
        await review.writeInEditor("Half a thought");
        await review.reload();
        expect(review.status()).toBe(
          "1 unsent draft kept: reopen the comment to go on.",
        );
        await review.unmount();
      });
    });
}
