import { afterEach, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff } from "../review/patch";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import type { RunProcessWithCodeTimeout } from "./file-types";
import { stagedLines } from "./git-combined";
import { readDiffFile } from "./git-diff";

/*
 * The combined working diff of one file (git.diff_file, kind "combined"):
 * staged and unstaged changes together against HEAD, untracked files as
 * new, which changed lines the index holds; and the git-config hardening
 * the review's patch loader has (review-patch.test.ts), kept here.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "roamgate-combined-git-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const run = { shQuote, runProcessWithCodeTimeout };

function withGitConfig(key: string, value: string) {
  const runner: RunProcessWithCodeTimeout = (argv, timeoutMs) =>
    runProcessWithCodeTimeout(
      [
        "env",
        "GIT_CONFIG_COUNT=1",
        `GIT_CONFIG_KEY_0=${key}`,
        `GIT_CONFIG_VALUE_0=${value}`,
        ...argv,
      ],
      timeoutMs,
    );
  return { shQuote, runProcessWithCodeTimeout: runner };
}

function combined(
  root: string,
  path: string,
  context: {
    shQuote: (value: string) => string;
    runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  } = run,
  extra: Record<string, unknown> = {},
) {
  return readDiffFile({
    ...context,
    workspaceId: "w",
    root,
    params: { path, kind: "combined", ...extra },
  }) as Promise<{
    kind: string;
    path: string;
    diff: string;
    truncated: boolean;
    untracked?: true;
    unmerged?: true;
    staged?: { old: [number, number][]; new: [number, number][] };
  }>;
}

const linesOf = (diff: string) =>
  parseUnifiedDiff(diff).flatMap((file) =>
    file.hunks.flatMap((hunk) => hunk.lines),
  );

test("a file's staged and unstaged changes read as one diff against HEAD", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "ONE\ntwo\nthree\n");
  git(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "ONE\ntwo\nTHREE\n");
  const file = await combined(root, "a.txt");
  expect(file.kind).toBe("combined");
  expect(linesOf(file.diff).filter((line) => line.kind !== " ")).toEqual([
    { kind: "-", old: 1, new: null, text: "one" },
    { kind: "+", old: null, new: 1, text: "ONE" },
    { kind: "-", old: 3, new: null, text: "three" },
    { kind: "+", old: null, new: 3, text: "THREE" },
  ]);
  // The first change is in the index, the second only in the working tree.
  expect(file.staged).toEqual({ old: [[1, 1]], new: [[1, 1]] });
});

test("a chunk is partly staged when the index holds some of its lines", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "one\nnew 1\ntwo\nthree\n");
  git(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "one\nnew 1\nnew 2\ntwo\nthree\n");
  const file = await combined(root, "a.txt");
  const hunks = parseUnifiedDiff(file.diff)[0]!.hunks;
  expect(hunks).toHaveLength(1);
  expect(
    hunks[0]!.lines.filter((line) => line.kind === "+").map((l) => l.new),
  ).toEqual([2, 3]);
  expect(file.staged).toEqual({ old: [], new: [[2, 2]] });
});

test("staging everything marks every changed line staged, the diff unchanged", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  const before = await combined(root, "a.txt");
  expect(before.staged).toEqual({ old: [], new: [] });
  git(root, "add", "a.txt");
  const after = await combined(root, "a.txt");
  expect(after.diff).toBe(before.diff);
  expect(after.staged).toEqual({
    old: [[2, 2]],
    new: [
      [2, 2],
      [4, 4],
    ],
  });
});

test("lines added above an unstaged change keep the staged lines' numbers right", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nstaged\n");
  git(root, "add", "a.txt");
  // Two lines added at the top, unstaged: the staged line moves to 6.
  writeFileSync(join(root, "a.txt"), "top 1\ntop 2\none\ntwo\nthree\nstaged\n");
  const file = await combined(root, "a.txt");
  expect(file.staged).toEqual({ old: [], new: [[6, 6]] });
});

test("an untracked file is a new file, nothing of it staged", async () => {
  const root = repository();
  writeFileSync(join(root, "new.txt"), "fresh\nlines\n");
  const file = await combined(root, "new.txt");
  expect(file.untracked).toBe(true);
  expect(linesOf(file.diff)).toEqual([
    { kind: "+", old: null, new: 1, text: "fresh" },
    { kind: "+", old: null, new: 2, text: "lines" },
  ]);
  expect(file.staged).toEqual({ old: [], new: [] });
});

test("a new file added to the index then edited is partly staged", async () => {
  const root = repository();
  writeFileSync(join(root, "new.txt"), "first\n");
  git(root, "add", "new.txt");
  writeFileSync(join(root, "new.txt"), "first\nsecond\n");
  const file = await combined(root, "new.txt");
  expect(file.untracked).toBeUndefined();
  expect(linesOf(file.diff).map((line) => line.text)).toEqual([
    "first",
    "second",
  ]);
  expect(file.staged).toEqual({ old: [], new: [[1, 1]] });
});

test("a staged rename reads as a rename with its edits", async () => {
  const root = repository();
  git(root, "mv", "a.txt", "b.txt");
  writeFileSync(join(root, "b.txt"), "one\ntwo\nthree\nfour\n");
  const file = await combined(root, "b.txt", run, { old_path: "a.txt" });
  const [parsed] = parseUnifiedDiff(file.diff);
  expect([parsed!.oldPath, parsed!.path]).toEqual(["a.txt", "b.txt"]);
  expect(file.diff).toContain("rename from a.txt");
  expect(
    parsed!.hunks.flatMap((hunk) => hunk.lines).filter((l) => l.kind !== " "),
  ).toEqual([{ kind: "+", old: null, new: 4, text: "four" }]);
  // The rename is staged, the added line is not.
  expect(file.staged).toEqual({ old: [], new: [] });
});

test("a binary file has no lines, and nothing staged to tell", async () => {
  const root = repository();
  writeFileSync(join(root, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, "add", "img.bin");
  git(root, "commit", "-q", "-m", "bin");
  writeFileSync(join(root, "img.bin"), Buffer.from([0, 9, 9, 0, 255]));
  const file = await combined(root, "img.bin");
  const [parsed] = parseUnifiedDiff(file.diff);
  expect(parsed!.binary).toBe(true);
  expect(parsed!.hunks).toEqual([]);
  expect(file.staged).toEqual({ old: [], new: [] });
});

test("a conflicted file is read against HEAD without staged lines", async () => {
  const root = repository();
  git(root, "switch", "-q", "-c", "other");
  writeFileSync(join(root, "a.txt"), "one\nother\nthree\n");
  git(root, "commit", "-q", "-am", "other");
  git(root, "switch", "-q", "main");
  writeFileSync(join(root, "a.txt"), "one\nmain\nthree\n");
  git(root, "commit", "-q", "-am", "main");
  // Fails on the conflict, as wanted.
  Bun.spawnSync(["git", "-C", root, "merge", "-q", "other"], { env: GIT_ENV });
  const file = await combined(root, "a.txt");
  expect(file.unmerged).toBe(true);
  expect(file.staged).toBeUndefined();
  expect(file.diff).toContain("+<<<<<<<");
});

test("a repository with no commit yet reads its files as new", async () => {
  const root = mkdtempSync(join(tmpdir(), "roamgate-combined-git-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  const file = await combined(root, "a.txt");
  expect(linesOf(file.diff).map((line) => [line.kind, line.text])).toEqual([
    ["+", "one"],
    ["+", "two"],
  ]);
  expect(file.staged).toEqual({ old: [], new: [[1, 1]] });
});

test("glob characters in a name are taken literally", async () => {
  const root = repository();
  writeFileSync(join(root, "x*.txt"), "star\n");
  writeFileSync(join(root, "xy.txt"), "other\n");
  git(root, "add", "x*.txt", "xy.txt");
  git(root, "commit", "-q", "-m", "names");
  writeFileSync(join(root, "x*.txt"), "STAR\n");
  writeFileSync(join(root, "xy.txt"), "OTHER\n");
  const file = await combined(root, "x*.txt");
  expect(parseUnifiedDiff(file.diff).map((each) => each.path)).toEqual([
    "x*.txt",
  ]);
});

test("stagedLines tells a removed line the index dropped from one it kept", () => {
  const [combinedFile] = parseUnifiedDiff(
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,1 @@\n-a\n-b\n c\n",
  );
  const [cachedFile] = parseUnifiedDiff(
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n-a\n b\n",
  );
  expect(stagedLines(combinedFile, cachedFile, undefined)).toEqual({
    old: [[1, 1]],
    new: [],
  });
});

// ---- The review patch loader's git-config hardening, ported ---------------

test("diff.suppressBlankEmpty does not shift line numbers", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "a\n\nb\n");
  git(root, "commit", "-q", "-am", "blank line");
  writeFileSync(join(root, "a.txt"), "a\n\nB\n");
  const file = await combined(
    root,
    "a.txt",
    withGitConfig("diff.suppressBlankEmpty", "true"),
  );
  expect(parseUnifiedDiff(file.diff)[0]!.hunks[0]!.lines).toEqual([
    { kind: " ", old: 1, new: 1, text: "a" },
    { kind: " ", old: 2, new: 2, text: "" },
    { kind: "-", old: 3, new: null, text: "b" },
    { kind: "+", old: null, new: 3, text: "B" },
  ]);
});

test("diff.mnemonicPrefix does not change the paths", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "edited\n");
  writeFileSync(join(root, "new.txt"), "fresh\n");
  const config = withGitConfig("diff.mnemonicPrefix", "true");
  const files = [
    ...parseUnifiedDiff((await combined(root, "a.txt", config)).diff),
    ...parseUnifiedDiff((await combined(root, "new.txt", config)).diff),
  ];
  expect(files.map((f) => [f.oldPath, f.path]).sort()).toEqual([
    ["a.txt", "a.txt"],
    ["new.txt", "new.txt"],
  ]);
});

test("diff.noprefix keeps a real top-level a/ directory", async () => {
  const root = repository();
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "x.txt"), "one\n");
  git(root, "add", "a/x.txt");
  git(root, "commit", "-q", "-m", "a dir");
  writeFileSync(join(root, "a", "x.txt"), "two\n");
  const file = await combined(
    root,
    "a/x.txt",
    withGitConfig("diff.noprefix", "true"),
  );
  expect(parseUnifiedDiff(file.diff).map((f) => f.path)).toEqual(["a/x.txt"]);
});

test("non-ASCII names show as they are in the combined diff", async () => {
  const root = repository();
  const tracked = "caf\u00e9.txt";
  const untracked = "na\u00efve.txt";
  writeFileSync(join(root, tracked), "one\n");
  git(root, "add", tracked);
  git(root, "commit", "-q", "-m", "accent");
  writeFileSync(join(root, tracked), "two\n");
  writeFileSync(join(root, untracked), "fresh\n");
  const files = [
    ...parseUnifiedDiff((await combined(root, tracked)).diff),
    ...parseUnifiedDiff((await combined(root, untracked)).diff),
  ];
  expect(files.map((f) => f.path).sort()).toEqual([tracked, untracked]);
});

test("the combined read refuses links out of the checkout and FIFOs", async () => {
  const root = repository();
  const outside = mkdtempSync(join(tmpdir(), "roamgate-combined-outside-"));
  directories.push(outside);
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linked"));
  const fifo = join(root, "pipe");
  Bun.spawnSync(["mkfifo", fifo]);
  // A read that hangs fails here instead of blocking the test.
  const quick: RunProcessWithCodeTimeout = (argv) =>
    runProcessWithCodeTimeout(argv, 3000);
  const read = (path: string) =>
    combined(root, path, { shQuote, runProcessWithCodeTimeout: quick });
  try {
    // A link is shown as a link (its target's name), never followed.
    const link = await read("link.txt");
    expect(link.diff).toContain("new file mode 120000");
    expect(link.diff).not.toContain("secret\n");
    // Through a linked directory: not a file of the checkout, not read.
    await expect(read("linked/secret.txt")).rejects.toThrow(
      "outside the checkout",
    );
    await expect(read("pipe")).rejects.toThrow("not a regular file");
    writeFileSync(join(root, "a.txt"), "one\n2\nthree\n");
    expect((await read("a.txt")).diff).toContain("+2");
  } finally {
    // Releases a reader left blocked on the FIFO.
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {}
  }
}, 15_000);

test("what a login profile prints before the output is skipped", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "ONE\ntwo\nthree\n");
  const noisy: RunProcessWithCodeTimeout = async (argv, timeoutMs) => {
    const result = await runProcessWithCodeTimeout(argv, timeoutMs);
    return { ...result, stdout: `Welcome 1 0 0\nmotd\n${result.stdout}` };
  };
  const file = await combined(root, "a.txt", {
    shQuote,
    runProcessWithCodeTimeout: noisy,
  });
  expect(linesOf(file.diff).filter((l) => l.kind === "+")).toEqual([
    { kind: "+", old: null, new: 1, text: "ONE" },
  ]);
});
