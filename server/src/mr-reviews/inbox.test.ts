import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import { NotSignedInError, type InboxFetchers } from "./fetchers";
import { createMrInbox } from "./inbox";
import { createMrOrder } from "./order";
import { handleMrReviewsRpc } from "./rpc";
import { normalizeStoredMrReviews, mrReviewsSettings } from "./settings";
import { openMrStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "mr-inbox-"));
  dirs.push(dir);
  return openMrStore(join(dir, "state.json"));
}

const settings: MrReviewsSettings = {
  ...DEFAULT_MR_REVIEWS_SETTINGS,
  hosts: [
    { host: "gitlab.example.org", provider: "gitlab" },
    { host: "github.com", provider: "github" },
    { host: "gitlab.nologin.org", provider: "gitlab" },
  ],
  followed: [
    { host: "gitlab.example.org", provider: "gitlab", project: "group/app" },
  ],
};

const mr = (iid: number, extra: Record<string, unknown> = {}) => ({
  iid: String(iid),
  title: `MR ${iid}`,
  webUrl: `https://gitlab.example.org/group/app/-/merge_requests/${iid}`,
  state: "opened",
  updatedAt: "2026-11-03T10:00:00Z",
  userNotesCount: 1,
  diffHeadSha: "aaaaaaa1",
  project: { fullPath: "group/app" },
  author: { username: "alice" },
  ...extra,
});

function fakeFetchers(over: Partial<InboxFetchers> = {}) {
  const calls: string[] = [];
  let gitlabNotes = 1;
  const fetchers: InboxFetchers = {
    async gitlab(host, query) {
      calls.push(`gitlab ${host}`);
      if (host === "gitlab.nologin.org")
        throw new NotSignedInError("Not signed in to gitlab.nologin.org");
      if (query.includes("authoredMergeRequests"))
        return { data: { currentUser: { username: "me", au: { nodes: [] } } } };
      expect(query).toContain('project(fullPath: "group/app")');
      return {
        data: {
          currentUser: {
            username: "me",
            rr: { nodes: [mr(1, { userNotesCount: gitlabNotes })] },
            as: { nodes: [] },
            todos: { nodes: [] },
          },
          f0: { mergeRequests: { nodes: [mr(1), mr(2)] } },
        },
      };
    },
    async github(host) {
      calls.push(`github ${host}`);
      return { data: { viewer: { login: "me" } } };
    },
    async gitlabDrafts(item) {
      calls.push(`drafts ${item.number}`);
      return 2;
    },
    ...over,
  };
  return { fetchers, calls, setNotes: (n: number) => (gitlabNotes = n) };
}

