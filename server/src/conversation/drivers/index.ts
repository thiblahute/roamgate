import type { ConversationAgent } from "../../../../shared/agentChat";
import { claudeProtocolDriver } from "./claude";
import { claudeTerminalDriver } from "./claude-tui";
import type { ConversationDriver } from "./types";

const DRIVERS: Record<ConversationAgent, ConversationDriver> = {
  claude: { protocol: claudeProtocolDriver, terminal: claudeTerminalDriver },
};

/** The driver pair of an agent; absent (an older lease): claude. */
export function conversationDriver(
  agent?: ConversationAgent | null,
): ConversationDriver {
  return DRIVERS[agent ?? "claude"] ?? DRIVERS.claude;
}

/** Every driver: what probes for any agent's processes go through. */
export function conversationDrivers(): ConversationDriver[] {
  return Object.values(DRIVERS);
}

/** The driver of the agent Herdr names in a pane, if conversation mode has one. */
export function driverForHerdrAgent(name: unknown): ConversationDriver | null {
  return (
    Object.values(DRIVERS).find((each) => each.terminal.herdrAgent === name) ??
    null
  );
}

export { claudeProtocolDriver, claudeTerminalDriver };
export type * from "./types";
