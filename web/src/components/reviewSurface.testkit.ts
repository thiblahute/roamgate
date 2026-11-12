/**
 * Behavior-level test kit for the review surfaces (plan: review into the
 * inspector, gate 3). A test drives a surface with keys and commands and
 * reads what is visible: the line with the cursor, its side, the word under
 * it, what is folded. It never asserts a surface's class names, so the same
 * test runs against the classic review pane and, once it exists, the review
 * in Changes; each surface has its own implementation of `ReviewSurface`.
 *
 * Not a test file: imported by `reviewBehavior.*.dom.test.tsx`, which run in
 * an isolated child with happy-dom installed (`installReviewDom`).
 */
import type {
  ReviewCommit,
  ReviewDiffFile,
  ReviewDiffHunk,
  ReviewDiffLine,
  ReviewMergeRequest,
  ReviewThread,
} from "../../../shared/review";

/** One drawn line of the diff, as a reviewer sees it. */
export type ShownLine = {
  path: string;
  old: number | null;
  new: number | null;
  /** The line's text, without its +/- sign. */
  text: string;
  /** "+" added, "-" removed, " " unchanged, "reviewed" a folded chunk. */
  kind: "+" | "-" | " " | "reviewed" | "message";
};

export type SurfaceOptions = {
  files: ReviewDiffFile[];
  /** Each file's whole text (new side), read to reveal context. */
  texts?: Record<string, string>;
  threads?: ReviewThread[];
  /** Reviewed marks the review starts with (the session's `reviewed`). */
  reviewed?: Record<string, string>;
  /** Side by side from the start (a remembered preference); unset: default. */
  split?: boolean;
  /** The window's width (default 1024, below the side by side default). */
  width?: number;

  // The review and what the bridge holds.
  /** The review's session id (default "s1"): reviews keep places apart. */
  sessionId?: string;
  /** Fields of the review session over the kit's (target, gitlab, agent...). */
  session?: Record<string, unknown>;
  /** The merge request a request's review read (snapshot.mergeRequest). */
  mergeRequest?: ReviewMergeRequest;
  /** Why the merge request could not be read (snapshot.gitlabError). */
  gitlabError?: string;
  /** Threads of the checkout's other reviews shown here (rendered files). */
  shared?: ReviewThread[];
  /** The other reviews the bridge holds, by their session. */
  otherReviews?: Record<string, unknown>[];
  /**
   * The review's commits, oldest first. A commit with `files` is a view of
   * its own: the review opens on the oldest such commit.
   */
  commits?: SurfaceCommit[];
  /** Patch ids by sha, answered with the commits. */
  patchIds?: Record<string, string>;
  /** A file's text at a revision: `${rev}:${path}` ("" is the checkout). */
  fileAt?: Record<string, string>;
  /** The repositories the bridge finds in the workspace's directories. */
  repos?: { root: string; branch?: string; ahead?: number; dirty?: boolean }[];
  /** What the bridge answers a method, over the kit's answers. */
  answers?: Record<string, (params: Record<string, unknown>) => unknown>;

  // The page around the review.
  /** The workspace's agent panes, best candidate first. */
  agentPanes?: { paneId: string; agent: string }[];
  /** The workspace's pane directories, and its agents'. */
  repoDirs?: string[];
  agentDirs?: string[];
  /**
   * Mounted by a host that can show the agent's pane, other repositories,
   * the local or forge review and open files (ReviewHost does). The reviews
   * list and another review are always offered.
   */
  hostCallbacks?: boolean;
  /** The surface can open files (Open, Rendered, gf). */
  openFiles?: boolean;
  /** Mounted out of sight (pinned to a workspace not shown). */
  hidden?: boolean;
  /**
   * The browser storage it opens with: "keep" leaves what the reviews
   * mounted before left (another review of the same browser); a record
   * replaces it (keys to raw values, damaged ones too). Default: empty.
   */
  storage?: "keep" | Record<string, string>;
  /** The Vim preference for comments (default: on). */
  vim?: boolean;
  /**
   * Mount under Bun's fake timers (restored by unmount): `advance(ms)` lets
   * time pass, for polls and deadlines.
   */
  fakeTimers?: boolean;

  // The screen.
  /**
   * The screen's height in lines: the surface is laid out as a column of
   * lines that tall (each drawn line one line high), so page keys, H M L
   * and zz zt zb have a screen to act on. Unset: no layout.
   */
  viewport?: number;
  /** A touch screen (a coarse pointer). */
  coarse?: boolean;
  /** The phone layout (mobile mode, its system Back). */
  phone?: boolean;
  /** The surface's stylesheet applied, for what is shown or hidden. */
  styles?: boolean;
};

