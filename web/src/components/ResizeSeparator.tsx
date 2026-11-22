import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
} from "react";

/** The keys a separator steps with. */
export type ResizeSeparatorKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

const STEP_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

/**
 * A vertical separator dragged sideways: the pointer is captured while it
 * moves, each move says the value at the pointer, the release commits it;
 * a double-click resets; the arrows, Home and End step it. What the value
 * means (a ratio, a width) is the caller's: `at` reads it from the
 * pointer, `step` from a key.
 */
export function ResizeSeparator({
  className,
  label,
  title = "Drag to resize; double-click to reset",
  controls,
  value,
  valueMin,
  valueMax,
  valueNow,
  at,
  step,
  onChange,
  onCommit,
  onReset,
}: {
  className: string;
  label: string;
  title?: string;
  controls?: string;
  value: number;
  valueMin?: number;
  valueMax?: number;
  valueNow?: number;
  /** The value with the pointer at clientX. */
  at: (clientX: number, separator: HTMLDivElement) => number;
  /** The value a key steps to from the current one. */
  step: (
    key: ResizeSeparatorKey,
    current: number,
    separator: HTMLDivElement,
  ) => number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
}) {
  const dragRef = useRef(value);
  dragRef.current = value;

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const next = at(event.clientX, event.currentTarget);
    dragRef.current = next;
    onChange(next);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!STEP_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = step(
      event.key as ResizeSeparatorKey,
      dragRef.current,
      event.currentTarget,
    );
    dragRef.current = next;
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      className={className}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      {...(controls ? { "aria-controls": controls } : {})}
      {...(valueMin !== undefined ? { "aria-valuemin": valueMin } : {})}
      {...(valueMax !== undefined ? { "aria-valuemax": valueMax } : {})}
      {...(valueNow !== undefined ? { "aria-valuenow": valueNow } : {})}
      title={title}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        updateFromPointer(event);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(dragRef.current);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onCommit(dragRef.current);
      }}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}
