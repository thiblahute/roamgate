import { describe, expect, test } from "bun:test";
import { withoutGateFlags } from "../workspace/forge-calls";
import {
  createDraftNote,
  parseMergeRequestUrl,
  readMergeRequest,
  readMergeRequestDiff,
  readMergeRequestThreads,
  replyToDiscussion,
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
    const threads = await readMergeRequestThreads(ctx, mr, "s");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments.map((c) => c.author)).toEqual(["@bob", "@me"]);
    expect(threads[0]!.anchor).toMatchObject({
      path: "a.c",
      line: 1,
      side: "new",
    });
    // Every call is a read with gh.
    expect(
      calls.every((argv) => argv[0] === "gh" && argv.includes("GET")),
    ).toBe(true);
  });

  test("no write reaches GitHub through the GitLab draft calls", async () => {
    const { context: ctx, calls } = context({});
    const mr = {
      host: "github.com",
      project: "o/r",
      iid: 7,
      forge: "github" as const,
      url: URL,
      title: "",
      state: "opened",
      baseSha: "",
      startSha: "",
      headSha: "",
    };
    await expect(createDraftNote(ctx, mr, {}, "x")).rejects.toThrow(/GitHub/);
    await expect(replyToDiscussion(ctx, mr, "1", "x")).rejects.toThrow(
      /GitHub/,
    );
    expect(calls).toEqual([]);
  });
});
