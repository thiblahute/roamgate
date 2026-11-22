import type { ShortcutRow } from "./components/ShortcutHelp";

/*
 * The board view's shortcut lists, for its help (?, ShortcutHelp) and the
 * shortcut cheat sheet: picked in the help, a row runs as its keys typed
 * in the view (the first of them where it lists synonyms).
 */

/**
 * An effort's view's keys, for its help (?): its tabs, its ledger and the
 * comments one leaves there for its leader session.
 */
export const EFFORT_KEYS: readonly ShortcutRow[] = [
  [
    "B",
    "Board: a card per planned request, in the inbox's lanes (the last tab shown opens next time)",
  ],
  ["P", "Progress"],
  ["L", "Ledger"],
  ["R", "Plans (planned requests)"],
  ["F", "Feeders"],
  ["W", "What changed"],
  [
    "j ↓",
    "on the Board: the next card in its column (through every column on a phone); in the ledger: the next commit; elsewhere the next thing one comments on",
    "j",
  ],
  [
    "k ↑",
    "on the Board: the previous card in its column; in the ledger: the previous commit; elsewhere the previous thing one comments on",
    "k",
  ],
  ["h ←", "on the Board: the column on the left", "h"],
  ["l →", "on the Board: the column on the right", "l"],
  [
    "Enter",
    "on the Board: the card's review in its home (a part's workspace, a plan's place in Plans); in the ledger: the commit's versions",
  ],
  ["o", "on the Board: the card's request on the forge"],
  ["e", "on the Board: set the card's next step and who it is on"],
  ["w", "on the Board: the card's workspace"],
  ["za", "on the Board: fold or unfold its column (Done starts folded)"],
  ["x", "in the ledger: select the commit"],
  ["V", "in the ledger: select a range"],
  ["/", "filter the ledger: words, disposition:, dir:, file:, author:"],
  [
    "d",
    "in the ledger: goes to its head workspace and shows the commit's diff in its Changes; with two versions picked in its history (Enter): the two compared there",
  ],
  [
    "c",
    "comment on the words selected, else on what the cursor is on (a card of the Board, a commit, a plan, a count, a directory, a feeder, a part of What changed): the thread goes to the leader session, which answers in it; held while none runs",
  ],
  ["C", "comment on the tab"],
  ["n", "the next thread"],
  ["N", "the previous thread"],
  ["gn", "the next open thread, on any tab"],
  ["gN", "the previous open thread, on any tab"],
  ["r", "on a thread: resolve or reopen it"],
  ["R", "on a thread: reply"],
  ["dd", "on a thread: delete your lone comment"],
  ["za", "on a thread: fold it"],
  ["gl", "its leader: the Claude session of its head workspace"],
  ["u", "undo the last change"],
  [
    ":",
    "a command: mark not-upstream REASON, supersede REF, plan NAME, confirm [N], reject [N|all], accept NAME, split NEW (the selected commits out of their plan), part [NAME], drop NAME, seen, unsort, refresh, delete (the effort, after a confirmation, with Undo)",
  ],
  [":seen", "mark what changed as seen"],
  [":refresh", "read the effort again"],
  ["?", "this list", false],
  ["Esc", "clear the selection, then back to the requests"],
];

/**
 * The board view's keys, the same in both of its modes (the reviews
 * inbox, the Work board): the walk, the columns, the switch between them.
 */
export const BOARD_KEYS: readonly ShortcutRow[] = [
  ["[ ]", "the other mode of the view: Work, or Reviews", "]"],
];

/**
 * The Work board's keys, for its help (?) and the shortcut cheat sheet:
 * the view's, then its own.
 */
export const WORK_KEYS: readonly ShortcutRow[] = [
  [
    "j ↓",
    "next item (a count repeats: 3j); in an item's detail, the next part of its description or comments",
    "j",
  ],
  ["k ↑", "previous item; in an item's detail, the previous part", "k"],
  ["gg Home", "first", "gg"],
  ["G End", "last", "G"],
  ["zz", "show the selected item (in a detail, the part) in the middle"],
  ["zt", "show the selected item (in a detail, the part) at the top"],
  ["zb", "show the selected item (in a detail, the part) at the bottom"],
  [
    "Ctrl+D Ctrl+U",
    "in an item's detail: half a page down / up, the cursor with it",
    "Ctrl-d",
  ],
  [
    "Ctrl+F Ctrl+B",
    "in an item's detail: a page down / up, the cursor with it",
    "Ctrl-f",
  ],
  [
    "{ }",
    "in an item's detail: the previous / next heading of its description (a design doc's)",
    "}",
  ],
  ["h", "on a wide pane (columns): the column on the left"],
  ["l Tab", "on a wide pane (columns): the column on the right", "l"],
  [
    "Enter i",
    "open the item: its description, state, tags, owner, links, its thread",
    "Enter",
  ],
  [
    "c",
    "comment on the item, for its owner session (r in its detail: reply to the last thread)",
  ],
  ["s", "its state"],
  ["t", "its tags"],
  ["o", "the owner's work: its session's pane, its subagent's task"],
  ["dd", "done"],
  [
    "a :add :new-item",
    "add an item: a title, a description with images, its state and tags (from the list or an item's detail; :add WORDS starts it with them)",
    "a",
  ],
  ["za", "fold or unfold the column"],
  [
    "zf",
    "on a wide pane: the column alone, full width (h l the next one, zf or Esc every column again)",
  ],
  ["f", "every tag, to filter by several"],
  ["/", "search the items: words, tags, owner"],
  ["r", "read the board again"],
  ...BOARD_KEYS,
  ["?", "this list", false],
  [
    "Esc",
    "close the filters, the detail, clear the search or the selection, then hide the view",
  ],
];

