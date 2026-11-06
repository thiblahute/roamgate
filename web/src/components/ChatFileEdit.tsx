import { FilePen, MessageSquarePlus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { FileEdit } from "../../../shared/fileEdits";
import {
  fileEditRows,
  placeFileEditThread,
  useFileEditParts,
} from "../fileEditComments";
import type { HistoryEntry } from "./agentHistory";
import "./ChatFileEdit.css";

export { type FileEditRow, fileEditRows } from "../fileEditComments";

/** Lines shown before the rest is a tap away, as the terminal shows. */
export const FILE_EDIT_SHOWN = 10;

function splitPath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at < 0
    ? { dir: "", name: path }
    : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/**
 * A file a tool call changed, in the chat as in the terminal: the file,
 * how many lines went in and out, and the change itself, its first lines
 * shown and the rest a tap away. `state`: done, running (no result yet),
 * or asked (a permission card: nothing changed yet).
 *
 * The card of a `call` in a chat with threads takes comments as the chat's
 * messages do: on a line (its +, or `c` on it), on the lines selected, or
 * on the file (the head's button). Its threads are drawn under their
 * lines, the card showing as far down as they are; those whose lines are
 * no longer in the change show at its end with what they quote.
 */
export function ChatFileEdit({
  edit,
  state = "done",
  call,
}: {
  edit: FileEdit;
  state?: "done" | "running" | "asked";
  /** The tool call that made the change: comments are on it. */
  call?: HistoryEntry;
}) {
  const [open, setOpen] = useState(false);
  const parts = useFileEditParts(call, edit);
  const rows = useMemo(() => fileEditRows(edit), [edit]);
  // Each thread's place: under the head, under a row, or at the end.
  const placed = useMemo(() => {
    const head: ReactNode[] = [];
    const end: { key: string; quote: string; node: ReactNode }[] = [];
    const byRow = new Map<number, ReactNode[]>();
    for (const note of parts?.notes ?? []) {
      const place = placeFileEditThread(rows, note.anchor);
      const node = (
        <div key={note.key} className="chat-file-edit-thread">
          {note.node}
        </div>
      );
      if (place.at === "head") head.push(node);
      else if (place.at === "row")
        byRow.set(place.row, [...(byRow.get(place.row) ?? []), node]);
      else
        end.push({
          key: note.key,
          quote: note.anchor.chat?.quote ?? "",
          node: note.node,
        });
    }
    return { head, end, byRow };
  }, [parts?.notes, rows]);
  const focused = parts?.focused ?? null;
  // Folded, the card still shows down to its last thread (and the line
  // j / k are on).
  const reach = Math.max(
    FILE_EDIT_SHOWN,
    ...[...placed.byRow.keys()].map((row) => row + 1),
    focused ?? 0,
  );
  const lines = rows.filter((row) => row.kind !== "gap").length;
  const shown = open ? rows : rows.slice(0, reach);
  const hidden = lines - shown.filter((row) => row.kind !== "gap").length;
  const { dir, name } = splitPath(edit.path);
  const verb =
    state === "asked"
      ? "Change to"
      : state === "running"
        ? "Editing"
        : edit.created
          ? "Created"
          : "Edited";
  // The rows, in runs apart where threads are drawn under a row.
  const change: ReactNode[] = [];
  let run: ReactNode[] = [];
  const endRun = (key: string) => {
    if (run.length)
      change.push(
        <div key={key} className="chat-file-edit-lines">
          {run}
        </div>,
      );
    run = [];
  };
  shown.forEach((row, index) => {
    if (row.kind === "gap") {
      run.push(
        // The rows of one edit never change order.
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        <div key={index} className="chat-file-edit-gap">
          ...
        </div>,
      );
      return;
    }
    const notes = placed.byRow.get(index);
    run.push(
      // biome-ignore lint/a11y/useKeyWithClickEvents: j / k select by key
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
        key={index}
        className={`chat-file-edit-line is-${row.kind}${focused === index + 1 ? " is-focused" : ""}${notes ? " has-notes" : ""}`}
        data-row={index}
        data-part={parts ? index + 1 : undefined}
        onClick={
          parts
            ? (event) => {
                event.stopPropagation();
                parts.onSelect(index + 1);
              }
            : undefined
        }
      >
        <span className="chat-file-edit-number">
          {row.number ?? ""}
          {parts ? (
            <button
              type="button"
              className="chat-file-edit-add"
              title="Comment on this line"
              aria-label={`Comment on ${row.number ? `line ${row.number}` : "this line"}`}
              onClick={(event) => {
                event.stopPropagation();
                parts.onComment(index, index);
              }}
            />
          ) : null}
        </span>
        <span className="chat-file-edit-sign">
          {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
        </span>
        <span className="chat-file-edit-text">{row.text}</span>
      </div>,
    );
    if (notes) {
      endRun(`l${index}`);
      change.push(
        <div key={`n${index}`} className="chat-file-edit-notes">
          {notes}
        </div>,
      );
    }
  });
  endRun("l");
  return (
    <div
      className={`chat-file-edit${state === "running" ? " is-pending" : ""}${parts ? " is-commentable" : ""}`}
      data-file-edit={edit.path}
      data-entry-id={parts ? call?.id : undefined}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: j / k select by key */}
      <div
        className={`chat-file-edit-head${focused === 0 ? " is-focused" : ""}`}
        title={edit.path}
        data-part={parts ? 0 : undefined}
        onClick={parts ? () => parts.onSelect(0) : undefined}
      >
        <FilePen size={12} aria-hidden="true" />
        <span className="chat-file-edit-verb">{verb}</span>
        <span className="chat-file-edit-path">
          {/* One run, so the name stays after its directory. */}
          <span>
            {dir ? <span className="chat-file-edit-dir">{dir}</span> : null}
            <strong>{name}</strong>
          </span>
        </span>
        <span className="chat-file-edit-counts">
          {edit.added ? (
            <span className="chat-file-edit-added">+{edit.added}</span>
          ) : null}
          {edit.removed ? (
            <span className="chat-file-edit-removed">-{edit.removed}</span>
          ) : null}
        </span>
        {parts ? (
          <button
            type="button"
            className="chat-file-edit-comment"
            title="Comment on this file"
            aria-label="Comment on this file"
            onClick={(event) => {
              event.stopPropagation();
              parts.onComment(-1, -1);
            }}
          >
            <MessageSquarePlus size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {placed.head.length ? (
        <div className="chat-file-edit-notes">{placed.head}</div>
      ) : null}
      {rows.length ? (
        <div className="chat-file-edit-change" role="group" aria-label="Change">
          {change}
        </div>
      ) : null}
      {hidden > 0 || open ? (
        <button
          type="button"
          className="chat-file-edit-more"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open
            ? "Show less"
            : `Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`}
        </button>
      ) : null}
      {open && edit.truncated ? (
        <p className="chat-file-edit-note">
          The rest of the change is in the call's arguments.
        </p>
      ) : null}
      {placed.end.length ? (
        <div className="chat-file-edit-notes is-outdated">
          {placed.end.map((note) => (
            <div key={note.key} className="chat-file-edit-thread">
              <div className="chat-file-edit-quote-label">
                On lines no longer in this change:
              </div>
              <pre className="chat-file-edit-quote">{note.quote}</pre>
              {note.node}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
