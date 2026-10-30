/**
 * Rewinding a Claude Code session from the chat, through its /rewind menu
 * as the user would in the terminal: its picker lists the user's messages
 * oldest first and starts on "(current)", below the last one; Enter on a
 * message asks what to restore, numbered. Each step is checked on screen
 * before the next key, so a menu that moved or changed stops the rewind
 * rather than undoing the wrong thing.
 */

import type { AgentChatRewindCheck } from "../../shared/agentChat";

export type RewindMode = "both" | "conversation" | "code";

export const REWIND_MODES: { mode: RewindMode; label: string }[] = [
  { mode: "both", label: "Restore code and conversation" },
  { mode: "conversation", label: "Restore conversation" },
  { mode: "code", label: "Restore code" },
];

/** What restoring the code covers, said beside the choices. */
export const REWIND_CODE_HELP =
  "Restoring the code undoes the edits Claude made with its file tools. What commands (Bash) changed is not known, and is not undone.";

/** Files listed in a note: the first few, then how many more. */
export function listedFiles(files: readonly string[], shown = 5): string {
  const listed = files.slice(0, shown).join(", ");
  return files.length > shown
    ? `${listed} and ${files.length - shown} more`
    : listed;
}

/** What is asked when the code of edits has no checkpoint. */
export function noCheckpointQuestion(files?: readonly string[]): string {
  return [
    "Claude Code has no code checkpoint for these changes (made before checkpoints were on). Rewind the conversation only?",
    ...(files?.length ? ["", `Files changed: ${listedFiles(files)}`] : []),
  ].join("\n");
}

/**
 * Which choices a rewind offers, from what is known of its code before the
 * user picks (null: not known yet, or at all): the code ones are off, with
 * why, when there is nothing to restore or no checkpoint to restore from.
 */
export function rewindModeStates(check: AgentChatRewindCheck | null): {
  disabled: ReadonlySet<RewindMode>;
  note: string | null;
} {
  const code = new Set<RewindMode>(["both", "code"]);
  switch (check?.code) {
    case "none":
      return {
        disabled: code,
        note: "No code changes to restore: Claude edited no file after this message.",
      };
    case "no_checkpoint":
      return {
        disabled: code,
        note: `Claude Code has no code checkpoint for these changes (made before checkpoints were on)${
          check.files?.length ? `: ${listedFiles(check.files)}` : ""
        }. Restore the conversation only.`,
      };
    default:
      return { disabled: new Set(), note: null };
  }
}

const PICKER = "Restore the code and/or conversation to the point before";
const CONFIRM = "Confirm you want to restore to the point before";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";
/** How far from where it is counted the message may be in the picker. */
const SEARCH = 12;

const BORDER = /^[\s│┃|]+|[\s│┃|]+$/g;

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** The picker's line under its ❯ cursor, without the cursor. */
export function selectedRewindEntry(screen: readonly string[]): string | null {
  const start = screen.findIndex((line) => line.includes(PICKER));
  if (start < 0) return null;
  for (const line of screen.slice(start + 1)) {
    const text = line.replace(BORDER, "");
    if (text.startsWith("❯")) return normalize(text.slice(1));
  }
  return null;
}

/** Whether a picker line shows `message`: its start, cut short with "…". */
export function showsMessage(entry: string, message: string) {
  const shown = normalize(entry.replace(/…$/, ""));
  const text = normalize(message);
  if (!shown || !text) return false;
  return (
    text.startsWith(shown) ||
    normalize(message.split("\n")[0] ?? "").startsWith(shown)
  );
}

/** The confirmation's choices: label to the key that picks it. */
export function rewindChoices(screen: readonly string[]): Map<string, string> {
  const choices = new Map<string, string>();
  const start = screen.findIndex((line) => line.includes(CONFIRM));
  if (start < 0) return choices;
  for (const line of screen.slice(start + 1)) {
    const match = /^(?:[❯↑↓]\s*)?(\d)\.\s+(.+)$/.exec(line.replace(BORDER, ""));
    if (match) choices.set(normalize(match[2]!), match[1]!);
  }
  return choices;
}

export type RewindIo = {
  readScreen: () => string[];
  /** Types a command in the agent's prompt and submits it. */
  command: (text: string) => Promise<void>;
  /** Presses keys. */
  send: (text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

async function waitFor(
  io: RewindIo,
  sleep: (ms: number) => Promise<void>,
  done: (screen: string[]) => boolean,
  ms = 4000,
) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (done(io.readScreen())) return true;
    await sleep(100);
  }
  return done(io.readScreen());
}

/**
 * Rewinds to before `message`, the user's `after`+1-th message from the
 * end (0 for the last one), restoring what `mode` says.
 */
export async function rewindClaude(
  io: RewindIo,
  message: string,
  after: number,
  mode: RewindMode,
) {
  const sleep =
    io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cancel = async () => {
    await io.send(ESC);
    await sleep(150);
    await io.send(ESC);
  };
  await io.command("/rewind");
  if (
    !(await waitFor(io, sleep, (screen) =>
      screen.some((l) => l.includes(PICKER)),
    ))
  )
    throw new Error("Claude Code did not open its rewind menu");

  // Up once per later message, and once from "(current)"; then the nearest
  // line showing the message, should the count be off.
  let position = 0;
  const moveTo = async (target: number) => {
    const keys = target > position ? DOWN : UP;
    const steps = Math.abs(target - position);
    if (!steps) return;
    await io.send(keys.repeat(steps));
    position = target;
    await sleep(120);
  };
  const estimate = -(after + 1);
  let found = false;
  for (const offset of [
    0,
    ...Array.from(
      { length: SEARCH * 2 },
      (_, i) => (i % 2 ? 1 : -1) * Math.ceil((i + 1) / 2),
    ),
  ]) {
    const target = estimate + offset;
    if (target >= 0) continue;
    await moveTo(target);
    const entry = selectedRewindEntry(io.readScreen());
    if (entry && showsMessage(entry, message)) {
      found = true;
      break;
    }
  }
  if (!found) {
    await cancel();
    throw new Error("The message was not found in Claude Code's rewind menu");
  }
  await io.send("\r");
  if (
    !(await waitFor(io, sleep, (screen) =>
      screen.some((l) => l.includes(CONFIRM)),
    ))
  ) {
    await cancel();
    throw new Error("Claude Code did not ask what to restore");
  }
  const label = REWIND_MODES.find((each) => each.mode === mode)!.label;
  const key = rewindChoices(io.readScreen()).get(label);
  if (!key) {
    await cancel();
    throw new Error(`Claude Code does not offer "${label}" here`);
  }
  await io.send(key);
  if (
    !(await waitFor(
      io,
      sleep,
      (screen) =>
        !screen.some((l) => l.includes(CONFIRM) || l.includes(PICKER)),
    ))
  )
    throw new Error("Claude Code's rewind menu did not close");
}
