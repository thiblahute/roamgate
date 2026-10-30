/**
 * Claude Code's bash mode: a line typed starting with `!` runs as a shell
 * command, and Claude reads the command and its output on its next turn,
 * from user records it writes this way:
 *
 *   <bash-input>git status</bash-input>
 *   <bash-stdout>On branch main...</bash-stdout><bash-stderr></bash-stderr>
 *
 * The terminal writes the two as records of their own (in the same turn);
 * conversation mode sends them as the first blocks of the next message.
 * The output is HTML-escaped; the command is not.
 */

/** What Claude reads of each stream, as Claude Code's own cap. */
export const BASH_OUTPUT_LIMIT = 30_000;

/** One command run in bash mode and what it printed. */
export type BashModeRun = {
  command: string;
  stdout: string;
  stderr: string;
};

/**
 * The command of a `!` line: the text after the `!` when it is the first
 * character that is not a space, as in the terminal; null for any other
 * message, and for a `!` with nothing after it.
 */
export function shellLine(text: string): string | null {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== "!") return null;
  const command = text.slice(start + 1);
  return command.trim() ? command : null;
}

export function escapeBashOutput(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function unescapeBashOutput(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Output past the cap, cut as Claude Code cuts it: the first `limit`
 * characters, then how many lines were left out.
 */
export function truncateBashOutput(
  value: string,
  limit = BASH_OUTPUT_LIMIT,
): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  const head = value.slice(0, limit);
  const rest = value.slice(limit);
  const lines = rest.split("\n").length;
  return {
    text: `${head}\n\n... [${lines} lines truncated] ...`,
    truncated: true,
  };
}

/** The two text blocks Claude reads for one run, in Claude Code's format. */
export function bashModeTexts(run: BashModeRun): [string, string] {
  return [
    `<bash-input>${run.command}</bash-input>`,
    `<bash-stdout>${escapeBashOutput(run.stdout)}</bash-stdout><bash-stderr>${escapeBashOutput(run.stderr)}</bash-stderr>`,
  ];
}

/** A run read back from a transcript: its command, its output, or both. */
export type BashModePart = {
  command?: string;
  stdout?: string;
  stderr?: string;
};

const INPUT = /^\s*<bash-input>([\s\S]*?)<\/bash-input>/;
const OUTPUT =
  /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*<bash-stderr>([\s\S]*?)<\/bash-stderr>/;

/**
 * The bash-mode runs a user message starts with, and the text after them
 * (the user's own words, when there are any); null when it starts with
 * none. An output with no command before it belongs to the command of the
 * record before (the terminal writes them apart).
 */
export function splitBashMode(
  text: string,
): { parts: BashModePart[]; rest: string } | null {
  const parts: BashModePart[] = [];
  let rest = text;
  for (;;) {
    const input = INPUT.exec(rest);
    if (input) {
      parts.push({ command: input[1]! });
      rest = rest.slice(input[0].length);
      continue;
    }
    const output = OUTPUT.exec(rest);
    if (output) {
      const last = parts[parts.length - 1];
      const printed = {
        stdout: unescapeBashOutput(output[1]!),
        stderr: unescapeBashOutput(output[2]!),
      };
      if (last && last.stdout === undefined) Object.assign(last, printed);
      else parts.push(printed);
      rest = rest.slice(output[0].length);
      continue;
    }
    break;
  }
  return parts.length ? { parts, rest: rest.trim() } : null;
}