describe("reviews inbox", () => {
  test("lists the user's requests per host, says which hosts failed", async () => {
    const fake = fakeFetchers();
    let now = Date.parse("2026-11-04T12:00:00Z");
    const shared = store();
    // Draft counts are read only for requests reviewed in Roamgate.
    shared.update((state) => {
      state.reviews["gitlab:gitlab.example.org/group/app#1"] = {
        connectionId: "c",
        sessionId: "s",
      };
    });
    const inbox = createMrInbox({
      fetchers: fake.fetchers,
      settings: async () => settings,
      store: shared,
      now: () => now,
    });
    await inbox.refresh();
    expect(fake.calls.filter((call) => call.startsWith("drafts"))).toEqual([
      "drafts 1",
    ]);
    const snapshot = inbox.snapshot(settings);
    expect(snapshot.entries.map((e) => [e.number, e.section])).toEqual([
      [1, "mine"],
    ]);
    // The followed project's other request is no suggestion until picked.
    // A host's first answer is the baseline: nothing is "new" in it.
    expect(snapshot.entries[0]!.isNew).toBe(false);
    expect(snapshot.entries[0]!.unread?.changed).toBe(false);
    expect(snapshot.entries[0]!.drafts).toBe(2);
    expect(snapshot.hosts.map((h) => [h.host, h.state])).toEqual([
      ["gitlab.example.org", "ok"],
      ["github.com", "ok"],
      ["gitlab.nologin.org", "not_signed_in"],
    ]);
    // Drafts are read again only after their TTL.
    fake.calls.length = 0;
    now += 60_000;
    await inbox.refresh();
    expect(fake.calls).not.toContain("drafts 1");
  });

  test("a request that comes after the baseline is new", async () => {
    let second = false;
    const fake = fakeFetchers({
      async gitlab(host) {
        if (host !== "gitlab.example.org") throw new NotSignedInError("no");
        return {
          data: {
            currentUser: {
              username: "me",
              rr: { nodes: second ? [mr(1), mr(5)] : [mr(1)] },
            },
          },
        };
      },
    });
    const inbox = createMrInbox({
      fetchers: fake.fetchers,
      settings: async () => settings,
      store: store(),
    });
    await inbox.refresh();
    second = true;
    await inbox.refresh();
    const byNumber = new Map(
      inbox.snapshot(settings).entries.map((e) => [e.number, e.isNew]),
    );
    expect(byNumber.get(1)).toBe(false);
    expect(byNumber.get(5)).toBe(true);
  });

  test("unread follows what the user saw", async () => {
    const fake = fakeFetchers();
    const inbox = createMrInbox({
      fetchers: fake.fetchers,
      settings: async () => settings,
      store: store(),
    });
    await inbox.refresh();
    expect(inbox.markSeen("gitlab:gitlab.example.org/group/app#1")).toBe(true);
    let entry = inbox.snapshot(settings).entries[0]!;
    expect(entry.isNew).toBe(false);
    expect(entry.unread?.changed).toBe(false);
    fake.setNotes(4);
    await inbox.refresh();
    entry = inbox.snapshot(settings).entries[0]!;
    expect(entry.unread).toEqual({
      newCommits: false,
      newNotes: 3,
      changed: true,
    });
  });

  test("a host that fails keeps its requests", async () => {
    const fake = fakeFetchers();
    const shared = store();
    const inbox = createMrInbox({
      fetchers: fake.fetchers,
      settings: async () => settings,
      store: shared,
    });
    await inbox.refresh();
    const failing = createMrInbox({
      fetchers: {
        ...fake.fetchers,
        gitlab: async () => {
          throw new Error("timeout");
        },
      },
      settings: async () => settings,
      store: shared,
    });
    await failing.refresh();
    const snapshot = failing.snapshot(settings);
    expect(snapshot.entries.map((e) => e.number)).toEqual([1]);
    expect(snapshot.hosts[0]!.state).toBe("error");
  });

  test("suggestions: picked ones show, not interested ones go", async () => {
    const fake = fakeFetchers();
    const shared = store();
    const inbox = createMrInbox({
      fetchers: fake.fetchers,
      settings: async () => settings,
      store: shared,
    });
    await inbox.refresh();
    const key = "gitlab:gitlab.example.org/group/app#2";
    shared.update((state) => {
      state.ranked[key] = {
        updatedAt: "2026-11-03T10:00:00Z",
        pick: true,
        score: 80,
        reason: "touches files you changed",
        at: "now",
      };
    });
    let suggested = inbox
      .snapshot(settings)
      .entries.filter((e) => e.section === "suggested");
    expect(suggested.map((e) => [e.number, e.reason])).toEqual([
      [2, "touches files you changed"],
    ]);
    inbox.feedback(key, "not_interested");
    suggested = inbox
      .snapshot(settings)
      .entries.filter((e) => e.section === "suggested");
    expect(suggested).toEqual([]);
    expect(shared.get().feedback.map((f) => [f.key, f.verdict])).toEqual([
      [key, "not_interested"],
    ]);
  });

  test("a closed request's review starts aging", async () => {
    const shared = store();
    const key = "gitlab:gitlab.example.org/group/app#1";
    shared.update((state) => {
      state.reviews[key] = { connectionId: "c", sessionId: "s" };
    });
    const inbox = createMrInbox({
      fetchers: fakeFetchers({
        async gitlab() {
          return {
            data: {
              currentUser: {
                username: "me",
                rr: { nodes: [mr(1, { state: "merged" })] },
              },
            },
          };
        },
      }).fetchers,
      settings: async () => ({ ...settings, hosts: [settings.hosts[0]!] }),
      store: shared,
    });
    await inbox.refresh();
    expect(shared.get().reviews[key]!.closedAt).toBeString();
  });
});

