import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MR_MERGE_RULES,
  botFailureReason,
  formatMergeDelay,
  mergeAfterLabel,
  mrBotLabel,
  mrBotName,
  mrMergeFact,
  mrMergeInfo,
  mrMergePattern,
  mrMergeRulesFor,
  mrMergeScope,
  parseMergeDelay,
  queueLabel,
  type MrMergeFacts,
} from "./mrReviewsMerge";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const rules = DEFAULT_MR_MERGE_RULES;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function facts(change: Partial<MrMergeFacts> = {}): MrMergeFacts {
  return { assignees: [], reviewers: [], events: [], ...change };
}

describe("merge delays", () => {
  test("reads the usual ways labels write a delay", () => {
    expect(parseMergeDelay("2 days")).toBe(2 * DAY);
    expect(parseMergeDelay("1 week")).toBe(7 * DAY);
    expect(parseMergeDelay("3d")).toBe(3 * DAY);
    expect(parseMergeDelay("12h")).toBe(12 * HOUR);
    expect(parseMergeDelay("one week")).toBe(7 * DAY);
    expect(parseMergeDelay("1 week 2 days")).toBe(9 * DAY);
    expect(parseMergeDelay("2d12h")).toBe(2.5 * DAY);
    expect(parseMergeDelay("30 min")).toBe(30 * 60_000);
    expect(parseMergeDelay("1.5 days")).toBe(1.5 * DAY);
  });

  test("refuses what is not a delay", () => {
    expect(parseMergeDelay("")).toBeNull();
    expect(parseMergeDelay("soon")).toBeNull();
    expect(parseMergeDelay("2 fortnights")).toBeNull();
    expect(parseMergeDelay("0 days")).toBeNull();
    expect(parseMergeDelay("400 days")).toBeNull();
  });

  test("says a delay as a row does", () => {
    expect(formatMergeDelay(2 * DAY)).toBe("2 days");
    expect(formatMergeDelay(7 * DAY)).toBe("1 week");
    expect(formatMergeDelay(36 * HOUR)).toBe("36 hours");
    expect(formatMergeDelay(DAY + 30 * 60_000)).toBe("1 day 1 hour");
    expect(formatMergeDelay(90_000)).toBe("2 minutes");
  });
});

describe("merge-after labels", () => {
  test("the default patterns recognize the common spellings", () => {
    for (const [label, delay] of [
      ["Merge after: 2 days", 2 * DAY],
      ["merge-after: 1 week", 7 * DAY],
      ["merge after 3d", 3 * DAY],
      ["merge-after::1w", 7 * DAY],
      ["Merge_after=12h", 12 * HOUR],
      ["merge in 2 days", 2 * DAY],
    ] as const)
      expect(mergeAfterLabel([label], rules.afterLabels)).toEqual({
        label,
        delayMs: delay,
      });
    expect(
      mergeAfterLabel(["bug", "Merge after review"], rules.afterLabels),
    ).toBeNull();
    expect(mergeAfterLabel(["mergeable"], rules.afterLabels)).toBeNull();
  });

  test("a project's own pattern: the delay group, else the first group", () => {
    expect(
      mergeAfterLabel(["land::5d"], ["^land::(?<delay>.+)$"])?.delayMs,
    ).toBe(5 * DAY);
    expect(mergeAfterLabel(["wait 2 days"], ["^wait (.+)$"])?.delayMs).toBe(
      2 * DAY,
    );
    expect(mergeAfterLabel(["cooldown 1w"], ["^cooldown"])?.delayMs).toBe(
      7 * DAY,
    );
  });

  test("queue labels", () => {
    expect(queueLabel(["merge-queue"], rules.queueLabels)).toBe("merge-queue");
    expect(queueLabel(["Queued for merge"], rules.queueLabels)).toBe(
      "Queued for merge",
    );
    expect(queueLabel(["queue"], rules.queueLabels)).toBeNull();
  });
});

