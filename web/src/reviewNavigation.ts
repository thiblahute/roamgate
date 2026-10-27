/**
 * Vim-style navigation for the review overlay, as maildesk's review does it.
 * Pure functions over the diff's rows so they can be tested without a DOM.
 */

/** Words are letters, digits and underscores; symbols are skipped. */
const WORD = /[A-Za-z0-9_]+/g;
/** WORDs (W, B) are runs of non-blank characters. */
const BIG_WORD = /\S+/g;

export type Cursor = { at: number; col: number };

export type Match = { at: number; start: number; end: number };

function words(text: string, big: boolean): [number, number][] {
  const pattern = big ? BIG_WORD : WORD;
  pattern.lastIndex = 0;
  const spans: [number, number][] = [];
  for (const match of text.matchAll(pattern))
    spans.push([match.index!, match.index! + match[0].length]);
  return spans;
}

/** The word under or right after `col`, or null when the line has none. */
export function wordAt(
  text: string,
  col: number,
): { start: number; end: number; word: string } | null {
  for (const [start, end] of words(text, false)) {
    if (col < end) return { start, end, word: text.slice(start, end) };
  }
  return null;
}

/**
 * `w`, `b` and `e` across lines. Lines without words are skipped, as in
 * maildesk, so the cursor never lands on a blank or symbol-only line.
 */
export function wordMotion(
  lines: readonly string[],
  cursor: Cursor,
  motion: "w" | "b" | "e",
  big = false,
): Cursor {
  const { at, col } = cursor;
  if (motion === "w" || motion === "e") {
    for (let row = at; row < lines.length; row++) {
      for (const [start, end] of words(lines[row] ?? "", big)) {
        if (motion === "w" && (row > at ? start >= 0 : start > col))
          return { at: row, col: start };
        if (motion === "e" && (row > at || end - 1 > col))
          return { at: row, col: end - 1 };
      }
    }
    return cursor;
  }
  for (let row = at; row >= 0; row--) {
    const spans = words(lines[row] ?? "", big);
    for (let index = spans.length - 1; index >= 0; index--) {
      const [start] = spans[index]!;
      if (row < at || start < col) return { at: row, col: start };
    }
  }
  return cursor;
}

export function firstNonBlank(text: string): number {
  const match = /\S/.exec(text);
  return match ? match.index : 0;
}

/** Vim's smart case: lower-case patterns ignore case. */
export function searchRegExp(
  pattern: string,
  wholeWord: boolean,
): RegExp | null {
  if (!pattern) return null;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = wholeWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(source, /[A-Z]/.test(pattern) ? "g" : "gi");
}

export function findMatches(
  lines: readonly string[],
  pattern: string,
  wholeWord: boolean,
): Match[] {
  const regexp = searchRegExp(pattern, wholeWord);
  if (!regexp) return [];
  const matches: Match[] = [];
  lines.forEach((text, at) => {
    regexp.lastIndex = 0;
    for (const match of text.matchAll(regexp)) {
      if (!match[0]) break;
      matches.push({
        at,
        start: match.index!,
        end: match.index! + match[0].length,
      });
    }
  });
  return matches;
}

/**
 * The next file whose path matches, after (or before) the file `from`,
 * wrapping around; -1 when none does.
 */
export function findFile(
  paths: readonly (string | null)[],
  pattern: string,
  from: number,
  direction: 1 | -1 = 1,
): number {
  const regexp = searchRegExp(pattern, false);
  if (!regexp || !paths.length) return -1;
  for (let step = 1; step <= paths.length; step++) {
    const index =
      (((from + direction * step) % paths.length) + paths.length) %
      paths.length;
    const path = paths[index];
    regexp.lastIndex = 0;
    if (path && regexp.test(path)) return index;
  }
  return -1;
}

/** The next match after (or before) the cursor, wrapping around. */
export function nextMatch(
  matches: readonly Match[],
  cursor: Cursor,
  direction: 1 | -1,
): Match | null {
  if (!matches.length) return null;
  const after = (m: Match) =>
    m.at > cursor.at || (m.at === cursor.at && m.start > cursor.col);
  const before = (m: Match) =>
    m.at < cursor.at || (m.at === cursor.at && m.start < cursor.col);
  if (direction === 1) return matches.find(after) ?? matches[0]!;
  for (let index = matches.length - 1; index >= 0; index--)
    if (before(matches[index]!)) return matches[index]!;
  return matches[matches.length - 1]!;
}

