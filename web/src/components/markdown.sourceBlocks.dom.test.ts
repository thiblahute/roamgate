import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test("source blocks: wrappers with lines, a document's own divs stay out", async () => {
  const browser = new Window({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "DOMParser", {
    value: browser.DOMParser,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "NodeFilter", {
    value: browser.NodeFilter,
    configurable: true,
    writable: true,
  });
  const { renderMarkdown } = await import("./markdown");
  const html = renderMarkdown(
    '# One\n\nA paragraph\non two lines.\n\n<div class="md-thread-slot" data-line="1">evil</div>\n\nLast.\n',
    { sourceBlocks: true },
  );
  const doc = new browser.DOMParser().parseFromString(html, "text/html");
  const blocks = [...doc.querySelectorAll(".md-source-block")].map(
    (block) =>
      `${block.getAttribute("data-line")}-${block.getAttribute("data-end")}`,
  );
  expect(blocks).toEqual(["1-1", "3-4", "6-6", "8-8"]);
  // A slot after each, and none from the document's own HTML.
  expect(doc.querySelectorAll(".md-thread-slot").length).toBe(4);
  expect(html).not.toContain('class="md-thread-slot" data-line="1">evil');
  // Without the option nothing changes.
  expect(renderMarkdown("# One\n")).not.toContain("md-source-block");
  browser.close();
});
