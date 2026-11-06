import { createContext, type ReactNode, useContext } from "react";
import type { FileEdit } from "../../shared/fileEdits";
import type { ReviewAnchor, ReviewChatPart } from "../../shared/review";
import type { HistoryEntry } from "./components/agentHistory";

/**
 * Comments on the files a chat's tool calls changed (their diff cards):
 * the rows a card shows, what a comment on some of them anchors on, and
 * where a thread on a card is drawn again. A thread on a card is one of the
 * chat's threads (target `chat`) whose anchor carries the file and lines as
 * a review comment on code does.
 */

export type FileEditRow =
  | { kind: "gap" }
  | {
      kind: "add" | "remove" | "context";
      text: string;
      /** The line's number in the file it is in, when known. */
      number?: number;
    };

type LineRow = Exclude<FileEditRow, { kind: "gap" }>;

const isLine = (row: FileEditRow): row is LineRow => row.kind !== "gap";

/**
 * An edit's lines, numbered when its hunks say where they start: an added
 * or kept line by its new number, a removed one by its old one. Hunks are
 * apart by a gap row.
 */
export function fileEditRows(edit: FileEdit): FileEditRow[] {
  const rows: FileEditRow[] = [];
  for (const [index, hunk] of edit.hunks.entries()) {
    if (index > 0) rows.push({ kind: "gap" });
    let old = hunk.old_start;
    let next = hunk.new_start;
    for (const line of hunk.lines) {
      const sign = line.charAt(0);
      const text = line.slice(1);
      if (sign === "+") {
        rows.push({ kind: "add", text, ...(next ? { number: next } : {}) });
        if (next) next += 1;
      } else if (sign === "-") {
        rows.push({ kind: "remove", text, ...(old ? { number: old } : {}) });
        if (old) old += 1;
      } else {
        rows.push({
          kind: "context",
          text,
          ...(next ? { number: next } : {}),
        });
        if (old) old += 1;
        if (next) next += 1;
      }
    }
  }
  return rows;
}

/** The most a quote keeps, as the server does. */
const MAX_QUOTE = 4000;

const SIGNS = { add: "+", remove: "-", context: " " } as const;

/** Where a comment on a card is, and the words it quotes. */
export type FileEditPlace = Pick<
  ReviewAnchor,
  "line" | "endLine" | "side" | "text"
> & { path: string; quote: string };

/**
 * What a comment on the rows `from` to `to` of a card is on (-1: the file
 * as a whole, quoted by its path). The lines on the new side, numbered as
 * the change left the file, unless only removed lines are taken (then as
 * the file was before it); none when the change has no numbers (a call
 * still running). The quote is the lines' text, each marked + or - when
 * removed lines are taken with others.
 */
export function fileEditPlace(
  edit: FileEdit,
  from: number,
  to: number,
): FileEditPlace {
  const whole = { path: edit.path, quote: edit.path };
  if (from < 0 || to < 0) return whole;
  const rows = fileEditRows(edit);
  const taken = rows
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .filter(isLine);
  if (!taken.length) return whole;
  const kept = taken.filter((row) => row.kind !== "remove");
  const side = kept.length ? "new" : "old";
  const numbered = (kept.length ? kept : taken).filter(
    (row) => row.number !== undefined,
  );
  const mixed = kept.length > 0 && kept.length < taken.length;
  const quote = taken
    .map((row) => (mixed ? `${SIGNS[row.kind]}${row.text}` : row.text))
    .join("\n")
    .slice(0, MAX_QUOTE);
  const first = numbered[0];
  const last = numbered[numbered.length - 1];
  return {
    path: edit.path,
    ...(first?.number
      ? {
          line: first.number,
          ...(last?.number && last.number !== first.number
            ? { endLine: last.number }
            : {}),
          side,
          ...(first.text.trim() ? { text: first.text } : {}),
        }
      : {}),
    // A blank line still says which: the server keeps no empty quote.
    quote: quote.trim()
      ? quote
      : `(blank ${taken.length === 1 ? "line" : "lines"})`,
  };
}

/** A comment's anchor on the rows `from` to `to` of a call's card. */
export function fileEditAnchor(
  call: HistoryEntry,
  edit: FileEdit,
  from: number,
  to: number,
): ReviewAnchor {
  const { quote, ...where } = fileEditPlace(edit, from, to);
  return {
    ...where,
    chat: {
      entry: call.id,
      quote,
      ...(call.sent_at ? { at: call.sent_at } : {}),
      ...(call.source_call_id ? { call: call.source_call_id } : {}),
    },
  };
}

/** A thread on a file change rather than on a message's words. */
export function onFileEdit(anchor: ReviewAnchor): boolean {
  return !!anchor.chat && !!anchor.path;
}

/**
 * The tool call a comment on a file change is on, among the entries shown:
 * by its entry id, else by the call's own id (the chat read the call with
 * another entry id: a streamed call now the transcript's). Null: not shown.
 */
