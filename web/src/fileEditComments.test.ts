import { expect, test } from "bun:test";
import type { FileEdit } from "../../shared/fileEdits";
import type { ReviewAnchor } from "../../shared/review";
import type { HistoryEntry } from "./components/agentHistory";
import {
  fileEditAnchor,
  fileEditEntry,
  fileEditPlace,
  fileEditRows,
  onFileEdit,
  placeFileEditThread,
} from "./fileEditComments";

/** A file Claude wrote: its lines numbered from 1. */
const created: FileEdit = {
  path: "/w/plans/desktop-move.md",
  created: true,
  added: 5,
  removed: 0,
  hunks: [
    {
      old_start: 0,
      new_start: 1,
      lines: ["+# Desktop move", "+", "+## Disks", "+  Two of them.", "+Done."],
    },
  ],
};

/** An edit: a line replaced in context, and a second hunk further down. */
const edited: FileEdit = {
  path: "/w/src/a.ts",
  added: 2,
  removed: 1,
  hunks: [
    { old_start: 10, new_start: 10, lines: [" keep", "-old", "+new", "+more"] },
    { old_start: 40, new_start: 41, lines: [" tail"] },
  ],
};

const call = {
  id: "c1",
  kind: "tool_call",
  role: "tool",
  text: "",
  tool_name: "Write",
  source_call_id: "toolu_01",
  sent_at: "2026-11-07T10:00:00.000Z",
} as HistoryEntry;

test("a comment on lines is on their new numbers, quoting their text", () => {
  // One line.
  expect(fileEditPlace(created, 2, 2)).toEqual({
    path: "/w/plans/desktop-move.md",
    line: 3,
    side: "new",
    text: "## Disks",
    quote: "## Disks",
  });
  // A range, either way round.
  expect(fileEditPlace(created, 3, 2)).toEqual({
    path: "/w/plans/desktop-move.md",
    line: 3,
    endLine: 4,
    side: "new",
    text: "## Disks",
    quote: "## Disks\n  Two of them.",
  });
  // The file as a whole: its path.
  expect(fileEditPlace(created, -1, -1)).toEqual({
    path: "/w/plans/desktop-move.md",
    quote: "/w/plans/desktop-move.md",
  });
  // A blank line: still a quote the server keeps, no text to match.
  expect(fileEditPlace(created, 1, 1)).toEqual({
    path: "/w/plans/desktop-move.md",
    line: 2,
    side: "new",
    quote: "(blank line)",
  });
});

test("removed lines: on the old side alone, marked when taken with others", () => {
  // Only the removed line: as the file was before the change.
  expect(fileEditPlace(edited, 1, 1)).toEqual({
    path: "/w/src/a.ts",
    line: 11,
    side: "old",
    text: "old",
    quote: "old",
  });
  // With the lines around it: the new side, each line marked.
  expect(fileEditPlace(edited, 0, 3)).toEqual({
    path: "/w/src/a.ts",
    line: 10,
    endLine: 12,
    side: "new",
    text: "keep",
    quote: " keep\n-old\n+new\n+more",
  });
  // Across the gap between hunks.
  expect(fileEditPlace(edited, 3, 5)).toMatchObject({ line: 12, endLine: 41 });
});

test("a change without numbers (a call running) is quoted, not numbered", () => {
  const running: FileEdit = {
    path: "/w/b.md",
    added: 2,
    removed: 0,
    hunks: [{ lines: ["+one", "+two"] }],
  };
  expect(fileEditPlace(running, 0, 1)).toEqual({
    path: "/w/b.md",
    quote: "one\ntwo",
  });
});

test("the anchor names the call, its time and its id", () => {
  const anchor = fileEditAnchor(call, created, 2, 3);
  expect(anchor).toEqual({
    path: "/w/plans/desktop-move.md",
    line: 3,
    endLine: 4,
    side: "new",
    text: "## Disks",
    chat: {
      entry: "c1",
      quote: "## Disks\n  Two of them.",
      at: "2026-11-07T10:00:00.000Z",
      call: "toolu_01",
    },
  });
  expect(onFileEdit(anchor)).toBe(true);
  expect(onFileEdit({ chat: { entry: "e1", quote: "words" } })).toBe(false);
});

test("a thread is drawn under its last line, found again when it moved", () => {
  const rows = fileEditRows(created);
  const anchor = fileEditAnchor(call, created, 2, 3);
  expect(placeFileEditThread(rows, anchor)).toEqual({ at: "row", row: 3 });
  // On the file: under its head.
  expect(
    placeFileEditThread(rows, fileEditAnchor(call, created, -1, -1)),
  ).toEqual({ at: "head" });
  // The server trims the quote; the lines still read as they did.
  expect(
    placeFileEditThread(rows, {
      ...anchor,
      chat: { ...anchor.chat!, quote: "## Disks\nTwo of them." },
    }),
  ).toEqual({ at: "row", row: 3 });
  // Its line moved down two (the change read anew): found by its text,
  // the same count of lines on.
  const moved = fileEditRows({
    ...created,
    hunks: [
      {
        old_start: 0,
        new_start: 1,
        lines: [
          "+# Desktop move",
          "+",
          "+Intro",
          "+",
          ...created.hunks[0]!.lines.slice(2),
        ],
      },
    ],
  });
  expect(placeFileEditThread(moved, anchor)).toEqual({ at: "row", row: 5 });
  // Its lines gone: at the card's end, with its quote.
  const gone: ReviewAnchor = {
    ...anchor,
    text: "## Elsewhere",
    chat: { ...anchor.chat!, quote: "## Elsewhere" },
  };
  expect(placeFileEditThread(rows, gone)).toEqual({ at: "end" });
  // Removed lines are found on the old side.
  const editRows = fileEditRows(edited);
  expect(
    placeFileEditThread(editRows, fileEditAnchor(call, edited, 1, 1)),
  ).toEqual({ at: "row", row: 1 });
  expect(
    placeFileEditThread(editRows, fileEditAnchor(call, edited, 0, 3)),
  ).toEqual({ at: "row", row: 3 });
});

test("a comment made while the call ran finds its lines once numbered", () => {
  const running: FileEdit = {
    ...created,
    hunks: [{ lines: created.hunks[0]!.lines }],
  };
  const anchor = fileEditAnchor(call, running, 2, 3);
  expect(anchor.line).toBeUndefined();
  expect(placeFileEditThread(fileEditRows(created), anchor)).toEqual({
    at: "row",
    row: 3,
  });
});

test("a comment's call is found by its id when its entry id changed", () => {
  const part = { entry: "live:c1", quote: "x", call: "toolu_01" };
  const entries = [
    { ...call, id: "m1", kind: "message", source_call_id: undefined },
    { ...call, id: "c9" },
  ] as HistoryEntry[];
  expect(fileEditEntry(part, entries)).toBe("c9");
  expect(fileEditEntry({ ...part, entry: "m1" }, entries)).toBe("m1");
  // Not shown: listed apart.
  expect(fileEditEntry({ ...part, call: "toolu_02" }, entries)).toBeNull();
  expect(fileEditEntry({ entry: "gone", quote: "x" }, entries)).toBeNull();
});
