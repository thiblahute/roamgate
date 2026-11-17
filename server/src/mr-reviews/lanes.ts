import type {
  MrInboxEntry,
  MrLane,
  MrNextStep,
  MrOverride,
} from "../../../shared/mrReviews";
import { mrRefLabel, mrWhoseLabel } from "../../../shared/mrReviews";
import {
  mrBotFailedLabel,
  mrBotFailedNext,
  mrBotLabel,
  mrBotQueuedNext,
} from "../../../shared/mrReviewsMerge";

/**
 * Lanes of one's own work: whose move it is, and the next step. An
 * override's whose-move (not outdated) wins, then the inference (later),
 * then rules from what the forge already says, so lanes work before any
 * model runs. A request waiting for another open request of the list is
 * drawn under it (its `parent`) and counts in Blocked.
 */

const DAY_MS = 24 * 60 * 60_000;

export type RuleLane = {
  lane: MrLane;
  why: string;
  next: string;
  /**
   * From exact merge facts (a bot merging or failing, a merge-after delay):
   * wins over the model's inference; an override still wins over it.
   */
  exact?: boolean;
};

/** Lane, why, and next step of one own request from the forge's status. */
export function ruleLane(
  entry: MrInboxEntry,
  options: { staleDays: number; now: number; waitingFor: MrInboxEntry[] },
): RuleLane {
  if (entry.branch) return branchLane(entry, options);
  if (entry.state === "merged" || entry.state === "closed")
    return {
      lane: "done",
      why: entry.state,
      next: entry.state === "merged" ? "Merged" : "Closed",
    };
  const open = options.waitingFor.filter((each) => each.state === "open");
  if (open.length) {
    const names = open.map((each) => mrRefLabel(each, true)).join(", ");
    return {
      lane: "blocked",
      why: `after ${names}`,
      next: `Waits for ${names}`,
    };
  }
  const bot = entry.merge?.bot;
  if (bot?.failed)
    return {
      lane: "your_move",
      why: mrBotFailedLabel(bot),
      next: mrBotFailedNext(bot),
      exact: true,
    };
  if (bot?.queued) {
    const after = entry.merge?.after;
    return {
      lane: "merging",
      why: mrBotLabel(bot),
      next:
        after && !after.ready
          ? `${mrBotLabel(bot)}, once the merge-after delay (${after.delay}) is over`
          : mrBotQueuedNext(bot),
      exact: true,
    };
  }
  const updated = Date.parse(entry.updatedAt);
  if (
    Number.isFinite(updated) &&
    options.now - updated > options.staleDays * DAY_MS
  ) {
    const days = Math.floor((options.now - updated) / DAY_MS);
    return {
      lane: "stale",
      why: `quiet ${days} days`,
      next: `No activity for ${days} days: ping, rebase or close it`,
    };
  }
  const own = entry.own;
  if (entry.pipeline === "failed")
    return {
      lane: "your_move",
      why: "pipeline failed",
      next: "Fix the failed pipeline",
    };
  if (own?.conflicts)
    return {
      lane: "your_move",
      why: "conflicts",
      next: `Rebase on ${entry.targetBranch || "the target"}: it conflicts`,
    };
  if (own?.changesRequested.length)
    return {
      lane: "your_move",
      why: "changes requested",
      next: `Address the changes ${own.changesRequested.join(", ")} asked for`,
    };
  if (own?.unresolved)
    return {
      lane: "your_move",
      why: `${own.unresolved} unresolved`,
      next: `Answer ${own.unresolved} unresolved thread${own.unresolved === 1 ? "" : "s"}`,
    };
  if (own?.needsRebase)
    return {
      lane: "your_move",
      why: "needs rebase",
      next: `Rebase on ${entry.targetBranch || "the target"}`,
    };
  if (entry.draft)
    return {
      lane: "your_move",
      why: "draft",
      next: "Mark it ready for review",
    };
  const after = entry.merge?.after;
  if (after && !after.ready)
    return {
      lane: "waiting",
      why: `merge after ${after.delay}`,
      next: `Waiting on time: ${after.delay} from ${SINCE[after.from]}`,
      exact: true,
    };
  if (after?.ready)
    return {
      lane: "your_move",
      why: "mergeable",
      next: `Merge it: the merge-after delay (${after.delay}) is over`,
      exact: true,
    };
  if (own?.approved || own?.approvedBy.length)
    return {
      lane: "waiting",
      why: "approved",
      next: "Approved: waiting to be merged",
    };
  if (entry.pipeline === "running" || entry.pipeline === "pending")
    return {
      lane: "waiting",
      why: "pipeline running",
      next: "Pipeline running",
    };
  return { lane: "waiting", why: "in review", next: "Waiting for review" };
}

