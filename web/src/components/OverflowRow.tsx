import { EllipsisVertical } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import "./OverflowRow.css";

/** An item's height in the open list, its rows' pitch. */
const ROW_PITCH = 32;
/** The list's inner padding. */
const PANEL_PAD = 4;
/** The list's least width. */
const PANEL_MIN_WIDTH = 200;

/**
 * A row of controls that is never wider than its room: the controls that
 * do not fit go, measured as the row is drawn and resized (never by a
 * breakpoint guessed in advance), behind a ⋮ button at the row's end,
 * which lists them under it. They stay the very controls they are (their
 * state, their own menus, every key that clicks them): only where they are
 * drawn changes.
 *
 * Each child element is one control. Attributes on it say how it goes:
 * - `data-overflow-keep`: always in the row;
 * - `data-overflow-priority="n"`: the higher, the longer it stays (0 by
 *   default; between equals, the last goes first);
 * - `data-overflow-shrink`: it shrinks to its `min-width` before anything
 *   goes (a name, a status line), counted at that width;
 * - `aria-label` on a control drawn with an icon only: its name beside the
 *   icon in the list.
 */
export function OverflowRow({
  children,
  className = "",
  moreLabel = "More controls",
  moreClassName = "",
}: {
  children: ReactNode;
  className?: string;
  /** The ⋮ button's name. */
  moreLabel?: string;
  /** The ⋮ button's own class, to look like the row's buttons. */
  moreClassName?: string;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const focusFirst = useRef(false);

  /** Where the open list goes: under ⋮, within its positioned ancestor. */
  const place = useCallback(() => {
    const row = rowRef.current;
    const more = moreRef.current;
    const parent = more?.offsetParent;
    if (!row || !more || !(parent instanceof HTMLElement)) return;
    const width = Number.parseFloat(
      row.style.getPropertyValue("--overflow-width") || `${PANEL_MIN_WIDTH}`,
    );
    const box = parent.getBoundingClientRect();
    const button = more.getBoundingClientRect();
    const inner = box.width - parent.clientLeft * 2;
    let right = box.right - parent.clientLeft - button.right;
    // Never past the ancestor's start: a narrow row's list goes left.
    if (inner - right - width < PANEL_PAD) right = inner - width - PANEL_PAD;
    row.style.setProperty(
      "--overflow-top",
      `${button.bottom - box.top - parent.clientTop + 4}px`,
    );
    row.style.setProperty("--overflow-right", `${Math.max(0, right)}px`);
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const view = row?.ownerDocument.defaultView;
    if (!row || !view?.getComputedStyle) return;
    const getComputedStyle = view.getComputedStyle.bind(view);
    // The slot it is in fits it to its room, not by scrolling sideways.
    const host = row.parentElement?.closest<HTMLElement>(
      "[data-overflow-host]",
    );
    host?.setAttribute("data-overflow-fits", "");
    /** Each control's width in the row, kept while it is in the list. */
    const widths = new WeakMap<Element, number>();
    let moreWidth = 28;
    let frame = 0;
    /** The row's controls: its children, and those of a child drawn as
        its children's box only (display: contents). */
    const controls = () => {
      const found: HTMLElement[] = [];
      const walk = (parent: Element) => {
        for (const element of Array.from(parent.children)) {
          if (
            !(element instanceof HTMLElement) ||
            element.hasAttribute("data-overflow-own")
          )
            continue;
          if (getComputedStyle(element).display === "contents") walk(element);
          else found.push(element);
        }
      };
      walk(row);
      return found;
    };
    const measure = () => {
      frame = 0;
      const list = controls();
      const listOpen = openRef.current;
      for (const element of list) {
        // In the row, or out of it while the list is closed (drawn at its
        // own width then, as in the row): its width now.
        if (!element.hasAttribute("data-overflowed") || !listOpen)
          widths.set(element, element.getBoundingClientRect().width);
      }
      const more = moreRef.current;
      if (more && !more.hidden) moreWidth = more.getBoundingClientRect().width;
      const style = getComputedStyle(row);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const room =
        row.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0);
      const width = (element: HTMLElement) => {
        if (element.hasAttribute("data-overflow-shrink"))
          return Number.parseFloat(getComputedStyle(element).minWidth) || 0;
        return widths.get(element) ?? 0;
      };
      // Not drawn (display: none): not a control here.
      const drawn = list.filter(
        (element) =>
          (widths.get(element) ?? 0) > 0 ||
          element.hasAttribute("data-overflow-shrink"),
      );
      const span = (elements: readonly HTMLElement[]) =>
        elements.reduce((sum, element) => sum + width(element), 0) +
        gap * Math.max(0, elements.length - 1);
      const out = new Set<HTMLElement>();
      if (span(drawn) > room + 0.5) {
        const fits = room - moreWidth - gap;
        const order = drawn
          .map((element, index) => ({
            element,
            index,
            priority: Number(element.dataset.overflowPriority ?? 0) || 0,
          }))
          .filter(({ element }) => !element.hasAttribute("data-overflow-keep"))
          .sort((a, b) => a.priority - b.priority || b.index - a.index);
        let kept = drawn;
        for (const { element } of order) {
          if (span(kept) <= fits) break;
          out.add(element);
          kept = kept.filter((each) => each !== element);
        }
        // A wide control gone may leave room for smaller ones that went
        // before it: back in, the most wanted first.
        for (const { element } of [...order].reverse()) {
          if (!out.has(element) || span([...kept, element]) > fits) continue;
          out.delete(element);
          kept = [...kept, element];
        }
      }
      let index = 0;
      let widest = 0;
      for (const element of list) {
        if (out.has(element)) {
          if (!element.hasAttribute("data-overflowed"))
            element.setAttribute("data-overflowed", "");
          element.style.setProperty("--overflow-index", String(index));
          index += 1;
          widest = Math.max(widest, widths.get(element) ?? 0);
        } else if (element.hasAttribute("data-overflowed")) {
          element.removeAttribute("data-overflowed");
          element.style.removeProperty("--overflow-index");
        }
      }
      row.style.setProperty(
        "--overflow-width",
        `${Math.max(PANEL_MIN_WIDTH, Math.ceil(widest) + 2 * PANEL_PAD)}px`,
      );
      row.style.setProperty("--overflow-count", String(out.size));
      row.style.setProperty("--overflow-pitch", `${ROW_PITCH}px`);
      setHiddenCount(out.size);
      if (listOpen) place();
    };
    const schedule = () => {
      if (!frame) frame = view.requestAnimationFrame(measure);
    };
    const Observer = (
      view as unknown as { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver;
    const resized = Observer
      ? new Observer(schedule)
      : { observe() {}, disconnect() {} };
    const watch = () => {
      resized.disconnect();
      resized.observe(row);
      for (const element of controls()) resized.observe(element);
    };
    const Mutations = (
      view as unknown as { MutationObserver?: typeof MutationObserver }
    ).MutationObserver;
    const changed = new (Mutations ?? MutationObserver)(() => {
      watch();
      schedule();
    });
    changed.observe(row, { childList: true, subtree: true });
    watch();
    measure();
    return () => {
      if (frame) view.cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
      host?.removeAttribute("data-overflow-fits");
    };
  }, [place]);

  useEffect(() => {
    if (!hiddenCount && open) setOpen(false);
  }, [hiddenCount, open]);

  // Open: placed, the first control focused when opened by key; a press
  // elsewhere closes it (not in a menu one of its controls opened).
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const row = rowRef.current;
    if (focusFirst.current)
      row
        ?.querySelector<HTMLElement>(
          "[data-overflowed]:is(button, a, input, select):not(:disabled), [data-overflowed] :is(button, a, input, select, [tabindex]):not(:disabled)",
        )
        ?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || row?.contains(target)) return;
      if (
        target.closest(
          '[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [role="listbox"]',
        )
      )
        return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || event.key !== "Escape") return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("[data-overflowed]"))
      return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    moreRef.current?.focus({ preventScroll: true });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc in its list
    <div
      ref={rowRef}
      className={`overflow-row ${className}${open ? " is-open" : ""}`}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        // A control picked from the list: done with the list, unless it
        // opens a menu of its own.
        if (!open) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const control = target.closest("button, a");
        if (
          !control ||
          !control.closest("[data-overflowed]") ||
          control.hasAttribute("aria-haspopup")
        )
          return;
        setOpen(false);
      }}
    >
      {children}
      <button
        ref={moreRef}
        type="button"
        data-overflow-own=""
        hidden={!hiddenCount}
        className={`overflow-row-more ${moreClassName}`}
        aria-expanded={open}
        aria-label={moreLabel}
        title={`${moreLabel}: the ${hiddenCount} this row has no room for`}
        onClick={(event) => {
          // Opened from the keyboard (no pointer: detail 0): its first
          // control takes the focus.
          focusFirst.current = event.detail === 0;
          setOpen((value) => !value);
        }}
      >
        <EllipsisVertical size={14} aria-hidden="true" />
      </button>
      {open && hiddenCount ? (
        <div
          className="overflow-row-panel"
          data-overflow-own=""
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
