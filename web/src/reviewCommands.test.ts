import { expect, test } from "bun:test";
import {
  findInspectorCommand,
  inspectorCompletions,
  runInspectorCommand,
} from "./inspectorCommands";
import {
  notAReviewCommand,
  REVIEW_COMMAND_ALIASES,
  reviewInspectorCommands,
} from "./reviewCommands";
import {
  commandCompletions,
  parseReviewCommand,
  REVIEW_COMMANDS,
  type ReviewCommand,
} from "./reviewNavigation";

/**
 * Every word of parseReviewCommand (plan, section 4), with an argument,
 * and what it runs: pinned, so a new command table keeps every alias.
 */
const WORDS: [string, ReviewCommand][] = [
  ["q", { type: "close" }],
  ["q!", { type: "close" }],
  ["quit", { type: "close" }],
  ["close", { type: "close" }],
  ["wq", { type: "close" }],
  ["x", { type: "close" }],
  ["xit", { type: "close" }],
  ["w", { type: "save" }],
  ["write", { type: "save" }],
  ["s", { type: "split" }],
  ["split", { type: "split" }],
  ["diff", { type: "split" }],
  ["unified", { type: "split" }],
  ["files", { type: "files" }],
  ["only", { type: "diffOnly" }],
  ["o", { type: "diffOnly" }],
  ["diffonly", { type: "diffOnly" }],
  ["comments", { type: "comments" }],
  ["hidecomments", { type: "comments" }],
  ["ask", { type: "ask" }],
  ["chat", { type: "ask" }],
  ["discuss", { type: "ask" }],
  ["review", { type: "review", focus: null }],
  ["review the parser", { type: "review", focus: "the parser" }],
  ["send", { type: "send" }],
  ["handoff", { type: "send" }],
  ["hold", { type: "hold" }],
  ["overall", { type: "overall" }],
  ["summary", { type: "overall" }],
  ["conversations", { type: "threads" }],
  ["threads", { type: "threads" }],
  ["conv", { type: "threads" }],
  ["unresolved", { type: "unresolved" }],
  ["openonly", { type: "unresolved" }],
  ["unreviewed", { type: "unreviewed" }],
  ["suggest", { type: "suggest" }],
  ["open", { type: "open" }],
  ["gitlab", { type: "open" }],
  ["mr", { type: "open" }],
  ["switch", { type: "switchMode" }],
  ["commit", { type: "commit", index: null }],
  ["commit 2", { type: "commit", index: 1 }],
  ["commit fix the parser", { type: "commits", query: "fix the parser" }],
  ["commits", { type: "commits", query: "" }],
  ["commits parser", { type: "commits", query: "parser" }],
  ["all", { type: "commit", index: null }],
  ["e", { type: "reload" }],
  ["edit", { type: "reload" }],
  ["reload", { type: "reload" }],
  ["reviews", { type: "reviews" }],
  ["vim", { type: "vim" }],
  ["novim", { type: "vim", on: false }],
  ["set vim", { type: "vim", on: true }],
  ["set novim", { type: "vim", on: false }],
];

function ran(input: string): ReviewCommand[] {
  const commands: ReviewCommand[] = [];
  const problem = runInspectorCommand(
    reviewInspectorCommands((command) => commands.push(command)),
    input,
    (line) => commands.push({ type: "line", line }),
    notAReviewCommand,
  );
  if (problem) commands.push({ type: "unknown", text: problem });
  return commands;
}

test("every word of the review's commands runs through the registry what parseReviewCommand reads", () => {
  for (const [word, command] of WORDS) {
    expect(parseReviewCommand(word)).toEqual(command);
    expect(ran(`:${word}`)).toEqual([command]);
  }
  // :N is the prompt's, given to the view's lines.
  expect(ran(":12")).toEqual([{ type: "line", line: 12 }]);
});

test("Tab offers the review's commands as before, aliases never", () => {
  const commands = reviewInspectorCommands(() => {});
  for (const [name] of REVIEW_COMMANDS)
    for (let end = 0; end <= name.length; end++) {
      const typed = name.slice(0, end);
      expect(inspectorCompletions(commands, typed)).toEqual(
        commandCompletions(typed),
      );
    }
  expect(inspectorCompletions(commands, "nov")).toEqual([]);
  expect(inspectorCompletions(commands, "se")).toEqual([
    ["send", "send the held comments to the agent"],
  ]);
  // Every alias names a listed command, and is found exactly.
  for (const [name, aliases] of Object.entries(REVIEW_COMMAND_ALIASES)) {
    expect(REVIEW_COMMANDS.some(([listed]) => listed === name)).toBe(true);
    for (const alias of aliases)
      expect(findInspectorCommand(commands, alias)?.command.name).toBe(name);
  }
});

test(":s is side by side, never :stage or :scope; unknown words and :set options say so", () => {
  expect(ran(":s")).toEqual([{ type: "split" }]);
  expect(ran(":frob now")).toEqual([
    { type: "unknown", text: notAReviewCommand("frob now") },
  ]);
  expect(ran(":set number")).toEqual([
    { type: "unknown", text: notAReviewCommand("set number") },
  ]);
  expect(ran(":set")).toEqual([
    { type: "unknown", text: notAReviewCommand("set") },
  ]);
  expect(ran(":set reviewin=elsewhere")).toEqual([
    { type: "unknown", text: notAReviewCommand("set reviewin=elsewhere") },
  ]);
  expect(ran(":help")).toEqual([
    { type: "unknown", text: notAReviewCommand("help") },
  ]);
  // The retired switch (`reviewin`) is no setting now.
  expect(ran(":set reviewin=changes")).toEqual([
    { type: "unknown", text: notAReviewCommand("set reviewin=changes") },
  ]);
});
