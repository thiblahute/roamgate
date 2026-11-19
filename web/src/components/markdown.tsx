import { resolveWorkspaceMarkdownLink } from "../workspaceFileUrl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Lexer, Marked, type Tokens } from "marked";
import { diagramMarkdown, endsInOpenFence } from "../diagramSource";
import { useForgeSlots } from "../forgeSlots";
import { useDiagramSlots } from "./DiagramSlots";
import {
  listItemLines,
  type MarkdownBlock,
  markdownBlocks,
  narrowLines,
  quoteOffset,
  type SlotColumn,
  type SourceItem,
  type SourceStop,
  sourceStopOf,
} from "../renderedSource";
import "./markdown.css";

const MARKDOWN_ALLOWED_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const MARKDOWN_ALLOWED_ATTRS = new Set([
  "alt",
  "checked",
  "colspan",
  "disabled",
  "href",
  "rowspan",
  "src",
  "title",
  "type",
]);
const MARKDOWN_DROP_CONTENT_TAGS = new Set([
  "iframe",
  "object",
  "script",
  "style",
]);
/**
 * The names a project's markdown file may use as HTML (the elements of
 * HTML, SVG and MathML a README draws with): the sanitizer drops their
 * tags, or them with their content, as it does any HTML.
 */
const HTML_ELEMENT_NAMES = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo blockquote body " +
    "br button canvas caption center cite code col colgroup data datalist dd " +
    "del details dfn dialog div dl dt em embed fieldset figcaption figure " +
    "font footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe " +
    "img input ins kbd label legend li link main map mark menu meta meter " +
    "nav noscript object ol optgroup option output p param picture pre " +
    "progress q rp rt ruby s samp script search section select slot small " +
    "source span strike strong style sub summary sup table tbody td template " +
    "textarea tfoot th thead time title tr track tt u ul var video wbr " +
    "svg g path circle ellipse line polygon polyline rect text tspan defs use " +
    "symbol lineargradient radialgradient stop clippath mask pattern " +
    "foreignobject math mi mn mo mrow msup msub mfrac msqrt"
  ).split(" "),
);

/**
 * `text` with each `<` that does not start a tag `keep` takes, or an HTML
 * comment, written `&lt;`: shown as written, not read as a tag the
 * sanitizer would drop.
 */
function escapeUnknownTags(
  text: string,
  keep: (name: string) => boolean,
): string {
  return text.replace(
    /<(?:(!--)|\/?([A-Za-z][\w-]*)(?=[\s/>]|$))?/g,
    (match, comment?: string, name?: string) =>
      comment || (name && keep(name.toLowerCase()))
        ? match
        : `&lt;${match.slice(1)}`,
  );
}

/** The raw HTML a chat message or comment draws: the tags allowed only. */
const messageTag = (name: string) => MARKDOWN_ALLOWED_TAGS.has(name);
/** The raw HTML a project's markdown file draws: any HTML element. */
const documentTag = (name: string) =>
  HTML_ELEMENT_NAMES.has(name) || name.includes("-");

/**
 * A markdown parser whose raw HTML keeps only the tags `keep` takes; any
 * other `<` is text. A block of raw HTML with text in it is read again as
 * markdown, its text shown as written.
 */
function markdownParser(keep: (name: string) => boolean) {
  return new Marked({
    renderer: {
      html(token) {
        const text = escapeUnknownTags(token.text, keep);
        if (text === token.text || !token.block) return text;
        return this.parser.parse(Lexer.lex(text, this.options));
      },
    },
  });
}
const messageMarkdown = markdownParser(messageTag);
const documentMarkdown = markdownParser(documentTag);

export function isSafeMarkdownUrl(value: string) {
  // Browsers drop tabs and line breaks anywhere in a URL, and spaces and
  // control characters around it: "java\tscript:" is "javascript:". They
  // also read a backslash as a slash, so "/\host" is another origin.
  const trimmed = [...value]
    .filter((char) => char > " " && char !== "\u007f")
    .join("")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (!trimmed || trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/);
  if (!protocolMatch) return true;
  return ["http:", "https:", "mailto:"].includes(protocolMatch[0]);
}