export function fileEditEntry(
  part: ReviewChatPart,
  entries: readonly HistoryEntry[],
  ids: ReadonlySet<string> = new Set(entries.map((entry) => entry.id)),
): string | null {
  if (ids.has(part.entry)) return part.entry;
  if (!part.call) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "tool_call" && entry.source_call_id === part.call)
      return entry.id;
  }
  return null;
}

/**
 * Where a thread is drawn on a card: under the file's head (on the file as
 * a whole), under a row (the last of its lines), or at the card's end with
 * its quote, its lines being no longer in the change as shown.
 */
export type FileEditThreadPlace =
  | { at: "head" }
  | { at: "row"; row: number }
  | { at: "end" };

const loose = (text: string) => text.trim();

/**
 * Finds a thread's lines on a card again: by their numbers when the first
 * still reads as it did, else by that line's text nearest its number (the
 * same count of lines on), else by the quote, row for row.
 */
export function placeFileEditThread(
  rows: readonly FileEditRow[],
  anchor: ReviewAnchor,
): FileEditThreadPlace {
  const quote = anchor.chat?.quote ?? "";
  if (!anchor.line && (!quote || quote === anchor.path)) return { at: "head" };
  if (anchor.line) {
    const old = anchor.side === "old";
    const onSide = (row: FileEditRow): row is LineRow =>
      isLine(row) && (row.kind === "remove") === old;
    const indexOf = (number: number) =>
      rows.findIndex((row) => onSide(row) && row.number === number);
    const start = indexOf(anchor.line);
    const startRow = rows[start];
    if (
      startRow &&
      isLine(startRow) &&
      (anchor.text === undefined || loose(startRow.text) === loose(anchor.text))
    ) {
      const end = anchor.endLine ? indexOf(anchor.endLine) : start;
      return { at: "row", row: Math.max(start, end) };
    }
    if (anchor.text !== undefined) {
      const line = anchor.line;
      const text = loose(anchor.text);
      let best = -1;
      let distance = Number.POSITIVE_INFINITY;
      rows.forEach((row, index) => {
        if (!onSide(row) || loose(row.text) !== text) return;
        const away =
          row.number === undefined
            ? Number.MAX_SAFE_INTEGER
            : Math.abs(row.number - line);
        if (away < distance) {
          best = index;
          distance = away;
        }
      });
      if (best >= 0) {
        let row = best;
        let left = (anchor.endLine ?? line) - line;
        for (let index = best + 1; index < rows.length && left > 0; index++)
          if (onSide(rows[index]!)) {
            row = index;
            left -= 1;
          }
        return { at: "row", row };
      }
    }
  }
  // By the quote: the run of rows reading as its lines (marked or not).
  const lines = quote.split("\n").map(loose);
  const reads = (row: FileEditRow | undefined, line: string) =>
    !!row &&
    isLine(row) &&
    (loose(row.text) === line ||
      loose(`${SIGNS[row.kind]}${row.text}`) === line);
  for (let start = 0; start + lines.length <= rows.length; start++)
    if (lines.every((line, offset) => reads(rows[start + offset], line)))
      return { at: "row", row: start + lines.length - 1 };
  return { at: "end" };
}

/**
 * The rows of a card (`[data-row]`) a selection runs over, as `[from,
 * to]`; none (the head's words only): `[-1, -1]`, the file. A selection
 * ending at the very start of a row (a line selected whole) leaves it out.
 */
export function selectedRows(card: Element, range: Range): [number, number] {
  const taken = Array.from(
    card.querySelectorAll<HTMLElement>("[data-row]"),
  ).filter((row) => range.intersectsNode(row));
  const last = taken[taken.length - 1];
  if (
    last &&
    taken.length > 1 &&
    range.endOffset === 0 &&
    last.contains(range.endContainer)
  )
    taken.pop();
  if (!taken.length) return [-1, -1];
  return [
    Number(taken[0]!.dataset.row),
    Number(taken[taken.length - 1]!.dataset.row),
  ];
}

/** The threads on a card, and what it takes to comment on it. */
export type FileEditParts = {
  /** The threads on the card and the comment being written, each drawn
   * where its anchor says. */
  notes: readonly { key: string; anchor: ReviewAnchor; node: ReactNode }[];
  /** The part j / k is on: 0 the file's head, n the row n - 1. */
  focused: number | null;
  /** Comments on the rows `from` to `to` (-1: on the file as a whole). */
  onComment: (from: number, to: number) => void;
  /** A tap or click on a part puts j / k on it. */
  onSelect: (part: number) => void;
};

type FileEditThreads = {
  partsFor: (call: HistoryEntry, edit: FileEdit) => FileEditParts;
};

/** Given by a chat with threads (ChatThreads): its cards take comments. */
export const FileEditThreadsContext = createContext<FileEditThreads | null>(
  null,
);

/** A card's threads, when it is a call's card in a chat with threads. */
export function useFileEditParts(
  call: HistoryEntry | undefined,
  edit: FileEdit,
): FileEditParts | undefined {
  const threads = useContext(FileEditThreadsContext);
  return call && threads ? threads.partsFor(call, edit) : undefined;
}
