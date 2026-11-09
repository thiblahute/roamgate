import { expect, test } from "bun:test";
import type { ReviewSnapshot } from "../../shared/review";
import { fileReviewRoot, pathInReview } from "./reviewOpen";

const review = (
  id: string,
  root: string,
  target: Record<string, unknown>,
  connectionId = "desktop",
) =>
  ({
    session: { id, connectionId, root, target },
    threads: [],
  }) as unknown as ReviewSnapshot;

test("Show in code review finds the checkout of the file, else its directory", () => {
  const sessions = [
    review("a", "/src/gst", { kind: "range", base: "main", head: "HEAD" }),
    review("b", "/src/gst/subprojects/glib", { kind: "worktree" }),
    review("c", "/src/other", { kind: "worktree" }, "laptop"),
    review("d", "/", { kind: "rendered", url: "http://localhost:8080/" }),
    review("e", "/src/plan", { kind: "rendered", path: "plan.md" }),
  ];
  // The deepest checkout holding it.
  expect(
    fileReviewRoot(sessions, "desktop", "/src/gst/subprojects/glib/README.md"),
  ).toBe("/src/gst/subprojects/glib");
  expect(fileReviewRoot(sessions, "desktop", "/src/gst/docs/plan.md")).toBe(
    "/src/gst",
  );
  // A rendered file's checkout counts; a site's root does not.
  expect(fileReviewRoot(sessions, "desktop", "/src/plan/plan.md")).toBe(
    "/src/plan",
  );
  // Another connection's reviews do not; then the file's directory.
  expect(fileReviewRoot(sessions, "desktop", "/src/other/notes.md")).toBe(
    "/src/other",
  );
  expect(pathInReview("/src/gst/", "/src/gst/docs/plan.md")).toBe(
    "docs/plan.md",
  );
  expect(pathInReview("/elsewhere", "/src/gst/docs/plan.md")).toBe(
    "/src/gst/docs/plan.md",
  );
});
