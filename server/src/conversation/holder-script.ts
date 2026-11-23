import { createHash } from "node:crypto";
import { CLAUDE_START_ENV } from "../../../shared/agentChat";
import { claudeTerminalDriver } from "./drivers/claude-tui";
import type { TerminalDriver } from "./drivers/types";
import { ROAMGATE_HOLD_PY } from "../assets";

/**
 * `roamgate-hold`: runs in a pane while Roamgate's conversation mode owns
 * the pane's Claude session. It keeps the shell from taking a second
 * `claude`, runs the session's headless claude as its own child (so an SSH
 * link that drops, or a Roamgate restart, does not kill it), relays that
 * child's output through a log Roamgate reads from where it stopped and
 * Roamgate's input to its stdin, waits for Roamgate to hand the session
 * back (or for Enter, which asks it to), and then, once its child is gone,
 * becomes `claude --resume <id>` in the session's directory. Python 3
 * standard library only, like roamgate-review, and it talks to the same
 * socket.
 */
export const HOLD_CLIENT_SCRIPT = ROAMGATE_HOLD_PY;

export const HOLD_CLIENT_CHECKSUM = createHash("sha256")
  .update(HOLD_CLIENT_SCRIPT)
  .digest("hex")
  .slice(0, 16);

export const HOLD_CLIENT_INSTALLED_SCRIPT = `${HOLD_CLIENT_SCRIPT}# roamgate-hold ${HOLD_CLIENT_CHECKSUM}\n`;

function checkSessionId(sessionId: string) {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId))
    throw new Error("invalid session id");
}

/** A word every shell (sh, bash, zsh, fish) reads the same; null if none. */
function shellWord(value: string): string | null {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  // Backslashes inside single quotes differ between fish and the others.
  if (value.includes("\\")) return null;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * What is typed into the pane's shell to start the holder. Locally the
 * holder's path and Roamgate's socket are given whole: the pane's $HOME
 * need not be Roamgate's. Over SSH the host's own install is used.
 */
export function holderCommand(
  sessionId: string,
  local?: { bin: string; socket: string },
): string {
  checkSessionId(sessionId);
  // The leading space keeps it out of most shells' history.
  if (!local)
    return ` "$HOME/.cache/roamgate/bin/roamgate-hold" ${sessionId}\r`;
  const bin = shellWord(local.bin);
  const socket = shellWord(local.socket);
  if (!bin || !socket) throw new Error("unusual characters in the holder path");
  return ` ${bin} ${sessionId} --socket ${socket}\r`;
}

/**
 * What is typed into the pane's shell to start a launch Roamgate prepared
 * (a profile's agent): roamgate-hold fetches the program and environment
 * with the token and becomes it. Paths as for holderCommand.
 */
export function launchCommand(
  token: string,
  local?: { bin: string; socket: string },
): string {
  if (!/^[0-9a-f]{16,64}$/.test(token)) throw new Error("invalid token");
  if (!local)
    return ` "$HOME/.cache/roamgate/bin/roamgate-hold" --launch ${token}\r`;
  const bin = shellWord(local.bin);
  const socket = shellWord(local.socket);
  if (!bin || !socket) throw new Error("unusual characters in the holder path");
  return ` ${bin} --socket ${socket} --launch ${token}\r`;
}

/**
 * What is typed into the pane's shell to resume the session in its TUI
 * (claude by default), with the flags it ran with when every shell reads
 * them the same way.
 */
export function resumeCommand(
  sessionId: string,
  args: string[] = [],
  terminal: TerminalDriver = claudeTerminalDriver,
): string {
  checkSessionId(sessionId);
  const words = args.map(shellWord);
  const flags = words.every((word) => word !== null) ? (words as string[]) : [];
  // env, not VAR=value: fish before 3.1 does not read the latter. The
  // agent resumed here stays in the terminal (see CLAUDE_START_ENV).
  return ` ${["env", `${CLAUDE_START_ENV}=terminal`, ...terminal.resumeArgv(sessionId, flags)].join(" ")}\r`;
}
