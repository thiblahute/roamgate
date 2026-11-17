import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerSshMaster,
  runSshCommand,
  unregisterSshMaster,
} from "../bridge/ssh-sessions";
import { withoutGateFlags } from "../workspace/forge-calls";
import { ghApi } from "./github";
import {
  createDraftNote,
  createDraftReply,
  deleteDraftNote,
  updateDraftNote,
  parseMergeRequestUrl,
  readMergeRequest,
  readMergeRequestDiff,
  readMergeRequestThreads,
} from "./gitlab";

function context(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  return {
    calls,
    context: {
      root: "/tmp",
      shQuote: (value: string) => `'${value}'`,
      runProcessWithCodeTimeout: async (argv: string[]) => {
        const plain = withoutGateFlags(argv);
        calls.push(plain);
        if (plain.includes("graphql"))
          return {
            code: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: { id: "PR", reviews: { nodes: [] } },
                },
              },
            }),
            stderr: "",
          };
        const path = plain.find((part) => part.startsWith("repos/")) ?? "";
        const key = Object.keys(answers).find((prefix) =>
          path.startsWith(prefix),
        );
        return key
          ? { code: 0, stdout: JSON.stringify(answers[key]), stderr: "" }
          : { code: 1, stdout: "", stderr: `no answer for ${path}` };
      },
    },
  };
}

const URL = "https://github.com/o/r/pull/7";

describe("GitHub pull requests in the review pane", () => {
  test("a pull request URL is a merge request reference", () => {
    expect(parseMergeRequestUrl(`${URL}/files`)).toEqual({
      host: "github.com",
      project: "o/r",
      iid: 7,
    });
  });

  test("reads the pull request, its diff and its comment threads", async () => {
    const { context: ctx, calls } = context({
      // GitHub's shape of a pull request's conversation (issue) comments.
      "repos/o/r/issues/7/comments": [
        {
          id: 3501,
          body: "Thanks! Could you add a test?",
          user: { login: "reviewer" },
          created_at: "2026-11-01T10:00:00Z",
          updated_at: "2026-11-01T10:00:00Z",
          author_association: "MEMBER",
        },
      ],
      "repos/o/r/pulls/7/files": [
        {
          filename: "a.c",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
      "repos/o/r/pulls/7/comments": [
        {
          id: 1,
          path: "a.c",
          line: 1,
          side: "RIGHT",
          body: "why?",
          user: { login: "bob" },
          created_at: "t",
        },
        {
          id: 2,
          in_reply_to_id: 1,
          path: "a.c",
          body: "because",
          user: { login: "me" },
          created_at: "t2",
        },
      ],
      "repos/o/r/pulls/7": {
        html_url: URL,
        title: "T",
        state: "open",
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
      },
    });
    const mr = await readMergeRequest(ctx, URL);
    expect(mr).toMatchObject({
      forge: "github",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      state: "opened",
    });
    const diff = await readMergeRequestDiff(ctx, mr);
    expect(diff.files.map((file) => file.path)).toEqual(["a.c"]);
    const all = await readMergeRequestThreads(ctx, mr, "s");
    // The conversation comment: a general thread, with no draft reply.
    const general = all.filter((thread) => !thread.anchor.path);
    expect(
      general.map((thread) => [
        thread.id,
        thread.comments[0]!.author,
        thread.gitlab?.discussionId,
      ]),
    ).toEqual([["ghc:3501", "@reviewer", undefined]]);
    const threads = all.filter((thread) => thread.anchor.path);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments.map((c) => c.author)).toEqual(["@bob", "@me"]);
    expect(threads[0]!.anchor).toMatchObject({
      path: "a.c",
      line: 1,
      side: "new",
    });
    // Every call is a read with gh.
    expect(
      calls.every(
        (argv) =>
          argv[0] === "gh" &&
          (argv.includes("GET") ||
            (argv.includes("graphql") && !argv.join(" ").includes("mutation"))),
      ),
    ).toBe(true);
  });

  test("drafts are the user's pending review; replies and submits never", async () => {
    const calls: string[][] = [];
    let pending: any = null;
    const comments: any[] = [];
    const ctx = {
      root: "/tmp",
      shQuote: (value: string) => `'${value}'`,
      runProcessWithCodeTimeout: async (argv: string[]) => {
        const plain = withoutGateFlags(argv);
        calls.push(plain);
        const query =
          plain.find((part) => part.startsWith("query="))?.slice(6) ?? "";
        const field = (name: string) =>
          plain
            .find((part) => part.startsWith(`${name}=`))
            ?.slice(name.length + 1);
        let data: any;
        if (query.includes("reviews(states: PENDING")) {
          // GitHub's shape: the side is the thread's, a comment names its
          // review, and fullDatabaseId is a string (no databaseId).
          expect(query).not.toMatch(/\bdatabaseId\b/);
          expect(query).toContain("reviewThreads");
          data = {
            repository: {
              pullRequest: {
                id: "PR1",
                reviews: { nodes: pending ? [pending] : [] },
                reviewThreads: {
                  nodes: [
                    // A published thread of someone else: not a draft.
                    {
                      id: "T0",
                      diffSide: "LEFT",
                      comments: {
                        nodes: [
                          {
                            id: "X1",
                            fullDatabaseId: "5",
                            body: "old",
                            path: "a.c",
                            line: 1,
                            originalLine: 1,
                            startLine: null,
                            replyTo: null,
                            pullRequestReview: { id: "R0" },
                          },
                        ],
                      },
                    },
                    ...comments.map((comment) => ({
                      diffSide: "RIGHT",
                      comments: { nodes: [comment] },
                    })),
                  ],
                },
              },
            },
          };
        } else if (query.includes("addPullRequestReview(")) {
          pending = { id: "R1", body: "" };
          data = {
            addPullRequestReview: {
              pullRequestReview: { id: "R1", state: "PENDING" },
            },
          };
        } else if (query.includes("addPullRequestReviewThread(")) {
          const comment = {
            id: "C9",
            fullDatabaseId: "9",
            body: field("body"),
            path: field("path"),
            line: 3,
            originalLine: 3,
            startLine: null,
            replyTo: null,
            pullRequestReview: { id: "R1" },
          };
          comments.push(comment);
          data = {
            addPullRequestReviewThread: {
              thread: { diffSide: "RIGHT", comments: { nodes: [comment] } },
            },
          };
        } else if (query.includes("addPullRequestReviewThreadReply")) {
          expect(field("t")).toBe("T0");
          expect(field("r")).toBe("R1");
          data = {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "C10",
                fullDatabaseId: "10",
                body: field("b"),
                path: "a.c",
                line: 1,
                originalLine: 1,
                startLine: null,
                replyTo: { fullDatabaseId: "5" },
                pullRequestReview: { id: "R1" },
              },
            },
          };
        } else if (query.includes("updatePullRequestReviewComment")) {
          comments[0].body = field("b");
          data = {
            updatePullRequestReviewComment: {
              pullRequestReviewComment: comments[0],
            },
          };
        } else if (query.includes("deletePullRequestReviewComment")) {
          comments.splice(0, 1);
          data = {
            deletePullRequestReviewComment: { pullRequestReview: { id: "R1" } },
          };
        } else if (query.includes("updatePullRequestReview(")) {
          pending.body = field("b");
          data = {
            updatePullRequestReview: { pullRequestReview: { id: "R1" } },
          };
        } else return { code: 1, stdout: "", stderr: "unexpected" };
        return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
      },
    };
    const mr = {
      host: "github.com",
      project: "o/r",
      iid: 7,
      forge: "github" as const,
      url: URL,
      title: "",
      state: "opened",
      baseSha: "b",
      startSha: "b",
      headSha: "a".repeat(40),
    };
    const draft = await createDraftNote(
      ctx,
      mr,
      { path: "a.c", line: 3, side: "new" },
      "nit",
    );
    expect(draft).toMatchObject({
      id: 9,
      note: "nit",
      position: { new_path: "a.c", new_line: 3 },
    });
    expect((await updateDraftNote(ctx, mr, 9, "nit 2")).note).toBe("nit 2");
    await createDraftNote(ctx, mr, {}, "Overall");
    expect(pending.body).toBe("Overall");
    await deleteDraftNote(ctx, mr, 9);
    expect(comments).toEqual([]);
    // A reply is a draft of the pending review, in its discussion.
    await expect(createDraftReply(ctx, mr, "1", "x")).rejects.toThrow(
      /no such discussion/,
    );
    expect(await createDraftReply(ctx, mr, "5", "agreed")).toMatchObject({
      id: 10,
      note: "agreed",
      discussion_id: "5",
    });
    const all = calls.map((argv) => argv.join(" ")).join("\n");
    // Never an event: nothing is submitted.
    expect(all).not.toMatch(
      /submitPullRequestReview|event|APPROVE|COMMENT\b|REQUEST_CHANGES/,
    );
    expect(all).not.toContain("/comments/"); // no public comment
  });
});

