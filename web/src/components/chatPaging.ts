/**
 * Page Up / Page Down in an agent chat's message box: the conversation
 * scrolls by a page, as it would with the box not focused.
 */
export function scrollChatPage(from: Element, direction: 1 | -1): boolean {
  const list = from
    .closest(".agent-history-messages")
    ?.querySelector<HTMLElement>(".agent-history-chat");
  if (!list) return false;
  list.scrollBy({ top: direction * list.clientHeight * 0.9 });
  return true;
}

/** Asks an agent chat to put j / k on its messages' parts (ChatThreads). */
export const CHAT_PARTS_EVENT = "roamgate:chat-parts";

/**
 * From the message box into the conversation: false when the chat has no
 * parts to step through, so the key does what it did.
 */
export function enterChatParts(from: Element): boolean {
  const messages = from.closest(".agent-history-messages");
  if (!messages?.querySelector(".chat-review [data-part]")) return false;
  messages.dispatchEvent(new CustomEvent(CHAT_PARTS_EVENT));
  return true;
}

/**
 * A jump to one of a chat's messages (its minimap): scrolls the chat's own
 * message list, `list` or the scroller inside it that holds `target`, to
 * put `target` at its top (`margin` pixels below it) or, for `nearest`,
 * just in view. scrollIntoView would also scroll every scroller around the
 * list, the panel and the page among them. In CSS pixels even when the UI
 * is zoomed.
 */
export function scrollChatTo(
  list: HTMLElement,
  target: HTMLElement,
  {
    block = "start",
    margin = 0,
    behavior = "auto",
  }: {
    block?: "start" | "nearest";
    margin?: number;
    behavior?: ScrollBehavior;
  } = {},
): void {
  let scroller = list;
  for (
    let element = list.contains(target) ? target.parentElement : null;
    element && element !== list;
    element = element.parentElement
  ) {
    const overflow =
      element.ownerDocument.defaultView?.getComputedStyle(element).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollHeight > element.clientHeight
    ) {
      scroller = element;
      break;
    }
  }
  const viewport = scroller.getBoundingClientRect();
  const scale = scroller.offsetHeight
    ? viewport.height / scroller.offsetHeight
    : 1;
  const box = target.getBoundingClientRect();
  const top = (box.top - viewport.top) / (scale || 1);
  const bottom = (box.bottom - viewport.top) / (scale || 1);
  let offset = top - margin;
  if (block === "nearest") {
    if (top < 0) offset = top;
    else if (bottom > scroller.clientHeight)
      offset = Math.min(top, bottom - scroller.clientHeight);
    else return;
  }
  if (behavior === "smooth" && typeof scroller.scrollTo === "function")
    scroller.scrollTo({ top: scroller.scrollTop + offset, behavior });
  else scroller.scrollTop += offset;
}
