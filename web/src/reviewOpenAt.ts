import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReviewThread } from "../../shared/review";
import "./components/openAt.css";

/*
 * Opening a review at a thread or a comment, from outside it (a chat's
 * tool row, a Work item's link, a notification's link): the target is
 * kept here, the review is shown where it lives (requestReviewShown: its
 * Changes, its chat, its rendered file, its effort, its Work item), and
 * the view that draws that thread, once shown and its snapshot read,
 * takes it (useOpenAtTarget): it goes there with its own thread
 * navigation (unfolding a folded thread), and the comment is scrolled
 * into view and highlighted for a moment.
 */

/** Where to open: a thread, and one of its comments. */
export type OpenAtTarget = {
  thread: string;
  comment?: string;
  /** The review it is in, when known (for the views that care). */
  review?: string;
};

export type PendingOpenAt = OpenAtTarget & { seq: number; at: number };

/** Not taken by then (no view drew the thread): dropped. */
export const OPEN_AT_TIMEOUT_MS = 20_000;
/** How long the comment gone to stays highlighted. */
export const OPEN_AT_FLASH_MS = 2_000;

let pending: PendingOpenAt | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/** Asks the view showing `target.thread` to go there. */
export function requestOpenAt(target: OpenAtTarget, now = Date.now()) {
  pending = { ...target, seq: ++seq, at: now };
  emit();
}

/** The target asked for, not yet taken nor expired. */
export function pendingOpenAt(now = Date.now()): PendingOpenAt | null {
  if (pending && now - pending.at > OPEN_AT_TIMEOUT_MS) pending = null;
  return pending;
}

/** Taken by a view (or dropped): only the one asked for (`at`). */
export function takeOpenAt(at?: number) {
  if (!pending || (at !== undefined && pending.seq !== at)) return;
  pending = null;
  emit();
}

export function onOpenAt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What openReviewAt needs: overridden in tests. */
export type OpenReviewAtDeps = {
  summary: (review: string) => unknown;
  load: (connectionId: string) => Promise<void>;
  show: (connectionId: string, review: string) => void;
};

/** The review store's (read when used: the views here need none of it). */
async function storeDeps(): Promise<OpenReviewAtDeps> {
  const { getReviewSummary, loadReviews, requestReviewShown } = await import(
    "./review"
  );
  return {
    summary: getReviewSummary,
    load: loadReviews,
    show: requestReviewShown,
  };
}

/**
 * Shows a review where it lives, at a thread and a comment when given:
 * its list read first when the page does not know it yet, so it opens in
 * its home and not in Changes.
 */
export async function openReviewAt(
  connectionId: string,
  review: string,
  at?: { thread?: string; comment?: string },
  given?: OpenReviewAtDeps,
) {
  if (at?.thread)
    requestOpenAt({
      review,
      thread: at.thread,
      ...(at.comment ? { comment: at.comment } : {}),
    });
  const deps = given ?? (await storeDeps());
  if (!deps.summary(review)) await deps.load(connectionId).catch(() => {});
  deps.show(connectionId, review);
}

/** Whether an element is on the screen: none of its boxes hidden. */
function isShown(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden], [inert]"))
    return false;
  const view = element.ownerDocument.defaultView;
  for (let at: HTMLElement | null = element; at; at = at.parentElement)
    if (view?.getComputedStyle(at).display === "none") return false;
  return true;
}

/** The element of a comment (else of its thread) drawn in `root`. */
export function openAtElement(
  root: ParentNode,
  thread: string,
  comment?: string,
): HTMLElement | null {
  if (comment) {
    const id = CSS.escape(comment);
    const found = root.querySelector<HTMLElement>(
      `[data-chat-stop="m:${id}"], [data-message-id="${id}"], [data-comment-id="${id}"]`,
    );
    if (found) return found;
  }
  return root.querySelector<HTMLElement>(
    `[data-thread-id="${CSS.escape(thread)}"]`,
  );
}

/**
 * Highlights the comment gone to (else its thread) once drawn, in view:
 * looked for frame by frame up to `wait` ms (a file read, a thread
 * unfolded first).
 */
