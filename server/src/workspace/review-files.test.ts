import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { readReviewPatch, ReviewGoneError } from "./review-patch";
import {
  parseReviewFiles,
  readReviewFiles,
  readReviewSummary,
  reviewFilesScript,
} from "./review-files";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const run = { shQuote, runProcessWithCodeTimeout };

/** main: four files; topic: one of each change, generated and binary too. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), "roamgate-review-files-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "keep.txt"), "a\nb\nc\nd\ne\nf\n");
  writeFileSync(join(root, "gone.txt"), "x\n");
  writeFileSync(join(root, "old.txt"), "1\n2\n3\n4\n5\n6\n7\n");
  writeFileSync(join(root, ".gitattributes"), "gen.js linguist-generated\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "switch", "-q", "-c", "topic");
  git(root, "rm", "-q", "gone.txt");
  git(root, "mv", "old.txt", "new.txt");
  writeFileSync(join(root, "new.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  writeFileSync(join(root, "keep.txt"), "a\nB\nc\nd\ne\nf\n");
  writeFileSync(join(root, "gen.js"), "x = 1;\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0]));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  return root;
}

test("a range's summary lists each file with its status and counts, between its merge base and head", async () => {
  const root = repository();
  // main moving on is not part of the review.
  git(root, "switch", "-q", "main");
  writeFileSync(join(root, "later.txt"), "later\n");
  git(root, "add", "later.txt");
  git(root, "commit", "-q", "-m", "main moves on");
  git(root, "switch", "-q", "topic");
  const summary = await readReviewSummary({
    ...run,
    root,
    of: { target: { kind: "range", base: "main", head: "topic" } },
  });
  expect(summary.summary).toBe(true);
  expect(summary.baseSha).toBe(git(root, "merge-base", "main", "topic"));
  expect(summary.headSha).toBe(git(root, "rev-parse", "topic"));
  const byPath = Object.fromEntries(
    summary.files.map((file) => [file.path, file]),
  );
  expect(Object.keys(byPath).sort()).toEqual([
    "bin.dat",
    "gen.js",
    "gone.txt",
    "keep.txt",
    "new.txt",
  ]);
  expect(byPath["keep.txt"]).toMatchObject({
    status: "modified",
    additions: 1,
    deletions: 1,
    hunks: [],
  });
  expect(byPath["new.txt"]).toMatchObject({
    status: "renamed",
    oldPath: "old.txt",
    additions: 1,
    deletions: 0,
  });
  expect(byPath["gone.txt"]).toMatchObject({ status: "deleted", deletions: 1 });
  expect(byPath["bin.dat"]).toMatchObject({ status: "added", binary: true });
  expect(byPath["gen.js"]).toMatchObject({ status: "added", generated: true });
  expect(byPath["keep.txt"]!.generated).toBeUndefined();
});

test("a summary's files read a few at a time are the whole patch's files", async () => {
  const root = repository();
  const target = { kind: "range" as const, base: "main", head: "topic" };
  const summary = await readReviewSummary({ ...run, root, of: { target } });
  const files = await readReviewFiles({
    ...run,
    root,
    base: summary.baseSha!,
    head: summary.headSha!,
    files: summary.files.map(({ path, oldPath }) => ({ path, oldPath })),
  });
  const whole = await readReviewPatch({ ...run, root, target });
  const strip = (file: { path: string; oldPath: string; hunks: unknown }) => ({
    path: file.path,
    oldPath: file.oldPath,
    hunks: file.hunks,
  });
  expect(files.map(strip)).toEqual(
    summary.files
      .map((file) => whole.files.find((each) => each.path === file.path)!)
      .map(strip),
  );
  expect(files.find((file) => file.path === "bin.dat")?.binary).toBe(true);
});

test("a commit's summary is against its first parent, a root commit's against the empty tree", async () => {
  const root = repository();
  const second = git(root, "rev-parse", "topic");
  const first = git(root, "rev-parse", "main");
  const commit = await readReviewSummary({
    ...run,
    root,
    of: { commit: second },
  });
  expect(commit.baseSha).toBe(first);
  expect(commit.headSha).toBe(second);
  expect(commit.files).toHaveLength(5);
  const rootCommit = await readReviewSummary({
    ...run,
    root,
    of: { commit: first },
  });
  expect(rootCommit.baseSha).toBe(
    git(root, "hash-object", "-t", "tree", "/dev/null"),
  );
  expect(rootCommit.files.map((file) => file.status)).toEqual([
    "added",
    "added",
    "added",
    "added",
  ]);
  const [keep] = await readReviewFiles({
    ...run,
    root,
    base: rootCommit.baseSha!,
    head: rootCommit.headSha!,
    files: [{ path: "keep.txt" }],
  });
  expect(keep!.hunks[0]!.header).toMatch(/^@@ -0,0 \+1,6 @@/);
});

test("a compare's summary is tree against tree; a step's between its snapshots", async () => {
  const root = repository();
  const compare = await readReviewSummary({
    ...run,
    root,
    of: {
      target: { kind: "range", base: "main", head: "topic", compare: true },
    },
  });
  expect(compare.baseSha).toBe(git(root, "rev-parse", "main"));
  const before = git(root, "rev-parse", "main^{tree}");
  const after = git(root, "rev-parse", "topic^{tree}");
  const step = await readReviewSummary({
    ...run,
    root,
    of: {
      target: { kind: "step", step: "1-abcdef01", before, after },
    },
  });
  expect(step.baseSha).toBe(before);
  expect(step.files).toHaveLength(5);
});

test("a range whose base is gone says so as the whole patch does", async () => {
  const root = repository();
  await expect(
    readReviewSummary({
      ...run,
      root,
      of: { target: { kind: "range", base: "nothing-here", head: "topic" } },
    }),
  ).rejects.toBeInstanceOf(ReviewGoneError);
});

test("each file's patch is cut at the limit on a whole hunk and marked; the others are whole", () => {
  const big = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,1 +1,1 @@",
    "-one",
    "+ONE",
    "@@ -10,1 +10,1 @@",
    "-ten",
    "+TEN",
    "",
  ].join("\n");
  const small = [
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-b",
    "+B",
    "",
  ].join("\n");
  const cutAt = big.indexOf("@@ -10") + 8;
  const output = `\nROAMGATE-REVIEW-FILE 0\n${big.slice(0, cutAt + 1)}\nROAMGATE-REVIEW-FILE 1\n${small}`;
  const [a, b, c] = parseReviewFiles(
    output,
    [{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }],
    cutAt,
  );
  expect(a).toMatchObject({ path: "a.txt", truncated: true });
  expect(a!.hunks).toHaveLength(1);
  expect(b).toMatchObject({ path: "b.txt" });
  expect(b!.truncated).toBeUndefined();
  expect(b!.hunks).toHaveLength(1);
  // Nothing printed for it (a mode change): no hunks.
  expect(c).toEqual({ path: "c.txt", oldPath: "c.txt", hunks: [] });
});

test("the files script refuses names that are not revisions, paths out of the checkout and too many files", () => {
  const ends = { base: "a".repeat(40), head: "b".repeat(40) };
  expect(() =>
    reviewFilesScript(
      "/r",
      { base: "main", head: ends.head },
      [{ path: "a" }],
      shQuote,
    ),
  ).toThrow("invalid revision");
  expect(() =>
    reviewFilesScript("/r", ends, [{ path: "../etc/passwd" }], shQuote),
  ).toThrow("invalid path");
  expect(() =>
    reviewFilesScript(
      "/r",
      ends,
      Array.from({ length: 33 }, (_, i) => ({ path: `f${i}` })),
      shQuote,
    ),
  ).toThrow("at most 32");
});
