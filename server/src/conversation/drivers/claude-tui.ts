import type { PaneProcess } from "../herdr";
import type { TerminalDriver } from "./types";

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `ps -eo pid=,args=` lists a headless claude on one of these
 * sessions: its argv resumes the id and streams JSON. Matched by argv, not
 * by a recorded pid, which another process may have taken since.
 */
export function psHasHeadless(
  psOutput: string,
  sessionIds: readonly string[],
): boolean {
  const ids = sessionIds.filter(Boolean);
  if (!ids.length) return false;
  const resume = new RegExp(
    `--resume['"\\s]+(?:${ids.map(escapeRegExp).join("|")})(?![\\w-])`,
  );
  return psOutput
    .split("\n")
    .some((line) => line.includes("stream-json") && resume.test(line));
}

/**
 * Whether `ps -eo pid=,args=` lists an interactive claude resuming one of
 * these sessions (not a headless one: those stream JSON), other than the
 * given pids. Its pid, if so.
 */
export function psInteractiveClaude(
  psOutput: string,
  sessionIds: readonly string[],
  exceptPids: readonly number[] = [],
): number | null {
  const ids = sessionIds.filter(Boolean);
  if (!ids.length) return null;
  const resume = new RegExp(
    `(?:--resume|-r)(?:=|['"\\s]+)(?:${ids.map(escapeRegExp).join("|")})(?![\\w-])`,
  );
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2]!;
    if (exceptPids.includes(pid) || args.includes("stream-json")) continue;
    if (!/(?:^|[\s/])claude(?:\.exe)?(?:\s|$)|claude-code/.test(args)) continue;
    if (resume.test(args)) return pid;
  }
  return null;
}

/** Whether a foreground process is an interactive Claude Code. */
export function isClaudeProcess(process: PaneProcess): boolean {
  const parts = [process.argv0 ?? "", ...(process.argv ?? [])];
  // The pane holder's headless child (it streams JSON) is no TUI.
  if (
    parts.includes("stream-json") ||
    (process.cmdline ?? "").includes("stream-json")
  )
    return false;
  if (parts.some((part) => /(?:^|\/)claude(?:\.exe)?$/.test(part))) return true;
  return /(?:^|[\s/])claude(?:\s|$)|@anthropic-ai\/claude-code/.test(
    process.cmdline ?? "",
  );
}

/**
 * How each of claude's flags that a resumed TUI should keep takes values:
 * none, one, or several (up to the next flag).
 */
const KEPT_FLAGS: Record<string, 0 | 1 | "*"> = {
  "--model": 1,
  "--permission-mode": 1,
  "--dangerously-skip-permissions": 0,
  "--allow-dangerously-skip-permissions": 0,
  "--add-dir": "*",
  "--mcp-config": "*",
  "--strict-mcp-config": 0,
  "--settings": 1,
  "--setting-sources": 1,
  "--agent": 1,
  "--effort": 1,
  "--fallback-model": 1,
  "--append-system-prompt": 1,
  "--system-prompt": 1,
  "--allowedTools": "*",
  "--allowed-tools": "*",
  "--disallowedTools": "*",
  "--disallowed-tools": "*",
  "--plugin-dir": "*",
  "--ide": 0,
  "--verbose": 0,
};

/**
 * The flags the pane's claude ran with that its resumed TUI keeps (model,
 * permission mode, directories, MCP configs...). Anything else (a session
 * to resume, a prompt, an unknown flag) is left out.
 */
export function terminalClaudeArgs(process: PaneProcess): string[] {
  const argv = process.argv ?? [];
  let at = -1;
  for (let index = 0; index < argv.length; index += 1)
    if (/(?:^|\/)claude(?:\.exe)?$|claude-code\/cli\.m?js$/.test(argv[index]!))
      at = index;
  const rest = argv.slice(at + 1);
  const kept: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const [flag, inline] = arg.split(/=(.*)/s, 2) as [string, string?];
    const arity = KEPT_FLAGS[flag];
    if (arity === undefined) continue;
    if (inline !== undefined) {
      if (arity !== 0) kept.push(arg);
      continue;
    }
    kept.push(arg);
    if (arity === 1) {
      const value = rest[index + 1];
      if (value === undefined) kept.pop();
      else {
        kept.push(value);
        index += 1;
      }
    } else if (arity === "*")
      while (index + 1 < rest.length && !rest[index + 1]!.startsWith("-")) {
        kept.push(rest[index + 1]!);
        index += 1;
      }
  }
  return kept;
}

