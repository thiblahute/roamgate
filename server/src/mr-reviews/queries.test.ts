import { describe, expect, test } from "bun:test";
import {
  githubInboxQuery,
  gitlabInboxQuery,
  gitlabSystemEvents,
  lesserOwnFields,
  ownDetailsQuery,
  ownNotes,
  parseGithubInbox,
  parseGitlabInbox,
  parseLabelEvents,
  parseOwnDetails,
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

test("the forges' labels are read with the lists", async () => {
  const { gitlabItem, githubItem, gitlabOwnListQuery, githubOwnListQuery } =
    await import("./queries");
  expect(gitlabInboxQuery([])).toContain("labels { nodes { title } }");
  expect(gitlabOwnListQuery()).toContain("labels { nodes { title } }");
  expect(githubInboxQuery([])).toContain(
    "labels(first: 10) { nodes { name } }",
  );
  expect(githubOwnListQuery()).toContain(
    "labels(first: 10) { nodes { name } }",
  );
  expect(
    gitlabItem(
      "gitlab.example.org",
      glNode(1, "group/app", {
        labels: { nodes: [{ title: "audio" }, { title: "" }, {}] },
      }),
    )!.labels,
  ).toEqual(["audio"]);
  expect(gitlabItem("gitlab.example.org", glNode(2))!.labels).toBeUndefined();
  expect(
    githubItem("github.com", {
      number: 3,
      title: "t",
      url: "https://github.com/o/r/pull/3",
      state: "OPEN",
      updatedAt: "x",
      repository: { nameWithOwner: "o/r" },
      labels: { nodes: [{ name: "bug" }] },
    })!.labels,
  ).toEqual(["bug"]);
});

test("own details carry the description and the last notes, oldest first, no system notes", () => {
  expect(ownDetailsQuery("gitlab", [{ project: "g/p", number: 1 }])).toContain(
    "discussions(last: 10)",
  );
  expect(
    ownDetailsQuery("gitlab", [{ project: "g/p", number: 1 }], "basic"),
  ).not.toContain("discussions");
  expect(ownDetailsQuery("github", [{ project: "o/r", number: 1 }])).toContain(
    "lastThreads: reviewThreads(last: 20)",
  );
  const node = {
    ...glNode(4),
    description: "Needs !3 first",
    discussions: {
      nodes: [
        {
          resolvable: true,
          resolved: false,
          notes: {
            nodes: [
              {
                author: { username: "bob" },
                createdAt: "2026-11-02T00:00:00Z",
                body: "Why  this\nlock?",
              },
            ],
          },
        },
        {
          resolvable: false,
          resolved: false,
          notes: {
            nodes: [
              {
                author: { username: "me" },
                createdAt: "2026-11-01T00:00:00Z",
                body: "Ready",
              },
            ],
          },
        },
        {
          resolvable: false,
          resolved: false,
          notes: {
            nodes: [
              {
                author: { username: "bot" },
                createdAt: "2026-11-03T00:00:00Z",
                body: "added 1 commit",
                system: true,
              },
            ],
          },
        },
      ],
    },
  };
  const details = parseOwnDetails("gitlab", "gitlab.example.org", {
    data: { p0: { mergeRequests: { nodes: [node] } } },
  });
  const found = [...details.values()][0]!;
  expect(found.description).toBe("Needs !3 first");
  expect(found.lastNotes).toEqual([
    {
      author: "me",
      at: "2026-11-01T00:00:00Z",
      body: "Ready",
      resolvable: false,
      resolved: false,
    },
    {
      author: "bob",
      at: "2026-11-02T00:00:00Z",
      body: "Why this lock?",
      resolvable: true,
      resolved: false,
    },
  ]);
  expect(
    ownNotes("github", {
      lastComments: {
        nodes: [{ author: { login: "ann" }, createdAt: "2", body: "LGTM" }],
      },
      lastThreads: {
        nodes: [
          {
            isResolved: true,
            comments: {
              nodes: [{ author: { login: "bob" }, createdAt: "1", body: "ok" }],
            },
          },
        ],
      },
    }).map((note) => [note.author, note.resolvable, note.resolved]),
  ).toEqual([
    ["bob", true, true],
    ["ann", false, false],
  ]);
});

describe("merge facts in the details (section 15)", () => {
  test("each level asks its fields: full adds who is assigned and auto-merge", () => {
    const items = [{ project: "group/app", number: 4 }];
    expect(ownDetailsQuery("gitlab", items, "full")).toContain(
      "autoMergeEnabled",
    );
    expect(ownDetailsQuery("gitlab", items, "nomerge")).not.toContain(
      "assignees",
    );
    expect(ownDetailsQuery("gitlab", items, "nomerge")).toContain("approvedBy");
    const items2 = [{ project: "acme/app", number: 4 }];
    expect(ownDetailsQuery("github", items2, "full")).toContain(
      "mergeQueueEntry",
    );
    expect(ownDetailsQuery("github", items2, "nomerge")).not.toContain(
      "mergeTimeline",
    );
    expect(lesserOwnFields("gitlab", "full")).toBe("nomerge");
    expect(lesserOwnFields("gitlab", "nomerge")).toBe("basic");
    expect(lesserOwnFields("github", "nomerge")).toBeNull();
  });

  test("GitLab system notes as events", () => {
    expect(gitlabSystemEvents("assigned to @marge-bot", "t1", "me")).toEqual([
      { at: "t1", actor: "me", kind: "assigned", who: ["marge-bot"] },
    ]);
    expect(
      gitlabSystemEvents(
        "assigned to @alice and unassigned @marge-bot",
        "t2",
        "marge-bot",
      ).map((event) => [event.kind, event.who]),
    ).toEqual([
      ["assigned", ["alice"]],
      ["unassigned", ["marge-bot"]],
    ]);
    expect(
      gitlabSystemEvents("requested review from @marge-bot", "t", "me")[0]
        ?.kind,
    ).toBe("review_requested");
    expect(
      gitlabSystemEvents("approved this merge request", "t", "bob")[0]?.kind,
    ).toBe("approved");
    expect(
      gitlabSystemEvents(
        "aborted the automatic merge because the source branch was updated",
        "t",
        "me",
      )[0],
    ).toMatchObject({
      kind: "auto_merge_off",
      reason: "the source branch was updated",
    });
    expect(gitlabSystemEvents("added 1 commit", "t", "me")).toEqual([]);
  });

  test("GitLab details: assignees, auto-merge, events and the approval time", () => {
    const node = glNode(4, "group/app", {
      approvedBy: { nodes: [{ username: "bob" }] },
      assignees: { nodes: [{ username: "marge-bot" }] },
      reviewers: { nodes: [{ username: "bob" }] },
      autoMergeEnabled: true,
      mergeUser: { username: "me" },
      discussions: {
        nodes: [
          {
            notes: {
              nodes: [
                {
                  author: { username: "bob" },
                  createdAt: "2026-11-10T10:00:00Z",
                  body: "approved this merge request",
                  system: true,
                },
              ],
            },
          },
          {
            notes: {
              nodes: [
                {
                  author: { username: "me" },
                  createdAt: "2026-11-11T10:00:00Z",
                  body: "assigned to @marge-bot",
                  system: true,
                },
              ],
            },
          },
        ],
      },
    });
    const details = parseOwnDetails("gitlab", "gitlab.example.org", {
      data: { p0: { mergeRequests: { nodes: [node] } } },
    });
    const merge = [...details.values()][0]!.merge!;
    expect(merge.assignees).toEqual(["marge-bot"]);
    expect(merge.reviewers).toEqual(["bob"]);
    expect(merge.autoMerge).toEqual({ by: "me" });
    expect(merge.approvedAt).toBe("2026-11-10T10:00:00Z");
    expect(merge.events.map((event) => event.kind)).toEqual([
      "approved",
      "assigned",
    ]);
    // Without the full fields: no merge facts at all.
    const basic = parseOwnDetails("gitlab", "gitlab.example.org", {
      data: { p0: { mergeRequests: { nodes: [glNode(5)] } } },
    });
    expect([...basic.values()][0]!.merge).toBeUndefined();
  });

  test("GitHub details: the merge queue, auto-merge, the timeline and label times", () => {
    const pr = {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      updatedAt: "2026-11-12T10:00:00Z",
      headRefOid: "34b4a605c093ccf7a7e40d51e7e2edc4d752384b",
      repository: { nameWithOwner: "acme/app" },
      latestOpinionatedReviews: {
        nodes: [
          {
            state: "APPROVED",
            submittedAt: "2026-11-09T08:00:00Z",
            author: { login: "bob" },
          },
        ],
      },
      assignees: { nodes: [] },
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "mergify" } }],
      },
      autoMergeRequest: {
        enabledAt: "2026-11-12T09:00:00Z",
        enabledBy: { login: "me" },
      },
      mergeQueueEntry: { position: 3, enqueuedAt: "2026-11-12T09:30:00Z" },
      mergeTimeline: {
        nodes: [
          {
            __typename: "LabeledEvent",
            createdAt: "2026-11-11T08:00:00Z",
            actor: { login: "me" },
            label: { name: "merge after 2 days" },
          },
          {
            __typename: "RemovedFromMergeQueueEvent",
            createdAt: "2026-11-11T09:00:00Z",
            actor: { login: "github-merge-queue" },
            reason: "FAILED_CHECKS",
          },
          { __typename: "SomethingElse", createdAt: "x" },
        ],
      },
    };
    const details = parseOwnDetails("github", "github.com", {
      data: { p0: { n7: pr } },
    });
    const merge = [...details.values()][0]!.merge!;
    expect(merge.reviewers).toEqual(["mergify"]);
    expect(merge.autoMerge).toEqual({ by: "me", at: "2026-11-12T09:00:00Z" });
    expect(merge.queue).toEqual({ position: 3, at: "2026-11-12T09:30:00Z" });
    expect(merge.approvedAt).toBe("2026-11-09T08:00:00Z");
    expect(merge.labelsAddedAt).toEqual({
      "merge after 2 days": "2026-11-11T08:00:00Z",
    });
    expect(merge.events).toEqual([
      {
        kind: "dequeued",
        at: "2026-11-11T09:00:00Z",
        actor: "github-merge-queue",
        reason: "failed checks",
      },
    ]);
  });

  test("GitLab label events: the last add of each label still on", () => {
    expect(
      parseLabelEvents([
        { action: "add", label: { name: "a" }, created_at: "t1" },
        { action: "add", label: { name: "b" }, created_at: "t2" },
        { action: "remove", label: { name: "a" }, created_at: "t3" },
        { action: "add", label: { name: "a" }, created_at: "t4" },
        { action: "add", label: { name: "c" }, created_at: "t5" },
        { action: "remove", label: { name: "c" }, created_at: "t6" },
      ]),
    ).toEqual({ a: "t4", b: "t2" });
    expect(parseLabelEvents({ message: "403" })).toEqual({});
  });
});
