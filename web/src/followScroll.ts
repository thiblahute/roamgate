import { useCallback, useEffect, useRef, useState } from "react";

/** How far from its end a list still counts as at its end, in pixels. */
export const FOLLOW_SLACK_PX = 24;

/** What a scrolled list needs: its metrics and its scroll events. */
export type FollowScroller = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: "scroll", listener: () => void): void;
  removeEventListener(type: "scroll", listener: () => void): void;
};

export function atScrollEnd(
  element: Pick<FollowScroller, "scrollTop" | "scrollHeight" | "clientHeight">,
  slack = FOLLOW_SLACK_PX,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= slack
  );
}

/**
 * Watches what a list shows change (rows added, text streamed in, rows
 * growing); the function that stops watching back.
 */
export type ContentWatch = (
  element: FollowScroller,
  changed: () => void,
) => () => void;

const domContentWatch: ContentWatch = (element, changed) => {
  const stops: (() => void)[] = [];
  if (typeof Element === "undefined" || !(element instanceof Element))
    return () => {};
  // Rows that grow once drawn (a long answer wrapping, a late font).
  const resize =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(changed) : null;
  const watchRows = () => {
    if (!resize) return;
    for (const child of element.children) resize.observe(child);
  };
  if (resize) {
    resize.observe(element);
    watchRows();
    stops.push(() => resize.disconnect());
  }
  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      watchRows();
      changed();
    });
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    stops.push(() => observer.disconnect());
  }
  return () => {
    for (const stop of stops) stop();
  };
};

/**
 * Keeps a list at its newest (its end) as what it shows grows, while the
 * reader is there: scrolled up to read, it stays put and `following` goes
 * false until they come back to the end, by hand or with `jump()`.
 */
export function followScroll(
  element: FollowScroller,
  onFollowing: (following: boolean) => void,
  watch: ContentWatch = domContentWatch,
): { jump: () => void; stop: () => void } {
  let following = true;
  const set = (next: boolean) => {
    if (following === next) return;
    following = next;
    onFollowing(next);
  };
  const toEnd = () => {
    element.scrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
  };
  const onScroll = () => set(atScrollEnd(element));
  const onChange = () => {
    if (following) toEnd();
  };
  element.addEventListener("scroll", onScroll);
  const unwatch = watch(element, onChange);
  toEnd();
  return {
    jump: () => {
      set(true);
      toEnd();
    },
    stop: () => {
      element.removeEventListener("scroll", onScroll);
      unwatch();
    },
  };
}

/**
 * followScroll for a React list: a ref for the scrolled element, whether
 * it follows the newest, and the way back to it.
 */
export function useFollowScroll<T extends HTMLElement>(): {
  ref: (element: T | null) => void;
  following: boolean;
  jump: () => void;
} {
  const [following, setFollowing] = useState(true);
  const controlRef = useRef<ReturnType<typeof followScroll> | null>(null);
  const ref = useCallback((element: T | null) => {
    controlRef.current?.stop();
    controlRef.current = null;
    setFollowing(true);
    if (element) controlRef.current = followScroll(element, setFollowing);
  }, []);
  useEffect(() => () => controlRef.current?.stop(), []);
  const jump = useCallback(() => controlRef.current?.jump(), []);
  return { ref, following, jump };
}
