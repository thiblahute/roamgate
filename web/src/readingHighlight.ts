/**
 * Marks the sentence being read aloud in the chat, with the CSS Custom
 * Highlight API: the page's text is left as it is.
 */
const HIGHLIGHT = "roamgate-reading";

/** Where `sentence` is in `root`'s text, spaces and line breaks aside. */
export function findSentence(root: Node, sentence: string): Range | null {
  // What reading adds to a list item (its number, a task's state) is not
  // in the page's text.
  const words = sentence
    .replace(/^(?:\d{1,3}\.|Completed\.|Not completed\.)\s+/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.textContent ?? "";
  }
  const escaped = words.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const match = new RegExp(escaped.join("\\s+"), "u").exec(text);
  if (!match) return null;
  const at = (offset: number, end: boolean) => {
    // The node holding this offset: at a boundary, the end of the one before
    // for the range's end, the start of the next one for its start.
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const { node, start } = nodes[i]!;
      if (end ? offset > start : offset >= start)
        return { node, offset: offset - start };
    }
    return { node: nodes[0]!.node, offset: 0 };
  };
  const from = at(match.index, false);
  const to = at(match.index + match[0].length, true);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** The bubble of a message: by its chat id, else by its reply block. */
function bubbleOf(id: string): Element | null {
  const byId = document.querySelector(
    `[data-entry-id="${CSS.escape(id)}"] .agent-history-chat-bubble`,
  );
  if (byId || !id.startsWith("live:")) return byId;
  // A streamed block (live:<message>:<index>) once its saved entry took
  // its place.
  return document.querySelector(
    `[data-block-key="${CSS.escape(id.slice(5))}"] .agent-history-chat-bubble`,
  );
}

/** What is read now, put back when the chat redraws under it. */
let reading: {
  ids: readonly string[];
  sentence: string;
  scrolled: boolean;
  anywhere: boolean;
} | null = null;
/**
 * The bubble a reading of no known entries was last found in: its next
 * sentences are looked for there first.
 */
let anchor: Element | null = null;
/** Fewer words match too easily in some other message. */
const ANYWHERE_MIN_WORDS = 3;

/**
 * The bubbles on screen that may show a reading of no known entries (an
 * answer a session gave a call's companion): the one it was last found
 * in, then the newest first.
 */
function bubblesAnywhere(): Element[] {
  const all = [
    ...document.querySelectorAll(".agent-history-chat-bubble"),
  ].reverse();
  return anchor?.isConnected
    ? [anchor, ...all.filter((bubble) => bubble !== anchor)]
    : all;
}
let observer: MutationObserver | null = null;
let pending = 0;

function apply(): boolean {
  const registry = globalThis.CSS?.highlights;
  if (!registry || typeof Highlight === "undefined" || !reading) return false;
  registry.delete(HIGHLIGHT);
  const bubbles = reading.ids.map(bubbleOf);
  if (
    reading.anywhere &&
    reading.sentence.split(/\s+/).filter(Boolean).length >= ANYWHERE_MIN_WORDS
  )
    bubbles.push(...bubblesAnywhere());
  for (const bubble of bubbles) {
    const range = bubble && findSentence(bubble, reading.sentence);
    if (!range) continue;
    if (reading.anywhere) anchor = bubble;
    registry.set(HIGHLIGHT, new Highlight(range));
    // Brought into view once per sentence, not on every redraw.
    if (!reading.scrolled) {
      reading.scrolled = true;
      const box = range.getBoundingClientRect();
      if (box.top < 0 || box.bottom > window.innerHeight)
        range.startContainer.parentElement?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
    }
    return true;
  }
  return false;
}

/**
 * Highlights `sentence` in the first of the messages `ids` that shows it,
 * scrolling it into view; null clears the highlight. While it is read, a
 * redraw of the chat (a reply still streaming in, its saved copy taking the
 * streamed one's place) puts it back.
 *
 * `anywhere`: an answer read whose entries are not known here (a session's
 * answer to a call's companion) is looked for in any chat on screen, in
 * the message its sentences were last found in first, then the newest.
 */
export function highlightReading(
  ids: readonly string[],
  sentence: string | null,
  { anywhere = false }: { anywhere?: boolean } = {},
) {
  const registry = globalThis.CSS?.highlights;
  if (!registry || typeof Highlight === "undefined") return;
  if (!sentence) {
    reading = null;
    anchor = null;
    registry.delete(HIGHLIGHT);
    observer?.disconnect();
    observer = null;
    return;
  }
  reading = { ids: [...ids], sentence, scrolled: false, anywhere };
  apply();
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        apply();
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
}