export type ReviewCommand =
  | { type: "line"; line: number }
  | { type: "close" }
  | { type: "save" }
  | { type: "split" }
  | { type: "files" }
  | { type: "diffOnly" }
  | { type: "comments" }
  | { type: "ask" }
  | { type: "send" }
  | { type: "hold" }
  | { type: "threads" }
  /** Only the unresolved threads where they are, or all of them again. */
  | { type: "unresolved" }
  /** The next hunk not reviewed (gu). */
  | { type: "unreviewed" }
  | { type: "review"; focus: string | null }
  | { type: "open" }
  | { type: "switchMode" }
  | { type: "suggest" }
  | { type: "commit"; index: number | null }
  /** The commit picker, searched for `query` (`:commits`, `:commit words`). */
  | { type: "commits"; query: string }
  | { type: "reload" }
  | { type: "overall" }
  | { type: "reviews" }
  | { type: "vim"; on?: boolean }
  | { type: "unknown"; text: string };

/** maildesk's command list, for the `:` line and its Tab completion. */
export const REVIEW_COMMANDS: [string, string][] = [
  ["q", "close the review"],
  ["w", "save the review"],
  ["wq", "save and close"],
  ["x", "save and close"],
  ["diff", "side by side / unified"],
  ["files", "show / hide the file list"],
  ["only", "diff only: no chrome, just the diff"],
  ["comments", "show / hide all comments"],
  ["ask", "ask the agent about this line"],
  ["review", "agent review (:review focus)"],
  ["send", "send the held comments to the agent"],
  ["hold", "hold comments until :send / send as written"],
  ["overall", "write the overall comment on the review"],
  ["conversations", "every conversation of the review, resolved too (T)"],
  ["threads", "every conversation of the review, resolved too (T)"],
  ["unresolved", "show only the unresolved threads, or all again (gH)"],
  ["unreviewed", "the next chunk not reviewed (gu)"],
  ["suggest", "suggest a change on this line"],
  ["open", "open the MR on GitLab"],
  ["gitlab", "open the MR on GitLab"],
  ["switch", "local review / review on GitLab (the branch's MR)"],
  [
    "commit",
    "review one commit: :commit 2, :commit words of its subject; alone for all",
  ],
  ["commits", "pick a commit by its subject (gc)"],
  ["all", "all changes again"],
  ["reviews", "the reviews in progress"],
  ["vim", "Vim keys in comments on / off"],
  ["e", "reload the diff (gr)"],
];

export function commandCompletions(text: string): [string, string][] {
  const typed = text.trim();
  return REVIEW_COMMANDS.filter(([name]) => name.startsWith(typed));
}

/** maildesk's `:` commands. */
export function parseReviewCommand(input: string): ReviewCommand {
  const text = input.trim().replace(/^:/, "");
  if (/^\d+$/.test(text)) return { type: "line", line: Number(text) };
  const [word = "", ...rest] = text.split(/\s+/);
  const argument = rest.join(" ");
  switch (word) {
    case "q":
    case "q!":
    case "quit":
    case "wq":
    case "x":
    case "xit":
    case "close":
      return { type: "close" };
    case "w":
    case "write":
      return { type: "save" };
    case "s":
    case "split":
    case "diff":
    case "unified":
      return { type: "split" };
    case "files":
      return { type: "files" };
    case "only":
    case "diffonly":
    case "o":
      return { type: "diffOnly" };
    case "comments":
    case "hidecomments":
      return { type: "comments" };
    case "ask":
    case "chat":
    case "discuss":
      return { type: "ask" };
    case "send":
    case "handoff":
      return { type: "send" };
    case "hold":
      return { type: "hold" };
    case "overall":
    case "summary":
      return { type: "overall" };
    case "threads":
    case "conversations":
    case "conv":
      return { type: "threads" };
    case "unresolved":
    case "openonly":
      return { type: "unresolved" };
    case "unreviewed":
      return { type: "unreviewed" };
    case "review":
      return { type: "review", focus: argument || null };
    case "open":
    case "gitlab":
    case "mr":
      return { type: "open" };
    case "switch":
      return { type: "switchMode" };
    case "suggest":
      return { type: "suggest" };
    case "all":
      return { type: "commit", index: null };
    case "commit":
      if (/^\d+$/.test(argument))
        return { type: "commit", index: Number(argument) - 1 };
      return argument
        ? { type: "commits", query: argument }
        : { type: "commit", index: null };
    case "commits":
      return { type: "commits", query: argument };
    case "e":
    case "edit":
    case "reload":
      return { type: "reload" };
    case "reviews":
      return { type: "reviews" };
    case "vim":
      return { type: "vim" };
    case "novim":
      return { type: "vim", on: false };
    case "set":
      if (argument === "vim") return { type: "vim", on: true };
      if (argument === "novim") return { type: "vim", on: false };
      return { type: "unknown", text };
    default:
      return { type: "unknown", text };
  }
}

