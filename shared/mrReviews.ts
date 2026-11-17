import type { AssistantSource } from "./assistant";
import { forgeRefLabel } from "./forge";
import { type WorkspaceRef, workspaceRefKey } from "./workspaceTree";
import {
  EMPTY_MR_MERGE_SETTINGS,
  type MrMergeInfo,
  type MrMergeSettings,
} from "./mrReviewsMerge";
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
  /** The forge's labels (at most 10). */
  labels?: string[];
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
  /** What the user (or an agent) set on it by hand. */
  override?: MrOverride;
  /**
   * The override's whose-move and next step were set before the request
   * moved on (its activity marker changed): shown dimmed, "changed since".
   */
  overrideOutdated?: boolean;
  /** What Roamgate inferred of one's own work (section 7), when it did. */
  inferred?: MrInferred;
  /** The inference no longer holds: the request moved on meaningfully since. */
  inferredOutdated?: boolean;
  /** One's own work: whose move it is (override, inference, else rules). */
  lane?: MrLane;
  /** Why it is in its lane, in a few words (the rule, or who set it). */
  laneWhy?: string;
  /** The next step, and where it comes from. */
  next?: MrNextStep;
  /** The requests it waits for (keys), override first. */
  dependsOn?: string[];
  /**
   * Drawn under this request (an open request it depends on, in the list):
   * the key of its parent. Absent for cycles and for dependencies not
   * listed.
   */
  parent?: string;
  /** A branch the user said will be a request (not proposed yet). */
  unsent?: boolean;
  /**
   * A branch headed upstream (no request yet): its key is
   * `branch:<provider>:<host>/<project>@<branch>`, its project the target's.
   */
  branch?: MrBranchInfo;
  /** A request opened from a branch headed upstream: that branch. */
  fromBranch?: string;
  /** Its checkout here: commits not pushed, local changes. */
  local?: { unpushed: number; dirty: number; workspace: string };
  /** The upstreaming effort it is a part of (its name). */
  effort?: string;
  /** A merge scheduled by a label, or a bot merging it (section 15). */
  merge?: MrMergeInfo;
};

/** A branch headed upstream, as its workspace's checkout has it. */
export type MrBranchInfo = {
  name: string;
  connectionId: string;
  connectionLabel: string;
  workspaceId: string;
  workspaceLabel: string;
  path: string;
  /** The target it is compared with ("origin/main"). */
  target: string;
  ahead: number;
  behind: number;
  /** Files changed and not committed. */
  dirty: number;
  /** Commits not pushed to its own upstream branch. */
  unpushed?: number;
  /** Its commits beyond the target, newest first (at most 50 here). */
  commits: { sha: string; subject: string; at: string }[];
  /** The Headed upstream group it is in. */
  group: string;
};

/** A branch's key: the target project and the branch name (D6). */
export function mrBranchKey(ref: {
  provider: ForgeProvider;
  host: string;
  project: string;
  branch: string;
}): string {
  return `branch:${ref.provider}:${ref.host.toLowerCase()}/${ref.project.toLowerCase()}@${ref.branch}`;
}

/** How a row is named: a request's reference, or a branch's name. */
export function mrRefLabel(
  entry: ForgeRef & Pick<MrInboxEntry, "branch">,
  short = false,
): string {
  if (entry.branch)
    return short ? entry.branch.name : `${entry.project}@${entry.branch.name}`;
  return forgeRefLabel(entry, short);
}

/** A branch key's parts; null for any other key. */
export function parseBranchKey(key: string): {
  provider: ForgeProvider;
  host: string;
  project: string;
  branch: string;
} | null {
  const match = /^branch:(gitlab|github):([^/]+)\/([^@]+)@(.+)$/.exec(key);
  if (!match) return null;
  return {
    provider: match[1] as ForgeProvider,
    host: match[2]!,
    project: match[3]!,
    branch: match[4]!,
  };
}

/** Whose move it is on one's own request. */
export type MrWhose = "me" | "reviewer" | "external" | { person: string };

/**
 * What the user (or an agent) set by hand on one of their requests: each
 * field set wins over what Roamgate infers. Kept in settings.json
 * (`mr_reviews.overrides`), on every device.
 */
export type MrOverride = {
  whose?: MrWhose;
  next?: string;
  /** Request keys it waits for. */
  dependsOn?: string[];
  labels?: string[];
  /** A URL, or a path on the workspace that has it (notes, a plan). */
  link?: string;
  stale?: boolean;
  at: string;
  by: "user" | "agent";
  /** The request's activity marker when it was set (mrActivityMarker). */
  marker: string;
};

