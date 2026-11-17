/*
 * Where a small floating box (a menu, a chip's details) opens next to the
 * button it belongs to: under it, or over it when the room is there and not
 * under, moved sideways to stay within the window (8 px from its edges),
 * never wider or taller than the room it has.
 */

export type FloatingBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type FloatingPlace = {
  left: number;
  top: number;
  /** Set when the box had to be narrowed to fit the window. */
  width?: number;
  maxHeight: number;
};

const MARGIN = 8;
const GAP = 4;

/**
 * The place, in the window's pixels, of a box of `size` opened from
 * `anchor`: its right edge on the anchor's (`end`, a menu at a row's end)
 * or its left edge (`start`).
 */
export function floatingPlace(
  anchor: FloatingBox,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "start" | "end" = "end",
): FloatingPlace {
  const room = Math.max(0, viewport.width - 2 * MARGIN);
  const width = Math.min(size.width, room);
  const wanted = align === "end" ? anchor.right - width : anchor.left;
  const left = Math.max(
    MARGIN,
    Math.min(wanted, viewport.width - MARGIN - width),
  );
  const below = Math.max(0, viewport.height - anchor.bottom - GAP - MARGIN);
  const above = Math.max(0, anchor.top - GAP - MARGIN);
  const under = size.height <= below || below >= above;
  const height = Math.min(size.height, under ? below : above);
  return {
    left: Math.round(left),
    top: Math.round(under ? anchor.bottom + GAP : anchor.top - GAP - height),
    ...(width < size.width ? { width: Math.floor(width) } : {}),
    maxHeight: Math.floor(under ? below : above),
  };
}

/**
 * Puts a `position: fixed` box at `place` (window pixels). A fixed box is
 * placed against its containing block, which an ancestor with a transform
 * or `container-type` makes something else than the window, and the page's
 * zoom scales its pixels: the box is moved by what it missed, measured.
 */
export function placeFixed(element: HTMLElement, place: FloatingPlace) {
  const style = element.style;
  style.left = `${place.left}px`;
  style.top = `${place.top}px`;
  style.right = "auto";
  style.bottom = "auto";
  if (place.width !== undefined) style.width = `${place.width}px`;
  const box = element.getBoundingClientRect();
  const scale =
    element.offsetWidth > 0 && box.width > 0
      ? box.width / element.offsetWidth
      : 1;
  style.maxHeight = `${place.maxHeight / scale}px`;
  if (place.width !== undefined) style.width = `${place.width / scale}px`;
  const dx = (place.left - box.left) / scale;
  const dy = (place.top - box.top) / scale;
  if (Math.abs(dx) >= 0.5) style.left = `${place.left + dx}px`;
  if (Math.abs(dy) >= 0.5) style.top = `${place.top + dy}px`;
}

/** The window's size, the visual viewport's on a phone (its keyboard out). */
export function viewportSize(): { width: number; height: number } {
  const visual = window.visualViewport;
  return {
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  };
}
