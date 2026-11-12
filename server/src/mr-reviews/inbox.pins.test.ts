import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrInbox,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import type { InboxFetchers } from "./fetchers";
import { createMrInbox } from "./inbox";
import { handleMrReviewsRpc } from "./rpc";
import {
  MAX_HIDDEN,
  MAX_PINNED,
  mrReviewsSettings,
  normalizeStoredMrReviews,
  storedMrReviews,
} from "./settings";
import { openMrStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const base: MrReviewsSettings = {
  ...DEFAULT_MR_REVIEWS_SETTINGS,
  hosts: [
    { host: "gitlab.example.org", provider: "gitlab" },
    { host: "github.com", provider: "github" },
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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mr-pins-"));
  dirs.push(dir);
  const reads: string[] = [];
  const notes = { 1: 1, 7: 2 } as Record<number, number>;
  const fetchers: InboxFetchers = {
    async gitlab(_host, query) {
      const one = /mergeRequest\(iid: "(\d+)"\)/.exec(query);
      if (one) {
        const iid = Number(one[1]);
        reads.push(`one ${iid}`);
        if (iid === 404) return { data: { project: { mergeRequest: null } } };
        if (iid === 500) throw new Error("boom");
        return {
          data: {
            project: {
              mergeRequest: mr(iid, { userNotesCount: notes[iid] ?? 0 }),
            },
          },
        };
      }
      reads.push("inbox");
      return {
        data: {
          currentUser: {
            username: "me",
            rr: { nodes: [mr(1, { userNotesCount: notes[1] })] },
            as: { nodes: [] },
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
  let current = base;
  const inbox = createMrInbox({
    fetchers,
    settings: async () => current,
    store: openMrStore(join(dir, "state.json")),
  });
  const deps = {
    inbox,
    settings: async () => current,
    saveSettings: async (next: MrReviewsSettings) => {
      current = next;
      return next;
    },
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    handleMrReviewsRpc(deps, `bridge.mr_reviews.${method}`, params);
  const snapshot = (): MrInbox => inbox.snapshot(current);
  return { inbox, call, snapshot, reads, notes, settings: () => current };
}

const url = (iid: number) =>
  `https://gitlab.example.org/group/app/-/merge_requests/${iid}`;

describe("pinned and hidden requests", () => {
  test("settings keep them checked and capped", () => {
    const stored = normalizeStoredMrReviews({
      pinned: [
        {
          provider: "gitlab",
          host: "GitLab.Example.org",
          project: "g/a",
          number: 3,
        },
        {
          provider: "gitlab",
          host: "gitlab.example.org",
          project: "g/a",
          number: 3,
        },
        { provider: "svn", host: "x.org", project: "g/a", number: 4 },
        { provider: "github", host: "github.com", project: "../x", number: 5 },
        { provider: "github", host: "github.com", project: "o/r", number: 0 },
        ...Array.from({ length: MAX_PINNED + 5 }, (_, index) => ({
          provider: "github",
          host: "github.com",
          project: "o/r",
          number: index + 10,
        })),
      ],
      hidden: [
        { key: "a", marker: "m" },
        { key: "a", marker: "again" },
        { key: "", marker: "m" },
        { key: "b", marker: 3 },
        ...Array.from({ length: MAX_HIDDEN + 5 }, (_, index) => ({
          key: `k${index}`,
          marker: "m",
        })),
      ],
    });
    expect(stored?.pinned).toHaveLength(MAX_PINNED);
    expect(stored?.pinned?.[0]).toEqual({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "g/a",
      number: 3,
    });
    // The oldest hidden ones are forgotten first.
    expect(stored?.hidden).toHaveLength(MAX_HIDDEN);
    expect(stored?.hidden?.at(-1)?.key).toBe(`k${MAX_HIDDEN + 4}`);
    expect(mrReviewsSettings(undefined).pinned).toEqual([]);
    const round = storedMrReviews(mrReviewsSettings(stored));
    expect(round.pinned).toHaveLength(MAX_PINNED);
    expect(storedMrReviews(DEFAULT_MR_REVIEWS_SETTINGS).pinned).toBeUndefined();
  });

  test("pin by URL: read from the forge, listed as Pinned, kept in the settings", async () => {
    const t = setup();
    await t.inbox.refresh();
    const pinned = (await t.call("pin", { text: url(7) })) as { key: string };
    expect(pinned.key).toBe("gitlab:gitlab.example.org/group/app#7");
    const entry = t.snapshot().entries.find((each) => each.number === 7)!;
    expect(entry.section).toBe("pinned");
    expect(entry.title).toBe("MR 7");
    expect(entry.unavailable).toBeUndefined();
    expect(t.snapshot().entries.map((each) => each.section)).toEqual([
      "pinned",
      "mine",
    ]);
    expect(t.settings().pinned.map((ref) => ref.number)).toEqual([7]);
    // Pinning again changes nothing; the refresh reads it again (open).
    await t.call("pin", { text: url(7) });
    expect(t.settings().pinned).toHaveLength(1);
    expect(t.inbox.item(pinned.key)?.title).toBe("MR 7");
    t.reads.length = 0;
    await t.inbox.refresh();
    expect(t.reads).toEqual(["inbox", "one 7"]);
    // One the inbox lists is pinned without another call.
    await t.call("pin", { text: url(1) });
    t.reads.length = 0;
    await t.inbox.refresh();
    expect(t.reads).toEqual(["inbox", "one 7"]);
    expect(
      t.snapshot().entries.find((each) => each.number === 1)?.section,
    ).toBe("pinned");
    // Unpinned, it is back in For you.
    await t.call("unpin", { key: "gitlab:gitlab.example.org/group/app#1" });
    expect(
      t.snapshot().entries.find((each) => each.number === 1)?.section,
    ).toBe("mine");
  });

  test("pin refuses other hosts, other text, and says when a request is not found", async () => {
    const t = setup();
    await expect(
      t.call("pin", { text: "https://elsewhere.org/g/p/-/merge_requests/3" }),
    ).rejects.toThrow(/not one of your forge hosts/);
    await expect(t.call("pin", { text: "hello" })).rejects.toThrow(
      /paste its URL/,
    );
    await expect(t.call("pin", { text: "" })).rejects.toThrow(/required/);
    await t.inbox.refresh();
    await t.call("pin", { text: url(404) });
    const gone = t.snapshot().entries.find((each) => each.number === 404)!;
    expect(gone.section).toBe("pinned");
    expect(gone.unavailable).toMatch(/Not found/);
    expect(gone.url).toBe(url(404));
    // A host that fails keeps the pin, with the reason.
    await t.call("pin", { text: url(500) });
    expect(
      t.snapshot().entries.find((each) => each.number === 500)?.unavailable,
    ).toBe("boom");
    // Removing it unpins it.
    expect(
      await t.call("hide", { key: "gitlab:gitlab.example.org/group/app#404" }),
    ).toEqual({ ok: true, action: "unpinned" });
    expect(t.settings().pinned.map((ref) => ref.number)).toEqual([500]);
  });

  test("a pin is capped", async () => {
    const t = setup();
    await t.inbox.refresh();
    for (let n = 0; n < MAX_PINNED; n++)
      await t.call("pin", { text: url(1000 + n) });
    await expect(t.call("pin", { text: url(9999) })).rejects.toThrow(/At most/);
  });

  test("hide: out of the view until something happens on it, restorable", async () => {
    const t = setup();
    await t.inbox.refresh();
    const key = "gitlab:gitlab.example.org/group/app#1";
    expect(await t.call("hide", { key })).toEqual({
      ok: true,
      action: "hidden",
    });
    expect(t.settings().hidden.map((each) => each.key)).toEqual([key]);
    let snapshot = t.snapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.hidden.map((each) => each.key)).toEqual([key]);
    // A new comment brings it back; the list of hidden ones drops it.
    t.notes[1] = 2;
    await t.inbox.refresh();
    snapshot = t.snapshot();
    expect(snapshot.entries.map((each) => each.key)).toEqual([key]);
    expect(snapshot.hidden).toEqual([]);
    // Hidden again, then restored by hand.
    await t.call("hide", { key });
    expect(t.snapshot().entries).toEqual([]);
    await t.call("unhide", { key });
    expect(t.snapshot().entries).toHaveLength(1);
    await expect(
      t.call("hide", { key: "gitlab:gitlab.example.org/group/app#99" }),
    ).rejects.toThrow(/no such request/);
  });

  test("pinning a hidden request shows it again; settings saves keep both", async () => {
    const t = setup();
    await t.inbox.refresh();
    const key = "gitlab:gitlab.example.org/group/app#1";
    await t.call("hide", { key });
    await t.call("pin", { text: url(1) });
    expect(t.settings().hidden).toEqual([]);
    await t.call("hide", { key });
    expect(t.settings().pinned).toEqual([]);
    await t.call("pin", { text: url(7) });
    await t.call("settings.update", { settings: { retentionDays: 5 } });
    expect(t.settings().pinned.map((ref) => ref.number)).toEqual([7]);
    await t.call("settings.update", { settings: { order: [key] } });
    expect(t.settings().pinned).toHaveLength(1);
  });
});
