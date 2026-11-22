import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrInboxEntry,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import { mrFilterMatches } from "../../../shared/mrReviewsFilter";
import { createMrInbox } from "./inbox";
import { meaningful, rowFacts } from "./inference";
import { createOwnForge, type FakeRequest } from "./own-forge.fixture";
import { openMrStore } from "./store";
import { mergeFields } from "./board-tools";
import { EXPORTED_KEYS } from "../history/mr-reviews";
import {
  mrReviewsSettings,
  normalizeStoredMrReviews,
  storedMrReviews,
} from "./settings";

/**
 * Scheduled merges and merge bots (section 15) through the inbox, against
 * the fake forge: what the rows say, their lanes, and what it costs.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "mr-merge-"));
  dirs.push(dir);
  return openMrStore(join(dir, "state.json"));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function request(number: number, extra: Partial<FakeRequest> = {}) {
  return {
    project: "media/engine",
    number,
    state: "open" as const,
    createdAt: ago(10 * DAY + number),
    updatedAt: ago(5 * HOUR),
    pipeline: "success" as const,
    ...extra,
  };
}

const gitlabRequests = (): FakeRequest[] => [
  request(1, {
    labels: ["Merge after: 2 days"],
    labelEvents: [{ label: "Merge after: 2 days", at: ago(DAY) }],
  }),
  request(2, { assignees: ["marge-bot"] }),
  request(3, {
    pipeline: "failed",
    notes: [
      {
        author: "me",
        at: ago(3 * HOUR),
        body: "assigned to @marge-bot",
        system: true,
      },
      {
        author: "marge-bot",
        at: ago(2 * HOUR),
        body: "I couldn't merge this branch: CI failed!",
      },
      {
        author: "marge-bot",
        at: ago(2 * HOUR - 1000),
        body: "unassigned @marge-bot",
        system: true,
      },
    ],
  }),
  request(4, {
    labels: ["merge-after: 1 day"],
    labelEvents: [{ label: "merge-after: 1 day", at: ago(3 * DAY) }],
  }),
  request(5),
];

function inboxOf(
  forge: ReturnType<typeof createOwnForge>,
  settings: MrReviewsSettings,
  now = () => NOW,
  onChange?: () => void,
) {
  return createMrInbox({
    fetchers: forge.fetchers,
    settings: async () => settings,
    store: store(),
    now,
    ...(onChange ? { onChange } : {}),
  });
}

const byNumber = (entries: MrInboxEntry[], number: number) =>
  entries.find((entry) => entry.number === number)!;

describe("scheduled merges and merge bots, GitLab", () => {
  const settings: MrReviewsSettings = {
    ...DEFAULT_MR_REVIEWS_SETTINGS,
    hosts: [{ host: "gitlab.example.org", provider: "gitlab" }],
  };

  test("rows, lanes and next steps", async () => {
    const forge = createOwnForge(
      "gitlab",
      "gitlab.example.org",
      gitlabRequests(),
    );
    const inbox = inboxOf(forge, settings);
    await inbox.refresh();
    const entries = inbox.snapshot(settings).entries;

    const scheduled = byNumber(entries, 1);
    expect(scheduled.merge?.after).toMatchObject({
      label: "Merge after: 2 days",
      from: "label",
      since: ago(DAY),
      at: new Date(NOW + DAY).toISOString(),
      ready: false,
    });
    expect(scheduled.lane).toBe("waiting");
    expect(scheduled.laneWhy).toBe("merge after 2 days");
    expect(scheduled.next?.text).toContain("Waiting on time");
    expect(mrFilterMatches(scheduled, "waiting:time")).toBe(true);
    expect(mrFilterMatches(scheduled, "merge-after:waiting")).toBe(true);
    expect(mrFilterMatches(scheduled, "waiting:reviewer")).toBe(false);

    const merging = byNumber(entries, 2);
    expect(merging.merge?.bot).toEqual({
      name: "marge-bot",
      via: "assignee",
      queued: true,
    });
    expect(merging.lane).toBe("merging");
    expect(merging.laneWhy).toBe("queued to merge by marge-bot");
    expect(mrFilterMatches(merging, "state:merging")).toBe(true);
    expect(mrFilterMatches(merging, "bot:marge-bot")).toBe(true);
    expect(mrFilterMatches(merging, "waiting:marge-bot")).toBe(true);
    expect(mrFilterMatches(merging, "lane:merging")).toBe(true);

    const failed = byNumber(entries, 3);
    expect(failed.merge?.bot?.failed).toEqual({
      reason: "CI failed!",
      at: ago(2 * HOUR - 1000),
    });
    expect(failed.lane).toBe("your_move");
    expect(failed.next?.text).toBe("marge-bot could not merge: CI failed!");
    expect(mrFilterMatches(failed, "bot:failed")).toBe(true);

    const ready = byNumber(entries, 4);
    expect(ready.merge?.after?.ready).toBe(true);
    expect(ready.lane).toBe("your_move");
    expect(ready.next?.text).toBe(
      "Merge it: the merge-after delay (1 day) is over",
    );
    expect(mrFilterMatches(ready, "merge-after:ready")).toBe(true);

    const plain = byNumber(entries, 5);
    expect(plain.merge).toBeUndefined();
    expect(plain.lane).toBe("waiting");
    expect(mrFilterMatches(plain, "merge-after:no")).toBe(true);
    expect(mrFilterMatches(plain, "-bot:any")).toBe(true);
  });

  test("label times are read once per label change, never on a steady refresh", async () => {
    let now = NOW;
    const forge = createOwnForge(
      "gitlab",
      "gitlab.example.org",
      gitlabRequests(),
    );
    const inbox = inboxOf(forge, settings, () => now);
    await inbox.refresh();
    const first = forge.take();
    expect(
      first
        .filter((call) => call.kind === "labels")
        .flatMap((call) => call.numbers)
        .sort(),
    ).toEqual([1, 4]);

    // Nothing changed: the list only.
    now += 10 * 60_000;
    await inbox.refresh();
    expect(
      forge
        .take()
        .map((call) => call.kind)
        .filter((kind) => kind !== "inbox"),
    ).toEqual(["list"]);

    // A comment on 1: its details again, its label times kept.
    forge.update((list) =>
      list.map((r) =>
        r.number === 1 ? { ...r, updatedAt: new Date(now).toISOString() } : r,
      ),
    );
    now += 10 * 60_000;
    await inbox.refresh();
    const second = forge.take();
    expect(
      second
        .filter((call) => call.kind === "details")
        .flatMap((c) => c.numbers),
    ).toEqual([1]);
    expect(second.some((call) => call.kind === "labels")).toBe(false);
    expect(
      byNumber(inbox.snapshot(settings).entries, 1).merge?.after?.from,
    ).toBe("label");

    // Its label changed: read once more.
    forge.update((list) =>
      list.map((r) =>
        r.number === 1
          ? {
              ...r,
              updatedAt: new Date(now).toISOString(),
              labels: ["Merge after: 3 days"],
              labelEvents: [
                {
                  label: "Merge after: 3 days",
                  at: new Date(now).toISOString(),
                },
              ],
            }
          : r,
      ),
    );
    now += 10 * 60_000;
    await inbox.refresh();
    expect(
      forge
        .take()
        .filter((call) => call.kind === "labels")
        .flatMap((call) => call.numbers),
    ).toEqual([1]);
    expect(
      byNumber(inbox.snapshot(settings).entries, 1).merge?.after?.delay,
    ).toBe("3 days");
  });

  test("a scope turning the bots off there, and a project's own label", async () => {
    const scoped: MrReviewsSettings = {
      ...settings,
      merge: {
        scopes: {
          "gitlab.example.org/media/*": {
            bots: [],
            afterLabels: ["^soak (?<delay>.+)$"],
          },
        },
      },
    };
    const forge = createOwnForge("gitlab", "gitlab.example.org", [
      ...gitlabRequests().slice(1, 2),
      request(6, { labels: ["soak 1 week"] }),
    ]);
    const inbox = inboxOf(forge, scoped);
    await inbox.refresh();
    const entries = inbox.snapshot(scoped).entries;
    expect(byNumber(entries, 2).merge).toBeUndefined();
    expect(byNumber(entries, 2).lane).toBe("waiting");
    expect(byNumber(entries, 6).merge?.after?.delay).toBe("1 week");
  });

  test("an override still wins over the merge facts", async () => {
    const forge = createOwnForge(
      "gitlab",
      "gitlab.example.org",
      gitlabRequests(),
    );
    const base = inboxOf(forge, settings);
    await base.refresh();
    const key = byNumber(base.snapshot(settings).entries, 2).key;
    const marker = `${byNumber(base.snapshot(settings).entries, 2).headSha}|3|open`;
    const withOverride: MrReviewsSettings = {
      ...settings,
      overrides: {
        [key]: { whose: "me", at: ago(HOUR), by: "user", marker },
      },
    };
    expect(byNumber(base.snapshot(withOverride).entries, 2).lane).toBe(
      "your_move",
    );
  });

  test("the time passing moves the row, wakes the board and is a meaningful event", async () => {
    jest.useFakeTimers();
    try {
      let now = NOW;
      let changes = 0;
      const forge = createOwnForge(
        "gitlab",
        "gitlab.example.org",
        gitlabRequests().slice(0, 1),
      );
      const inbox = inboxOf(
        forge,
        settings,
        () => now,
        () => changes++,
      );
      await inbox.refresh();
      const before = byNumber(inbox.snapshot(settings).entries, 1);
      expect(before.lane).toBe("waiting");
      const factsBefore = rowFacts(before, [], "me");
      changes = 0;
      now += DAY + 2_000;
      jest.advanceTimersByTime(DAY + 2_000);
      expect(changes).toBeGreaterThan(0);
      const after = byNumber(inbox.snapshot(settings).entries, 1);
      expect(after.lane).toBe("your_move");
      expect(meaningful(factsBefore, rowFacts(after, [], "me"))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("scheduled merges and merge bots, GitHub", () => {
  const settings: MrReviewsSettings = {
    ...DEFAULT_MR_REVIEWS_SETTINGS,
    hosts: [{ host: "github.com", provider: "github" }],
  };
  const requests = (): FakeRequest[] => [
    request(11, {
      project: "acme/widgets",
      autoMerge: { by: "me", at: ago(HOUR) },
      timeline: [
        {
          __typename: "AutoMergeEnabledEvent",
          createdAt: ago(HOUR),
          actor: { login: "me" },
        },
      ],
    }),
    request(12, {
      project: "acme/widgets",
      queue: { position: 2, at: ago(HOUR) },
    }),
    request(13, {
      project: "acme/widgets",
      timeline: [
        {
          __typename: "AddedToMergeQueueEvent",
          createdAt: ago(3 * HOUR),
          actor: { login: "me" },
        },
        {
          __typename: "RemovedFromMergeQueueEvent",
          createdAt: ago(2 * HOUR),
          actor: { login: "github-merge-queue" },
          reason: "FAILED_CHECKS",
        },
      ],
    }),
    request(14, {
      project: "acme/widgets",
      labels: ["merge after 2 days"],
      timeline: [
        {
          __typename: "LabeledEvent",
          createdAt: ago(HOUR),
          actor: { login: "me" },
          label: { name: "merge after 2 days" },
        },
      ],
    }),
  ];

  test("auto-merge, the merge queue, a removal and a label time from the timeline", async () => {
    const forge = createOwnForge("github", "github.com", requests());
    const inbox = inboxOf(forge, settings);
    await inbox.refresh();
    const calls = forge.take();
    // No call beyond the list and the details.
    expect([...new Set(calls.map((call) => call.kind))].sort()).toEqual([
      "details",
      "inbox",
      "list",
    ]);
    const entries = inbox.snapshot(settings).entries;
    expect(byNumber(entries, 11).laneWhy).toBe("auto-merge set by me");
    expect(byNumber(entries, 11).lane).toBe("merging");
    expect(byNumber(entries, 12).laneWhy).toBe("#2 in the merge queue");
    expect(byNumber(entries, 13).lane).toBe("your_move");
    expect(byNumber(entries, 13).laneWhy).toBe("left the merge queue");
    expect(byNumber(entries, 11).next?.text).toBe(
      "Merges itself once the pipeline succeeds",
    );
    expect(byNumber(entries, 13).next?.text).toBe(
      "Removed from the merge queue: failed checks",
    );
    expect(byNumber(entries, 14).merge?.after).toMatchObject({
      from: "label",
      since: ago(HOUR),
      ready: false,
    });
  });
});

describe("merge settings (mr_reviews.merge)", () => {
  test("checked, kept as stored, and back", () => {
    const stored = normalizeStoredMrReviews({
      merge: {
        after_labels: ["^soak (?<delay>.+)$", "^broken ("],
        bots: ["@Marge-Bot", "mergify[bot]", "not a name!"],
        scopes: {
          "https://GitLab.example.org/media/*": { bots: [] },
          "bad scope!": { bots: ["x"] },
          "gitlab.example.org": { nothing: 1 },
        },
      },
    });
    expect(stored?.merge).toEqual({
      after_labels: ["^soak (?<delay>.+)$"],
      bots: ["marge-bot", "mergify"],
      scopes: { "gitlab.example.org/media/*": { bots: [] } },
    });
    const settings = mrReviewsSettings(stored);
    expect(settings.merge).toEqual({
      afterLabels: ["^soak (?<delay>.+)$"],
      bots: ["marge-bot", "mergify"],
      scopes: { "gitlab.example.org/media/*": { bots: [] } },
    });
    expect(storedMrReviews(settings).merge).toEqual(stored!.merge);
    // All defaults: nothing written.
    expect(storedMrReviews(mrReviewsSettings(undefined)).merge).toBeUndefined();
    expect(EXPORTED_KEYS).toContain("merge");
  });

  test("the tools' rows carry the merge state", () => {
    expect(
      mergeFields({
        after: {
          label: "merge after 1d",
          delayMs: DAY,
          delay: "1 day",
          from: "update",
          since: ago(DAY),
          at: ago(0),
          ready: true,
        },
        bot: {
          name: "marge-bot",
          via: "assignee",
          queued: false,
          failed: { reason: "CI failed!", at: ago(HOUR) },
        },
      }),
    ).toEqual({
      after: {
        label: "merge after 1d",
        delay: "1 day",
        from: "update",
        since: ago(DAY),
        mergeable_at: ago(0),
        ready: true,
      },
      bot: {
        name: "marge-bot",
        via: "assignee",
        queued: false,
        failed: { reason: "CI failed!", at: ago(HOUR) },
      },
    });
  });
});