type MarkdownRenderOptions = {
  breaks?: boolean;
  imageUrlResolver?: (source: string) => string | null;
  documentPath?: string;
  linkUrlResolver?: (path: string) => string;
  /** Each top-level block wrapped with its source lines, a slot after it. */
  sourceBlocks?: boolean;
  /** Raw HTML blocks left out, for a frame to draw (scripts on). */
  htmlFrames?: boolean;
  /**
   * A project's markdown file, whose raw HTML is meant as HTML: any HTML
   * element's tags are read as tags. Otherwise (a chat message, a comment)
   * only the tags the sanitizer keeps are, and any other `<` is text, so
   * `"peer":"<id>"` reads as written.
   */
  htmlDocument?: boolean;
};

export type MarkdownSelectionTarget = {
  quote: string;
  section: string[];
  x: number;
  y: number;
  /** The source lines of the words, when drawn with their lines. */
  line?: number;
  endLine?: number;
};

function selectionElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

export function markdownHeadingPath(root: Element, node: Node): string[] {
  const target = selectionElement(node);
  if (!target || !root.contains(target)) return [];
  const path: string[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>(
    "h1, h2, h3, h4, h5, h6",
  )) {
    const beforeTarget =
      heading === target ||
      heading.contains(target) ||
      Boolean(
        heading.compareDocumentPosition(target) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    if (!beforeTarget) break;
    const level = Number(heading.tagName.slice(1));
    path.length = Math.min(path.length, level - 1);
    path[level - 1] = heading.textContent?.trim() ?? "";
  }
  return path.filter(Boolean);
}

export function markdownSelectionTarget(
  root: HTMLElement,
  selection: Selection | null = window.getSelection(),
  sourceLines?: readonly string[],
): MarkdownSelectionTarget | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const start = selectionElement(range.startContainer);
  const end = selectionElement(range.endContainer);
  if (!start || !end || !root.contains(start) || !root.contains(end)) {
    return null;
  }
  if (start.closest(".diagram-block") || end.closest(".diagram-block")) {
    return null;
  }
  // The words of a comment drawn in the file are not the file's.
  if (start.closest(".md-thread-slot") || end.closest(".md-thread-slot")) {
    return null;
  }
  const quote = selection
    .toString()
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!quote || quote.length > 20_000) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const first = start.closest<HTMLElement>(".md-source-block");
  const last = end.closest<HTMLElement>(".md-source-block");
  const lines =
    sourceLines && first && last
      ? narrowLines(
          sourceLines,
          Number(first.dataset.line),
          Number(last.dataset.end),
          quote,
        )
      : null;
  return {
    quote,
    section: markdownHeadingPath(root, range.startContainer),
    x: rect.left,
    y: rect.bottom + 6,
    ...(lines
      ? {
          line: lines.line,
          ...(lines.endLine !== lines.line ? { endLine: lines.endLine } : {}),
        }
      : {}),
  };
}