/** A commit of the review; with `files`, the changes it makes. */
export type SurfaceCommit = Partial<ReviewCommit> & {
  sha: string;
  subject: string;
  files?: ReviewDiffFile[];
};

/** A new state of the review on the bridge. */
export type BridgeUpdate = {
  threads?: ReviewThread[];
  session?: Record<string, unknown>;
  mergeRequest?: ReviewMergeRequest;
  gitlabError?: string;
};

/** One message of a thread as shown. */
export type ShownMessage = {
  /** The comment's id (a client id while pending). */
  id: string;
  text: string;
  /** Its marks: "edited", "GitLab draft", "→ Claude", "Sending...", ... */
  marks: string[];
  /** Its buttons, by label. */
  buttons: string[];
  /** n / N selected it. */
  selected: boolean;
  /** On its way to the bridge, or failed to reach it. */
  pending: "sending" | "failed" | null;
};

/** A thread as shown with the review. */
export type ShownThread = {
  /** Its id when the review knows it, else null (a new one pending). */
  id: string | null;
  /** Above the diff (a comment on the whole review), or on a line. */
  general: boolean;
  folded: boolean;
  resolved: boolean;
  /** A folded thread's one line. */
  summary: string;
  messages: ShownMessage[];
  /** The buttons of the thread's own bar (Reply, Resolve, Fold, ...). */
  buttons: string[];
  /** "X is working on this..." while its agent works on it. */
  working: string | null;
};

/** The comments panel as shown. */
export type ThreadsPanelView = {
  /** Its threads in order, by id. */
  ids: string[];
  selected: string | null;
  /** Threads unfolded (all their messages shown). */
  unfolded: string[];
  /** The search box has the focus. */
  searching: boolean;
  text: string;
};

/** A menu entry as shown: its label, and its check for a toggle. */
export type ShownMenuItem = {
  label: string;
  checked?: boolean;
  disabled: boolean;
};

/** A forge (GitLab, GitHub) discussion as drawn. */
export type ShownForgeThread = {
  id: string;
  /** Its summary line: forge, author, replies, resolved, outdated. */
  head: string;
  /** Unfolded: its notes show. */
  open: boolean;
  text: string;
};

/** What the surface asked of the page around it (its host's callbacks). */
export type HostCall = { name: string; args: unknown[] };

export interface ReviewSurface {
  readonly name: string;
  /** The line with the cursor, or null when it is on no line. */
  cursorLine(): ShownLine | null;
  /**
   * Side by side, the side the cursor is on ("both" on an unchanged line,
   * drawn across); null in a unified diff.
   */
  cursorSide(): "old" | "new" | "both" | null;
  /** The word under the cursor (or its character), and where it starts. */
  cursorWord(): { start: number; text: string } | null;
  /** The lines a Visual selection holds, in order. */
  selection(): ShownLine[];
  /** Every drawn line, in order (both halves of a side by side row). */
  lines(path?: string): ShownLine[];
  /** True when the diff is drawn side by side. */
  sideBySide(): boolean;
  /** The text the surface shows, comments included. */
  text(): string;
  /** Keys in Vim notation: `5j`, `gg`, `<C-d>`, `<Left>`, `<Esc>`, `<A-v>`. */
  press(keys: string): Promise<void>;
  /** A `:` command, as typed at the prompt (with or without the colon). */
  command(text: string): Promise<void>;
  /** Click a line (Shift extends a selection). */
  click(
    line: Pick<ShownLine, "path"> & Partial<ShownLine>,
    shift?: boolean,
  ): Promise<void>;
  /** The gap buttons between hunks of a file and at its ends, in order. */
  gaps(path: string): { label: string; buttons: string[] }[];
  /** Press a gap's button (`gaps(path)[index]`, by its label). */
  expandGap(path: string, index: number, button: string): Promise<void>;
  /** Pick a file in the file list: the cursor goes to it, shown. */
  goToFile(path: string): Promise<void>;
  /** A file shows as reviewed (folded, ticked). */
  fileReviewed(path: string): boolean;
  /** The file list's chunk progress for a file, as "1/2", or null. */
  chunkProgress(path: string): string | null;
  /** The reviewed marks as the bridge holds them after every update. */
  reviewedMarks(): Record<string, string>;
  /** Close and open the review again, as a page reload. */
  reload(): Promise<void>;
  unmount(): Promise<void>;
  /** The shortcut list (`?`) as shown: each row's keys, in order. */
  shortcutKeys(): string[][];