describe("gh over SSH", () => {
  test("a dead master reruns a read cold, never a write", async () => {
    const directory = mkdtempSync("/tmp/rg-github-test-");
    const controlPath = join(directory, "m.ctl");
    writeFileSync(controlPath, "");
    let alive = true;
    const owner = {};
    registerSshMaster(owner, {
      destination: "gh-box",
      controlPath,
      isListening: () => true,
      isAlive: async () => alive,
    });
    try {
      let runs = 0;
      const ctx = {
        root: "/tmp",
        host: "gh-box",
        shQuote: (value: string) => `'${value}'`,
        // The master dies under the first, multiplexed run.
        runProcessWithCodeTimeout: (argv: string[]) => {
          alive = true;
          return runSshCommand(argv, async () => {
            runs++;
            if (runs > 1) return { code: 0, stdout: "{}", stderr: "" };
            alive = false;
            return { code: 255, stdout: "", stderr: "" };
          });
        },
      };
      const attempts = async (call: () => Promise<unknown>) => {
        runs = 0;
        await call().catch(() => {});
        return runs;
      };
      const query = (text: string): [string, string, "raw"][] => [
        ["query", text, "raw"],
      ];
      expect(
        await attempts(() =>
          ghApi(ctx, "github.com", "GET", "repos/o/r/pulls/8"),
        ),
      ).toBe(2);
      expect(
        await attempts(() =>
          ghApi(ctx, "github.com", "POST", "graphql", {
            kind: "drafts",
            fields: query("query { viewer { login } }"),
          }),
        ),
      ).toBe(2);
      expect(
        await attempts(() =>
          ghApi(ctx, "github.com", "POST", "graphql", {
            kind: "draft",
            fields: query(
              "mutation($r: ID!) { addPullRequestReviewThread(input: {pullRequestReviewId: $r}) { thread { id } } }",
            ),
          }),
        ),
      ).toBe(1);
      for (const method of ["POST", "PATCH", "DELETE"] as const)
        expect(
          await attempts(() =>
            ghApi(ctx, "github.com", method, "repos/o/r/pulls/8/comments"),
          ),
        ).toBe(1);
    } finally {
      unregisterSshMaster(owner);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
