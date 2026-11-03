import { describe, expect, test } from "bun:test";
import { atScrollEnd, type FollowScroller, followScroll } from "./followScroll";

/** A list 100 px tall whose content grows by hand. */
function list(height = 300) {
  const listeners = new Set<() => void>();
  let changed: () => void = () => {};
  const element = {
    scrollTop: 0,
    scrollHeight: height,
    clientHeight: 100,
    addEventListener: (_: "scroll", listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: "scroll", listener: () => void) =>
      listeners.delete(listener),
  } satisfies FollowScroller;
  return {
    element,
    /** The reader scrolls to `top`. */
    scroll(top: number) {
      element.scrollTop = top;
      for (const listener of listeners) listener();
    },
    /** A message comes, or streamed words make the last one longer. */
    grow(by: number) {
      element.scrollHeight += by;
      changed();
    },
    watch: (_: FollowScroller, onChange: () => void) => {
      changed = onChange;
      return () => {
        changed = () => {};
      };
    },
    listeners,
  };
}

describe("followScroll", () => {
  test("at its end within a little slack", () => {
    expect(
      atScrollEnd({ scrollTop: 200, scrollHeight: 300, clientHeight: 100 }),
    ).toBe(true);
    expect(
      atScrollEnd({ scrollTop: 180, scrollHeight: 300, clientHeight: 100 }),
    ).toBe(true);
    expect(
      atScrollEnd({ scrollTop: 100, scrollHeight: 300, clientHeight: 100 }),
    ).toBe(false);
  });

  test("starts at the newest and follows what comes", () => {
    const shown = list();
    const seen: boolean[] = [];
    followScroll(
      shown.element,
      (following) => seen.push(following),
      shown.watch,
    );
    expect(shown.element.scrollTop).toBe(200);
    shown.grow(50);
    expect(shown.element.scrollTop).toBe(250);
    // Streamed words, a few pixels at a time.
    shown.grow(5);
    shown.grow(5);
    expect(shown.element.scrollTop).toBe(260);
    expect(seen).toEqual([]);
  });

  test("scrolled up to read: stays put, until back at the end", () => {
    const shown = list();
    const seen: boolean[] = [];
    followScroll(
      shown.element,
      (following) => seen.push(following),
      shown.watch,
    );
    shown.scroll(40);
    expect(seen).toEqual([false]);
    shown.grow(120);
    expect(shown.element.scrollTop).toBe(40);
    // Back at the end by hand: it follows again.
    shown.scroll(shown.element.scrollHeight - 100);
    expect(seen).toEqual([false, true]);
    shown.grow(30);
    expect(shown.element.scrollTop).toBe(350);
  });

  test("jump goes to the newest and follows again", () => {
    const shown = list();
    const seen: boolean[] = [];
    const follow = followScroll(
      shown.element,
      (following) => seen.push(following),
      shown.watch,
    );
    shown.scroll(0);
    shown.grow(100);
    expect(shown.element.scrollTop).toBe(0);
    follow.jump();
    expect(shown.element.scrollTop).toBe(300);
    expect(seen).toEqual([false, true]);
    shown.grow(10);
    expect(shown.element.scrollTop).toBe(310);
  });

  test("stop lets the list go", () => {
    const shown = list();
    const follow = followScroll(shown.element, () => {}, shown.watch);
    follow.stop();
    expect(shown.listeners.size).toBe(0);
    shown.grow(100);
    expect(shown.element.scrollTop).toBe(200);
  });
});