/**
 * Collects a count and multi-key sequences (gg, dd, zz, zo...) the way Vim
 * does: digits accumulate, a prefix waits for its second key.
 */
export type KeyState = { count: string; pending: string };

export const EMPTY_KEY_STATE: KeyState = { count: "", pending: "" };

const PREFIXES = new Set(["g", "z", "d"]);
const SEQUENCES = new Set([
  "gg",
  "gf",
  "gl",
  "gm",
  "gc",
  "g;",
  "gn",
  "gN",
  "gH",
  "gu",
  "gU",
  "gr",
  "dd",
  "zz",
  "zt",
  "zb",
  "z.",
  "zo",
  "zO",
  "zR",
  "za",
]);

export type KeyResult =
  | { type: "wait"; state: KeyState }
  | { type: "command"; key: string; count: number | null; state: KeyState };

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export function feedKey(state: KeyState, key: string): KeyResult {
  // A bare modifier is part of the next key, not a key: it must not cancel
  // a count or a pending g/z/d (maildesk's 12G and zO lose to Shift).
  if (MODIFIERS.has(key)) return { type: "wait", state };
  if (state.pending) {
    const sequence = state.pending + key;
    const count = state.count ? Number(state.count) : null;
    if (SEQUENCES.has(sequence))
      return { type: "command", key: sequence, count, state: EMPTY_KEY_STATE };
    // An unknown sequence drops the prefix and reads the key on its own.
    return feedKey({ count: state.count, pending: "" }, key);
  }
  if (/^[0-9]$/.test(key) && (key !== "0" || state.count))
    return { type: "wait", state: { ...state, count: state.count + key } };
  if (PREFIXES.has(key))
    return { type: "wait", state: { ...state, pending: key } };
  return {
    type: "command",
    key,
    count: state.count ? Number(state.count) : null,
    state: EMPTY_KEY_STATE,
  };
}

/**
 * The files of a view that are reviewed: marked in this view (`view:path`)
 * with the diff they still have, or, never marked nor unmarked here (an
 * unmark is kept as ""), the same diff of the same file marked in another
 * view: a commit rebased, new changes reloaded.
 */
export function reviewedIndexes(
  paths: readonly string[],
  fingerprints: readonly string[],
  view: string,
  marks: Readonly<Record<string, string>>,
): Set<number> {
  const elsewhere = new Set<string>();
  for (const [key, value] of Object.entries(marks))
    if (value && !key.includes("\n"))
      elsewhere.add(`${key.slice(key.indexOf(":") + 1)}\n${value}`);
  const reviewed = new Set<number>();
  paths.forEach((path, index) => {
    const fingerprint = fingerprints[index];
    if (fingerprint === undefined) return;
    const own = marks[`${view}:${path}`];
    if (
      own === undefined
        ? elsewhere.has(`${path}\n${fingerprint}`)
        : own === fingerprint
    )
      reviewed.add(index);
  });
  return reviewed;
}

/** The changed lines of a hunk, as hunkIds reads them. */
type HunkLines = { lines: readonly { kind: string; text: string }[] };

/**
 * Each hunk's identity: a hash of the file's path and of the hunk's removed
 * and added lines, not of its place nor its context. A hunk keeps its mark
 * when a rebase or a change elsewhere moves it, and loses it when its own
 * lines change. A second hunk of the file with the same lines gets `~2`.
 */
