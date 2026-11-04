import type { ClaudeCodeProcess } from "../assistant/claude-driver";
import type { ApiKeyAnswer } from "./drivers/claude-env";

// Claude's headless command lives with its driver; re-exported here.
export {
  headlessClaudeArgs,
  headlessFlags,
  holderStartCommand,
} from "./drivers/claude";

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
  /**
   * The state a reader before this one left the conversation in, where
   * `lines` start (ConversationSession.resumeState): restored instead of
   * read again.
   */
  resume?: unknown;
  /**
   * Where the lines handled so far end in the holder's log, while it runs:
   * a reader after this one starts there with this one's state.
   */
  position?: () => {
    child: number;
    epoch_offset: number;
    offset: number;
  } | null;
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
  /**
   * The user's answer about the pane's API key, just given in the chat:
   * the holder files it where Claude Code keeps it, then starts claude.
   */
  apiKeyAnswer?: ApiKeyAnswer;
};

/** null only when attaching and nothing runs. */
export type SpawnHeadless = (
  options: HeadlessSpawnOptions,
) => Promise<HeadlessProcess | null>;
