import { useState } from "react";
import { formatUiDateTime } from "../uiLocale";
import type { HistoryEntry } from "./agentHistory";
import "./ChatRewoundNotice.css";

/**
 * Where a rewind cut the conversation: one line, like the other notices,
 * with the user's messages it cut a tap away. They are no longer part of
 * the conversation, and Claude never sees them again unless they are sent
 * again (or put back in the box to edit first).
 */
export function ChatRewoundNotice({
  entry,
  sequence,
  onSendAgain,
  onEditAgain,
}: {
  entry: HistoryEntry;
  sequence: number;
  onSendAgain?: (text: string) => Promise<unknown> | void;
  onEditAgain?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // What was sent again from here, so a second tap does not send it twice.
  const [sent, setSent] = useState<ReadonlySet<number>>(() => new Set());
  const messages = entry.rewound ?? [];
  return (
    <div
      className="agent-history-chat-injected is-rewound"
      data-sequence={sequence}
      data-bubble-id={entry.id}
      data-entry-id={entry.id}
    >
      <div className="agent-history-chat-compacted">
        <span title={entry.injected?.label}>{entry.injected?.label}</span>
        {messages.length ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
          >
            {open ? "Hide" : messages.length === 1 ? "Show it" : "Show them"}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="agent-history-chat-rewound-list">
          {messages.map((message, index) => (
            <li
              // The messages of a notice never change order.
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
              key={index}
              className="agent-history-chat-rewound-message"
            >
              <p>{message.text}</p>
              <div className="agent-history-chat-rewound-actions">
                <time dateTime={message.sent_at} title={message.sent_at}>
                  {formatUiDateTime(message.sent_at)}
                </time>
                {onEditAgain ? (
                  <button
                    type="button"
                    onClick={() => onEditAgain(message.text)}
                    title="Put it back in the message box, to edit and send"
                  >
                    Edit
                  </button>
                ) : null}
                {onSendAgain ? (
                  <button
                    type="button"
                    disabled={sent.has(index)}
                    onClick={() => {
                      setSent((current) => new Set(current).add(index));
                      void Promise.resolve(onSendAgain(message.text)).catch(
                        () =>
                          setSent((current) => {
                            const next = new Set(current);
                            next.delete(index);
                            return next;
                          }),
                      );
                    }}
                    title="Send it to Claude again, as a new message"
                  >
                    {sent.has(index) ? "Sent again" : "Send again"}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
