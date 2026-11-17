import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * A long chat draws only the messages near the view. Mounting every bubble
 * of a conversation of hundreds of messages and tool calls took the page
 * for seconds each time the chat was shown (another workspace, the terminal
 * in its place, a reconnect), and a key typed meanwhile waited. Messages
 * away from the view are kept as empty boxes of the size they were last
 * drawn at, carrying the ids and sequences the place, the minimap and the
 * jumps go by: scrolled near, one is drawn again.
 */

/** The newest items, always drawn: what fills the view, and a margin. */
export const MOUNT_TAIL = 40;
/** At most this many drawn besides those near the view and the newest. */
export const MOUNT_LIMIT = 120;
/** How far beyond the view items are drawn before they come into it. */
export const MOUNT_MARGIN_PX = 2000;
/** The height of an item never drawn yet. */
export const MOUNT_ESTIMATE_PX = 120;

/** The item's key, as its element carries it. */
export function mountKeyOf(element: Element): string | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  return element.dataset.bubbleId ?? element.dataset.placeId;
}

/**
 * The items drawn once those near the view changed: the ones drawn before
 * stay (a block opened, a part being commented on), then the farthest ones
 * not near the view go, the first drawn first, past `limit`.
 */
export function nextMounted(
  mounted: ReadonlySet<string>,
  near: ReadonlySet<string>,
  limit = MOUNT_LIMIT,
): ReadonlySet<string> {
  const next = new Set(mounted);
  for (const key of near) next.add(key);
  for (const key of mounted) {
    if (next.size <= limit) break;
    if (!near.has(key)) next.delete(key);
  }
  if (next.size === mounted.size && [...next].every((key) => mounted.has(key)))
    return mounted;
  return next;
}

export type MountWindow = {
  /** Whether the item is drawn rather than kept as an empty box. */
  drawn: (key: string, index: number) => boolean;
  /** The empty box's height: the item's as last drawn, else a guess. */
  heightOf: (key: string) => number;
};

/** Which of a chat's items are drawn; `count` is how many items it has. */
export function useMountWindow(
  listRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  count: number,
): MountWindow {
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  const nearRef = useRef(new Set<string>());
  const heightsRef = useRef(new Map<string, number>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedRef = useRef(new WeakSet<Element>());
  // Without an observer (an old browser), every item is drawn.
  const windowed =
    typeof IntersectionObserver !== "undefined" && count > MOUNT_TAIL;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const near = nearRef.current;
        let changed = false;
        for (const entry of entries) {
          const element = entry.target;
          const key = mountKeyOf(element);
          // Swapped for its drawing (or its box): the new element reports.
          if (!element.isConnected) {
            observer.unobserve(element);
            continue;
          }
          if (!key) continue;
          const height = entry.boundingClientRect?.height;
          if (height && !(element as HTMLElement).dataset.mountPlaceholder)
            heightsRef.current.set(key, height);
          if (entry.isIntersecting && !near.has(key)) {
            near.add(key);
            changed = true;
          } else if (!entry.isIntersecting && near.has(key)) {
            near.delete(key);
            changed = true;
          }
        }
        if (changed)
          setMounted((current) => nextMounted(current, nearRef.current));
      },
      { root: list, rootMargin: `${MOUNT_MARGIN_PX}px 0px` },
    );
    observerRef.current = observer;
    observedRef.current = new WeakSet();
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [listRef]);

  // Every item, drawn or not, is watched: a box coming near is drawn, an
  // item going far may give its place to an empty box.
  useLayoutEffect(() => {
    const observer = observerRef.current;
    const content = contentRef.current;
    if (!observer || !content) return;
    for (const child of content.children) {
      if (observedRef.current.has(child) || !mountKeyOf(child)) continue;
      observedRef.current.add(child);
      observer.observe(child);
    }
  });

  const drawn = useCallback(
    (key: string, index: number) =>
      !windowed || index >= count - MOUNT_TAIL || mounted.has(key),
    [windowed, count, mounted],
  );
  const heightOf = useCallback(
    (key: string) => heightsRef.current.get(key) ?? MOUNT_ESTIMATE_PX,
    [],
  );
  return { drawn, heightOf };
}
