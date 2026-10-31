import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clampOverlayGeometry,
  DEFAULT_OVERLAY_GEOMETRY,
  dragOverlayGeometry,
  maximizedOverlayRect,
  OVERLAY_GEOMETRY_STORAGE_KEY,
  onOverlayFullscreenToggle,
  parseOverlayGeometry,
  parseOverlayMaximized,
  readOverlayGeometry,
  readOverlayMaximized,
  requestOverlayFullscreenToggle,
  resetOverlayGeometry,
  writeOverlayGeometry,
} from "./overlayGeometry";

const previousLocalStorage = globalThis.localStorage;
let storedValues = new Map<string, string>();

beforeEach(() => {
  storedValues = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return storedValues.size;
      },
      key: (index: number) => [...storedValues.keys()][index] ?? null,
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
      clear: () => storedValues.clear(),
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousLocalStorage,
  });
});

const viewport = { width: 1000, height: 800 };
const close = (value: number) => Math.round(value * 1000) / 1000;
const rounded = (g: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  x: close(g.x),
  y: close(g.y),
  width: close(g.width),
  height: close(g.height),
});

describe("overlay geometry", () => {
  test("defaults to about 86% by 82%, centred", () => {
    const g = readOverlayGeometry();
    expect(g).toEqual(DEFAULT_OVERLAY_GEOMETRY);
    expect(close(g.x * 2 + g.width)).toBe(1);
    expect(close(g.y * 2 + g.height)).toBe(1);
  });

  test("is remembered in this browser and can be reset", () => {
    const g = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
    writeOverlayGeometry(g);
    expect(readOverlayGeometry()).toEqual(g);
    expect(resetOverlayGeometry()).toEqual(DEFAULT_OVERLAY_GEOMETRY);
    expect(storedValues.has(`roamgate:${OVERLAY_GEOMETRY_STORAGE_KEY}`)).toBe(
      false,
    );
    expect(readOverlayGeometry()).toEqual(DEFAULT_OVERLAY_GEOMETRY);
  });

  test("falls back to the default for malformed stored values", () => {
    expect(parseOverlayGeometry("{")).toEqual(DEFAULT_OVERLAY_GEOMETRY);
    expect(parseOverlayGeometry('{"x":0,"y":0,"width":0,"height":1}')).toEqual(
      DEFAULT_OVERLAY_GEOMETRY,
    );
    // Out of the window: pulled back in.
    expect(
      parseOverlayGeometry('{"x":0.9,"y":-1,"width":0.5,"height":2}'),
    ).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });

  test("resizing an edge keeps the opposite edge in place", () => {
    const start = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(
      rounded(dragOverlayGeometry(start, { left: true }, 0.05, 0, viewport)),
    ).toEqual({ x: 0.15, y: 0.1, width: 0.45, height: 0.5 });
    expect(
      rounded(
        dragOverlayGeometry(
          start,
          { bottom: true, right: true },
          0.1,
          0.2,
          viewport,
        ),
      ),
    ).toEqual({ x: 0.1, y: 0.1, width: 0.6, height: 0.7 });
  });

  test("never shrinks below the minimum or grows past the window", () => {
    const start = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const small = dragOverlayGeometry(start, { right: true }, -1, 0, viewport);
    expect(close(small.width * viewport.width)).toBe(320);
    expect(small.x).toBe(0.1);
    const big = dragOverlayGeometry(start, { top: true }, 0, -1, viewport);
    expect(rounded(big)).toEqual({ x: 0.1, y: 0, width: 0.5, height: 0.6 });
  });

  test("moving keeps the whole overlay inside the window", () => {
    const start = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(
      rounded(dragOverlayGeometry(start, null, 0.9, -0.9, viewport)),
    ).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });

  test("a window smaller than the minimum gets the whole window", () => {
    expect(
      clampOverlayGeometry(DEFAULT_OVERLAY_GEOMETRY, {
        width: 300,
        height: 150,
      }),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("maximised over the main area", () => {
  test("is remembered with the size, which restoring brings back", () => {
    const floating = { x: 0.2, y: 0.1, width: 0.5, height: 0.6 };
    writeOverlayGeometry(floating);
    expect(readOverlayMaximized()).toBe(false);
    writeOverlayGeometry(floating, true);
    expect(readOverlayMaximized()).toBe(true);
    // The floating size stays stored underneath.
    expect(readOverlayGeometry()).toEqual(floating);
    writeOverlayGeometry(floating, false);
    expect(readOverlayMaximized()).toBe(false);
    expect(readOverlayGeometry()).toEqual(floating);
    expect(
      JSON.parse(storedValues.get(`roamgate:${OVERLAY_GEOMETRY_STORAGE_KEY}`)!),
    ).toEqual(floating);
  });

  test("recentring forgets it, and nonsense reads as not maximised", () => {
    writeOverlayGeometry(DEFAULT_OVERLAY_GEOMETRY, true);
    resetOverlayGeometry();
    expect(readOverlayMaximized()).toBe(false);
    expect(parseOverlayMaximized(null)).toBe(false);
    expect(parseOverlayMaximized("{")).toBe(false);
    expect(parseOverlayMaximized('{"maximized":"yes"}')).toBe(false);
    expect(parseOverlayMaximized('{"maximized":true}')).toBe(true);
  });

  test("fills the main area, right of the sidebar and below the header", () => {
    expect(
      maximizedOverlayRect(
        { left: 284, top: 56, width: 716, height: 744 },
        viewport,
      ),
    ).toEqual({ left: 284, top: 56, width: 716, height: 744 });
  });

  test("stays inside the window, and falls back to all of it", () => {
    expect(
      maximizedOverlayRect(
        { left: 284, top: 56, width: 2000, height: 2000 },
        viewport,
      ),
    ).toEqual({ left: 284, top: 56, width: 716, height: 744 });
    const whole = { left: 0, top: 0, width: 1000, height: 800 };
    expect(maximizedOverlayRect(null, viewport)).toEqual(whole);
    expect(
      maximizedOverlayRect({ left: 0, top: 0, width: 0, height: 0 }, viewport),
    ).toEqual(whole);
    expect(
      maximizedOverlayRect(
        { left: 1200, top: 0, width: 100, height: 100 },
        viewport,
      ),
    ).toEqual(whole);
  });

  test("the shortcut reaches the frame while it listens", () => {
    let toggles = 0;
    const stop = onOverlayFullscreenToggle(() => toggles++);
    requestOverlayFullscreenToggle();
    stop();
    requestOverlayFullscreenToggle();
    expect(toggles).toBe(1);
  });
});
