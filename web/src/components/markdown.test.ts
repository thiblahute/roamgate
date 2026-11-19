import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window as BrowserWindow } from "happy-dom";
import {
  isSafeMarkdownUrl,
  renderInlineMarkdown,
  renderMarkdown,
} from "./markdown";

const browser = new BrowserWindow({ url: "http://localhost:8787/" });
const globalsUsed = {
  DOMParser: browser.DOMParser,
  NodeFilter: browser.NodeFilter,
};
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const [key, value] of Object.entries(globalsUsed)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** The href of every link in the rendered HTML. */
function hrefs(html: string): (string | null)[] {
  const doc = new browser.DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"));
}

/** What a browser would run: the href without what it ignores. */
function hasUnsafeScheme(href: string | null) {
  if (href === null) return false;
  const protocol = new URL(href, "https://roamgate.invalid/").protocol;
  return !["http:", "https:", "mailto:"].includes(protocol);
}

test("a scheme split by a tab or a line break is not a relative link", () => {
  for (const html of [
    '<a href="java&#9;script:x">a</a>',
    '<a href="java&#10;script:x">a</a>',
    '<a href="&#1;javascript:x">a</a>',
    '<a href="data:text/html,x">a</a>',
    '<a href="vbscript:x">a</a>',
    "[y](java&#9;script:alert(2))",
  ]) {
    const found = hrefs(renderMarkdown(html));
    expect(found.length).toBe(1);
    expect(found.some(hasUnsafeScheme)).toBe(false);
  }
  expect(isSafeMarkdownUrl("java\tscript:x")).toBe(false);
  expect(isSafeMarkdownUrl("java\nscript:x")).toBe(false);
  expect(isSafeMarkdownUrl("java\r\nscript:x")).toBe(false);
});

test("a backslash after the slash is another origin", () => {
  expect(isSafeMarkdownUrl("/\\evil.com")).toBe(false);
  expect(isSafeMarkdownUrl("\\\\evil.com")).toBe(false);
  expect(isSafeMarkdownUrl("\\/evil.com")).toBe(false);
  expect(hrefs(renderMarkdown('<a href="/\\evil.com">a</a>'))).toEqual([null]);
});

test("ordinary links still work", () => {
  expect(
    hrefs(
      renderMarkdown(
        "[a](https://example.com/x) [b](/review/1) [c](#part) [d](docs/a.md) [e](mailto:me@example.com)",
      ),
    ),
  ).toEqual([
    "https://example.com/x",
    "/review/1",
    "#part",
    "docs/a.md",
    "mailto:me@example.com",
  ]);
  expect(isSafeMarkdownUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeMarkdownUrl("//evil.com")).toBe(false);
});

test("a list split by a code block keeps its numbers", () => {
  const doc = new browser.DOMParser().parseFromString(
    renderMarkdown("1. a\n\n```\ncode\n```\n\n2. b\n\n7. c"),
    "text/html",
  );
  expect(
    [...doc.querySelectorAll("ol")].map((list) => list.getAttribute("start")),
  ).toEqual([null, "2"]);
  const odd = new browser.DOMParser().parseFromString(
    renderMarkdown(
      '<ol start="2;x" onclick="y"><li>a</li></ol><ul start="3"><li>b</li></ul>',
    ),
    "text/html",
  );
  expect(odd.querySelector("ol")?.getAttributeNames()).toEqual([]);
  expect(odd.querySelector("ul")?.getAttributeNames()).toEqual([]);
});

test("with HTML frames, a raw HTML block is left for its frame", () => {
  const html = renderMarkdown(
    '# T\n\n<div onclick="x()">raw</div>\n\n<!-- c -->\n\nText.\n',
    { sourceBlocks: true, htmlFrames: true },
  );
  expect(html).toContain('class="md-html-slot" data-html-index="1"');
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("raw");
  // A comment has nothing to frame.
  expect((html.match(/md-html-slot/g) ?? []).length).toBe(1);
});

/** The words a browser would show for the rendered HTML. */
function shown(html: string): string {
  const doc = new browser.DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}

test("a message's angle-bracket placeholders are shown as written", () => {
  const message =
    '{"event":"call_carry","call":7,"ok":true,"replies_peer":"<id>"}\n' +
    '{"event":"call_replies_peer","call":7,"peer":"<peer id>"}\n' +
    "Checkout <sha> on <name>.";
  const html = renderMarkdown(message, { breaks: true });
  expect(shown(html)).toContain('"replies_peer":"<id>"');
  expect(shown(html)).toContain('"peer":"<peer id>"');
  expect(shown(html)).toContain("Checkout <sha> on <name>.");
  // A line of its own is read as a raw HTML block: still shown, as markdown.
  const block = renderMarkdown("<id>\n**bold** after", { breaks: true });
  expect(shown(block)).toContain("<id>");
  expect(block).toContain("<strong>bold</strong>");
  // A table's cell in a review comment too.
  expect(shown(renderInlineMarkdown("peer <id>, call 7"))).toBe(
    "peer <id>, call 7",
  );
});

test("a message shows tags it does not draw as text, and draws the others", () => {
  const html = renderMarkdown("a <b>bold</b> and a<br>break", { breaks: true });
  expect(shown(html)).toContain("a <b>bold</b> and a");
  expect(html).toContain("<br>");
  expect(html).not.toContain("<b>");
});

test("a project's markdown file keeps HTML, and shows other brackets", () => {
  const html = renderMarkdown(
    '<div align="center"><b>Title</b></div>\n\nSet <id> to `x`, a <b>bold</b> word.',
    { htmlDocument: true },
  );
  expect(shown(html)).toContain("Title");
  expect(shown(html)).toContain("Set <id> to x, a bold word.");
  expect(html).not.toContain("<div");
});

test("a script never runs, in a message or a file", () => {
  for (const options of [{ breaks: true }, { htmlDocument: true }]) {
    for (const source of [
      "x <script>alert(1)</script> y",
      "<script>\nalert(1)\n</script>",
      '<img src=x onerror="alert(1)">',
      "<details><summary>s</summary><script>alert(1)</script></details>",
    ]) {
      const doc = new browser.DOMParser().parseFromString(
        renderMarkdown(source, options),
        "text/html",
      );
      expect(doc.querySelector("script")).toBeNull();
      expect(
        [...doc.querySelectorAll("*")].some((element) =>
          element.getAttributeNames().some((name) => name.startsWith("on")),
        ),
      ).toBe(false);
    }
  }
});
