import { roamgateLocalStorage } from "./browserStorage";

/**
 * Where the overlay tab floats, as fractions of the window so it follows the
 * window's size. Remembered per browser: a phone and a desktop each keep
 * their own.
 */
export type OverlayGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OverlayEdges = {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
};

export const OVERLAY_GEOMETRY_STORAGE_KEY = "overlayTabGeometry.v1";
/** About the size of Herdr Float's popup, centred. */
export const DEFAULT_OVERLAY_GEOMETRY: OverlayGeometry = {
  x: 0.07,
  y: 0.09,
  width: 0.86,
  height: 0.82,
};
/** Smallest overlay, in CSS pixels, before the window size is applied. */
export const OVERLAY_MIN_PX = { width: 320, height: 180 };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Keeps the overlay inside the window and at least the minimum size (or the
 * whole window when that is smaller).
 */
export function clampOverlayGeometry(
  geometry: OverlayGeometry,
  viewport: { width: number; height: number },
  minPx = OVERLAY_MIN_PX,
): OverlayGeometry {
  const minWidth = Math.min(1, minPx.width / Math.max(1, viewport.width));
  const minHeight = Math.min(1, minPx.height / Math.max(1, viewport.height));
  const width = Math.min(1, Math.max(minWidth, geometry.width));
  const height = Math.min(1, Math.max(minHeight, geometry.height));
  return {
    x: Math.min(1 - width, Math.max(0, geometry.x)),
    y: Math.min(1 - height, Math.max(0, geometry.y)),
    width,
    height,
  };
}

export function parseOverlayGeometry(raw: string | null): OverlayGeometry {
  if (!raw) return DEFAULT_OVERLAY_GEOMETRY;
  try {
    const value = JSON.parse(raw) as Partial<OverlayGeometry>;
    if (
      !finite(value.x) ||
      !finite(value.y) ||
      !finite(value.width) ||
      !finite(value.height) ||
      value.width <= 0 ||
      value.height <= 0
    )
      return DEFAULT_OVERLAY_GEOMETRY;
    return clampOverlayGeometry(
      { x: value.x, y: value.y, width: value.width, height: value.height },
      { width: 1, height: 1 },
      { width: 0, height: 0 },
    );
  } catch {
    return DEFAULT_OVERLAY_GEOMETRY;
  }
}

export function readOverlayGeometry(): OverlayGeometry {
  try {
    return parseOverlayGeometry(
      roamgateLocalStorage.getItem(OVERLAY_GEOMETRY_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_OVERLAY_GEOMETRY;
  }
}

/** Whether the overlay was left filling the main area, stored with its size. */
export function parseOverlayMaximized(raw: string | null): boolean {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { maximized?: unknown }).maximized === true;
  } catch {
    return false;
  }
}

export function readOverlayMaximized(): boolean {
  try {
    return parseOverlayMaximized(
      roamgateLocalStorage.getItem(OVERLAY_GEOMETRY_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}

/**
 * Stores the floating size and place, and whether it fills the main area:
 * maximised, the size it had stays stored, so restoring brings it back.
 */
export function writeOverlayGeometry(
  geometry: OverlayGeometry,
  maximized = false,
) {
  try {
    roamgateLocalStorage.setItem(
      OVERLAY_GEOMETRY_STORAGE_KEY,
      JSON.stringify(maximized ? { ...geometry, maximized } : geometry),
    );
  } catch {
    // The overlay still resizes; it just reopens at the last stored size.
  }
}

export type OverlayRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Where a maximised overlay sits, in CSS pixels: over the main area (right of
 * the sidebar, below the app header), else the whole window when that area
 * is not laid out.
 */
export function maximizedOverlayRect(
  main: OverlayRect | null,
  viewport: { width: number; height: number },
): OverlayRect {
  const whole = { left: 0, top: 0, ...viewport };
  if (!main || main.width <= 0 || main.height <= 0) return whole;
  const left = Math.max(0, Math.min(viewport.width, main.left));
  const top = Math.max(0, Math.min(viewport.height, main.top));
  const width = Math.min(viewport.width - left, main.width);
  const height = Math.min(viewport.height - top, main.height);
  return width > 0 && height > 0 ? { left, top, width, height } : whole;
}

type FullscreenListener = () => void;
const fullscreenListeners = new Set<FullscreenListener>();

/** The fullscreen shortcut asks the overlay's frame, which owns the state. */
export function requestOverlayFullscreenToggle() {
  for (const listener of fullscreenListeners) listener();
}

export function onOverlayFullscreenToggle(
  listener: FullscreenListener,
): () => void {
  fullscreenListeners.add(listener);
  return () => fullscreenListeners.delete(listener);
}

export function resetOverlayGeometry(): OverlayGeometry {
  try {
    roamgateLocalStorage.removeItem(OVERLAY_GEOMETRY_STORAGE_KEY);
  } catch {
    // Nothing stored to remove.
  }
  return DEFAULT_OVERLAY_GEOMETRY;
}

/**
 * Applies a pointer drag of (dx, dy) window fractions to the dragged edges,
 * or to the whole overlay when no edge is given (a move). Opposite edges stay
 * put, and the result is clamped to the window.
 */
export function dragOverlayGeometry(
  start: OverlayGeometry,
  edges: OverlayEdges | null,
  dx: number,
  dy: number,
  viewport: { width: number; height: number },
  minPx = OVERLAY_MIN_PX,
): OverlayGeometry {
  if (!edges)
    return clampOverlayGeometry(
      { ...start, x: start.x + dx, y: start.y + dy },
      viewport,
      minPx,
    );
  const minWidth = Math.min(1, minPx.width / Math.max(1, viewport.width));
  const minHeight = Math.min(1, minPx.height / Math.max(1, viewport.height));
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;
  if (edges.left) left = Math.min(right - minWidth, Math.max(0, left + dx));
  if (edges.right) right = Math.max(left + minWidth, Math.min(1, right + dx));
  if (edges.top) top = Math.min(bottom - minHeight, Math.max(0, top + dy));
  if (edges.bottom)
    bottom = Math.max(top + minHeight, Math.min(1, bottom + dy));
  return clampOverlayGeometry(
    { x: left, y: top, width: right - left, height: bottom - top },
    viewport,
    minPx,
  );
}
