import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  looseText,
  type MessageBlock,
  messageBlocks,
} from "../reviewMessageParts";
import { renderMarkdown } from "./markdown";
import { highlightSnippetTokens } from "./syntaxHighlighting";
import "./ReviewNoteBody.css";

/**
 * A comment's body as the review draws it: Markdown in parts one can comment
 * on, with code in its language's colors. The review and agent chats share
 * it.
 */

export type Mark = { start: number; end: number; className: string };

/** Text cut at every mark boundary; overlapping marks stack their classes. */
export function markedText(text: string, marks: readonly Mark[] | undefined) {
  if (!marks?.length) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const mark of marks) {
    cuts.add(Math.max(0, Math.min(text.length, mark.start)));
    cuts.add(Math.max(0, Math.min(text.length, mark.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const parts: ReactNode[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]!;
    const end = points[index + 1]!;
    if (start === end) continue;
    const classes = marks
      .filter((mark) => mark.start <= start && mark.end >= end)
      .map((mark) => mark.className);
    const piece = text.slice(start, end);
    parts.push(
      classes.length ? (
        <span key={start} className={classes.join(" ")}>
          {piece}
        </span>
      ) : (
        piece
      ),
    );
  }
  return parts;
}

/** Syntax colors for a snippet in a comment, once the highlighter answers. */
export function useSnippetMarks(code: string, language: string, path?: string) {
  const [marks, setMarks] = useState<Mark[]>([]);
  useEffect(() => {
    let cancelled = false;
    highlightSnippetTokens(code, language, path)
      .then((tokens) => {
        if (!cancelled)
          setMarks(
            tokens.map((token) => ({
              start: token.from,
              end: token.to,
              className: token.className,
            })),
          );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, language, path]);
  return marks;
}

/** Marks of one line of a snippet, from where the line starts in it. */
export function lineMarks(
  marks: readonly Mark[],
  start: number,
  length: number,
) {
  return marks
    .filter((mark) => mark.end > start && mark.start < start + length)
    .map((mark) => ({
      ...mark,
      start: mark.start - start,
      end: mark.end - start,
    }));
}

/** Comments on parts of a message, and the part the cursor is on. */
export type MessageParts = {
  /** Drawn under the part they quote. */
  notes: readonly { key: string; quote: string; node: ReactNode }[];
  /** The part j / k is on, by its index among the parts. */
  focused: number | null;
  /** + beside a part: comment on it, quoting it. */
  onComment?: (quote: string) => void;
  /** A click on a part puts j / k on it. */
  onSelect?: (index: number) => void;
  /**
   * A message in one part is a stop too (an agent chat): it shows as
   * selected. The review selects such a message whole instead.
   */
  single?: boolean;
};

/** + in the margin of a part of a message: comment on that part. */
export function PartButton({
  quote,
  parts,
}: {
  quote: string;
  parts: MessageParts | undefined;
}) {
  if (!parts?.onComment) return null;
  const onComment = parts.onComment;
  return (
    <button
      type="button"
      className="rc-part-add"
      title="Comment on this part"
      aria-label="Comment on this part"
      onClick={(event) => {
        event.stopPropagation();
        onComment(quote);
      }}
    >
      +
    </button>
  );
}

/**
 * A fenced code block in a comment, in its language's colors, a part per
 * line: the comments on a line come right under it.
 */
export function NoteCode({
  lines,
  language,
  path,
  first,
  parts,
  notesAt,
}: {
  lines: readonly string[];
  language: string;
  path?: string;
  /** The index of its first line among the message's parts. */
  first: number;
  parts?: MessageParts;
  notesAt: (index: number) => ReactNode[];
}) {
  const code = lines.join("\n");
  const marks = useSnippetMarks(code, language, path);
  const segments: ReactNode[] = [];
  let rowsHere: ReactNode[] = [];
  let offset = 0;
  lines.forEach((text, line) => {
    const index = first + line;
    const start = offset;
    offset += text.length + 1;
    const notes = notesAt(index);
    rowsHere.push(
      // biome-ignore lint/a11y/useKeyWithClickEvents: j / k select by key
      <div
        key={index}
        data-part={index}
        onClick={(event) => {
          if (!parts?.onSelect) return;
          event.stopPropagation();
          parts.onSelect(index);
        }}
        className={`rc-part rc-code-line${parts?.focused === index ? " is-focused" : ""}${notes.length ? " has-notes" : ""}`}
      >
        <PartButton quote={text} parts={parts} />
        {text
          ? markedText(text, lineMarks(marks, start, text.length))
          : "\u00a0"}
      </div>,
    );
    if (notes.length || line === lines.length - 1) {
      segments.push(
        <pre key={`c${index}`} className="note-code">
          {rowsHere}
        </pre>,
        ...notes,
      );
      rowsHere = [];
    }
  });
  return <>{segments}</>;
}

/** A GitLab suggestion: the replaced lines, then the new ones. */
export function SuggestionBlock({
  range,
  code,
  newLines,
  line,
  path,
}: {
  range: string;
  code: string;
  newLines: ReadonlyMap<number, string> | undefined;
  line: number | undefined;
  path?: string;
}) {
  const marks = useSnippetMarks(code, "", path);
  let offset = 0;
  const match = /^-(\d+)\+(\d+)$/.exec(range);
  const above = match ? Number(match[1]) : 0;
  const below = match ? Number(match[2]) : 0;
  const replaced: [number, string][] = [];
  if (line !== undefined && newLines)
    for (let n = line - above; n <= line + below; n++) {
      const text = newLines.get(n);
      if (text !== undefined) replaced.push([n, text]);
    }
  return (
    <div className="suggestion">
      <div className="sg-head">
        {replaced.length
          ? "Suggested change"
          : "Suggested change (the lines it replaces are not shown)"}
      </div>
      {replaced.map(([n, text]) => (
        <div key={`d${n}`} className="sg-row sg-del">
          <span className="sg-no">{n}</span>
          <span>-{text}</span>
        </div>
      ))}
      {code.split("\n").map((text, index) => {
        const start = offset;
        offset += text.length + 1;
        return (
          <div key={`a${index}`} className="sg-row sg-add">
            <span className="sg-no" />
            <span>
              +{markedText(text, lineMarks(marks, start, text.length))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Images in comments: only those pasted into a review, by their file's
 * path; any other source (a tracker on the web) is dropped.
 */
export function reviewImageUrl(source: string): string | null {
  let path = source;
  try {
    path = decodeURI(source);
  } catch {}
  const match =
    /\/images\/([0-9a-f]{16})\/([0-9a-f]{16}\.(?:png|jpg|gif|webp))$/.exec(
      path,
    );
  return match
    ? `/api/review/image?session=${match[1]}&name=${match[2]}`
    : null;
}

/** The text a reader sees of rendered HTML: quotes are found in it. */
export function renderedText(html: string): string {
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  );
}

/**
 * A message cut into its parts (messageBlocks), rendered, with what each
 * part reads: the same for drawing it and for the keys that step through it.
 */
export type MessageLayout = {
  blocks: MessageBlock[];
  html: string[];
  /** What each part reads, as the reader sees it. */
  quotes: string[];
  /** The same, compared loosely. */
  texts: string[];
};

const messageLayouts = new Map<string, MessageLayout>();

export function messageLayout(text: string): MessageLayout {
  const known = messageLayouts.get(text);
  if (known) return known;
  const blocks = messageBlocks(text);
  const html = blocks.map((block) =>
    block.kind === "markdown"
      ? renderMarkdown(block.source, {
          breaks: true,
          imageUrlResolver: reviewImageUrl,
        })
      : "",
  );
  const quotes: string[] = [];
  blocks.forEach((block, index) => {
    if (block.kind === "markdown")
      quotes.push(renderedText(html[index]!).trim());
    else if (block.kind === "code") quotes.push(...block.lines);
    else if (block.kind === "suggestion") quotes.push(block.code);
  });
  const layout = { blocks, html, quotes, texts: quotes.map(looseText) };
  if (messageLayouts.size > 500) messageLayouts.clear();
  messageLayouts.set(text, layout);
  return layout;
}

/**
 * The part of a message a comment quotes: the first one its quote's first
 * line is in (a selection may run over several), else the last.
 */
export function quotedPart(layout: MessageLayout, quote: string): number {
  const first = looseText(quote.split("\n")[0] ?? "").slice(0, 160);
  const index = first
    ? layout.texts.findIndex((text) => text.includes(first))
    : -1;
  return index >= 0 ? index : Math.max(0, layout.texts.length - 1);
}

/**
 * maildesk's note body: Markdown, code fences and GitLab suggestions, in
 * parts one can comment on (see messageBlocks), with those comments under
 * the part they quote.
 */
export function NoteBody({
  text,
  newLines,
  line,
  path,
  parts,
}: {
  text: string;
  newLines?: ReadonlyMap<number, string>;
  line?: number;
  /** The file commented on: the language of fences that name none. */
  path?: string;
  parts?: MessageParts;
}) {
  const layout = messageLayout(text);
  const { blocks, html, quotes } = layout;
  const notesByPart = useMemo(() => {
    const byPart = new Map<number, ReactNode[]>();
    for (const note of parts?.notes ?? []) {
      const index = quotedPart(layout, note.quote);
      byPart.set(index, [
        ...(byPart.get(index) ?? []),
        <div key={note.key} className="rc-part-notes">
          {note.node}
        </div>,
      ]);
    }
    return byPart;
  }, [parts?.notes, layout]);
  const notesAt = (index: number) => notesByPart.get(index) ?? [];
  const partClass = (index: number) =>
    `rc-part${
      parts?.focused === index && (quotes.length > 1 || parts.single)
        ? " is-focused"
        : ""
    }${notesAt(index).length ? " has-notes" : ""}`;

  const out: ReactNode[] = [];
  let index = 0;
  blocks.forEach((block, position) => {
    if (block.kind === "blank") {
      out.push(
        <div
          key={`b${position}`}
          className="rc-blank"
          style={{ height: `${block.lines * 1.45}em` }}
        />,
      );
      return;
    }
    if (block.kind === "code") {
      out.push(
        <NoteCode
          key={`c${position}`}
          lines={block.lines}
          language={block.lang}
          path={path}
          first={index}
          parts={parts}
          notesAt={notesAt}
        />,
      );
      index += block.lines.length;
      return;
    }
    const at = index++;
    out.push(
      // biome-ignore lint/a11y/useKeyWithClickEvents: j / k select by key
      <div
        key={`p${position}`}
        data-part={at}
        className={partClass(at)}
        onClick={(event) => {
          if (!parts?.onSelect) return;
          event.stopPropagation();
          parts.onSelect(at);
        }}
      >
        <PartButton quote={quotes[at] ?? ""} parts={parts} />
        {block.kind === "suggestion" ? (
          <SuggestionBlock
            range={block.range}
            code={block.code}
            newLines={newLines}
            line={line}
            path={path}
          />
        ) : (
          <div
            // renderMarkdown sanitises the HTML it produces.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised
            dangerouslySetInnerHTML={{ __html: html[position]! }}
          />
        )}
      </div>,
      ...notesAt(at),
    );
  });
  return <div className="rc-text rich">{out}</div>;
}
