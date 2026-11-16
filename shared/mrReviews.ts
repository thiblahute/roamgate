import type { AssistantSource } from "./assistant";
import type {
  ForgePipelineStatus,
  ForgeProvider,
  ForgeRef,
  ForgeRequestState,
} from "./forge";

/**
 * The reviews inbox: upstream merge and pull requests for the user to
 * review, from GitLab and GitHub. Read through the user's glab and gh
 * logins on the bridge's machine; only the user, in the UI, ever writes a
 * draft, and nothing is ever submitted from Roamgate.
 */

/**
 * Why a request is the user's: in "To review" (review requested, assigned,
 * mentioned), or in "Mine" (authored by the user).
 */
export type MrReason =
  | "review_requested"
  | "assigned"
  | "mentioned"
  | "authored";

/**
 * Where one of the user's own requests stands, from the same list query
 * (no call per request): reviews, threads and whether it merges cleanly.
 */
export type MrOwnStatus = {
  /** Who approved it. */
  approvedBy: string[];
  /** Approved as the forge requires (null: the forge did not say). */
  approved: boolean | null;
  /** GitHub: who asked for changes. */
  changesRequested: string[];
  /** Threads still to resolve (null: unknown). */
  unresolved: number | null;
  /** Conflicts with its target branch. */
  conflicts: boolean;
  /** GitLab: the target moved on and it must be rebased to merge. */
  needsRebase: boolean;
};

/** One merge or pull request as the inbox lists it. */
export type MrItem = ForgeRef & {
  /** forgeRefKey of the ref. */
  key: string;
  url: string;
  title: string;
  author: string;
  draft: boolean;
  state: ForgeRequestState;
  updatedAt: string;
  headSha: string;
  /** The diff's base, when the forge said. */
  baseSha?: string;
  sourceBranch: string;
  targetBranch: string;
  pipeline: ForgePipelineStatus | null;
  /** Comments by people (not the system's notes). */
  notes: number;
  /** Why it is the user's: empty for a suggestion. */
  reasons: MrReason[];
  /** Changed paths, for the suggestions (capped). */
  files?: string[];
  /**
   * The user's pending drafts on the forge: GitHub says with the list;
   * GitLab only on a read of the merge request's draft notes.
   */
  drafts?: number;
  /** The user's own request: where it stands. */
  own?: MrOwnStatus;
};

/** What the user saw last time they looked. */
export type MrSeen = {
  at: string;
  updatedAt: string;
  headSha: string;
  notes: number;
  /** Absent in records from before they were kept: no change said. */
  state?: ForgeRequestState;
  pipeline?: ForgePipelineStatus | null;
  approvedBy?: string[];
  unresolved?: number | null;
  conflicts?: boolean;
};

export type MrUnread = {
  /** The head moved since the user looked. */
  newCommits: boolean;
  /** Comments added since. */
  newNotes: number;
  /** Anything changed since (a new note, a push, a state change). */
  changed: boolean;
  /** Merged or closed since. */
  state?: ForgeRequestState;
  /** The pipeline's status since, when it changed. */
  pipeline?: ForgePipelineStatus | null;
  /** Who approved it since. */
  newApprovals?: string[];
  /** Conflicts appeared (true) or went (false). */
  conflicts?: boolean;
  /** Threads to resolve now, when their number changed. */
  unresolved?: number;
};

/**
 * "pinned": added by the user (by URL, or pinned from the list), listed
 * whether or not a query finds it; "mine": to review (requested, assigned,
 * mentioned); "authored": the user's own requests.
 */
export type MrSection = "pinned" | "mine" | "authored" | "suggested";

export type MrInboxEntry = MrItem & {
  section: MrSection;
  /** Null: never looked at. */
  unread: MrUnread | null;
  /** Never opened in Roamgate. */
  isNew: boolean;
  /** A suggestion: why Claude picked it, in one line. */
  reason?: string;
  /** The user's word on a suggestion. */
  feedback?: MrVerdict;
  /** Its review in Roamgate, once opened. */
  review?: { connectionId: string; workspaceId?: string; sessionId: string };
  /**
   * A pinned request the forge did not give (not found, no access, host
   * down), or not read yet: the row shows this instead of its state, and
   * only the remove button works.
   */
  unavailable?: string;
};

