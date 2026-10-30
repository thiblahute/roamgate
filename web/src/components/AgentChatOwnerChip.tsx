import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentChatOwner, AgentChatState } from "../../../shared/agentChat";
import { ownershipLabel } from "../agentChatOwnership";
import type { ConnectionClient } from "../api";
import { useConversationSwitch } from "../conversationSwitch";

/**
 * The mode line of a Claude chat or history, when there is something to
 * say: a switch on its way, a refused Open in terminal and why, or in the
 * History inspector of a terminal-mode pane "Terminal mode" with the user's
 * own switch. A session simply in conversation mode shows nothing: its chat
 * says so. While Claude is busy in the terminal the switch is armed
 * instead: it goes once Herdr reports the turn over, unless cancelled; with
 * background work running it waits for that work (conversationSwitch.ts).
 */
export function AgentChatOwnerChip({
  client,
  paneId,
  chat,
  refusal,
  handing,
  agentStatus,
  retryMs,
  retryMaxMs,
}: {
  client: ConnectionClient;
  paneId: string;
  chat: AgentChatState;
  refusal: string | null;
  handing: AgentChatOwner | null;
  /** Herdr's status of the pane's agent: whether the terminal is busy. */
  agentStatus: string | undefined;
  /** The first and the longest wait between asks while background work runs. */
  retryMs?: number;
  retryMaxMs?: number;
}) {
  const inTerminal = chat.phase === "terminal" && !handing;
  const inConversation = chat.phase === "conversation" && !handing;
  const switching = useConversationSwitch({
    client,
    paneId,
    phase: chat.phase,
    handing: !!handing,
    agentStatus,
    retryMs,
    retryMaxMs,
  });
  // A refused Open in terminal says why, as text (a phone has no hover),
  // until put away or refused again.
  const [putAway, setPutAway] = useState<string | null>(null);
  useEffect(() => {
    if (!refusal) setPutAway(null);
  }, [refusal]);
  const armed = switching.state === "armed" || switching.state === "waiting";
  const owner = ownershipLabel({
    chat,
    refusal: inConversation && refusal === putAway ? null : refusal,
    handing,
  });
  if (!owner) return null;
  const refused = owner.tone === "conversation";
  // Busy: the switch's own wording says why it waits.
  const detail =
    owner.tone === "terminal" && (switching.busy || armed)
      ? null
      : owner.detail;
  return (
    <span
      className={`agent-chat-owner is-${owner.tone}${refused ? " has-refusal" : ""}`}
      role="status"
      title={detail ?? owner.label}
    >
      {owner.label}
      {detail && owner.tone === "terminal" ? <small>{detail}</small> : null}
      {detail && refused ? (
        <>
          <span className="agent-chat-owner-reason">{detail}</span>
          <button
            type="button"
            className="agent-chat-owner-close ghost"
            aria-label="Put this away"
            title="Put this away"
            onClick={() => setPutAway(refusal)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </>
      ) : null}
      {inTerminal && armed ? (
        <>
          <small>
            {switching.state === "waiting"
              ? "Waiting for background tasks to finish"
              : "Switching when Claude is done"}
            {"…"}
          </small>
          <button
            type="button"
            className="agent-chat-owner-switch ghost"
            onClick={switching.cancel}
          >
            Cancel
          </button>
        </>
      ) : inTerminal ? (
        <button
          type="button"
          className="agent-chat-owner-switch ghost"
          title={
            switching.busy
              ? "Switch to conversation mode once Claude's turn ends"
              : "Hand this session to conversation mode"
          }
          onClick={switching.request}
        >
          {switching.busy
            ? "Switch to conversation mode when idle"
            : "Switch to conversation mode"}
        </button>
      ) : null}
    </span>
  );
}