export type PromptBoxState = {
  box: "empty" | "draft" | "missing";
  vim: "insert" | "normal" | "none";
};

const BORDER = /^[\s\u2502\u2503|]+|[\s\u2502\u2503|]+$/g;
const RULE =
  /^\s*[\u2500\u2501\u2550\u256d\u256e\u256f\u2570\u2514\u2518\u250c\u2510]{3,}/;

const ESCAPE =
  /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** The text of a line, its escapes left out. */
function plainText(line: string): string {
  return line.replace(ESCAPE, "");
}

/**
 * What the user typed on a line of Claude's prompt box: its text without
 * the dim parts (Claude's suggested next prompt, a placeholder) or the
 * cursor (inverse video).
 */
function typedText(line: string): string {
  let typed = "";
  let dim = false;
  let inverse = false;
  let at = 0;
  for (const match of line.matchAll(ESCAPE)) {
    if (!dim && !inverse) typed += line.slice(at, match.index);
    at = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] || "0").split(/[;:]/);
    for (let index = 0; index < codes.length; index += 1) {
      const code = Number(codes[index] || 0);
      // Colors' own parameters are not codes.
      if (code === 38 || code === 48 || code === 58) {
        index += codes[index + 1] === "5" ? 2 : 4;
        continue;
      }
      if (code === 0) dim = inverse = false;
      else if (code === 2) dim = true;
      else if (code === 22) dim = false;
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
    }
  }
  if (!dim && !inverse) typed += line.slice(at);
  return typed;
}

/**
 * Claude's prompt box and vim mode from the end of Claude's screen: the
 * last line with the prompt mark, and what follows it up to the box's rule.
 * With the screen's styles, dim text in the box (Claude's suggestion of a
 * next prompt) is not a draft; without them, any text is.
 */
export function claudePromptState(text: string): PromptBoxState {
  const lines = text.split("\n");
  const plain = lines.map(plainText);
  let at = -1;
  for (let index = plain.length - 1; index >= 0; index -= 1) {
    if (/^\s*[\u2502\u2503|]?\s*\u276f/.test(plain[index]!)) {
      at = index;
      break;
    }
  }
  const screen = plain.join("\n");
  const vim = /--\s*INSERT\s*--/.test(screen)
    ? "insert"
    : /--\s*(?:NORMAL|VISUAL)[^-\n]*--/.test(screen)
      ? "normal"
      : "none";
  if (at < 0) return { box: "missing", vim };
  const first = typedText(lines[at]!)
    .replace(/^\s*[\u2502\u2503|]?\s*\u276f/, "")
    .replace(BORDER, "");
  if (first) return { box: "draft", vim };
  for (let index = at + 1; index < lines.length; index += 1) {
    if (RULE.test(plain[index]!)) break;
    if (typedText(lines[index]!).replace(BORDER, ""))
      return { box: "draft", vim };
  }
  return { box: "empty", vim };
}

/** The lines from the last one with the prompt mark on: the box and footer. */
function linesAfterPrompt(plain: string[]): string[] {
  for (let index = plain.length - 1; index >= 0; index -= 1)
    if (/^\s*[│┃|]?\s*❯/.test(plain[index]!)) return plain.slice(index + 1);
  return [];
}

/** Footer words that name background work, as Claude Code writes them. */
const WORK =
  /(?:^|\s)(\d+)\s+(shells?|bash(?:es)?|background tasks?|tasks?|monitors?|(?:local |background )?agents? running)(?:\s+(?:still\s+)?running)?\s*$/i;

/**
 * Under this width (the prompt box's rule) Claude's footer is cut short:
 * "· 1 shell" may be gone from it, so it says nothing either way.
 */
