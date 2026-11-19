import { Pause, X } from "lucide-react";
import { useState } from "react";

/**
 * A slim line over a pane's terminal while an agent conversation waits
 * there stopped, as a shell job (the chat's Ctrl+Z): typing `fg` at the
 * shell's prompt brings it back, and so does its button (a phone has no
 * shell habit to lean on). It never covers the terminal.
 */
export function SuspendedConversationStrip({
  title,
  onForeground,
}: {
  /** The conversation's title when it was stopped. */
  title?: string;
  /** Brings it back: `fg` typed into the pane's shell. */
  onForeground: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const [asking, setAsking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [putAway, setPutAway] = useState(false);
  if (putAway) return null;
  return (
    <div className="terminal-mode-strip terminal-suspended-strip" role="status">
      <Pause size={14} aria-hidden="true" />
      <span>
        {refusal ? (
          <>Not brought back: {refusal}</>
        ) : (
          <>
            Claude{title ? <> ({title})</> : null} is suspended in this shell;
            type <kbd>fg</kbd> or press the fg button to bring it back.
          </>
        )}
      </span>
      <button
        type="button"
        className="ghost"
        disabled={asking}
        title="Bring the conversation back (fg in the pane's shell)"
        onClick={() => {
          setAsking(true);
          setRefusal(null);
          void onForeground().then((result) => {
            setAsking(false);
            if (!result.ok) setRefusal(result.reason);
          });
        }}
      >
        fg
      </button>
      <button
        type="button"
        className="ghost terminal-mode-strip-close"
        aria-label="Put this away"
        title="Put this away"
        onClick={() => setPutAway(true)}
      >
        <X size={13} />
      </button>
    </div>
  );
}
