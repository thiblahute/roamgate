import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot, replaceDataFile } from "../config/data-paths";
import type {
  MrFeedback,
  MrInferred,
  MrItem,
  MrSeen,
  MrVerdict,
} from "../../../shared/mrReviews";
import type { OwnDetails } from "./queries";

/**
 * The reviews module's own state, in `<data>/mr-reviews/state.json`: what
 * the user saw of each request, their feedback on suggestions, Claude's
 * picks, each request's review in Roamgate and each project's review
 * worktree. Written through on every change (small, atomic replace).
 */

export type MrRanked = {
  /** The request's updatedAt when it was ranked. */
  updatedAt: string;
  /**
   * What it was ranked on (its head and title): ranked again only when
   * they change, not on every comment or pipeline.
   */
  version?: string;
  pick: boolean;
  score: number;
  reason: string;
  at: string;
  /**
   * Who picked it: the reviews agent, asked in its chat ("agent"), or the
   * curation (unset). The curation leaves the agent's picks alone.
   */
  by?: "agent";
};

/**
 * A request the reviews agent found by searching, outside the inbox's
 * lists: kept so its suggestion, feedback or review has its request.
 * Not refreshed; dropped after FOUND_KEPT_DAYS.
 */
export type MrFound = { item: MrItem; at: string };

export const FOUND_KEPT_DAYS = 14;

/**
 * A request the user pinned that no inbox query lists: what the forge last
 * said of it, or why it could not be read.
 */
export type MrPinRead = { item?: MrItem; error?: string; at: string };

export type MrReviewRecord = {
  connectionId: string;
  workspaceId?: string;
  sessionId: string;
  /** The MR's Claude session in the review workspace. */
  claudeSession?: string;
  /** When the request was seen merged or closed. */
  closedAt?: string;
};

export type MrProjectRecord = {
  connectionId: string;
  /** The user's clone it shares objects with. */
  clone: string;
  /** The review worktree. */
  worktree: string;
  workspaceId?: string;
  /** The remote of the clone that is the project, when one is. */
  remote?: string;
  /** The review workspace's pane its Claude runs in. */
  claudePane?: string;
  /**
   * The session started there last: what runs in the pane when Herdr
   * cannot tell (a Claude without its session hook).
   */
  claudeStarted?: string;
  /** The request the worktree is checked out on. */
  checkedOut?: string;
};

export type MrState = {
  version: 1;
  seen: Record<string, MrSeen>;
  feedback: MrFeedback[];
  ranked: Record<string, MrRanked>;
  reviews: Record<string, MrReviewRecord>;
  projects: Record<string, MrProjectRecord>;
  /** The latest inbox items, shown at once after a restart. */
  items: MrItem[];
  /**
   * Hosts read once already: the first answer of a host is the baseline
   * (seen as it is), so only what comes after shows as new.
   */
  baselined: Record<string, string>;
  /** The head last prefetched, by request: fetched again when it moves. */
  prefetched: Record<string, string>;
  /** The latest GitLab draft counts read, by request. */
  drafts: Record<string, { count: number; at: string }>;
  /** Requests the reviews agent found, by key. */
  found: Record<string, MrFound>;
  /** The pinned requests the inbox's lists lack, by key. */
  pins: Record<string, MrPinRead>;
  /**
   * The details last read of the user's own requests, by key: read again
   * only when the request changed (or they were still settling).
   */
  ownDetails: Record<string, OwnDetails & { at: string }>;
  /** What was inferred of one's own work, by key (section 7). */
  inferred?: Record<string, MrInferred>;
  /** When the last twice-daily inference run started. */
  inferenceAt?: string;
};

export const FEEDBACK_KEPT = 200;

function empty(): MrState {
  return {
    version: 1,
    seen: {},
    feedback: [],
    ranked: {},
    reviews: {},
    projects: {},
    items: [],
    baselined: {},
    prefetched: {},
    drafts: {},
    found: {},
    pins: {},
    ownDetails: {},
  };
}

function record<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

export function normalizeState(raw: unknown): MrState {
  const value = record<unknown>(raw);
  return {
    version: 1,
    seen: record(value.seen),
    feedback: Array.isArray(value.feedback)
      ? (value.feedback as MrFeedback[])
          .filter((entry) => entry && typeof entry.key === "string")
          .slice(-FEEDBACK_KEPT)
      : [],
    ranked: record(value.ranked),
    reviews: record(value.reviews),
    projects: record(value.projects),
    items: Array.isArray(value.items) ? (value.items as MrItem[]) : [],
    baselined: record(value.baselined),
    prefetched: record(value.prefetched),
    drafts: record(value.drafts),
    found: record(value.found),
    pins: record(value.pins),
    ownDetails: record(value.ownDetails),
    inferred: record(value.inferred),
    ...(typeof value.inferenceAt === "string"
      ? { inferenceAt: value.inferenceAt }
      : {}),
  };
}

export function mrStatePath(root = dataRoot()): string {
  return join(root, "mr-reviews", "state.json");
}

export type MrStore = ReturnType<typeof openMrStore>;

export function openMrStore(path = mrStatePath()) {
  let state = empty();
  try {
    if (existsSync(path))
      state = normalizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // A broken file starts over; the forge has the rest.
  }
  const save = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    replaceDataFile(path, `${JSON.stringify(state)}\n`);
  };
  return {
    get: (): Readonly<MrState> => state,
    /** Changes the state and writes it. */
    update(change: (state: MrState) => void) {
      change(state);
      save();
    },
    setFeedback(
      item: Pick<MrItem, "key" | "title" | "project" | "author" | "files">,
      verdict: MrVerdict | null,
      at: string,
    ) {
      state.feedback = state.feedback.filter((entry) => entry.key !== item.key);
      if (verdict)
        state.feedback.push({
          key: item.key,
          verdict,
          at,
          title: item.title,
          project: item.project,
          author: item.author,
          files: (item.files ?? []).slice(0, 20),
        });
      state.feedback = state.feedback.slice(-FEEDBACK_KEPT);
      save();
    },
  };
}