export const FOOTER_MIN_WIDTH = 60;

export type ClaudeFooter = {
  /** The background work it shows ("1 shell"), or null. */
  work: string | null;
  /**
   * Whether its silence counts: false when the pane is too narrow for it
   * (it is cut) or no prompt box is on screen.
   */
  readable: boolean;
};

/**
 * The background work Claude's footer reports under its prompt box (a
 * background shell, a monitor, a task), as it words it: "1 shell". Claude
 * Code stops that work when it exits, so the terminal is not idle while it
 * runs, whatever Herdr says. Agents the footer lists ("← 18 agents") are
 * not counted: finished ones stay listed. A count whose word was cut ("· 1"
 * at the end of a narrow pane's footer) is work too.
 */
export function claudeFooter(text: string): ClaudeFooter {
  const plain = text.split("\n").map(plainText);
  const after = linesAfterPrompt(plain);
  // The box's rules: the narrower of the two around the prompt line.
  const rule = after.find((line) => RULE.test(line));
  const width = rule ? rule.trim().length : 0;
  const found: string[] = [];
  let cut = 0;
  for (const line of after)
    for (const raw of line.split(/\s+·\s+|\s+·\s*$/)) {
      const part = raw.trim();
      const match = WORK.exec(part);
      if (match && Number(match[1]) > 0)
        found.push(`${match[1]} ${match[2]!.toLowerCase()}`);
      // A count cut from its word: "1", "2 sh…".
      else if (/^[1-9]\d*(?:\s+\S*…)?$/.test(part))
        cut += Number.parseInt(part, 10);
    }
  if (found.length) return { work: found.join(", "), readable: true };
  if (cut)
    return {
      work: `${cut} background ${cut === 1 ? "task" : "tasks"}`,
      readable: true,
    };
  return { work: null, readable: width >= FOOTER_MIN_WIDTH };
}

/** The background work Claude's footer shows ("1 shell"), or null. */
export function claudeBackgroundWork(text: string): string | null {
  return claudeFooter(text).work;
}

/**
 * Claude Code's question when /exit finds background work running ("Exit
 * and stop tasks", "Move to background and exit", "Stay"): the key that
 * answers Stay (its number, or Escape, which cancels the same way), or
 * null when the question is not on screen.
 */
export function claudeExitDialog(text: string): { stayKey: string } | null {
  const screen = text.split("\n").map(plainText).join("\n");
  if (
    !/Background work is running/i.test(screen) &&
    !/Exit and stop tasks/i.test(screen)
  )
    return null;
  const stay = /(?:^|[\s❯>])(\d)\.\s*Stay\s*$/im.exec(screen);
  return { stayKey: stay ? stay[1]! : "\x1b" };
}

/**
 * Claude Code's TUI: the screen parsers above, its kept flags, /exit and
 * `claude --resume`.
 */
export const claudeTerminalDriver: TerminalDriver = {
  agent: "claude",
  herdrAgent: "claude",
  displayName: "Claude",
  isAgentProcess: isClaudeProcess,
  keptFlags: terminalClaudeArgs,
  readiness(screen) {
    const footer = claudeFooter(screen);
    let refusal: string | null = null;
    if (claudeExitDialog(screen))
      refusal = "Claude is asking whether to exit in the terminal";
    else {
      const prompt = claudePromptState(screen);
      if (prompt.box === "missing")
        refusal = "Claude's prompt box is not on screen";
      else if (prompt.box === "draft")
        refusal =
          "Something is typed in Claude's prompt box; send or clear it first";
      else if (prompt.vim === "normal")
        refusal =
          "Claude's prompt is in vim normal mode; switch it to insert mode first";
    }
    return {
      background: footer.work,
      backgroundKnown: footer.readable,
      refusal,
    };
  },
  exitCommand: "/exit",
  exitDialog: claudeExitDialog,
  backgroundWork: claudeBackgroundWork,
  resumeArgv: (sessionId, flags) => ["claude", ...flags, "--resume", sessionId],
  headlessProbe: psHasHeadless,
  interactiveWriter: psInteractiveClaude,
};
