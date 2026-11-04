import { describe, expect, test } from "bun:test";
import type { MrItem } from "../../../shared/mrReviews";
import {
  githubSearchQuery,
  githubSearchString,
  gitlabRequestQuery,
  gitlabSearchQuery,
  parseGithubSearch,
  parseGitlabSearch,
  parseRequest,
  parseRequestRef,
  searchDate,
} from "./agent-search";

const glNode = (iid: number, extra: Record<string, unknown> = {}) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://gl.example/g/p/-/merge_requests/${iid}`,
  draft: false,
  state: "opened",
  updatedAt: "2026-11-01T00:00:00Z",
  userNotesCount: 1,
  diffHeadSha: "a".repeat(40),
  sourceBranch: "x",
  targetBranch: "main",
  project: { fullPath: "g/p" },
  author: { username: "alice" },
  headPipeline: null,
  diffRefs: { baseSha: "b".repeat(40) },
  labels: { nodes: [{ title: "ges" }] },
  ...extra,
});

const item = (n: number, extra: Partial<MrItem> = {}): MrItem => ({
  provider: "gitlab",
  host: "gl.example",
  project: "g/p",
  number: n,
  key: `gitlab:gl.example/g/p#${n}`,
  url: `https://gl.example/g/p/-/merge_requests/${n}`,
  title: `MR ${n}`,
  author: "alice",
  draft: false,
  state: "open",
  updatedAt: "2026-11-01T00:00:00Z",
  headSha: "a".repeat(40),
  sourceBranch: "x",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: [],
  ...extra,
});

describe("reviews agent searches", () => {
  test("GitLab: one read-only query, the model's words quoted", () => {
    const query = gitlabSearchQuery(["g/p", "g/q"], {
      text: 'x") } mutation { y',
      labels: ["ges"],
      author: "bob",
      updatedAfter: "2026-10-01",
      state: "opened",
      first: 20,
    });
    expect(query.startsWith("query {")).toBe(true);
    // The injection stays inside its string.
    expect(query).toContain('search: "x\\") } mutation { y"');
    expect(query).toContain('p1: project(fullPath: "g/q")');
    expect(query).toContain('labels: ["ges"]');
    expect(query).toContain('authorUsername: "bob"');
    expect(query).toContain('updatedAfter: "2026-10-01"');
    expect(query).toContain("state: opened");
    expect(
      gitlabSearchQuery(["g/p"], { state: "all", first: 5 }),
    ).not.toContain("state:");
  });

  test("GitHub: the followed repositories and filters as search qualifiers", () => {
    expect(
      githubSearchString(["o/r"], {
        text: "rtp jitter",
        labels: ['bug"x'],
        author: "carol",
        updatedAfter: "2026-10-01T00:00:00Z",
        state: "merged",
        first: 10,
      }),
    ).toBe(
      'is:pr archived:false repo:o/r is:merged label:"bugx" author:carol updated:>=2026-10-01 rtp jitter',
    );
    expect(githubSearchQuery(["o/r"], { state: "opened", first: 3 })).toMatch(
      /^query \{ s: search\(type: ISSUE, query: "is:pr archived:false repo:o\/r is:open", first: 3\)/,
    );
  });

  test("dates: ISO dates and days back, nothing else", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(searchDate("7d", now)).toBe("2026-10-28");
    expect(searchDate("2026-10-01", now)).toBe("2026-10-01");
    expect(searchDate("yesterday", now)).toBeNull();
    expect(searchDate('2026-10-01" }', now)).toBeNull();
  });

  test("answers: requests with their files and labels; projects not seen", () => {
    const parsed = parseGitlabSearch("gl.example", ["g/p", "g/gone"], {
      data: {
        p0: {
          mergeRequests: {
            nodes: [glNode(5, { diffStats: [{ path: "ges/ges-clip.c" }] })],
          },
        },
        p1: null,
      },
    });
    expect(parsed.missing).toEqual(["g/gone"]);
    expect(parsed.found[0]!.item).toMatchObject({
      key: "gitlab:gl.example/g/p#5",
      files: ["ges/ges-clip.c"],
    });
    expect(parsed.found[0]!.labels).toEqual(["ges"]);
    const github = parseGithubSearch("github.com", {
      data: {
        s: {
          nodes: [
            {
              number: 9,
              title: "t",
              url: "https://github.com/o/r/pull/9",
              isDraft: false,
              state: "OPEN",
              updatedAt: "2026-11-01T00:00:00Z",
              headRefOid: "c".repeat(40),
              headRefName: "h",
              baseRefName: "main",
              repository: { nameWithOwner: "o/r" },
              author: { login: "dan" },
              files: { nodes: [{ path: "src/a.rs" }] },
              labels: { nodes: [{ name: "rtp" }] },
            },
          ],
        },
      },
    });
    expect(github.found[0]!.item.files).toEqual(["src/a.rs"]);
    expect(github.found[0]!.item.drafts).toBeUndefined();
    expect(() =>
      parseGitlabSearch("h", [], { errors: [{ message: "no" }] }),
    ).toThrow("GitLab: no");
  });

  test("one request: its changes and description", () => {
    const ref = {
      provider: "gitlab" as const,
      host: "gl.example",
      project: "g/p",
      number: 5,
    };
    expect(gitlabRequestQuery(ref)).toContain('mergeRequest(iid: "5")');
    const found = parseRequest(ref, {
      data: {
        project: {
          mergeRequest: glNode(5, {
            description: "Fixes trimming.",
            diffStats: [{ path: "ges/a.c", additions: 3, deletions: 1 }],
          }),
        },
      },
    });
    expect(found?.description).toBe("Fixes trimming.");
    expect(found?.changes).toEqual([
      { path: "ges/a.c", additions: 3, deletions: 1 },
    ]);
    // Another request than the one asked is not taken.
    expect(
      parseRequest(
        { ...ref, number: 6 },
        { data: { project: { mergeRequest: glNode(5) } } },
      ),
    ).toBeNull();
  });

  test("a request named as the agent names it", () => {
    const hosts = [
      { host: "gl.example", provider: "gitlab" as const },
      { host: "github.com", provider: "github" as const },
    ];
    const known = [
      item(12967),
      item(3, { project: "g/q", key: "gitlab:gl.example/g/q#3" }),
      item(3),
    ];
    expect(parseRequestRef("!12967", known, hosts)).toMatchObject({
      number: 12967,
      project: "g/p",
    });
    expect(parseRequestRef("!3", known, hosts)).toMatchObject({
      ambiguous: [{ project: "g/q" }, { project: "g/p" }],
    });
    expect(parseRequestRef("g/q!3", known, hosts)).toMatchObject({
      project: "g/q",
    });
    expect(parseRequestRef("other/x!8", known, hosts)).toEqual({
      provider: "gitlab",
      host: "gl.example",
      project: "other/x",
      number: 8,
    });
    expect(
      parseRequestRef("https://github.com/o/r/pull/4", known, hosts),
    ).toEqual({
      provider: "github",
      host: "github.com",
      project: "o/r",
      number: 4,
    });
    // Not one of the user's hosts.
    expect(
      parseRequestRef("https://evil.example/o/r/pull/4", known, hosts),
    ).toBeNull();
    expect(parseRequestRef("!999", known, hosts)).toBeNull();
  });
});