/** The fields of an override one may set or clear. */
export const MR_OVERRIDE_FIELDS = [
  "whose",
  "next",
  "dependsOn",
  "labels",
  "link",
  "stale",
] as const;
export type MrOverrideField = (typeof MR_OVERRIDE_FIELDS)[number];

/**
 * The lanes one's own work is grouped in: whose move it is. "done":
 * merged or closed lately.
 */
export type MrLane =
  | "your_move"
  | "waiting"
  | "merging"
  | "blocked"
  | "not_sent"
  | "stale"
  | "done";

export const MR_LANES: MrLane[] = [
  "your_move",
  "waiting",
  "merging",
  "blocked",
  "not_sent",
  "stale",
  "done",
];

export const MR_LANE_TITLE: Record<MrLane, string> = {
  your_move: "Your move",
  waiting: "Waiting",
  merging: "Merging",
  blocked: "Blocked",
  not_sent: "Not proposed upstream yet",
  stale: "Stale",
  done: "Merged or closed",
};

/** The next step on a request, and who said it. */
export type MrNextStep = {
  text: string;
  /** override: set by hand; rule: from the forge's status. */
  from: "override" | "rule" | "inferred";
  /** For an override: who set it. */
  by?: "user" | "agent";
};

/**
 * What Roamgate inferred of one of the user's own requests or branches:
 * derived (state.json), never synced nor exported. Overrides win over it.
 */
export type MrInferred = {
  whose: MrWhose;
  next: string;
  /** Request keys it waits for (references found, branch containment, the model). */
  dependsOn: string[];
  stale: boolean;
  /** The row's version when inferred (head, notes, state, pipeline...). */
  version: string;
  /** The facts it stood on, to tell a meaningful change (D7). */
  facts: string;
  at: string;
  /** model: Claude read it; local: only what was found without a model. */
  by: "model" | "local";
};

/** How a whose-move reads: "me", "reviewer", "external" or the person. */
export function mrWhoseLabel(whose: MrWhose): string {
  return typeof whose === "string" ? whose : whose.person;
}

/** "me" | "reviewer" | "external" | a person's name, as typed. */
export function parseMrWhose(text: string): MrWhose | null {
  const value = text.trim().replace(/^@/, "");
  if (!value || value.length > 80 || /\s/.test(value)) return null;
  const lower = value.toLowerCase();
  if (lower === "me" || lower === "reviewer" || lower === "external")
    return lower;
  if (lower === "you" || lower === "mine") return "me";
  return /^[\w.-]+$/.test(value) ? { person: value } : null;
}

/**
 * A workspace that is a request's (`bridge.mr_reviews.links`): on its
 * branch, named after it, made as its home ("Start a review with a home"),
 * or its review workspace, on any connection.
 */
export type MrWorkspaceLink = {
  connectionId: string;
  connectionLabel: string;
  workspaceId: string;
  label: string;
  why: ("home" | "branch" | "name" | "review")[];
};

/**
 * A request's homes: its workspaces other than the project's shared review
 * workspace (one linked only as where its review is), the first first.
 */
export function mrHomeLinks(
  links: readonly MrWorkspaceLink[] | undefined,
): MrWorkspaceLink[] {
  return (links ?? []).filter((link) =>
    link.why.some((why) => why !== "review"),
  );
}

/**
 * The search and filter the Reviews panel shows, kept across runs and
 * devices (`mr_reviews.panel`): `at` orders the writes, so an older answer
 * never takes a newer search back.
 */
export type MrPanelState = { search: string; filter: string; at: string };

/** The first prompt of a request's home agent, when the setting is empty. */
export const DEFAULT_MR_HOME_PROMPT = [
  "This workspace is the home of the review of {url}",
  '({ref} "{title}" by {author}, into {target}).',
  "Review it with Roamgate's review tools: open its review in this workspace's",
  "Changes, read the forge discussions, and draft your comments as the",
  "user's pending drafts: only the user sends them. Never post to the forge",
  "(no comment, approval, push or merge). Keep your notes here, in this",
  "workspace, for the next sessions. Start with a short summary of the",
  "request and what you plan to look at.",
].join(" ");

