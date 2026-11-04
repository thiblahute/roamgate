import { describe, expect, test } from "bun:test";
import {
  githubInboxQuery,
  gitlabInboxQuery,
  parseGithubInbox,
  parseGitlabInbox,
} from "./queries";

const glNode = (iid: number, project = "group/app", extra = {}) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://gitlab.example.org/${project}/-/merge_requests/${iid}`,
  draft: false,
  state: "opened",
  updatedAt: "2026-11-03T14:40:45Z",
  userNotesCount: 3,
  diffHeadSha: "34b4a605c093ccf7a7e40d51e7e2edc4d752384b",
  sourceBranch: "topic",
  targetBranch: "main",
  project: { fullPath: project },
  author: { username: "alice" },
  headPipeline: { status: "FAILED" },
  diffRefs: { baseSha: "15a26fd798fea4d636bf2f55d751dd0935f7e331" },
  ...extra,
});

describe("GitLab inbox", () => {
  test("the query asks each list and each followed project", () => {
    const query = gitlabInboxQuery(["group/app", 'we"ird/x']);
    expect(query).toContain("reviewRequestedMergeRequests(state: opened");
    expect(query).toContain("assignedMergeRequests(state: opened");
    expect(query).toContain("action: [mentioned, directly_addressed]");
    expect(query).toContain('f0: project(fullPath: "group/app")');
    expect(query).toContain('f1: project(fullPath: "we\\"ird/x")');
    expect(query).toContain("diffStats { path }");
  });

  test("merges the lists with their reasons, keeps followed apart", () => {
    const answer = {
      data: {
        currentUser: {
          username: "me",
          rr: { nodes: [glNode(1)] },
          as: { nodes: [glNode(1), glNode(2)] },
          todos: {
            nodes: [
              { action: "mentioned", target: glNode(3) },
              {
                action: "mentioned",
                target: glNode(4, "group/app", { state: "merged" }),
              },
            ],
          },
        },
        f0: {
          mergeRequests: {
            nodes: [
              glNode(1),
              glNode(9, "group/app", { diffStats: [{ path: "a.c" }] }),
            ],
          },
        },
        f1: null,
      },
    };
    const parsed = parseGitlabInbox(
      "gitlab.example.org",
      ["group/app", "gone/x"],
      answer,
    );
    expect(parsed.user).toBe("me");
    expect(parsed.mine.map((item) => [item.number, item.reasons])).toEqual([
      [1, ["review_requested", "assigned"]],
      [2, ["assigned"]],
      [3, ["mentioned"]],
    ]);
    expect(parsed.followed.map((item) => item.number)).toEqual([1, 9]);
    expect(parsed.followed[1]!.files).toEqual(["a.c"]);
    expect(parsed.missing).toEqual(["gone/x"]);
    const first = parsed.mine[0]!;
    expect(first.key).toBe("gitlab:gitlab.example.org/group/app#1");
    expect(first.pipeline).toBe("failed");
    expect(first.state).toBe("open");
    expect(first.baseSha).toBe("15a26fd798fea4d636bf2f55d751dd0935f7e331");
  });

  test("a URL on another host or request is not trusted", () => {
    const parsed = parseGitlabInbox("gitlab.example.org", [], {
      data: {
        currentUser: {
          username: "me",
          rr: {
            nodes: [
              glNode(1, "group/app", {
                webUrl: "https://evil.example/group/app/-/merge_requests/1",
              }),
            ],
          },
        },
      },
    });
    expect(parsed.mine).toEqual([]);
  });

  test("no user: not signed in; errors: said", () => {
    expect(() =>
      parseGitlabInbox("h.org", [], { data: { currentUser: null } }),
    ).toThrow(/not signed in/);
    expect(() =>
      parseGitlabInbox("h.org", [], { errors: [{ message: "boom" }] }),
    ).toThrow(/boom/);
  });
});

const ghNode = (number: number, repo = "o/r", extra = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  isDraft: true,
  state: "OPEN",
  updatedAt: "2026-11-02T10:00:00Z",
  headRefOid: "aaaaaaa1111111",
  baseRefOid: "bbbbbbb2222222",
  headRefName: "topic",
  baseRefName: "main",
  repository: { nameWithOwner: repo },
  author: { login: "bob" },
  comments: { totalCount: 2 },
  reviewThreads: { totalCount: 1 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [{ comments: { totalCount: 4 } }] },
  ...extra,
});

describe("GitHub inbox", () => {
  test("the query searches each list and each followed repository", () => {
    const query = githubInboxQuery(["o/r", "bad"]);
    expect(query).toContain("review-requested:@me");
    expect(query).toContain("assignee:@me");
    expect(query).toContain("mentions:@me");
    expect(query).toContain('f0: repository(owner: "o", name: "r")');
    expect(query).not.toContain("f1:");
    expect(query).toContain("reviews(states: PENDING");
  });

  test("parses lists, pending drafts and followed files", () => {
    const parsed = parseGithubInbox("github.com", ["o/r"], {
      data: {
        viewer: { login: "me" },
        rr: { nodes: [ghNode(5)] },
        as: { nodes: [] },
        mn: { nodes: [ghNode(5), {}] },
        f0: {
          pullRequests: {
            nodes: [ghNode(7, "o/r", { files: { nodes: [{ path: "x.rs" }] } })],
          },
        },
      },
    });
    expect(parsed.user).toBe("me");
    expect(parsed.mine).toHaveLength(1);
    const item = parsed.mine[0]!;
    expect(item.reasons).toEqual(["review_requested", "mentioned"]);
    expect(item.drafts).toBe(4);
    expect(item.notes).toBe(3);
    expect(item.draft).toBe(true);
    expect(item.pipeline).toBe("success");
    expect(parsed.followed[0]!.files).toEqual(["x.rs"]);
  });
});