const SINCE = {
  label: "the label",
  approval: "the last approval",
  update: "the last update",
} as const;

/** A branch headed upstream: not proposed yet, unless quiet for long. */
function branchLane(
  entry: MrInboxEntry,
  options: { staleDays: number; now: number },
): { lane: MrLane; why: string; next: string } {
  const branch = entry.branch!;
  const updated = Date.parse(entry.updatedAt);
  if (
    Number.isFinite(updated) &&
    options.now - updated > options.staleDays * DAY_MS
  ) {
    const days = Math.floor((options.now - updated) / DAY_MS);
    return {
      lane: "stale",
      why: `quiet ${days} days`,
      next: `No commit for ${days} days: propose it, rebase or drop it`,
    };
  }
  const commits = `${branch.ahead} commit${branch.ahead === 1 ? "" : "s"}`;
  return {
    lane: "not_sent",
    why: entry.unsent ? "not proposed yet" : "branch",
    next: branch.dirty
      ? `Commit or stash ${branch.dirty} changed file${branch.dirty === 1 ? "" : "s"}`
      : branch.behind > 50
        ? `Rebase on ${branch.target} (${branch.behind} behind), then propose it`
        : entry.unsent
          ? `Open the request (${commits})`
          : `Propose ${commits} upstream`,
  };
}

/**
 * Lanes, next steps and nesting for the own requests among `entries`
 * (changed in place): the override first, then the inference while it
 * holds, else the rules; dependencies found or set make it Blocked.
 */
export function assignLanes(
  entries: MrInboxEntry[],
  options: { staleDays: number; now: number },
): void {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const entry of entries) {
    if (!entry.reasons.includes("authored")) continue;
    const override: MrOverride | undefined = entry.override;
    // The inference while it holds (section 7); overrides win over it.
    const inferred =
      entry.inferred && !entry.inferredOutdated ? entry.inferred : undefined;
    const dependsOn = override?.dependsOn?.length
      ? override.dependsOn
      : (inferred?.dependsOn ?? []);
    if (dependsOn.length) entry.dependsOn = dependsOn;
    const waitingFor = dependsOn.flatMap((key) => {
      const found = byKey.get(key);
      return found ? [found] : [];
    });
    const rule = ruleLane(entry, { ...options, waitingFor });
    let lane = rule.lane;
    let why = rule.why;
    let next: MrNextStep = { text: rule.next, from: "rule" };
    const current = override && !entry.overrideOutdated;
    if (lane !== "done" && current && override.stale) {
      lane = "stale";
      why = "marked stale";
    } else if (lane !== "done" && current && override.whose) {
      lane = override.whose === "me" ? "your_move" : "waiting";
      why =
        override.whose === "me"
          ? `set by ${override.by === "agent" ? "Claude" : "you"}`
          : `waiting on ${mrWhoseLabel(override.whose)}`;
    } else if (
      inferred?.by === "model" &&
      !rule.exact &&
      lane !== "done" &&
      lane !== "blocked"
    ) {
      if (inferred.stale) {
        lane = "stale";
        why = "inferred stale";
      } else if (!entry.branch) {
        // A branch stays not proposed yet; its next step is inferred.
        lane = inferred.whose === "me" ? "your_move" : "waiting";
        why =
          inferred.whose === "me"
            ? "inferred: your move"
            : `inferred: waiting on ${mrWhoseLabel(inferred.whose)}`;
      }
    }
    if (override?.next)
      next = { text: override.next, from: "override", by: override.by };
    else if (
      inferred?.by === "model" &&
      inferred.next &&
      lane !== "done" &&
      !rule.exact
    )
      next = { text: inferred.next, from: "inferred" };
    entry.lane = lane;
    entry.laneWhy = why;
    entry.next = next;
  }
  // Drawn under the first open request it waits for that is listed, in
  // that request's lane; never in a cycle.
  for (const entry of entries) {
    if (!entry.lane || !entry.dependsOn?.length || entry.lane === "done")
      continue;
    const parent = entry.dependsOn
      .map((key) => byKey.get(key))
      .find(
        (found) =>
          !!found &&
          found.lane &&
          found.state === "open" &&
          found.key !== entry.key,
      );
    if (!parent) continue;
    if (reaches(parent.key, entry.key, byKey)) continue;
    entry.parent = parent.key;
  }
}

/** Whether `from` waits, through any chain, for `to`. */
function reaches(
  from: string,
  to: string,
  byKey: Map<string, MrInboxEntry>,
): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const key = stack.pop()!;
    if (key === to) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push(...(byKey.get(key)?.dependsOn ?? []));
  }
  return false;
}
