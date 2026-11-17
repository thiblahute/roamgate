import { expect, test } from "bun:test";
import { marked, type Tokens } from "marked";
import {
  cellPlacement,
  listItemLines,
  markdownBlocks,
  isAnimatedSvg,
  narrowLines,
  quoteOccurrence,
  quoteOffset,
  quoteWords,
  regionOf,
  renderedWhere,
  sourceStopOf,
} from "./renderedSource";

const doc = `# Plan

Intro paragraph
on two lines.

- one
- two
- three

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

See [the spec][spec].

[spec]: https://example.com/spec
`;

test("each Markdown block knows its source lines", () => {
  const blocks = markdownBlocks(doc).map(({ start, end, type }) => ({
    start,
    end,
    type,
  }));
  expect(blocks).toEqual([
    { start: 1, end: 1, type: "heading" },
    { start: 3, end: 4, type: "paragraph" },
    { start: 6, end: 8, type: "list" },
    { start: 10, end: 13, type: "code" },
    { start: 15, end: 15, type: "paragraph" },
  ]);
  // A block keeps the document's link definitions.
  expect(markdownBlocks(doc)[4]!.tokens.links.spec?.href).toBe(
    "https://example.com/spec",
  );
});

test("CRLF files count lines the same", () => {
  const blocks = markdownBlocks(doc.replace(/\n/g, "\r\n"));
  expect(blocks.map((block) => block.start)).toEqual([1, 3, 6, 10, 15]);
});

test("a quote narrows to the lines holding its first and last words", () => {
  const lines = doc.split("\n");
  expect(narrowLines(lines, 6, 8, "two")).toEqual({ line: 7, endLine: 7 });
  expect(narrowLines(lines, 6, 8, "two\nthree")).toEqual({
    line: 7,
    endLine: 8,
  });
  // Rendered as one line, written on two.
  expect(narrowLines(lines, 3, 4, "paragraph on two")).toEqual({
    line: 3,
    endLine: 4,
  });
  // Rendered link text is found in its Markdown.
  expect(narrowLines(lines, 15, 15, "the spec")).toEqual({
    line: 15,
    endLine: 15,
  });
  expect(narrowLines(lines, 6, 8, "nowhere")).toEqual({ line: 6, endLine: 8 });
});

test("a region is in fractions of the graphic, a click a point", () => {
  const box = { left: 100, top: 100, width: 200, height: 100 };
  expect(regionOf({ x: 150, y: 120 }, { x: 250, y: 170 }, box)).toEqual({
    x: 0.25,
    y: 0.2,
    w: 0.5,
    h: 0.5,
  });
  expect(regionOf({ x: 200, y: 150 }, { x: 202, y: 151 }, box)).toEqual({
    x: 0.5,
    y: 0.5,
    w: 0,
    h: 0,
  });
  // Clamped to the graphic.
  expect(regionOf({ x: 0, y: 0 }, { x: 400, y: 400 }, box)).toEqual({
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  });
  expect(regionOf({ x: 0, y: 0 }, { x: 1, y: 1 }, { ...box, width: 0 })).toBe(
    null,
  );
});

test("a thread's place reads briefly", () => {
  expect(
    renderedWhere({
      path: "a.md",
      line: 3,
      endLine: 5,
      render: { graphic: "diagram 1", element: "queue" },
    }),
  ).toBe("a.md:3-5 · diagram 1 (queue)");
  expect(renderedWhere({ render: { url: "/x.html", quote: "hello" } })).toBe(
    '/x.html · "hello"',
  );
});

test("an animated SVG is told from a still one", () => {
  expect(isAnimatedSvg("<svg><animate attributeName='x'/></svg>")).toBe(true);
  expect(isAnimatedSvg("<svg><style>@keyframes a{}</style></svg>")).toBe(true);
  expect(isAnimatedSvg("<svg><rect/></svg>")).toBe(false);
});

test("a list's items have their own lines, nested ones too", () => {
  const [list] = marked.lexer(
    "- one\n  - one a\n  - one b\n    more\n- two\n",
    {
      gfm: true,
    },
  );
  expect(listItemLines(list as Tokens.List, 3)).toEqual([
    {
      line: 3,
      end: 3,
      lists: [
        [
          { line: 4, end: 4, lists: [] },
          { line: 5, end: 6, lists: [] },
        ],
      ],
    },
    { line: 7, end: 7, lists: [] },
  ]);
});

test("a thread goes to the narrowest stop on its line, a cell by its words", () => {
  const stops = [
    { key: "b:1", line: 1, end: 1, text: "Title" },
    { key: "b:3", line: 3, end: 4, text: "An item" },
    { key: "b:6:0", line: 6, end: 6, text: "Name" },
    { key: "b:6:1", line: 6, end: 6, text: "Size" },
  ];
  expect(sourceStopOf(stops, 4)).toBe("b:3");
  expect(sourceStopOf(stops, 6, "size")).toBe("b:6:1");
  expect(sourceStopOf(stops, 6, "Na")).toBe("b:6:0");
  expect(sourceStopOf(stops, 6)).toBe("b:6:0");
  // Between stops: the one before.
  expect(sourceStopOf(stops, 5)).toBe("b:3");
});

test("a cell is found by part of its words, mid-word or across inline code", () => {
  const stops = [
    { key: "b:6:0", line: 6, end: 6, text: "0.9.0 and 0.9.4 (protocol 22)" },
    { key: "b:6:1", line: 6, end: 6, text: "Endpoint terminal mode" },
    { key: "b:7:0", line: 7, end: 7, text: "Run bun install now" },
    { key: "b:7:1", line: 7, end: 7, text: "Rejected" },
  ];
  expect(sourceStopOf(stops, 6, ".0 and 0.9.4 (protocol")).toBe("b:6:0");
  expect(sourceStopOf(stops, 6, "terminal mo")).toBe("b:6:1");
  expect(sourceStopOf(stops, 7, "`bun install` now")).toBe("b:7:0");
  expect(sourceStopOf(stops, 7, "reject")).toBe("b:7:1");
  expect(quoteWords("Run `bun  install` [now](x.md)")).toBe("runbuninstallnow");
});

test("threads on a line go by where their quotes are, repeats by their line", () => {
  const row = "| 0.9.0 and 0.9.4 (protocol 22) | Endpoint terminal mode |";
  expect(quoteOffset(row, ".0 and 0.9.4")).toBeLessThan(
    quoteOffset(row, "Endpoint terminal"),
  );
  expect(quoteOffset(row, "not there")).toBe(-1);
  const lines = ["Use the cache here.", "Then use the cache there."];
  expect(quoteOccurrence(lines, 1, 1, "the cache")).toBe(0);
  expect(quoteOccurrence(lines, 1, 2, "the cache")).toBe(1);
});

test("a cell's threads go in its column when a card fits, else under the row", () => {
  const columns = [
    { left: 0, width: 120 },
    { left: 120, width: 300 },
    { left: 420, width: 80 },
  ];
  expect(cellPlacement(columns, 1, 240)).toEqual({
    start: 1,
    end: 2,
    under: false,
    pointer: 150,
  });
  // From its column to the row's end when that is room enough.
  expect(cellPlacement(columns, 0, 240)).toEqual({
    start: 0,
    end: 3,
    under: true,
    pointer: 60,
  });
  // The last column, too narrow and alone: from the column before it.
  expect(cellPlacement(columns, 2, 240)).toEqual({
    start: 1,
    end: 3,
    under: true,
    pointer: 340,
  });
});
