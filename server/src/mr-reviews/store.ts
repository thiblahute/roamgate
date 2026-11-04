import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRoot, replaceDataFile } from "../config/data-paths";
import type {
  MrFeedback,
  MrItem,
  MrSeen,
  MrVerdict,
} from "../../../shared/mrReviews";

/**
 * The reviews module's own state, in `<data>/mr-reviews/state.json`: what
 * the user saw of each request, their feedback on suggestions, Claude's
 * picks, each request's review in Roamgate and each project's review
 * worktree. Written through on every change (small, atomic replace).
 */

export type MrRanked = {
  /** The request's updatedAt when it was ranked: ranked again after. */
  updatedAt: string;
  pick: boolean;
  score: number;
  reason: string;
  at: string;
};

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
  /** The latest GitLab draft counts read, by request. */
  drafts: Record<string, { count: number; at: string }>;
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
    drafts: {},
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
    drafts: record(value.drafts),
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