/** The home prompt with the request's facts in place of its {fields}. */
export function mrHomePrompt(
  template: string,
  facts: {
    url: string;
    ref: string;
    title: string;
    author: string;
    target: string;
    source: string;
    project: string;
  },
): string {
  const text = template.trim() || DEFAULT_MR_HOME_PROMPT;
  return text.replace(
    /\{(url|ref|title|author|target|source|project)\}/g,
    (_, name: keyof typeof facts) => facts[name],
  );
}

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
  /** The inference of whose move it is (section 7). */
  inference?: MrCurationState;
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
  /** The user's saved searches. */
  views?: MrSavedView[];
  /** The search and filter kept across runs and devices. */
  panel?: MrPanelState;
  /** Upstreaming efforts' cards. */
  efforts?: MrEffortSummary[];
  /** The Workspaces-tree groups headed upstream. */
  upstreamGroups?: string[];
  /** The workspaces headed upstream by themselves, outside such a group. */
  upstreamWorkspaces?: WorkspaceRef[];
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
  /** Claude infers whose move it is and the next step of one's own work. */
  inference: boolean;
  /** Hours between two inference runs over what moved (D7). */
  inferenceHours: number;
  /**
   * The model the inference runs on, any name the agent takes; empty:
   * automatic (Sonnet, D27).
   */
  inferenceModel: string;
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
  /**
   * Read only: the inbox version, counting every change of what the user
   * authored here (order, pins, removals, overrides...).
   */
  orderVersion?: number;
  /** Requests the user added by URL, newest first. */
  pinned: ForgeRef[];
  /**
   * Requests the user removed from the view, with their activity marker
   * (mrActivityMarker) at that time: shown again once it changes.
   */
  hidden: { key: string; marker: string }[];
  /** What was set by hand on requests, by request key. */
  overrides: Record<string, MrOverride>;
  /** A request quiet this many days is Stale. */
  staleDays: number;
  /** Saved searches, shown as chips after All / To review / Mine. */
  views: MrSavedView[];
  /** Workspaces-tree groups headed upstream (node ids; nested ones too). */
  upstreamGroups: string[];
  /** Workspaces in such a group that are not (the tree's references). */
  upstreamSkip: WorkspaceRef[];
  /**
   * Workspaces headed upstream by themselves, in no such group (the
   * tree's references; a workspace needs no node of the tree for it).
   */
  upstreamWorkspaces: WorkspaceRef[];
  /** Branches said to be requests, not proposed yet (D25: "not sent"). */
  unsent: MrUnsent[];
  /** Upstreaming efforts, each declared on a group headed upstream. */
  efforts: MrEffort[];
  /** Scheduled merges and merge bots: patterns and names, per scope. */
  merge: MrMergeSettings;
  /** The search and filter the panel shows, on every device. */
  panel: MrPanelState;
  /**
   * The first prompt of a request's home agent ({url} {ref} {title}
   * {author} {target} {source} {project}); empty: DEFAULT_MR_HOME_PROMPT.
   */
  homePrompt: string;
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
  inference: true,
  inferenceHours: 12,
  inferenceModel: "",
  suggestDays: 30,
  hints: "",
  treeGroups: {},
  clones: {},
  order: [],
  pinned: [],
  hidden: [],
  overrides: {},
  staleDays: 90,
  views: [],
  upstreamGroups: [],
  upstreamSkip: [],
  upstreamWorkspaces: [],
  unsent: [],
  efforts: [],
  merge: EMPTY_MR_MERGE_SETTINGS,
  panel: { search: "", filter: "all", at: "" },
  homePrompt: "",
};

/** Whether a stored workspace reference names that workspace. */
export function sameUpstreamWorkspace(
  stored: WorkspaceRef,
  ref: WorkspaceRef,
): boolean {
  return (
    workspaceRefKey(stored) === workspaceRefKey(ref) ||
    (stored.connection_id === ref.connection_id &&
      !!stored.path &&
      stored.path === ref.path)
  );
}

/**
 * The home id of a workspace headed upstream by itself: what its branches
 * and efforts name in place of a group node (`ws-` and a hash of its
 * reference's identity, so it is the same on every page and the server).
 */