/**
 * A workspace that is a request's (`bridge.mr_reviews.links`): on its
 * branch, named after it, or its review workspace, on any connection.
 */
export type MrWorkspaceLink = {
  connectionId: string;
  connectionLabel: string;
  workspaceId: string;
  label: string;
  why: ("branch" | "name" | "review")[];
};

/** A request the user removed from the view, for the Restore list. */
export type MrHiddenEntry = {
  key: string;
  provider: ForgeProvider;
  host: string;
  project: string;
  number: number;
  url: string;
  title: string;
};

export type MrHostState = {
  host: string;
  provider: ForgeProvider;
  state: "ok" | "not_signed_in" | "unavailable" | "error" | "pending";
  /** The user there, once known. */
  user?: string;
  message?: string;
  fetchedAt?: string;
};

export type MrCurationState = {
  state: "idle" | "running" | "off" | "error";
  at?: string;
  message?: string;
};

export type MrInbox = {
  entries: MrInboxEntry[];
  hosts: MrHostState[];
  curation: MrCurationState;
  /** When the latest refresh ended. */
  refreshedAt?: string;
  /** A refresh is running. */
  refreshing: boolean;
  /** The user's order (the settings' `order`), when they set one. */
  order?: string[];
  /**
   * Counts every change of the order, the pins and the removals: a page
   * keeps what has the higher one.
   */
  orderVersion?: number;
  /** Removed by the user and quiet since: the "N hidden" list. */
  hidden: MrHiddenEntry[];
};

export type MrVerdict = "not_interested" | "more_like_this";

export type MrFeedback = {
  key: string;
  verdict: MrVerdict;
  at: string;
  title: string;
  project: string;
  author: string;
  files: string[];
};

export type MrCheckoutMode = "immediately" | "on_demand";

export type MrReviewsSettings = {
  /**
   * Forge hosts whose requests for the user are listed. Empty: the hosts
   * glab and gh are signed in to on the bridge's machine.
   */
  hosts: { host: string; provider: ForgeProvider }[];
  /** Projects whose open requests are candidates for suggestions. */
  followed: { host: string; provider: ForgeProvider; project: string }[];
  /** When the review worktree follows the selected request. */
  checkout: MrCheckoutMode;
  /** Per-request state is dropped this long after a merge or close. */
  retentionDays: number;
  /** Claude picks suggestions in the background. */
  curation: boolean;
  /**
   * Only requests updated this many days ago at most are suggested; an
   * older one is considered again once it changes.
   */
  suggestDays: number;
  /**
   * The user's own hints for the suggestions (areas they maintain, people
   * they work with), in their words; the rest comes from their history.
   */
  hints: string;
  /**
   * Where each project's review workspace goes in the Workspaces tree:
   * "host/project" -> a path of names (groups, or workspaces). Absent: a
   * "Reviews" group under the clone's workspace, else at the top.
   */
  treeGroups: Record<string, string[]>;
  /** Clones picked by the user: "host/project" -> where. */
  clones: Record<string, { connectionId: string; path: string }>;
  /**
   * The inbox in the user's order, as request keys; requests not in it come
   * first, in the inbox's own order. Empty: the inbox's order.
   */
  order: string[];
  /** Read only: counts the changes of `order`, `pinned` and `hidden`. */
  orderVersion?: number;
  /** Requests the user added by URL, newest first. */
  pinned: ForgeRef[];
  /**
   * Requests the user removed from the view, with their activity marker
   * (mrActivityMarker) at that time: shown again once it changes.
   */
  hidden: { key: string; marker: string }[];
  /** Read only: each project's review worktree, where it is. */
  reviewWorktrees?: { project: string; connectionId: string; path: string }[];
  /** Read only: the hosts found signed in, when `hosts` is empty. */
  discoveredHosts?: { host: string; provider: ForgeProvider }[];
};

/** Nothing user-specific: hosts come from the logins, projects from the user. */
export const DEFAULT_MR_REVIEWS_SETTINGS: MrReviewsSettings = {
  hosts: [],
  followed: [],
  checkout: "immediately",
  retentionDays: 3,
  curation: true,
  suggestDays: 30,
  hints: "",
  treeGroups: {},
  clones: {},
  order: [],
  pinned: [],
  hidden: [],
};