describe("rules per scope", () => {
  const settings = {
    bots: ["robot"],
    scopes: {
      "gitlab.example.org": { bots: ["marge-bot"] },
      "gitlab.example.org/media/*": { afterLabels: ["^soak (?<delay>.+)$"] },
      "gitlab.example.org/media/engine": { bots: [] },
    },
  };

  test("the most specific scope wins, list by list", () => {
    expect(
      mrMergeRulesFor(settings, { host: "github.com", project: "a/b" }).bots,
    ).toEqual(["robot"]);
    const plugins = mrMergeRulesFor(settings, {
      host: "gitlab.example.org",
      project: "media/plugins",
    });
    expect(plugins.bots).toEqual(["marge-bot"]);
    expect(plugins.afterLabels).toEqual(["^soak (?<delay>.+)$"]);
    expect(plugins.botFailures).toEqual(rules.botFailures);
    // An empty list there turns the detection off.
    expect(
      mrMergeRulesFor(settings, {
        host: "GitLab.example.org",
        project: "Media/Engine",
      }).bots,
    ).toEqual([]);
  });

  test("scope keys and patterns are checked", () => {
    expect(mrMergeScope("https://GitLab.example.org/group/*")).toBe(
      "gitlab.example.org/group/*",
    );
    expect(mrMergeScope("not a scope")).toBeNull();
    expect(mrMergePattern("^merge (")).toBeNull();
    expect(mrMergePattern(" ^ok$ ")).toBe("^ok$");
    expect(mrMergePattern("x".repeat(300))).toBeNull();
  });

  test("bot names compare without @ and [bot]", () => {
    expect(mrBotName("@Marge-Bot")).toBe("marge-bot");
    expect(mrBotName("mergify[bot]")).toBe("mergify");
  });
});

describe("bot failures", () => {
  test("Marge-bot's family of messages", () => {
    expect(
      botFailureReason(
        "I couldn't merge this branch: CI failed!",
        rules.botFailures,
      ),
    ).toBe("CI failed!");
    expect(
      botFailureReason(
        "I couldn't merge this branch: Insufficient approvals (have: [], missing: 1)",
        rules.botFailures,
      ),
    ).toBe("Insufficient approvals (have: [], missing: 1)");
    expect(
      botFailureReason(
        "Sorry, I can't merge requests marked as Draft!",
        rules.botFailures,
      ),
    ).toBe("merge requests marked as Draft!");
    expect(
      botFailureReason(
        "I'm broken on the inside, please somebody fix me... :cry:",
        rules.botFailures,
      ),
    ).toContain("broken on the inside");
    expect(
      botFailureReason(":broken_heart: Test failed", rules.botFailures),
    ).toBe("Test failed");
    expect(
      botFailureReason("Ok, merging it now", rules.botFailures),
    ).toBeNull();
  });
});

