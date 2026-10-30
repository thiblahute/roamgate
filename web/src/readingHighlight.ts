/**
 * Marks the sentence being read aloud in the chat, with the CSS Custom
 * Highlight API: the page's text is left as it is.
 */
const HIGHLIGHT = "roamgate-reading";

/** Where `sentence` is in `root`'s text, spaces and line breaks aside. */
export function findSentence(root: Node, sentence: string): Range | null {
  const words = sentence.split(/\s+/).filter(Boolean);
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

/**
 * Highlights `sentence` in the first of the messages `ids` that shows it,
 * scrolling it into view; null clears the highlight.
 */
export function highlightReading(
  ids: readonly string[],
  sentence: string | null,
) {
  const registry = globalThis.CSS?.highlights;
  if (!registry || typeof Highlight === "undefined") return;
  registry.delete(HIGHLIGHT);
  if (!sentence) return;
  for (const id of ids) {
    const bubble = document.querySelector(
      `[data-entry-id="${CSS.escape(id)}"] .agent-history-chat-bubble`,
    );
    const range = bubble && findSentence(bubble, sentence);
    if (!range) continue;
    registry.set(HIGHLIGHT, new Highlight(range));
    const box = range.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight)
      range.startContainer.parentElement?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    return;
  }
}
