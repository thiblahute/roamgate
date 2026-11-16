import type { InspectorCommand } from "./inspectorCommands";
import {
  parseReviewCommand,
  REVIEW_COMMANDS,
  type ReviewCommand,
} from "./reviewNavigation";

/*
 * The review's `:` commands as the inspector's registry has them
 * (inspectorCommands.ts): one entry per name Tab offers (REVIEW_COMMANDS,
 * in its order), with the other words of parseReviewCommand as its
 * aliases, and the words Tab never offers (`:novim`, `:set ...`) as
 * entries of their own. Each runs what parseReviewCommand reads.
 */

/** Words run but not offered, by the listed name they mean the same as. */
export const REVIEW_COMMAND_ALIASES: Readonly<
  Record<string, readonly string[]>
> = {
  q: ["q!", "quit", "close"],
  w: ["write"],
  x: ["xit"],
  diff: ["s", "split", "unified"],
  only: ["diffonly", "o"],
  comments: ["hidecomments"],
  ask: ["chat", "discuss"],
  send: ["handoff"],
  overall: ["summary"],
  conversations: ["conv"],
  unresolved: ["openonly"],
  open: ["mr"],
  e: ["edit", "reload"],
};

/**
 * The review's words that are its frame's in Changes: the inspector's
 * prompt runs them (the tree, Review only, the preferences).
 */
export const REVIEW_FRAME_COMMANDS: readonly string[] = [
  "files",
  "only",
  "vim",
  "novim",
  "set",
];

/** Words with a meaning of their own that Tab does not offer. */
export const REVIEW_UNLISTED_COMMANDS: readonly string[] = ["novim", "set"];

/**
 * The review's commands for the prompt, each handing what it means to
 * `run`. `:N` is not among them: the prompt gives it to the view's lines.
 */
export function reviewInspectorCommands(
  run: (command: ReviewCommand) => void,
): InspectorCommand[] {
  const entry = (
    name: string,
    description: string,
    listed: boolean,
  ): InspectorCommand => ({
    name,
    description,
    ...(REVIEW_COMMAND_ALIASES[name]
      ? { aliases: REVIEW_COMMAND_ALIASES[name] }
      : {}),
    ...(listed ? {} : { listed: false }),
    run: (argument, how) => {
      const command = parseReviewCommand(
        argument ? `${name} ${argument}` : name,
      );
      if (command.type === "unknown") how.unknown();
      else run(command);
    },
  });
  return [
    ...REVIEW_COMMANDS.map(([name, description]) =>
      entry(name, description, true),
    ),
    entry("novim", "Vim keys in comments off", false),
    entry("set", "set vim, novim", false),
  ];
}

/** The review's message for a word that is none of its commands. */
export function notAReviewCommand(text: string): string {
  return `Not a review command: :${text} (try :q, :w, :diff, :files)`;
}
