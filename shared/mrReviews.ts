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

/** Why a request is in the "For you" section. */
export type MrReason = "review_requested" | "assigned" | "mentioned";

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
};

/** What the user saw last time they looked. */
export type MrSeen = {
  at: string;
  updatedAt: string;
  headSha: string;
  notes: number;
};

export type MrUnread = {
  /** The head moved since the user looked. */
  newCommits: boolean;
  /** Comments added since. */
  newNotes: number;
  /** Anything changed since (a new note, a push, a state change). */
  changed: boolean;
};

export type MrSection = "mine" | "suggested";

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
};

/** "host/project", lower case: a project's key in the settings and state. */
export function mrProjectKey(ref: { host: string; project: string }): string {
  return `${ref.host.toLowerCase()}/${ref.project.toLowerCase()}`;
}

/** What changed since the user looked, or null when they never did. */
export function mrUnread(
  item: Pick<MrItem, "updatedAt" | "headSha" | "notes">,
  seen: MrSeen | undefined,
): MrUnread | null {
  if (!seen) return null;
  const newCommits = !!item.headSha && item.headSha !== seen.headSha;
  const newNotes = Math.max(0, item.notes - seen.notes);
  return {
    newCommits,
    newNotes,
    changed: newCommits || newNotes > 0 || item.updatedAt > seen.updatedAt,
  };
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
