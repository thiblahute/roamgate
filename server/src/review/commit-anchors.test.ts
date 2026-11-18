import { expect, test } from "bun:test";
import type {
  ReviewAnchor,
  ReviewCommit,
  ReviewDiffFile,
} from "../../../shared/review";
import {
  lineInFile,
  movedAnchor,
  rewrittenCommit,
  rewrittenOut,
} from "./commit-anchors";

const commit = (sha: string, subject: string): ReviewCommit => ({
  sha,
  parent: `${sha}-parent`,
  author: "Test",
  date: "2026-11-18T20:00:00Z",
  subject,
  body: "",
});

const file = (path: string, lines: string[], from = 1): ReviewDiffFile => ({
  path,
  oldPath: path,
  hunks: [
    {
      header: `@@ -0,0 +${from},${lines.length} @@`,
      lines: lines.map((text, index) => ({
        kind: "+" as const,
        old: null,
        new: from + index,
        text,
      })),
    },
  ],
});

const onCommit: ReviewAnchor = {
  path: "play.c",
  commit: "acd7920f82",
  commitSubject: "gst-c: Add futures, elements written in C, and the pipeline",
  commitParent: "4e035085a2",
  line: 144,
  side: "new",
  text: "die (const char *what, GstError *err)",
  feedback: JSON.stringify({
    source: "diff",
    path: "play.c",
    kind: "branch",
    side: "new",
    line: 144,
    quote: "die (const char *what, GstError *err)",
    commit: {
      sha: "acd7920f82",
      subject: "gst-c: Add futures, elements written in C, and the pipeline",
      parent: "4e035085a2",
    },
  }),
};

test("a commit no longer among the review's is told from one still there", () => {
  const commits = [commit("1111", "a"), commit("acd7920f82aa", "b")];
  expect(rewrittenOut(onCommit, commits)).toBe(false);
  expect(rewrittenOut(onCommit, [commit("1111", "a")])).toBe(true);
  expect(rewrittenOut({ path: "x" }, [commit("1111", "a")])).toBe(false);
  // No commits read: nothing is said to be gone.
  expect(rewrittenOut(onCommit, [])).toBe(false);
});

test("what a rewritten commit became: its patch id first, then its subject", () => {
  const amended = commit(
    "f00d",
    "gst-c: Add futures, elements written in C, and the pipeline",
  );
  const reworded = commit("beef", "gst-c: futures and elements in C");
  const commits = [
    commit("1111", "gst-c: a C API for caps"),
    reworded,
    amended,
  ];
  // The same change under another subject: by its patch id.
  expect(
    rewrittenCommit(onCommit, commits, { acd7920f82full: "P", beef: "P" }),
  ).toBe(reworded);
  // Changed by the amend: by its subject.
  expect(rewrittenCommit(onCommit, commits, {})).toBe(amended);
  // Only the patch id for another branch's thread.
  expect(rewrittenCommit(onCommit, commits, {}, false)).toBeNull();
  // A fixup's subject, normalized.
  expect(
    rewrittenCommit(
      { ...onCommit, commitSubject: "fixup! gst-c: a C API for caps." },
      commits,
      {},
    )?.sha,
  ).toBe("1111");
  expect(rewrittenCommit({ path: "x", line: 1 }, commits, {})).toBeNull();
});

test("the anchored line is found by its text, the lines after it first, else the nearest", () => {
  const moved = file("play.c", [
    "static void",
    "die (const char *what, GstError *err)",
    "{",
  ]);
  expect(lineInFile(onCommit, moved)).toEqual({ side: "new", line: 2 });
  // Twice: the one whose next lines read as the quote's.
  const ranged: ReviewAnchor = {
    ...onCommit,
    line: 3,
    endLine: 4,
    feedback: JSON.stringify({
      quote: "die (const char *what, GstError *err)\n{ /* fatal */",
    }),
  };
  const twice = file("play.c", [
    "die (const char *what, GstError *err)",
    "{",
    "x",
    "x",
    "x",
    "x",
    "x",
    "die (const char *what, GstError *err)",
    "{ /* fatal */",
  ]);
  expect(lineInFile(ranged, twice)).toEqual({ side: "new", line: 8 });
  expect(lineInFile({ ...ranged, feedback: undefined }, twice)).toEqual({
    side: "new",
    line: 1,
  });
  expect(lineInFile(onCommit, file("play.c", ["gone"]))).toBeNull();
  expect(lineInFile(onCommit, undefined)).toBeNull();
});

test("a moved anchor and its note name the new commit and line, or the whole change", () => {
  const to = commit(
    "f00d",
    "gst-c: Add futures, elements written in C, and the pipeline",
  );
  const onNew = movedAnchor(onCommit, to, { side: "new", line: 150 });
  expect(onNew).toMatchObject({
    commit: "f00d",
    commitParent: "f00d-parent",
    line: 150,
    side: "new",
  });
  expect(onNew.outdated).toBeUndefined();
  const note = JSON.parse(onNew.feedback!);
  expect(note.commit).toEqual({
    sha: "f00d",
    subject: to.subject,
    parent: "f00d-parent",
  });
  expect(note.line).toBe(150);
  const range = movedAnchor({ ...onCommit, endLine: 146 }, to, {
    side: "new",
    line: 10,
  });
  expect(range.endLine).toBe(12);
  expect(JSON.parse(range.feedback!).endLine).toBe(12);
  // Onto the whole change: no commit any more.
  const whole = movedAnchor(onCommit, null, { side: "new", line: 7 });
  expect(whole.commit).toBeUndefined();
  expect(whole.commitSubject).toBeUndefined();
  expect(JSON.parse(whole.feedback!).commit).toBeUndefined();
  // Nothing found: kept where it was, outdated.
  const outdated = movedAnchor(onCommit, to, null, true);
  expect(outdated.line).toBe(144);
  expect(outdated.commit).toBe("f00d");
  expect(outdated.outdated).toBe(true);
  // Found again later: no longer outdated.
  expect(
    movedAnchor(outdated, to, { side: "new", line: 1 }).outdated,
  ).toBeUndefined();
});
