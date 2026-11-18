import { expect, test } from "bun:test";
import {
  findInspectorCommand,
  inspectorCompletions,
  runInspectorCommand,
} from "./inspectorCommands";
import {
  notAReviewCommand,
  type ReviewActions,
  reviewCommands,
} from "./reviewCommands";

/**
 * Every word of the review's `:` commands, with an argument, and what it
 * runs: pinned, so the table keeps every alias. Without views of its
 * commits (one commit), the review answers `:commit`, `:commits`, `:all`
 * and `:e` itself; with them, those words are the views'.
 */
const WORDS: [string, keyof ReviewActions, string?][] = [
  ["q", "close"],
  ["q!", "close"],
  ["quit", "close"],
  ["close", "close"],
  ["wq", "close"],
  ["x", "close"],
  ["xit", "close"],
  ["w", "save"],
  ["write", "save"],
  ["s", "split"],
  ["split", "split"],
  ["diff", "split"],
  ["unified", "split"],
  ["comments", "comments"],
  ["hidecomments", "comments"],
  ["ask", "ask"],
  ["chat", "ask"],
  ["discuss", "ask"],
  ["review", "review"],
  ["review the parser", "review", "the parser"],
  ["send", "send"],
  ["handoff", "send"],
  ["hold", "hold"],
  ["overall", "overall"],
  ["summary", "overall"],
  ["conversations", "threads"],
  ["threads", "threads"],
  ["conv", "threads"],
  ["unresolved", "unresolved"],
  ["openonly", "unresolved"],
  ["unreviewed", "unreviewed"],
  ["suggest", "suggest"],
  ["open", "open"],
  ["gitlab", "open"],
  ["mr", "open"],
  ["switch", "switchMode"],
  ["reviews", "reviews"],
  ["commit", "single"],
  ["commit 2", "single", "2"],
  ["commits parser", "single", "parser"],
  ["all", "single"],
  ["e", "reload"],
  ["edit", "reload"],
  ["reload", "reload"],
];

const VIEW_WORDS = ["commit", "commits", "all", "e", "edit", "reload"];

function ran(input: string, ownViews = false): string[] {
  const done: string[] = [];
  const act = new Proxy({} as ReviewActions, {
    get: (_, action: string) => (argument: string) =>
      done.push(argument ? `${action} ${argument}` : action),
  });
  const problem = runInspectorCommand(
    reviewCommands(act, ownViews),
    input,
    (line) => done.push(`line ${line}`),
    notAReviewCommand,
  );
  if (problem) done.push(problem);
  return done;
}

test("every word of the review's commands runs what it means", () => {
  for (const [word, action, argument] of WORDS)
    expect(ran(`:${word}`)).toEqual([
      argument ? `${action} ${argument}` : action,
    ]);
  // :N is the prompt's, given to the view's lines.
  expect(ran(":12")).toEqual(["line 12"]);
});

test("with views of its commits, :commit, :commits, :all and :e are theirs", () => {
  const commands = reviewCommands({} as ReviewActions, true);
  for (const word of VIEW_WORDS)
    expect(findInspectorCommand(commands, word)).toBeNull();
  expect(ran(":q", true)).toEqual(["close"]);
});

test("Tab offers the listed names in order, aliases never", () => {
  const commands = reviewCommands({} as ReviewActions, false);
  expect(inspectorCompletions(commands, "").map(([name]) => name)).toEqual([
    "q",
    "w",
    "wq",
    "x",
    "diff",
    "comments",
    "ask",
    "review",
    "send",
    "hold",
    "overall",
    "drafts",
    "conversations",
    "threads",
    "unresolved",
    "unreviewed",
    "suggest",
    "open",
    "gitlab",
    "switch",
    "commit",
    "commits",
    "all",
    "reviews",
    "e",
  ]);
  expect(inspectorCompletions(commands, "commi").map(([name]) => name)).toEqual(
    ["commit", "commits"],
  );
  expect(inspectorCompletions(commands, "se")).toEqual([
    ["send", "send the held comments to the agent"],
  ]);
  expect(inspectorCompletions(commands, "conv")).toEqual([
    ["conversations", "every conversation of the review, resolved too (T)"],
  ]);
});

test(":s is side by side, never :stage or :scope; unknown words and the frame's say so here", () => {
  expect(ran(":s")).toEqual(["split"]);
  for (const words of [
    "frob now",
    "set number",
    "set",
    "set reviewin=elsewhere",
    "help",
    "files",
    "vim",
  ])
    expect(ran(`:${words}`)).toEqual([notAReviewCommand(words)]);
});
