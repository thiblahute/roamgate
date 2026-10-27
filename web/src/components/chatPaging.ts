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
