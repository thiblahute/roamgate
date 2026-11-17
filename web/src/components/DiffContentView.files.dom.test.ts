import { inIsolatedChild } from "../testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * One review across Files and Changes, on Changes' side: a comment written in
 * Files (a thread of the checkout's worktree review, its note's source
 * "file") is drawn on its file's combined diff at its source line, listed in
 * the Comments panel and walked by gn; one on a rendered file's words with no
 * line is on the file as a whole; a file with no change that is commented on
 * or ticked is one of the review's "Other files", under the changed files,
 * with its threads and its tick-only mark.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "Changes and Files' one review in an isolated DOM runtime",
    "ROAMGATE_CHANGES_FILES_DOM_TEST",
    60_000,
  )
) {
  const { installReviewDom, file, hunk, numbered, thread } = await import(
    "./reviewSurface.testkit"
  );
  await installReviewDom();
  const { mountChangesReview } = await import(
    "./reviewSurface.changes.testkit"
  );
  type ReviewThread = import("../../../shared/review").ReviewThread;

  /** `count` added lines `${path} line N`. */
  const added = (path: string, count: number) =>
    file(
      path,
      hunk(
        1,
        1,
        numbered(`${path} line`, count).map((line) => `+${line}`),
      ),
    );

  /** A thread written in Files: its note's source is the file. */
  const fromFiles = (
    id: string,
    path: string,
    line: number | undefined,
    body: string,
    extra: Partial<ReviewThread["anchor"]> = {},
  ): ReviewThread => {
    const base = thread(id, path, line ?? 1, body);
    const anchor = {
      path,
      ...(line !== undefined ? { line, side: "new" as const } : {}),
      ...extra,
    };
    return {
      ...base,
      anchor: {
        ...anchor,
        feedback: JSON.stringify({
          source: "file",
          anchor: line !== undefined && !extra.render ? "line" : "quote",
          path,
          ...(line !== undefined ? { line } : {}),
          section: [],
          quote: extra.render?.quote ?? "",
        }),
      },
    } as ReviewThread;
  };

  /** The Other files block, as drawn under the changed files. */
  const otherFiles = () =>
    [...document.querySelectorAll<HTMLElement>("[data-other-file]")]
      .filter((each) => each.closest("[data-testid='diff-other-files']"))
      .map((each) => ({
        path: each.dataset.otherFile ?? "",
        tick:
          each
            .querySelector(".diff-other-file-tick")
            ?.getAttribute("aria-pressed") === "true",
        threads: [
          ...each.querySelectorAll<HTMLElement>(".chat-thread[data-thread-id]"),
        ].map((card) => card.dataset.threadId ?? ""),
      }));

  describe("Files' comments in Changes", () => {
    test("a comment on a changed file's source line is drawn at its line, listed in the Comments panel and walked by gn", async () => {
      const review = await mountChangesReview({
        files: [added("a.ts", 12)],
        threads: [
          fromFiles("f1", "a.ts", 6, "From Files", {
            text: "a.ts line 6",
          }),
        ],
      });
      expect(
        review.shownThreads().map((each) => [each.id, each.general]),
      ).toEqual([["f1", false]]);
      expect(review.markedLines().map((line) => line.new)).toEqual([6]);
      await review.press("gg");
      await review.press("gn");
      expect(review.cursorLine()?.new).toBe(6);
      await review.clickThreadsChip();
      expect(review.threadsPanel()?.ids).toEqual(["f1"]);
      await review.unmount();
    });

    test("a rendered file's words are at their source line though the line reads otherwise; with no line, on the file as a whole", async () => {
      const review = await mountChangesReview({
        files: [added("a.ts", 12)],
        threads: [
          fromFiles("r1", "a.ts", 4, "On the words", {
            text: "the rendered words",
            render: { quote: "the rendered words" },
          }),
          fromFiles("r2", "a.ts", undefined, "On the page", {
            render: { quote: "somewhere" },
          }),
        ],
      });
      const shown = review.shownThreads();
      expect(shown.find((each) => each.id === "r1")?.general).toBe(false);
      expect(review.markedLines().map((line) => line.new)).toEqual([4]);
      expect(review.fileComments("a.ts").join(" ")).toContain("On the page");
      await review.unmount();
    });
  });

  describe("one delivery", () => {
    test("held comments written in Files and in Changes are sent together by Send, to the one review", async () => {
      const yours = (each: ReviewThread): ReviewThread => ({
        ...each,
        comments: each.comments.map((comment) => ({
          ...comment,
          author: "you",
        })),
      });
      const review = await mountChangesReview({
        files: [added("a.ts", 6)],
        session: {
          agent: { name: "Claude", paneId: "w1:p1" },
          holdComments: true,
        },
        threads: [
          yours(fromFiles("f1", "a.ts", 2, "From Files")),
          yours(fromFiles("o1", "notes.md", 1, "On an unchanged file")),
          yours(thread("c1", "a.ts", 4, "From Changes")),
        ],
      });
      await review.clickButton("Send (3)");
      expect(review.calls("review.handoff")).toEqual([
        { method: "review.handoff", params: { session_id: "s1" } },
      ]);
      await review.unmount();
    });
  });

  describe("one reviewed tick", () => {
    test("the tick Changes writes for a file is the one Files reads from the file's combined diff", async () => {
      const { reviewedFileOf, changedFileReviewed } = await import(
        "../reviewFiles"
      );
      const review = await mountChangesReview({ files: [added("a.ts", 4)] });
      await review.press("gg");
      await review.press("v");
      const marks = review.reviewedMarks();
      const patch = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,0 +1,4 @@",
        ...numbered("a.ts line", 4).map((line) => `+${line}`),
        "",
      ].join("\n");
      const read = reviewedFileOf("a.ts", patch)!;
      expect(marks["all:a.ts"]).toBe(read.fingerprint);
      expect(changedFileReviewed(read, marks)).toBe(true);
      expect(review.fileReviewed("a.ts")).toBe(true);
      await review.unmount();
    });
  });

  describe("Other files", () => {
    test("a file with no change joins by an open thread or its tick, under the changed files; a resolved thread does not keep one", async () => {
      const review = await mountChangesReview({
        files: [added("a.ts", 4)],
        threads: [
          fromFiles("o1", "notes.md", 3, "On an unchanged file"),
          {
            ...fromFiles("o2", "gone.md", 1, "Done"),
            resolved: true,
          },
        ],
        reviewed: { "all:ticked.md": "unchanged" },
      });
      expect(otherFiles()).toEqual([
        { path: "notes.md", tick: false, threads: ["o1"] },
        { path: "ticked.md", tick: true, threads: [] },
      ]);
      // Its thread is on the file, not among the review's general ones.
      expect(
        review.shownThreads().find((each) => each.id === "o1")?.general,
      ).toBe(false);
      // Listed in the Comments panel with the others.
      await review.clickThreadsChip();
      expect(review.threadsPanel()?.ids).toEqual(["o1"]);
      await review.unmount();
    });

    test("its tick is a tick only: marked and unmarked as such, and the changed files' chunk progress is unchanged", async () => {
      const review = await mountChangesReview({
        files: [added("a.ts", 4)],
        threads: [fromFiles("o1", "notes.md", 3, "On an unchanged file")],
      });
      await review.clickButton("Mark reviewed");
      expect(
        review.calls("review.update").slice(-1)[0]?.params.reviewed,
      ).toEqual({
        "all:notes.md": "unchanged",
      });
      expect(otherFiles()[0]?.tick).toBe(true);
      // No chunk of a changed file is counted for it.
      expect(review.fileReviewed("a.ts")).toBe(false);
      expect(review.chunkProgress("a.ts")).toBeNull();
      await review.clickButton("\u2713 Reviewed");
      expect(
        review.calls("review.update").slice(-1)[0]?.params.reviewed,
      ).toEqual({
        "all:notes.md": null,
      });
      expect(otherFiles()[0]?.tick).toBe(false);
      await review.unmount();
    });

    test("a changed file is never an Other file, even with a tick-only mark left from before it changed", async () => {
      const review = await mountChangesReview({
        files: [added("a.ts", 4)],
        reviewed: { "all:a.ts": "unchanged" },
      });
      expect(otherFiles()).toEqual([]);
      expect(review.fileReviewed("a.ts")).toBe(false);
      await review.unmount();
    });
  });
}
