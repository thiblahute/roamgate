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
    ": (effort)",
    "mark not-upstream REASON, supersede REF, plan NAME, confirm [N], reject [N|all], accept NAME, split NEW (the selected commits out of their plan), part [NAME], drop NAME, seen, unsort, delete (the effort, after a confirmation, with Undo)",
  ],
  ["?", "this list"],
  ["Esc", "close the list, clear the search, then hide the panel"],
];