export function sanitizeMarkdownHtml(
  html: string,
  options: MarkdownRenderOptions = {},
) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    // The wrappers made below; a document's own <div> is not one of them.
    if (
      options.sourceBlocks &&
      tag === "div" &&
      (element.parentElement === doc.body
        ? /^md-(source-block|thread-slot)$/.test(element.className)
        : element.className === "md-html-slot" &&
          element.parentElement?.parentElement === doc.body &&
          element.parentElement.className === "md-source-block")
    )
      continue;
    if (MARKDOWN_DROP_CONTENT_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!MARKDOWN_ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    if (tag === "input") {
      const isCheckbox = element.getAttribute("type") === "checkbox";
      if (!isCheckbox) {
        element.remove();
        continue;
      }
      element.setAttribute("disabled", "");
    }

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name === "class" &&
        tag === "code" &&
        /^language-[a-z0-9#+.-]{1,40}$/i.test(attr.value.trim())
      ) {
        // Keep the fenced-code language hint so mermaid blocks can be found
        // and replaced with rendered diagrams after sanitization.
        continue;
      }
      if (
        name === "start" &&
        tag === "ol" &&
        /^\d{1,9}$/.test(attr.value.trim())
      ) {
        // A list drawn in parts (a chat message's commentable items) keeps
        // each item's number.
        continue;
      }
      if (
        name.startsWith("on") ||
        name === "style" ||
        !MARKDOWN_ALLOWED_ATTRS.has(name)
      ) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" || name === "src") {
        if (!isSafeMarkdownUrl(attr.value)) {
          element.removeAttribute(attr.name);
          continue;
        }
        if (name === "src" && tag === "img" && options.imageUrlResolver) {
          const resolved = options.imageUrlResolver(attr.value);
          if (!resolved || !isSafeMarkdownUrl(resolved)) {
            element.removeAttribute(attr.name);
          } else {
            element.setAttribute(attr.name, resolved);
          }
        }
      }
    }

    if (tag === "a" && element.hasAttribute("href")) {
      const href = element.getAttribute("href")!;
      const destination = options.documentPath
        ? resolveWorkspaceMarkdownLink(href, options.documentPath)
        : undefined;
      if (destination === null) {
        element.removeAttribute("href");
      } else if (destination) {
        element.setAttribute("data-document-path", destination.path);
        element.setAttribute("data-document-fragment", destination.fragment);
        element.setAttribute(
          "href",
          options.linkUrlResolver?.(destination.path) ?? "#",
        );
      } else if (!href.startsWith("#")) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
      }
    }
  }

  const headingIds = new Set<string>();
  for (const heading of doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const base = (heading.textContent ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    let id = base;
    let suffix = 0;
    while (headingIds.has(id)) id = `${base}-${++suffix}`;
    headingIds.add(id);
    heading.setAttribute("id", id);
  }
  return doc.body.innerHTML;
}

/** A raw HTML block with something to draw (not a comment). */
function framedHtml(block: MarkdownBlock): boolean {
  const raw = block.tokens[0]?.raw ?? "";
  return block.type === "html" && !/^\s*<!--[\s\S]*-->\s*$/.test(raw);
}

export function renderMarkdown(
  text: string,
  options: MarkdownRenderOptions = {},
) {
  // Chat messages are not authored as strict markdown documents, so callers
  // rendering conversation text should opt into breaks to keep intentional
  // single newlines instead of collapsing them into one paragraph.
  const breaks = options.breaks ?? false;
  const parser = options.htmlDocument ? documentMarkdown : messageMarkdown;
  const html = options.sourceBlocks
    ? markdownBlocks(text)
        .map((block, index) => {
          const body =
            options.htmlFrames && framedHtml(block)
              ? `<div class="md-html-slot" data-html-index="${index}"></div>`
              : parser.parser(block.tokens, {
                  async: false,
                  breaks,
                  gfm: true,
                });
          return `<div class="md-source-block" data-line="${block.start}" data-end="${block.end}" data-stop="b:${block.start}">${body}</div><div class="md-thread-slot" data-line="${block.start}" data-end="${block.end}" data-stops="b:${block.start}"></div>`;
        })
        .join("")
    : parser.parse(text, { async: false, breaks, gfm: true });
  const clean = sanitizeMarkdownHtml(String(html), options);
  return options.sourceBlocks ? withSourceItems(clean, text) : clean;
}

/** A line of a chat message or comment (a table's cell), sanitized. */
export function renderInlineMarkdown(
  text: string,
  options: MarkdownRenderOptions = {},
) {
  return sanitizeMarkdownHtml(
    String(messageMarkdown.parseInline(text, { async: false, gfm: true })),
    options,
  );
}

/** An element made in `doc`, with these attributes. */
function made(
  doc: Document,
  tag: string,
  attributes: Record<string, string | number>,
): HTMLElement {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, String(value));
  return element;
}

/**
 * A list's items, each its own stop: its own words (not its nested
 * lists) in a .md-source-item with their lines, a slot for its threads
 * after them.
 */
