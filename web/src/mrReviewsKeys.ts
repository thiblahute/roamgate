/**
 * An effort's view's keys, for its help (?): its tabs, its ledger and the
 * comments one leaves there for its leader session.
 */
export const EFFORT_KEYS: [string, string][] = [
  [
    "B P L R F W",
    "Board (a card per planned request, in the inbox's lanes), Progress, Ledger, Plans (planned requests), Feeders, What changed; the last one shown opens next time",
  ],
  [
    "j k h l",
    "on the Board: the next / previous card in its column (through every column on a phone), the column on the left / right",
  ],
  [
    "Enter o e w za",
    "on the Board: the card's review in its home (a part's workspace, a plan's place in Plans), its request on the forge, set its next step and whose move, its workspace, fold or unfold its column (Done starts folded)",
  ],
  [
    "j k / Down Up",
    "the next / previous commit in the ledger, the next / previous thing one comments on elsewhere (a click points at one too)",
  ],
  ["x V", "in the ledger: select the commit, select a range"],
  ["/", "filter the ledger: words, disposition:, dir:, file:, author:"],
  [
    "d",
    "in the ledger: goes to its head workspace and shows the commit's diff in its Changes; with two versions picked in its history (Enter): the two compared there",
  ],
  ["Enter", "in the ledger: the commit's versions"],
  [
    "c",
    "comment on the words selected, else on what the cursor is on (a card of the Board, a commit, a plan, a count, a directory, a feeder, a part of What changed): the thread goes to the leader session, which answers in it; held while none runs",
  ],
  ["C", "comment on the tab"],
  ["n N", "the next / previous thread"],
  ["gn gN", "the next / previous open thread, on any tab"],
  [
    "r R dd za",
    "on a thread: resolve or reopen it, reply, delete your lone comment, fold it",
  ],
  ["gl", "its leader: the Claude session of its head workspace"],
  ["u", "undo the last change"],
  [
    ":",
    "mark not-upstream REASON, supersede REF, plan NAME, confirm [N], reject [N|all], accept NAME, split NEW (the selected commits out of their plan), part [NAME], drop NAME, seen, unsort, refresh, delete (the effort, after a confirmation, with Undo)",
  ],
  ["?", "this list"],
  ["Esc", "close this list, clear the selection, then back to the requests"],
];

/**
 * The reviews panel's keys, for its help (?) and the shortcut cheat sheet:
 * alone, so the cheat sheet does not load the panel's code.
 */
export const MR_REVIEWS_KEYS: [string, string][] = [
  ["j k / Down Up", "next / previous request (a count repeats: 3j)"],
  ["gg G / Home End", "first / last"],
  [
    "zz zt zb",
    "show the selected request in the middle, at the top, at the bottom",
  ],
  [
    "Enter",
    "its review in its home (its workspace: on its branch, named after it, or made for it); with none, in the project's review workspace",
  ],
  ["i", "its details"],
  ["c", "its Claude session"],
  ["o", "open it on GitLab or GitHub"],
  ["w", "go to its workspace (2w: the second)"],
  ["P", "pin it on top, or unpin it (:pin, :unpin)"],
  ["e", "set by hand: whose move, next step, what it waits for, labels, link"],
  ["E", "clear what was set by hand (:clear [FIELD])"],
  ["za", "fold the requests after it, or its lane"],
  ["gx", "open its link (a URL, or a file in its workspace)"],
  [
    "gH",
    "start a review with a home: a workspace of its own on its head, with a Claude session told its job (:home)",
  ],
  ["h l / Tab", "on a wide pane (columns): the lane on the left / right"],
  [
    "f F",
    "next / previous of all, to review, mine and your saved views (:all, :review, :mine, :view NAME)",
  ],
  ["J K / Alt+Down Alt+Up", "move it down / up in your order (3J)"],
  [
    "/",
    "search: words and project:, label:, lane:, waiting:, state:, author:, pipeline:, is: (-key: negates; Tab completes)",
  ],
  [
    ":",
    "a command: note TEXT, whose me|reviewer|external|NAME, after REF, label X, unlabel X, link URL, stale, clear [FIELD], save NAME (the search as a view), view NAME, delview NAME, infer (whose move, read again now), pin, unpin, add URL (or pin URL: adds a request), all, review, mine, refresh",
  ],
  [
    "p",
    "add a request: a prompt to paste its URL in (Enter adds, Esc closes); a URL pasted in the search, or pasted or dropped in the panel, adds it too",
  ],
  ["dd / Delete", "remove it from the view (a pinned one is unpinned)"],
  ["u", "undo the last removal"],
  ["H", "the hidden requests, to restore"],
  ["x", "not interested (a suggestion), else remove it as dd"],
  ["+", "more like this (a suggestion)"],
  ["r", "refresh"],
  ["a", "ask the reviews agent"],
  [
    "P L R F W",
    "in an effort: Progress, Ledger, Plans (planned requests), Feeders, What changed",
  ],
  [
    "d",
    "in an effort's ledger: goes to its head workspace and shows the commit's diff in its Changes; with two versions picked in its history (Enter): the two compared there",
  ],
  [
    "c (effort)",
    "in an effort: comment on the words selected or on what the cursor is on, for its leader session (C: on the tab; n N, gn gN: its threads; gl: the leader session; ?: all its keys)",
  ],
  [
    ": (effort)",
    "mark not-upstream REASON, supersede REF, plan NAME, confirm [N], reject [N|all], accept NAME, split NEW (the selected commits out of their plan), part [NAME], drop NAME, seen, unsort, delete (the effort, after a confirmation, with Undo)",
  ],
  ["?", "this list"],
  ["Esc", "close the list, clear the search, then hide the panel"],
];
