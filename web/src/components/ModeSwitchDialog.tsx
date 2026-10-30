import { useSyncExternalStore } from "react";
import { requestAgentChatHandover } from "../agentChat";
import { useConnectionClient } from "../useConnectionClient";
import { requestConversationSwitch } from "../conversationSwitch";
import { ConfirmDialog } from "./ModalDialogs";

/**
 * The phone's offer to switch a Claude pane's mode, from its bottom bar or
 * its menus: one view per mode, so showing the chat of a terminal-mode
 * Claude, or its terminal in conversation mode, is a switch the user
 * confirms, never a view laid over the other mode.
 */
export type ModeSwitchOffer = {
  connectionId: string;
  paneId: string;
  to: "conversation" | "terminal";
  /** Claude works or waits on a question: the switch waits for it. */
  busy: boolean;
};

let offer: ModeSwitchOffer | null = null;
const listeners = new Set<() => void>();

function set(next: ModeSwitchOffer | null) {
  offer = next;
  for (const listener of listeners) listener();
}

/** Asks the user whether to switch the pane's mode. */
export function offerModeSwitch(next: ModeSwitchOffer) {
  set(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the dialog says for an offer. */
export function modeSwitchText(next: ModeSwitchOffer): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  if (next.to === "conversation")
    return {
      title: "Switch to conversation mode?",
      message: next.busy
        ? "Claude is in terminal mode and busy in its terminal. Conversation mode shows it as a chat; it switches once Claude's turn ends."
        : "Claude is in terminal mode. Conversation mode shows it as a chat; Terminal, in More options, brings the terminal back.",
      confirmLabel: next.busy
        ? "Switch when Claude is done"
        : "Switch to conversation mode",
    };
  return {
    title: "Open in terminal?",
    message: next.busy
      ? "Claude is in conversation mode and in the middle of a turn: it opens in the terminal once the turn ends and its queue is empty."
      : "Claude leaves conversation mode and resumes in the pane's terminal.",
    confirmLabel: "Open in terminal",
  };
}

/** The offer's dialog: mounted once, for the connection shown. */
export function ModeSwitchDialog() {
  const client = useConnectionClient();
  const shown = useSyncExternalStore(
    subscribe,
    () => offer,
    () => offer,
  );
  const current =
    shown && shown.connectionId === client.connectionId ? shown : null;
  const text = current ? modeSwitchText(current) : null;
  return (
    <ConfirmDialog
      open={!!current}
      title={text?.title ?? ""}
      message={text?.message ?? ""}
      confirmLabel={text?.confirmLabel}
      onClose={() => set(null)}
      onConfirm={() => {
        set(null);
        if (!current) return;
        if (current.to === "conversation")
          requestConversationSwitch(current.connectionId, current.paneId);
        else void requestAgentChatHandover(client, current.paneId, "terminal");
      }}
    />
  );
}