function markItems(list: Element, items: readonly SourceItem[]) {
  const doc = list.ownerDocument;
  const lis = [...list.children].filter((child) => child.tagName === "LI");
  lis.forEach((li, index) => {
    const item = items[index];
    if (!item) return;
    const nested = [...li.children].filter(
      (child) => child.tagName === "UL" || child.tagName === "OL",
    );
    const own = made(doc, "div", {
      class: "md-source-item",
      "data-line": item.line,
      "data-end": item.end,
      "data-stop": `b:${item.line}`,
    });
    for (const node of [...li.childNodes]) {
      if (node === nested[0]) break;
      own.append(node);
    }
    li.prepend(
      own,
      made(doc, "div", {
        class: "md-thread-slot",
        "data-line": item.line,
        "data-end": item.end,
        "data-stops": `b:${item.line}`,
      }),
    );
    nested.forEach((child, at) => {
      const inner = item.lists[at];
      if (inner) markItems(child, inner);
    });
  });
}

/**
 * A table's cells, each its own stop on its row's line (the header's
 * first, the body's after the delimiter row), a row for the threads on a
 * row's cells after it.
 */
function markCells(table: Element, start: number) {
  const doc = table.ownerDocument;
  const rows = [...table.querySelectorAll("tr")];
  rows.forEach((row, index) => {
    // The header row, then the body's after the |---| line.
    const line = index === 0 ? start : start + index + 1;
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    const keys = cells.map((cell, column) => {
      const key = `b:${line}:${column}`;
      cell.classList.add("md-source-item");
      cell.setAttribute("data-line", String(line));
      cell.setAttribute("data-end", String(line));
      cell.setAttribute("data-stop", key);
      return key;
    });
    const threads = made(doc, "tr", { class: "md-thread-row" });
    const holder = made(doc, "td", { colspan: Math.max(1, cells.length) });
    holder.append(
      made(doc, "div", {
        class: "md-thread-slot",
        "data-line": line,
        "data-end": line,
        "data-stops": keys.join(" "),
      }),
    );
    threads.append(holder);
    row.after(threads);
  });
}

/**
 * The stops inside the blocks: a list's items (nested ones too) and a
 * table's cells get their own lines; their block is no stop then.
 */
function withSourceItems(html: string, text: string): string {
  const blocks = markdownBlocks(text);
  if (!blocks.some((block) => block.type === "list" || block.type === "table"))
    return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const wrappers = [...doc.body.children].filter((child) =>
    child.classList.contains("md-source-block"),
  );
  wrappers.forEach((wrapper, index) => {
    const block = blocks[index];
    const token = block?.tokens[0];
    if (!block || !token) return;
    const root = [...wrapper.children][0];
    if (
      block.type === "list" &&
      (root?.tagName === "UL" || root?.tagName === "OL")
    )
      markItems(root, listItemLines(token as Tokens.List, block.start));
    else if (block.type === "table" && root?.tagName === "TABLE")
      markCells(root, block.start);
    else return;
    // Its items hold its threads.
    wrapper.removeAttribute("data-stop");
    wrapper.nextElementSibling?.setAttribute("data-stops", "");
  });
  return doc.body.innerHTML;
}

/**
 * What a slot of threads is told besides its stops (MarkdownPreview's
 * threadsFor): which stop a thread on a line and quote goes to, where a
 * quote is in a stop's words (-1: not found), and, in a table, its row's
 * columns as drawn (none until measured).
 */
export type SlotWhere = {
  stopOf: (line: number, quote?: string) => string | undefined;
  quoteAt: (stop: string, quote: string) => number;
  columns?: readonly SlotColumn[];
};

/**
 * The columns of the row a table's slot of threads is under, from the
 * row's left edge; none when the slot is not a table's, or not drawn.
 */
export function slotColumns(slot: HTMLElement): SlotColumn[] | undefined {
  const row = slot.closest("tr.md-thread-row")?.previousElementSibling;
  if (!row) return undefined;
  const boxes = [...row.children]
    .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
    .map((cell) => cell.getBoundingClientRect());
  if (!boxes.length || !boxes.some((box) => box.width > 0)) return undefined;
  const first = boxes[0]!.left;
  return boxes.map((box, index) => ({
    left: box.left - first,
    // Up to the next cell: the columns tile the row, borders and all.
    width:
      index < boxes.length - 1 ? boxes[index + 1]!.left - box.left : box.width,
  }));
}

