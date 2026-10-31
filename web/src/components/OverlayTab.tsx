import {
  Columns2,
  Maximize2,
  Minimize2,
  PanelTop,
  Power,
  Rows2,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  dragOverlayGeometry,
  type OverlayEdges,
  type OverlayGeometry,
  clampOverlayGeometry,
  maximizedOverlayRect,
  onOverlayFullscreenToggle,
  type OverlayRect,
  readOverlayGeometry,
  readOverlayMaximized,
  resetOverlayGeometry,
  writeOverlayGeometry,
} from "../overlayGeometry";
import "./OverlayTab.css";

const HANDLES: { name: string; edges: OverlayEdges }[] = [
  { name: "n", edges: { top: true } },
  { name: "s", edges: { bottom: true } },
  { name: "e", edges: { right: true } },
  { name: "w", edges: { left: true } },
  { name: "ne", edges: { top: true, right: true } },
  { name: "nw", edges: { top: true, left: true } },
  { name: "se", edges: { bottom: true, right: true } },
  { name: "sw", edges: { bottom: true, left: true } },
];

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The main area (right of the sidebar, below the header), followed while needed. */
function useMainAreaRect(enabled: boolean): OverlayRect | null {
  const [rect, setRect] = useState<OverlayRect | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const main = document.querySelector<HTMLElement>("main.main");
    const measure = () => {
      const box = main?.getBoundingClientRect();
      setRect(
        maximizedOverlayRect(
          box
            ? {
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }
            : null,
          viewportSize(),
        ),
      );
    };
    measure();
    const observer =
      main && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (main) observer?.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled]);
  return enabled ? rect : null;
}

/**
 * The frame of a workspace's overlay tab: Roamgate's own title bar and
 * buttons around the tab's panes (the splits among them: over its
 * terminals they would hide text). On a desktop it floats above the displayed
 * tab and can be moved by its title bar and resized from any edge or corner,
 * or maximised over the main area and restored; its place, and whether it is
 * maximised, are remembered in this browser. On a phone it is a sheet over
 * the terminal area. Hidden, it stays mounted so its terminals stay attached.
 */
