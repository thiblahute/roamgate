import { type ReactNode, useEffect, useRef, useState } from "react";

/** One entry of a review header menu; a toggle shows a check when on. */
export type ReviewMenuItem = {
  label: string;
  /** Its key, shown on the right. */
  hint?: string;
  title?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * A button opening a short list of actions under it: the review header's
 * less used actions, out of the way. Arrows move, Enter picks, Esc closes.
 */
export function ReviewMenu({
  label,
  title,
  className = "",
  items,
}: {
  label: ReactNode;
  title: string;
  className?: string;
  items: readonly (ReviewMenuItem | null | false)[];
}) {
  const [open, setOpen] = useState(false);
  /** Under its button, placed on the window: a scrolling head clips nothing. */
  const [place, setPlace] = useState<{ top: number; right: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const shown = items.filter((item): item is ReviewMenuItem => !!item);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    rootRef.current
      ?.querySelector<HTMLButtonElement>(".rv-menu button:not(:disabled)")
      ?.focus();
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  return (
    <span ref={rootRef} className={`rv-menu-root ${className}`}>
      <button
        type="button"
        className={`btn ghost rv-sm rv-menu-button${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setPlace({
            top: box.bottom + 4,
            right: Math.max(8, window.innerWidth - box.right),
          });
          setOpen((value) => !value);
        }}
      >
        {label}
      </button>
      {open ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: keys handled below
        <div
          className="rv-menu"
          role="menu"
          style={place ?? undefined}
          onKeyDown={(event) => {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const at = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === "ArrowDown" || event.key === "j")
              buttons[(at + 1) % buttons.length]?.focus();
            else if (event.key === "ArrowUp" || event.key === "k")
              buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
            else if (event.key === "Escape") {
              setOpen(false);
              rootRef.current
                ?.querySelector<HTMLButtonElement>(".rv-menu-button")
                ?.focus();
            } else {
              // Other letters are not the review's keys while it is open.
              if (event.key.length === 1 && event.key !== " ")
                event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
          }}
          // The review's own keys stay out of the menu.
          onKeyUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {shown.map((item) => (
            <button
              key={item.label}
              type="button"
              role={
                item.checked === undefined ? "menuitem" : "menuitemcheckbox"
              }
              aria-checked={item.checked}
              title={item.title}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="rv-menu-check" aria-hidden="true">
                {item.checked ? "✓" : ""}
              </span>
              <span className="rv-menu-label">{item.label}</span>
              {item.hint ? <kbd>{item.hint}</kbd> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
