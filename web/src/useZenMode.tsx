import { Maximize2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * The review's chrome-free mode, shared by the review pane and the Files
 * preview: all the chrome away, just what is reviewed.
 */
export function useZenMode(): [boolean, () => void] {
  const [zen, setZen] = useState(false);
  const toggle = useCallback(() => setZen((value) => !value), []);
  return [zen, toggle];
}

/** Whether `o` or Esc may mean the mode: not typing in a box. */
export function zenKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  return !(
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

export function ZenButton({
  zen,
  onToggle,
  className = "",
  label = "Diff only",
  title = "Diff only: hide all the chrome, just the diff (o, :only; o or Esc brings it back)",
  size = 16,
  overflowPriority,
}: {
  zen: boolean;
  onToggle: () => void;
  className?: string;
  label?: string;
  title?: string;
  size?: number;
  /** In an OverflowRow: how long it stays in the row. */
  overflowPriority?: number;
}) {
  return (
    <button
      type="button"
      className={`${className}${zen ? " on" : ""}`}
      data-overflow-priority={overflowPriority}
      aria-pressed={zen}
      aria-label={label}
      title={title}
      onClick={onToggle}
    >
      <Maximize2 size={size} />
    </button>
  );
}

/** While the mode is on, Esc anywhere leaves it (typing aside). */
export function useZenEscape(zen: boolean, toggle: () => void) {
  useEffect(() => {
    if (!zen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && zenKeyTarget(event.target)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen, toggle]);
}
