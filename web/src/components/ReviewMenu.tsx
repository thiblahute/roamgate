import { type ReactNode, useRef, useState } from "react";
import { useLayoutPreferences } from "../layoutPreferences";
import { useSystemBack } from "../systemBack";
import { MobileSheetHandle } from "./MobileSheetHandle";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./ReviewMenu.css";

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
 * The list opens over the page (out of the head, whose row clips and may
 * scroll), next to its button and within the window; on a phone, as the
 * app menu's bottom sheet.
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
  /** The page the list opens over (the app's); the head in a bare mount. */
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const { mobile } = useLayoutPreferences();
  const sheet = open && mobile;
  const rootRef = useRef<HTMLSpanElement | null>(null);
  /** An item was picked: its action, not the button, gets the focus. */
  const picked = useRef(false);
  const shown = items.filter((item): item is ReviewMenuItem => !!item);
  const close = () => setOpen(false);
  useSystemBack(sheet, close, "popup");

  return (
    <span
      ref={rootRef}
      className={`rv-menu-root ${className}`}
      // What the menu holds, for tests reading every reachable control.
      data-menu-items={shown.map((item) => item.label).join("\n")}
    >
      <Popover
        open={open}
        onOpenChange={(value) => {
          if (value)
            setLayer(
              rootRef.current?.closest<HTMLElement>(".app") ?? rootRef.current,
            );
          setOpen(value);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`btn ghost rv-sm rv-menu-button${open ? " on" : ""}`}
            aria-haspopup="menu"
            title={title}
          >
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent
          container={layer}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={`rv-menu${sheet ? " is-sheet mobile-sheet" : ""}`}
          role="menu"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement)
              .querySelector<HTMLButtonElement>(
                "button[role^='menuitem']:not(:disabled)",
              )
              ?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            if (picked.current) event.preventDefault();
            picked.current = false;
          }}
          onKeyDown={(event) => {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button[role^='menuitem']:not(:disabled)",
              ),
            );
            const at = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === "ArrowDown" || event.key === "j")
              buttons[(at + 1) % buttons.length]?.focus();
            else if (event.key === "ArrowUp" || event.key === "k")
              buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
            else if (event.key === "Escape") close();
            else {
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
          {sheet ? (
            <MobileSheetHandle label={`Close ${title}`} onClose={close} />
          ) : null}
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
                picked.current = true;
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
        </PopoverContent>
      </Popover>
    </span>
  );
}
