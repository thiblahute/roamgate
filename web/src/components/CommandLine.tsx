import { useState } from "react";
import "./CommandLine.css";

/*
 * The Vim-like prompt at a view's bottom edge, the review pane's: `:` for a
 * command (Tab / Shift+Tab go through the completions) or `/` for a search.
 * Enter runs what is typed; Esc, or Backspace on nothing, leaves it.
 */
export function CommandLine({
  kind,
  completions = () => [],
  onSubmit,
  onCancel,
  onBlur,
}: {
  kind: ":" | "/";
  /** The commands Tab goes through for what is typed, as [name, note]. */
  completions?: (typed: string) => [string, string][];
  /** Enter, with what is typed. */
  onSubmit: (text: string) => void;
  /** Esc, or Backspace on an empty line. */
  onCancel: () => void;
  /** The prompt lost the focus. */
  onBlur: () => void;
}) {
  const [line, setLine] = useState({ text: "", wild: -1, typed: "" });
  const shown = kind === ":" ? completions(line.typed) : [];
  return (
    <div className="review-cmdline">
      {kind}
      <input
        className="review-cmd"
        aria-label={kind === ":" ? "Command" : "Search"}
        // biome-ignore lint/a11y/noAutofocus: a Vim prompt takes the keys
        autoFocus
        value={line.text}
        onChange={(event) =>
          setLine({
            text: event.target.value,
            typed: event.target.value,
            wild: -1,
          })
        }
        onBlur={onBlur}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit(line.text);
          } else if (
            event.key === "Escape" ||
            (event.key === "Backspace" && !line.text)
          ) {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Tab" && kind === ":") {
            event.preventDefault();
            if (!shown.length) return;
            const step = event.shiftKey ? -1 : 1;
            const wild = (line.wild + step + shown.length) % shown.length;
            setLine({ ...line, wild, text: shown[wild]![0] });
          }
        }}
      />
      {kind === ":" ? (
        <span className="review-wild">
          {shown.map(([name, description], index) => (
            <span
              key={name}
              className={`wild-item${index === line.wild ? " on" : ""}`}
            >
              {name}
              <span className="note"> {description}</span>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
