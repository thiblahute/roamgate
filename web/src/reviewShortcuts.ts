import type { ShortcutRow } from "./components/ShortcutList";
import { detectShortcutPlatform, formatShortcut } from "./shortcutBindings";

/*
 * The review's shortcut list (`?`) in Changes, the rows FEATURES.md
 * documents.
 */

/** The file reviewed, or no longer: Option+V on a Mac, Alt+V elsewhere. */
const MARK_FILE_KEY = formatShortcut("Alt+V", detectShortcutPlatform());

export const REVIEW_KEYS: readonly ShortcutRow[] = [
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
    "resolve or reopen the thread on the line; elsewhere mark the chunk (hunk) reviewed: it folds to one line, the cursor goes on to the next chunk not reviewed, r again unmarks; after V, the chunks selected",
  ],
  [
    `${MARK_FILE_KEY} v`,
    `mark the file reviewed, every chunk of it (it folds; ${MARK_FILE_KEY} again unmarks it and its chunks)`,
  ],
  [
    "gu gU :unreviewed",
    "next / previous chunk not reviewed, in any file (wrapping)",
  ],
  [
    "za",
    "fold / unfold a thread, resolved or not (resolved ones start folded); on a reviewed chunk, show it or fold it again",
  ],
  [
    "gn gN",
    "next / previous unresolved thread, in any file, commit or fold (wrapping); also the arrows beside the comments chip",
  ],
  [
    "gH :unresolved",
    "show only the unresolved threads (n / N skip the resolved ones; r goes on to the next), or all again; remembered",
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
  ["R gr :e", "reload the diff"],
  ["S :diff", "side by side / unified"],
  ["f :files", "show / hide the file list"],
  ["o :only", "diff only: hide all the chrome (o or Esc brings it back)"],
  ["t :comments", "show / hide every comment (margin markers stay)"],
  [
    "T :conversations",
    "every conversation, in any commit, open ones first; there j / k move, Enter goes, Space folds, r resolves (the list stays put), H shows / hides the resolved ones, R answers, / searches",
  ],
  [
    "C :ask",
    "ask the agent about the line (or the selected lines), as a discussion",
  ],
  [
    "V",
    "select lines (j / k extend, Shift+click too); then C asks the agent, r marks their chunks reviewed, Esc cancels",
  ],
  [":review [focus]", "the agent reviews line by line"],
  [":hold", "hold your comments until :send, or send each as written"],
  [":send", "send the held comments (or the open discussions) to the agent"],
  [":overall", "write the overall comment on the review"],
  [":vim", "Vim keys in comments on / off"],
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
  [":all", "all changes again"],
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

/**
 * The review in Changes: the review's rows, then what only Changes has
 * (the checkout's git, its scopes, the inspector's views and dock).
 */
export const CHANGES_REVIEW_KEYS: readonly ShortcutRow[] = [
  ...REVIEW_KEYS,
  ["Ctrl-e Ctrl-y", "a line down / up"],
  [
    "gs :stage",
    "stage the file at the cursor, or the files V selected (:unstage, :discard, :delete)",
  ],
  [
    ":working :branch :last",
    "the working tree, the branch against its base, the agent's last step",
  ],
  ["gt gT :view", "next / previous view of the inspector (:view NAME)"],
  [":dock :expand", "dock the inspector at right or bottom; expand it"],
  [":help", "this list, filtered by the words after it"],
];
