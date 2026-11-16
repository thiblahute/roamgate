import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrReviewsSettings,
  mrSeenOf,
  mrUnread,
} from "../../../shared/mrReviews";
import type { InboxFetchers } from "./fetchers";
import { createMrInbox } from "./inbox";
import {
  githubOwnQuery,
  gitlabOwnQuery,
  parseOwnRequests,
  unknownFieldError,
} from "./queries";
import { openMrStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "mr-own-"));
  dirs.push(dir);
  return openMrStore(join(dir, "state.json"));
}

const settings: MrReviewsSettings = {
  ...DEFAULT_MR_REVIEWS_SETTINGS,
  hosts: [{ host: "gitlab.example.org", provider: "gitlab" }],
};

const mr = (iid: number, extra: Record<string, unknown> = {}) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://gitlab.example.org/group/app/-/merge_requests/${iid}`,
  state: "opened",
  updatedAt: "2026-11-03T10:00:00Z",
  userNotesCount: 1,
  diffHeadSha: "aaaaaaa1",
  sourceBranch: `topic-${iid}`,
  targetBranch: "main",
  project: { fullPath: "group/app" },
  author: { username: "me" },
  headPipeline: { status: "RUNNING" },
  conflicts: false,
  shouldBeRebased: false,
  approved: false,
  approvedBy: { nodes: [] },
  resolvableDiscussionsCount: 2,
  resolvedDiscussionsCount: 1,
  ...extra,
});

describe("own requests: queries", () => {
  test("GitLab asks the authored list with the own fields, GitHub searches", () => {
    expect(gitlabOwnQuery()).toContain("authoredMergeRequests");
    expect(gitlabOwnQuery()).toContain("approvedBy");
    expect(gitlabOwnQuery("basic")).not.toContain("approvedBy");
    expect(gitlabOwnQuery("basic")).toContain("conflicts");
    expect(githubOwnQuery()).toContain("author:@me");
    expect(githubOwnQuery()).not.toContain("is:open");
  });

  test("GitLab: status, open ones and recently settled ones only", () => {
    const items = parseOwnRequests(
      "gitlab",
      "gitlab.example.org",
      {
        data: {
          currentUser: {
            au: {
              nodes: [
                mr(1, {
                  approved: true,
                  approvedBy: { nodes: [{ username: "bob" }] },
                  conflicts: true,
                }),
                mr(2, {
                  state: "merged",
                  updatedAt: "2026-11-02T00:00:00Z",
                  detailedMergeStatus: "NEED_REBASE",
                }),
                mr(3, { state: "closed", updatedAt: "2026-10-01T00:00:00Z" }),
              ],
            },
          },
        },
      },
      "2026-10-30T00:00:00Z",
    );
    expect(items.map((item) => [item.number, item.state])).toEqual([
      [1, "open"],
      [2, "merged"],
    ]);
    expect(items[0]!.reasons).toEqual(["authored"]);
    expect(items[0]!.own).toEqual({
      approvedBy: ["bob"],
      approved: true,
      changesRequested: [],
      unresolved: 1,
      conflicts: true,
      needsRebase: false,
    });
    expect(items[1]!.own?.needsRebase).toBe(true);
  });

  test("GitHub: reviews, open threads and conflicts", () => {
    const [item] = parseOwnRequests(
      "github",
      "github.com",
      {
        data: {
          au: {
            nodes: [
              {
                number: 9,
                title: "Fix",
                url: "https://github.com/acme/widgets/pull/9",
                isDraft: false,
                state: "OPEN",
                updatedAt: "2026-11-03T10:00:00Z",
                headRefOid: "bbbbbbb2",
                headRefName: "fix",
                baseRefName: "main",
                repository: { nameWithOwner: "acme/widgets" },
                author: { login: "me" },
                comments: { totalCount: 1 },
                reviewThreads: { totalCount: 2 },
                mergeable: "CONFLICTING",
                reviewDecision: "CHANGES_REQUESTED",
                latestOpinionatedReviews: {
                  nodes: [
                    { state: "APPROVED", author: { login: "ann" } },
                    { state: "CHANGES_REQUESTED", author: { login: "bo" } },
                  ],
                },
                openThreads: {
                  nodes: [{ isResolved: false }, { isResolved: true }],
                },
              },
            ],
          },
        },
      },
      "2026-10-30T00:00:00Z",
    );
    expect(item!.own).toEqual({
      approvedBy: ["ann"],
      approved: false,
      changesRequested: ["bo"],
      unresolved: 1,
      conflicts: true,
      needsRebase: false,
    });
  });

  test("an answer refusing a field is told apart from others", () => {
    expect(
      unknownFieldError({
        errors: [
          { message: "Field 'approved' doesn't exist on type 'MergeRequest'" },
        ],
      }),
    ).toBe(true);
    expect(unknownFieldError({ data: {}, errors: [{ message: "x" }] })).toBe(
      false,
    );
  });
});

