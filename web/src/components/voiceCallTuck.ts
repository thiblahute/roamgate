import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useRef, useState } from "react";

/*
 * On a touch screen, the call card swipes down into a slim bar (the call goes
 * on: who is speaking, mute, hang up) and the bar swipes up, or is tapped,
 * back into the card. The card follows the finger while it drags, and snaps
 * to the nearer state on release: past a distance, or on a quick flick. A
 * mouse never drags it: on a desktop the card stays as it is.
 */

/** How far a touch moves before it is a drag rather than a tap. */
export const TUCK_SLOP = 8;
/** How far the card is dragged down before a release tucks it. */
export const TUCK_DISTANCE = 56;
/** How far the bar is dragged up before a release brings the card back. */
export const UNTUCK_DISTANCE = 28;
/** A flick this fast (px per ms) is enough, whatever the distance. */
export const TUCK_FLING = 0.5;
/** Only the last moments of a drag count for its speed. */
const FLING_WINDOW_MS = 100;

/**
 * Where the card is drawn for a drag of `dy` px (down is positive): with the
 * finger the way it can go (down for the card, up for the bar), held back the
 * other way.
 */
export function tuckDragOffset(tucked: boolean, dy: number): number {
  const along = tucked ? Math.min(dy, 0) : Math.max(dy, 0);
  return along + (dy - along) / 5;
}

/**
 * Whether the card ends tucked when a drag of `dy` px is released at
 * `velocity` px per ms (down is positive).
 */
export function tuckReleased(
  tucked: boolean,
  dy: number,
  velocity: number,
): boolean {
  if (tucked) {
    const up = -dy >= UNTUCK_DISTANCE || velocity <= -TUCK_FLING;
    return !up;
  }
  return dy >= TUCK_DISTANCE || (velocity >= TUCK_FLING && dy > TUCK_SLOP);
}

/**
 * Whether a touch at `target` scrolls something rather than the card: an
 * element between it and the card that scrolls and is not at its top.
 */
export function touchScrollsInside(
  target: EventTarget | null,
  card: Element,
): boolean {
  for (
    let node = target instanceof Element ? target : null;
    node && node !== card;
    node = node.parentElement
  ) {
    if (node.scrollHeight > node.clientHeight && node.scrollTop > 0) {
      return true;
    }
  }
  return false;
}

type Drag = {
  pointer: number;
  x: number;
  y: number;
  dragging: boolean;
  samples: { y: number; at: number }[];
};

/** How fast the drag moved at its end, in px per ms (down is positive). */
function dragVelocity(samples: Drag["samples"]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const first =
    samples.find((sample) => last.at - sample.at <= FLING_WINDOW_MS) ?? last;
  const ms = last.at - first.at;
  return ms > 0 ? (last.y - first.y) / ms : 0;
}

/**
 * The card's tucked state and the pointer handlers that swipe it. `tucked`
 * starts at `initial`; `onChange` hears each change, to remember it.
 */
export function useCallTuck(
  initial: boolean,
  onChange?: (tucked: boolean) => void,
) {
  const [tucked, setTuckedState] = useState(initial);
  const [offset, setOffset] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  // A drag ends with a click on whatever button it started on: not a tap.
  const swallowClick = useRef(false);

  const setTucked = (next: boolean) => {
    setTuckedState(next);
    onChange?.(next);
  };

  const end = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    if (!current.dragging) return;
    setOffset(null);
    // A cancelled drag ends with no click.
    if (cancelled) return;
    swallowClick.current = true;
    const dy = event.clientY - current.y;
    current.samples.push({ y: event.clientY, at: Date.now() });
    const next = tuckReleased(tucked, dy, dragVelocity(current.samples));
    if (next !== tucked) setTucked(next);
  };

  const handlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      swallowClick.current = false;
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      if (touchScrollsInside(event.target, event.currentTarget)) return;
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
        samples: [{ y: event.clientY, at: Date.now() }],
      };
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.dragging) {
        if (Math.abs(dy) < TUCK_SLOP) {
          // Sideways first: not a swipe of the card.
          if (Math.abs(dx) >= TUCK_SLOP) drag.current = null;
          return;
        }
        if (Math.abs(dx) > Math.abs(dy)) {
          drag.current = null;
          return;
        }
        current.dragging = true;
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // The pointer is already gone: the drag ends with its cancel.
        }
      }
      const at = Date.now();
      current.samples.push({ y: event.clientY, at });
      while (
        current.samples.length > 2 &&
        at - current.samples[0].at > FLING_WINDOW_MS
      ) {
        current.samples.shift();
      }
      setOffset(tuckDragOffset(tucked, dy));
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      end(event, false);
    },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
      end(event, true);
    },
    onClickCapture(event: ReactMouseEvent<HTMLElement>) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  const style =
    offset === null
      ? undefined
      : ({ "--voice-tuck-drag": `${offset}px` } as CSSProperties);
  return {
    tucked,
    setTucked,
    dragging: offset !== null,
    style,
    handlers,
  };
}
