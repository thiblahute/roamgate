import { roamgateSessionStorage } from "./browserStorage";

/**
 * Where the reader is in an agent chat, kept per connection, pane and
 * session while the chat is not shown (another pane, workspace or
 * connection, the terminal in its place, a reload): the chat comes back
 * there rather than at its end.
 *
 * A place is content, not a scroll offset: the message at the top of the
 * view and how far above or below the top it was, so it holds while new
 * messages arrive under it and older ones are read in above it.
 */

/** The item at the top of the view, and where it was. */
export type ChatAnchor = {
  /** A bubble's id (data-bubble-id), or another item's (data-place-id). */
  id: string;
  /** Its top, from the top of the view: negative when above it. */
  offset: number;
  /**
   * The reply block it shows (message id and block): the same block
   * streamed then saved has another id.
   */
  block?: string;
  /**
   * When it was written: it is looked for among older messages only when
   * it is older than those shown, else where the conversation went on.
   */
  at?: string;
  /**
   * Inside it, the part or thread message at the top of the view: a thread
   * above it that grows (an answer come in) does not move it.
   */
  inner?: { key: string; offset: number };
};

/** The last message the reader saw at the end of the chat. */
export type ChatSeen = { id: string; block?: string; at?: string };

export type ChatPlace = {
  /** None: at the end, following what comes. */
  anchor: ChatAnchor | null;
  seen?: ChatSeen;
};

/** How many places are kept: the least recently used go first. */
const MAX_PLACES = 200;
const STORAGE_KEY = "chatPlaces:v1";

let places: Map<string, ChatPlace> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function loaded(): Map<string, ChatPlace> {
  if (places) return places;
  places = new Map();
  try {
    const saved = JSON.parse(
      roamgateSessionStorage.getItem(STORAGE_KEY) ?? "[]",
    ) as unknown;
    if (Array.isArray(saved))
      for (const item of saved)
        if (
          Array.isArray(item) &&
          typeof item[0] === "string" &&
          item[1] &&
          typeof item[1] === "object"
        )
          places.set(item[0], item[1] as ChatPlace);
  } catch {
    /* A place is a convenience: none kept, the chat opens at its end. */
  }
  if (typeof window !== "undefined")
    window.addEventListener("pagehide", flushChatPlaces);
  return places;
}

/** Writes the places to this tab's storage, for a reload. */
export function flushChatPlaces(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!places) return;
  try {
    roamgateSessionStorage.setItem(STORAGE_KEY, JSON.stringify([...places]));
  } catch {
    /* Kept in memory for this page when storage is not writable. */
  }
}

/** The key of a pane's chat: its connection, pane and agent session. */
export function chatPlaceKey(
  connectionId: string | null | undefined,
  paneId: string,
  session: string,
): string {
  return JSON.stringify([connectionId ?? "", paneId, session]);
}

export function readChatPlace(key: string): ChatPlace | null {
  return loaded().get(key) ?? null;
}

export function rememberChatPlace(key: string, place: ChatPlace): void {
  const kept = loaded();
  kept.delete(key);
  kept.set(key, place);
  while (kept.size > MAX_PLACES) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
  flushTimer ??= setTimeout(flushChatPlaces, 400);
}

// The chat's items: its direct children with an id. Their order is their
// order on screen.
const ITEM_ATTRIBUTES = ["bubbleId", "placeId"] as const;
// Inside an item, what the place can hold by: a thread's messages and
// folded threads (data-chat-stop), the parts of a message (data-part).
const INNER_SELECTOR = "[data-chat-stop], [data-part]";

function itemId(element: HTMLElement): string | undefined {
  for (const name of ITEM_ATTRIBUTES) {
    const id = element.dataset[name];
    if (id) return id;
  }
  return undefined;
}

function chatItems(content: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of content.children)
    if (child instanceof HTMLElement && itemId(child)) items.push(child);
  return items;
}

/** What names a part or thread message inside an item, as j / k do. */
function innerKey(element: HTMLElement): string | null {
  if (element.dataset.chatStop) return element.dataset.chatStop;
  const part = element.dataset.part;
  if (part === undefined) return null;
  const message =
    element.closest<HTMLElement>(".chat-thread-body")?.dataset.messageId;
  if (message) return `q:${message}:${part}`;
  const entry =
    element.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
  return entry ? `p:${entry}:${part}` : null;
}

function drawn(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

/**
 * The item at the top of the list's view, and inside it the deepest part
 * or thread message the top crosses (else the first one under it).
 * `describe` adds what the item's message says of itself.
 */
export function readChatAnchor(
  list: HTMLElement,
  content: HTMLElement,
  describe: (id: string) => Pick<ChatAnchor, "block" | "at"> = () => ({}),
): ChatAnchor | null {
  const top = list.getBoundingClientRect().top;
  const items = chatItems(content);
  if (!items.length) return null;
  // The first whose bottom is under the top of the view: they are in order.
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.getBoundingClientRect().bottom > top) {
      found = middle;
      high = middle - 1;
    } else low = middle + 1;
  }
  const item = items[found < 0 ? items.length - 1 : found]!;
  const id = itemId(item)!;
  const anchor: ChatAnchor = {
    id,
    offset: Math.round(item.getBoundingClientRect().top - top),
    ...describe(id),
  };
  let crossing: HTMLElement | null = null;
  let under: HTMLElement | null = null;
  for (const inner of item.querySelectorAll<HTMLElement>(INNER_SELECTOR)) {
    const rect = inner.getBoundingClientRect();
    if (!drawn(rect) || rect.bottom <= top) continue;
    // Those the top crosses come first, the deepest last; then those
    // wholly under it.
    if (rect.top <= top) crossing = inner;
    else {
      under = inner;
      break;
    }
  }
  const inner = crossing ?? under;
  const key = inner ? innerKey(inner) : null;
  if (inner && key)
    anchor.inner = {
      key,
      offset: Math.round(inner.getBoundingClientRect().top - top),
    };
  return anchor;
}

/** The item a place is at: by its id, else by the reply block it shows. */
export function findChatAnchorItem(
  content: HTMLElement,
  anchor: Pick<ChatAnchor, "id" | "block">,
): HTMLElement | null {
  const items = chatItems(content);
  return (
    items.find((item) => itemId(item) === anchor.id) ??
    (anchor.block
      ? items.find((item) => item.dataset.blockKey === anchor.block)
      : undefined) ??
    null
  );
}

/** Scrolls the list so an element's top is `offset` from its view's. */
export function scrollChatTo(
  list: HTMLElement,
  element: HTMLElement,
  offset: number,
): void {
  const delta =
    element.getBoundingClientRect().top -
    list.getBoundingClientRect().top -
    offset;
  if (Math.abs(delta) >= 1) list.scrollTop += delta;
}

/**
 * Puts the place back in view: false when its item is not among those
 * drawn.
 */
export function placeChatAnchor(
  list: HTMLElement,
  content: HTMLElement,
  anchor: ChatAnchor,
): boolean {
  const item = findChatAnchorItem(content, anchor);
  if (!item) return false;
  const key = anchor.inner?.key;
  const inner = key
    ? Array.from(item.querySelectorAll<HTMLElement>(INNER_SELECTOR)).find(
        (element) => innerKey(element) === key,
      )
    : undefined;
  if (inner && anchor.inner && drawn(inner.getBoundingClientRect()))
    scrollChatTo(list, inner, anchor.inner.offset);
  else scrollChatTo(list, item, anchor.offset);
  return true;
}
