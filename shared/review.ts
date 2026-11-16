import type { FileEdit } from "./fileEdits";

/**
 * Review sessions: a diff under review plus the threads written on it.
 *
 * Two kinds of thread share one shape. A `discussion` is the private
 * conversation between the user and the agent working in a pane; it is never
 * published. A `draft` is a review comment meant for the merge request; in
 * a merge request's review the user's live as GitLab draft notes, others
 * here until sent there.
 */

/** What is being reviewed. Ranges keep ref names so they follow rebases. */
export type ReviewTarget =
  | {
      kind: "range";
      base: string;
      head: string;
      /**
       * Compare the two trees (`git diff BASE HEAD`) instead of what HEAD
       * adds since their merge-base: what changed between two versions of a
       * rewritten branch, such as before and after a force-push.
       */
      compare?: boolean;
    }
  | { kind: "worktree" }
  /**
   * What an agent's last step changed in the checkout (plan D15): the
   * worktree snapshots (`git write-tree` of the files, untracked ones
   * included) taken before and after it. Its trees stay under
   * `refs/roamgate/steps/` while the step has threads, and for the last 5
   * steps.
   */
  | {
      kind: "step";
      /** The step's id: its snapshot refs' name. */
      step: string;
      /** The trees before and after the step. */
      before: string;
      after: string;
      /** When the step ended. */
      at?: string;
      /** Untracked files left out of the snapshots: too large. */
      skipped?: string[];
    }
  | { kind: "mr"; url: string }
  /**
   * An agent chat (its agent session, or its pane): no diff, threads on
   * parts of its messages.
   */
  | { kind: "chat"; chat: string }
  /**
   * A file of the checkout as Roamgate renders it (Markdown, HTML, SVG,
   * an image: `path`, relative to the root), or a site's pages (`url`, an
   * http(s) URL): no diff, threads on what the user points at.
   */
  | { kind: "rendered"; path?: string; url?: string }
  /**
   * An upstreaming effort's view in Reviews (its id): no diff, threads on
   * what the view shows, delivered to the effort's leader session.
   */
  | { kind: "effort"; effort: string };

export type ReviewSide = "old" | "new";