/**
 * The stops of a source-lined preview (MarkdownPreview with threadsFor):
 * the blocks, but the items and cells of lists and tables.
 */
export function sourceStopElements(root: ParentNode): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(".md-source-block, .md-source-item"),
  ].filter(
    (stop) =>
      stop.classList.contains("md-source-item") ||
      stop.dataset.stop !== undefined,
  );
}

export function MarkdownPreview({
  text,
  className = "",
  breaks = false,
  imageUrlResolver,
  documentPath,
  linkUrlResolver,
  onOpenDocument,
  fragment,
  onSelectionChange,
  threadsFor,
  htmlBlock,
  htmlDocument = false,
}: {
  text: string;
  className?: string;
  breaks?: boolean;
  imageUrlResolver?: (source: string) => string | null;
  documentPath?: string;
  linkUrlResolver?: (path: string) => string;
  onOpenDocument?: (path: string, fragment: string) => void;
  fragment?: string;
  onSelectionChange?: (target: MarkdownSelectionTarget | null) => void;
  /**
   * Draws each block with its lines, and each list item and table cell
   * with its own; under each, this, given the stops a slot holds and
   * which stop a thread on a line and quote goes to (the file's threads),
   * with where quotes are in them and a table row's columns.
   */
  threadsFor?: (
    stops: readonly string[],
    stopOf: (line: number, quote?: string) => string | undefined,
    where: SlotWhere,
  ) => ReactNode;
  /** With scripts on: draws a raw HTML block itself. */
  htmlBlock?: (html: string) => ReactNode;
  /** A project's markdown file: its raw HTML is meant as HTML. */
  htmlDocument?: boolean;
}) {
  // SVG markup alone is drawn as an ```svg block.
  const source = useMemo(() => diagramMarkdown(text), [text]);
  const sourceBlocks = threadsFor !== undefined;
  const htmlFrames = htmlBlock !== undefined;
  const html = useMemo(
    () =>
      renderMarkdown(source, {
        breaks,
        imageUrlResolver,
        documentPath,
        linkUrlResolver,
        sourceBlocks,
        htmlFrames,
        htmlDocument,
      }),
    [
      htmlDocument,
      htmlFrames,
      source,
      breaks,
      imageUrlResolver,
      documentPath,
      linkUrlResolver,
      sourceBlocks,
    ],
  );
  const sourceLines = useMemo(
    () =>
      sourceBlocks ? source.replace(/\r\n?/g, "\n").split("\n") : undefined,
    [source, sourceBlocks],
  );
  const [slots, setSlots] = useState<{
    list: { element: HTMLElement; stops: string[] }[];
    stops: SourceStop[];
  }>({ list: [], stops: [] });
  const articleRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (fragment) scrollToMarkdownHeading(articleRef.current, fragment);
  }, [html, fragment]);
  useLayoutEffect(() => {
    const root = articleRef.current;
    setSlots(
      sourceBlocks && root
        ? {
            list: [
              ...root.querySelectorAll<HTMLElement>(".md-thread-slot"),
            ].map((element) => ({
              element,
              stops: (element.dataset.stops ?? "").split(" ").filter(Boolean),
            })),
            stops: sourceStopElements(root).map((stop) => ({
              key: stop.dataset.stop ?? `b:${stop.dataset.line}`,
              line: Number(stop.dataset.line),
              end: Number(stop.dataset.end),
              text: stop.textContent ?? "",
            })),
          }
        : { list: [], stops: [] },
    );
  }, [html, sourceBlocks]);
  const stopOf = useCallback(
    (line: number, quote?: string) => sourceStopOf(slots.stops, line, quote),
    [slots.stops],
  );
  const quoteAt = useCallback(
    (stop: string, quote: string) => {
      const text = slots.stops.find((each) => each.key === stop)?.text;
      return text === undefined ? -1 : quoteOffset(text, quote);
    },
    [slots.stops],
  );
  // A table's rows as drawn, for their threads to sit in their cells'
  // columns: measured again as the preview or a table changes size.
  const [columns, setColumns] = useState<
    readonly (readonly SlotColumn[] | undefined)[]
  >([]);
  useLayoutEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      const next = slots.list.map(({ element }) => slotColumns(element));
      setColumns((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    measure();
    const tables = root.querySelectorAll("table");
    if (!tables.length || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(root);
    for (const table of tables) observer.observe(table);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [slots.list]);
  const [htmlSlots, setHtmlSlots] = useState<
    { element: HTMLElement; html: string }[]
  >([]);
  useLayoutEffect(() => {
    if (!htmlFrames) {
      setHtmlSlots([]);
      return;
    }
    const blocks = markdownBlocks(source);
    setHtmlSlots(
      [
        ...(articleRef.current?.querySelectorAll<HTMLElement>(
          ".md-html-slot",
        ) ?? []),
      ].map((element) => ({
        element,
        html: blocks[Number(element.dataset.htmlIndex)]?.tokens[0]?.raw ?? "",
      })),
    );
  }, [html, htmlFrames, source]);

  const openLink = (event: React.MouseEvent<HTMLElement>) => {
    const target =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (!target || !event.currentTarget.contains(target)) return;
    const path = target.getAttribute("data-document-path");
    if (path && onOpenDocument) {
      event.preventDefault();
      const anchor = target.getAttribute("data-document-fragment") ?? "";
      if (path === documentPath) {
        if (anchor) scrollToMarkdownHeading(articleRef.current, anchor);
        else articleRef.current?.scrollIntoView({ block: "start" });
      } else onOpenDocument(path, anchor);
    } else if (target.getAttribute("href")?.startsWith("#")) {
      event.preventDefault();
      const hash = target.getAttribute("href")!.slice(1);
      let anchor = hash;
      try {
        anchor = decodeURIComponent(hash);
      } catch {
        /* Keep malformed fragments literal. */
      }
      scrollToMarkdownHeading(articleRef.current, anchor);
    }
  };

  // Its ```mermaid and ```svg blocks, as diagrams; a block still being
  // streamed stays code until it is closed.
  const openAtEnd = useMemo(() => endsInOpenFence(source), [source]);
  const diagrams = useDiagramSlots(articleRef, html, openAtEnd);

  // A chat's merge and pull request references, as chips.
  const forgeChips = useForgeSlots(articleRef, html);

  useEffect(() => {
    if (!onSelectionChange) return;
    let frame = 0;
    const updateSelection = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = articleRef.current;
        onSelectionChange(
          root ? markdownSelectionTarget(root, undefined, sourceLines) : null,
        );
      });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", updateSelection);
    };
  }, [onSelectionChange, sourceLines]);

  return (
    <>
      <article
        ref={articleRef}
        onClick={openLink}
        onAuxClick={(event) => {
          if (event.button === 1) openLink(event);
        }}
        className={`file-preview-markdown ${className}`.trim()}
        data-forge-scan=""
        onPointerDown={() => onSelectionChange?.(null)}
        onPointerUp={() => {
          requestAnimationFrame(() => {
            const root = articleRef.current;
            onSelectionChange?.(
              root
                ? markdownSelectionTarget(root, undefined, sourceLines)
                : null,
            );
          });
        }}
        onKeyUp={() => {
          const root = articleRef.current;
          onSelectionChange?.(
            root ? markdownSelectionTarget(root, undefined, sourceLines) : null,
          );
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {diagrams}
      {forgeChips}
      {htmlBlock
        ? htmlSlots.map(({ element, html: raw }, index) =>
            createPortal(htmlBlock(raw), element, `html-${index}`),
          )
        : null}
      {threadsFor
        ? slots.list.map(({ element, stops }, index) =>
            createPortal(
              threadsFor(stops, stopOf, {
                stopOf,
                quoteAt,
                ...(columns[index] ? { columns: columns[index] } : {}),
              }),
              element,
              `slot-${index}`,
            ),
          )
        : null}
    </>
  );
}

function scrollToMarkdownHeading(root: HTMLElement | null, fragment: string) {
  const heading = Array.from(
    root?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [],
  ).find((element) => element.id === fragment);
  heading?.scrollIntoView({ block: "start" });
}
