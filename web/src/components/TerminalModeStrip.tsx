import { MessagesSquare, X } from "lucide-react";
import {
  type AgentChatOtherWriter,
  otherWriterDoing,
  otherWriterWhy,
} from "../../../shared/agentChat";
import type { ConversationSwitchState } from "../conversationSwitch";

/**
 * A slim line over a terminal-mode Claude's terminal, while the user's
 * switch to conversation mode waits (Claude busy, background work), was
 * refused, or messages wait for conversation mode (the bridge kept them
 * when its holder went away). It never covers the terminal.
 *
 * Refused because another Claude runs the session in another pane, it says
 * where and why that blocks the switch, takes the user there, and offers
 * to quit that one when it is idle (never while it works or asks).
 */
export function TerminalModeStrip({
  state,
  refusal,
  writer = null,
  writerPlace = "",
  queued,
  onSwitch,
  onCancel,
  onDismiss,
  onGoToWriter,
  onQuitWriter,
}: {
  state: ConversationSwitchState;
  /** Why the last switch was refused, until put away. */
  refusal: string | null;
  /** The other pane's Claude it was refused for, if that was why. */
  writer?: AgentChatOtherWriter | null;
  /** Where that pane is, as the sidebar names it. */
  writerPlace?: string;
  /** Messages waiting for conversation mode. */
  queued: number;
  onSwitch: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  /** Shows the other pane. */
  onGoToWriter?: () => void;
  /** Quits the other pane's idle Claude, then switches. */
  onQuitWriter?: () => void;
}) {
  const waits = `${queued === 1 ? "A message waits" : `${queued} messages wait`} for conversation mode`;
  const close = (
    <button
      type="button"
      className="ghost terminal-mode-strip-close"
      aria-label="Put this away"
      title="Put this away"
      onClick={onDismiss}
    >
      <X size={13} />
    </button>
  );
  return (
    <div className="terminal-mode-strip" role="status">
      <MessagesSquare size={14} aria-hidden="true" />
      {state === "asking" ? (
        <span>Switching to conversation mode{"…"}</span>
      ) : state === "armed" || state === "waiting" ? (
        <>
          <span>
            {state === "waiting"
              ? "Waiting for background tasks to finish, then switching to conversation mode"
              : "Switching to conversation mode when Claude is done"}
            {"…"}
          </span>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : refusal && writer ? (
        <>
          <span>
            Still in terminal mode. This session is also open in{" "}
            <strong>{writerPlace || `pane ${writer.pane_id}`}</strong>
            {otherWriterDoing(writer)}. {otherWriterWhy(writer)}.
            {writer.quit_refusal
              ? ` It did not quit: ${writer.quit_refusal}.`
              : ""}
            {queued ? ` ${waits}.` : ""}
          </span>
          {onGoToWriter ? (
            <button type="button" className="ghost" onClick={onGoToWriter}>
              Go to it
            </button>
          ) : null}
          {writer.status === "idle" && onQuitWriter ? (
            <button type="button" className="ghost" onClick={onQuitWriter}>
              Quit it and switch
            </button>
          ) : (
            <button type="button" className="ghost" onClick={onSwitch}>
              Try again
            </button>
          )}
          {close}
        </>
      ) : refusal ? (
        <>
          <span>
            Still in terminal mode: {refusal}
            {queued ? `. ${waits}.` : ""}
          </span>
          <button type="button" className="ghost" onClick={onSwitch}>
            Try again
          </button>
          {close}
        </>
      ) : (
        <>
          <span>{waits}</span>
          <button type="button" className="ghost" onClick={onSwitch}>
            Switch to conversation mode
          </button>
        </>
      )}
    </div>
  );
}