export function flashOpenAt(
  root: () => HTMLElement | null,
  thread: string,
  comment?: string,
  wait = 8_000,
): () => void {
  const until = Date.now() + wait;
  let frame = 0;
  let timer = 0;
  const look = () => {
    const scope = root();
    const found = scope ? openAtElement(scope, thread, comment) : null;
    // A comment asked for: its thread's element only once it never shows.
    const exact =
      !comment ||
      !found ||
      found.dataset.threadId === undefined ||
      Date.now() >= until;
    if (found && exact) {
      // An attribute: the class the view draws (its cursor's) leaves it.
      delete found.dataset.openAt;
      // Restarts the animation when it is gone to again.
      void found.offsetWidth;
      found.dataset.openAt = "";
      found.scrollIntoView?.({ block: "nearest" });
      timer = window.setTimeout(
        () => delete found.dataset.openAt,
        OPEN_AT_FLASH_MS,
      );
      return;
    }
    if (Date.now() < until) frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

/** A view drawing threads: how it finds one and goes there. */
export type OpenAtView = {
  /** The thread, when this view draws it. */
  find: (id: string) => ReviewThread | undefined;
  /** Changes when the view's threads change: the target is looked for again. */
  threads: unknown;
  /** The view's element: taken only while it is on the screen. */
  root: () => HTMLElement | null;
  /** Goes to the thread (unfolded) and the comment, with the view's own keys. */
  go: (thread: ReviewThread, comment?: string) => void;
};

/** How often a view not shown yet looks again for the target. */
const RETRY_MS = 100;

/**
 * Takes the open-at target when this view draws its thread and is shown:
 * goes there (`go`), then highlights the comment.
 */
export function useOpenAtTarget(view: OpenAtView) {
  const target = useSyncExternalStore(onOpenAt, peek, peek);
  const current = useRef(view);
  current.current = view;
  // The highlight outlives the target taken: stopped when the view goes.
  const flashing = useRef<() => void>(() => {});
  useEffect(() => () => flashing.current(), []);
  useEffect(() => {
    void view.threads;
    if (!target) return;
    let timer = 0;
    const attempt = () => {
      if (pendingOpenAt()?.seq !== target.seq) return;
      const { find, root, go } = current.current;
      const thread = find(target.thread);
      // Not this view's thread (or not read yet): looked for again when
      // its threads change.
      if (!thread) return;
      const element = root();
      if (!element || !isShown(element)) {
        timer = window.setTimeout(attempt, RETRY_MS);
        return;
      }
      takeOpenAt(target.seq);
      go(thread, target.comment);
      flashing.current();
      flashing.current = flashOpenAt(
        () => current.current.root(),
        target.thread,
        target.comment,
      );
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [target, view.threads]);
}

function peek() {
  return pending;
}

/** The page's hash that opens a review (a notification's or a comment's link). */
const REVIEW_HASH = "#roamgate-review=";

/** A review a link names, and the thread and comment in it to go to. */
export type ReviewHashTarget = {
  review: string;
  thread?: string;
  comment?: string;
};

const HEX_ID = /^[0-9a-f]{8,32}$/;

/**
 * The review a page's hash names (`#roamgate-review=ID`, with
 * `&thread=ID&comment=ID` to open it at a comment), or null.
 */
export function reviewTargetInHash(
  hash = window.location.hash,
): ReviewHashTarget | null {
  if (!hash.startsWith(REVIEW_HASH)) return null;
  const [head = "", ...rest] = hash.slice(REVIEW_HASH.length).split("&");
  const review = decodeURIComponent(head).trim();
  if (!HEX_ID.test(review)) return null;
  const params = new URLSearchParams(rest.join("&"));
  const id = (name: string) => {
    const value = params.get(name)?.trim();
    return value && HEX_ID.test(value) ? value : undefined;
  };
  const thread = id("thread");
  const comment = thread ? id("comment") : undefined;
  return {
    review,
    ...(thread ? { thread } : {}),
    ...(comment ? { comment } : {}),
  };
}

/**
 * A link to a review (`/#roamgate-review=ID…`) opens it where it lives, at
 * the comment it names, on load and when the hash changes; the hash is
 * then taken off the address. Kept until the page has a connection
 * (watched again then).
 */
export function watchReviewHash(
  connectionId: () => string | null,
  open: (connectionId: string, target: ReviewHashTarget) => void = (
    connection,
    { review, ...at },
  ) => void openReviewAt(connection, review, at),
) {
  const check = () => {
    const target = reviewTargetInHash();
    const connection = connectionId();
    if (!target || !connection) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    open(connection, target);
  };
  check();
  window.addEventListener("hashchange", check);
  return () => window.removeEventListener("hashchange", check);
}