  // Showing and the screen.
  /**
   * Put the review out of sight, kept as it is, or show it again (Option+R
   * closing and reopening it, another workspace and back). Renders only: it
   * runs no timer, so it works under fake timers.
   */
  setHidden(hidden: boolean): Promise<void>;
  /** The review holds the keyboard focus. */
  hasFocus(): boolean;
  /**
   * Advance Bun's fake timers by `ms`, rendering what they change (settled
   * too when mounted with `fakeTimers`).
   */
  advance(ms: number): Promise<void>;
  /** The page goes out of view (true) or back (false). */
  setPageHidden(hidden: boolean): Promise<void>;
  /** The lines fully on the screen, top to bottom (needs `viewport`). */
  screenLines(): ShownLine[];
  /** The phone's system Back (needs `phone`). */
  systemBack(): Promise<void>;
  /**
   * A control by its label (or title): its smallest touch size in pixels
   * and whether it stays in place while its row scrolls (needs `styles`).
   */
  control(label: string): { minHeight: number; sticky: boolean } | null;

  // What is shown.
  /** The file list shows (with `styles`, as the stylesheet lays it out). */
  filesShown(): boolean;
  /** The head and the file list are shown, not only the diff (needs `styles`). */
  chromeShown(): boolean;
  /** Review only (diff only): the chrome is hidden. */
  diffOnly(): boolean;
  /**
   * The view shown, as its strip names it: "1/2 <sha> <subject>" or
   * "All changes 2 commits"; "" when the review shows no commit strip.
   */
  view(): string;
  /**
   * The commit bar as shown (Review only: the bottom strip): the view's
   * head ("2/3 bbbbbbbb", "All changes") and subject; null when hidden.
   */
  commitBar(): { head: string; subject: string } | null;
  /** Step the shown commit bar: -1 previous, 1 next. */
  stepCommitBar(direction: -1 | 1): Promise<void>;
  /** The commit picker: its search and its choices, or null. */
  commitPicker(): { query: string; choices: string[] } | null;
  /** The repository chooser: its choices and the one shown; null if none. */
  repoChooser(): { choices: string[]; value: string } | null;
  /** A status shown about the review (code changed, ...). */
  banner(): string | null;
  /** The review's status line (read aloud: aria-live). */
  status(): string;
  /** The app's latest notice (a toast), or null. */
  notice(): string | null;
  /** Every notice the surface showed since mounting, oldest first. */
  notices(): string[];
  /** Labels of the buttons and links shown (text, else aria-label). */
  buttons(): string[];
  /** Click the `index`th button or link with that text or aria-label. */
  clickButton(label: string, index?: number): Promise<void>;
  /** A link's target, by its text. */
  linkHref(label: string): string | null;
  /**
   * A header menu's entries: "agent" (how comments reach the agent, asking
   * it) or "more" (GitLab, copying). Opens and closes it to read.
   */
  menu(name: "agent" | "more"): Promise<ShownMenuItem[]>;
  /** Pick an entry of a header menu. */
  chooseMenu(name: "agent" | "more", label: string): Promise<void>;
  /** The Local / forge switch: each choice and whether it is on. */
  modeSwitch(): { label: string; on: boolean }[] | null;
  /** The agent review's focus bar: its text, or null when closed. */
  focusBar(): string | null;

  // Files.
  /** A file's lines are folded away under its header. */
  fileFolded(path: string): boolean;
  /** The buttons on a file's header, by label. */
  fileButtons(path: string): string[];
  /** Click a file's header (its name), or one of its buttons by label. */
  clickFileHeader(path: string, button?: string): Promise<void>;

  // Search, the `:` prompt and the shortcut list.
  /** A `/` search, as typed at its prompt. */
  search(pattern: string): Promise<void>;
  /** The search line (pattern, match counter, "Pattern not found"), or null. */
  searchLine(): string | null;
  /** The paths the file list marks as matching the search. */
  filesMatching(): string[];
  /** Open the `:` prompt and type `text`, without running it. */
  typeCommand(text: string): Promise<void>;
  /** The prompt shown (`:` or `/`), its text and its completions. */
  prompt(): {
    kind: string;
    text: string;
    completions: { name: string; description: string; on: boolean }[];
  } | null;
  /** The shortcut list's rows, or null when it is closed. */
  shortcuts(): { keys: string; label: string }[] | null;
  /** Type a filter into the open shortcut list. */
  filterShortcuts(text: string): Promise<void>;
  /** The Vim preference for comments, as remembered. */
  vimPreference(): boolean | undefined;
  /** Where reviews open (`:set reviewin=`), as remembered. */
  reviewInPreference(): string | undefined;

