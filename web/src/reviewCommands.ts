import type { InspectorCommand } from "./inspectorCommands";

/*
 * The review's `:` commands in Changes, one table: each listed name with
 * the other words run as it, what Tab says of it and what it does. The
 * frame's words (`:files`, `:only`, `:vim`, `:set`) are the inspector's;
 * a commit bar's `:commit`, `:commits`, `:all` and `:e` are the views'.
 */

/** What the review does for its words; `argument`: the words after it. */
export type ReviewActions = Record<
  | "close"
  | "save"
  | "split"
  | "comments"
  | "ask"
  | "review"
  | "send"
  | "hold"
  | "overall"
  | "threads"
  | "unresolved"
  | "unreviewed"
  | "suggest"
  | "open"
  | "switchMode"
  | "reviews"
  /** `:commit`, `:commits`, `:all` without views of their own. */
  | "single"
  /** `:e` without views of their own. */
  | "reload",
  (argument: string) => void
>;

/** [name, what Tab says, what it does, the other words run as it]. */
const TABLE: [string, string, keyof ReviewActions, ...string[]][] = [
  ["q", "close the review", "close", "q!", "quit", "close"],
  ["w", "save the review", "save", "write"],
  ["wq", "save and close", "close"],
  ["x", "save and close", "close", "xit"],
  ["diff", "side by side / unified", "split", "s", "split", "unified"],
  ["comments", "show / hide all comments", "comments", "hidecomments"],
  ["ask", "ask the agent about this line", "ask", "chat", "discuss"],
  ["review", "agent review (:review focus)", "review"],
  ["send", "send the held comments to the agent", "send", "handoff"],
  ["hold", "hold comments until :send / send as written", "hold"],
  ["overall", "write the overall comment on the review", "overall", "summary"],
  [
    "conversations",
    "every conversation of the review, resolved too (T)",
    "threads",
    "conv",
  ],
  ["threads", "every conversation of the review, resolved too (T)", "threads"],
  [
    "unresolved",
    "show only the unresolved threads, or all again (gH)",
    "unresolved",
    "openonly",
  ],
  ["unreviewed", "the next chunk not reviewed (gu)", "unreviewed"],
  ["suggest", "suggest a change on this line", "suggest"],
  ["open", "open the MR on GitLab", "open", "mr"],
  ["gitlab", "open the MR on GitLab", "open"],
  ["switch", "local review / review on GitLab (the branch's MR)", "switchMode"],
  [
    "commit",
    "review one commit: :commit 2, :commit words of its subject; alone for all",
    "single",
  ],
  ["commits", "pick a commit by its subject (gc)", "single"],
  ["all", "all changes again", "single"],
  ["reviews", "the reviews in progress", "reviews"],
  ["e", "reload the diff (gr)", "reload", "edit", "reload"],
];

/** The views' words: theirs when the review has views of its commits. */
const VIEW_WORDS = new Set(["commit", "commits", "all", "e"]);

/**
 * The review's commands for the prompt. `:N` is not among them: the
 * prompt gives it to the view's lines.
 */
export function reviewCommands(
  act: ReviewActions,
  ownViews: boolean,
): InspectorCommand[] {
  return TABLE.filter(([name]) => !ownViews || !VIEW_WORDS.has(name)).map(
    ([name, description, action, ...aliases]) => ({
      name,
      description,
      ...(aliases.length ? { aliases } : {}),
      run: (argument) => act[action](argument),
    }),
  );
}

/** The review's message for a word that is none of its commands. */
export function notAReviewCommand(text: string): string {
  return `Not a review command: :${text} (try :q, :w, :diff, :files)`;
}
