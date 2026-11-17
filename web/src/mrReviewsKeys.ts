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
  ["Enter", "go to its workspace (as w); with none, review it"],
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
    "a command: note TEXT, whose me|reviewer|external|NAME, after REF, label X, unlabel X, link URL, stale, clear [FIELD], save NAME (the search as a view), view NAME, delview NAME, pin, unpin, all, review, mine, refresh",
  ],
  ["p", "add a request: paste its URL (also paste or drop one in the panel)"],
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
    "in an effort's ledger: the commit's diff in its head workspace; with two versions picked in its history (Enter): how they differ",
  ],
  [
    ": (effort)",
    "mark not-upstream REASON, supersede REF, plan NAME, confirm [N], reject [N|all], accept NAME, split NEW (the selected commits out of their plan), part [NAME], drop NAME, seen, unsort",
  ],
  ["?", "this list"],
  ["Esc", "close the list, clear the search, then hide the panel"],
];
