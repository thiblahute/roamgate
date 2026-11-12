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

/** Every word of parseReviewCommand (plan, section 4), with an argument. */
const WORDS = [
  "q",
  "q!",
  "quit",
  "close",
  "wq",
  "x",
  "xit",
  "w",
  "write",
  "s",
  "split",
  "diff",
  "unified",
  "files",
  "only",
  "o",
  "diffonly",
  "comments",
  "hidecomments",
  "ask",
  "chat",
  "discuss",
  "review",
  "review the parser",
  "send",
  "handoff",
  "hold",
  "overall",
  "summary",
  "conversations",
  "threads",
  "conv",
  "unresolved",
  "openonly",
  "unreviewed",
  "suggest",
  "open",
  "gitlab",
  "mr",
  "switch",
  "commit",
  "commit 2",
  "commit fix the parser",
  "commits",
  "commits parser",
  "all",
  "e",
  "edit",
  "reload",
  "reviews",
  "vim",
  "novim",
  "set vim",
  "set novim",
  "set reviewin=changes",
  "set reviewin=classic",
  "set reviewin",
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
  for (const word of WORDS) {
    const parsed = parseReviewCommand(word);
    expect(parsed.type).not.toBe("unknown");
    expect(ran(`:${word}`)).toEqual([parsed]);
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
  expect(ran(":set reviewin=changes")).toEqual([
    { type: "reviewIn", surface: "changes" },
  ]);
});