/**
 * Pushed to every page when the order, the pins or the removals change
 * (`{mr_reviews: ...}`): the order itself, so the list follows at once.
 */
export type MrReviewsPush = {
  version: number;
  order: string[];
  changed: ("order" | "pinned" | "hidden")[];
  by: "user" | "agent";
  /** What the agent did, in a few words, for a toast with Undo. */
  summary?: string;
  /** The version Undo takes back. */
  undo?: number;
};

/**
 * What counts as activity on a request for a hidden one to come back: a
 * push, a comment or a state change (not a pipeline or a title edit).
 */
export function mrActivityMarker(
  item: Pick<MrItem, "headSha" | "notes" | "state">,
): string {
  return `${item.headSha}|${item.notes}|${item.state}`;
}

/** "host/project", lower case: a project's key in the settings and state. */
export function mrProjectKey(ref: { host: string; project: string }): string {
  return `${ref.host.toLowerCase()}/${ref.project.toLowerCase()}`;
}

/** What the user sees of a request now, to tell what changes after. */
export function mrSeenOf(
  item: Pick<
    MrItem,
    "updatedAt" | "headSha" | "notes" | "state" | "pipeline" | "own"
  >,
  at: string,
): MrSeen {
  return {
    at,
    updatedAt: item.updatedAt,
    headSha: item.headSha,
    notes: item.notes,
    state: item.state,
    pipeline: item.pipeline,
    ...(item.own
      ? {
          approvedBy: item.own.approvedBy,
          unresolved: item.own.unresolved,
          conflicts: item.own.conflicts,
        }
      : {}),
  };
}

/** What changed since the user looked, or null when they never did. */
export function mrUnread(
  item: Pick<MrItem, "updatedAt" | "headSha" | "notes"> &
    Partial<Pick<MrItem, "state" | "pipeline" | "own">>,
  seen: MrSeen | undefined,
): MrUnread | null {
  if (!seen) return null;
  const newCommits = !!item.headSha && item.headSha !== seen.headSha;
  const newNotes = Math.max(0, item.notes - seen.notes);
  const out: MrUnread = {
    newCommits,
    newNotes,
    changed: newCommits || newNotes > 0 || item.updatedAt > seen.updatedAt,
  };
  // What a record from before these were kept does not hold is not said.
  if (seen.state && item.state && item.state !== seen.state)
    out.state = item.state;
  if (
    seen.pipeline !== undefined &&
    item.pipeline !== undefined &&
    item.pipeline !== seen.pipeline
  )
    out.pipeline = item.pipeline;
  const own = item.own;
  if (own && seen.approvedBy) {
    const before = new Set(seen.approvedBy);
    const added = own.approvedBy.filter((name) => !before.has(name));
    if (added.length) out.newApprovals = added;
  }
  if (own && seen.conflicts !== undefined && own.conflicts !== seen.conflicts)
    out.conflicts = own.conflicts;
  if (
    own &&
    own.unresolved !== null &&
    typeof seen.unresolved === "number" &&
    own.unresolved !== seen.unresolved
  )
    out.unresolved = own.unresolved;
  if (
    out.state ||
    "pipeline" in out ||
    out.newApprovals ||
    out.conflicts !== undefined ||
    out.unresolved !== undefined
  )
    out.changed = true;
  return out;
}

/**
 * A message of the reviews agent's chat, shaped as Ranger's (its tools as
 * activity); `opens` are the requests whose review it showed, opened by
 * the browser that asked (`request_id`).
 */
export type MrAgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  sent_at: string;
  tools: {
    id: string;
    name: string;
    status: "running" | "completed" | "failed";
    arguments?: string;
    output?: string;
  }[];
  /** None: its tools cite no workspace. */
  sources: AssistantSource[];
  thinking?: string[];
  request_id?: string;
  opens?: MrItem[];
  /** The turn ended in an error. */
  failed?: boolean;
};

/** The reviews agent's chat, as `bridge.mr_reviews.agent.*` gives it. */
export type MrAgentSnapshot = {
  instance_id: string;
  revision: number;
  /** The Claude Code session the next question resumes. */
  session_id?: string;
  model: string;
  running: boolean;
  error: string | null;
  messages: MrAgentMessage[];
  /** Questions waiting for the running one, oldest first. */
  queue: { id: string; mode: "follow_up"; text: string; sent_at: string }[];
};
