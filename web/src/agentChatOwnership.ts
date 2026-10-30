import type {
  AgentChatOwner,
  AgentChatPhase,
  AgentChatState,
  AgentChatStatus,
} from "../../shared/agentChat";

/**
 * Who writes to a Claude session, the terminal's TUI or conversation mode's
 * headless process, is the user's choice alone (design decision 4): one
 * view per mode. In terminal mode the pane shows its terminal, and only
 * that; in conversation mode it shows the chat. The user switches with
 * "Switch to conversation mode" (useConversationSwitch) and "Open in
 * terminal"; what a browser shows never moves the session.
 */

/** Whether conversation mode holds the session (or is taking or giving it). */
export function conversationOwns(
  chat: Pick<AgentChatState, "phase"> | null | undefined,
): boolean {
  return !!chat && chat.phase !== "terminal";
}

/**
 * The view a Claude pane shows in its mode: the chat while conversation
 * mode has the session or takes it, the terminal while the terminal has it
 * or gets it back. Null while the mode is not known yet.
 */
export function modeView(
  chat: Pick<AgentChatState, "phase"> | null | undefined,
): "chat" | "terminal" | null {
  if (!chat) return null;
  return chat.phase === "conversation" || chat.phase === "to_conversation"
    ? "chat"
    : "terminal";
}

/**
 * What an agent pane shows. A Claude pane whose bridge has conversation
 * mode is mode-bound: its mode's view, the view last kept for it until the
 * mode is known, its terminal when none was. Other agents, and a Claude
 * where the bridge has no conversation mode, show the view chosen for the
 * pane (upstream's chat over the terminal).
 */
export function paneShownView(args: {
  /** The pane runs an agent whose history can be read. */
  agent: boolean;
  claude: boolean;
  chat: {
    state: Pick<AgentChatState, "phase"> | null;
    unavailable: boolean;
  } | null;
  /** The view kept for the pane, null when none was. */
  stored: "chat" | "terminal" | null;
  /** The view chosen for the pane, the default one when none was kept. */
  chosen: "chat" | "terminal";
}): { view: "chat" | "terminal"; modeBound: boolean } {
  const modeBound = args.claude && !!args.chat && !args.chat.unavailable;
  const view = !args.agent
    ? "terminal"
    : modeBound
      ? (modeView(args.chat?.state) ?? args.stored ?? "terminal")
      : args.chosen;
  return { view, modeBound };
}

/**
 * The owner line: which mode has the session, and why it did not switch.
 * Null while conversation mode simply holds the session: its chat says so
 * well enough, so the header keeps its room. A refused Open in terminal is
 * still said, with why.
 */
export function ownershipLabel(args: {
  chat: { phase: AgentChatPhase; status: AgentChatStatus } | null;
  refusal: string | null;
  handing: AgentChatOwner | null;
}): {
  label: string;
  detail: string | null;
  tone: "terminal" | "conversation" | "busy";
} | null {
  const { chat, refusal, handing } = args;
  if (handing === "conversation" || chat?.phase === "to_conversation")
    return {
      label: "Switching to conversation mode",
      detail: "Closing Claude in the terminal",
      tone: "busy",
    };
  if (handing === "terminal" || chat?.phase === "to_terminal")
    return {
      label: "Opening in the terminal",
      detail: "Resuming Claude in the terminal",
      tone: "busy",
    };
  if (chat?.phase === "conversation")
    return refusal
      ? {
          label: "Still in conversation mode",
          detail: refusal,
          tone: "conversation",
        }
      : null;
  return { label: "Terminal mode", detail: refusal, tone: "terminal" };
}

/**
 * The status the chat shows while conversation mode holds the session, in
 * Herdr's words: the stream knows better than the pane's reported status.
 */
export function conversationAgentStatus(status: AgentChatStatus): string {
  switch (status) {
    case "working":
    case "starting":
      return "working";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
}

/** What the activity line says while conversation mode works. */
export function conversationActivity(activity: string | null): string {
  if (!activity) return "Working\u2026";
  if (activity === "thinking") return "Thinking\u2026";
  if (activity === "compacting") return "Compacting\u2026";
  // Its process stopped while idle (idle stop) starts again for a message.
  if (activity === "waking") return "Waking Claude\u2026";
  return `Running ${activity}`;
}