/**
 * The reviews panel's keys, for its help (?) and the shortcut cheat sheet:
 * alone, so the cheat sheet does not load the panel's code.
 */
export const MR_REVIEWS_KEYS: readonly ShortcutRow[] = [
  ["j ↓", "next request (a count repeats: 3j)", "j"],
  ["k ↑", "previous request", "k"],
  ["gg Home", "first", "gg"],
  ["G End", "last", "G"],
  ["zz", "show the selected request in the middle"],
  ["zt", "show the selected request at the top"],
  ["zb", "show the selected request at the bottom"],
  [
    "Enter",
    "its review in its home (its workspace: on its branch, named after it, or made for it); with none, in the project's review workspace",
  ],
  ["i", "its details"],
  ["c", "its Claude session"],
  ["o", "open it on GitLab or GitHub"],
  ["w", "go to its workspace (2w: the second)"],
  ["P :pin :unpin", "pin it on top, or unpin it", "P"],
  [
    "e",
    "set by hand: who it is on, next step, what it waits for, labels, link",
  ],
  ["E :clear", "clear what was set by hand (:clear FIELD: one of them)", "E"],
  ["za", "fold the requests after it, or its lane"],
  ["gx", "open its link (a URL, or a file in its workspace)"],
  [
    "gH :home",
    "start a review with a home: a workspace of its own on its head, with a Claude session told its job",
    "gH",
  ],
  ["h", "on a wide pane (columns): the lane on the left"],
  ["l Tab", "on a wide pane (columns): the lane on the right", "l"],
  [
    "f",
    "next of all, to review, mine and your saved views (:view NAME: one of them)",
  ],
  ["F", "previous of all, to review, mine and your saved views"],
  [":all", "all the requests"],
  [":review", "the requests to review"],
  [":mine", "your own requests"],
  ["J Alt+Down", "move it down in your order (3J)", "J"],
  ["K Alt+Up", "move it up in your order", "K"],
  [
    "/",
    "search: words and project:, label:, lane:, waiting:, state:, author:, pipeline:, is: (-key: negates; Tab completes)",
  ],
  [
    ":",
    "a command: note TEXT, whose me|reviewer|external|NAME, after REF, label X, unlabel X, link URL, stale, clear [FIELD], save NAME (the search as a view), view NAME, delview NAME, infer, pin, unpin, add URL (or pin URL: adds a request), all, review, mine, refresh",
  ],
  [":infer", "who it is on and its next step, read again now"],
  [
    "p",
    "add a request: a prompt to paste its URL in (Enter adds, Esc closes); a URL pasted in the search, or pasted or dropped in the panel, adds it too",
  ],
  ["dd Delete", "remove it from the view (a pinned one is unpinned)", "dd"],
  ["u", "undo the last removal"],
  ["H", "the hidden requests, to restore"],
  ["x", "not interested (a suggestion), else remove it as dd"],
  ["+", "more like this (a suggestion)"],
  ["r :refresh", "refresh", "r"],
  ["a", "ask the reviews agent"],
  [
    "Enter w dd u (local)",
    "on a Local review (Option+Shift+R, :reviews): Enter shows it in its workspace's Changes, w goes to its workspace, dd (x, Delete) discards it, u brings it back",
    false,
  ],
  ...BOARD_KEYS,
  [
    "P L R F W",
    "in an effort: Progress, Ledger, Plans (planned requests), Feeders, What changed",
  ],
  [
    "d",
    "in an effort's ledger: goes to its head workspace and shows the commit's diff in its Changes; with two versions picked in its history (Enter): the two compared there",
    false,
  ],
  [
    "c (effort)",
    "in an effort: comment on the words selected or on what the cursor is on, for its leader session (C: on the tab; n N, gn gN: its threads; gl: the leader session; ?: all its keys)",
  ],
  [
    ": (effort)",
    "mark not-upstream REASON, supersede REF, plan NAME, confirm [N], reject [N|all], accept NAME, split NEW (the selected commits out of their plan), part [NAME], drop NAME, seen, unsort, delete (the effort, after a confirmation, with Undo)",
  ],
  ["?", "this list", false],
  ["Esc", "clear the search, then hide the panel"],
];
