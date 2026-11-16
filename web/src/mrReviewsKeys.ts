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
  ["f", "show all, to review, or mine (:all, :review, :mine)"],
  ["J K / Alt+Down Alt+Up", "move it down / up in your order (3J)"],
  ["/", "search: title, project, author, number, branch"],
  [":", "a command: pin, unpin, all, review, mine, refresh"],
  ["p", "add a request: paste its URL (also paste or drop one in the panel)"],
  ["dd / Delete", "remove it from the view (a pinned one is unpinned)"],
  ["u", "undo the last removal"],
  ["H", "the hidden requests, to restore"],
  ["x", "not interested (a suggestion), else remove it as dd"],
  ["+", "more like this (a suggestion)"],
  ["r", "refresh"],
  ["a", "ask the reviews agent"],
  ["?", "this list"],
  ["Esc", "close the list, clear the search, then hide the panel"],
];
