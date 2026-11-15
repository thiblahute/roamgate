import { Menu, Minimize2, Shrink } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openAppMenu } from "../configurationOpen";
import { shortcutTitle } from "../shortcutPreferences";

/**
 * A header's place for Zen's way out (ZenDock): the end of its right-hand
 * group, whose buttons show words (`labels`) or only icons, in their class.
 */
type Dock = {
  element: HTMLElement;
  labels: boolean;
  buttonClassName: string;
  iconSize: number;
  order: number;
};

const docks = new Set<Dock>();
const dockListeners = new Set<() => void>();
let dockOrder = 0;

function docksChanged() {
  for (const listener of [...dockListeners]) listener();
}

/** How far down the screen a header still counts as the top one. */
const TOP_EDGE = 80;

/** The group a dock ends. */
const hostOf = (dock: Dock) => dock.element.parentElement;

/**
 * The dock of the header at the top of the screen, shown and uncovered; the
 * latest of several wins. None: the way out hangs from the top edge.
 */
function topZenDock(): Dock | null {
  const latestFirst = [...docks].sort((a, b) => b.order - a.order);
  for (const dock of latestFirst) {
    const host = hostOf(dock);
    if (!host?.isConnected) continue;
    if (typeof host.checkVisibility === "function" && !host.checkVisibility())
      continue;
    const box = host.getBoundingClientRect();
    if (box.top > TOP_EDGE) continue;
    // Under another view (an overlay, the expanded inspector): not this one.
    // Zen's top bar only slides over it for a while (hover, focus).
    const hit =
      box.width > 0 && box.height > 0 && document.elementFromPoint
        ? document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          )
        : null;
    if (hit && !host.contains(hit) && !hit.closest(".zen-island, .topbar"))
      continue;
    return dock;
  }
  return null;
}

/**
 * Where Zen's way out goes in a header that can sit at the top of the
 * screen: at the end of the header's right-hand group. In Zen, Exit Zen and
 * the menu then show there as that group's buttons, after a divider,
 * instead of hanging over the header.
 */
export function ZenDock({
  labels = false,
  buttonClassName = "",
  iconSize = 14,
}: {
  /** The group's buttons show words: Exit Zen shows its own. */
  labels?: boolean;
  /** The group's buttons' class. */
  buttonClassName?: string;
  iconSize?: number;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const dock: Dock = {
      element,
      labels,
      buttonClassName,
      iconSize,
      order: ++dockOrder,
    };
    docks.add(dock);
    docksChanged();
    return () => {
      docks.delete(dock);
      docksChanged();
    };
  }, [labels, buttonClassName, iconSize]);
  return <span ref={ref} className="zen-dock" data-zen-dock="" />;
}

/** The dock Zen's way out is in, followed as headers come and go. */
function useTopZenDock() {
  const [dock, setDock] = useState<Dock | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const pick = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setDock(topZenDock()));
    };
    // A header hidden, shown or moved resizes its group, or ends a
    // transition (Zen's own layout change, a sliding view).
    const resizes =
      typeof ResizeObserver === "function" ? new ResizeObserver(pick) : null;
    const watch = () => {
      resizes?.disconnect();
      for (const each of docks) {
        const host = hostOf(each);
        if (host) resizes?.observe(host);
      }
      setDock(topZenDock());
      pick();
    };
    watch();
    dockListeners.add(watch);
    window.addEventListener("resize", pick);
    document.addEventListener("transitionend", pick, true);
    return () => {
      cancelAnimationFrame(frame);
      dockListeners.delete(watch);
      window.removeEventListener("resize", pick);
      document.removeEventListener("transitionend", pick, true);
      resizes?.disconnect();
    };
  }, []);
  return dock;
}

/**
 * Zen's way out and the application menu, opened without leaving Zen, so
 * what lives there (Activity, Configuration...) is one click away instead of
 * a hover on the tab and a trip to the hidden top bar's far end. A header at
 * the top of the screen holds them as its own buttons (ZenDock); without
 * one they hang as a tab from the top edge (or sit in the call's strip).
 */
export function ZenIsland({ onExit }: { onExit: () => void }) {
  const dock = useTopZenDock();
  const exitTitle = shortcutTitle("Exit Zen mode", "zen.toggle");
  if (dock) {
    const buttonClass = dock.buttonClassName;
    return createPortal(
      <span className="zen-dock-island" role="group" aria-label="Zen mode">
        <span className="zen-dock-divider" aria-hidden="true" />
        <button
          type="button"
          className={`${buttonClass} zen-dock-exit`.trim()}
          title={exitTitle}
          aria-label={exitTitle}
          onClick={onExit}
        >
          {/* Not Minimize2: a header may have that already (the inspector's
              Restore). */}
          <Shrink size={dock.iconSize} aria-hidden="true" />
          {dock.labels ? <span>Exit Zen</span> : null}
        </button>
        <button
          type="button"
          className={`${buttonClass} zen-island-menu`.trim()}
          title="Menu"
          aria-label="Menu"
          onClick={openAppMenu}
        >
          <Menu size={dock.iconSize} aria-hidden="true" />
        </button>
      </span>,
      dock.element,
    );
  }
  return (
    <div className="zen-island" role="group" aria-label="Zen mode">
      <button
        type="button"
        className="zen-island-button"
        title={exitTitle}
        aria-label={exitTitle}
        onClick={onExit}
      >
        <Minimize2 size={13} aria-hidden="true" />
        <span>Exit Zen</span>
      </button>
      <span className="zen-island-divider" aria-hidden="true" />
      <button
        type="button"
        className="zen-island-button zen-island-menu"
        title="Menu"
        aria-label="Menu"
        onClick={openAppMenu}
      >
        <Menu size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
