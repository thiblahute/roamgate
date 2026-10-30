import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HistoryEntry as AgentHistoryEntry } from "./agentHistory";
import { REWIND_MODES, type RewindMode } from "../claudeRewind";
import { formatUiDateTime } from "../uiLocale";
import "./AgentRewindSheet.css";

/**
 * /rewind typed in a Claude chat: the user's messages, newest first, then
 * what to restore to before the one picked. ↑/↓ (or k/j) and Enter, the
 * restore's number, Esc to go back; or a tap.
 */
export function AgentRewindSheet({
  entries,
  onRewind,
  onClose,
}: {
  entries: readonly AgentHistoryEntry[];
  onRewind: (entry: AgentHistoryEntry, mode: RewindMode) => void;
  onClose: () => void;
}) {
  const messages = useMemo(
    () =>
      entries
        .filter(
          (entry) =>
            entry.kind === "message" &&
            entry.role === "user" &&
            !entry.queued &&
            !entry.compact_summary &&
            !entry.injected &&
            // A command run (/model haiku), not a message to rewind to.
            !entry.text.startsWith("<command-"),
        )
        .reverse(),
    [entries],
  );
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<AgentHistoryEntry | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => sheetRef.current?.focus(), [picked]);
  useEffect(() => {
    sheetRef.current
      ?.querySelector(`[data-rewind-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const choose = (mode: RewindMode) => {
    if (!picked) return;
    onClose();
    onRewind(picked, mode);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key;
    if (key === "Escape") {
      if (picked) setPicked(null);
      else onClose();
    } else if (picked) {
      const mode = REWIND_MODES[Number(key) - 1];
      if (mode) choose(mode.mode);
      else return;
    } else if (key === "ArrowDown" || key === "j")
      setCursor((at) => Math.min(messages.length - 1, at + 1));
    else if (key === "ArrowUp" || key === "k")
      setCursor((at) => Math.max(0, at - 1));
    else if (key === "Enter" && messages[cursor]) setPicked(messages[cursor]);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      className="agent-rewind-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="agent-rewind-sheet"
        role="dialog"
        aria-label="Rewind"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="agent-rewind-head">
          <strong>
            {picked
              ? "Restore to before this message"
              : "Rewind to before which message?"}
          </strong>
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        {picked ? (
          <div className="agent-rewind-confirm">
            <p className="agent-rewind-quote">{picked.text}</p>
            {REWIND_MODES.map(({ mode, label }, index) => (
              <button
                key={mode}
                type="button"
                className="agent-rewind-mode"
                onClick={() => choose(mode)}
              >
                <kbd>{index + 1}</kbd> {label}
              </button>
            ))}
            <button
              type="button"
              className="agent-rewind-mode"
              onClick={() => setPicked(null)}
            >
              <kbd>Esc</kbd> Back
            </button>
          </div>
        ) : messages.length ? (
          <ul className="agent-rewind-list">
            {messages.map((entry, index) => (
              <li key={`${entry.id}@${entry.sent_at}`}>
                <button
                  type="button"
                  data-rewind-index={index}
                  className={index === cursor ? "is-current" : undefined}
                  onPointerEnter={() => setCursor(index)}
                  onClick={() => setPicked(entry)}
                >
                  <span>{entry.text}</span>
                  <time dateTime={entry.sent_at}>
                    {formatUiDateTime(entry.sent_at)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="agent-rewind-empty">No message to rewind to yet.</p>
        )}
      </div>
    </div>
  );
}
