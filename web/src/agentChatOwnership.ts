import type {
  AgentChatOwner,
  AgentChatPhase,
  AgentChatStatus,
} from "../../shared/agentChat";
import { agentStateKind } from "./components/agentSession";

/**
 * Who writes to a Claude session, the terminal's TUI or conversation mode's
 * headless process, follows the view (design decision 4): showing the chat
 * of an idle Claude hands the session to conversation mode, showing the
 * terminal hands it back once no turn runs. The bridge checks and refuses;
 * this only decides when to ask.
 *
 * These requests are automatic: the bridge arbitrates them, and refuses
 * one while another browser shows the pane in the other view (the user's
 * own switch, a button, always goes ahead). Each showing of a view (a
 * switch of view, the pane becoming the active one, the page coming back)
 * asks at most until it has its way once: once the session sits where it
 * wants it, it never asks again, whoever moves the session afterwards
 * (Enter in the holder, the user's switch on another device). A refusal
 * stands until something changes (Herdr's state, the stream's status, or
 * a retry of a refused takeover), then it asks again.
 */
export type OwnershipInput = {
  view: "chat" | "terminal";
  /** This browser shows the pane now (active pane, page visible). */
  visible: boolean;
  agent: string | null | undefined;
  /** Herdr's status of the pane's agent. */
  agentStatus: string | undefined;
  /** Herdr's count of the pane's state changes: a new chance to ask. */
  stateSeq?: number;
  /**
   * Counts the times this browser started showing the view: a view switch,
   * the pane becoming active, the page becoming visible.
   */
  viewSeq?: number;
  chat: {
    owner: AgentChatOwner;
    phase: AgentChatPhase;
    status: AgentChatStatus;
    session_id: string | null;
    queue: number;
  } | null;
  /** A handover this browser asked for is still running. */
  handing: boolean;
  /**
   * Counts the retries of a refused takeover: what refused it (a dialog,
   * text in Claude's prompt box) may go without Herdr's state changing.
   */
  retry?: number;
};

/** What this showing of the view asked last, and how it went. */
export type OwnershipAttempt = {
  showing: string;
  /** It had its way (asked and accepted, or found so): done asking. */
  ok: boolean;
  /** The state it was refused in: asked again once that changes. */
  state: string;
};

export type OwnershipRequest = {
  to: AgentChatOwner;
  /** Changes whenever it should be asked again. */
  key: string;
  attempt: OwnershipAttempt;
};

/** Whether conversation mode holds the session (or is taking or giving it). */
export function conversationOwns(
  chat: Pick<NonNullable<OwnershipInput["chat"]>, "phase"> | null | undefined,
): boolean {
  return !!chat && chat.phase !== "terminal";
}

/**
 * One look at the pane: what to ask the bridge for now, if anything, and
 * what to remember of this showing for the next look.
 */
export function ownershipStep(
  input: OwnershipInput,
  last: OwnershipAttempt | null,
): { request: OwnershipRequest | null; last: OwnershipAttempt | null } {
  const { chat } = input;
  if (input.agent !== "claude" || !chat || input.handing || !input.visible)
    return { request: null, last };
  const showing = JSON.stringify([input.view, input.viewSeq ?? 0]);
  const mine = last?.showing === showing ? last : null;
  if (mine?.ok) return { request: null, last };
  // Already where this view wants it: done, whoever did it.
  const settled =
    input.view === "chat"
      ? chat.phase !== "terminal"
      : chat.phase === "terminal" || chat.phase === "to_terminal";
  if (settled) return { request: null, last: { showing, ok: true, state: "" } };
  let to: AgentChatOwner | null = null;
  if (input.view === "chat") {
    const kind = agentStateKind(input.agentStatus);
    // Never while a turn runs, or a question waits: it would be lost.
    if (chat.phase === "terminal" && (kind === "idle" || kind === "done"))
      to = "conversation";
  } else if (
    chat.phase === "conversation" &&
    (chat.status === "idle" || chat.status === "stopped") &&
    chat.queue === 0
  )
    to = "terminal";
  if (!to) return { request: null, last };
  const state = JSON.stringify([
    input.stateSeq ?? null,
    chat.phase,
    chat.status,
    chat.session_id,
    to === "conversation" ? (input.retry ?? 0) : 0,
  ]);
  if (mine && mine.state === state) return { request: null, last };
  return {
    request: {
      to,
      key: JSON.stringify([to, showing, state]),
      attempt: { showing, ok: true, state },
    },
    last,
  };
}

/** What to ask the bridge for now, if anything. */
export function ownershipRequest(
  input: OwnershipInput,
  last: OwnershipAttempt | null = null,
): OwnershipRequest | null {
  return ownershipStep(input, last).request;
}

/** The chat header's owner line: who has the session, and why not. */
export function ownershipLabel(args: {
  chat: { phase: AgentChatPhase; status: AgentChatStatus } | null;
  refusal: string | null;
  handing: AgentChatOwner | null;
}): {
  label: string;
  detail: string | null;
  tone: "terminal" | "conversation" | "busy";
} {
  const { chat, refusal, handing } = args;
  if (handing === "conversation" || chat?.phase === "to_conversation")
    return {
      label: "Taking over",
      detail: "Closing Claude in the terminal",
      tone: "busy",
    };
  if (handing === "terminal" || chat?.phase === "to_terminal")
    return {
      label: "Handing back",
      detail: "Resuming Claude in the terminal",
      tone: "busy",
    };
  if (chat?.phase === "conversation")
    return {
      label: "Conversation mode",
      detail: refusal,
      tone: "conversation",
    };
  return { label: "Terminal", detail: refusal, tone: "terminal" };
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
  return `Running ${activity}`;
}
