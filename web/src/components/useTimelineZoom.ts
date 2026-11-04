import { type RefObject, useEffect, useRef, useState } from "react";
import {
  brushRange,
  panBy,
  type Range,
  wheelFactor,
  zoomAt,
} from "../timelineZoom";

/** A brush being drawn, in pixels from the surface's left edge. */
export type Brush = { left: number; width: number };

type Gesture =
  | { kind: "brush"; id: number; from: number; to: number }
  | {
      kind: "pan";
      id: number;
      x: number;
      range: Range;
      moved: boolean;
    }
  | {
      kind: "pinch";
      distance: number;
      at: number;
      range: Range;
    };

/** Moves under this many pixels are a click, not a drag. */
const DRAG_PX = 4;

/**
 * The zoom gestures of a day's timeline, on its surface (the chart):
 * - a drag across the axis (an element marked data-zoom-brush) zooms to it;
 * - Ctrl/Cmd + wheel, or a trackpad pinch, zooms around the pointer;
 * - zoomed, a drag on the lanes, a sideways wheel or Shift + wheel pans;
 * - on a phone, two fingers pinch and one drags sideways to pan.
 * The track (the axis's lane) gives the pixels the shown range spans.
 */
export function useTimelineZoom({
  surfaceRef,
  trackRef,
  range,
  bounds,
  minSpan,
  zoomed,
  onRange,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  trackRef: RefObject<HTMLElement | null>;
  range: Range;
  bounds: Range;
  minSpan: number;
  zoomed: boolean;
  onRange: (range: Range) => void;
}): Brush | null {
  const [brush, setBrush] = useState<Brush | null>(null);
  const latest = useRef({ range, bounds, minSpan, zoomed, onRange });
  latest.current = { range, bounds, minSpan, zoomed, onRange };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let gesture: Gesture | null = null;
    let swallowClick = false;

    const track = () => {
      const rect = trackRef.current?.getBoundingClientRect();
      return rect && rect.width > 0 ? rect : null;
    };
    const fraction = (x: number) => {
      const rect = track();
      return rect ? (x - rect.left) / rect.width : 0.5;
    };
    const showBrush = (from: number, to: number) => {
      const rect = track();
      const outer = surface.getBoundingClientRect();
      if (!rect) return;
      const clamp = (f: number) => Math.min(1, Math.max(0, f));
      const a = clamp(Math.min(from, to));
      const b = clamp(Math.max(from, to));
      setBrush({
        left: rect.left - outer.left + a * rect.width,
        width: (b - a) * rect.width,
      });
    };
    const pinchState = (): Gesture | null => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return null;
      return {
        kind: "pinch",
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        at: fraction((a.x + b.x) / 2),
        range: latest.current.range,
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest("button, a, input, select, textarea")) return;
      swallowClick = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        setBrush(null);
        gesture = pinchState();
        return;
      }
      if (pointers.size > 2) return;
      if (target?.closest("[data-zoom-brush]")) {
        const at = fraction(event.clientX);
        gesture = { kind: "brush", id: event.pointerId, from: at, to: at };
        surface.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      } else if (latest.current.zoomed) {
        gesture = {
          kind: "pan",
          id: event.pointerId,
          x: event.clientX,
          range: latest.current.range,
          moved: false,
        };
      }
    };

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const now = latest.current;
      if (gesture?.kind === "pinch") {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        now.onRange(
          zoomAt(
            gesture.range,
            now.bounds,
            gesture.distance / distance,
            gesture.at,
            now.minSpan,
          ),
        );
        event.preventDefault();
        return;
      }
      if (gesture?.kind === "brush" && gesture.id === event.pointerId) {
        gesture.to = fraction(event.clientX);
        showBrush(gesture.from, gesture.to);
        return;
      }
      if (gesture?.kind === "pan" && gesture.id === event.pointerId) {
        const dx = event.clientX - gesture.x;
        if (!gesture.moved && Math.abs(dx) < DRAG_PX) return;
        if (!gesture.moved) {
          gesture.moved = true;
          surface.setPointerCapture?.(event.pointerId);
          surface.classList.add("is-panning");
        }
        const rect = track();
        if (!rect) return;
        const span = gesture.range.end - gesture.range.start;
        now.onRange(
          panBy(gesture.range, now.bounds, (-dx / rect.width) * span),
        );
        event.preventDefault();
      }
    };

    const onUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      const now = latest.current;
      if (gesture?.kind === "brush" && gesture.id === event.pointerId) {
        const rect = track();
        const wide =
          rect && Math.abs(gesture.to - gesture.from) * rect.width >= DRAG_PX;
        if (wide && event.type === "pointerup") {
          now.onRange(
            brushRange(
              now.range,
              now.bounds,
              gesture.from,
              gesture.to,
              now.minSpan,
            ),
          );
          swallowClick = true;
        }
        setBrush(null);
        gesture = null;
        return;
      }
      if (gesture?.kind === "pan" && gesture.id === event.pointerId) {
        if (gesture.moved) swallowClick = true;
        surface.classList.remove("is-panning");
        gesture = null;
        return;
      }
      if (gesture?.kind === "pinch" && pointers.size < 2) {
        // The finger left keeps going as a pan, from where it is.
        const [rest] = [...pointers.entries()];
        gesture = rest
          ? {
              kind: "pan",
              id: rest[0],
              x: rest[1].x,
              range: now.range,
              moved: true,
            }
          : null;
        swallowClick = true;
      }
    };

    const onClick = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent) => {
      const now = latest.current;
      const rect = track();
      if (!rect) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        now.onRange(
          zoomAt(
            now.range,
            now.bounds,
            wheelFactor(event.deltaY),
            fraction(event.clientX),
            now.minSpan,
          ),
        );
        return;
      }
      if (!now.zoomed) return;
      const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!sideways && !event.shiftKey) return;
      event.preventDefault();
      const delta = sideways ? event.deltaX : event.deltaY;
      const span = now.range.end - now.range.start;
      now.onRange(panBy(now.range, now.bounds, (delta / rect.width) * span));
    };

    surface.addEventListener("pointerdown", onDown);
    surface.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerup", onUp);
    surface.addEventListener("pointercancel", onUp);
    surface.addEventListener("click", onClick, true);
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onUp);
      surface.removeEventListener("click", onClick, true);
      surface.removeEventListener("wheel", onWheel);
      surface.classList.remove("is-panning");
    };
  }, [surfaceRef, trackRef]);

  return brush;
}

/** An element's width, kept up to date (0 until it is laid out). */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** How many ticks fit a track this wide (a label is about 56 px). */
export function ticksFor(width: number) {
  return width > 0 ? Math.min(14, Math.max(3, Math.floor(width / 64))) : 8;
}