  // The comment editor.
  /** A comment editor is open. */
  editorOpen(): boolean;
  /** The comment editor open, with its prompt and text, or null. */
  editor(): { placeholder: string; text: string } | null;
  /** The text of the open comment editor, or null when none is open. */
  editorText(): string | null;
  /** The open editor's placeholder (who the comment is for), or null. */
  editorPlaceholder(): string | null;
  /** Types text into the open editor at its cursor. */
  type(text: string): Promise<void>;
  /** Types text into the open editor at its end. */
  typeInEditor(text: string): Promise<void>;
  /** Write in the open comment editor, replacing its text. */
  writeInEditor(text: string): Promise<void>;
  /** Keys in Vim notation, pressed in the open editor (`<Esc>`, `<C-Enter>`). */
  editorPress(keys: string): Promise<void>;
  /** An ex command typed in the editor's Vim prompt (`:w`, `:q`, `:sugg`). */
  editorCommand(text: string): Promise<void>;
  /** The buttons of the open comment editor, by label. */
  editorButtons(): string[];
  /** Presses the open editor's button of that label (Save, Suggest, Esc). */
  editorButton(label: string): Promise<void>;
  /** Pastes an image file into the open editor. */
  pasteImage(name: string, type?: string): Promise<void>;
  /** Holds pasted images' uploads; the function lets them land. */
  holdImageUploads(): () => Promise<void>;
  /** Selects words of a message (as a mouse drag would) in the review. */
  selectWords(words: string): Promise<void>;
  /** Comments on the part of a message reading `part`, with its margin +. */
  commentOnPart(part: string): Promise<void>;

  // Threads.
  /** The threads shown, above the diff and under its lines, in order. */
  shownThreads(): ShownThread[];
  /** The texts of the comments drawn at a file's head, before its lines. */
  fileComments(path: string): string[];
  /** The texts of the comment boxes drawn in the review, in order. */
  commentTexts(): string[];
  /**
   * Press a button of a thread by its label (Reply, Resolve, Edit, Retry,
   * ...): of its message `message` (index), else of the thread's own bar.
   */
  threadButton(
    threadId: string,
    label: string,
    message?: number,
  ): Promise<void>;
  /** Click a thread: a folded one unfolds, else its message `message`. */
  clickThread(threadId: string, message?: number): Promise<void>;
  /** Comments show (not all hidden). */
  commentsShown(): boolean;
  /** The comments are hidden (t, :comments), as its view button says. */
  commentsHidden(): boolean;
  /** The view button that shows or hides the comments: its badge count. */
  hiddenBadge(): number | null;
  /** The lines that carry a comment marker in the margin. */
  markedLines(): ShownLine[];
  /** The forge's discussions as drawn, in order. */
  forgeThreads(): ShownForgeThread[];
  /** Fold or unfold a drawn forge discussion by clicking its summary. */
  toggleForgeThread(id: string): Promise<void>;
  /** The review's conversations list is open. */
  conversationsShown(): boolean;
  /** The comments panel (T), or null when closed. */
  threadsPanel(): ThreadsPanelView | null;
  /** The comments chip ("2 open · 3 comments"), or null. */
  threadsChip(): string | null;
  /** Click the comments chip. */
  clickThreadsChip(): Promise<void>;
  /** The unresolved threads' arrows: their label and buttons, or null. */
  unresolvedNav(): { label: string; disabled: boolean } | null;
  /** Press an arrow of the unresolved nav: "next", "previous" or "only". */
  unresolvedStep(button: "next" | "previous" | "only"): Promise<void>;

  // The bridge.
  /** The bridge calls made since mounting (of one method), in order. */
  calls(method?: string): { method: string; params: Record<string, unknown> }[];
  /** The bridge pushes a new state of the review. */
  push(update: BridgeUpdate): Promise<void>;
  /**
   * What the bridge holds without pushing it (a push lost with its
   * socket): what reading the review back answers.
   */
  bridgeHolds(update: BridgeUpdate | (() => BridgeUpdate)): void;
  /** Make the bridge fail these methods (none: answer them again). */
  failBridge(methods: string[], error?: string): void;
  /**
   * The connection goes down (false), every call failing meanwhile as the
   * bridge's socket does ("bridge hello is unavailable"), or comes back.
   */
  setConnected(connected: boolean): Promise<void>;
  /** Hold the bridge's answer to a method until released. */
  holdBridge(method: string): { release(error?: string): Promise<void> };