export function upstreamWorkspaceHome(ref: WorkspaceRef): string {
  const text = workspaceRefKey(ref);
  // Two 32-bit FNV-1a passes with different seeds: 16 hex digits.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 + 2) >>> 0;
  }
  return `ws-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * An upstreaming effort: a large branch (the source) followed commit by
 * commit until all of it is upstream, declared on a group headed upstream
 * or on a workspace headed upstream by itself.
 */
export type MrEffort = {
  id: string;
  /**
   * Its home: the Workspaces-tree group node, or a workspace's
   * `upstreamWorkspaceHome`.
   */
  group: string;
  name: string;
  /** The clone the source is read in. */
  clone: { connectionId: string; path: string };
  /** An exact ref: refs/remotes/<remote>/<branch> or refs/heads/<branch>. */
  source: string;
  /** The upstream project's branch. */
  target: { remote: string; branch: string };
  /** Exact refs whose commits land into the source. */
  feeders: string[];
  /** The head workspace (its Claude session leads the effort). */
  head?: { connectionId: string; path: string; workspaceId?: string };
};

/** What happens to one commit of an effort. */
export type MrDisposition =
  | "upstream"
  | "in_review"
  | "in_part"
  | "planned"
  | "not_for_upstream"
  | "superseded"
  | "unsorted";

export const MR_DISPOSITIONS: MrDisposition[] = [
  "upstream",
  "in_review",
  "in_part",
  "planned",
  "not_for_upstream",
  "superseded",
  "unsorted",
];

/** An effort as the inbox shows it: its card. */
export type MrEffortSummary = {
  id: string;
  name: string;
  group: string;
  source: string;
  target: string;
  total: number;
  counts: Partial<Record<MrDisposition, number>>;
  /** Feeders' commits not on the source yet. */
  notReady: number;
  /** When the ledger was last derived. */
  at?: string;
  /** Read problem (the clone is unreachable, a ref is gone). */
  error?: string;
  /** Other efforts or branches holding some of its commits. */
  overlaps: MrOverlap[];
  head?: { connectionId: string; workspaceId?: string; label?: string };
  /** Unsorted commits with a fuzzy match to confirm or reject. */
  proposals?: number;
  /** Planned requests, by state. */
  plans?: { proposed: number; accepted: number };
  /** What changed since the user last looked (What changed). */
  changed?: number;
};

/**
 * A planned request of an effort (D25): commits the leader session
 * proposed (or the user made) to go upstream together. Accepted, it gets
 * its part: a worktree in the effort's group with its commits picked.
 */
export type MrPlan = {
  id: string;
  name: string;
  /** Ledger keys, in source order. */
  commits: string[];
  /** Plans it comes after (ids). */
  dependsOn: string[];
  state: "proposed" | "accepted";
  part?: {
    connectionId: string;
    path: string;
    branch: string;
    workspaceId?: string;
    /** The pick stopped here: the commit and its conflicting files. */
    conflict?: { sha: string; subject: string; files: string[] };
  };
  at: string;
  by: "user" | "agent";
};

/** An upstream commit proposed as the same change as an effort's commit (D14). */
export type MrMatchProposal = {
  sha: string;
  subject: string;
  author: string;
  /** 0 to 1. */
  score: number;
  /** What made it close: "same files, subject words, size". */
  why: string;
};

/** What changed in an effort since the user last looked. */
export type MrEffortChanges = {
  since: string | null;
  /** Commits unsorted now that were not before (new on the source, or put back). */
  unsorted: string[];
  /** Commits upstream now that were not. */
  landed: string[];
  /** Commits in review now that were not. */
  inReview: string[];
  /** Feeders whose commits reached the source: how many. */
  feeders: { ref: string; landed: number }[];
  /** Plans whose part is all upstream now. */
  partsMerged: string[];
  /** Commits with proposals to confirm or reject. */
  proposals: string[];
  /** Said not for upstream, yet upstream. */
  upstreamAnyway: string[];
};

/** Commits two branches or efforts share (D23). */
export type MrOverlap = {
  with: string;
  /** effort or branch key. */
  kind: "effort" | "branch";
  shared: number;
  /** same: the same commits; contains: all of one is in the other. */
  relation: "same" | "contains" | "contained" | "partial";
  proposal: string;
};

/** A branch said to be a request before it is one. */
export type MrUnsent = {
  key: string;
  title?: string;
  /** Its target branch, when not the default one. */
  target?: string;
  at: string;
};

/** A saved search: its name and its query (section 5's tokens and words). */
export type MrSavedView = { name: string; query: string };

/** What a push says changed (`MrReviewsPush.changed`). */
export const MR_PUSH_KINDS = [
  "order",
  "pinned",
  "hidden",
  "overrides",
  "views",
  "unsent",
  "upstream",
  "efforts",
  "effort",
  "panel",
] as const;
export type MrPushKind = (typeof MR_PUSH_KINDS)[number];

/**
 * Pushed to every page when what the user authored here changes (the
 * order, pins, removals, overrides...: `{mr_reviews: ...}`): the order
 * itself, so the list follows at once.
 */
export type MrReviewsPush = {
  version: number;
  order: string[];
  changed: MrPushKind[];
  by: "user" | "agent";
  /** What the agent did, in a few words, for a toast with Undo. */
  summary?: string;
  /** The version Undo takes back. */
  undo?: number;
  /** An effort's ledger changed: which, and the bulk change Undo takes back. */
  effort?: { id: string; journal?: number };
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
