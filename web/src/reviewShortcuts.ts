import type { ShortcutRow } from "./components/ShortcutHelp";
import { detectShortcutPlatform, formatShortcut } from "./shortcutBindings";

/*
 * The review's shortcut list (`?`) in Changes, the rows FEATURES.md
 * documents.
 */

/** The file reviewed, or no longer: Option+V on a Mac, Alt+V elsewhere. */
const MARK_FILE_KEY = formatShortcut("Alt+V", detectShortcutPlatform());

/**
 * The review in Changes: the review's rows, then what only Changes has
 * (the checkout's git, its scopes, the inspector's views and dock).
 */
export const CHANGES_REVIEW_KEYS: readonly ShortcutRow[] = [
  ["j ↓", "next line or message under it (5j); side by side, on one side", "j"],
  [
    "k ↑",
    "previous line or message under it (5k); side by side, on one side",
    "k",
  ],
  ["J", "10 lines down"],
  ["K", "10 lines up"],
  ["gg", "first line"],
  ["G", "last line (12G: line 12)"],
  ["Ctrl-d", "half a page down"],
  ["Ctrl-u", "half a page up"],
  ["Ctrl-f", "a page down (also Ctrl-j, PageDown)"],
  ["Ctrl-b", "a page up (also Ctrl-k, PageUp)"],
  ["H", "top of the screen"],
  ["M", "middle of the screen"],
  ["L", "bottom of the screen"],
  ["zz", "current line to the middle"],
  ["zt", "current line to the top"],
  ["zb", "current line to the bottom"],
  ["{", "previous hunk"],
  ["}", "next hunk"],
  ["[", "previous file"],
  ["]", "next file"],
  ["w", "next word"],
  ["b", "previous word"],
  ["E", "end of word"],
  ["h", "one character left"],
  ["l", "one character right"],
  ["0", "start of the line"],
  ["^", "first character of the line"],
  ["$", "end of the line"],
  ["←", "as h; side by side, past a line's start: the line beside it"],
  ["→", "as l; side by side, past a line's end: the line beside it"],
  ["/", "search the diff (smart case); n / N next / previous match, Esc ends"],
  ["*", "search the word under the cursor, forward"],
  ["#", "search the word under the cursor, backward"],
  ["c Enter i a", "comment on the line", "c"],
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
    "resolve or reopen the thread on the line; elsewhere mark the chunk (hunk) reviewed: it folds to one line, the cursor goes on to the next chunk not reviewed, r again unmarks; after V, the chunks selected",
  ],
  [
    `${MARK_FILE_KEY} v`,
    `mark the file reviewed, every chunk of it (it folds; ${MARK_FILE_KEY} again unmarks it and its chunks)`,
    "v",
  ],
  ["gu :unreviewed", "next chunk not reviewed, in any file (wrapping)", "gu"],
  ["gU", "previous chunk not reviewed, in any file (wrapping)"],
  [
    "za",
    "fold / unfold a thread, resolved or not (resolved ones start folded); on a reviewed chunk, show it or fold it again",
  ],
  [
    "gn",
    "next unresolved thread, in any file, commit or fold (wrapping); also the arrows beside the comments chip",
  ],
  ["gN", "previous unresolved thread, in any file, commit or fold (wrapping)"],
  [
    "gH :unresolved",
    "show only the unresolved threads (n / N skip the resolved ones; r goes on to the next), or all again; remembered",
    "gH",
  ],
  ["gl", "the last message of the thread selected, or on the line"],
  ["g;", "the comment written last, in any view"],
  ["u", "undo that delete"],
  ["n", "next message, one by one through threads (or search match)"],
  ["N", "previous message, one by one through threads (or search match)"],
  ["Tab", "next message, even during a search"],
  ["Shift+Tab", "previous message, even during a search"],
  [
    "Esc Esc / :w",
    "in a comment (Vim): save it; :q drops the edit, Cmd+Enter saves",
    false,
  ],
  ["zo x", "20 more lines around the hunk", "zo"],
  ["zO X", "all hidden lines around the hunk", "zO"],
  ["zR", "the whole file"],
  ["R gr :e", "reload the diff", "R"],
  ["S :diff", "side by side / unified", "S"],
  ["f :files", "show / hide the file list", "f"],
  ["o :only", "diff only: hide all the chrome (o or Esc brings it back)", "o"],
  ["t :comments", "show / hide every comment (margin markers stay)", "t"],
  [
    "T :conversations",
    "every conversation, in any commit, open ones first; there j / k move, Enter goes, Space folds, r resolves (the list stays put), H shows / hides the resolved ones, R answers, / searches",
    "T",
  ],
  [
    "C :ask",
    "ask the agent about the line (or the selected lines), as a discussion",
    "C",
  ],
  [
    "V",
    "select lines (j / k extend, Shift+click too); then C asks the agent, r marks their chunks reviewed, Esc cancels",
  ],
  [":review [focus]", "the agent reviews line by line", ":review"],
  [":hold", "hold your comments until :send, or send each as written"],
  [":send", "send the held comments (or the open discussions) to the agent"],
  [":overall", "write the overall comment on the review"],
  [":vim", "Vim keys in comments on / off"],
  ["O :open", "open the merge request on GitLab", "O"],
  [
    "gm :switch",
    "local review / review on GitLab: the branch's merge request (its discussions, your comments as draft notes) and back",
    "gm",
  ],
  [":40", "go to line 40", false],
  [
    "> :commit",
    "next commit (wrapping to all changes); :commit 2: the second",
    ">",
  ],
  ["<", "previous commit (wrapping to all changes)"],
  [":all", "all changes again"],
  [
    "gc :commits",
    "pick a commit by its subject or sha; :commit words goes to the one matching",
    "gc",
  ],
  [")", "next repository of the workspace"],
  ["(", "previous repository of the workspace"],
  ["p", "search the workspace's repositories and open one"],
  [":", "command line; Tab / Shift+Tab complete"],
  ["?", "this list", false],
  ["Esc :q", "close the review (it is kept)", "Esc"],
  ["Ctrl-e", "a line down"],
  ["Ctrl-y", "a line up"],
  [
    "gs :stage",
    "stage the file at the cursor, or the files V selected (:unstage, :discard, :delete)",
    "gs",
  ],
  [":working", "the working tree"],
  [":branch", "the branch against its base"],
  [":last", "the agent's last step"],
  ["gt :view", "next view of the inspector (:view NAME)", "gt"],
  ["gT", "previous view of the inspector"],
  [":dock", "dock the inspector at right or bottom"],
  [":expand", "expand the inspector"],
  [":help", "this list, filtered by the words after it", false],
];
