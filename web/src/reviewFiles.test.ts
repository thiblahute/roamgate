import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../../shared/review";
import type { ReviewAnnotation } from "./annotations";
import {
  changedFileMarks,
  changedFileReviewed,
  fileNoteAsDiff,
  hasFileMarks,
  OTHER_FILE_MARK,
  otherFileMarks,
  otherReviewFiles,
  reviewedFileOf,
} from "./reviewFiles";

/*
 * One review across Files and Changes: Files' comments read in Changes, the
 * review's files with no change ("Other files"), and the reviewed tick both
 * views read the same way.
 */

const thread = (
  id: string,
  path: string | undefined,
  extra: Partial<ReviewThread> = {},
): ReviewThread =>
  ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: path ? { path, line: 2, side: "new" } : {},
    comments: [],
    resolved: false,
    createdAt: "2026-11-15",
    updatedAt: "2026-11-15",
    ...extra,
  }) as ReviewThread;

describe("fileNoteAsDiff", () => {
  const note: ReviewAnnotation = {
    id: "n1",
    source: "file",
    anchor: "line",
    path: "guide.md",
    line: 3,
    endLine: 5,
    quote: "# Title",
    comment: "Clearer?",
    createdAt: 1,
  };
  test("a Files comment is a comment on its file's combined diff, at its thread's line, by the repository's path", () => {
    expect(
      fileNoteAsDiff(
        note,
        thread("n1", "docs/guide.md", {
          anchor: { path: "docs/guide.md", line: 4, endLine: 6 },
        }),
      ),
    ).toEqual({
      id: "n1",
      source: "diff",
      kind: "combined",
      path: "docs/guide.md",
      side: "new",
      line: 4,
      endLine: 6,
      hunk: "",
      quote: "# Title",
      comment: "Clearer?",
      createdAt: 1,
    });
  });
  test("words of a rendered file with no source line are on the file as a whole", () => {
    const quoted: ReviewAnnotation = {
      id: "n2",
      source: "file",
      anchor: "quote",
      path: "guide.md",
      section: [],
      quote: "words",
      comment: "?",
      createdAt: 1,
    };
    expect(fileNoteAsDiff(quoted)).toMatchObject({
      source: "diff",
      path: "guide.md",
      line: 0,
    });
    expect(fileNoteAsDiff(quoted)).not.toHaveProperty("endLine");
  });
  test("a site's comment and a diff's stay as they are", () => {
    const site = { ...note, path: "https://example.com/" };
    expect(fileNoteAsDiff(site)).toBe(site);
    const diff: ReviewAnnotation = {
      id: "d",
      source: "diff",
      kind: "unstaged",
      path: "a.ts",
      side: "new",
      line: 1,
      hunk: "",
      quote: "",
      comment: "",
      createdAt: 1,
    };
    expect(fileNoteAsDiff(diff)).toBe(diff);
  });
});

describe("otherReviewFiles", () => {
  test("a file with no change joins by an open thread or a tick; changed files, sites, resolved threads and parts do not", () => {
    const files = otherReviewFiles(
      [
        thread("a", "notes.md"),
        thread("b", "src/a.ts"),
        thread("c", "old.md", { resolved: true }),
        thread("d", "https://example.com/"),
        thread("e", undefined),
        thread("f", "part.md", {
          anchor: {
            path: "part.md",
            message: { comment: "x", start: 0, end: 1 },
          } as unknown as ReviewThread["anchor"],
        }),
      ],
      {
        "all:ticked.md": OTHER_FILE_MARK,
        "all:src/a.ts": OTHER_FILE_MARK,
        "all:fingerprinted.md": "2:abc",
        "all:notes.md\nh1.x": "1",
      },
      new Set(["src/a.ts"]),
    );
    expect(
      files.map(({ path, reviewed, threads }) => ({
        path,
        reviewed,
        threads: threads.map((each) => each.id),
      })),
    ).toEqual([
      { path: "notes.md", reviewed: false, threads: ["a"] },
      { path: "ticked.md", reviewed: true, threads: [] },
    ]);
  });
  test("ticking writes the tick-only mark, unticking drops it", () => {
    expect(otherFileMarks("notes.md", true)).toEqual({
      "all:notes.md": OTHER_FILE_MARK,
    });
    expect(otherFileMarks("notes.md", false)).toEqual({
      "all:notes.md": null,
    });
  });
});

describe("a changed file's tick from its combined diff", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "@@ -10,1 +10,2 @@",
    " ten",
    "+eleven",
    "",
  ].join("\n");
  test("ticked whole, or chunk by chunk, it reads reviewed; its diff changed, not", () => {
    const file = reviewedFileOf("a.ts", patch)!;
    expect(file.hunks).toHaveLength(2);
    expect(changedFileReviewed(file, {})).toBe(false);
    const whole = changedFileMarks(file, true, {}) as Record<string, string>;
    expect(whole["all:a.ts"]).toBe(file.fingerprint);
    expect(changedFileReviewed(file, whole)).toBe(true);
    const chunks = {
      [`all:a.ts\n${file.hunks[0]}`]: "1",
      [`all:a.ts\n${file.hunks[1]}`]: "1",
    };
    expect(changedFileReviewed(file, chunks)).toBe(true);
    expect(changedFileReviewed(file, { "all:a.ts": "2:other" })).toBe(false);
    // Unticked: no longer reviewed, as Changes' v unmarks it.
    const unticked: Record<string, string> = { ...whole };
    for (const [key, value] of Object.entries(
      changedFileMarks(file, false, whole),
    ))
      if (value === null) delete unticked[key];
      else unticked[key] = value;
    expect(changedFileReviewed(file, unticked)).toBe(false);
  });
  test("only a file with a mark of any view is worth reading", () => {
    expect(hasFileMarks("a.ts", { "all:b.ts": "x" })).toBe(false);
    expect(hasFileMarks("a.ts", { "all:a.ts": "" })).toBe(false);
    expect(hasFileMarks("a.ts", { "working:a.ts\nh1.x": "1" })).toBe(true);
    expect(reviewedFileOf("a.ts", "")).toBeNull();
  });
});
