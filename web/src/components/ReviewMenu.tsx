import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLayoutPreferences } from "../layoutPreferences";
import { useSystemBack } from "../systemBack";
import { floatingPlace, placeFixed, viewportSize } from "./floatingPlace";
import { MobileSheetHandle } from "./MobileSheetHandle";
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
  /** The page the list opens over (the app's); none in a bare mount. */
  const [layer, setLayer] = useState<Element | null>(null);
  const { mobile } = useLayoutPreferences();
  const sheet = open && mobile;
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const shown = items.filter((item): item is ReviewMenuItem => !!item);
  const close = () => {
    setOpen(false);
    rootRef.current
      ?.querySelector<HTMLButtonElement>(".rv-menu-button")
      ?.focus();
  };
  useSystemBack(sheet, close, "popup");

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const button = rootRef.current?.querySelector(".rv-menu-button");
    if (!open || sheet || !menu || !button) return;
    const place = () => {
      // Its natural size first, then where it fits.
      menu.style.maxHeight = "";
      menu.style.width = "";
      const box = menu.getBoundingClientRect();
      placeFixed(
        menu,
        floatingPlace(
          button.getBoundingClientRect(),
          { width: box.width, height: box.height },
          viewportSize(),
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open, sheet, layer]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    menuRef.current
      ?.querySelector<HTMLButtonElement>(
        "button[role^='menuitem']:not(:disabled)",
      )
      ?.focus({ preventScroll: true });
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const menu = open ? (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys handled below
    <div
      ref={menuRef}
      className={`rv-menu${sheet ? " is-sheet mobile-sheet" : ""}`}
      role="menu"
      onKeyDown={(event) => {
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button[role^='menuitem']:not(:disabled)",
          ),
        );
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
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
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
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
  ) : null;

  return (
    <span
      ref={rootRef}
      className={`rv-menu-root ${className}`}
      // What the menu holds, for tests reading every reachable control.
      data-menu-items={shown.map((item) => item.label).join("\n")}
    >
      <button
        type="button"
        className={`btn ghost rv-sm rv-menu-button${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => {
          setLayer(rootRef.current?.closest(".app") ?? null);
          setOpen((value) => !value);
        }}
      >
        {label}
      </button>
      {menu && layer ? createPortal(menu, layer) : menu}
    </span>
  );
}
