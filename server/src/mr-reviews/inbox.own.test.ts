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
import { createMrInbox, OWN_DETAILS_TTL_MS } from "./inbox";
import {
  createOwnForge,
  type FakeRequest,
  fakeRequests,
} from "./own-forge.fixture";
import {
  githubOwnListQuery,
  gitlabOwnListQuery,
  OWN_MAX_PAGES,
  OWN_PAGE,
  ownDetailsQuery,
  parseOwnDetails,
  parseOwnList,
  unknownFieldError,
  withOwnDetails,
} from "./queries";
import { openMrStore } from "./store";
import type { Logger } from "../utils/logger";

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
  test("GitLab lists the open ones paged, the first page with the latest settled", () => {
    const first = gitlabOwnListQuery();
    expect(first).toContain("authoredMergeRequests(state: opened");
    expect(first).toContain("pageInfo { hasNextPage endCursor }");
    expect(first).toContain("state: merged");
    expect(first).toContain("state: closed");
    // The list is light: the costly fields are the details'.
    expect(first).not.toContain("approvedBy");
    expect(first).not.toContain("headPipeline");
    const next = gitlabOwnListQuery("abc");
    expect(next).toContain('after: "abc"');
    expect(next).not.toContain("state: merged");
  });

  test("GitHub searches the open ones paged, the first page with the latest closed", () => {
    const first = githubOwnListQuery();
    expect(first).toContain("is:pr is:open author:@me");
    expect(first).toContain("is:pr is:closed author:@me");
    expect(first).not.toContain("statusCheckRollup");
    expect(githubOwnListQuery("xyz")).not.toContain("is:closed");
  });

  test("details are asked by project, full or basic", () => {
    const refs = [
      { project: "group/app", number: 1 },
      { project: "group/app", number: 2 },
      { project: "other/tool", number: 3 },
    ];
    const gitlab = ownDetailsQuery("gitlab", refs);
    expect(gitlab).toContain(
      'p0: project(fullPath: "group/app") { mergeRequests(iids: ["1","2"]',
    );
    expect(gitlab).toContain('p1: project(fullPath: "other/tool")');
    expect(gitlab).toContain("approvedBy");
    expect(ownDetailsQuery("gitlab", refs, "basic")).not.toContain(
      "approvedBy",
    );
    const github = ownDetailsQuery("github", refs);
    expect(github).toContain(
      'p0: repository(owner: "group", name: "app") { n1: pullRequest(number: 1)',
    );
    expect(github).toContain("latestOpinionatedReviews");
  });

  test("GitLab: the list, then status from the details", () => {
    const page = parseOwnList("gitlab", "gitlab.example.org", {
      data: {
        currentUser: {
          op: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [mr(1)],
          },
          mg: { nodes: [mr(2, { state: "merged" })] },
          cl: { nodes: [mr(3, { state: "closed" })] },
        },
      },
    });
    expect(page.next).toBe("c1");
    expect(page.items.map((item) => [item.number, item.state])).toEqual([
      [1, "open"],
      [2, "merged"],
      [3, "closed"],
    ]);
    expect(page.items[0]!.reasons).toEqual(["authored"]);
    const details = parseOwnDetails("gitlab", "gitlab.example.org", {
      data: {
        p0: {
          mergeRequests: {
            nodes: [
              mr(1, {
                approved: true,
                approvedBy: { nodes: [{ username: "bob" }] },
                conflicts: true,
              }),
              mr(2, { detailedMergeStatus: "NEED_REBASE" }),
            ],
          },
        },
      },
    });
    const one = withOwnDetails(page.items[0]!, details.get(page.items[0]!.key));
    expect(one.own).toEqual({
      approvedBy: ["bob"],
      approved: true,
      changesRequested: [],
      unresolved: 1,
      conflicts: true,
      needsRebase: false,
    });
    expect(one.pipeline).toBe("running");
    // A running pipeline is read again even when nothing else changed.
    expect(details.get(page.items[0]!.key)?.settling).toBe(true);
    expect(details.get(page.items[1]!.key)?.own.needsRebase).toBe(true);
  });

  test("GitHub: reviews, open threads and conflicts", () => {
    const details = parseOwnDetails("github", "github.com", {
      data: {
        p0: {
          n9: {
            number: 9,
            url: "https://github.com/acme/widgets/pull/9",
            updatedAt: "2026-11-03T10:00:00Z",
            headRefOid: "bbbbbbb2",
            repository: { nameWithOwner: "acme/widgets" },
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
        },
      },
    });
    const [entry] = [...details.values()];
    expect(entry!.notes).toBe(3);
    expect(entry!.settling).toBe(false);
    expect(entry!.own).toEqual({
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
  function fetchers(
    over: {
      own?: (query: string) => unknown;
      details?: (query: string) => unknown;
    } = {},
  ) {
    const asked: string[] = [];
    let own: unknown[] = [mr(5)];
    const value: InboxFetchers = {
      async gitlab(_host, query) {
        if (query.includes("op: authoredMergeRequests")) {
          asked.push("list");
          if (over.own) return over.own(query);
          return {
            data: {
              currentUser: {
                username: "me",
                op: { pageInfo: { hasNextPage: false }, nodes: own },
              },
            },
          };
        }
        if (query.includes("mergeRequests(iids:")) {
          asked.push(
            query.includes("approvedBy") ? "details full" : "details basic",
          );
          if (over.details) return over.details(query);
          return { data: { p0: { mergeRequests: { nodes: own } } } };
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
        updatedAt: "2026-11-04T11:00:00Z",
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
      details: (query) =>
        query.includes("approvedBy")
          ? { errors: [{ message: "Field 'approved' doesn't exist" }] }
          : { data: { p0: { mergeRequests: { nodes: [mr(5)] } } } },
    });
    const inbox = createMrInbox({
      fetchers: fake.value,
      settings: async () => settings,
      store: store(),
    });
    await inbox.refresh();
    await inbox.refresh();
    // Its pipeline runs: its details are read again on the second.
    expect(fake.asked).toEqual([
      "inbox",
      "list",
      "details full",
      "details basic",
      "inbox",
      "list",
      "details basic",
    ]);
    const entry = inbox
      .snapshot(settings)
      .entries.find((item) => item.number === 5);
    expect(entry?.own?.unresolved).toBe(1);
  });

  test("own requests not read keep what was known", async () => {
    let fail = false;
    const fake = fetchers({
      own: () => {
        if (fail) throw new Error("timeout");
        return {
          data: {
            currentUser: {
              op: { pageInfo: { hasNextPage: false }, nodes: [mr(7)] },
            },
          },
        };
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

  test("details not read keep those known, the list stands", async () => {
    let fail = false;
    const fake = fetchers({
      details: () => {
        if (fail) throw new Error("timeout");
        return { data: { p0: { mergeRequests: { nodes: [mr(5)] } } } };
      },
    });
    const inbox = createMrInbox({
      fetchers: fake.value,
      settings: async () => settings,
      store: store(),
    });
    await inbox.refresh();
    fail = true;
    fake.setOwn([mr(5, { updatedAt: "2026-11-04T11:00:00Z" })]);
    await inbox.refresh();
    const [entry] = inbox.snapshot(settings).entries;
    expect(entry!.updatedAt).toBe("2026-11-04T11:00:00Z");
    expect(entry!.own?.unresolved).toBe(1);
    expect(entry!.pipeline).toBe("running");
  });
});

/** Old quiet open requests behind many recently merged ones. */
function oldOpenNewMerged(): FakeRequest[] {
  const day = (offset: number) =>
    new Date(
      Date.parse("2026-11-04T00:00:00Z") - offset * 3_600_000,
    ).toISOString();
  return [
    // 26 open, the newest untouched for a year, some since 2021.
    ...fakeRequests(26, "open", (index) =>
      new Date(
        Date.parse("2021-03-01T00:00:00Z") + index * 15 * 86_400_000,
      ).toISOString(),
    ),
    // 40 merged in the last two days.
    ...fakeRequests(40, "merged", (index) => day(index), 100),
  ];
}

describe.each(["gitlab", "github"] as const)(
  "own requests: every open one, details only when changed (%s)",
  (provider) => {
    const host = provider === "gitlab" ? "gitlab.example.org" : "github.com";
    const hostSettings: MrReviewsSettings = {
      ...DEFAULT_MR_REVIEWS_SETTINGS,
      hosts: [{ host, provider }],
    };
    const clock = Date.parse("2026-11-04T12:00:00Z");

    function inboxOf(
      forge: ReturnType<typeof createOwnForge>,
      at = () => clock,
    ) {
      return createMrInbox({
        fetchers: forge.fetchers,
        settings: async () => hostSettings,
        store: store(),
        now: at,
      });
    }

    const authored = (inbox: ReturnType<typeof createMrInbox>) =>
      inbox
        .snapshot(hostSettings)
        .entries.filter((entry) => entry.section === "authored");

    test("26 open requests older than 40 merged ones all show", async () => {
      const forge = createOwnForge(provider, host, oldOpenNewMerged());
      const inbox = inboxOf(forge);
      await inbox.refresh();
      const mine = authored(inbox);
      const open = mine.filter((entry) => entry.state === "open");
      expect(open.map((entry) => entry.number).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 26 }, (_, index) => index + 1),
      );
      // A small page of the latest settled, for the closed-review retention.
      const settled = mine.filter((entry) => entry.state !== "open");
      expect(settled.length).toBeGreaterThan(0);
      expect(settled.length).toBeLessThanOrEqual(20);
      // Every row has its details.
      expect(open.every((entry) => entry.own && entry.pipeline)).toBe(true);
    });

    test("a second refresh reads the details of the one that changed only", async () => {
      const forge = createOwnForge(provider, host, oldOpenNewMerged());
      const inbox = inboxOf(forge);
      await inbox.refresh();
      forge.take();
      forge.update((list) =>
        list.map((r) =>
          r.number === 4
            ? {
                ...r,
                updatedAt: "2026-11-04T11:30:00Z",
                pipeline: "failed",
                approvedBy: ["bob"],
              }
            : r,
        ),
      );
      await inbox.refresh();
      const calls = forge.take();
      const details = calls.filter((call) => call.kind === "details");
      expect(details.map((call) => call.numbers)).toEqual([[4]]);
      expect(calls.filter((call) => call.kind === "list")).toHaveLength(1);
      const four = authored(inbox).find((entry) => entry.number === 4);
      expect(four?.pipeline).toBe("failed");
      expect(four?.own?.approvedBy).toEqual(["bob"]);
      // The others kept their details.
      expect(authored(inbox).every((entry) => entry.own)).toBe(true);
      // Nothing changed: no details at all.
      await inbox.refresh();
      expect(forge.take().filter((call) => call.kind === "details")).toEqual(
        [],
      );
    });

    test("a running pipeline is read again until it ends", async () => {
      const forge = createOwnForge(
        provider,
        host,
        oldOpenNewMerged().map((r) =>
          r.number === 2 ? { ...r, pipeline: "running" as const } : r,
        ),
      );
      const inbox = inboxOf(forge);
      await inbox.refresh();
      forge.take();
      forge.update((list) =>
        list.map((r) => (r.number === 2 ? { ...r, pipeline: "success" } : r)),
      );
      await inbox.refresh();
      expect(
        forge
          .take()
          .flatMap((call) => (call.kind === "details" ? call.numbers : [])),
      ).toEqual([2]);
      expect(
        authored(inbox).find((entry) => entry.number === 2)?.pipeline,
      ).toBe("success");
      await inbox.refresh();
      expect(forge.take().filter((call) => call.kind === "details")).toEqual(
        [],
      );
    });

    test("unchanged details are read again a few at a time once old", async () => {
      let at = clock;
      const forge = createOwnForge(provider, host, oldOpenNewMerged());
      const inbox = inboxOf(forge, () => at);
      await inbox.refresh();
      forge.take();
      at += OWN_DETAILS_TTL_MS;
      await inbox.refresh();
      const read = forge
        .take()
        .flatMap((call) => (call.kind === "details" ? call.numbers : []));
      expect(read).toHaveLength(10);
      expect(read.every((number) => number <= 26)).toBe(true);
    });

    test("pages to the end, and stops at the cap with a log line", async () => {
      const warned: string[] = [];
      const logger: Logger = {
        enabled: () => true,
        error() {},
        warn: (message) => void warned.push(message),
        info() {},
        debug() {},
        child: () => logger,
      };
      const many = OWN_PAGE * OWN_MAX_PAGES + 5;
      const forge = createOwnForge(
        provider,
        host,
        fakeRequests(many, "open", (index) =>
          new Date(
            Date.parse("2020-01-01T00:00:00Z") + index * 60_000,
          ).toISOString(),
        ),
      );
      const inbox = createMrInbox({
        fetchers: forge.fetchers,
        settings: async () => hostSettings,
        store: store(),
        now: () => clock,
        logger,
      });
      await inbox.refresh();
      expect(forge.calls.filter((call) => call.kind === "list")).toHaveLength(
        OWN_MAX_PAGES,
      );
      expect(authored(inbox)).toHaveLength(OWN_PAGE * OWN_MAX_PAGES);
      expect(warned).toContain("own open requests cut at the page cap");
    });
  },
);
