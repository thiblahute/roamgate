/*
 * The `:` commands: each view lists the ones it has (name, aliases, what it
 * does, how it runs) and the one prompt completes and runs them. The
 * inspector's views and the classic review pane (reviewCommands.ts) give
 * theirs in this form. Pure: testable without a DOM.
 */

/** What a command can tell the prompt while it runs. */
export type InspectorCommandRun = {
  /** A message to show (a toast). */
  say: (message: string) => void;
  /**
   * What was typed is not a command after all (`:set` with an option it
   * does not know): the prompt says so as it does for an unknown name.
   */
  unknown: () => void;
};

export type InspectorCommand = {
  name: string;
  /** Other words for it, run but not completed. */
  aliases?: readonly string[];
  /** What it does, shown beside the completion. */
  description: string;
  /** `argument`: the words typed after the name, trimmed. */
  run: (argument: string, how: InspectorCommandRun) => void;
  /** The words its argument can be, as [word, note], for Tab. */
  complete?: () => readonly (readonly [string, string])[];
  /** Run but not offered by Tab (default: offered). */
  listed?: boolean;
};

/** The commands Tab completes for what is typed, as [name, description]. */
export function inspectorCompletions(
  commands: readonly InspectorCommand[],
  typed: string,
): [string, string][] {
  // A name and the start of its argument: the arguments it can take.
  const typedArgument = /^\s*:?(\S+)\s+(\S*)\s*$/.exec(typed);
  const taking = typedArgument
    ? commands.find(
        (entry) =>
          entry.complete &&
          (entry.name === typedArgument[1] ||
            entry.aliases?.includes(typedArgument[1]!)),
      )
    : undefined;
  if (typedArgument && taking?.complete)
    return taking
      .complete()
      .filter(([argument]) => argument.startsWith(typedArgument[2]!))
      .map(([argument, note]) => [`${typedArgument[1]} ${argument}`, note]);
  const word = typed.trim();
  const seen = new Set<string>();
  return commands
    .filter((command) => {
      if (
        command.listed === false ||
        !command.name.startsWith(word) ||
        seen.has(command.name)
      )
        return false;
      seen.add(command.name);
      return true;
    })
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
 * view has lines. Returns what to tell: what the command said, or that it is
 * none of them (`unknown` words it, default "Not a command here"); else null.
 */
export function runInspectorCommand(
  commands: readonly InspectorCommand[],
  input: string,
  line?: (line: number) => void,
  unknown: (
    text: string,
    commands: readonly InspectorCommand[],
  ) => string = notACommand,
): string | null {
  const text = input.trim().replace(/^:/, "").trim();
  if (!text) return null;
  if (line && /^\d+$/.test(text)) {
    line(Number(text));
    return null;
  }
  const found = findInspectorCommand(commands, text);
  if (!found) return unknown(text, commands);
  let said: string | null = null;
  let notOne = false;
  found.command.run(found.argument, {
    say: (message) => {
      said = message;
    },
    unknown: () => {
      notOne = true;
    },
  });
  return notOne ? unknown(text, commands) : said;
}

/** "Not a command here: :X (try ...)", naming a few of `commands`. */
export function notACommand(
  text: string,
  commands: readonly InspectorCommand[],
): string {
  const some = [
    ...new Set(
      commands
        .filter((command) => command.listed !== false)
        .map((command) => command.name),
    ),
  ]
    .slice(0, 4)
    .map((name) => `:${name}`)
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
  return !isTypingTarget(event.target);
}

/** A field, a comment box or any editable text, where keys are text. */
export function isTypingTarget(value: EventTarget | null): boolean {
  const target = value as {
    isContentEditable?: boolean;
    tagName?: unknown;
  } | null;
  if (!target || typeof target.tagName !== "string") return false;
  return (
    !!target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
}

/**
 * The words of the inspector's own commands and of the Files tree's: the
 * source view's Vim `:` hands them to the inspector's prompt too.
 */
export const INSPECTOR_COMMAND_WORDS: readonly string[] = [
  "view",
  "v",
  "dock",
  "expand",
  "refresh",
  "hidden",
  "newfolder",
  "mkdir",
  "browse",
  "search",
  "find",
  "vim",
  "novim",
  "help",
];

/** The views `:view` goes to, in the tab strip's order. */
export const INSPECTOR_VIEW_NAMES = [
  "files",
  "changes",
  "commits",
  "history",
] as const;

/**
 * The view `:view NAME` names: the whole name or the start of one, the
 * first in the tab strip's order (`:v c` is Changes).
 */
export function inspectorViewNamed<View extends string>(
  views: readonly View[],
  name: string,
): View | null {
  const word = name.trim().toLowerCase();
  if (!word) return null;
  return (
    views.find((view) => view === word) ??
    views.find((view) => view.startsWith(word)) ??
    null
  );
}
