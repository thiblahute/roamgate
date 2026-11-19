import { expect, test } from "bun:test";
import type { ReviewDiffFile } from "../../shared/review";
import { ReviewDiffs, ViewLoad } from "./reviewDiffLoad";

test("a slow answer for a view already left neither shows nor caches", () => {
  const diffs = new ReviewDiffs<string>();
  const a = diffs.begin("a");
  const b = diffs.begin("b");
  expect(b.done("diff of b")).toBe(true);
  // A answers last: B's view keeps B's diff.
  expect(a.current()).toBe(false);
  expect(a.done("diff of a")).toBe(false);
  expect(diffs.get("a")).toBeUndefined();
  expect(diffs.get("b")).toBe("diff of b");
});

test("moving to a cached view makes the pending one stale", () => {
  const diffs = new ReviewDiffs<string>();
  expect(diffs.begin("b").done("diff of b")).toBe(true);
  const a = diffs.begin("a");
  const b = diffs.begin("b");
  expect(b.cached).toBe("diff of b");
  expect(a.done("diff of a")).toBe(false);
});

test("an answer asked before a reload does not refill the cache", () => {
  const diffs = new ReviewDiffs<string>();
  const shown = diffs.begin("a");
  const searched = diffs.begin("b", { shown: false });
  diffs.clear();
  expect(shown.done("old a")).toBe(false);
  expect(searched.done("old b")).toBe(false);
  expect(diffs.get("a")).toBeUndefined();
  expect(diffs.get("b")).toBeUndefined();
});

test("looking at another view keeps the shown one current", () => {
  const diffs = new ReviewDiffs<string>();
  const shown = diffs.begin("a");
  const searched = diffs.begin("b", { shown: false });
  expect(searched.done("diff of b")).toBe(true);
  expect(shown.done("diff of a")).toBe(true);
  // Asked fresh: the cached diff is not offered.
  expect(diffs.begin("a", { fresh: true }).cached).toBeUndefined();
  expect(diffs.begin("a").cached).toBe("diff of a");
});

test("only the most recently used diffs are kept", () => {
  const diffs = new ReviewDiffs<string>(2);
  for (const sha of ["a", "b", "c"]) diffs.begin(sha).done(sha);
  expect(diffs.get("a")).toBeUndefined();
  expect(diffs.get("c")).toBe("c");
});

/** A summary of `count` files f0..fN, each `lines` lines changed. */
function summary(
  count: number,
  lines = 2,
  extra: Partial<ReviewDiffFile>[] = [],
) {
  return {
    files: [
      ...Array.from({ length: count }, (_, i) => ({
        path: `f${i}`,
        oldPath: `f${i}`,
        hunks: [],
        status: "modified" as const,
        additions: lines / 2,
        deletions: lines / 2,
      })),
      ...extra.map((file, i) => ({
        path: `x${i}`,
        oldPath: `x${i}`,
        hunks: [],
        ...file,
      })),
    ],
    baseSha: "b",
    headSha: "h",
    truncated: false,
    summary: true as const,
  };
}

/** A pump whose reads the test answers by hand. */
function pumping(view: ViewLoad) {
  const reads: { paths: string[]; answer: (fail?: string) => void }[] = [];
  let changes = 0;
  const read = (files: ReviewDiffFile[]) =>
    new Promise<ReviewDiffFile[]>((resolve, reject) => {
      reads.push({
        paths: files.map((file) => file.path),
        answer: (fail) =>
          fail
            ? reject(new Error(fail))
            : resolve(
                files.map((file) => ({
                  ...file,
                  hunks: [{ header: "@@ -1 +1 @@", lines: [] }],
                })),
              ),
      });
    });
  const pump = () =>
    view.pump(
      read,
      () => true,
      () => changes++,
    );
  return { reads, pump, changes: () => changes };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a summary's view reads its first files and the block after them, two reads at a time, not the rest", async () => {
  const view = new ViewLoad(summary(100));
  const { reads, pump } = pumping(view);
  pump();
  expect(reads.map((read) => read.paths.length)).toEqual([16, 16]);
  expect(reads[0]!.paths).toContain("f0");
  expect(view.loading.size).toBe(32);
  for (const read of reads) read.answer();
  await tick();
  expect(view.files.size).toBe(32);
  expect(view.loading.size).toBe(0);
  // Nothing more till the reader gets near.
  pump();
  expect(reads).toHaveLength(2);
});

test("the files near the reader are read, and the block after them once half of it waits", async () => {
  const view = new ViewLoad(summary(100));
  const { reads, pump } = pumping(view);
  pump();
  for (const read of reads) read.answer();
  await tick();
  // Near f20 (read): f32..f36 wait in the block after it, fewer than
  // half a block: nothing yet.
  expect(view.near(["f20"])).toBe(false);
  // Near f30: f32..f46 wait: read ahead, a block at once.
  expect(view.near(["f30"])).toBe(true);
  pump();
  expect(reads[2]!.paths.sort()).toEqual(
    Array.from({ length: 15 }, (_, i) => `f${32 + i}`).sort(),
  );
  // A file far down, near now: read at once, with its block.
  reads[2]!.answer();
  await tick();
  expect(view.near(["f80"])).toBe(true);
  pump();
  expect(reads[3]!.paths).toContain("f80");
});

test("a large or generated file waits to be asked for by name, then is read first", async () => {
  const view = new ViewLoad(
    summary(2, 2, [{ additions: 900, deletions: 200 }, { generated: true }]),
  );
  const { reads, pump } = pumping(view);
  pump();
  expect(reads[0]!.paths.sort()).toEqual(["f0", "f1"]);
  expect(ViewLoad.held(view.diff.files[2]!)).toBe(true);
  expect(view.near(["x0", "x1"])).toBe(false);
  expect(view.ask("x0")).toBe(true);
  pump();
  expect(reads[1]!.paths).toEqual(["x0"]);
  // Asked again while loading: nothing new.
  expect(view.ask("x0")).toBe(false);
});

test("a failed read says why for its files; asked again, they are read again", async () => {
  const view = new ViewLoad(summary(3));
  const { reads, pump } = pumping(view);
  pump();
  reads[0]!.answer("fatal: bad object");
  await tick();
  expect(view.errors.get("f1")).toBe("fatal: bad object");
  expect(view.files.size).toBe(0);
  expect(view.ask("f1")).toBe(true);
  expect(view.errors.has("f1")).toBe(false);
  pump();
  expect(reads[1]!.paths).toEqual(["f1"]);
});

test("a whole diff (no summary) is there at once: nothing to read", () => {
  const diff = { ...summary(3), summary: undefined };
  const view = new ViewLoad(diff);
  const { reads, pump } = pumping(view);
  pump();
  expect(reads).toHaveLength(0);
  expect(view.files.size).toBe(3);
});

test("a binary file is drawn from its summary, never read", () => {
  const view = new ViewLoad(summary(1, 2, [{ binary: true }]));
  expect(view.files.has("x0")).toBe(true);
  const { reads, pump } = pumping(view);
  pump();
  expect(reads[0]!.paths).toEqual(["f0"]);
});

test("an answer cut short leaves the files it lacks in error, not given another file's diff", async () => {
  const view = new ViewLoad(summary(2));
  view.pump(
    async (files) => [
      { ...files[1]!, hunks: [{ header: "@@ -1 +1 @@", lines: [] }] },
    ],
    () => true,
    () => {},
  );
  await tick();
  expect(view.files.get("f1")).toBeTruthy();
  expect(view.files.has("f0")).toBe(false);
  expect(view.errors.get("f0")).toBe("the bridge answered no file");
});