export function OverlayTabFrame({
  open,
  sheet,
  aboveReview = false,
  title,
  shortcut,
  onHide,
  onBackToTabs,
  onStop,
  onSplit,
  children,
}: {
  open: boolean;
  /** Phone layout: fill the terminal area, no move or resize. */
  sheet: boolean;
  /** Shown over an open review: it floats above the review. */
  aboveReview?: boolean;
  title: string;
  /** The toggle's key, as the shortcut list shows it. */
  shortcut: string;
  onHide: () => void;
  onBackToTabs: () => void;
  onStop: () => void;
  /** Splits the overlay's selected pane; absent while it has none. */
  onSplit?: (direction: "right" | "down") => void;
  children: ReactNode;
}) {
  const [geometry, setGeometry] = useState<OverlayGeometry>(() =>
    clampOverlayGeometry(readOverlayGeometry(), viewportSize()),
  );
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(readOverlayMaximized);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const fills = maximized && !sheet;
  const mainArea = useMainAreaRect(fills);
  const toggleMaximized = () =>
    setMaximized((current) => {
      writeOverlayGeometry(geometryRef.current, !current);
      return !current;
    });
  const toggleRef = useRef(toggleMaximized);
  toggleRef.current = toggleMaximized;

  // The fullscreen shortcut; a phone's sheet already fills its screen.
  useEffect(() => {
    if (sheet) return;
    return onOverlayFullscreenToggle(() => toggleRef.current());
  }, [sheet]);

  // A smaller window keeps the overlay inside it.
  useEffect(() => {
    if (sheet) return;
    const onResize = () =>
      setGeometry((current) => clampOverlayGeometry(current, viewportSize()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sheet]);

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    edges: OverlayEdges | null,
  ) => {
    if (event.button !== 0 || sheet || maximized) return;
    if (!edges && (event.target as Element).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners below still finish the drag.
    }
    const start = geometryRef.current;
    const startX = event.clientX;
    const startY = event.clientY;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setDragging(true);
    // The last position, kept here: a render may not have caught up when the
    // pointer is released.
    let latest = start;
    const move = (moveEvent: PointerEvent) => {
      const viewport = viewportSize();
      latest = dragOverlayGeometry(
        start,
        edges,
        (moveEvent.clientX - startX) / Math.max(1, viewport.width),
        (moveEvent.clientY - startY) / Math.max(1, viewport.height),
        viewport,
      );
      setGeometry(latest);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      document.body.style.userSelect = previousUserSelect;
      setDragging(false);
      if (latest !== start) writeOverlayGeometry(latest);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
  };

  const style = sheet
    ? undefined
    : fills
      ? mainArea
        ? {
            left: `${mainArea.left}px`,
            top: `${mainArea.top}px`,
            width: `${mainArea.width}px`,
            height: `${mainArea.height}px`,
          }
        : { inset: 0 }
      : {
          left: `${geometry.x * 100}%`,
          top: `${geometry.y * 100}%`,
          width: `${geometry.width * 100}%`,
          height: `${geometry.height * 100}%`,
        };

  return (
    <section
      className={`overlay-tab ${sheet ? "is-sheet" : "is-floating"}${
        fills ? " is-maximized" : ""
      }${aboveReview ? " is-above-review" : ""}`}
      data-open={open ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      aria-hidden={open ? undefined : true}
      aria-label={`${title} overlay`}
      style={style}
    >
      <header
        className="overlay-tab-header"
        onPointerDown={(event) => startDrag(event, null)}
        onDoubleClick={(event) => {
          if (sheet || (event.target as Element).closest("button")) return;
          if (maximized) {
            toggleMaximized();
            return;
          }
          setGeometry(
            clampOverlayGeometry(resetOverlayGeometry(), viewportSize()),
          );
        }}
        title={
          sheet
            ? undefined
            : maximized
              ? "Double-click to restore"
              : "Drag to move, double-click to recentre"
        }
      >
        <span className="overlay-tab-title">
          {title}
          {shortcut && !sheet ? (
            <span className="overlay-tab-shortcut"> · {shortcut}</span>
          ) : null}
        </span>
        <div className="overlay-tab-actions">
          {onSplit ? (
            <>
              <button
                type="button"
                className="overlay-tab-action"
                onClick={() => onSplit("right")}
                title="Split pane right"
                aria-label="Split pane right"
              >
                <Columns2 size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="overlay-tab-action"
                onClick={() => onSplit("down")}
                title="Split pane down"
                aria-label="Split pane down"
              >
                <Rows2 size={14} aria-hidden="true" />
              </button>
              <span className="overlay-tab-divider" aria-hidden="true" />
            </>
          ) : null}
          {sheet ? null : (
            <button
              type="button"
              className="overlay-tab-action"
              onClick={toggleMaximized}
              title={
                maximized
                  ? "Restore: back to its floating size"
                  : "Maximise: fill the main area"
              }
              aria-label={
                maximized ? "Restore the overlay" : "Maximise the overlay"
              }
              aria-pressed={maximized}
            >
              {maximized ? (
                <Minimize2 size={14} aria-hidden="true" />
              ) : (
                <Maximize2 size={14} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            className="overlay-tab-action"
            onClick={onBackToTabs}
            title="Back to tabs: show this tab in the tab strip again"
            aria-label="Back to tabs"
          >
            <PanelTop size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="overlay-tab-action is-danger"
            onClick={onStop}
            title="Stop: close this tab and its shells"
            aria-label="Stop the overlay tab"
          >
            <Power size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="overlay-tab-action"
            onClick={onHide}
            title={shortcut ? `Hide (${shortcut})` : "Hide"}
            aria-label={shortcut ? `Hide (${shortcut})` : "Hide"}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="overlay-tab-surface">{children}</div>
      {sheet || fills
        ? null
        : HANDLES.map((handle) => (
            <div
              key={handle.name}
              className={`overlay-tab-handle is-${handle.name}`}
              aria-hidden="true"
              onPointerDown={(event) => startDrag(event, handle.edges)}
            />
          ))}
    </section>
  );
}
