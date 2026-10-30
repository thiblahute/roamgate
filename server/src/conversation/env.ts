/**
 * The headless claude's environment, built explicitly: nothing of an outer
 * Claude Code session, no API key (the claude.ai login pays), and a marker
 * that tells Roamgate's own hooks to step aside. The pane's own HERDR_*
 * stay: the holder runs it in its pane, so Herdr's SessionStart hook tells
 * Herdr which session that pane holds, as it does for the terminal claude.
 */

const DROPPED = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];
const DROPPED_PREFIXES = ["CLAUDE_CODE_"];

export const HEADLESS_MARKER = "ROAMGATE_HEADLESS";

/**
 * What the pane holder changes in the pane's environment before it starts
 * the headless claude: the same names dropped, the same marker set.
 */
export function holderEnvChanges(): {
  drop: string[];
  drop_prefixes: string[];
  set: Record<string, string>;
} {
  return {
    drop: [...DROPPED],
    drop_prefixes: [...DROPPED_PREFIXES],
    set: { [HEADLESS_MARKER]: "1" },
  };
}
