import { describe, expect, test } from "bun:test";
import { mermaidRenderer } from "./diagramRender";
import {
  diagramLanguage,
  diagramMarkdown,
  endsInOpenFence,
  fenceClosed,
  rawSvgMarkup,
} from "./diagramSource";
import { messageBlockCount, messageBlocks } from "./reviewMessageParts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

describe("diagram sources", () => {
  test("a fence's language names a diagram", () => {
    expect(diagramLanguage("mermaid")).toBe("mermaid");
    expect(diagramLanguage(" Mermaid title=x")).toBe("mermaid");
    expect(diagramLanguage("svg")).toBe("svg");
    expect(diagramLanguage("ts")).toBe(null);
    expect(diagramLanguage(undefined)).toBe(null);
  });

  test("a message of SVG markup alone, with or without a prolog", () => {
    expect(rawSvgMarkup(`\n${SVG}\n`)).toBe(SVG);
    expect(rawSvgMarkup(`<?xml version="1.0"?>\n<!-- a -->\n${SVG}`)).toBe(
      `<?xml version="1.0"?>\n<!-- a -->\n${SVG}`,
    );
    expect(rawSvgMarkup(`Look:\n${SVG}`)).toBe(null);
    expect(rawSvgMarkup(`${SVG}\nThat is it.`)).toBe(null);
    expect(rawSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg">')).toBe(null);
  });

  test("SVG markup becomes an svg block, open while it is written", () => {
    expect(diagramMarkdown(SVG)).toBe(`\`\`\`svg\n${SVG}\n\`\`\``);
    expect(diagramMarkdown("<svg width='1'><text>a")).toBe(
      "```svg\n<svg width='1'><text>a",
    );
    expect(diagramMarkdown("Some **text**")).toBe("Some **text**");
    // Backticks in it lengthen the fence.
    expect(diagramMarkdown("<svg>```</svg>")).toBe(
      "````svg\n<svg>```</svg>\n````",
    );
  });

  test("a fence is closed by one as long, of its kind", () => {
    expect(fenceClosed("```mermaid\ngraph TD\n```\n")).toBe(true);
    expect(fenceClosed("```mermaid\ngraph TD\n  A-->B")).toBe(false);
    expect(fenceClosed("```mermaid")).toBe(false);
    expect(fenceClosed("````mermaid\na\n```")).toBe(false);
    expect(fenceClosed("~~~svg\n<svg/>\n```")).toBe(false);
    expect(fenceClosed("   ```svg\n   <svg/>\n   ```")).toBe(true);
    expect(fenceClosed("    indented code")).toBe(true);
  });

  test("a streamed message ends in an open block", () => {
    expect(endsInOpenFence("Text\n\n```mermaid\ngraph TD")).toBe(true);
    expect(endsInOpenFence("```mermaid\ngraph TD\n```\n\nMore")).toBe(false);
    expect(endsInOpenFence("1. Item\n\n   ```svg\n   <svg>")).toBe(true);
    expect(endsInOpenFence("No code at all")).toBe(false);
  });
});

describe("diagram parts of a comment", () => {
  test("a closed diagram block is one part", () => {
    const blocks = messageBlocks(
      "Before\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\n```svg\n<svg/>\n```\n\nAfter",
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "markdown",
      "diagram",
      "diagram",
      "markdown",
    ]);
    expect(blocks[1]).toEqual({
      kind: "diagram",
      lang: "mermaid",
      code: "sequenceDiagram\n  A->>B: hi",
    });
    expect(messageBlockCount(blocks)).toBe(4);
  });

  test("an open one stays code; SVG alone is a diagram", () => {
    expect(
      messageBlocks("```mermaid\nsequenceDiagram\n  A->>B").map((b) => b.kind),
    ).toEqual(["code"]);
    expect(messageBlocks(SVG)).toEqual([
      { kind: "diagram", lang: "svg", code: SVG },
    ]);
  });
});

describe("mermaid renderers", () => {
  test("beautiful-mermaid's types, mermaid.js's, and unknown ones", () => {
    expect(mermaidRenderer("sequenceDiagram\n  A->>B: x")).toBe("beautiful");
    expect(mermaidRenderer("%%{init: {}}%%\nflowchart LR\n A-->B")).toBe(
      "beautiful",
    );
    expect(mermaidRenderer("---\ntitle: x\n---\nstateDiagram-v2")).toBe(
      "beautiful",
    );
    expect(mermaidRenderer("gantt\n title G")).toBe("mermaid-js");
    expect(mermaidRenderer("pie title Pets")).toBe("mermaid-js");
    expect(mermaidRenderer("mindmap\n root")).toBe("mermaid-js");
    expect(mermaidRenderer("sequenceDiagramm")).toBe(null);
  });
});
