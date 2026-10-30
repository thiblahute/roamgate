import type { ClaudeCodeProcess } from "../assistant/claude-driver";
import { holderEnvChanges } from "./env";

/**
 * The long-lived headless claude for one session: stream-json both ways,
 * partial messages, the user's own messages echoed back once accepted, and
 * permissions asked over stdio. The user's hooks stay on.
 */
export function headlessClaudeArgs(sessionId: string): string[] {
  return [
    "-p",
    "--resume",
    sessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
  ];
}

/**
 * A headless claude as the conversation session sees it. The pane holder
 * runs it; Roamgate reads what it says and writes to it through the holder.
 */
export type HeadlessProcess = ClaudeCodeProcess & {
  /**
   * The first lines of `lines` were handled by an earlier reader (another
   * runtime, a Roamgate before a restart): they rebuild the turn's state
   * and are not sent to the browsers again.
   */
  replayed?: number;
  /**
   * The first lines of `lines` that were already in when it was taken
   * (`replayed` among them): until they are handled the session catches
   * up, and asks no prompt (a later line may show it answered).
   */
  catchUp?: number;
  /**
   * Once it exited: the user messages written to it that claude never got
   * (the holder dropped them: its stdin was closed), as written.
   */
  undelivered?: () => string[];
  /** Stops reading; the process itself keeps running in the holder. */
  detach?: () => void;
};

export type HeadlessSpawnOptions = {
  paneId: string;
  sessionId: string;
  cwd: string;
  /** Only a process that already runs (or ended unread) is taken. */
  attachOnly?: boolean;
  /** Gives up a start still waiting. */
  signal?: AbortSignal;
};

/** null only when attaching and nothing runs. */
export type SpawnHeadless = (
  options: HeadlessSpawnOptions,
) => Promise<HeadlessProcess | null>;

/**
 * What the pane holder is asked to run: claude resuming the session, in
 * its directory, with the headless environment.
 */
export function holderStartCommand(options: {
  sessionId: string;
  cwd: string;
}): Record<string, unknown> {
  return {
    argv: ["claude", ...headlessClaudeArgs(options.sessionId)],
    cwd: options.cwd,
    ...holderEnvChanges(),
  };
}
