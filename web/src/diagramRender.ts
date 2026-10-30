import type { DiagramLanguage } from "./diagramSource";
import { importWithReload } from "./lazyWithReload";
import {
  loadMermaidModule,
  normalizeMermaidSource,
  renderMermaidDiagram,
} from "./mermaidRender";
import { svgImage } from "./svgImage";

/**
 * How a diagram of a comment or a chat message is drawn.
 *
 * Mermaid goes to beautiful-mermaid (the file previews' renderer: small,
 * synchronous, its SVG sanitized into the page and colored by the theme's
 * variables) for the types it draws; the others (gantt, pie, mindmap...)
 * load mermaid.js, pinned, on the first such diagram only, with
 * securityLevel "strict", and its SVG is shown as an image (see svgImage),
 * so neither its labels nor its style sheet ever reach the page. SVG blocks
 * are always images.
 */

export type DiagramTheme = "dark" | "light";

export type DrawnDiagram =
  | { kind: "inline"; svg: string; width: number; height: number }
  | {
      kind: "image";
      url: string;
      width: number;
      height: number;
      /** Drawn in fixed colors for a white page: shown on one. */
      paper: boolean;
    }
  | { kind: "error"; error: string };

/** The diagram types beautiful-mermaid draws (header word, lowercase). */
const BEAUTIFUL_TYPES = new Set([
  "graph",
  "flowchart",
  "sequencediagram",
  "classdiagram",
  "erdiagram",
  "statediagram",
  "statediagram-v2",
  "xychart",
  "xychart-beta",
]);

/** The other types mermaid.js knows. */
const MERMAID_JS_TYPES = new Set([
  "architecture",
  "architecture-beta",
  "block",
  "block-beta",
  "c4component",
  "c4container",
  "c4context",
  "c4deployment",
  "c4dynamic",
  "gantt",
  "gitgraph",
  "ishikawa",
  "ishikawa-beta",
  "journey",
  "kanban",
  "mindmap",
  "packet",
  "packet-beta",
  "pie",
  "quadrantchart",
  "radar-beta",
  "requirementdiagram",
  "sankey",
  "sankey-beta",
  "timeline",
  "treemap",
  "treemap-beta",
  "venn-beta",
]);

export type MermaidRenderer = "beautiful" | "mermaid-js";

/** Which renderer draws a Mermaid source, or null: not a known type. */
export function mermaidRenderer(code: string): MermaidRenderer | null {
  const word =
    normalizeMermaidSource(code)
      .split(/[\s:;]/, 1)[0]
      ?.toLowerCase() ?? "";
  if (BEAUTIFUL_TYPES.has(word)) return "beautiful";
  if (MERMAID_JS_TYPES.has(word)) return "mermaid-js";
  return null;
}

function svgSize(svg: string) {
  const root = new DOMParser().parseFromString(
    svg,
    "image/svg+xml",
  ).documentElement;
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  return {
    width: Number(root.getAttribute("width")) || viewBox?.[2] || 800,
    height: Number(root.getAttribute("height")) || viewBox?.[3] || 600,
  };
}

type MermaidJs = typeof import("mermaid")["default"];
let mermaidJs: Promise<MermaidJs> | null = null;
/** mermaid.js is configured globally: one diagram at a time. */
let mermaidJsQueue: Promise<unknown> = Promise.resolve();
let mermaidJsRenders = 0;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

async function drawWithMermaidJs(
  code: string,
  theme: DiagramTheme,
): Promise<DrawnDiagram> {
  mermaidJs ??= importWithReload("mermaid-js", () => import("mermaid")).then(
    (module) => module.default,
  );
  const mermaid = await mermaidJs;
  const source = normalizeMermaidSource(code);
  const drawn = mermaidJsQueue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      // Labels as SVG text, not HTML in a foreignObject.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    });
    mermaidJsRenders += 1;
    // Laid out in a column of a message's width, not the page's (a gantt
    // takes the width it is given), out of sight.
    const column = document.createElement("div");
    column.style.cssText =
      "position:fixed;left:-10000px;top:0;width:800px;visibility:hidden";
    document.body.append(column);
    try {
      return (
        await mermaid.render(
          `roamgate-mermaid-${mermaidJsRenders}`,
          source,
          column,
        )
      ).svg;
    } finally {
      column.remove();
    }
  });
  mermaidJsQueue = drawn.catch(() => {});
  const image = svgImage(await drawn);
  return image.ok
    ? {
        kind: "image",
        url: image.url,
        width: image.width,
        height: image.height,
        paper: false,
      }
    : { kind: "error", error: image.error };
}

/** Draws a diagram; never rejects (a failure is an "error" diagram). */
export async function drawDiagram(
  lang: DiagramLanguage,
  code: string,
  theme: DiagramTheme,
  /** The theme's text color, for SVG drawn in currentColor. */
  color: string,
): Promise<DrawnDiagram> {
  try {
    if (lang === "svg") {
      const image = svgImage(code, { color });
      return image.ok
        ? {
            kind: "image",
            url: image.url,
            width: image.width,
            height: image.height,
            paper: !image.themed,
          }
        : { kind: "error", error: image.error };
    }
    if (!normalizeMermaidSource(code).trim())
      return { kind: "error", error: "Empty diagram" };
    const renderer = mermaidRenderer(code);
    if (renderer === "beautiful") {
      const drawn = renderMermaidDiagram(await loadMermaidModule(), code);
      if (drawn.ok)
        return { kind: "inline", svg: drawn.svg, ...svgSize(drawn.svg) };
      // A header it does not take ("graph" alone): mermaid.js may.
      if (!/header/i.test(drawn.error))
        return { kind: "error", error: drawn.error };
    } else if (!renderer) {
      const word = normalizeMermaidSource(code).split(/\s/, 1)[0] ?? "";
      return {
        kind: "error",
        error: `Unknown diagram type "${word.slice(0, 40)}"`,
      };
    }
    return await drawWithMermaidJs(code, theme);
  } catch (error) {
    return { kind: "error", error: message(error) };
  }
}

/** Whether a drawing depends on the theme (and must be drawn again). */
export function themedDrawing(lang: DiagramLanguage, code: string): boolean {
  return lang === "svg" || mermaidRenderer(code) !== "beautiful";
}
