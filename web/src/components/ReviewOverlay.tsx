import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  commentEdited,
  isReviewGoneCode,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewCommit,
  type ReviewDiff,
  type ReviewGoneCode,
  type ReviewMergeRequestLink,
  type ReviewSide,
  type ReviewSnapshot,
  type ReviewThread,
  type ReviewThreadKind,
} from "../../../shared/review";
import { RpcError } from "../api";
import { roamgateLocalStorage } from "../browserStorage";
import { copyTextWithFeedback } from "../copyText";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "../review";
import {
  anchorForRow,
  authorLabel,
  commitMessageFile,
  expandDiff,
  type FileExpansion,
  fileLines,
  type GapInfo,
  type GapState,
  gapForLine,
  type CommitChoice,
  commitChoices,
  locationLabel,
  placeThreads,
  REVIEW_USER,
  type ReviewRow,
  relocateLine,
  reviewAsMarkdown,
  reviewLayout,
  searchCommits,
  searchRepos,
  type WorkspaceRepo,
} from "../reviewModel";
import {
  commandCompletions,
  EMPTY_KEY_STATE,
  feedKey,
  findFile,
  findMatches,
  firstNonBlank,
  type KeyState,
  type Match,
  nextMatch,
  parseReviewCommand,
  reviewedIndexes,
  searchRegExp,
  splitStep,
  wordAt,
  wordMotion,
} from "../reviewNavigation";
import { mergeRequestNumber, reviewMrSwitch } from "../reviewMrSwitch";
import { store } from "../store";
import { useSystemBack } from "../systemBack";
import { markdownSelectionTarget } from "./markdown";
import {
  type CommentEditorHandle,
  ReviewCommentEditor,
} from "./ReviewCommentEditor";
import {
  highlightCodeTokens,
  type SyntaxTokenRange,
} from "./syntaxHighlighting";
import {
  type Mark,
  type MessageParts,
  markedText,
  messageLayout,
  NoteBody,
  quotedPart,
} from "./ReviewNoteBody";
import { ThreadsChip, ThreadsPanel } from "./ThreadsPanel";
import { ReviewMenu } from "./ReviewMenu";
import {
  ChevronDown,
  Columns2,
  Maximize2,
  MessageSquare,
  MessageSquareOff,
  MoreHorizontal,
  PanelLeft,
  Send,
  X,
} from "lucide-react";
import "./ReviewOverlay.css";

/**
 * The review overlay, built after maildesk's review view: the same layout,
 * keys, comment boxes and GitLab threads, over Roamgate's review sessions.
 */

type Editor = {
  /** Diff row the comment is on; null for file or whole-review comments. */
  at: number | null;
  file: number | null;
  kind: ReviewThreadKind;
  anchor: ReviewAnchor;
  /** Editing an existing comment, or answering a thread. */
  commentId?: string;
  replyTo?: string;
  /** Replies on GitLab threads post publicly. */
  publicReply?: boolean;
  /** The review's overall comment. */
  overall?: boolean;
  text: string;
  /** Remounts the editor when a suggestion is inserted from outside. */
  version: number;
};

/** A message under a line, or one part of it: where j / k and n / N stop. */
type CommentStop = {
  /** Its line, or GENERAL_AT above the diff (review-level comments). */
  at: number;
  thread: ReviewThread;
  comment: ReviewComment;
  /** The part of the message (see messageBlocks); none on GitLab's. */
  part?: number;
};

/** How often an open review reads its merge request's discussions again. */
const GITLAB_REFRESH_MS = 30_000;

/** Where the comments on the whole review sit: above the first line. */
const GENERAL_AT = -1;

/** One drawn line: a unified row, a split context row or a split pair. */
type DrawnRow =
  | { type: "line"; row: ReviewRow }
  | { type: "pair"; left: ReviewRow | null; right: ReviewRow | null };

const PREFS_KEY = "reviewPrefs";
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** A new comment shorter than this is only sent explicitly. */
const STRAY_MAX = 3;
/** Calls that change the review's threads: its state is read back after. */
const REVIEW_WRITES = new Set([
  "review.thread.add",
  "review.reply",
  "review.edit",
  "review.delete",
  "review.resolve",
  "review.restore",
]);
const SYNTAX_MAX_ROWS = 20_000;
const LARGE_FILE_LINES = 600;
const NOT_FOUND_MS = 2500;

type Prefs = {
  split?: boolean;
  filesHidden?: boolean;
  vim?: boolean;
};

function readPrefs(): Prefs {
  try {
    return JSON.parse(roamgateLocalStorage.getItem(PREFS_KEY) ?? "{}") as Prefs;
  } catch {
    return {};
  }
}

const PLACE_KEY = "reviewPlace";
/** The most reviews whose place is kept across reloads. */
const PLACES_KEPT = 50;

/** Where you were in a review: its view and line, back after a reload. */
type Place = {
  /** The commit shown, or null for all changes. */
  commit: string | null;
  path?: string;
  old?: number | null;
  new?: number | null;
};

function readPlaces(): Record<string, Place> {
  try {
    const all = JSON.parse(roamgateLocalStorage.getItem(PLACE_KEY) ?? "{}");
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

function readPlace(sessionId: string): Place | null {
  const place = readPlaces()[sessionId];
  return place && typeof place === "object" ? place : null;
}

function writePlace(sessionId: string, place: Place) {
  try {
    const kept = Object.entries(readPlaces())
      .filter(([id]) => id !== sessionId)
      .slice(-(PLACES_KEPT - 1));
    roamgateLocalStorage.setItem(
      PLACE_KEY,
      JSON.stringify(Object.fromEntries([...kept, [sessionId, place]])),
    );
  } catch {}
}

function writePrefs(update: Partial<Prefs>) {
  try {
    roamgateLocalStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...readPrefs(), ...update }),
    );
  } catch {}
}

function last<T>(items: readonly T[] | undefined): T | undefined {
  return items?.length ? items[items.length - 1] : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(message: string, kind: "info" | "error" = "info", ms = 4000) {
  store.notify({
    kind,
    message,
    autoDismissMs: kind === "error" ? Math.max(ms, 7000) : ms,
  });
}

/** maildesk's dates: today HH:MM, this week the weekday, else the date. */
function fmtDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** When the thread's latest message was written or rewritten. */
function lastMessageAt(thread: ReviewThread): string {
  let last = "";
  for (const comment of thread.comments) {
    if (comment.createdAt > last) last = comment.createdAt;
    if (comment.updatedAt > last) last = comment.updatedAt;
  }
  return last || thread.createdAt;
}

/** How long since `iso`: "12 s", "3 min", "2 h". */
function elapsed(now: number, iso: string): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

function plural(count: number, word: string, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

function drawnRows(rows: ReviewRow[], split: boolean): DrawnRow[] {
  if (!split) return rows.map((row) => ({ type: "line", row }));
  const result: DrawnRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.line.kind === " ") {
      result.push({ type: "line", row });
      index++;
      continue;
    }
    const removed: ReviewRow[] = [];
    while (
      index < rows.length &&
      rows[index]!.line.kind === "-" &&
      rows[index]!.hunk === row.hunk &&
      rows[index]!.file === row.file
    )
      removed.push(rows[index++]!);
    const added: ReviewRow[] = [];
    while (
      index < rows.length &&
      rows[index]!.line.kind === "+" &&
      rows[index]!.hunk === row.hunk &&
      rows[index]!.file === row.file
    )
      added.push(rows[index++]!);
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      result.push({
        type: "pair",
        left: removed[i] ?? null,
        right: added[i] ?? null,
      });
  }
  return result;
}

const REVIEW_KEYS: [string, string][] = [
  [
    "j k ↓ ↑",
    "next / previous line or message under it (5j); side by side, on one side",
  ],
  ["J K", "10 lines down / up"],
  ["gg G", "first / last line (12G: line 12)"],
  ["Ctrl-d Ctrl-u", "half a page down / up"],
  ["Ctrl-f Ctrl-b", "a page down / up (also Ctrl-j Ctrl-k, PageDown PageUp)"],
  ["H M L", "top / middle / bottom of the screen"],
  ["zz zt zb", "current line to the middle / top / bottom"],
  ["{ }", "previous / next hunk"],
  ["[ ]", "previous / next file"],
  ["w b E", "next word / previous word / end of word"],
  ["h l", "one character left / right"],
  ["0 ^ $", "start / first character / end of the line"],
  ["← →", "side by side: the removed / added line of the row"],
  ["/", "search the diff (smart case); n / N next / previous match, Esc ends"],
  ["* #", "search the word under the cursor, forward / backward"],
  ["c Enter i a", "comment on the line"],
  [
    "e",
    "edit the message n / N selected; else your last on the line, or anywhere",
  ],
  ["s", "suggest a change on the line (GitLab suggestion)"],
  ["dd", "delete the comment on the line"],
  [
    "gf",
    "open the file at this line in the file preview (Option+R comes back)",
  ],
  [
    "r",
    "resolve or reopen the thread on the line; elsewhere mark the file reviewed",
  ],
  ["v", "mark the file reviewed (it folds; v again unmarks)"],
  [
    "za",
    "fold / unfold a thread, resolved or not (resolved ones start folded)",
  ],
  ["gl", "the last message of the thread selected, or on the line"],
  ["g;", "the comment written last, in any view"],
  ["u", "undo that delete"],
  [
    "n N",
    "next / previous message, one by one through threads (or search match)",
  ],
  ["Tab Shift+Tab", "next / previous message, even during a search"],
  [
    "Esc Esc / :w",
    "in a comment (Vim): save it; :q drops the edit, Cmd+Enter saves",
  ],
  ["zo x", "20 more lines around the hunk"],
  ["zO X", "all hidden lines around the hunk"],
  ["zR", "the whole file"],
  ["S :diff", "side by side / unified"],
  ["f :files", "show / hide the file list"],
  ["o :only", "diff only: hide all the chrome (o or Esc brings it back)"],
  ["t :comments", "show / hide every comment (margin markers stay)"],
  [
    "T :conversations",
    "every conversation, in any commit, resolved too; there j / k move, Enter goes, Space folds, r resolves, R answers, / searches",
  ],
  [
    "C :ask",
    "ask the agent about the line (or the selected lines), as a discussion",
  ],
  [
    "V",
    "select lines (j / k extend, Shift+click too); then C asks the agent, Esc cancels",
  ],
  [":review [focus]", "the agent reviews line by line"],
  [":hold", "hold your comments until :send, or send each as written"],
  [":send", "send the held comments (or the open discussions) to the agent"],
  ["O :open", "open the merge request on GitLab"],
  [
    "gm :switch",
    "local review / review on GitLab: the branch's merge request (its discussions, your comments as draft notes) and back",
  ],
  [":40", "go to line 40"],
  [
    "> < :commit",
    "next / previous commit (wrapping to all changes); :commit 2, :all",
  ],
  [
    "gc :commits",
    "pick a commit by its subject or sha; :commit words goes to the one matching",
  ],
  [") (", "next / previous repository of the workspace"],
  ["p", "search the workspace's repositories and open one"],
  [":", "command line; Tab / Shift+Tab complete"],
  ["?", "this list"],
  ["Esc :q", "close the review (it is kept)"],
];

