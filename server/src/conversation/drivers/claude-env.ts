/**
 * The headless claude's environment, built explicitly: nothing of an outer
 * Claude Code session, the pane's API key only when the user said to use it
 * (below), and a marker that tells Roamgate's own hooks to step aside. Nor the pane's HERDR_ENV,
 * HERDR_PANE_ID and HERDR_SOCKET_PATH: with them, Herdr's SessionStart hook
 * claims the pane for `herdr:claude`, and Herdr then drops every state
 * Roamgate reports for it (`roamgate:headless`) until the pane is back at
 * its shell, so the pane showed one state for good. Roamgate reports the
 * pane's state and session itself (the service's `report`), and lists the
 * session for its own clients (agent-sessions' owned panes).
 * The pane and its Herdr server are still told under Roamgate's own names
 * (PANE_NAMES): the review client reports them, so comments in a review
 * the agent opened reach its pane (as a message, conversation mode being
 * what holds it), and Herdr's hook does not read them.
 * Checkpoints of the files it edits are turned on, as the terminal claude
 * has them: a rewind restores the code from them.
 */

/**
 * The pane's Anthropic API key. Claude Code's TUI asks once whether to use
 * it ("Detected a custom API key in your environment") and files the
 * answer in its global config (`customApiKeyResponses` in ~/.claude.json,
 * or in $CLAUDE_CONFIG_DIR, by the key's last 20 characters), while
 * `claude -p` uses it without asking. So the holder, on the pane's host,
 * reads that answer and keeps the key only when it was yes; with no answer
 * yet the chat asks the TUI's question and the holder files the answer
 * there, before it starts the headless claude (see roamgate-hold). The key
 * itself never leaves the host: the holder reports only the answer's state.
 *
 * ANTHROPIC_AUTH_TOKEN is kept: Claude Code uses it in the TUI as in print
 * mode, without asking, so conversation mode is billed as the terminal is.
 */
export const API_KEY = "ANTHROPIC_API_KEY";

/** What the holder is told to do with the pane's API key. */
export const API_KEY_POLICY = "claude_config";

/** The user's answer the holder files before it starts claude. */
export type ApiKeyAnswer = "approve" | "reject";

const DROPPED = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
  // Kept by a holder that knows the user approved it (API_KEY_POLICY); an
  // older holder drops it, as it always did.
  API_KEY,
  // Herdr's hook would claim the pane (see above).
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
];
const DROPPED_PREFIXES = ["CLAUDE_CODE_"];

export const HEADLESS_MARKER = "ROAMGATE_HEADLESS";

/** The pane's Herdr names, and what the headless claude has them as. */
export const PANE_NAMES = {
  HERDR_PANE_ID: "ROAMGATE_PANE_ID",
  HERDR_SOCKET_PATH: "ROAMGATE_HERDR_SOCKET_PATH",
} as const;

/** Off by default in print mode: on, as in the terminal. */
const CHECKPOINTS = "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING";

/**
 * What the pane holder changes in the pane's environment before it starts
 * the headless claude: the same names dropped, the same marker set, and
 * the API key kept only as Claude Code's stored answer (or `answer`, the
 * user's, which the holder files first) says. The pane's Herdr names are
 * copied to Roamgate's (`copy`, before the drop); the pane id is also set,
 * for a holder from before `copy`.
 */
export function holderEnvChanges(
  answer?: ApiKeyAnswer,
  paneId?: string,
): {
  drop: string[];
  drop_prefixes: string[];
  copy: Record<string, string>;
  set: Record<string, string>;
  api_key: { policy: string; answer?: ApiKeyAnswer };
} {
  return {
    drop: [...DROPPED],
    drop_prefixes: [...DROPPED_PREFIXES],
    copy: { ...PANE_NAMES },
    set: {
      [HEADLESS_MARKER]: "1",
      [CHECKPOINTS]: "1",
      ...(paneId ? { [PANE_NAMES.HERDR_PANE_ID]: paneId } : {}),
    },
    api_key: { policy: API_KEY_POLICY, ...(answer ? { answer } : {}) },
  };
}
