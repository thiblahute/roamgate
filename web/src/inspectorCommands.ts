/*
 * The inspector's `:` commands: each view lists the ones it has (name,
 * aliases, what it does, how it runs) and the one prompt completes and runs
 * them. Pure, as reviewNavigation's REVIEW_COMMANDS and parseReviewCommand,
 * which the review pane still keeps as they are.
 */

export type InspectorCommand = {
  name: string;
  /** Other words for it, run but not completed. */
  aliases?: readonly string[];
  /** What it does, shown beside the completion. */
  description: string;
  /** `argument`: the words typed after the name, trimmed. */
  run: (argument: string) => void;
};

/** The commands Tab completes for what is typed, as [name, description]. */
export function inspectorCompletions(
  commands: readonly InspectorCommand[],
  typed: string,
): [string, string][] {
  const word = typed.trim();
  return commands
    .filter((command) => command.name.startsWith(word))
    .map((command) => [command.name, command.description]);
}

/** The command `input` names (with or without its `:`), and its argument. */
export function findInspectorCommand(
  commands: readonly InspectorCommand[],
  input: string,
): { command: InspectorCommand; argument: string } | null {
  const text = input.trim().replace(/^:/, "").trim();
  const [word = "", ...rest] = text.split(/\s+/);
  if (!word) return null;
  const command = commands.find(
    (entry) => entry.name === word || entry.aliases?.includes(word),
  );
  return command ? { command, argument: rest.join(" ") } : null;
}

/**
 * Runs `input`: a command of `commands`, or `:N` given to `line` when the
 * view has lines. Returns what to tell when it is none of them, else null.
 */
export function runInspectorCommand(
  commands: readonly InspectorCommand[],
  input: string,
  line?: (line: number) => void,
): string | null {
  const text = input.trim().replace(/^:/, "").trim();
  if (!text) return null;
  if (line && /^\d+$/.test(text)) {
    line(Number(text));
    return null;
  }
  const found = findInspectorCommand(commands, text);
  if (found) {
    found.command.run(found.argument);
    return null;
  }
  const some = commands
    .slice(0, 4)
    .map((command) => `:${command.name}`)
    .join(", ");
  return `Not a command here: :${text}${some ? ` (try ${some})` : ""}`;
}

/**
 * Whether `:` pressed on `target` opens the prompt: not while typing, in a
 * field, a comment box or any editable text, where `:` is text.
 */
export function opensCommandLine(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}): boolean {
  if (event.key !== ":" || event.ctrlKey || event.metaKey) return false;
  const target = event.target as {
    isContentEditable?: boolean;
    tagName?: unknown;
  } | null;
  if (!target || typeof target.tagName !== "string") return true;
  return !(
    target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
}
