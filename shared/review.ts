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
  | { kind: "mr"; url: string }
  /**
   * An agent chat (its agent session, or its pane): no diff, threads on
   * parts of its messages.
   */
  | { kind: "chat"; chat: string };

export type ReviewSide = "old" | "new";

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
  /** On a part of a message of an agent chat (a chat review). */
  chat?: ReviewChatPart;
};

export type ReviewChatPart = {
  /** The chat message's id in the agent's history. */
  entry: string;
  /** When it was written, and how it starts: for the agent to find it. */
  at?: string;
  excerpt?: string;
  /** The words commented on. */
  quote: string;
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
};

export type ReviewAgentStatus = {
  name?: string;
  paneId?: string;
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
   * whose diff changed since is no longer reviewed.
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
  /** "Allow, and don't ask again" applies, as the terminal offers it. */
  canAlways: boolean;
  createdAt: string;
  /** When the hook stops waiting and the terminal asks instead. */
  expiresAt: string;
  /** Claude's multiple-choice questions (AskUserQuestion), not a permission. */
  questions?: AgentQuestion[];
};

/** One of Claude's questions, as its AskUserQuestion tool puts it. */
export type AgentQuestion = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
};

export type AgentPermissionAnswer = "allow" | "always" | "deny";
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
};

/** The path comments on a commit message are anchored to. */
export const COMMIT_MESSAGE_PATH = ":commit-message";

export type ReviewDiff = {
  files: ReviewDiffFile[];
  /** Resolved commits, when the target has them. */
  baseSha?: string;
  headSha?: string;
  truncated: boolean;
};

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
  if (thread.resolved) return false;
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