  // The page around the review.
  /** The host callbacks called (focus an agent pane, open a repo, ...). */
  hostCalls(name?: string): HostCall[];
  /** How many times the review asked to close. */
  closes(): number;
  /** How many times the review asked for the reviews list. */
  listsShown(): number;
  /** The reviews the review asked to show instead of itself. */
  reviewsShown(): unknown[];
  /** The files the review asked to open (needs `openFiles`). */
  openedFiles(): { path: string; line?: number; rendered?: boolean }[];
  /** The URLs the review opened in a new tab. */
  opened(): string[];
}

/** A hunk from lines written as in a patch: ` same`, `-gone`, `+new`. */
export function hunk(
  oldStart: number,
  newStart: number,
  patch: string[],
): ReviewDiffHunk {
  let old = oldStart;
  let added = newStart;
  const lines: ReviewDiffLine[] = patch.map((line) => {
    const kind = line[0] as "+" | "-" | " ";
    const text = line.slice(1);
    if (kind === "+") return { kind, old: null, new: added++, text };
    if (kind === "-") return { kind, old: old++, new: null, text };
    return { kind: " ", old: old++, new: added++, text };
  });
  const oldCount = old - oldStart;
  const newCount = added - newStart;
  return {
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    lines,
  };
}

export function file(path: string, ...hunks: ReviewDiffHunk[]): ReviewDiffFile {
  return { path, oldPath: path, hunks };
}

/** `count` numbered lines: `${prefix} 1` .. `${prefix} count`. */
export function numbered(prefix: string, count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${from + i}`);
}

/** A discussion with one comment on a line. */
export function thread(
  id: string,
  path: string,
  line: number,
  body: string,
  side: "old" | "new" = "new",
): ReviewThread {
  return {
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: { path, line, side },
    comments: [
      {
        id: `${id}c`,
        author: "Claude",
        body,
        createdAt: "2026-11-04T14:11:18Z",
        updatedAt: "2026-11-04T14:11:18Z",
      },
    ],
    resolved: false,
    createdAt: "2026-11-04T14:11:18Z",
    updatedAt: "2026-11-04T14:11:18Z",
  } as unknown as ReviewThread;
}

/** One key event's fields. */
export type KeyStroke = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

const NAMED: Record<string, string> = {
  esc: "Escape",
  cr: "Enter",
  enter: "Enter",
  tab: "Tab",
  bs: "Backspace",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  home: "Home",
  end: "End",
  pagedown: "PageDown",
  pageup: "PageUp",
  space: " ",
  lt: "<",
};

/** Vim notation to key events: `5j`, `<C-d>`, `<S-Tab>`, `<A-v>`. */
export function parseKeys(keys: string): KeyStroke[] {
  const strokes: KeyStroke[] = [];
  for (const match of keys.matchAll(/<([^<>]+)>|([\s\S])/g)) {
    const single = match[2];
    if (single !== undefined) {
      strokes.push({
        key: single,
        shiftKey: single !== single.toLowerCase(),
      });
      continue;
    }
    const parts = match[1]!.split("-");
    const name = parts.pop()!;
    const mods = new Set(parts.map((part) => part.toUpperCase()));
    const named = NAMED[name.toLowerCase()];
    const key = named ?? name;
    const stroke: KeyStroke = { key };
    if (mods.has("C")) stroke.ctrlKey = true;
    if (mods.has("S")) stroke.shiftKey = true;
    if (mods.has("A") || mods.has("M")) {
      stroke.altKey = true;
      // A Mac's Option types another character; the code says the key.
      if (key.length === 1 && /[a-z]/i.test(key)) {
        stroke.code = `Key${key.toUpperCase()}`;
        stroke.key = key.toLowerCase() === "v" ? "√" : key;
      }
    }
    strokes.push(stroke);
  }
  return strokes;
}

/** Let React and the timers of the surface settle. */
export async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Install a happy-dom window as the global DOM. Call once, at the top of
 * the isolated child, before React or a surface is imported.
 */
export async function installReviewDom() {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    Range: browser.Range,
    Text: browser.Text,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLInputElement: browser.HTMLInputElement,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  return browser;
}
