import { describe, expect, test } from "bun:test";
import { withoutGateFlags } from "../workspace/forge-calls";
import { createInboxFetchers, NotSignedInError } from "./fetchers";

describe("inbox fetchers", () => {
  test("GitHub: one graphql read; its data even with errors", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(withoutGateFlags(argv));
      if (argv.includes("auth")) return { code: 0, stdout: "", stderr: "" };
      return {
        code: 1,
        stdout: '{"data":{"viewer":{"login":"me"}},"errors":[{"message":"x"}]}',
        stderr: "gh: x",
      };
    };
    const fetchers = createInboxFetchers(run);
    const answer = (await fetchers.github(
      "github.com",
      "query { viewer { login } }",
    )) as any;
    expect(answer.data.viewer.login).toBe("me");
    const graphql = calls.find((argv) => argv.includes("graphql"))!;
    expect(graphql.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(
      graphql.some(
        (part) => /--method|POST|-X/.test(part) && part !== "graphql",
      ),
    ).toBe(false);
  });

  test("GitHub without a login is said so, nothing asked", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      return { code: 1, stdout: "", stderr: "not logged in" };
    };
    await expect(
      createInboxFetchers(run).github("ghe.example.com", "query {}"),
    ).rejects.toBeInstanceOf(NotSignedInError);
    expect(calls.some((argv) => argv.includes("graphql"))).toBe(false);
  });

  test("GitLab: the graphql query and draft notes are reads", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      // glab's host check script.
      if (!argv.includes("api"))
        return { code: 0, stdout: "glab gitlab.example.org\n", stderr: "" };
      calls.push(withoutGateFlags(argv));
      return {
        code: 0,
        stdout: argv.includes("graphql") ? '{"data":{}}' : "[{},{}]",
        stderr: "",
      };
    };
    const fetchers = createInboxFetchers(run);
    await fetchers.gitlab("gitlab.example.org", "query {}");
    const count = await fetchers.gitlabDrafts({
      host: "gitlab.example.org",
      project: "g/p",
      number: 3,
    } as any);
    expect(count).toBe(2);
    expect(calls[0]).toContain("graphql");
    expect(calls[0]).toContain("POST");
    const drafts = calls[1]!;
    expect(drafts).toContain("GET");
    expect(drafts.join(" ")).toContain(
      "projects/g%2Fp/merge_requests/3/draft_notes",
    );
  });
});