export function hunkIds(path: string, hunks: readonly HunkLines[]): string[] {
  const seen = new Map<string, number>();
  return hunks.map((hunk) => {
    let hash = 5381;
    const feed = (text: string) => {
      for (let i = 0; i < text.length; i++)
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    };
    feed(`${path}\n`);
    let changed = 0;
    for (const line of hunk.lines) {
      if (line.kind === " ") continue;
      changed++;
      feed(`${line.kind}${line.text}\n`);
    }
    const id = `h${changed}.${(hash >>> 0).toString(36)}`;
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}~${count}`;
  });
}

/**
 * Where a hunk's mark is kept, beside the file marks (`view:path`): its
 * id after a newline, valued "1" (reviewed) or "" (unmarked in this view).
 */
export function hunkKey(view: string, path: string, id: string): string {
  return `${view}:${path}\n${id}`;
}

/** A file of the view, as the reviewed marks see it. */
export type ReviewedFile = {
  path: string;
  /** fileFingerprint of its whole diff. */
  fingerprint: string;
  /** hunkIds of its hunks. */
  hunks: readonly string[];
};

export type ReviewedState = {
  /** Files reviewed: marked whole, or every hunk marked. */
  files: Set<number>;
  /** The reviewed hunks of each file, by index. */
  hunks: Set<number>[];
};

/**
 * The reviewed files and hunks of a view. A hunk is reviewed when marked
 * here; never marked nor unmarked here, when the same hunk is marked in
 * another view or its file is reviewed whole (reviewedIndexes). A file is
 * reviewed whole, or once every one of its hunks is.
 */
export function reviewedState(
  files: readonly ReviewedFile[],
  view: string,
  marks: Readonly<Record<string, string>>,
): ReviewedState {
  const whole = reviewedIndexes(
    files.map((file) => file.path),
    files.map((file) => file.fingerprint),
    view,
    marks,
  );
  const elsewhere = new Set<string>();
  for (const [key, value] of Object.entries(marks))
    if (value && key.includes("\n"))
      elsewhere.add(key.slice(key.indexOf(":") + 1));
  const reviewed = new Set(whole);
  const hunks = files.map((file, index) => {
    const done = new Set<number>();
    file.hunks.forEach((id, hunk) => {
      const own = marks[hunkKey(view, file.path, id)];
      if (
        own === undefined
          ? whole.has(index) || elsewhere.has(`${file.path}\n${id}`)
          : own !== ""
      )
        done.add(hunk);
    });
    if (file.hunks.length && done.size === file.hunks.length)
      reviewed.add(index);
    return done;
  });
  return { files: reviewed, hunks };
}

/**
 * The marks to write so that `file` has exactly the hunks `want` reviewed:
 * each hunk marked "1", or unmarked ("" where another mark would count it,
 * else its mark dropped as null); the file itself marked whole with every
 * hunk (or `whole`, for a file without hunks), else unmarked. Only what
 * changes.
 */
export function reviewedChanges(
  file: ReviewedFile,
  want: ReadonlySet<number>,
  view: string,
  marks: Readonly<Record<string, string>>,
  whole = file.hunks.length > 0 && file.hunks.every((_, i) => want.has(i)),
): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  const set = (key: string, value: string | null) => {
    if (value === null ? key in marks : marks[key] !== value)
      changes[key] = value;
  };
  const fileKey = `${view}:${file.path}`;
  const markedElsewhere = (suffix: string, value?: string) =>
    Object.entries(marks).some(
      ([key, mark]) =>
        mark !== "" &&
        (value === undefined || mark === value) &&
        key !== fileKey &&
        key.slice(key.indexOf(":") + 1) === suffix,
    );
  set(
    fileKey,
    whole
      ? file.fingerprint
      : fileKey in marks || markedElsewhere(file.path, file.fingerprint)
        ? ""
        : null,
  );
  file.hunks.forEach((id, index) => {
    const key = hunkKey(view, file.path, id);
    set(
      key,
      want.has(index)
        ? "1"
        : key in marks || markedElsewhere(`${file.path}\n${id}`)
          ? ""
          : null,
    );
  });
  return changes;
}

/** A row's hunk, as it was in the view's diff; null for context revealed. */
export type HunkUnit = { file: number; hunk: number } | null;

/**
 * gu / gU: the first row of the next (or previous) hunk not reviewed, after
 * the hunk of row `from`, wrapping around; null when every other hunk is.
 */
export function nextUnreviewedHunk(
  units: readonly HunkUnit[],
  reviewed: (file: number, hunk: number) => boolean,
  from: number,
  direction: 1 | -1,
): number | null {
  const count = units.length;
  if (!count) return null;
  const here = units[from];
  const same = (unit: HunkUnit) =>
    !!unit && !!here && unit.file === here.file && unit.hunk === here.hunk;
  for (let step = 1; step <= count; step++) {
    const at = (((from + direction * step) % count) + count) % count;
    const unit = units[at];
    if (!unit || same(unit) || reviewed(unit.file, unit.hunk)) continue;
    let first = at;
    while (
      first > 0 &&
      units[first - 1]?.file === unit.file &&
      units[first - 1]?.hunk === unit.hunk
    )
      first--;
    return first;
  }
  return null;
}

/** A drawn line of a side by side diff: its rows, both the same for context. */
export type SplitLine = { left: number | null; right: number | null };

/**
 * Side by side, j / k: `delta` drawn lines down or up from the row `at`,
 * staying on `side` where that line has a row there.
 */
export function splitStep(
  lines: readonly SplitLine[],
  at: number,
  delta: number,
  side: "left" | "right",
): number | null {
  const index = lines.findIndex(
    (line) => line.left === at || line.right === at,
  );
  if (index < 0) return null;
  const line = lines[Math.max(0, Math.min(lines.length - 1, index + delta))]!;
  return side === "left"
    ? (line.left ?? line.right)
    : (line.right ?? line.left);
}