/** A last step's review: "last step 14:02" (when it ended), else its trees. */
export function describeStepTarget(
  target: Extract<ReviewTarget, { kind: "step" }>,
): string {
  const at = target.at ? new Date(target.at) : null;
  if (at && !Number.isNaN(at.getTime()))
    return `last step ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `last step ${target.before.slice(0, 7)}..${target.after.slice(0, 7)}`;
}

/**
 * Where a thread was written. No path: the whole review. A path without a
 * line: the file. `line` (and `endLine` for a range) count on `side`.
 * `text` is the anchored line as it read then, so the thread can find its
 * line again after the code moves, or be shown as outdated once it is gone.
 */
export type ReviewAnchor = {
  path?: string;
  line?: number;
  endLine?: number;
  side?: ReviewSide;
  text?: string;
  /** The old-side number of an unchanged line anchored on the new side. */
  contextOld?: number;
  /** The path before a rename, when it differs. */
  oldPath?: string;
  /** Written on one commit's diff (absent: on the whole change). */
  commit?: string;
  /** That commit's subject, to find it again after a rebase. */
  commitSubject?: string;
  /** That commit's parent: the base of a GitLab position on it. */
  commitParent?: string;
  /**
   * On a part of an earlier message: the thread and comment it is in, and
   * the words quoted from it. The rest of the anchor is that thread's.
   */
  message?: ReviewMessagePart;
  /**
   * On a part of a message of an agent chat (a chat review). With a path,
   * on a file a tool call of the chat changed (its diff card): the path,
   * and the lines with their text when on lines, say where, as on a diff.
   */
  chat?: ReviewChatPart;
  /** On what an effort's view shows (an effort review). */
  effort?: ReviewEffortPart;
  /**
   * On what a rendered review shows: the words, the graphic's region or
   * the page's element pointed at. `path` and the lines, when known, are
   * where it comes from in the source.
   */
  render?: ReviewRenderPart;
  /** On words selected in a terminal: its pane, as named then. */
  terminal?: { pane: string; title: string; quote: string };
  /**
   * A comment written in a workspace view or on terminal text: its note
   * there (JSON), which Copy and Send read back word for word.
   */
  feedback?: string;
};

/** A box (or a point: no size) in fractions of a graphic's drawn size. */
export type ReviewRegion = { x: number; y: number; w: number; h: number };

export type ReviewRenderPart = {
  /** The words selected, as shown. */
  quote?: string;
  /** A site's page or an HTML file's page: its path and query. */
  url?: string;
  /** The page's element, as a CSS selector. */
  selector?: string;
  /** Where on a graphic (diagram, SVG, image). */
  region?: ReviewRegion;
  /** Which graphic: "diagram 2", an image's name. */
  graphic?: string;
  /** The SVG element clicked: its id, else its text. */
  element?: string;
  /**
   * An animated graphic's state when the comment started (it is paused
   * then): its time, as "2.4 s", or its frame.
   */
  moment?: string;
  /** The region's crop, an image saved with the review (absolute path). */
  snapshot?: string;
};

/** The tabs of an effort's view. */
export const REVIEW_EFFORT_TABS = [
  "board",
  "progress",
  "ledger",
  "plans",
  "feeders",
  "changes",
] as const;
export type ReviewEffortTab = (typeof REVIEW_EFFORT_TABS)[number];

/** What one points at in an effort's view. */
export const REVIEW_EFFORT_ITEMS = [
  /** A planned request: its id. */
  "plan",
  /** A commit (a Ledger row, a plan's commit, a What changed entry): its ledger key, which follows rebases by patch id. */
  "commit",
  /** A count of the Progress tab: its name ("upstream", "total"...). */
  "counter",
  /** A directory of the Progress breakdown: its path. */
  "directory",
  /** A feeder: its ref. */
  "feeder",
  /** A part of What changed: its heading. */
  "change",
  /** A card of the Board: its planned request's id. */
  "card",
] as const;
export type ReviewEffortItemKind = (typeof REVIEW_EFFORT_ITEMS)[number];

/**
 * Where a thread of an effort review is: the tab, what was pointed at in
 * it by a stable key (absent: the tab itself), and the words selected.
 */
export type ReviewEffortPart = {
  tab: ReviewEffortTab;
  item?: {
    kind: ReviewEffortItemKind;
    key: string;
    /** How it read: a plan's name, a commit's sha and subject. */
    label?: string;
  };
  /** A commit shown in a plan: that plan's id. */
  plan?: string;
  /** The words commented on. */
  quote?: string;
};

/**
 * The agent session an effort review's comments follow: its leader, the
 * Claude session of its head workspace, looked up when they are sent.
 */
export const EFFORT_SESSION_PREFIX = "effort:";

/** Why an effort's comments wait: no leader session runs. */
export const EFFORT_NO_LEADER =
  "no leader session runs for this effort: the comments wait for one";

/** A thread's place in an effort's view, in words. */
export function describeEffortPart(part: ReviewEffortPart): string {
  const tab = {
    board: "Board",
    progress: "Progress",
    ledger: "Ledger",
    plans: "Plans",
    feeders: "Feeders",
    changes: "What changed",
  }[part.tab];
  const item = part.item;
  if (!item) return `the ${tab} tab`;
  const label = item.label ? ` "${item.label}"` : "";
  const name =
    item.kind === "plan"
      ? `planned request ${item.key}${label}`
      : item.kind === "commit"
        ? `commit${label} (ledger key ${item.key})${part.plan ? ` in planned request ${part.plan}` : ""}`
        : item.kind === "counter"
          ? item.label
            ? `the count "${item.label}"`
            : `the ${item.key} count`
          : item.kind === "directory"
            ? `directory ${item.key}`
            : item.kind === "feeder"
              ? `feeder ${item.key}`
              : item.kind === "card"
                ? `the card of planned request ${item.key}${label}`
                : `"${item.label ?? item.key}"`;
  return `${name} in the ${tab} tab`;
}

export type ReviewChatPart = {
  /** The chat message's id in the agent's history. */
  entry: string;
  /** When it was written, and how it starts: for the agent to find it. */
  at?: string;
  excerpt?: string;
  /** The words commented on. */
  quote: string;
  /**
   * On a file change: the id of the tool call that made it, which keeps
   * when the chat reads the call with another entry id.
   */
  call?: string;
};

export type ReviewMessagePart = {
  thread: string;
  comment: string;
  quote: string;
};

export type ReviewCommit = {
  sha: string;
  parent: string | null;
  author: string;
  date: string;
  subject: string;
  body: string;
  /**
   * History of a branch with no commits of its own (the default branch
   * itself), latest first: not the branch's work.
   */
  history?: true;
};

/**
 * `merge-request`: a discussion on the GitLab merge request, shown read-only
 * apart from replying, which posts publicly.
 */
export type ReviewThreadKind = "discussion" | "draft" | "merge-request";

/** The user is `you`; an agent signs with its own name. */
export const REVIEW_USER = "you";

export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** A draft reply in a GitLab discussion: on GitLab, not published yet. */
  gitlabDraftId?: number;
};

export type ReviewThread = {
  id: string;
  sessionId: string;
  kind: ReviewThreadKind;
  anchor: ReviewAnchor;
  comments: ReviewComment[];
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  /** Set for threads that live on GitLab. */
  gitlab?: { draftId?: number; discussionId?: string; headSha?: string };
  /**
   * A local review comment answering a GitLab discussion (its id): it
   * becomes a draft reply there when the drafts go to GitLab.
   */
  gitlabReplyTo?: string;
  /**
   * A local review comment: the merge request (URL) of the branch it was
   * written on. It waits in that merge request's review, whatever the
   * checkout is on later.
   */
  pendingFor?: string;
  /**
   * Held in the workspace's Review feedback until the user sends it: the
   * agent does not hear of it, and its value orders the feedback list.
   */
  held?: number;
  /** Handed to the agent in one prompt: what it says then has been heard. */
  handedAt?: string;
};

export type ReviewAgentStatus = {
  name?: string;
  paneId?: string;
  /**
   * The agent session that ran in that pane when it was bound: should the
   * pane go, the comments follow the session to the pane running it.
   */
  sessionId?: string;
  /** What the agent says it is doing; `threadId` when on one thread. */
  working?: { at: string; message?: string; threadId?: string };
  update?: { at: string; message?: string };
};

export type ReviewSession = {
  id: string;
  connectionId: string;
  workspaceId?: string;
  /** Repository root on the connection's host. */
  root: string;
  title: string;
  target: ReviewTarget;
  /**
   * A range opened against Automatic's base (no base named): it follows
   * that base when it moves between the local default branch and its
   * remote counterpart, its comments with it. False for a base someone
   * named; absent on reviews from before.
   */
  automaticBase?: boolean;
  /**
   * A review of a GitLab merge request (target `mr`): its discussions and
   * draft notes are shown. Always false for a local review.
   */
  gitlab: boolean;
  /** The overall comment of the draft review. */
  summary: string;
  /**
   * A merge request's review: the overall comment was written by the agent and is not on
   * GitLab yet; it goes with the user's other drafts.
   */
  summaryUnsent?: boolean;
  /** The overall comment as the agent last had it (or wrote it). */
  summarySent?: string;
  agent: ReviewAgentStatus;
  /** Set when the user hands the open threads to the agent. */
  handoffAt?: string;
  /** The head commit the last time the diff was shown. */
  seenHeadSha?: string;
  /** Send the user's discussion comments to the agent as they are written. */
  autoSend?: boolean;
  /**
   * Hold the user's discussion comments until they hand the review over
   * (Send to the agent), instead of sending each as it is written.
   */
  holdComments?: boolean;
  /** Up to when the user's comments were delivered to the agent. */
  deliveredAt?: string;
  /** Why the last delivery to the agent failed, until one succeeds. */
  deliveryError?: string;
  /**
   * Files the user marked reviewed, as tuicr does: `view:path` (the view is
   * a commit, or `all`) to a fingerprint of the file's diff then. A file
   * whose diff changed since is no longer reviewed. Hunks are marked the
   * same way, `view:path\nid` to "1" (the id hashes the hunk's changed
   * lines, so a hunk whose lines change is no longer reviewed); "" keeps an
   * unmark in that view.
   */
  reviewed?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

/** What changed since the user last looked, for the reviews list. */
/** What a review can no longer find: its checkout, or an end of its range. */
export type ReviewGoneCode = "checkout-gone" | "base-gone" | "head-gone";

export function isReviewGoneCode(code: unknown): code is ReviewGoneCode {
  return (
    code === "checkout-gone" || code === "base-gone" || code === "head-gone"
  );
}

export type ReviewActivity = {
  sessionId: string;
  /** The branch moved since the diff was last shown. */
  newCommits: boolean;
  headSha?: string;
  /** Its checkout or a commit of its range was found gone lately. */
  gone?: ReviewGoneCode;
};

export type ReviewMergeRequest = {
  url: string;
  title: string;
  state: string;
  headSha: string;
  /** Confidential: never sent to the agent. */
  security: boolean;
};

/**
 * The GitLab merge request of a local review's branch, whose review opens
 * from there; for a review of a merge request, the same one,
 * when the checkout is on its branch.
 */
export type ReviewMergeRequestLink = {
  url: string;
  title: string;
  /** Its `!` number. */
  number: number;
};

export type ReviewSnapshot = {
  session: ReviewSession;
  threads: ReviewThread[];
  /**
   * The threads of the checkout's other reviews on what this one shows: in
   * a code review, those of its rendered files; in a rendered file, those
   * of the code reviews on it (a merge request's GitLab threads too). Each
   * stays in its own review (its sessionId), which delivers it to the agent
   * and takes what is written on it.
   */
  shared?: ReviewThread[];
  /** A merge request's review: the merge request, once read. */
  mergeRequest?: ReviewMergeRequest;
  /** A merge request's review could not reach the merge request. */
  gitlabError?: string;
};

/** Pushed to every browser; each keeps the sessions of its connections. */
/**
 * An agent asking leave to use a tool (Claude Code's permission prompt), sent
 * by its hook: answered from the phone, or by the terminal once it gives up.
 */
export type AgentPermissionPrompt = {
  id: string;
  connectionId: string;
  paneId: string;
  agent: string;
  tool: string;
  /** What it would do: the command, the file, the URL. */
  summary: string;
  /** The tool's input, shortened. */
  detail?: string;
  /** A file edit it asks to make (Edit, Write...): the change, shown. */
  file_edit?: FileEdit;
  /** "Allow, and don't ask again" applies, as the terminal offers it. */
  canAlways: boolean;
  createdAt: string;
  /** When the hook stops waiting and the terminal asks instead. */
  expiresAt: string;
  /** Claude's multiple-choice questions (AskUserQuestion), not a permission. */
  questions?: AgentQuestion[];
  /**
   * No terminal can ask it instead (conversation mode's headless claude):
   * unanswered, the tool is denied.
   */
  noTerminal?: boolean;
};

/** One of Claude's questions, as its AskUserQuestion tool puts it. */
export type AgentQuestion = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
};

/**
 * "dismiss": the user puts the prompt away without answering it. The agent
 * is told so (a denial saying the user dismissed it) and goes on.
 */
export type AgentPermissionAnswer = "allow" | "always" | "deny" | "dismiss";

/** What the agent is told of a question the user dismissed. */
export const DISMISSED_QUESTION_MESSAGE =
  "The user dismissed this question without answering.";
/** What the agent is told of a permission the user dismissed. */
export const DISMISSED_PERMISSION_MESSAGE =
  "The user dismissed this request without answering.";

/** Whether a tool's result is the denial a dismissed prompt sends. */
export function isDismissedResult(text: string | undefined | null): boolean {
  return (
    !!text &&
    (text.includes(DISMISSED_QUESTION_MESSAGE) ||
      text.includes(DISMISSED_PERMISSION_MESSAGE))
  );
}
/** Each question's text to the chosen labels (", "-joined) or the user's own. */
export type AgentQuestionAnswers = Record<string, string>;
export type AgentPromptAnswer =
  | AgentPermissionAnswer
  | { answers: AgentQuestionAnswers };

export type ReviewPush =
  | {
      type: "prompts";
      connectionId: string;
      prompts: AgentPermissionPrompt[];
    }
  | { type: "session"; snapshot: ReviewSnapshot }
  | { type: "removed"; sessionId: string; connectionId: string }
  | {
      type: "open";
      sessionId: string;
      connectionId: string;
      paneId?: string;
      message?: string;
    };

export type ReviewLineKind = " " | "+" | "-";

export type ReviewDiffLine = {
  kind: ReviewLineKind;
  old: number | null;
  new: number | null;
  text: string;
  /** Context the reviewer revealed around a hunk; not part of the patch. */
  expanded?: true;
};

export type ReviewDiffHunk = { header: string; lines: ReviewDiffLine[] };

export type ReviewDiffFile = {
  path: string;
  oldPath: string;
  binary?: boolean;
  /** The commit's message, shown as a file so its lines can be commented. */
  commitMessage?: true;
  hunks: ReviewDiffHunk[];
  /**
   * In a summary (`ReviewDiff.summary`): what git says of the file, its
   * hunks read file by file later.
   */
  status?: ReviewFileStatus;
  additions?: number;
  deletions?: number;
  /** Marked generated (linguist-generated, gitlab-generated). */
  generated?: boolean;
  /** Its patch was cut at the per-file limit: the hunks read end there. */
  truncated?: boolean;
};

/** A file's change in a review summary. */
export type ReviewFileStatus = "added" | "deleted" | "renamed" | "modified";

/** The path comments on a commit message are anchored to. */
export const COMMIT_MESSAGE_PATH = ":commit-message";

export type ReviewDiff = {
  files: ReviewDiffFile[];
  /** Resolved commits, when the target has them. */
  baseSha?: string;
  headSha?: string;
  truncated: boolean;
  /**
   * Asked for the view a review opens on (`first`): the commit it is the
   * diff of, the oldest of the review's; null for all the changes.
   */
  view?: string | null;
  /**
   * The files only, no hunks (asked with `summary`): each is read with
   * `files` and the two commits above, a few at a time, whatever the size
   * of the whole change.
   */
  summary?: true;
};

/** The most files one `review.diff` with `files` reads. */
export const REVIEW_DIFF_FILES_MAX = 32;

export const REVIEW_LIMITS = {
  bodyChars: 20_000,
  summaryChars: 20_000,
  threadsPerSession: 2_000,
  commentsPerThread: 500,
  messageChars: 500,
  titleChars: 300,
  sessions: 500,
} as const;

/** A comment rewritten after it was first written. */
export function commentEdited(comment: ReviewComment): boolean {
  return comment.updatedAt > comment.createdAt;
}

/**
 * A discussion needs an answer from `agent` when it is open and someone else
 * spoke last, or rewrote a comment after the agent's last word. Drafts are
 * the user's review, not a conversation.
 */
/** A review comment that suggests a change (a ```suggestion block). */
export function isSuggestion(thread: ReviewThread): boolean {
  return (
    thread.kind === "draft" &&
    thread.comments.some((comment) => /```suggestion\b/.test(comment.body))
  );
}

export function threadNeedsAnswer(
  thread: ReviewThread,
  agent: string,
  /** A local review: a suggested change is for the agent to apply. */
  options: { suggestions?: boolean } = {},
): boolean {
  if (thread.resolved || thread.held !== undefined) return false;
  if (
    thread.kind !== "discussion" &&
    !(options.suggestions && isSuggestion(thread))
  )
    return false;
  const last = thread.comments[thread.comments.length - 1];
  if (last === undefined) return false;
  if (last.author !== agent) return true;
  const answered = thread.comments
    .filter((comment) => comment.author === agent)
    .reduce(
      (latest, comment) =>
        comment.updatedAt > latest ? comment.updatedAt : latest,
      "",
    );
  return thread.comments.some(
    (comment) => comment.author !== agent && comment.updatedAt > answered,
  );
}

/**
 * The user's comments in a thread the agent has not had: newer than the
 * last delivery (`since`), and not answered since (an answered comment
 * reached the agent, however it got there; an edit made after the answer
 * is news).
 */
export function unheardComments(
  thread: ReviewThread,
  since: string,
): ReviewComment[] {
  const { comments, handedAt, held } = thread;
  if (held !== undefined) return [];
  const heard = handedAt && handedAt > since ? handedAt : since;
  return comments.filter(
    (comment, index) =>
      comment.author === REVIEW_USER &&
      comment.updatedAt > heard &&
      !comments
        .slice(index + 1)
        .some(
          (answer) =>
            answer.author !== REVIEW_USER &&
            answer.gitlabDraftId === undefined &&
            answer.updatedAt >= comment.updatedAt,
        ),
  );
}