describe("settings", () => {
  test("defaults are empty: nothing user-specific", () => {
    const value = mrReviewsSettings(undefined);
    expect(value.hosts).toEqual([]);
    expect(value.followed).toEqual([]);
    expect(value.hints).toBe("");
  });

  test("normalizes what settings.json holds", () => {
    const stored = normalizeStoredMrReviews({
      hosts: [
        { host: "GitLab.Example.org", provider: "gitlab" },
        { host: "bad host", provider: "gitlab" },
        { host: "x.org", provider: "svn" },
      ],
      followed: [
        { host: "gitlab.example.org", provider: "gitlab", project: "/g/p/" },
        { host: "gitlab.example.org", provider: "gitlab", project: "g/p" },
        { host: "gitlab.example.org", provider: "gitlab", project: "../x" },
      ],
      checkout: "on_demand",
      retention_days: 7,
      curation: false,
      hints: "I maintain ges",
      clones: { "h/p": { connection_id: "c", path: "/src/p" }, x: {} },
    });
    expect(stored).toEqual({
      hosts: [{ host: "gitlab.example.org", provider: "gitlab" }],
      followed: [
        { host: "gitlab.example.org", provider: "gitlab", project: "g/p" },
      ],
      checkout: "on_demand",
      retention_days: 7,
      curation: false,
      hints: "I maintain ges",
      clones: { "h/p": { connection_id: "c", path: "/src/p" } },
    });
  });

  test("the RPC saves through the stored form", async () => {
    let saved: MrReviewsSettings | null = null;
    const inbox = createMrInbox({
      fetchers: fakeFetchers().fetchers,
      settings: async () => settings,
      store: store(),
    });
    const result = await handleMrReviewsRpc(
      {
        inbox,
        settings: async () => DEFAULT_MR_REVIEWS_SETTINGS,
        saveSettings: async (next) => {
          saved = next;
          return next;
        },
        order: createMrOrder({
          inbox,
          settings: async () => DEFAULT_MR_REVIEWS_SETTINGS,
          save: async (next) => next,
        }),
      },
      "bridge.mr_reviews.settings.update",
      {
        settings: {
          followed: [
            { host: "gitlab.example.org", provider: "gitlab", project: "g/p" },
          ],
          retentionDays: 5,
        },
      },
    );
    expect(saved!.followed).toHaveLength(1);
    expect((result as MrReviewsSettings).retentionDays).toBe(5);
    await expect(
      handleMrReviewsRpc(
        {
          inbox,
          settings: async () => settings,
          saveSettings: async (next) => next,
          order: createMrOrder({
            inbox,
            settings: async () => settings,
            save: async (next) => next,
          }),
        },
        "bridge.mr_reviews.feedback",
        { key: "k", verdict: "submit" },
      ),
    ).rejects.toThrow(/verdict/);
  });

  test("the user's order: kept, checked, saved alone without a refresh", async () => {
    expect(
      normalizeStoredMrReviews({ order: ["a", "a", 3, "", "b"] })?.order,
    ).toEqual(["a", "b"]);
    expect(mrReviewsSettings(undefined).order).toEqual([]);
    let current: MrReviewsSettings = { ...settings, order: ["x"] };
    const inbox = createMrInbox({
      fetchers: fakeFetchers().fetchers,
      settings: async () => current,
      store: store(),
    });
    let refreshes = 0;
    const deps = {
      inbox: {
        ...inbox,
        refresh: async () => {
          refreshes++;
        },
      } as typeof inbox,
      settings: async () => current,
      saveSettings: async (next: MrReviewsSettings) => {
        current = next;
        return next;
      },
      order: createMrOrder({
        inbox,
        settings: async () => current,
        save: async (next) => {
          current = next;
          return next;
        },
      }),
    };
    await handleMrReviewsRpc(deps, "bridge.mr_reviews.settings.update", {
      settings: { order: ["b", "a"] },
    });
    expect(current.order).toEqual(["b", "a"]);
    expect(refreshes).toBe(0);
    // Saving the other settings keeps it, and refreshes.
    await handleMrReviewsRpc(deps, "bridge.mr_reviews.settings.update", {
      settings: { retentionDays: 4 },
    });
    expect(current.order).toEqual(["b", "a"]);
    expect(refreshes).toBe(1);
    // Every browser reads it with the inbox.
    expect(inbox.snapshot(current).order).toEqual(["b", "a"]);
    expect(inbox.snapshot({ ...current, order: [] }).order).toBeUndefined();
  });
});