function matchesFilter(keys: string, label: string, filter: string): boolean {
  const normal = (value: string) =>
    value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const query = normal(filter).trim();
  if (!query) return true;
  if (query.length === 1 && keys.split(" ").some((key) => key === filter))
    return true;
  const haystack = normal(`${keys} ${label}`);
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/** A short fingerprint of a file's diff: reviewed until it changes. */
function fileFingerprint(file: ReviewDiff["files"][number]): string {
  let hash = 5381;
  for (const hunk of file.hunks)
    for (const line of hunk.lines) {
      const text = `${line.kind}${line.text}\n`;
      for (let i = 0; i < text.length; i++)
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
  return `${file.hunks.length}:${(hash >>> 0).toString(36)}`;
}

/** Scans cost a round trip to the host: reuse them for a minute. */
const repoScans = new Map<
  string,
  { at: number; repos: Promise<WorkspaceRepo[]> }
>();

function scanRepos(
  connectionId: string,
  dirs: string[],
  agentDirs: string[],
): Promise<WorkspaceRepo[]> {
  const key = `${connectionId}\n${[...dirs].sort().join("\n")}\n-\n${agentDirs.join("\n")}`;
  const cached = repoScans.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.repos;
  const repos = reviewCall<{ repos: WorkspaceRepo[] }>(
    connectionId,
    "review.repos",
    { paths: dirs, agent_paths: agentDirs },
  ).then(
    (result) => result.repos,
    () => [],
  );
  repoScans.set(key, { at: Date.now(), repos });
  return repos;
}

/**
 * The repositories of the review's workspace: those with a review, and
 * those its panes' directories (and their subprojects) have changes in,
 * and those its agent edits.
 */
function useWorkspaceRepos(
  connectionId: string,
  session: ReviewSnapshot["session"],
  dirs: string[],
  agentDirs: string[],
): WorkspaceRepo[] {
  const [scanned, setScanned] = useState<WorkspaceRepo[]>([]);
  const dirsKey = dirs.join("\n");
  const agentKey = agentDirs.join("\n");
  useEffect(() => {
    let cancelled = false;
    const list = dirsKey ? dirsKey.split("\n") : [];
    const agents = agentKey ? agentKey.split("\n") : [];
    void scanRepos(connectionId, [session.root, ...list], agents).then(
      (repos) => {
        if (!cancelled) setScanned(repos);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId, session.root, dirsKey, agentKey]);
  const { sessions } = useReviewState();
  return useMemo(() => {
    const byRoot = new Map<string, WorkspaceRepo>();
    for (const repo of scanned) byRoot.set(repo.root, { ...repo });
    for (const snapshot of sessions.values()) {
      const other = snapshot.session;
      if (
        other.connectionId !== session.connectionId ||
        !session.workspaceId ||
        other.workspaceId !== session.workspaceId ||
        // A chat's threads are not comments on a checkout.
        other.target.kind === "chat"
      )
        continue;
      const entry = byRoot.get(other.root) ?? { root: other.root };
      entry.comments =
        (entry.comments ?? 0) +
        snapshot.threads.filter((t) => t.kind !== "merge-request").length;
      byRoot.set(other.root, entry);
    }
    if (!byRoot.has(session.root))
      byRoot.set(session.root, { root: session.root });
    // By path, so ( and ) go the same way from every repository.
    return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
  }, [scanned, sessions, session]);
}

/** Nothing committed beyond its default branch, but work in progress. */
function worktreeOnly(repo: WorkspaceRepo): boolean {
  return !repo.ahead && repo.dirty === true;
}

function repoLabel(repo: WorkspaceRepo): string {
  const name = repo.root.split("/").pop() ?? repo.root;
  const facts = [
    repo.branch,
    repo.ahead ? `${repo.ahead} ahead` : "",
    repo.dirty ? "uncommitted" : "",
    repo.comments ? plural(repo.comments, "comment") : "",
  ].filter(Boolean);
  return facts.length ? `${name} · ${facts.join(", ")}` : name;
}

export function ReviewOverlay({
  snapshot,
  connectionId,
  onClose,
  onFocusAgentPane,
  onShowList,
  agentPanes = [],
  repoDirs = [],
  agentDirs = [],
  onOpenRepo,
  onOpenLocal,
  onShowReview,
  onOpenFile,
  hidden = false,
}: {
  snapshot: ReviewSnapshot;
  connectionId: string;
  onClose: () => void;
  onFocusAgentPane?: (paneId: string) => void;
  onShowList?: () => void;
  /** Agent panes of the review's workspace, best candidate first. */
  agentPanes?: { paneId: string; agent: string }[];
  /** The directories of the workspace's panes, to find its repositories. */
  repoDirs?: string[];
  /** Where its agents run: their sessions name the repositories they edit. */
  agentDirs?: string[];
  /**
   * Shows the workspace's review of another repository; of its uncommitted
   * work when it has no commits of its own.
   */
  onOpenRepo?: (root: string, worktree?: boolean) => void;
  /** Shows the checkout's own review of its branch (from an MR's review). */
  /** The local review of the branch: one of `reviews`, else a new one. */
  onOpenLocal?: (root: string, reviews: string[]) => void;
  /** Shows another review in this overlay (the branch's MR review). */
  onShowReview?: (snapshot: ReviewSnapshot) => void;
  /** Opens a file of the checkout (absolute path) at a line, in the preview. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Pinned to a workspace that is not shown: kept as it is, out of sight. */
  hidden?: boolean;
}) {
  const { session, threads } = snapshot;
  const repos = useWorkspaceRepos(connectionId, session, repoDirs, agentDirs);
  /** p: the repository picker, searched as you type. */
  const [picker, setPicker] = useState<{ query: string; at: number } | null>(
    null,
  );
  const picked = picker ? searchRepos(repos, picker.query) : [];
  function pickRepo(repo: WorkspaceRepo | undefined) {
    setPicker(null);
    rootRef.current?.focus({ preventScroll: true });
    if (repo && repo.root !== session.root)
      onOpenRepo?.(repo.root, worktreeOnly(repo));
  }
  const sessionId = session.id;
  const prefs = useMemo(readPrefs, []);
  const [split, setSplit] = useState(
    () =>
      prefs.split ??
      (typeof window !== "undefined" && window.innerWidth >= 1100),
  );
  const [filesShown, setFilesShown] = useState(() => !prefs.filesHidden);
  // Not remembered: a review always opens with its discussions shown.
  const [hideComments, setHideComments] = useState(false);
  const [vimMode, setVimMode] = useState(() => prefs.vim !== false);
  // Touch screens: their keyboards lack Esc, which Vim needs.
  const coarsePointer =
    globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;
  const [zen, setZen] = useState(false);
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  /**
   * The checkout was removed, or the range's base or head is no longer in
   * it: said plainly, with a way to retarget or forget the review.
   */
  const [gone, setGone] = useState<{
    code: ReviewGoneCode;
    message: string;
  } | null>(null);
  const goneRef = useRef(gone);
  goneRef.current = gone;
  const [newBase, setNewBase] = useState("");
  const [forgetAsked, setForgetAsked] = useState(false);
  /** Whether a failure was that; it is then shown as such. */
  function noteGone(error: unknown): boolean {
    if (!(error instanceof RpcError) || !isReviewGoneCode(error.code))
      return false;
    setGone({ code: error.code, message: error.message });
    return true;
  }
  const [loading, setLoading] = useState(true);
  const [commits, setCommits] = useState<ReviewCommit[] | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  /**
   * Threads folded or unfolded by hand (za): resolved ones start folded, the
   * others open.
   */
  const [foldFlipped, setFoldFlipped] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const threadFolded = (thread: ReviewThread) =>
    thread.kind !== "merge-request" &&
    thread.resolved !== foldFlipped.has(thread.id);
  /** The message n / N stopped on; e edits it. */
  const [focusedComment, setFocusedComment] = useState<string | null>(null);
  /** The part of that message j / k is on (c comments on it). */
  const [focusedPart, setFocusedPart] = useState<number | null>(null);
  /** Words selected in a message, with where to offer commenting on them. */
  const [partSelection, setPartSelection] = useState<{
    thread: ReviewThread;
    comment: ReviewComment;
    quote: string;
    x: number;
    y: number;
  } | null>(null);
  const [col, setCol] = useState(0);
  const wantCol = useRef(0);
  const [selection, setSelection] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorHandle = useRef<CommentEditorHandle | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState<{
    pattern: string;
    wholeWord: boolean;
  } | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{
    kind: ":" | "/";
    text: string;
    wild: number;
    typed: string;
  } | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  // The phone's Back closes the conversations, then the review.
  useSystemBack(!hidden && threadsOpen, () => setThreadsOpen(false), "popup");
  useSystemBack(!hidden, () => close(), "navigation");
  /** Bumped to move to a remembered place in the view already shown. */
  const [placeTick, setPlaceTick] = useState(0);
  const [keysFilter, setKeysFilter] = useState("");
  const [focusBar, setFocusBar] = useState<string | null>(null);
  const [expansions, setExpansions] = useState<
    ReadonlyMap<number, FileExpansion>
  >(new Map());
  const [openedLarge, setOpenedLarge] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [relocations, setRelocations] = useState<
    ReadonlyMap<string, { line: number; wasLine: number; text: string }>
  >(new Map());
  const [syntax, setSyntax] = useState<ReadonlyMap<number, Mark[]>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const keyState = useRef<KeyState>(EMPTY_KEY_STATE);
  const scrollMode = useRef<ScrollLogicalPosition | "keep" | null>(null);
  const lastDeleted = useRef<ReviewThread | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const syntaxCache = useRef(new Map<string, SyntaxTokenRange[]>());
  const diffCache = useRef(new Map<string, ReviewDiff>());
  /** Bumped by a reload: the commits and diffs are read again. */
  const [generation, setGeneration] = useState(0);
  /** What the code was when loaded, to notice it change while open. */
  const loadedState = useRef<string | null>(null);
  const [codeChanged, setCodeChanged] = useState(false);
  /** The remembered place was read: the first commits load uses it. */
  const placeRead = useRef(false);
  /** The search found a file's name: n / N go through such files. */
  const fileSearch = useRef<string | null>(null);
  const restorePlace = useRef<Place | null>(null);
  const keepCursorOn = useRef<{
    file: number;
    old: number | null;
    new: number | null;
    kind: string;
  } | null>(null);

  const agent = session.agent;
  const agentName =
    agent.name ??
    (agentPanes[0]
      ? agentPanes[0].agent.charAt(0).toUpperCase() +
        agentPanes[0].agent.slice(1)
      : "Agent");
  const agentPaneId = agent.paneId ?? agentPanes[0]?.paneId;
  const agentAllowed = !snapshot.mergeRequest?.security;
  /** Comments go to the agent as they are written (not on GitLab reviews). */
  const talk =
    !session.gitlab &&
    session.autoSend !== false &&
    !!agentPaneId &&
    agentAllowed;
  const commentKind: ReviewThreadKind = talk ? "discussion" : "draft";
  /** Comments wait for Send instead of going as they are written. */
  const held = talk && session.holdComments === true;
  /** Your discussion comments the agent has not had yet. */
  const heldCount = held
    ? threads
        .filter((thread) => thread.kind === "discussion" && !thread.resolved)
        .flatMap((thread) => thread.comments)
        .filter(
          (comment) =>
            comment.author === REVIEW_USER &&
            comment.updatedAt > (session.deliveredAt ?? ""),
        ).length
    : 0;
  // A new answer in a discussion shows the comments: it is never missed.
  const latestAnswer = threads
    .filter((thread) => thread.kind === "discussion")
    .flatMap((thread) => thread.comments)
    .filter((comment) => comment.author !== REVIEW_USER)
    .reduce(
      (latest, comment) =>
        comment.createdAt > latest ? comment.createdAt : latest,
      "",
    );
  const seenAnswer = useRef(latestAnswer);
  /** Text left in an editor that only an explicit send delivers. */
  const unsent = useRef(new Map<string, string>());
  useEffect(() => {
    if (latestAnswer <= seenAnswer.current) return;
    seenAnswer.current = latestAnswer;
    setHideComments(false);
  }, [latestAnswer]);
  const gitlabMr = snapshot.mergeRequest ?? null;

  const call = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}) => {
      const result = await reviewCall<T>(connectionId, method, {
        session_id: sessionId,
        ...params,
      });
      // The server pushes the new state, but a push can be lost with its
      // socket: read it back so your own comment never goes missing.
      if (REVIEW_WRITES.has(method))
        void reviewCall<ReviewSnapshot>(connectionId, "review.get", {
          session_id: sessionId,
        })
          .then(rememberReviewSnapshot)
          .catch(() => {});
      return result;
    },
    [connectionId, sessionId],
  );

  async function run<T>(action: () => Promise<T>, failure?: string) {
    try {
      return await action();
    } catch (error) {
      setStatus(failure ? `${failure}: ${errorText(error)}` : errorText(error));
      return undefined;
    }
  }

  // ---- Commits and diffs ------------------------------------------------

  /**
   * A commit a rebase took out of the review, opened from one of its
   * conversations: shown as long as git still has it.
   */
  const [goneCommit, setGoneCommit] = useState<ReviewCommit | null>(null);
  const goneSha = useRef<string | null>(null);
  goneSha.current = goneCommit?.sha ?? null;
  const commitIndex = commits?.findIndex((c) => c.sha === commitSha) ?? -1;
  const currentCommit =
    commitIndex >= 0
      ? commits![commitIndex]!
      : goneCommit && goneCommit.sha === commitSha
        ? goneCommit
        : null;
  /** The branch has no commits of its own: its recent history instead. */
  const history = commits?.[0]?.history === true;
  /** The view shown, as the commit bars and the picker name it. */
  const viewName = !commits
    ? null
    : currentCommit
      ? {
          head:
            commitIndex >= 0
              ? `${commitIndex + 1}/${commits.length} ${currentCommit.sha.slice(0, 8)}`
              : currentCommit.sha.slice(0, 8),
          subject:
            commitIndex >= 0
              ? currentCommit.subject
              : `${currentCommit.subject} (no longer in the review)`,
        }
      : { head: "All changes", subject: plural(commits.length, "commit") };

  /** gc: the commit picker, searched by subject or sha as you type. */
  const [commitPicker, setCommitPicker] = useState<{
    query: string;
    at: number;
  } | null>(null);
  const viewChoices = useMemo(
    () =>
      commitChoices(
        commits ?? [],
        !history,
        currentCommit && commitIndex < 0 ? currentCommit : null,
      ),
    [commits, history, currentCommit, commitIndex],
  );
  const pickedCommits = commitPicker
    ? searchCommits(viewChoices, commitPicker.query)
    : [];
  const commitPickerList = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!commitPicker) return;
    commitPickerList.current
      ?.querySelector(".on")
      ?.scrollIntoView({ block: "nearest" });
  }, [commitPicker]);
  function openCommitPicker(query = "") {
    if (viewChoices.length < 2) {
      notify("This review has a single commit.", "info", 1500);
      return;
    }
    const shown = searchCommits(viewChoices, query);
    setCommitPicker({
      query,
      at: Math.max(
        0,
        shown.findIndex((choice) => choice.sha === commitSha),
      ),
    });
  }
  function pickCommit(choice: CommitChoice | undefined) {
    setCommitPicker(null);
    rootRef.current?.focus({ preventScroll: true });
    if (choice && choice.sha !== commitSha) showView(choice.sha);
  }

  useEffect(() => {
    let cancelled = false;
    // Opening or reloading checks the checkout again, even one known gone.
    void call<{ commits: ReviewCommit[] }>("review.commits", {
      recheck: true,
    }).then(
      (result) => {
        if (cancelled) return;
        setCommits(result.commits);
        // One commit at a time, oldest first; a branch's history (it has
        // nothing of its own) comes latest first.
        const start = result.commits[0]?.sha ?? null;
        const known = (sha: string | null) =>
          sha &&
          (sha === goneSha.current || result.commits.some((c) => c.sha === sha))
            ? sha
            : start;
        // All changes stays so; recent history has no such view.
        const keep = (sha: string | null) =>
          sha === null && result.commits[0]?.history !== true
            ? null
            : known(sha);
        if (!placeRead.current) {
          // First load, after a page reload too: where you were.
          placeRead.current = true;
          const place = readPlace(sessionId);
          const commit = place ? keep(place.commit) : start;
          if (place?.path) restorePlace.current = { ...place, commit };
          setCommitSha(commit);
        } else setCommitSha(keep);
      },
      (error) => {
        if (cancelled) return;
        noteGone(error);
        setCommits([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [call, generation, sessionId]);

  // The code as loaded, then checked every few seconds while shown: a
  // change offers a reload, which keeps the comments (they follow their
  // code, or show as outdated).
  useEffect(() => {
    let cancelled = false;
    loadedState.current = null;
    setCodeChanged(false);
    void call<{ state: string }>("review.state").then(
      (result) => {
        if (!cancelled) loadedState.current = result.state || null;
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [call, generation]);
  useEffect(() => {
    if (hidden) return;
    let busy = false;
    const check = async () => {
      if (
        busy ||
        document.hidden ||
        goneRef.current ||
        loadedState.current === null
      )
        return;
      busy = true;
      try {
        const { state } = await call<{ state: string }>("review.state");
        if (state && loadedState.current && state !== loadedState.current)
          setCodeChanged(true);
      } catch {
      } finally {
        busy = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => clearInterval(timer);
  }, [hidden, call]);

  function reload() {
    setGone(null);
    diffCache.current.clear();
    setGeneration((value) => value + 1);
    if (session.gitlab) void call("review.gitlab.refresh").catch(() => {});
  }

  const loadDiff = useCallback(
    async (fresh = false) => {
      if (commits === null) return;
      const key = commitSha ?? "";
      const cached = diffCache.current.get(key);
      if (cached && !fresh) {
        setDiff(cached);
        setLoading(false);
        return;
      }
      setLoading(true);
      setDiffError(null);
      const label = !commitSha
        ? ""
        : commitIndex >= 0
          ? `${commitIndex + 1}/${commits.length} ${commitSha.slice(0, 8)}`
          : `${commitSha.slice(0, 8)}, no longer in the review,`;
      if (commitSha) setStatus(`Loading commit ${label}...`);
      try {
        const loaded = await call<ReviewDiff>(
          "review.diff",
          commitSha ? { commit: commitSha } : {},
        );
        diffCache.current.set(key, loaded);
        setDiff(loaded);
        if (commitSha) setStatus("");
      } catch (error) {
        noteGone(error);
        setDiffError(errorText(error));
        if (commitSha)
          setStatus(`Cannot load that commit: ${errorText(error)}`);
      } finally {
        setLoading(false);
      }
    },
    [call, commitSha, commits, commitIndex],
  );

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  function showView(sha: string | null) {
    restorePlace.current = null;
    commitEditor();
    setSelection(null);
    setCommitSha(sha);
    setCursor(0);
    setCol(0);
    mainRef.current?.scrollTo({ top: 0 });
  }

  function stepView(direction: 1 | -1) {
    if (!commits?.length) {
      notify("This review has a single commit.", "info", 1500);
      return;
    }
    // The views wrap around: before "all changes" comes the last commit.
    // Recent history has no "all changes" view: it is not one change.
    const first = history ? 0 : -1;
    const count = commits.length - first;
    const next = ((commitIndex - first + direction + count) % count) + first;
    if (next === commitIndex) return;
    showView(next < 0 ? null : commits[next]!.sha);
  }

  // ---- Expansion, folding, layout ---------------------------------------

  /**
   * In a commit's view its message comes first, as a file whose lines can be
   * commented like code (tuicr does the same).
   */
  const viewDiff = useMemo(
    () =>
      diff && currentCommit
        ? {
            ...diff,
            files: [
              commitMessageFile(currentCommit.subject, currentCommit.body),
              ...diff.files,
            ],
          }
        : diff,
    [diff, currentCommit],
  );
  useEffect(() => {
    setExpansions(new Map());
    setOpenedLarge(new Set());
  }, [viewDiff]);

  const expanded = useMemo(
    () => (viewDiff ? expandDiff(viewDiff, expansions) : null),
    [viewDiff, expansions],
  );
  // Reviewed files (as in tuicr), per view, folded until shown again.
  const viewKey = commitSha ?? "all";
  const fingerprints = useMemo(
    () => viewDiff?.files.map(fileFingerprint) ?? [],
    [viewDiff],
  );
  const reviewedKey = (index: number) =>
    `${viewKey}:${viewDiff?.files[index]?.path ?? ""}`;
  /**
   * Reviewed files: marked in this view with the diff they still have, or
   * (never marked nor unmarked here) the same diff of the same file marked
   * in another view: a commit rebased, new changes reloaded elsewhere.
   */
  const reviewedFiles = useMemo(
    () =>
      reviewedIndexes(
        viewDiff?.files.map((file) => file.path) ?? [],
        fingerprints,
        viewKey,
        session.reviewed ?? {},
      ),
    [viewDiff, viewKey, fingerprints, session.reviewed],
  );
  const isReviewed = (index: number) => reviewedFiles.has(index);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const reviewedFolded = useMemo(() => {
    const folds = new Set<number>();
    for (const index of reviewedFiles) {
      const key = `${viewKey}:${viewDiff?.files[index]?.path ?? ""}`;
      if (!revealed.has(key)) folds.add(index);
    }
    return folds;
  }, [reviewedFiles, viewDiff, viewKey, revealed]);
  // Files folded by a click on their name, per view.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collapsedFiles = useMemo(() => {
    const folds = new Set<number>();
    viewDiff?.files.forEach((file, index) => {
      if (collapsed.has(`${viewKey}:${file.path}`)) folds.add(index);
    });
    return folds;
  }, [viewDiff, viewKey, collapsed]);
  const reviewedCount = fingerprints.filter((_, index) =>
    isReviewed(index),
  ).length;
  const folded = useMemo(() => {
    const sizes = new Map<number, number>();
    expanded?.diff.files.forEach((file, index) => {
      const lines = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
      if (lines > LARGE_FILE_LINES && !openedLarge.has(index))
        sizes.set(index, lines);
    });
    return sizes;
  }, [expanded, openedLarge]);
  const shownDiff = useMemo(
    () =>
      expanded
        ? {
            ...expanded.diff,
            files: expanded.diff.files.map((file, index) =>
              folded.has(index) ||
              reviewedFolded.has(index) ||
              collapsedFiles.has(index)
                ? { ...file, hunks: [] }
                : file,
            ),
          }
        : null,
    [expanded, folded, reviewedFolded, collapsedFiles],
  );
  const gaps = expanded?.gaps ?? new Map<string, GapInfo>();
  const layout = useMemo(() => reviewLayout(shownDiff), [shownDiff]);
  const rows = layout.rows;
  const lineTexts = useMemo(() => rows.map((row) => row.line.text), [rows]);

  useEffect(() => {
    const wanted = keepCursorOn.current;
    if (!wanted) return;
    keepCursorOn.current = null;
    const row = rows.find(
      (candidate) =>
        candidate.file === wanted.file &&
        candidate.line.kind === wanted.kind &&
        candidate.line.old === wanted.old &&
        candidate.line.new === wanted.new,
    );
    if (row) {
      scrollMode.current = "keep";
      setCursor(row.at);
    }
  }, [rows]);

  // Back on the line you were at, once its view is loaded.
  useEffect(() => {
    const place = restorePlace.current;
    if (!place || !shownDiff || !rows.length) return;
    if (diff !== diffCache.current.get(place.commit ?? "")) return;
    restorePlace.current = null;
    const inFile = rows.filter(
      (row) => shownDiff.files[row.file]?.path === place.path,
    );
    const row =
      inFile.find(
        (candidate) =>
          candidate.line.old === (place.old ?? null) &&
          candidate.line.new === (place.new ?? null),
      ) ??
      (place.new != null
        ? inFile.find((candidate) => (candidate.line.new ?? 0) >= place.new!)
        : place.old != null
          ? inFile.find((candidate) => (candidate.line.old ?? 0) >= place.old!)
          : undefined) ??
      inFile[0];
    if (row) {
      scrollMode.current = "center";
      setCursor(row.at);
    } else {
      // A file without lines (a rename): its header.
      const index = shownDiff.files.findIndex(
        (file) => file.path === place.path,
      );
      if (index >= 0)
        requestAnimationFrame(() =>
          rootRef.current
            ?.querySelector(`[data-file="${index}"]`)
            ?.scrollIntoView({ block: "start" }),
        );
    }
  }, [rows, shownDiff, diff, placeTick]);

  // Remembered as you move, for the next page load.
  useEffect(() => {
    if (!placeRead.current || restorePlace.current || commits === null) return;
    const row = rows[cursor];
    const path = row ? shownDiff?.files[row.file]?.path : undefined;
    writePlace(
      sessionId,
      path && row
        ? { commit: commitSha, path, old: row.line.old, new: row.line.new }
        : { commit: commitSha },
    );
  }, [sessionId, commits, commitSha, cursor, rows, shownDiff]);

  /** New-side lines of each file, for suggestions. */
  const newLinesByPath = useMemo(() => {
    const byPath = new Map<string, Map<number, string>>();
    for (const row of rows) {
      if (row.line.new === null) continue;
      const path = shownDiff!.files[row.file]!.path;
      let lines = byPath.get(path);
      if (!lines) {
        lines = new Map();
        byPath.set(path, lines);
      }
      lines.set(row.line.new, row.line.text);
    }
    return byPath;
  }, [rows, shownDiff]);

  // ---- Threads of this view ---------------------------------------------

  /**
   * A thread's view: its commit (one with the same subject after a
   * rebase), or null for all changes; an unknown sha when it is gone.
   */
  const commitOf = useCallback(
    (thread: ReviewThread) => {
      const { commit, commitSubject } = thread.anchor;
      if (!commit) return null;
      if (commits?.some((c) => c.sha === commit)) return commit;
      return commits?.find((c) => c.subject === commitSubject)?.sha ?? commit;
    },
    [commits],
  );
  const viewThreads = useMemo(() => {
    return threads.filter((thread) => {
      const own = commitOf(thread);
      // On the whole review, as a merge request's overall discussion: in
      // every view.
      if (!thread.anchor.path && own === null) return true;
      if (currentCommit) {
        if (thread.kind === "merge-request")
          return (
            thread.gitlab?.headSha === currentCommit.sha ||
            own === currentCommit.sha
          );
        // A single commit is all the changes: what was said on those (an
        // agent's comment names no commit) shows on it too.
        return (
          own === currentCommit.sha ||
          (own === null && commits?.length === 1 && !history)
        );
      }
      return own === null;
    });
  }, [threads, commitOf, currentCommit, commits, history]);

  /**
   * Every conversation of the review: open ones first, then the one with
   * the latest message (written or rewritten; resolving or moving a thread
   * is not one).
   */
  const conversations = useMemo(
    () =>
      threads
        .filter((thread) => thread.kind !== "merge-request")
        .map((thread) => ({ thread, last: lastMessageAt(thread) }))
        .sort(
          (a, b) =>
            Number(a.thread.resolved) - Number(b.thread.resolved) ||
            b.last.localeCompare(a.last) ||
            b.thread.updatedAt.localeCompare(a.thread.updatedAt),
        )
        .map(({ thread }) => thread),
    [threads],
  );

  /** A thread's view, in words. */
  function viewLabel(thread: ReviewThread): string {
    const own = commitOf(thread);
    if (own === null) return "all changes";
    const index = commits?.findIndex((c) => c.sha === own) ?? -1;
    return index >= 0
      ? `commit ${index + 1}/${commits!.length}`
      : `${own.slice(0, 8)}, no longer in the review`;
  }

  /** To a thread, in its view, comments shown. */
  function openThread(thread: ReviewThread) {
    const own = commitOf(thread);
    if (own !== null && !commits?.some((c) => c.sha === own))
      setGoneCommit({
        sha: own,
        parent: thread.anchor.commitParent ?? null,
        author: "",
        date: "",
        subject: thread.anchor.commitSubject ?? "",
        body: "",
      });
    setThreadsOpen(false);
    setHideComments(false);
    if (own !== commitSha) showView(own);
    const { path, line, side } = thread.anchor;
    if (path)
      restorePlace.current = {
        commit: own,
        path,
        ...(side === "old" ? { old: line ?? null } : { new: line ?? null }),
      };
    setPlaceTick((tick) => tick + 1);
    rootRef.current?.focus({ preventScroll: true });
  }

  /** GitLab threads on code this commit does not show. */
  const outsideCount = useMemo(
    () =>
      currentCommit
        ? threads.filter(
            (thread) =>
              thread.kind === "merge-request" &&
              thread.anchor.path &&
              thread.gitlab?.headSha !== currentCommit.sha,
          ).length
        : 0,
    [threads, currentCommit],
  );

  /** Comments parked in the other views (maildesk's commit bar count). */
  const otherViewComments = useMemo(
    () =>
      threads.filter(
        (thread) => thread.kind === "draft" && !viewThreads.includes(thread),
      ).length,
    [threads, viewThreads],
  );

  /**
   * Comments on parts of a message, by that message: drawn in it, under the
   * part they quote, not on their line.
   */
  const messageParts = useMemo(() => {
    const comments = new Set(
      threads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
    );
    const parts = new Map<string, ReviewThread[]>();
    for (const thread of threads) {
      const part = thread.anchor.message;
      if (part && comments.has(part.comment))
        parts.set(part.comment, [...(parts.get(part.comment) ?? []), thread]);
    }
    return parts;
  }, [threads]);
  const nestedThreads = useMemo(
    () => new Set([...messageParts.values()].flat().map((thread) => thread.id)),
    [messageParts],
  );

  const placedThreads = useMemo(
    () =>
      viewThreads
        .filter((thread) => !nestedThreads.has(thread.id))
        .map((thread) => {
          const moved = relocations.get(thread.id);
          if (moved)
            return {
              ...thread,
              anchor: {
                ...thread.anchor,
                line: moved.line,
                side: "new" as const,
                text: moved.text,
              },
            };
          if (
            !currentCommit &&
            thread.kind === "merge-request" &&
            thread.gitlab?.headSha &&
            diff?.headSha &&
            thread.gitlab.headSha !== diff.headSha
          )
            return { ...thread, anchor: {} };
          return thread;
        }),
    [viewThreads, nestedThreads, relocations, diff?.headSha, currentCommit],
  );
  const drawn = useMemo(() => drawnRows(rows, split), [rows, split]);
  /** For ←/→ in side by side: the pair a row belongs to. */
  const pairOf = useMemo(() => {
    const map = new Map<
      number,
      { left: ReviewRow | null; right: ReviewRow | null }
    >();
    for (const item of drawn)
      if (item.type === "pair") {
        if (item.left) map.set(item.left.at, item);
        if (item.right) map.set(item.right.at, item);
      }
    return map;
  }, [drawn]);

  const placement = useMemo(
    () => placeThreads(shownDiff, layout, placedThreads),
    [shownDiff, layout, placedThreads],
  );

  const commentRows = useMemo(() => {
    const at = new Set<number>();
    for (const [row, list] of placement.byRow) if (list.length) at.add(row);
    return [...at].sort((a, b) => a - b);
  }, [placement]);

  /**
   * Every message on a line, in the order they are drawn: n / N stops. A
   * message of several parts is a stop as a whole (n / N land there), then
   * one per part (j / k step into them), each followed by the comments on
   * that part.
   */
  const commentStops = useMemo(() => {
    const stops: CommentStop[] = [];
    const pushThread = (at: number, thread: ReviewThread) => {
      // A folded thread is one stop: its summary line.
      if (threadFolded(thread)) {
        const first = thread.comments[0];
        if (first) stops.push({ at, thread, comment: first });
        return;
      }
      for (const comment of thread.comments) {
        if (thread.kind === "merge-request") {
          stops.push({ at, thread, comment });
          continue;
        }
        const layout = messageLayout(comment.body);
        const notes = new Map<number, ReviewThread[]>();
        for (const note of messageParts.get(comment.id) ?? []) {
          const part = quotedPart(layout, note.anchor.message?.quote ?? "");
          notes.set(part, [...(notes.get(part) ?? []), note]);
        }
        stops.push({ at, thread, comment });
        const parts = layout.quotes.length > 1 ? layout.quotes.length : 0;
        for (let part = 0; part < Math.max(1, parts); part++) {
          if (parts) stops.push({ at, thread, comment, part });
          for (const note of notes.get(part) ?? []) pushThread(at, note);
        }
      }
    };
    // Above the diff, as drawn: the open GitLab discussions, then yours.
    for (const thread of placement.general)
      if (thread.kind === "merge-request" && !thread.resolved)
        pushThread(GENERAL_AT, thread);
    for (const thread of placement.general)
      if (thread.kind !== "merge-request") pushThread(GENERAL_AT, thread);
    for (const at of commentRows) {
      const list = placement.byRow.get(at) ?? [];
      for (const thread of [
        ...list.filter((t) => t.kind === "merge-request"),
        ...list.filter((t) => t.kind !== "merge-request"),
      ])
        pushThread(at, thread);
    }
    return stops;
    // threadFolded reads foldFlipped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentRows, placement, foldFlipped, messageParts]);
  /**
   * The rows of the cursor's drawn line: side by side, both halves, whose
   * comments are all drawn under it.
   */
  function lineRows(at: number): number[] {
    const pair = split ? pairOf.get(at) : undefined;
    if (!pair) return [at];
    return [pair.left?.at, pair.right?.at].filter(
      (row): row is number => row !== undefined,
    );
  }
  /**
   * The messages under a drawn line, in the order they are drawn; at
   * GENERAL_AT, those above the diff.
   */
  function stopsOn(at: number) {
    const own = at === GENERAL_AT ? [GENERAL_AT] : lineRows(at);
    return hideComments
      ? []
      : commentStops.filter((stop) => own.includes(stop.at));
  }
  const focusedStop = [...stopsOn(GENERAL_AT), ...stopsOn(cursor)].find(
    (stop) =>
      stop.comment.id === focusedComment && (stop.part ?? null) === focusedPart,
  );
  /** Puts j / k on a message (and a part of it), or on no message. */
  function focusStop(stop: CommentStop | undefined | null) {
    setFocusedComment(stop?.comment.id ?? null);
    setFocusedPart(stop?.part ?? null);
  }

  /** Moves to a message's line (none above the diff) and selects it. */
  function goToStop(
    stop: CommentStop,
    scroll: ScrollLogicalPosition | "none" = "center",
  ) {
    if (stop.at !== GENERAL_AT && stop.at !== cursor)
      jumpTo(stop.at, 0, scroll);
    focusStop(stop);
  }

  // Moving the cursor leaves a message above the diff.
  const generalFocused = focusedStop?.at === GENERAL_AT;
  const cursorSeen = useRef(cursor);
  useEffect(() => {
    if (cursorSeen.current === cursor) return;
    cursorSeen.current = cursor;
    if (generalFocused) focusStop(null);
    // Only on a move of the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  // Moving off the line leaves the message.
  useEffect(() => {
    if (focusedComment && !focusedStop) {
      setFocusedComment(null);
      setFocusedPart(null);
    }
  }, [focusedComment, focusedStop]);

  /** The message selected, or its part j / k is on. */
  function focusedElement(): Element | null {
    if (!focusedComment) return null;
    const message = document.querySelector(
      `[data-comment-id="${focusedComment}"]`,
    );
    if (focusedPart === null) return message;
    // The part j / k is on, not one of a comment drawn inside the message.
    const part = Array.from(
      message?.querySelectorAll(`[data-part="${focusedPart}"]`) ?? [],
    ).find((element) => element.closest("[data-comment-id]") === message);
    return part ?? message;
  }

  useEffect(() => {
    focusedElement()?.scrollIntoView({ block: "nearest" });
    // focusedElement reads these two.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedComment, focusedPart]);

  const fileCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const [at, list] of placement.byRow) {
      const file = rows[at]?.file;
      const mine = list.filter((t) => t.kind !== "merge-request").length;
      if (file !== undefined && mine)
        counts.set(file, (counts.get(file) ?? 0) + mine);
    }
    return counts;
  }, [placement, rows]);

  // ---- GitLab -----------------------------------------------------------

  // The merge request's discussions, read again while the review is shown
  // (and as soon as the page is back in view): new comments, replies and
  // resolutions come in on their own.
  const gitlabOn = session.gitlab;
  useEffect(() => {
    if (!gitlabOn || hidden) return;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        await call("review.gitlab.refresh");
      } catch {
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), GITLAB_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [gitlabOn, hidden, call]);

  // The branch's merge request, found while the review is local (or, for
  // a merge request's review, when the checkout is on its branch): asked
  // when the review shows and when its head moves; the bridge remembers it
  // for a while, and says nothing when GitLab cannot be reached.
  const [foundMr, setFoundMr] = useState<ReviewMergeRequestLink | null>(null);
  const kind = session.target.kind;
  const findMr =
    kind === "mr" ? !!onOpenLocal : kind === "range" || kind === "worktree";
  const shownHead = diff?.headSha;
  useEffect(() => {
    if (!findMr || hidden) return;
    let live = true;
    call<{ mergeRequest: ReviewMergeRequestLink | null }>("review.gitlab.find")
      .then((result) => {
        if (live) setFoundMr(result.mergeRequest);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [findMr, hidden, shownHead, session.target.kind, call]);
  const mrSwitch = reviewMrSwitch(session, gitlabMr, foundMr, !!onOpenLocal);
  // The head's Local / GitLab switch, where there is room for it.
  const modeSwitch =
    session.target.kind === "mr" ||
    session.target.kind === "range" ||
    session.target.kind === "worktree";
  const mrNumber = gitlabMr ? mergeRequestNumber(gitlabMr.url) : null;
  const mrLabel = mrSwitch?.label ?? (mrNumber ? `MR !${mrNumber}` : null);

  /**
   * GitLab is the merge request's own review, Local the checkout's: each
   * is a review of its own, with its own place and comments. Turning
   * GitLab on or off shows the other one in this overlay.
   */
  function setGitlab(on: boolean) {
    if (on !== session.gitlab) switchMode();
  }

  function notifyNoMr() {
    notify(
      session.target.kind === "mr"
        ? "The checkout is not on this merge request's branch."
        : "No open GitLab merge request found for this branch.",
      "info",
      2200,
    );
  }

  /** gm, :switch, the head's MR chip: local review and GitLab, both ways. */
  function switchMode() {
    if (session.target.kind === "mr") {
      if (!onOpenLocal) {
        notifyNoMr();
        return;
      }
      // The checkout may have moved since the chip was found: ask again
      // (the bridge remembers it) and act on that answer.
      void run(async () => {
        // With the local reviews of its branch, to go back to one of them.
        const { mergeRequest, localReviews } = await call<{
          mergeRequest: ReviewMergeRequestLink | null;
          localReviews?: string[];
        }>("review.gitlab.find", { local: true });
        setFoundMr(mergeRequest);
        if (!mergeRequest) {
          notifyNoMr();
          return;
        }
        commitEditor();
        onOpenLocal(session.root, localReviews ?? []);
      });
      return;
    }
    if (kind !== "range" && kind !== "worktree") {
      notifyNoMr();
      return;
    }
    // The merge request's review, opened or raised from a fresh lookup.
    void run(async () => {
      const { mergeRequest, snapshot: opened } = await call<{
        mergeRequest: ReviewMergeRequestLink | null;
        snapshot?: ReviewSnapshot;
      }>("review.gitlab.open");
      setFoundMr(mergeRequest);
      if (!mergeRequest || !opened) {
        notifyNoMr();
        return;
      }
      rememberReviewSnapshot(opened);
      commitEditor();
      onShowReview?.(opened);
    });
  }

  // Older GitLab threads: find their line in today's file (All view only).
  useEffect(() => {
    const headSha = diff?.headSha;
    if (!diff || !headSha || currentCommit) return;
    const stale = threads.filter(
      (thread) =>
        thread.kind === "merge-request" &&
        thread.gitlab?.headSha &&
        thread.gitlab.headSha !== headSha &&
        thread.anchor.side === "new" &&
        thread.anchor.path &&
        thread.anchor.line &&
        !relocations.has(thread.id),
    );
    if (!stale.length) return;
    let cancelled = false;
    void (async () => {
      const files = new Map<string, Promise<string[] | null>>();
      const read = (path: string, rev: string) => {
        const key = `${rev}\0${path}`;
        let pending = files.get(key);
        if (!pending) {
          pending = call<{ text: string }>("review.file", { path, rev }).then(
            (result) => fileLines(result.text),
            () => null,
          );
          files.set(key, pending);
        }
        return pending;
      };
      const found = new Map(relocations);
      for (const thread of stale) {
        const path = thread.anchor.path!;
        const [old, current] = await Promise.all([
          read(path, thread.gitlab!.headSha!),
          read(path, session.target.kind === "worktree" ? "" : headSha),
        ]);
        if (cancelled) return;
        if (!old || !current) continue;
        const line = relocateLine(old, thread.anchor.line!, current);
        if (line === null) continue;
        found.set(thread.id, {
          line,
          wasLine: thread.anchor.line!,
          text: current[line - 1] ?? "",
        });
        const fileIndex = diff.files.findIndex((file) => file.path === path);
        const file = diff.files[fileIndex];
        const gap = file ? gapForLine(file, line) : null;
        if (gap !== null && fileIndex >= 0)
          setExpansions((currentExpansions) => {
            const next = new Map(currentExpansions);
            const existing = next.get(fileIndex);
            const fileGaps = new Map(existing?.gaps ?? []);
            fileGaps.set(gap, {
              ...(fileGaps.get(gap) ?? { top: 0, bottom: 0 }),
              all: true,
            });
            next.set(fileIndex, {
              lines: existing?.lines ?? current,
              gaps: fileGaps,
            });
            return next;
          });
      }
      if (!cancelled) setRelocations(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [diff, threads, relocations, call, session.target.kind, currentCommit]);

  // ---- Syntax colouring -------------------------------------------------

  useEffect(() => {
    if (!shownDiff || rows.length > SYNTAX_MAX_ROWS) {
      setSyntax(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const byRow = new Map<number, Mark[]>();
      let at = 0;
      for (const file of shownDiff.files) {
        for (const hunk of file.hunks) {
          const text = hunk.lines.map((line) => line.text).join("\n");
          const key = `${file.path}\0${text}`;
          let tokens = syntaxCache.current.get(key);
          if (!tokens) {
            try {
              tokens = await highlightCodeTokens(text, file.path);
            } catch {
              tokens = [];
            }
            if (cancelled) return;
            syntaxCache.current.set(key, tokens);
          }
          let lineStart = 0;
          let tokenIndex = 0;
          for (const line of hunk.lines) {
            const lineEnd = lineStart + line.text.length;
            const marks: Mark[] = [];
            while (
              tokenIndex < tokens.length &&
              tokens[tokenIndex]!.to <= lineStart
            )
              tokenIndex++;
            for (
              let index = tokenIndex;
              index < tokens.length && tokens[index]!.from < lineEnd;
              index++
            ) {
              const token = tokens[index]!;
              marks.push({
                start: Math.max(0, token.from - lineStart),
                end: Math.min(line.text.length, token.to - lineStart),
                className: token.className,
              });
            }
            if (marks.length) byRow.set(at, marks);
            at++;
            lineStart = lineEnd + 1;
          }
        }
      }
      if (!cancelled) setSyntax(byRow);
    })();
    return () => {
      cancelled = true;
    };
  }, [shownDiff, rows.length]);

  // ---- Search -----------------------------------------------------------

  /**
   * Lines that match, and files whose path does (at their first line), in
   * the order of the view.
   */
  const searchHits = useCallback(
    (pattern: string, wholeWord: boolean): Match[] => {
      const found = findMatches(lineTexts, pattern, wholeWord);
      const regexp = searchRegExp(pattern, wholeWord);
      if (!regexp) return found;
      shownDiff?.files.forEach((file, index) => {
        const at = layout.fileStart[index];
        regexp.lastIndex = 0;
        if (
          file.commitMessage ||
          at === undefined ||
          !regexp.test(file.path) ||
          found.some((match) => match.at === at && match.start === 0)
        )
          return;
        found.push({ at, start: 0, end: 0 });
      });
      return found.sort((a, b) => a.at - b.at || a.start - b.start);
    },
    [lineTexts, shownDiff, layout],
  );
  const matches = useMemo(
    () => (search ? searchHits(search.pattern, search.wholeWord) : []),
    [searchHits, search],
  );
  const matchesByRow = useMemo(() => {
    const byRow = new Map<number, Match[]>();
    for (const match of matches) {
      const list = byRow.get(match.at);
      if (list) list.push(match);
      else byRow.set(match.at, [match]);
    }
    return byRow;
  }, [matches]);

  useEffect(() => {
    if (!notFound) return;
    const timer = setTimeout(() => setNotFound(null), NOT_FOUND_MS);
    return () => clearTimeout(timer);
  }, [notFound]);

  function runSearch(pattern: string, wholeWord: boolean, direction: 1 | -1) {
    fileSearch.current = null;
    const found = searchHits(pattern, wholeWord);
    if (!found.length) {
      setSearch(null);
      // Not in the code: a file's name, here or in another commit.
      if (searchFile(pattern, direction)) fileSearch.current = pattern;
      else void searchFileElsewhere(pattern);
      return;
    }
    setSearch({ pattern, wholeWord });
    const target = nextMatch(found, { at: cursor, col }, direction);
    if (target) jumpTo(target.at, target.start, "keep-visible");
  }

  function repeatSearch(direction: 1 | -1) {
    if (fileSearch.current) {
      searchFile(fileSearch.current, direction);
      return;
    }
    const target = nextMatch(matches, { at: cursor, col }, direction);
    if (target) jumpTo(target.at, target.start, "keep-visible");
  }

  /** The next file of this view whose path matches; false when none. */
  function searchFile(pattern: string, direction: 1 | -1): boolean {
    const files = shownDiff?.files ?? [];
    const index = findFile(
      files.map((file) => (file.commitMessage ? null : file.path)),
      pattern,
      rows[cursor]?.file ?? -1,
      direction,
    );
    if (index < 0) return false;
    goToFile(index);
    notify(`File ${files[index]!.path}`, "info", 2000);
    return true;
  }

  /** The views of this review whose files are searched, nearest first. */
  async function searchFileElsewhere(pattern: string) {
    const views = (commits ?? [])
      .map((commit) => commit.sha as string | null)
      .filter((sha) => sha !== commitSha);
    if (commitSha !== null && !history) views.push(null);
    for (const sha of views) {
      const key = sha ?? "";
      let viewDiff = diffCache.current.get(key);
      if (!viewDiff) {
        try {
          viewDiff = await call<ReviewDiff>(
            "review.diff",
            sha ? { commit: sha } : {},
          );
        } catch {
          continue;
        }
        diffCache.current.set(key, viewDiff);
      }
      const index = findFile(
        viewDiff.files.map((file) => (file.commitMessage ? null : file.path)),
        pattern,
        -1,
      );
      if (index < 0) continue;
      const path = viewDiff.files[index]!.path;
      const position = commits!.findIndex((c) => c.sha === sha);
      showView(sha);
      restorePlace.current = { commit: sha, path };
      fileSearch.current = pattern;
      notify(
        sha
          ? `${path}: in commit ${position + 1}/${commits!.length}`
          : `${path}: in all changes`,
        "info",
        3000,
      );
      return;
    }
    setNotFound(pattern);
  }

  // ---- Cursor and scrolling ---------------------------------------------

  const inSelection = useCallback(
    (at: number) =>
      selection !== null &&
      at >= Math.min(selection, cursor) &&
      at <= Math.max(selection, cursor),
    [selection, cursor],
  );

  /** Moves the cursor; maildesk centres the line on every move. */
  function jumpTo(
    at: number,
    column?: number,
    scroll: ScrollLogicalPosition | "keep-visible" | "none" = "center",
  ) {
    if (!rows.length) return;
    let target = Math.max(0, Math.min(rows.length - 1, at));
    // A selection stays inside the file it started in.
    if (selection !== null) {
      const file = rows[selection]!.file;
      while (rows[target]!.file !== file) target += target > selection ? -1 : 1;
    }
    const length = rows[target]!.line.text.length;
    const nextCol =
      column ?? Math.min(wantCol.current, Math.max(0, length - 1));
    if (column !== undefined) wantCol.current = column;
    scrollMode.current =
      scroll === "keep-visible"
        ? "nearest"
        : scroll === "none"
          ? "keep"
          : scroll;
    setCursor(target);
    setCol(Math.max(0, Math.min(nextCol, Math.max(0, length - 1))));
  }

  useEffect(() => {
    const mode = scrollMode.current;
    scrollMode.current = null;
    if (mode === "keep") return;
    const element = rootRef.current?.querySelector<HTMLElement>(
      `[data-at="${cursor}"]`,
    );
    element?.scrollIntoView({ block: mode ?? "nearest" });
  }, [cursor, split, zen]);

  function visibleRows(): number[] {
    const main = mainRef.current;
    if (!main) return [];
    const box = main.getBoundingClientRect();
    const found: number[] = [];
    for (const element of main.querySelectorAll<HTMLElement>("[data-at]")) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > box.top + 4 && rect.top < box.bottom - 4)
        found.push(Number(element.dataset.at));
    }
    return [...new Set(found)].sort((a, b) => a - b);
  }

  function jumpHunk(direction: 1 | -1, count: number) {
    let at = cursor;
    for (let step = 0; step < count; step++) {
      if (direction === 1) {
        let next = at + 1;
        while (
          next < rows.length &&
          rows[next]!.hunk === rows[at]!.hunk &&
          rows[next]!.file === rows[at]!.file
        )
          next++;
        if (next >= rows.length) break;
        at = next;
      } else {
        let start = at;
        while (
          start > 0 &&
          rows[start - 1]!.hunk === rows[at]!.hunk &&
          rows[start - 1]!.file === rows[at]!.file
        )
          start--;
        if (start < at) at = start;
        else if (start > 0) {
          let previous = start - 1;
          while (
            previous > 0 &&
            rows[previous - 1]!.hunk === rows[start - 1]!.hunk &&
            rows[previous - 1]!.file === rows[start - 1]!.file
          )
            previous--;
          at = previous;
        }
      }
    }
    jumpTo(at, firstNonBlank(lineTexts[at] ?? ""));
  }

  function jumpFile(delta: number) {
    const current = rows[cursor]?.file ?? 0;
    const target = current + delta;
    const start = layout.fileStart[target];
    if (start !== undefined) jumpTo(start, 0);
  }

  /** n / N over your comments and GitLab threads, without wrapping. */
  /**
   * n / N: the next or previous message, one by one through each thread
   * (comments draw below their line). With comments hidden, line to line.
   */
  function jumpComment(direction: 1 | -1) {
    if (hideComments) {
      const next =
        direction === 1
          ? commentRows.find((at) => at > cursor)
          : [...commentRows].reverse().find((at) => at < cursor);
      if (next !== undefined) jumpTo(next, 0);
      return;
    }
    // By message: the parts of the one selected are skipped.
    let index = focusedStop ? commentStops.indexOf(focusedStop) : -1;
    if (index >= 0) {
      const from = commentStops[index]!.comment.id;
      while (commentStops[index]?.comment.id === from) index += direction;
    } else
      index =
        direction === 1
          ? commentStops.findIndex((stop) => stop.at >= cursor)
          : commentStops.length -
            1 -
            [...commentStops].reverse().findIndex((stop) => stop.at < cursor);
    // On a message, its first part.
    while (
      index > 0 &&
      commentStops[index - 1]?.comment.id === commentStops[index]?.comment.id
    )
      index--;
    const next = commentStops[index];
    if (!next) return;
    goToStop(next);
  }

  /**
   * gl: the last message of the thread selected, or of the first open one on
   * the line: where its latest answer is.
   */
  function jumpLastMessage() {
    const thread =
      focusedStop?.thread ??
      threadsHere().find((t) => !t.resolved) ??
      threadsHere()[0];
    const last = thread?.comments[thread.comments.length - 1];
    const stop = last
      ? commentStops.find(
          (s) =>
            s.thread.id === thread!.id &&
            s.comment.id === last.id &&
            s.part === undefined,
        )
      : undefined;
    if (!stop) {
      notify(
        thread ? "That thread is folded (za opens it)." : "No thread here.",
        "info",
        2000,
      );
      return;
    }
    goToStop(stop, "none");
  }

  /** A comment to put the cursor on once its view is shown (g;). */
  const pendingComment = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingComment.current;
    if (!id) return;
    const stop = commentStops.find((s) => s.comment.id === id);
    if (!stop) return;
    pendingComment.current = null;
    goToStop(stop, "none");
    // Once the view with that comment is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentStops]);

  /** g;: the comment written last, yours or the agent's, in any view. */
  function jumpLatestComment() {
    let latest: {
      thread: ReviewThread;
      comment: ReviewComment;
      at: string;
    } | null = null;
    for (const thread of threads)
      for (const comment of thread.comments) {
        const at =
          comment.updatedAt > comment.createdAt
            ? comment.updatedAt
            : comment.createdAt;
        if (!latest || at > latest.at) latest = { thread, comment, at };
      }
    if (!latest) {
      notify("No comment yet.", "info", 1500);
      return;
    }
    // A folded thread is one stop: its first message.
    const stop =
      commentStops.find((s) => s.comment.id === latest.comment.id) ??
      commentStops.find((s) => s.thread.id === latest.thread.id);
    if (stop) {
      goToStop(stop, "none");
      return;
    }
    pendingComment.current = latest.comment.id;
    openThread(latest.thread);
  }

  function editable(thread: ReviewThread, comment: ReviewComment) {
    if (comment.gitlabDraftId !== undefined) return true;
    return (
      comment.author === REVIEW_USER &&
      thread.kind !== "merge-request" &&
      (thread.kind === "discussion" || comment === thread.comments[0])
    );
  }

  /** Who started a GitLab discussion, for a reply written to it here. */
  function gitlabAuthorOf(discussionId: string): string {
    const discussion = threads.find(
      (t) => t.gitlab?.discussionId === discussionId,
    );
    const who = discussion?.comments[0]?.author.replace(/^@/, "");
    return who ? `${who}'s GitLab discussion` : "a GitLab discussion";
  }

  // ---- Comments ---------------------------------------------------------

  function withCommit(anchor: ReviewAnchor): ReviewAnchor {
    return currentCommit
      ? {
          ...anchor,
          commit: currentCommit.sha,
          commitSubject: currentCommit.subject,
          ...(currentCommit.parent
            ? { commitParent: currentCommit.parent }
            : {}),
        }
      : anchor;
  }

  /** maildesk's editComment: the line's comment, or a new one. */
  function editComment(at: number, kind: ReviewThreadKind = "draft") {
    if (!shownDiff) return;
    const row = rows[at];
    if (!row) return;
    commitEditor();
    if (kind === "discussion") {
      // A line already being discussed: answer there.
      const open = (placement.byRow.get(at) ?? []).find(
        (thread) => thread.kind === "discussion" && !thread.resolved,
      );
      if (open) {
        openEditor({
          at: null,
          file: row.file,
          kind,
          anchor: open.anchor,
          replyTo: open.id,
          text: "",
          version: 0,
        });
        return;
      }
    }
    const existing = (placement.byRow.get(at) ?? []).find(
      (thread) => thread.kind === kind && kind === "draft",
    );
    if (existing) {
      openEditor({
        at,
        file: row.file,
        kind,
        anchor: existing.anchor,
        commentId: existing.comments[0]!.id,
        text: existing.comments[0]!.body,
        version: 0,
      });
      return;
    }
    let anchor = withCommit(anchorForRow(shownDiff, row));
    if (selection !== null && selection !== at) {
      const from = Math.min(selection, at);
      const to = Math.max(selection, at);
      anchor = withCommit(anchorForRow(shownDiff, rows[from]!, rows[to]!));
    }
    openEditor({ at, file: row.file, kind, anchor, text: "", version: 0 });
  }

  /** After marking a file reviewed, the cursor goes on to the next one. */
  const nextFileAfter = useRef<number | null>(null);
  useEffect(() => {
    const after = nextFileAfter.current;
    if (after === null) return;
    nextFileAfter.current = null;
    const start = layout.fileStart.find(
      (at, index) => index > after && at !== undefined,
    );
    if (start !== undefined) jumpTo(start, 0);
    // Only when the layout changes: jumpTo is a new function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  /**
   * r (no message selected): mark the cursor's file reviewed, which folds
   * it, or unmark it. Kept per view and until the file's diff changes.
   */
  /**
   * gf: the cursor's file (or `fileIndex`'s) in the file preview, at the
   * cursor line as the checkout has it now.
   */
  function openFileHere(fileIndex?: number) {
    const row = fileIndex === undefined ? rows[cursor] : undefined;
    const file = shownDiff?.files[fileIndex ?? row?.file ?? -1];
    if (!onOpenFile || !file || file.commitMessage) {
      notify(
        file?.commitMessage
          ? "The commit message is not a file."
          : "No file here to open.",
        "info",
        2000,
      );
      return;
    }
    // A removed line is gone from the file: its old number is near enough.
    const line = row ? (row.line.new ?? row.line.old ?? undefined) : undefined;
    if (commitSha)
      notify(
        "Opened as the checkout has it now, not as in this commit.",
        "info",
        3000,
      );
    onOpenFile(`${session.root}/${file.path}`, line);
  }

  function toggleReviewedHere() {
    const index = rows[cursor]?.file;
    if (index === undefined || fingerprints[index] === undefined) return;
    const key = reviewedKey(index);
    const marking = !isReviewed(index);
    setRevealed((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (marking) nextFileAfter.current = index;
    void run(async () => {
      rememberReviewSnapshot(
        await call<ReviewSnapshot>("review.update", {
          // Unmarking is kept (as ""), so the same diff marked in another
          // view does not mark it again.
          reviewed: { [key]: marking ? fingerprints[index]! : "" },
        }),
      );
      notify(
        marking
          ? `Reviewed (${reviewedCount + 1}/${fingerprints.length})`
          : "No longer reviewed",
        "info",
        1500,
      );
    });
  }

  /**
   * A click on a file's name folds or unfolds it; a reviewed or very large
   * file, folded on its own, opens.
   */
  function toggleFileFold(index: number) {
    if (reviewedFolded.has(index)) return revealFile(index);
    if (folded.has(index)) {
      setOpenedLarge((current) => new Set(current).add(index));
      return;
    }
    const key = reviewedKey(index);
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** Shows a reviewed file again, until r unmarks it. */
  /** To a file of this view: its first line, or its folded header. */
  function goToFile(index: number) {
    if (reviewedFolded.has(index)) return revealFile(index);
    const start = layout.fileStart[index];
    if (start !== undefined) jumpTo(start, 0);
    else
      rootRef.current
        ?.querySelector(`[data-file="${index}"]`)
        ?.scrollIntoView({ block: "start" });
  }

  function revealFile(index: number) {
    const key = reviewedKey(index);
    setRevealed((current) => new Set(current).add(key));
    nextFileAfter.current = index - 1;
  }

  /**
   * r: resolve the thread of the selected message, or the one on the cursor
   * line; on a resolved thread, reopen it. GitLab's discussions are
   * resolved on GitLab.
   */
  function resolveHere() {
    const thread =
      focusedStop?.thread ??
      threadsHere().find((t) => t.kind !== "merge-request");
    if (!thread || thread.kind === "merge-request") {
      notify(
        thread
          ? "GitLab discussions are resolved on GitLab."
          : "No comment to resolve on this line.",
        "info",
        2000,
      );
      return;
    }
    toggleResolved(thread);
  }

  function toggleResolved(thread: ReviewThread) {
    void run(async () => {
      await call("review.resolve", {
        comment_id: thread.id,
        resolved: !thread.resolved,
      });
      notify(
        thread.resolved ? "Reopened" : "Resolved (r reopens)",
        "info",
        2000,
      );
    });
  }

  /**
   * zz / zt / zb: the selected message (its part j / k is on), or the
   * cursor line, to a place.
   */
  function placeView(block: ScrollLogicalPosition) {
    const target = focusedComment
      ? focusedElement()
      : rootRef.current?.querySelector(`[data-at="${cursor}"]`);
    target?.scrollIntoView({ block });
  }

  /** A click on a message selects it, as n / N would. */
  function selectComment(thread: ReviewThread, comment: ReviewComment) {
    const stop = commentStops.find((s) => s.comment.id === comment.id);
    if (!stop || stop.thread.id !== thread.id) return;
    if (focusedComment !== comment.id) goToStop(stop, "none");
    else if (stop.at !== GENERAL_AT && stop.at !== cursor)
      jumpTo(stop.at, 0, "none");
  }

  function startEdit(thread: ReviewThread, comment: ReviewComment) {
    commitEditor();
    openEditor({
      at: null,
      file: null,
      // A draft reply on GitLab is edited as the review comment it is.
      kind: comment.gitlabDraftId !== undefined ? "draft" : thread.kind,
      anchor: thread.anchor,
      commentId: comment.id,
      text: comment.body,
      version: 0,
    });
  }

  /**
   * e: rewrite your last message, in the thread on the cursor line, or else
   * your latest one in the review (the cursor goes there).
   */
  function editLastMessage() {
    if (focusedStop) {
      if (editable(focusedStop.thread, focusedStop.comment))
        startEdit(focusedStop.thread, focusedStop.comment);
      else
        notify(
          `That message is ${authorLabel(focusedStop.comment.author)}'s; e edits yours.`,
          "info",
          2500,
        );
      return;
    }
    const mine = (thread: ReviewThread) =>
      last(thread.comments.filter((comment) => editable(thread, comment)));
    for (const thread of [...threadsHere()].reverse()) {
      const comment = mine(thread);
      if (comment) return startEdit(thread, comment);
    }
    let latest: {
      thread: ReviewThread;
      comment: ReviewComment;
      at: number | null;
    } | null = null;
    const consider = (thread: ReviewThread, at: number | null) => {
      const comment = mine(thread);
      if (comment && (!latest || comment.updatedAt > latest.comment.updatedAt))
        latest = { thread, comment, at };
    };
    for (const [at, list] of placement.byRow)
      for (const thread of list) consider(thread, at);
    for (const list of placement.byFile.values())
      for (const thread of list) consider(thread, null);
    const found = latest as {
      thread: ReviewThread;
      comment: ReviewComment;
      at: number | null;
    } | null;
    if (!found) {
      notify("You have not written anything here yet.", "info", 2000);
      return;
    }
    if (found.at !== null) jumpTo(found.at, 0, "center");
    startEdit(found.thread, found.comment);
  }

  /** A GitLab suggestion for the cursor line (new side only). */
  function suggestion(at: number): string | null {
    const row = rows[at];
    if (!row || row.line.kind === "-") {
      notify("Suggestions apply to lines of the new version.", "info", 2000);
      return null;
    }
    return `\`\`\`suggestion:-0+0\n${row.line.text}\n\`\`\`\n`;
  }

  function suggestHere() {
    const block = suggestion(cursor);
    if (block === null) return;
    if (editor && editorHandle.current) {
      editorHandle.current.append(block, 5);
      return;
    }
    editComment(cursor);
    setEditor((current) =>
      current
        ? {
            ...current,
            text:
              (current.text && !current.text.endsWith("\n")
                ? `${current.text}\n`
                : current.text) + block,
            version: current.version + 1,
          }
        : current,
    );
  }

  /**
   * Saves the open editor. Without `explicit` (Esc, another line, another
   * view), a new comment of a key or two is a stray keystroke: dropped.
   */
  function editorKey(current: Editor): string {
    if (current.overall) return "overall";
    if (current.commentId) return `edit:${current.commentId}`;
    if (current.replyTo) return `reply:${current.replyTo}`;
    return `new:${current.kind}:${JSON.stringify(current.anchor)}`;
  }

  /** An editor whose text reaches someone once saved: the agent, or GitLab. */
  function sendsOut(current: Editor, text: string): boolean {
    if (current.replyTo || current.publicReply) return true;
    if (current.kind === "discussion" || current.kind === "merge-request")
      return true;
    // A suggested change goes to the agent in a local review.
    return !session.gitlab && /```suggestion\b/.test(text);
  }

  /** Opens an editor, with what you left unsent there. */
  function openEditor(next: Editor) {
    const key = editorKey(next);
    const kept = unsent.current.get(key);
    unsent.current.delete(key);
    if (kept !== undefined)
      notify("Your unsent text is back. Cmd+Enter sends it.", "info", 3000);
    setEditor(kept === undefined ? next : { ...next, text: kept });
  }

  function commitEditor(explicit = false) {
    const current = editor;
    if (!current) return;
    setEditor(null);
    const text = current.text;
    if (current.overall) {
      // Kept as you leave it; sent as you save while comments go out as
      // written, else with Send.
      if (explicit && talk && agent.name && text.trim()) void handoff(text);
      else saveSummary(text);
      return;
    }
    // What goes to the agent or GitLab leaves only on an explicit send (Cmd+Enter,
    // Save, :w): Esc or moving away keeps it for when the editor reopens.
    if (!explicit) {
      const original = current.commentId
        ? threads
            .flatMap((thread) => thread.comments)
            .find((comment) => comment.id === current.commentId)?.body
        : "";
      if (sendsOut(current, text) || sendsOut(current, original ?? "")) {
        if (text.trim() && text !== original) {
          unsent.current.set(editorKey(current), text);
          notify(
            "Not sent: reopen it to go on, Cmd+Enter or Save sends it.",
            "info",
            4000,
          );
        }
        return;
      }
    }
    // A suggestion that changes nothing counts as empty, as in maildesk.
    let meaningful = text
      .replace(/```suggestion[^\n]*\n([\s\S]*?)\n?```/g, (block, code) => {
        const row = current.at !== null ? rows[current.at] : undefined;
        return row && code === row.line.text ? "" : block;
      })
      .trim();
    if (
      !explicit &&
      !current.commentId &&
      meaningful &&
      meaningful.length < STRAY_MAX
    ) {
      notify(
        `Not sent: "${meaningful}" looks like a stray key. Cmd+Enter or Save sends it.`,
        "info",
        4000,
      );
      meaningful = "";
    }
    // What you write shows: hidden comments come back.
    if (meaningful && !current.commentId && hideComments) toggleComments();
    if (current.replyTo) {
      if (!meaningful) return;
      void run(() =>
        call("review.reply", { comment_id: current.replyTo, text }),
      );
    } else if (current.commentId) {
      void run(() =>
        meaningful
          ? call("review.edit", { comment_id: current.commentId, text })
          : call("review.delete", { comment_id: current.commentId }),
      );
    } else if (meaningful) {
      void run(() =>
        call("review.thread.add", {
          kind: current.kind,
          anchor: current.anchor,
          text,
        }),
      );
    }
  }

  function deleteThread(thread: ReviewThread) {
    lastDeleted.current = thread;
    void run(async () => {
      await call("review.delete", { comment_id: thread.id });
      notify("Comment deleted (u undoes)");
    });
  }

  function undoDelete() {
    const thread = lastDeleted.current;
    if (!thread) return;
    lastDeleted.current = null;
    void run(() =>
      thread.gitlab
        ? call("review.thread.add", {
            kind: "draft",
            anchor: thread.anchor,
            text: thread.comments[0]?.body ?? "",
          })
        : call("review.restore", { thread }),
    );
  }

  /** dd: your comment on the line (or the agent's), not GitLab's. */
  function deleteHere() {
    const thread = last(
      threadsHere().filter(
        (t) => t.kind === "draft" || t.comments[0]?.author === REVIEW_USER,
      ),
    );
    if (thread) deleteThread(thread);
    else notify("No comment on this line.", "info", 1500);
  }

  // ---- Overall comment --------------------------------------------------

  function saveSummary(text: string) {
    if (text === session.summary) return;
    void run(async () =>
      rememberReviewSnapshot(
        await call<ReviewSnapshot>("review.update", { summary: text }),
      ),
    );
  }

  /** Writes the overall comment, in the editor every comment uses. */
  function openOverall() {
    commitEditor();
    openEditor({
      at: null,
      file: null,
      kind: "discussion",
      anchor: {},
      overall: true,
      text: session.summary,
      version: 0,
    });
  }

  // ---- Agent --------------------------------------------------------------

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const reviewing = agent.working?.message === "reviewing";
  const wasReviewing = useRef(reviewing);
  useEffect(() => {
    if (wasReviewing.current && !reviewing) {
      const mine = threads.filter(
        (thread) =>
          thread.kind === "draft" &&
          thread.comments.every((comment) => comment.author === agent.name),
      ).length;
      setStatus(
        mine
          ? `${agentName} left ${plural(mine, "comment")}: edit or delete them, n jumps to the next.`
          : `${agentName} found nothing to comment on.${agent.update?.message ? ` ${agent.update.message}` : ""}`,
      );
    }
    wasReviewing.current = reviewing;
  }, [reviewing, threads, agent.name, agent.update?.message, agentName]);

  async function startAgentReview(focus: string) {
    setFocusBar(null);
    if (!agentPaneId) {
      setStatus(
        `${agentName} could not review: no agent pane in this workspace`,
      );
      return;
    }
    await run(
      async () =>
        rememberReviewSnapshot(
          await call<ReviewSnapshot>("review.agent.review", {
            pane_id: agentPaneId,
            agent: agentName,
            focus: focus.trim() || undefined,
          }),
        ),
      `${agentName} could not review`,
    );
  }

  /** maildesk's "Ask Claude": a discussion with the agent on the line(s). */
  function askAgent() {
    if (!agentAllowed) {
      notify("This security merge request is not shared with agents.", "info");
      return;
    }
    editComment(cursor, "discussion");
    setSelection(null);
  }

  function toggleHold() {
    void run(async () =>
      rememberReviewSnapshot(
        await call<ReviewSnapshot>("review.update", { holdComments: !held }),
      ),
    );
    setStatus(
      held
        ? `Your comments go to ${agentName} as you write them.`
        : `Your comments wait until you Send them to ${agentName} (:send).`,
    );
  }

  const overallUnsent =
    !!session.summary.trim() &&
    session.summary.trim() !== session.summarySent?.trim();

  /** Hands the review over: the open discussions and the overall comment. */
  async function handoff(overall = session.summary) {
    const newOverall =
      !!overall.trim() && overall.trim() !== session.summarySent?.trim();
    await run(async () => {
      // What is typed in the overall comment goes with it.
      if (overall !== session.summary)
        await call<ReviewSnapshot>("review.update", { summary: overall });
      rememberReviewSnapshot(await call<ReviewSnapshot>("review.handoff"));
    });
    const open = threads.filter(
      (thread) =>
        thread.kind === "discussion" &&
        !thread.resolved &&
        last(thread.comments)?.author !== agent.name,
    ).length;
    setStatus(
      `Sent to ${agentName}: ${plural(open, "open discussion")}${newOverall ? " and your overall comment" : ""}.`,
    );
  }

  // ---- Toggles ------------------------------------------------------------

  function toggleSplit() {
    setSplit((value) => {
      writePrefs({ split: !value });
      return !value;
    });
    scrollMode.current = "center";
  }

  function toggleFiles() {
    setFilesShown((value) => {
      writePrefs({ filesHidden: value });
      return !value;
    });
  }

  function toggleComments() {
    setHideComments((value) => !value);
    scrollMode.current = "center";
  }

  function toggleZen() {
    setZen((value) => !value);
    scrollMode.current = "center";
  }

  function openMr() {
    if (!gitlabMr) {
      notify("This review is not about a GitLab merge request.", "info", 2000);
      return;
    }
    window.open(`${gitlabMr.url}/diffs`, "_blank", "noopener");
  }

  // ---- Context expansion --------------------------------------------------

  async function loadFileLines(file: number): Promise<string[] | null> {
    const known = expansions.get(file);
    if (known) return known.lines;
    const entry = viewDiff?.files[file];
    if (entry?.commitMessage) return null;
    if (!entry) return null;
    const rev = session.target.kind === "worktree" ? "" : (diff?.headSha ?? "");
    try {
      const { text } = await call<{ text: string }>("review.file", {
        path: entry.path,
        rev,
      });
      return fileLines(text);
    } catch (error) {
      notify(`Cannot show more lines: ${errorText(error)}`, "error");
      return null;
    }
  }

  async function expandGaps(
    file: number,
    changes: { gap: number; change: (state: GapState) => GapState }[],
  ) {
    const lines = await loadFileLines(file);
    if (!lines) return;
    const row = rows[cursor];
    if (row)
      keepCursorOn.current = {
        file: row.file,
        old: row.line.old,
        new: row.line.new,
        kind: row.line.kind,
      };
    setExpansions((current) => {
      const next = new Map(current);
      const existing = next.get(file);
      const fileGaps = new Map(existing?.gaps ?? []);
      for (const { gap, change } of changes)
        fileGaps.set(gap, change(fileGaps.get(gap) ?? { top: 0, bottom: 0 }));
      next.set(file, { lines: existing?.lines ?? lines, gaps: fileGaps });
      return next;
    });
  }

  function expandAroundCursor(mode: "more" | "all" | "file", count: number) {
    const row = rows[cursor];
    if (!row) return;
    if (mode === "file") {
      void expandGaps(
        row.file,
        [...gaps.values()]
          .filter((gap) => gap.file === row.file)
          .map((gap) => ({
            gap: gap.gap,
            change: (state) => ({ ...state, all: true }),
          })),
      );
      return;
    }
    const hunkCount = shownDiff?.files[row.file]?.hunks.length ?? 0;
    const before = gaps.get(`${row.file}:${row.hunk}`);
    const after = gaps.get(
      row.hunk + 1 < hunkCount
        ? `${row.file}:${row.hunk + 1}`
        : `${row.file}:end`,
    );
    const changes: { gap: number; change: (state: GapState) => GapState }[] =
      [];
    if (before)
      changes.push({
        gap: before.gap,
        change: (state) =>
          mode === "all"
            ? { ...state, all: true }
            : { ...state, bottom: state.bottom + 20 * count },
      });
    if (after)
      changes.push({
        gap: after.gap,
        change: (state) =>
          mode === "all"
            ? { ...state, all: true }
            : { ...state, top: state.top + 20 * count },
      });
    if (changes.length) void expandGaps(row.file, changes);
  }

  // ---- Command line -------------------------------------------------------

  function runCommand(text: string) {
    const command = parseReviewCommand(text);
    switch (command.type) {
      case "line":
        jumpTo(command.line - 1, 0);
        break;
      case "close":
        close();
        break;
      case "save":
        commitEditor(true);
        notify("Review saved", "info", 1200);
        break;
      case "overall":
        openOverall();
        break;
      case "split":
        toggleSplit();
        break;
      case "files":
        toggleFiles();
        break;
      case "diffOnly":
        toggleZen();
        break;
      case "comments":
        toggleComments();
        break;
      case "ask":
        askAgent();
        break;
      case "send":
        void handoff();
        break;
      case "threads":
        setThreadsOpen(true);
        break;
      case "hold":
        if (talk) toggleHold();
        else notify(`Comments are not going to ${agentName}.`, "info", 1800);
        break;
      case "review":
        if (command.focus === null) setFocusBar("");
        else void startAgentReview(command.focus);
        break;
      case "open":
        openMr();
        break;
      case "switchMode":
        switchMode();
        break;
      case "suggest":
        suggestHere();
        break;
      case "commit":
        if (command.index === null) showView(null);
        else if (commits?.[command.index])
          showView(commits[command.index]!.sha);
        break;
      case "commits": {
        // A single match goes there; else the picker shows them.
        const matches = searchCommits(viewChoices, command.query);
        if (command.query && matches.length === 1) {
          if (matches[0]!.sha !== commitSha) showView(matches[0]!.sha);
        } else openCommitPicker(command.query);
        break;
      }
      case "reload":
        reload();
        break;
      case "reviews":
        commitEditor();
        onShowList?.();
        break;
      case "vim":
        setVimMode((value) => {
          const next = command.on ?? !value;
          writePrefs({ vim: next });
          return next;
        });
        break;
      default:
        notify(
          `Not a review command: :${command.text} (try :q, :w, :diff, :files)`,
          "info",
          2500,
        );
    }
  }

  function close() {
    commitEditor();
    onClose();
  }

  // ---- A checkout or commit that is gone ----------------------------------

  function forget() {
    if (threads.length && !forgetAsked) {
      setForgetAsked(true);
      return;
    }
    void run(async () => {
      await call("review.remove");
      notify("Review forgotten", "info", 2500);
      onClose();
    }, "Cannot forget the review");
  }

  function retarget(event: { preventDefault: () => void }) {
    event.preventDefault();
    const base = newBase.trim();
    if (!base) return;
    void run(async () => {
      rememberReviewSnapshot(
        await call<ReviewSnapshot>("review.update", { base }),
      );
      setNewBase("");
      reload();
    }, "Cannot compare against it");
  }

  function goneSection() {
    if (!gone) return null;
    const range = session.target.kind === "range";
    return (
      <div className="review-gone bubble error" role="alert">
        <p>{gone.message}</p>
        {gone.code === "checkout-gone" ? (
          <p className="note">
            Its worktree was probably removed. The review can only be read again
            if the checkout comes back at that path.
          </p>
        ) : null}
        {gone.code === "base-gone" && range ? (
          <form className="review-gone-retarget" onSubmit={retarget}>
            <input
              aria-label="New base"
              value={newBase}
              placeholder="Another base: origin/main, a commit..."
              onChange={(event) => setNewBase(event.target.value)}
            />
            <button
              type="submit"
              className="btn rv-sm"
              disabled={!newBase.trim()}
            >
              Compare against it
            </button>
          </form>
        ) : null}
        <div className="review-gone-actions">
          <button type="button" className="btn rv-sm" onClick={forget}>
            {forgetAsked
              ? `Forget it with its ${threads.length} conversation${threads.length === 1 ? "" : "s"}`
              : "Forget this review"}
          </button>
          {forgetAsked ? (
            <button
              type="button"
              className="btn ghost rv-sm"
              onClick={() => setForgetAsked(false)}
            >
              Keep it
            </button>
          ) : null}
          <button type="button" className="btn ghost rv-sm" onClick={reload}>
            Try again
          </button>
          <button type="button" className="btn ghost rv-sm" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }

  // ---- Keys ---------------------------------------------------------------

  // The keys come here when it opens and each time its workspace is back.
  // Arriving in a workspace also focuses its terminal, a moment later:
  // the review keeps the keys over that.
  useEffect(() => {
    if (hidden) return;
    const root = rootRef.current;
    root?.focus({ preventScroll: true });
    const reclaim = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".xterm"))
        root?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", reclaim);
    const stop = setTimeout(
      () => document.removeEventListener("focusin", reclaim),
      800,
    );
    return () => {
      clearTimeout(stop);
      document.removeEventListener("focusin", reclaim);
    };
  }, [hidden]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (keysOpen || threadsOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setKeysOpen(false);
        setThreadsOpen(false);
        rootRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (target.closest(".rc-editor")) return;
    if (
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement
    ) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        target.blur();
        rootRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.ctrlKey && !event.metaKey) {
      const half = Math.max(1, Math.floor(visibleRows().length / 2));
      const deltas: Record<string, number> = {
        d: half,
        u: -half,
        f: 2 * half,
        b: -2 * half,
        // A page with the hand on j / k (the fn key never reaches a page).
        j: 2 * half,
        k: -2 * half,
        e: 1,
        y: -1,
      };
      const delta = deltas[event.key];
      if (delta === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      jumpTo(cursor + delta);
      return;
    }
    if (event.metaKey || event.altKey) return;
    // Tab / Shift+Tab: message to message, even while n / N follow a search.
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      jumpComment(event.shiftKey ? -1 : 1);
      return;
    }
    const result = feedKey(keyState.current, event.key);
    keyState.current = result.state;
    if (result.type === "wait") {
      if (event.key.length === 1) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const { key } = result;
    const n = result.count ?? 1;
    let handled = true;
    switch (key) {
      // Line by line, the view only follows (as in Vim), so zz / zt / zb
      // decide where the line sits.
      case "j":
      case "ArrowDown":
        stepLines(n);
        break;
      case "k":
      case "ArrowUp":
        stepLines(-n);
        break;
      case "J":
        jumpTo(lineBelow(10 * n));
        break;
      case "K":
        jumpTo(lineBelow(-10 * n));
        break;
      case "PageDown":
        jumpTo(cursor + 2 * Math.max(1, Math.floor(visibleRows().length / 2)));
        break;
      case "PageUp":
        jumpTo(cursor - 2 * Math.max(1, Math.floor(visibleRows().length / 2)));
        break;
      case "gg":
        jumpTo(result.count ? result.count - 1 : 0, 0, "start");
        break;
      case "gf":
        openFileHere();
        break;
      case "gl":
        jumpLastMessage();
        break;
      case "gm":
        switchMode();
        break;
      case "gc":
        openCommitPicker();
        break;
      case "g;":
        jumpLatestComment();
        break;
      case "G":
        if (result.count) jumpTo(result.count - 1, 0);
        else jumpTo(rows.length - 1, 0, "end");
        break;
      case "Home":
        jumpTo(0, 0, "start");
        break;
      case "End":
        jumpTo(rows.length - 1, 0, "end");
        break;
      case "H":
      case "M":
      case "L": {
        const visible = visibleRows();
        if (!visible.length) break;
        const at =
          key === "H"
            ? visible[Math.min(visible.length - 1, n - 1)]!
            : key === "L"
              ? visible[Math.max(0, visible.length - n)]!
              : visible[Math.floor(visible.length / 2)]!;
        jumpTo(at, undefined, "nearest");
        break;
      }
      case "zz":
      case "z.":
        placeView("center");
        break;
      case "zt":
        placeView("start");
        break;
      case "zb":
        placeView("end");
        break;
      case "zo":
      case "x":
        expandAroundCursor("more", n);
        break;
      case "zO":
      case "X":
        expandAroundCursor("all", n);
        break;
      case "zR":
        expandAroundCursor("file", n);
        break;
      case "}":
        jumpHunk(1, n);
        break;
      case "{":
        jumpHunk(-1, n);
        break;
      case "]":
        jumpFile(n);
        break;
      case "[":
        jumpFile(-n);
        break;
      case "c":
      case "Enter":
      case "i":
      case "a": {
        // On a part of a long message (j / k went into it): a comment on
        // that part. On a whole message, as on a line.
        if (focusedStop?.part !== undefined)
          commentOnPart(
            focusedStop.thread,
            focusedStop.comment,
            messageLayout(focusedStop.comment.body).quotes[focusedStop.part] ??
              "",
          );
        else editComment(cursor, commentKind);
        break;
      }
      case "n":
        if (search) repeatSearch(1);
        else jumpComment(1);
        break;
      case "N":
        if (search) repeatSearch(-1);
        else jumpComment(-1);
        break;
      case "e":
        editLastMessage();
        break;
      case "w":
      case "W":
      case "b":
      case "B":
      case "E": {
        let next = { at: cursor, col };
        for (let step = 0; step < n; step++)
          next = wordMotion(
            lineTexts,
            next,
            key.toLowerCase() as "w" | "b" | "e",
          );
        jumpTo(next.at, next.col, next.at === cursor ? "none" : "nearest");
        break;
      }
      case "h":
        jumpTo(cursor, Math.max(0, col - n), "none");
        break;
      case "l":
        jumpTo(cursor, col + n, "none");
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const row = rows[cursor];
        const pair = split ? pairOf.get(cursor) : undefined;
        if (pair && row) {
          splitSide.current = key === "ArrowLeft" ? "left" : "right";
          const other = key === "ArrowLeft" ? pair.left?.at : pair.right?.at;
          if (other !== undefined && other !== cursor)
            jumpTo(other, undefined, "none");
        } else
          jumpTo(
            cursor,
            key === "ArrowLeft" ? Math.max(0, col - n) : col + n,
            "none",
          );
        break;
      }
      case "0":
        jumpTo(cursor, 0, "none");
        break;
      case "^":
        jumpTo(cursor, firstNonBlank(lineTexts[cursor] ?? ""), "none");
        break;
      case "$":
        jumpTo(
          cursor,
          Math.max(0, (lineTexts[cursor]?.length ?? 1) - 1),
          "none",
        );
        break;
      case "*":
      case "#": {
        const word = wordAt(lineTexts[cursor] ?? "", col);
        if (word) runSearch(word.word, true, key === "*" ? 1 : -1);
        break;
      }
      case "dd":
        deleteHere();
        break;
      case "u":
        undoDelete();
        break;
      case "s":
        suggestHere();
        break;
      case "S":
        toggleSplit();
        break;
      case "f":
        toggleFiles();
        break;
      case "o":
        toggleZen();
        break;
      case "t":
        toggleComments();
        break;
      case "T":
        setThreadsOpen(true);
        break;
      case "C":
        askAgent();
        break;
      case "V":
        setSelection((current) => (current === null ? cursor : null));
        break;
      case ">":
        stepView(1);
        break;
      case ")":
      case "(": {
        const at = repos.findIndex((repo) => repo.root === session.root);
        const next = repos[at + (key === ")" ? 1 : -1)];
        if (next) onOpenRepo?.(next.root, worktreeOnly(next));
        break;
      }
      case "<":
        stepView(-1);
        break;
      case "O":
        openMr();
        break;
      case ":":
        setPrompt({ kind: ":", text: "", wild: -1, typed: "" });
        break;
      case "/":
        setPrompt({ kind: "/", text: "", wild: -1, typed: "" });
        break;
      case "?":
        setKeysFilter("");
        setKeysOpen(true);
        break;
      case "p":
        if (repos.length < 2) {
          notify("This workspace has a single repository here.", "info", 1800);
          break;
        }
        setPicker({ query: "", at: 0 });
        break;
      case "R":
        runCommand("e");
        break;
      case "r":
        // A thread here (resolved ones too) before the file.
        if (
          focusedStop ||
          threadsHere().some((thread) => thread.kind !== "merge-request")
        )
          resolveHere();
        else toggleReviewedHere();
        break;
      case "v":
        toggleReviewedHere();
        break;
      case "za":
        toggleFoldHere();
        break;
      case "Escape":
        if (selection !== null) setSelection(null);
        else if (search) setSearch(null);
        else if (zen) toggleZen();
        else close();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // ---- Rendering helpers --------------------------------------------------

  /** Side by side, the side j / k stay on: the cursor's, or the last one. */
  const splitSide = useRef<"left" | "right">("right");
  const splitLines = useMemo(
    () =>
      drawn.map((item) =>
        item.type === "line"
          ? { left: item.row.at, right: item.row.at }
          : { left: item.left?.at ?? null, right: item.right?.at ?? null },
      ),
    [drawn],
  );

  /**
   * The threads on the cursor's line. Side by side, the threads of both
   * halves are drawn under the line, so either half has them all.
   */
  function threadsHere(): ReviewThread[] {
    const own = placement.byRow.get(cursor) ?? [];
    const pair = split ? pairOf.get(cursor) : undefined;
    const other = pair?.left?.at === cursor ? pair.right?.at : pair?.left?.at;
    return other === undefined || other === cursor
      ? own
      : [...own, ...(placement.byRow.get(other) ?? [])];
  }

  /** The row `delta` lines down: drawn lines side by side, on one side. */
  function lineBelow(delta: number, from = cursor): number {
    if (!split) return from + delta;
    const pair = pairOf.get(from);
    if (pair?.left?.at === from && pair.right?.at !== from)
      splitSide.current = "left";
    else if (pair?.right?.at === from) splitSide.current = "right";
    return (
      splitStep(splitLines, from, delta, splitSide.current) ?? from + delta
    );
  }

  /**
   * j / k: line by line, each message under a line being a line of its own
   * (r, e, dd act on it there).
   */
  function stepLines(count: number) {
    let message: CommentStop | null = focusedStop ?? null;
    // The messages above the diff come before its first line.
    let at = message?.at === GENERAL_AT ? GENERAL_AT : cursor;
    for (let step = 0; step < Math.abs(count); step++) {
      const stops = stopsOn(at);
      const index = message ? stops.indexOf(message) : -1;
      if (count > 0) {
        if (index + 1 < stops.length) {
          message = stops[index + 1]!;
          continue;
        }
        const next =
          at === GENERAL_AT ? 0 : Math.min(rows.length - 1, lineBelow(1, at));
        if (next === at) break;
        at = next;
        message = null;
      } else if (index > 0) message = stops[index - 1]!;
      else if (index === 0 && at !== GENERAL_AT) message = null;
      else if (at !== GENERAL_AT) {
        const previous = Math.max(0, lineBelow(-1, at));
        const above = last(stopsOn(GENERAL_AT));
        if (previous !== at) {
          at = previous;
          message = last(stopsOn(at)) ?? null;
        } else if (above) {
          at = GENERAL_AT;
          message = above;
        } else break;
      }
    }
    if (at === GENERAL_AT) {
      focusStop(message);
      return;
    }
    // A message scrolls itself into view (see focusedComment's effect).
    if (at !== cursor) jumpTo(at, undefined, message ? "none" : "keep-visible");
    else if (!message)
      rootRef.current
        ?.querySelector(`[data-at="${at}"]`)
        ?.scrollIntoView({ block: "nearest" });
    focusStop(message);
  }

  /** A file's name with the search's matches in it marked, as in lines. */
  function markSearch(text: string): ReactNode {
    const regexp = search
      ? searchRegExp(search.pattern, search.wholeWord)
      : null;
    if (!regexp) return text;
    const parts: ReactNode[] = [];
    let position = 0;
    for (const match of text.matchAll(regexp)) {
      if (!match[0]) break;
      parts.push(
        text.slice(position, match.index),
        <mark key={match.index} className="rv-hit">
          {match[0]}
        </mark>,
      );
      position = match.index! + match[0].length;
    }
    if (!parts.length) return text;
    parts.push(text.slice(position));
    return parts;
  }

  function marksFor(at: number): Mark[] | undefined {
    const marks: Mark[] = [...(syntax.get(at) ?? [])];
    for (const match of matchesByRow.get(at) ?? [])
      marks.push({
        start: match.start,
        end: match.end,
        className:
          at === cursor && match.start === col ? "rv-hit rv-cur" : "rv-hit",
      });
    if (at === cursor) {
      const text = lineTexts[at] ?? "";
      const onHit = (matchesByRow.get(at) ?? []).some(
        (match) => match.start <= col && col < match.end,
      );
      if (!onHit) {
        const word = wordAt(text, col);
        if (word && word.start <= col)
          marks.push({
            start: word.start,
            end: word.end,
            className: "rv-word",
          });
        else if (text.length)
          marks.push({ start: col, end: col + 1, className: "rv-word" });
      }
    }
    return marks.length ? marks : undefined;
  }

  function cellText(row: ReviewRow, sign: string) {
    const text = row.line.text;
    const empty = !text.length && row.at === cursor;
    return (
      <span className="tx">
        {sign}
        {empty ? (
          <span className="rv-word"> </span>
        ) : (
          markedText(text, marksFor(row.at))
        )}
      </span>
    );
  }

  function rowClasses(row: ReviewRow, extra = "") {
    const list = placement.byRow.get(row.at) ?? [];
    const mine = list.some((t) => t.kind !== "merge-request");
    const mr = list.some((t) => t.kind === "merge-request");
    return `rl${extra}${row.line.kind === "+" ? " add" : row.line.kind === "-" ? " del" : ""}${mine ? " has" : ""}${mr ? " has-mr" : ""}${row.at === cursor ? " cur" : ""}${inSelection(row.at) ? " in-sel" : ""}`;
  }

  function clickRow(event: React.MouseEvent, row: ReviewRow) {
    if (event.shiftKey) {
      setSelection((current) => current ?? cursor);
      jumpTo(row.at, undefined, "none");
      return;
    }
    setSelection(null);
    // A click puts the cursor on a line; a second one (or c) comments it,
    // so keys typed after a click move instead of writing a comment.
    const again = row.at === cursor || event.detail > 1;
    jumpTo(row.at, undefined, "none");
    // A hidden thread's line shows the comments rather than a new one.
    if (hideComments && placement.byRow.get(row.at)?.length) {
      toggleComments();
      return;
    }
    if (again) editComment(row.at, commentKind);
  }

  /** A pasted image, stored with the review: Markdown linking its file. */
  async function addImage(file: File): Promise<string> {
    try {
      if (file.size > IMAGE_MAX_BYTES)
        throw new Error("an image is at most 10 MiB");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      const { path } = await call<{ path: string }>("review.image.add", {
        type: file.type,
        data: btoa(binary),
      });
      // The file's path: what an agent reads; the overlay shows it.
      return `![${file.name && file.name !== "image.png" ? file.name.replace(/[[\]]/g, "") : "screenshot"}](<${path}>)`;
    } catch (error) {
      notify(`Cannot add the image: ${errorText(error)}`, "error");
      throw error;
    }
  }

  /** Back to the conversation list when the editor was in it, else the diff. */
  function refocusAfterEditor() {
    (threadsOpen
      ? rootRef.current?.querySelector<HTMLElement>(".threads-panel")
      : rootRef.current
    )?.focus({
      preventScroll: true,
    });
  }

  /** A reply to a conversation, written in the conversation list. */
  function replyInList(thread: ReviewThread) {
    if (thread.kind !== "discussion") {
      notify("Review comments are edited, not answered.", "info", 2000);
      return;
    }
    commitEditor();
    openEditor({
      at: null,
      file: null,
      kind: "discussion",
      anchor: thread.anchor,
      replyTo: thread.id,
      text: "",
      version: 0,
    });
  }

  function editorFor(current: Editor) {
    const placeholder = current.overall
      ? !agent.name
        ? "Your overall comment on the review (Cmd+Enter saves, Esc closes)"
        : talk
          ? `Your overall comment, for ${agentName}: sent as you save (Cmd+Enter saves, Esc closes)`
          : `Your overall comment, for ${agentName}: sent when you press Send (Cmd+Enter saves, Esc closes)`
      : current.replyTo
        ? current.publicReply
          ? "Your reply, posted on GitLab when saved (Cmd+Enter saves, Esc closes)"
          : "Your reply (Cmd+Enter saves, Esc closes)"
        : current.kind === "discussion"
          ? talk
            ? `For ${agentName}: sent as you save (Cmd+Enter saves, Esc closes)`
            : `For ${agentName}: sent when you press Send (Cmd+Enter saves, Esc closes)`
          : "Your comment on this line (Cmd+Enter saves, Esc closes)";
    return (
      <div className="rc" key={`editor-${current.version}`}>
        <ReviewCommentEditor
          key={current.version}
          value={current.text}
          vimMode={vimMode}
          placeholder={placeholder}
          handleRef={editorHandle}
          onChange={(text) =>
            setEditor((existing) =>
              existing ? { ...existing, text } : existing,
            )
          }
          onCommit={(explicit) => {
            commitEditor(explicit);
            refocusAfterEditor();
          }}
          onCancel={() => {
            setEditor(null);
            refocusAfterEditor();
          }}
          onSuggest={suggestHere}
          onPasteImage={addImage}
        />
        <div className="rc-bar">
          {current.at !== null && !current.replyTo ? (
            <button
              type="button"
              className="btn ghost"
              title="Insert a GitLab suggestion for this line (:suggest)"
              onClick={suggestHere}
            >
              Suggest
            </button>
          ) : null}
          <span className="spacer" />
          {vimMode && coarsePointer ? (
            // Phone keyboards have no Esc key, and Vim needs one.
            <button
              type="button"
              className="btn ghost rc-escape"
              title="Esc: Vim normal mode; again, close"
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => editorHandle.current?.escape()}
            >
              Esc
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            onClick={() => commitEditor(true)}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  /** The overall comment: a comment like the others, on the whole review. */
  function overallComment(): ReactNode {
    if (editor?.overall) return editorFor(editor);
    if (!session.summary.trim())
      return (
        <div className="rc-bar">
          <button
            type="button"
            className="btn ghost"
            title="An overall comment on the review (:overall)"
            onClick={openOverall}
          >
            Overall comment
          </button>
        </div>
      );
    return (
      <div className="rc talk">
        <NoteBody text={session.summary} />
        <div className="rc-bar">
          <span>Overall comment</span>
          {agent.name ? (
            <span className="rc-kind">
              {!overallUnsent
                ? `→ ${agentName}`
                : held
                  ? `held for ${agentName}`
                  : `for ${agentName}, not sent`}
            </span>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={openOverall}>
            Edit
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => saveSummary("")}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  /** Comments are Markdown, sanitised: links, code, quotes, lists. */
  function commentBody(
    thread: ReviewThread,
    text: string,
    comment?: ReviewComment,
  ) {
    return (
      <NoteBody
        parts={
          comment && thread.kind !== "merge-request"
            ? messagePartsOf(thread, comment)
            : undefined
        }
        text={text}
        newLines={
          thread.anchor.path
            ? newLinesByPath.get(thread.anchor.path)
            : undefined
        }
        line={thread.anchor.endLine ?? thread.anchor.line}
        path={thread.anchor.path}
      />
    );
  }

  /** The comments on parts of a message, and its part j / k is on. */
  function messagePartsOf(
    thread: ReviewThread,
    comment: ReviewComment,
  ): MessageParts {
    const notes = (messageParts.get(comment.id) ?? []).map((note) => ({
      key: note.id,
      quote: note.anchor.message?.quote ?? "",
      node: renderComment(note),
    }));
    if (
      editor &&
      !editor.commentId &&
      !editor.replyTo &&
      editor.anchor.message?.comment === comment.id
    )
      notes.push({
        key: "new-part",
        quote: editor.anchor.message.quote,
        node: editorFor(editor),
      });
    return {
      notes,
      focused: focusedComment === comment.id ? focusedPart : null,
      onComment: (quote) => commentOnPart(thread, comment, quote),
      onSelect: (part) => selectPart(thread, comment, part),
    };
  }

  /** Starts a thread on a part of a message, quoting it. */
  function commentOnPart(
    thread: ReviewThread,
    comment: ReviewComment,
    quote: string,
  ) {
    commitEditor();
    setPartSelection(null);
    window.getSelection()?.removeAllRanges();
    openEditor({
      at: null,
      file: null,
      kind: "discussion",
      anchor: {
        ...thread.anchor,
        message: {
          thread: thread.id,
          comment: comment.id,
          quote: quote.trim().slice(0, 4000),
        },
      },
      text: "",
      version: 0,
    });
  }

  function selectPart(
    thread: ReviewThread,
    comment: ReviewComment,
    part: number,
  ) {
    const stop = commentStops.find(
      (s) => s.comment.id === comment.id && s.part === part,
    );
    // A message in one part is selected whole.
    if (!stop) return selectComment(thread, comment);
    if (stop.thread.id !== thread.id) return;
    goToStop(stop, "none");
  }

  // The offer goes with the selection.
  useEffect(() => {
    if (!partSelection) return;
    const onChange = () => {
      if (window.getSelection()?.isCollapsed !== false) setPartSelection(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [partSelection]);

  /** Words selected in a message: offer to comment on them. */
  function noticeSelection(
    event: React.MouseEvent<HTMLElement>,
    thread: ReviewThread,
    comment: ReviewComment,
  ) {
    if (thread.kind === "merge-request") return;
    const body = event.currentTarget.querySelector<HTMLElement>(".rc-text");
    const target = body ? markdownSelectionTarget(body) : null;
    setPartSelection(
      target
        ? { thread, comment, quote: target.quote, x: target.x, y: target.y }
        : null,
    );
  }

  /** Your comment or the agent's (maildesk's .rc), or a discussion. */
  function toggleFold(thread: ReviewThread) {
    setFoldFlipped((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });
  }

  /**
   * za: fold or unfold the thread selected or on the line, resolved or not
   * (folding does not resolve it).
   */
  function toggleFoldHere() {
    const thread =
      focusedStop?.thread ??
      threadsHere().find((t) => t.kind !== "merge-request");
    if (!thread || thread.kind === "merge-request") {
      notify("No comment to fold on this line.", "info", 2000);
      return;
    }
    toggleFold(thread);
  }

  function renderComment(thread: ReviewThread): ReactNode {
    const discussion = thread.kind === "discussion";
    if (threadFolded(thread)) {
      const first = thread.comments[0];
      const summary = (first?.body ?? "").split("\n")[0]!.slice(0, 140);
      return (
        <button
          type="button"
          key={thread.id}
          data-comment-id={first?.id}
          className={`rc${thread.resolved ? " resolved" : ""} folded${first && first.id === focusedComment ? " focused" : ""}`}
          title={`${thread.resolved ? "Resolved" : "Folded"}; click or za to unfold`}
          onClick={() => toggleFold(thread)}
        >
          <span className="rc-fold-mark">
            {thread.resolved ? "✓ Resolved" : "▸ Folded"}
          </span>
          <span className="rc-fold-text">{summary}</span>
          <span className="rc-kind">
            {thread.comments.length} message
            {thread.comments.length === 1 ? "" : "s"}
          </span>
        </button>
      );
    }
    // A draft is edited in place of its box; a discussion keeps the
    // conversation around the comment being rewritten.
    if (
      !discussion &&
      editor?.commentId &&
      thread.comments[0]?.id === editor.commentId
    )
      return <div key={thread.id}>{editorFor(editor)}</div>;
    return (
      <div
        key={thread.id}
        className={`rc${discussion ? " talk" : ""}${thread.resolved ? " resolved" : ""}`}
      >
        {thread.comments.map((comment, index) =>
          editor?.commentId === comment.id ? (
            <div key={comment.id} className={index ? "rc-reply" : undefined}>
              {editorFor(editor)}
            </div>
          ) : (
            // biome-ignore lint/a11y/useKeyWithClickEvents: n / N select by key
            <div
              key={comment.id}
              data-comment-id={comment.id}
              onClick={(event) => {
                // Not the message a comment on a part of it is drawn in.
                event.stopPropagation();
                selectComment(thread, comment);
              }}
              onMouseUp={(event) => {
                event.stopPropagation();
                noticeSelection(event, thread, comment);
              }}
              className={
                [
                  index ? "rc-reply" : "",
                  comment.author === REVIEW_USER ? "" : "from-agent",
                  comment.id === focusedComment ? "focused" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            >
              {commentBody(thread, comment.body, comment)}
              <div className="rc-bar">
                <span
                  className={comment.author === REVIEW_USER ? "" : "by-claude"}
                >
                  {authorLabel(comment.author)}
                </span>
                {discussion && comment.author === REVIEW_USER ? (
                  <span className="rc-kind">
                    {session.deliveredAt &&
                    comment.updatedAt <= session.deliveredAt
                      ? `→ ${agentName}`
                      : held
                        ? `held for ${agentName}`
                        : talk
                          ? `→ ${agentName}...`
                          : `for ${agentName}, not sent`}
                  </span>
                ) : null}
                {thread.gitlab?.draftId !== undefined ? (
                  <span className="rc-kind">GitLab draft</span>
                ) : null}
                {index === 0 && thread.gitlabReplyTo ? (
                  <span
                    className="rc-kind"
                    title="Goes to GitLab as a draft reply with your other review comments"
                  >
                    reply to {gitlabAuthorOf(thread.gitlabReplyTo)}
                  </span>
                ) : null}
                {commentEdited(comment) ? (
                  <span className="rc-kind">edited</span>
                ) : null}
                <span className="spacer" />
                {(index === 0 && !discussion) ||
                (discussion && comment.author === REVIEW_USER) ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => startEdit(thread, comment)}
                  >
                    Edit
                  </button>
                ) : null}
                {index === 0 ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => deleteThread(thread)}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </div>
          ),
        )}
        {agent.working?.threadId === thread.id ? (
          <div className="rc-working" role="status">
            <span className="rc-working-mark" aria-hidden="true" />
            <span>
              <strong>{agentName}</strong> is working on this
              {agent.working.message ? `: ${agent.working.message}` : "..."}
            </span>
            <span className="rc-working-time">
              {elapsed(now, agent.working.at)}
            </span>
          </div>
        ) : null}
        {/* A draft the agent answered is a conversation too. */}
        {discussion || thread.comments.length > 1 ? (
          editor?.replyTo === thread.id && !threadsOpen ? (
            editorFor(editor)
          ) : (
            <div className="rc-bar">
              <span className="spacer" />
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  commitEditor();
                  openEditor({
                    at: null,
                    file: null,
                    kind: "discussion",
                    anchor: thread.anchor,
                    replyTo: thread.id,
                    text: "",
                    version: 0,
                  });
                }}
              >
                Reply
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() =>
                  void run(() =>
                    call("review.resolve", {
                      comment_id: thread.id,
                      resolved: !thread.resolved,
                    }),
                  )
                }
              >
                {thread.resolved ? "Reopen" : "Resolve"}
              </button>
              {thread.resolved ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => toggleFold(thread)}
                >
                  Fold
                </button>
              ) : null}
            </div>
          )
        ) : null}
      </div>
    );
  }

  /** Your draft reply in a GitLab discussion: submitted with your review. */
  function renderDraftReply(
    thread: ReviewThread,
    comment: ReviewComment,
  ): ReactNode {
    if (editor?.commentId === comment.id)
      return <div key={comment.id}>{editorFor(editor)}</div>;
    return (
      <div
        key={comment.id}
        data-comment-id={comment.id}
        className={`mr-note mr-draft${comment.id === focusedComment ? " focused" : ""}`}
      >
        <div className="mr-who">
          <span className="mr-draft-tag">Your draft reply</span>, not submitted
        </div>
        <div className="mr-body">
          <NoteBody
            text={comment.body}
            newLines={
              thread.anchor.path
                ? newLinesByPath.get(thread.anchor.path)
                : undefined
            }
            line={thread.anchor.line}
            path={thread.anchor.path}
          />
        </div>
        <div className="rc-bar">
          <span className="spacer" />
          <button
            type="button"
            className="btn ghost"
            onClick={() => startEdit(thread, comment)}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              void run(() => call("review.delete", { comment_id: comment.id }))
            }
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  /** A GitLab discussion (maildesk's .mrt). */
  function renderMrThread(thread: ReviewThread, top = false): ReactNode {
    const relocated = relocations.get(thread.id);
    const replies = thread.comments.length - 1;
    const first = thread.comments[0];
    return (
      <details
        key={thread.id}
        className={`mrt${thread.resolved ? " resolved" : ""}`}
        open={top ? !thread.resolved : !thread.resolved && !relocated}
      >
        <summary className="mr-head">
          <span className="mr-tag">GitLab</span>{" "}
          {first?.author.replace(/^@/, "")}
          {replies > 0 ? ` + ${plural(replies, "reply", "replies")}` : ""}
          {thread.resolved ? (
            <span className="mr-resolved"> · resolved</span>
          ) : null}
          {relocated ? (
            <span className="mr-resolved">
              {" "}
              · outdated (was line {relocated.wasLine})
            </span>
          ) : null}
          {top && thread.anchor.path ? (
            <code className="mr-where">
              {thread.anchor.path}
              {thread.anchor.line ? `:${thread.anchor.line}` : ""}
            </code>
          ) : null}
        </summary>
        {thread.comments.map((comment) =>
          comment.gitlabDraftId !== undefined ? (
            renderDraftReply(thread, comment)
          ) : (
            <div
              key={comment.id}
              data-comment-id={comment.id}
              className={`mr-note${comment.id === focusedComment ? " focused" : ""}`}
            >
              <div className="mr-who">
                <strong>{comment.author.replace(/^@/, "")}</strong> ·{" "}
                {fmtDate(comment.createdAt)}
              </div>
              <div className="mr-body">
                <NoteBody
                  text={comment.body}
                  newLines={
                    thread.anchor.path
                      ? newLinesByPath.get(thread.anchor.path)
                      : undefined
                  }
                  line={thread.anchor.line}
                  path={thread.anchor.path}
                />
              </div>
            </div>
          ),
        )}
        {editor?.replyTo === thread.id ? (
          editorFor(editor)
        ) : (
          <div className="rc-bar">
            <span className="spacer" />
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                commitEditor();
                openEditor({
                  at: null,
                  file: null,
                  kind: "merge-request",
                  anchor: thread.anchor,
                  replyTo: thread.id,
                  publicReply: true,
                  text: "",
                  version: 0,
                });
              }}
            >
              Reply on GitLab
            </button>
          </div>
        )}
      </details>
    );
  }

  /** The threads on a row; with a side, only those written on it. */
  function renderThreadsAt(at: number, side?: ReviewSide): ReactNode[] {
    const onSide = (anchor: ReviewAnchor) =>
      !side || (anchor.side ?? "new") === side;
    const list = (placement.byRow.get(at) ?? []).filter((thread) =>
      onSide(thread.anchor),
    );
    const out: ReactNode[] = [];
    for (const thread of list)
      if (thread.kind === "merge-request") out.push(renderMrThread(thread));
    for (const thread of list)
      if (thread.kind !== "merge-request") out.push(renderComment(thread));
    if (
      editor &&
      editor.at === at &&
      !editor.commentId &&
      !editor.replyTo &&
      onSide(editor.anchor)
    )
      out.push(<div key={`new-${at}`}>{editorFor(editor)}</div>);
    return out;
  }

  /**
   * Side by side, threads sit under the side they were written on: the old
   * side's on the left, the new side's on the right.
   */
  function sideThreads(
    key: string,
    left: [number, ReviewSide] | null,
    right: [number, ReviewSide] | null,
  ): ReactNode[] {
    const leftThreads = left ? renderThreadsAt(...left) : [];
    const rightThreads = right ? renderThreadsAt(...right) : [];
    if (!leftThreads.length && !rightThreads.length) return [];
    return [
      <div key={key} className="srow rd-side-threads">
        <div className="rd-side">{leftThreads}</div>
        <div className="rd-side">{rightThreads}</div>
      </div>,
    ];
  }

  function renderGap(info: GapInfo, key: string): ReactNode {
    const label =
      info.hidden === null ? "more lines" : plural(info.hidden, "hidden line");
    const change = (update: (state: GapState) => GapState) => () =>
      void expandGaps(info.file, [{ gap: info.gap, change: update }]);
    return (
      <div key={key} className="rd-expand">
        <span className="note">{label}</span>
        {info.canDown ? (
          <button
            type="button"
            className="btn ghost"
            title="Show 20 more lines below the hunk above"
            onClick={change((state) => ({ ...state, top: state.top + 20 }))}
          >
            ↓ 20
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          title={
            info.hidden === null
              ? "Show the rest of the file"
              : "Show every hidden line here"
          }
          onClick={change((state) => ({ ...state, all: true }))}
        >
          {info.hidden === null ? "Show the rest" : `Show all ${info.hidden}`}
        </button>
        {info.canUp ? (
          <button
            type="button"
            className="btn ghost"
            title="Show 20 more lines above the hunk below"
            onClick={change((state) => ({
              ...state,
              bottom: state.bottom + 20,
            }))}
          >
            ↑ 20
          </button>
        ) : null}
      </div>
    );
  }

  // ---- Body ---------------------------------------------------------------

  const body: ReactNode[] = [];
  if (shownDiff) {
    let drawnIndex = 0;
    shownDiff.files.forEach((file, fileIndex) => {
      const foldedLines = folded.get(fileIndex);
      body.push(
        <div key={`f${fileIndex}`} className="rd-file" data-file={fileIndex}>
          <button
            type="button"
            className="rd-name"
            title="Fold or unfold the file"
            onClick={() => toggleFileFold(fileIndex)}
          >
            <span className="rd-caret">
              {collapsedFiles.has(fileIndex) ||
              reviewedFolded.has(fileIndex) ||
              foldedLines !== undefined
                ? "▸"
                : "▾"}
            </span>
            {file.commitMessage
              ? `Commit message · ${currentCommit?.sha.slice(0, 10) ?? ""}`
              : markSearch(
                  file.oldPath !== file.path
                    ? `${file.oldPath} → ${file.path}`
                    : file.path,
                )}
          </button>
          {file.binary ? <span className="note"> binary</span> : null}
          {onOpenFile && !file.commitMessage ? (
            <button
              type="button"
              className="btn ghost rd-open"
              title="Open the file in the preview (gf), at the cursor line when it is in this file"
              onClick={() =>
                rows[cursor]?.file === fileIndex
                  ? openFileHere()
                  : openFileHere(fileIndex)
              }
            >
              Open
            </button>
          ) : null}
          {reviewedFolded.has(fileIndex) ? (
            <>
              <span className="note rd-reviewed"> ✓ reviewed</span>
              <button
                type="button"
                className="btn ghost rd-show"
                onClick={() => revealFile(fileIndex)}
              >
                Show
              </button>
            </>
          ) : isReviewed(fileIndex) ? (
            <span className="note rd-reviewed"> ✓ reviewed</span>
          ) : null}
          {foldedLines !== undefined && !reviewedFolded.has(fileIndex) ? (
            <button
              type="button"
              className="btn ghost rd-show"
              onClick={() =>
                setOpenedLarge((current) => new Set(current).add(fileIndex))
              }
            >
              Show {foldedLines} lines
            </button>
          ) : null}
        </div>,
      );
      for (const thread of placement.byFile.get(fileIndex) ?? [])
        body.push(
          thread.kind === "merge-request"
            ? renderMrThread(thread)
            : renderComment(thread),
        );
      if (
        editor &&
        editor.at === null &&
        editor.file === fileIndex &&
        !editor.commentId &&
        !editor.replyTo
      )
        body.push(<div key={`fe${fileIndex}`}>{editorFor(editor)}</div>);
      let lastHunk = -1;
      while (drawnIndex < drawn.length) {
        const item = drawn[drawnIndex]!;
        const first =
          item.type === "line" ? item.row : (item.left ?? item.right)!;
        if (first.file !== fileIndex) break;
        drawnIndex++;
        if (first.hunk !== lastHunk) {
          const gap = gaps.get(`${fileIndex}:${first.hunk}`);
          if (gap) body.push(renderGap(gap, `g${fileIndex}:${first.hunk}`));
          const hunk = file.hunks[first.hunk]!;
          // Once the gap above is fully shown, maildesk drops the header.
          const continued =
            lastHunk >= 0 ||
            (hunk.lines[0]?.expanded && hunk.lines[0].new === 1);
          if ((!continued || gap) && !file.commitMessage)
            body.push(
              <div key={`h${fileIndex}:${first.hunk}`} className="rd-hunk">
                {hunk.header}
              </div>,
            );
          lastHunk = first.hunk;
        }
        if (item.type === "line" && file.commitMessage) {
          // A message has no sides: one numbered column, full width.
          const row = item.row;
          body.push(
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys are global
            <div
              key={`r${row.at}`}
              className={rowClasses(row, " msg")}
              data-at={row.at}
              onClick={(event) => clickRow(event, row)}
            >
              <span className="no">{row.line.new ?? ""}</span>
              {cellText(row, "")}
            </div>,
          );
          if (!hideComments || editor?.at === row.at)
            body.push(...renderThreadsAt(row.at));
        } else if (item.type === "line") {
          const row = item.row;
          body.push(
            split ? (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are global
              <div
                key={`r${row.at}`}
                className={rowClasses(row, " split")}
                data-at={row.at}
                onClick={(event) => clickRow(event, row)}
              >
                <span className="no">{row.line.old ?? ""}</span>
                {cellText(row, " ")}
                <span className="no">{row.line.new ?? ""}</span>
                {cellText(row, " ")}
              </div>
            ) : (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are global
              <div
                key={`r${row.at}`}
                className={rowClasses(row)}
                data-at={row.at}
                onClick={(event) => clickRow(event, row)}
              >
                <span className="no">{row.line.old ?? ""}</span>
                <span className="no">{row.line.new ?? ""}</span>
                {cellText(row, row.line.kind)}
              </div>
            ),
          );
          if (!hideComments || editor?.at === row.at)
            body.push(
              ...(split
                ? sideThreads(`t${row.at}`, [row.at, "old"], [row.at, "new"])
                : renderThreadsAt(row.at)),
            );
        } else {
          const half = (row: ReviewRow | null, side: "old" | "new") =>
            row ? (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are global
              <div
                className={rowClasses(row, " half")}
                data-at={row.at}
                onClick={(event) => clickRow(event, row)}
              >
                <span className="no">
                  {side === "old" ? row.line.old : row.line.new}
                </span>
                {cellText(row, row.line.kind)}
              </div>
            ) : (
              <div className="rl half empty" />
            );
          body.push(
            <div
              key={`p${item.left?.at ?? "x"}-${item.right?.at ?? "x"}`}
              className="srow"
            >
              {half(item.left, "old")}
              {half(item.right, "new")}
            </div>,
          );
          const shown = (row: ReviewRow | null) =>
            row && (!hideComments || editor?.at === row.at) ? row.at : null;
          const left = shown(item.left);
          const right = shown(item.right);
          body.push(
            ...sideThreads(
              `t${item.left?.at ?? "x"}-${item.right?.at ?? "x"}`,
              left === null ? null : [left, "old"],
              right === null ? null : [right, "new"],
            ),
          );
        }
      }
      const endGap = gaps.get(`${fileIndex}:end`);
      if (endGap && lastHunk >= 0)
        body.push(renderGap(endGap, `g${fileIndex}:end`));
    });
  }

  // ---- GitLab section -----------------------------------------------------

  const mrThreads = viewThreads.filter((t) => t.kind === "merge-request");
  const gitlabDrafts = threads.filter((t) => t.gitlab?.draftId !== undefined);
  const placedMr = [...placement.byRow.values()]
    .flat()
    .filter((t) => t.kind === "merge-request").length;
  const openMrThreads = placement.general.filter(
    (t) => t.kind === "merge-request" && !t.resolved,
  );
  const resolvedMr = placement.general.filter(
    (t) => t.kind === "merge-request" && t.resolved,
  );
  const generalMine = placement.general.filter(
    (t) => t.kind !== "merge-request",
  );
  const localDrafts =
    threads.filter((t) => t.kind === "draft" && !t.gitlab).length +
    (session.summaryUnsent ? 1 : 0);

  let gitlabSection: ReactNode = null;
  if (session.gitlab) {
    gitlabSection = snapshot.gitlabError ? (
      <p className="note">
        GitLab comments unavailable: {snapshot.gitlabError}
      </p>
    ) : !gitlabMr ? (
      <p className="note">Loading the merge request comments...</p>
    ) : (
      <>
        <p className="note">
          GitLab: {plural(mrThreads.length, "discussion")}
          {gitlabDrafts.length
            ? `, ${plural(gitlabDrafts.length, "pending draft")} of yours`
            : ""}
          ; {placedMr} shown on their lines below
          {outsideCount ? (
            <>
              , {outsideCount} on code outside this commit (
              <button
                type="button"
                className="link"
                onClick={() => showView(null)}
              >
                all changes
              </button>
              )
            </>
          ) : null}
          .
          {gitlabMr.security
            ? " Security merge request: not shared with agents."
            : ""}
        </p>
        {openMrThreads.length ? (
          <div className="mr-open">
            <h4>Open discussions ({openMrThreads.length})</h4>
            {openMrThreads.map((thread) => renderMrThread(thread, true))}
          </div>
        ) : null}
        {resolvedMr.length ? (
          <details className="mr-other">
            <summary>Resolved ({resolvedMr.length})</summary>
            {resolvedMr.map((thread) => renderMrThread(thread, true))}
          </details>
        ) : null}
      </>
    );
  }

  // ---- Status -------------------------------------------------------------

  const statusText = session.deliveryError
    ? /agent_blocked/.test(session.deliveryError)
      ? `${agentName} is waiting for an answer in its pane; your comments go to it once it is free.`
      : `Your comments did not reach ${agentName}: ${session.deliveryError} (Send to ${agentName} retries)`
    : reviewing
      ? `${agentName} is reviewing, reading the code where needed (${Math.max(
          0,
          Math.round((now - Date.parse(agent.working!.at)) / 1000),
        )} s)...`
      : loading && !commitSha
        ? "Loading the diff..."
        : gone
          ? ""
          : diffError && !commitSha
            ? `Cannot load the diff: ${diffError}`
            : status ||
              (agent.working
                ? `${agentName} is working: ${agent.working.message ?? ""}`
                : agent.update?.message
                  ? `${agentName}: ${agent.update.message}`
                  : "");

  const currentMatch = matches.findIndex(
    (match) => match.at === cursor && match.start === col,
  );

  const keysList = REVIEW_KEYS.filter(([keys, label]) =>
    matchesFilter(keys, label, keysFilter),
  );
  const completions =
    prompt?.kind === ":" ? commandCompletions(prompt.typed) : [];

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the review takes the keys
    <div
      hidden={hidden}
      className={`review-overlay${filesShown ? "" : " no-files"}${hideComments ? " hide-comments" : ""}${zen ? " zen" : ""}`}
      role="dialog"
      aria-label="Patch review"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      {partSelection ? (
        <button
          type="button"
          className="rc-select-comment"
          style={{
            left: Math.min(
              Math.max(8, partSelection.x),
              Math.max(8, window.innerWidth - 120),
            ),
            top: Math.min(
              Math.max(8, partSelection.y),
              Math.max(8, window.innerHeight - 40),
            ),
          }}
          // Keeps the selection while the button is pressed.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() =>
            commentOnPart(
              partSelection.thread,
              partSelection.comment,
              partSelection.quote,
            )
          }
        >
          Comment
        </button>
      ) : null}
      <div className={`review-head${session.gitlab ? " is-gitlab" : ""}`}>
        <button
          type="button"
          className={`icon-btn rv-icon${filesShown ? " on" : ""}`}
          aria-pressed={filesShown}
          aria-label="Files"
          title="Show / hide the file list (f)"
          onClick={toggleFiles}
        >
          <PanelLeft size={16} />
        </button>
        <h2
          title={`${session.title}\n${
            session.target.kind === "mr" || gitlabMr
              ? `GitLab merge request ${gitlabMr?.url ?? ""}`
              : session.target.kind === "worktree"
                ? "Working tree"
                : `Branch ${session.root}`
          }`}
        >
          {gitlabMr?.title || session.title}
        </h2>
        {mrSwitch ? (
          <button
            type="button"
            className={`btn rv-sm rv-mr-chip${mrSwitch.on ? " on" : ""}`}
            aria-label={`${mrSwitch.label}, ${mrSwitch.mode}`}
            title={mrSwitch.title}
            onClick={switchMode}
          >
            {mrSwitch.label}
            <span className="rv-mode">{mrSwitch.mode}</span>
          </button>
        ) : session.gitlab ? (
          <span
            className="rv-mr-chip rv-mode"
            title="Reviewing the merge request on GitLab"
          >
            GitLab
          </span>
        ) : null}
        {modeSwitch ? (
          <div
            className="rv-mode-switch"
            role="group"
            aria-label="Review mode"
            title={mrSwitch?.title}
          >
            {mrLabel ? <span className="rv-mode-mr">{mrLabel}</span> : null}
            <button
              type="button"
              className={session.gitlab ? "" : "on"}
              aria-pressed={!session.gitlab}
              title={
                session.gitlab
                  ? session.target.kind === "mr"
                    ? "Review the checkout's branch locally (gm, :switch)"
                    : "Keep your comments here instead of GitLab draft notes (gm, :switch)"
                  : "A local review: your comments stay in Roamgate"
              }
              onClick={() => {
                if (!session.gitlab) return;
                if (session.target.kind === "mr") switchMode();
                else setGitlab(false);
              }}
            >
              Local
            </button>
            <button
              type="button"
              className={session.gitlab ? "on" : ""}
              aria-pressed={session.gitlab}
              title={
                session.gitlab
                  ? "GitLab mode: the merge request's discussions are shown and your comments are draft notes"
                  : "Use the branch's GitLab merge request: its discussions, and your review as draft notes (gm, :switch)"
              }
              onClick={() => {
                if (!session.gitlab) setGitlab(true);
              }}
            >
              GitLab
            </button>
          </div>
        ) : null}
        {conversations.length ? (
          <ThreadsChip
            className="review-threads-chip"
            threads={conversations}
            open={threadsOpen}
            onToggle={() => setThreadsOpen((open) => !open)}
          />
        ) : null}
        <div className="rv-tools" role="group" aria-label="View">
          <button
            type="button"
            className={`icon-btn rv-icon${hideComments ? "" : " on"}`}
            aria-pressed={!hideComments}
            aria-label="Comments"
            title={
              hideComments && commentRows.length
                ? `Show the ${plural(commentRows.length, "hidden comment")} (t, :comments)`
                : "Show / hide every comment, yours and GitLab's (t, :comments)"
            }
            onClick={toggleComments}
          >
            {hideComments ? (
              <MessageSquareOff size={16} />
            ) : (
              <MessageSquare size={16} />
            )}
            {hideComments && commentRows.length ? (
              <span className="rv-badge">{commentRows.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            className={`icon-btn rv-icon${split ? " on" : ""}`}
            aria-pressed={split}
            aria-label="Side by side"
            title={
              split
                ? "Side by side; click for unified (S, :diff)"
                : "Unified; click for side by side (S, :diff)"
            }
            onClick={toggleSplit}
          >
            <Columns2 size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn rv-icon${zen ? " on" : ""}`}
            aria-pressed={zen}
            aria-label="Diff only"
            title="Diff only: hide all the chrome, just the diff (o, :only; o or Esc brings it back)"
            onClick={toggleZen}
          >
            <Maximize2 size={16} />
          </button>
        </div>
        {agentAllowed ? (
          <div className="rv-agent" role="group" aria-label="Agent">
            {agent.name ? (
              <button
                type="button"
                className={`btn rv-sm rv-send${heldCount || overallUnsent ? " primary" : ""}`}
                title={
                  heldCount
                    ? `Send your ${plural(heldCount, "held comment")} to ${agentName} (:send)`
                    : overallUnsent
                      ? `Send your overall comment and the open discussions to ${agentName} (:send, or Cmd+Enter in the comment)`
                      : `Hand the open discussions to ${agentName} (:send)`
                }
                onClick={() => void handoff()}
              >
                <Send size={14} />
                {heldCount ? `Send ${heldCount}` : "Send"}
              </button>
            ) : null}
            <ReviewMenu
              title={`${agentName}: how your comments reach it, and asking it`}
              label={
                <>
                  {agentName}
                  {talk ? (
                    <span className="rv-mode">{held ? "holding" : "live"}</span>
                  ) : null}
                  <ChevronDown size={14} />
                </>
              }
              items={[
                !session.gitlab &&
                  !!agentPaneId && {
                    label: `Comments go to ${agentName}`,
                    title: talk
                      ? `Your comments go to ${agentName} as you write them; uncheck to write review comments instead`
                      : `Send your comments to ${agentName} as you write them`,
                    checked: talk,
                    onSelect: () =>
                      void run(async () =>
                        rememberReviewSnapshot(
                          await call<ReviewSnapshot>("review.update", {
                            autoSend: !talk,
                          }),
                        ),
                      ),
                  },
                talk && {
                  label: "Hold until Send",
                  hint: ":hold",
                  title: held
                    ? `Your comments wait until you Send them to ${agentName}; uncheck to send each as you write it`
                    : `Hold your comments and Send them to ${agentName} when you are done`,
                  checked: held,
                  onSelect: toggleHold,
                },
                {
                  label: `Ask ${agentName} about this line`,
                  hint: "C",
                  title: `A discussion with ${agentName} on the line your cursor is on (:ask)`,
                  onSelect: askAgent,
                },
                {
                  label: `${agentName} reviews the changes`,
                  hint: ":review",
                  title: `${agentName} reviews line by line, reading the checkout; you can give it a focus first`,
                  disabled: reviewing,
                  onSelect: () => setFocusBar((value) => value ?? ""),
                },
                !!agentPaneId &&
                  !!onFocusAgentPane && {
                    label: `Go to ${agentName}'s pane`,
                    title: "The review is kept",
                    onSelect: () => onFocusAgentPane(agentPaneId),
                  },
              ]}
            />
          </div>
        ) : null}
        {session.gitlab && localDrafts > 0 ? (
          <button
            type="button"
            className="btn primary rv-sm"
            title="Send the review comments waiting here (the local review's and the agent's drafts) to GitLab as draft notes; you submit the review there"
            onClick={() =>
              void run(async () =>
                rememberReviewSnapshot(
                  await call<ReviewSnapshot>("review.gitlab.push"),
                ),
              )
            }
          >
            GitLab draft ({localDrafts})
          </button>
        ) : null}
        <ReviewMenu
          className="rv-more"
          title="More: GitLab, copying the review"
          label={<MoreHorizontal size={16} />}
          items={[
            {
              label: "GitLab mode",
              title: session.gitlab
                ? "Reviewing the merge request from GitLab: your comments are draft notes; uncheck for the local review"
                : "Review the branch's merge request from GitLab: its diff, its discussions, and your review as draft notes",
              checked: session.gitlab,
              ...(mrSwitch?.action === "gitlab" ? { hint: "gm" } : {}),
              onSelect: () => setGitlab(!session.gitlab),
            },
            !!gitlabMr && {
              label: "Open the merge request on GitLab",
              hint: "O",
              title: "Where you submit the review (:open)",
              onSelect: openMr,
            },
            {
              label: "Copy the review as Markdown",
              title: "The overall comment, then each comment under its line",
              onSelect: () => {
                const text = reviewAsMarkdown(session.summary, viewThreads);
                if (!text.trim())
                  notify("Nothing to send yet: comment a line first.");
                else void copyTextWithFeedback(text);
              },
            },
          ]}
        />
        <button
          type="button"
          className="icon-btn"
          id="review-keys-btn"
          title="Shortcuts (?)"
          onClick={() => {
            setKeysFilter("");
            setKeysOpen(true);
          }}
        >
          ?
        </button>
        <button
          type="button"
          className="icon-btn rv-close"
          aria-label="Close"
          title="Close (Esc, :q); your review is kept"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      {repos.length > 1 ? (
        <div className="review-repos">
          <select
            aria-label="Repository"
            title="Repository: ( and ) step through them"
            value={session.root}
            onChange={(event) => {
              const repo = repos.find((r) => r.root === event.target.value);
              if (repo) onOpenRepo?.(repo.root, worktreeOnly(repo));
            }}
          >
            {repos.map((repo) => (
              <option key={repo.root} value={repo.root}>
                {repoLabel(repo)}
              </option>
            ))}
          </select>
          <span className="note">
            {repos.length} repositories in this workspace; p searches, ( )
            switch
          </span>
        </div>
      ) : null}
      {codeChanged ? (
        <div className="review-changed" role="status">
          <span>The code changed since this review was loaded.</span>
          <button
            type="button"
            className="btn rv-sm"
            title="Reload (R)"
            onClick={reload}
          >
            Reload
          </button>
          <span className="note">R</span>
        </div>
      ) : null}
      {/* A single commit too: its view has its message, and the list says
          what is reviewed. */}
      {commits && (commits.length > 0 || (currentCommit && commitIndex < 0)) ? (
        <div className="review-commits">
          <button
            type="button"
            className="btn ghost rv-sm"
            title="Previous commit (<)"
            onClick={() => stepView(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="review-commit-name"
            title="Pick a commit by its subject (gc)"
            onClick={() => openCommitPicker()}
          >
            <span className="note">{viewName?.head}</span>
            <span>{viewName?.subject}</span>
          </button>
          <button
            type="button"
            className="btn ghost rv-sm"
            title="Next commit (>)"
            onClick={() => stepView(1)}
          >
            ›
          </button>
          {history ? (
            <span className="note">
              Nothing beyond the default branch: its{" "}
              {plural(commits.length, "commit")}, latest first (&gt; goes back)
            </span>
          ) : null}
          {otherViewComments ? (
            <span className="note">
              {plural(otherViewComments, "comment")} in other views
            </span>
          ) : null}
        </div>
      ) : null}
      {focusBar !== null ? (
        <div className="review-focusbar">
          <span className="note">{agentName} review, focus (optional):</span>
          <input
            // The focus bar takes the keys as soon as it opens.
            // biome-ignore lint/a11y/noAutofocus: see above
            autoFocus
            value={focusBar}
            placeholder="locking, API, error paths... (Enter starts, Esc cancels)"
            onChange={(event) => setFocusBar(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void startAgentReview(focusBar);
                rootRef.current?.focus({ preventScroll: true });
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setFocusBar(null);
                rootRef.current?.focus({ preventScroll: true });
              }
            }}
          />
          <button
            type="button"
            className="btn primary rv-sm"
            onClick={() => void startAgentReview(focusBar)}
          >
            Start
          </button>
        </div>
      ) : null}
      {/* Diff only: the commits stay at hand, in a strip of their own at the
          bottom (its own room, over none of the diff). */}
      {commits && viewChoices.length > 1 && viewName ? (
        <div className="review-zen-commits">
          <button
            type="button"
            aria-label="Previous commit"
            title="Previous commit (<)"
            onClick={() => stepView(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="review-commit-name"
            title="Pick a commit by its subject (gc)"
            onClick={() => openCommitPicker()}
          >
            <span className="note">{viewName.head}</span>
            <span>{viewName.subject}</span>
          </button>
          <button
            type="button"
            aria-label="Next commit"
            title="Next commit (>)"
            onClick={() => stepView(1)}
          >
            ›
          </button>
        </div>
      ) : null}
      <div className="review-zen-hint">
        <button
          type="button"
          title="Show the header and files again (o or Esc)"
          onClick={toggleZen}
        >
          Show all
        </button>
        <button
          type="button"
          aria-label="Close the review"
          title="Close (Esc twice, :q); your review is kept"
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="review-body">
        {threadsOpen ? (
          <ThreadsPanel
            className="review-threads-panel"
            title="Conversations"
            threads={conversations.map((thread) => ({
              id: thread.id,
              resolved: thread.resolved,
              where: thread.anchor.path
                ? locationLabel(thread.anchor)
                : "The review",
              meta: `${viewLabel(thread)}${thread.kind === "draft" ? " · review comment" : ""}`,
              when: fmtDate(lastMessageAt(thread)),
              comments: thread.comments.map((comment) => ({
                id: comment.id,
                author: authorLabel(comment.author),
                body: comment.body,
              })),
              canReply: thread.kind === "discussion",
              search: thread.kind === "draft" ? "review comment" : "discussion",
            }))}
            onClose={() => {
              setThreadsOpen(false);
              rootRef.current?.focus({ preventScroll: true });
            }}
            onGo={(id) => {
              const thread = conversations.find((t) => t.id === id);
              if (thread) openThread(thread);
            }}
            onResolve={(id) => {
              const thread = conversations.find((t) => t.id === id);
              if (thread) toggleResolved(thread);
            }}
            onReply={(id) => {
              const thread = conversations.find((t) => t.id === id);
              if (thread) replyInList(thread);
            }}
            replying={
              editor?.replyTo &&
              conversations.some((t) => t.id === editor.replyTo)
                ? { id: editor.replyTo, editor: editorFor(editor) }
                : null
            }
            renderBody={(thread, body) => (
              <NoteBody
                text={body}
                path={
                  conversations.find((t) => t.id === thread.id)?.anchor.path
                }
              />
            )}
          />
        ) : null}
        <nav className="review-files" aria-label="Files">
          {fingerprints.length ? (
            <div className="rf-progress note">
              {reviewedCount}/{fingerprints.length} reviewed
            </div>
          ) : null}
          {shownDiff?.files.map((file, index) => (
            <button
              type="button"
              key={`${file.path}-${index}`}
              className={rows[cursor]?.file === index ? "on" : ""}
              title={file.path}
              onClick={() => goToFile(index)}
            >
              <span
                className={`rf-check${isReviewed(index) ? " done" : ""}`}
                aria-label={isReviewed(index) ? "reviewed" : "not reviewed"}
              >
                {isReviewed(index) ? "✓" : "▢"}
              </span>
              <span className="rf-name">
                {file.commitMessage ? "Commit message" : markSearch(file.path)}
              </span>
              {fileCounts.get(index) ? (
                <span className="count">{fileCounts.get(index)}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="review-main" ref={mainRef}>
          <div className="review-overall">{overallComment()}</div>
          <div id="review-status" className="note" aria-live="polite">
            {statusText}
          </div>
          {gone ? goneSection() : null}
          <div className="review-mr">
            {gitlabSection}
            {generalMine.map(renderComment)}
            {editor &&
            editor.at === null &&
            editor.file === null &&
            !editor.commentId &&
            !editor.replyTo &&
            !editor.overall
              ? editorFor(editor)
              : null}
          </div>
          <div className={`review-diff${split ? " split" : ""}`}>
            {shownDiff && !shownDiff.files.length ? (
              <p className="note">No changes to review.</p>
            ) : null}
            {body}
          </div>
        </div>
      </div>
      {search || notFound ? (
        <div className="review-searchline">
          {search ? (
            <>
              <span className="rv-search-label">
                {search.wholeWord ? "Word " : "Search "}
              </span>
              <mark className="rv-hit">{search.pattern}</mark>
              {`  match ${currentMatch + 1 || "-"} of ${matches.length}${search.wholeWord ? " (whole word)" : ""} · n / N next / previous · Esc clears`}
            </>
          ) : (
            <>
              <span className="rv-search-label">Pattern not found: </span>
              <mark className="rv-hit">{notFound}</mark>
            </>
          )}
        </div>
      ) : null}
      {selection !== null ? (
        <div className="review-searchline">
          <span className="rv-search-label">-- VISUAL LINE -- </span>
          {plural(Math.abs(cursor - selection) + 1, "line")} · C asks{" "}
          {agentName} about them · Esc cancels
        </div>
      ) : null}
      {prompt ? (
        <div className="review-cmdline">
          {prompt.kind}
          <input
            className="review-cmd"
            aria-label={prompt.kind === ":" ? "Command" : "Search"}
            // biome-ignore lint/a11y/noAutofocus: a Vim prompt takes the keys
            autoFocus
            value={prompt.text}
            onChange={(event) =>
              setPrompt({
                ...prompt,
                text: event.target.value,
                typed: event.target.value,
                wild: -1,
              })
            }
            onBlur={() => setPrompt(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                const { kind, text } = prompt;
                setPrompt(null);
                rootRef.current?.focus({ preventScroll: true });
                if (kind === ":") runCommand(text);
                else if (text) runSearch(text, false, 1);
              } else if (
                event.key === "Escape" ||
                (event.key === "Backspace" && !prompt.text)
              ) {
                event.preventDefault();
                setPrompt(null);
                rootRef.current?.focus({ preventScroll: true });
              } else if (event.key === "Tab" && prompt.kind === ":") {
                event.preventDefault();
                if (!completions.length) return;
                const step = event.shiftKey ? -1 : 1;
                const wild =
                  (prompt.wild + step + completions.length) %
                  completions.length;
                setPrompt({
                  ...prompt,
                  wild,
                  text: completions[wild]![0],
                });
              }
            }}
          />
          {prompt.kind === ":" ? (
            <span className="review-wild">
              {completions.map(([name, description], index) => (
                <span
                  key={name}
                  className={`wild-item${index === prompt.wild ? " on" : ""}`}
                >
                  {name}
                  <span className="note"> {description}</span>
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {commitPicker ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it
        <div
          className="review-keys"
          onClick={(event) => {
            if (event.target === event.currentTarget) pickCommit(undefined);
          }}
        >
          <div className="review-keys-panel review-picker">
            <input
              // The picker takes the keys as soon as it opens.
              // biome-ignore lint/a11y/noAutofocus: opened by a key
              autoFocus
              type="search"
              name="search"
              placeholder="Commit: words of its subject, or its sha (j / k move)"
              aria-label="Search commits"
              value={commitPicker.query}
              onChange={(event) =>
                setCommitPicker({ query: event.target.value, at: 0 })
              }
              onKeyDown={(event) => {
                const move = (step: number) => {
                  event.preventDefault();
                  setCommitPicker({
                    ...commitPicker,
                    at: Math.max(
                      0,
                      Math.min(
                        pickedCommits.length - 1,
                        commitPicker.at + step,
                      ),
                    ),
                  });
                };
                // Bare j / k move until a search is typed; Ctrl+j / k always.
                const browse = !commitPicker.query || event.ctrlKey;
                if (event.key === "Escape") {
                  event.preventDefault();
                  pickCommit(undefined);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  pickCommit(pickedCommits[commitPicker.at]);
                } else if (
                  event.key === "ArrowDown" ||
                  (event.ctrlKey && event.key === "n") ||
                  (browse && event.key === "j" && !event.altKey)
                )
                  move(1);
                else if (
                  event.key === "ArrowUp" ||
                  (event.ctrlKey && event.key === "p") ||
                  (browse && event.key === "k" && !event.altKey)
                )
                  move(-1);
                event.stopPropagation();
              }}
            />
            <ul ref={commitPickerList}>
              {pickedCommits.map((choice, index) => (
                <li key={choice.sha ?? "all"}>
                  <button
                    type="button"
                    className={`${index === commitPicker.at ? "on" : ""}${choice.sha === commitSha ? " current" : ""}`}
                    onClick={() => pickCommit(choice)}
                  >
                    <span>
                      {choice.commit ? (
                        <>
                          <span className="note">
                            {choice.position
                              ? `${choice.position}/${commits?.length ?? 0} `
                              : ""}
                            {choice.sha?.slice(0, 8)}
                          </span>{" "}
                          {choice.commit.subject}
                        </>
                      ) : (
                        `All changes (${plural(commits?.length ?? 0, "commit")})`
                      )}
                    </span>
                    <span className="note">
                      {choice.commit
                        ? [
                            choice.commit.author,
                            fmtDate(choice.commit.date),
                            choice.position ? "" : "no longer in the review",
                          ]
                            .filter(Boolean)
                            .join(", ")
                        : "the whole change"}
                    </span>
                  </button>
                </li>
              ))}
              {pickedCommits.length ? null : (
                <li className="note">No commit matches.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
      {picker ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it
        <div
          className="review-keys"
          onClick={(event) => {
            if (event.target === event.currentTarget) pickRepo(undefined);
          }}
        >
          <div className="review-keys-panel review-picker">
            <input
              // The picker takes the keys as soon as it opens.
              // biome-ignore lint/a11y/noAutofocus: opened by a key
              autoFocus
              type="search"
              name="search"
              placeholder="Repository: name, branch or path"
              aria-label="Search repositories"
              value={picker.query}
              onChange={(event) =>
                setPicker({ query: event.target.value, at: 0 })
              }
              onKeyDown={(event) => {
                const move = (step: number) => {
                  event.preventDefault();
                  setPicker({
                    ...picker,
                    at: Math.max(
                      0,
                      Math.min(picked.length - 1, picker.at + step),
                    ),
                  });
                };
                if (event.key === "Escape") {
                  event.preventDefault();
                  pickRepo(undefined);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  pickRepo(picked[picker.at]);
                } else if (
                  event.key === "ArrowDown" ||
                  (event.ctrlKey && event.key === "n")
                )
                  move(1);
                else if (
                  event.key === "ArrowUp" ||
                  (event.ctrlKey && event.key === "p")
                )
                  move(-1);
                event.stopPropagation();
              }}
            />
            <ul>
              {picked.map((repo, index) => (
                <li key={repo.root}>
                  <button
                    type="button"
                    className={`${index === picker.at ? "on" : ""}${repo.root === session.root ? " current" : ""}`}
                    onClick={() => pickRepo(repo)}
                  >
                    <span>{repoLabel(repo)}</span>
                    <span className="note">{repo.root}</span>
                  </button>
                </li>
              ))}
              {picked.length ? null : (
                <li className="note">No repository matches.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
      {keysOpen ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it
        <div
          className="review-keys"
          onClick={(event) => {
            if (event.target === event.currentTarget) setKeysOpen(false);
          }}
        >
          <div className="review-keys-panel">
            <div className="settings-head">
              <h2>Review shortcuts</h2>
              <button
                type="button"
                className="icon-btn"
                title="Close (Esc)"
                onClick={() => setKeysOpen(false)}
              >
                ×
              </button>
            </div>
            <input
              id="review-keys-filter"
              type="search"
              // biome-ignore lint/a11y/noAutofocus: filtering is the point
              autoFocus
              placeholder="Search shortcuts (comment, hunk, gitlab...)"
              value={keysFilter}
              onChange={(event) => setKeysFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setKeysOpen(false);
                  rootRef.current?.focus({ preventScroll: true });
                }
              }}
            />
            <dl className="keys">
              {keysList.map(([keys, label]) => (
                <div key={keys} className="keys-row">
                  <dt>
                    {keys.split(" ").map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
            {keysList.length ? null : <p className="note">Nothing matches.</p>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