describe("own requests: what changed since the user looked", () => {
  const item = {
    updatedAt: "2026-11-03T10:00:00Z",
    headSha: "aaaaaaa1",
    notes: 1,
    state: "open" as const,
    pipeline: "running" as const,
    own: {
      approvedBy: [],
      approved: false,
      changesRequested: [],
      unresolved: 1,
      conflicts: false,
      needsRebase: false,
    },
  };

  test("pipeline, approvals, conflicts, threads and state are said", () => {
    const seen = mrSeenOf(item, "2026-11-03T11:00:00Z");
    expect(mrUnread(item, seen)?.changed).toBe(false);
    const later = {
      ...item,
      updatedAt: "2026-11-03T12:00:00Z",
      state: "merged" as const,
      pipeline: "failed" as const,
      own: {
        ...item.own,
        approvedBy: ["bob"],
        conflicts: true,
        unresolved: 3,
      },
    };
    expect(mrUnread(later, seen)).toEqual({
      newCommits: false,
      newNotes: 0,
      changed: true,
      state: "merged",
      pipeline: "failed",
      newApprovals: ["bob"],
      conflicts: true,
      unresolved: 3,
    });
  });

  test("a record from before these were kept says no such change", () => {
    const old = {
      at: "x",
      updatedAt: item.updatedAt,
      headSha: item.headSha,
      notes: 1,
    };
    expect(
      mrUnread({ ...item, pipeline: "failed", state: "merged" }, old),
    ).toEqual({ newCommits: false, newNotes: 0, changed: false });
  });
});

describe("own requests: the inbox", () => {
  function fetchers(over: { own?: (query: string) => unknown } = {}) {
    const asked: string[] = [];
    let own: unknown[] = [mr(5)];
    const value: InboxFetchers = {
      async gitlab(_host, query) {
        if (query.includes("authoredMergeRequests")) {
          asked.push(query.includes("approvedBy") ? "own full" : "own basic");
          if (over.own) return over.own(query);
          return {
            data: { currentUser: { username: "me", au: { nodes: own } } },
          };
        }
        asked.push("inbox");
        return {
          data: {
            currentUser: {
              username: "me",
              rr: { nodes: [] },
              // Authors often assign themselves: still theirs.
              as: { nodes: [mr(5)] },
              todos: { nodes: [] },
            },
          },
        };
      },
      async github() {
        return { data: { viewer: { login: "me" } } };
      },
      async gitlabDrafts() {
        return 0;
      },
    };
    return { value, asked, setOwn: (next: unknown[]) => (own = next) };
  }

  test("listed as Mine, never new, and what changes after shows", async () => {
    const fake = fetchers();
    const shared = store();
    const inbox = createMrInbox({
      fetchers: fake.value,
      settings: async () => settings,
      store: shared,
      now: () => Date.parse("2026-11-04T12:00:00Z"),
    });
    await inbox.refresh();
    let [entry] = inbox.snapshot(settings).entries;
    expect(entry!.section).toBe("authored");
    expect(entry!.reasons.sort()).toEqual(["assigned", "authored"]);
    expect(entry!.isNew).toBe(false);
    expect(entry!.unread?.changed).toBe(false);
    expect(entry!.own?.unresolved).toBe(1);
    fake.setOwn([
      mr(5, {
        headPipeline: { status: "FAILED" },
        approvedBy: { nodes: [{ username: "bob" }] },
      }),
    ]);
    await inbox.refresh();
    [entry] = inbox.snapshot(settings).entries;
    expect(entry!.unread).toMatchObject({
      changed: true,
      pipeline: "failed",
      newApprovals: ["bob"],
    });
    // Looked at: nothing new any more.
    inbox.markSeen(entry!.key);
    [entry] = inbox.snapshot(settings).entries;
    expect(entry!.unread?.changed).toBe(false);
  });

  test("a host refusing the full fields is asked the basic ones from then on", async () => {
    const fake = fetchers({
      own: (query) =>
        query.includes("approvedBy")
          ? { errors: [{ message: "Field 'approved' doesn't exist" }] }
          : { data: { currentUser: { au: { nodes: [mr(6)] } } } },
    });
    const inbox = createMrInbox({
      fetchers: fake.value,
      settings: async () => settings,
      store: store(),
    });
    await inbox.refresh();
    await inbox.refresh();
    expect(fake.asked).toEqual([
      "inbox",
      "own full",
      "own basic",
      "inbox",
      "own basic",
    ]);
    expect(
      inbox.snapshot(settings).entries.map((entry) => entry.number),
    ).toContain(6);
  });

  test("own requests not read keep what was known", async () => {
    let fail = false;
    const fake = fetchers({
      own: () => {
        if (fail) throw new Error("timeout");
        return { data: { currentUser: { au: { nodes: [mr(7)] } } } };
      },
    });
    const inbox = createMrInbox({
      fetchers: fake.value,
      settings: async () => settings,
      store: store(),
    });
    await inbox.refresh();
    fail = true;
    await inbox.refresh();
    expect(
      inbox
        .snapshot(settings)
        .entries.filter((entry) => entry.section === "authored")
        .map((entry) => entry.number),
    ).toEqual([7]);
  });
});