describe("a row's merge state", () => {
  const base = {
    state: "open",
    updatedAt: iso(NOW - 3 * DAY),
    rules,
    user: "me",
    now: NOW,
  };

  test("counts from the label's add time, else the approval, else the update", () => {
    const labels = ["Merge after: 2 days"];
    const fromLabel = mrMergeInfo({
      ...base,
      labels,
      facts: facts({
        labelsAddedAt: { "Merge after: 2 days": iso(NOW - DAY) },
        approvedAt: iso(NOW - 5 * DAY),
      }),
    })!.after!;
    expect(fromLabel).toMatchObject({
      from: "label",
      delay: "2 days",
      at: iso(NOW + DAY),
      ready: false,
    });
    const fromApproval = mrMergeInfo({
      ...base,
      labels,
      facts: facts({ approvedAt: iso(NOW - 5 * DAY) }),
    })!.after!;
    expect(fromApproval).toMatchObject({ from: "approval", ready: true });
    const fromUpdate = mrMergeInfo({ ...base, labels })!.after!;
    expect(fromUpdate).toMatchObject({
      from: "update",
      at: iso(NOW - DAY),
      ready: true,
    });
    expect(mrMergeFact({ after: fromLabel })).toBe("scheduled");
    expect(mrMergeFact({ after: fromUpdate })).toBe("ready");
  });

  test("nothing for a closed request or one without either", () => {
    expect(
      mrMergeInfo({ ...base, state: "merged", labels: ["merge after 1d"] }),
    ).toBeUndefined();
    expect(mrMergeInfo({ ...base, labels: ["bug"] })).toBeUndefined();
  });

  test("a bot assigned, or a reviewer, is merging it", () => {
    const info = mrMergeInfo({
      ...base,
      facts: facts({ assignees: ["alice", "marge-bot"] }),
    })!;
    expect(info.bot).toEqual({
      name: "marge-bot",
      via: "assignee",
      queued: true,
    });
    expect(mrBotLabel(info.bot!)).toBe("queued to merge by marge-bot");
    expect(
      mrMergeInfo({ ...base, facts: facts({ reviewers: ["Mergify[bot]"] }) })!
        .bot?.via,
    ).toBe("reviewer");
    expect(mrMergeFact(info)).toBe("queued");
  });

  test("the forge's merge queue, auto-merge, or a queue label", () => {
    const queued = mrMergeInfo({
      ...base,
      facts: facts({ queue: { position: 2, at: iso(NOW - HOUR) } }),
    })!.bot!;
    expect(mrBotLabel(queued)).toBe("#2 in the merge queue");
    const auto = mrMergeInfo({
      ...base,
      facts: facts({ autoMerge: { by: "alice" } }),
    })!.bot!;
    expect(mrBotLabel(auto)).toBe("auto-merge set by alice");
    const label = mrMergeInfo({ ...base, labels: ["merge-queue"] })!.bot!;
    expect(label).toMatchObject({ via: "label", queued: true });
  });

  test("a failure note after the bot was assigned, and the bot leaving", () => {
    const failed = mrMergeInfo({
      ...base,
      facts: facts({
        events: [
          {
            kind: "assigned",
            at: iso(NOW - 2 * HOUR),
            actor: "me",
            who: ["marge-bot"],
          },
          {
            kind: "unassigned",
            at: iso(NOW - HOUR),
            actor: "marge-bot",
            who: ["marge-bot"],
          },
        ],
      }),
      notes: [
        {
          author: "marge-bot",
          at: iso(NOW - HOUR - 60_000),
          body: "I couldn't merge this branch: CI failed!",
        },
      ],
    })!.bot!;
    expect(failed).toMatchObject({
      name: "marge-bot",
      queued: false,
      failed: { reason: "CI failed!", at: iso(NOW - HOUR) },
    });
    expect(mrMergeFact({ bot: failed })).toBe(`failed:${iso(NOW - HOUR)}`);
  });

  test("the bot unassigning itself without a note still says so", () => {
    const failed = mrMergeInfo({
      ...base,
      facts: facts({
        events: [
          {
            kind: "unassigned",
            at: iso(NOW - HOUR),
            actor: "marge-bot",
            who: ["marge-bot"],
          },
        ],
      }),
    })!.bot!;
    expect(failed.failed?.reason).toBe("marge-bot unassigned itself");
  });

  test("assigned again after a failure: a new attempt", () => {
    const bot = mrMergeInfo({
      ...base,
      facts: facts({
        assignees: ["marge-bot"],
        events: [
          {
            kind: "assigned",
            at: iso(NOW - 10 * 60_000),
            actor: "me",
            who: ["marge-bot"],
          },
        ],
      }),
      notes: [
        {
          author: "marge-bot",
          at: iso(NOW - HOUR),
          body: "I couldn't merge this branch: CI failed!",
        },
      ],
    })!.bot!;
    expect(bot).toEqual({ name: "marge-bot", via: "assignee", queued: true });
    // Still assigned, the assignment out of what was read: trusted.
    expect(
      mrMergeInfo({
        ...base,
        facts: facts({ assignees: ["marge-bot"] }),
        notes: [
          {
            author: "marge-bot",
            at: iso(NOW - HOUR),
            body: "I couldn't merge this branch: CI failed!",
          },
        ],
      })!.bot!.queued,
    ).toBe(true);
  });

  test("a note of someone else that looks like a failure is not one", () => {
    expect(
      mrMergeInfo({
        ...base,
        notes: [
          {
            author: "alice",
            at: iso(NOW - HOUR),
            body: "I couldn't merge this branch: CI failed!",
          },
        ],
      }),
    ).toBeUndefined();
  });

  test("GitHub: removed from the queue, auto-merge turned off by someone else", () => {
    const dequeued = mrMergeInfo({
      ...base,
      facts: facts({
        events: [
          { kind: "queued", at: iso(NOW - 2 * HOUR) },
          {
            kind: "dequeued",
            at: iso(NOW - HOUR),
            actor: "github-merge-queue",
            reason: "failed checks",
          },
        ],
      }),
    })!.bot!;
    expect(dequeued.failed?.reason).toBe(
      "removed from the merge queue: failed checks",
    );
    // Turned off by the user themselves: no failure.
    expect(
      mrMergeInfo({
        ...base,
        facts: facts({
          events: [
            { kind: "auto_merge_on", at: iso(NOW - 2 * HOUR) },
            {
              kind: "auto_merge_off",
              at: iso(NOW - HOUR),
              actor: "me",
              reason: "manually",
            },
          ],
        }),
      }),
    ).toBeUndefined();
  });

  test("a scheduled merge with a bot: both said", () => {
    const info = mrMergeInfo({
      ...base,
      labels: ["merge after 7 days"],
      facts: facts({ assignees: ["marge-bot"] }),
    })!;
    expect(info.after?.ready).toBe(false);
    expect(info.bot?.queued).toBe(true);
    expect(mrMergeFact(info)).toBe("queued");
  });
});
