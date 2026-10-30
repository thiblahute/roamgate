import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import {
  parseReviewPatchOutput,
  readReviewCommitPatch,
  readReviewCommits,
  readReviewFile,
  readReviewHeads,
  readReviewPatch,
  readReviewRoot,
  readReviewState,
  ReviewGoneError,
  reviewScriptError,
  scanReviewRepos,
  validReviewPath,
} from "./review-patch";

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

function repository() {
  const root = mkdtempSync(join(tmpdir(), "roamgate-review-git-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base");
  git(root, "switch", "-q", "-c", "topic");
  writeFileSync(join(root, "a.txt"), "one\n2\nthree\n");
  git(root, "commit", "-q", "-am", "change");
  return root;
}

const run = { shQuote, runProcessWithCodeTimeout };

test("a range reviews what the head adds since the merge base", async () => {
  const root = repository();
  // A later commit on main must not show up as a removal in the review.
  git(root, "switch", "-q", "main");
  writeFileSync(join(root, "b.txt"), "main only\n");
  git(root, "add", "b.txt");
  git(root, "commit", "-q", "-m", "main moves on");
  git(root, "switch", "-q", "topic");

  const diff = await readReviewPatch({
    ...run,
    root,
    target: { kind: "range", base: "main", head: "HEAD" },
  });
  expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  expect(diff.headSha).toBe(git(root, "rev-parse", "HEAD"));
  expect(diff.baseSha).toBe(git(root, "merge-base", "main", "HEAD"));
  expect(diff.truncated).toBe(false);
});

test("the working tree includes untracked files", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "one\n2\nthree\nfour\n");
  writeFileSync(join(root, "new file.txt"), "fresh\n");
  const diff = await readReviewPatch({
    ...run,
    root,
    target: { kind: "worktree" },
  });
  expect(diff.files.map((f) => f.path).sort()).toEqual([
    "a.txt",
    "new file.txt",
  ]);
});

test("an unknown revision is reported", async () => {
  const root = repository();
  await expect(
    readReviewPatch({
      ...run,
      root,
      target: { kind: "range", base: "nope", head: "HEAD" },
    }),
  ).rejects.toThrow("The review's base nope is gone from this checkout");
  const error = await readReviewCommits({
    ...run,
    root,
    base: "main",
    head: "3996d0feec6",
  }).catch((failure) => failure);
  expect(error).toBeInstanceOf(ReviewGoneError);
  expect(error.code).toBe("head-gone");
  expect(error.message).toBe(
    "The review's head 3996d0feec6 is gone from this checkout",
  );
});

test("a removed checkout is reported as such, not as the shell's error", async () => {
  const root = repository();
  rmSync(root, { recursive: true, force: true });
  const reads: (() => Promise<unknown>)[] = [
    () =>
      readReviewPatch({
        ...run,
        root,
        target: { kind: "range", base: "main", head: "HEAD" },
      }),
    () => readReviewPatch({ ...run, root, target: { kind: "worktree" } }),
    () =>
      readReviewState({
        ...run,
        root,
        target: { kind: "range", base: "main", head: "HEAD" },
      }),
    () => readReviewCommits({ ...run, root, base: "main", head: "HEAD" }),
    () => readReviewCommitPatch({ ...run, root, commit: "a".repeat(40) }),
    () => readReviewFile({ ...run, root, rev: "", path: "a.txt" }),
  ];
  for (const read of reads) {
    const error = (await read().catch((failure) => failure)) as ReviewGoneError;
    expect(error).toBeInstanceOf(ReviewGoneError);
    expect(error.code).toBe("checkout-gone");
    expect(error.message).toBe(`This checkout no longer exists: ${root}`);
  }
});

test("over SSH, a removed checkout and other failures are told apart", () => {
  const target = { kind: "range" as const, base: "main", head: "HEAD" };
  // The remote shell's banner or warnings come along on stderr.
  const gone = reviewScriptError(
    "Warning: Permanently added host\nROAMGATE-REVIEW-NO-CHECKOUT\n",
    "git failed",
    "/var/home/me/wt",
    target,
  );
  expect(gone).toBeInstanceOf(ReviewGoneError);
  expect(gone.message).toBe("This checkout no longer exists: /var/home/me/wt");
  const base = reviewScriptError(
    "unknown revision: main\n",
    "git failed",
    "/r",
    target,
  );
  expect((base as ReviewGoneError).code).toBe("base-gone");
  const other = reviewScriptError("fatal: bad object", "git failed", "/r");
  expect(other).not.toBeInstanceOf(ReviewGoneError);
  expect(other.message).toBe("fatal: bad object");
  expect(reviewScriptError("", "git failed", "/r").message).toBe("git failed");
});

test("the repository root is found from a subdirectory", async () => {
  const root = repository();
  expect(await readReviewRoot({ ...run, path: root })).toEndWith(
    root.split("/").at(-1)!,
  );
});

test("a cut patch drops its partial last file", () => {
  const output = [
    "ROAMGATE-REVIEW-SHAS b h",
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/y b/y",
    "--- a/y",
    "+++ b/y",
    "@@ -1 +1 @@",
    "-c",
  ].join("\n");
  const diff = parseReviewPatchOutput(output, 60);
  expect(diff.truncated).toBe(true);
  expect(diff.files.map((f) => f.path)).toEqual(["x"]);
  expect(diff.baseSha).toBe("b");
});

test("files are read at a commit or from the working tree, inside the checkout", async () => {
  const root = repository();
  writeFileSync(join(root, "a.txt"), "one\n2\nthree\nlocal\n");
  const base = git(root, "rev-parse", "main");
  expect(await readReviewFile({ ...run, root, rev: base, path: "a.txt" })).toBe(
    "one\ntwo\nthree\n",
  );
  expect(await readReviewFile({ ...run, root, rev: "", path: "a.txt" })).toBe(
    "one\n2\nthree\nlocal\n",
  );
  await expect(
    readReviewFile({ ...run, root, rev: "", path: "../etc/passwd" }),
  ).rejects.toThrow("invalid path");
  await expect(
    readReviewFile({ ...run, root, rev: "HEAD;rm", path: "a.txt" }),
  ).rejects.toThrow("invalid revision");
  expect(validReviewPath("src/a.c")).toBe(true);
  for (const path of ["/abs", "a//b", "a/../b", ""])
    expect(validReviewPath(path)).toBe(false);
});

test("heads of several checkouts in one command", async () => {
  const root = repository();
  const heads = await readReviewHeads({
    ...run,
    entries: [
      { root, ref: "HEAD" },
      { root, ref: "nope" },
      { root, ref: "main" },
    ],
  });
  expect(heads).toEqual([
    git(root, "rev-parse", "HEAD"),
    null,
    git(root, "rev-parse", "main"),
  ]);
});

test("a range's commits come oldest first, each with its own diff", async () => {
  const root = repository();
  writeFileSync(join(root, "b.txt"), "second\n");
  git(root, "add", "b.txt");
  git(root, "commit", "-q", "-m", "add b", "-m", "Body line.");
  const commits = await readReviewCommits({
    ...run,
    root,
    base: "main",
    head: "HEAD",
  });
  expect(commits.map((c) => c.subject)).toEqual(["change", "add b"]);
  expect(commits[1]!.body).toBe("Body line.");
  expect(commits[1]!.parent).toBe(commits[0]!.sha);
  const first = await readReviewCommitPatch({
    ...run,
    root,
    commit: commits[0]!.sha,
  });
  expect(first.files.map((f) => f.path)).toEqual(["a.txt"]);
  expect(first.headSha).toBe(commits[0]!.sha);
  const second = await readReviewCommitPatch({
    ...run,
    root,
    commit: commits[1]!.sha,
  });
  expect(second.files.map((f) => f.path)).toEqual(["b.txt"]);
  expect(second.baseSha).toBe(commits[0]!.sha);
  // The root commit diffs against nothing.
  const base = git(root, "rev-list", "--max-parents=0", "HEAD");
  const rootDiff = await readReviewCommitPatch({ ...run, root, commit: base });
  expect(rootDiff.files.map((f) => f.path)).toEqual(["a.txt"]);
  await expect(
    readReviewCommitPatch({ ...run, root, commit: "HEAD; rm" }),
  ).rejects.toThrow("invalid commit");
});

test("the default branch itself shows its recent history", async () => {
  const root = repository();
  const commits = await readReviewCommits({
    ...run,
    root,
    base: "main",
    head: "main",
  });
  // Nothing beyond main: its own commits, latest first, marked as history.
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.every((c) => c.history === true)).toBe(true);
  expect(commits[0]!.sha).toBe(git(root, "rev-parse", "main"));
  // A branch with work of its own is not history.
  const work = await readReviewCommits({
    ...run,
    root,
    base: "main",
    head: "HEAD",
  });
  expect(work.some((c) => c.history)).toBe(false);
});

test("a review from the empty tree covers the whole repository", async () => {
  const root = repository();
  const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const diff = await readReviewPatch({
    ...run,
    root,
    target: { kind: "range", base: empty, head: "HEAD" },
  });
  expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  expect(diff.files[0]!.hunks[0]!.header).toMatch(/^@@ -0,0 /);
  const commits = await readReviewCommits({
    ...run,
    root,
    base: empty,
    head: "HEAD",
  });
  // Every commit, oldest first; not the default branch's history.
  expect(commits.map((c) => c.subject)).toEqual(["base", "change"]);
  expect(commits.some((c) => c.history)).toBe(false);
});

test("a review's state changes when its code does", async () => {
  const root = repository();
  const range = { kind: "range" as const, base: "main", head: "HEAD" };
  const worktree = { kind: "worktree" as const };
  const read = (target: typeof range | typeof worktree) =>
    readReviewState({ ...run, root, target });
  const [range0, work0] = [await read(range), await read(worktree)];
  expect(await read(range)).toBe(range0);
  expect(await read(worktree)).toBe(work0);
  // An edit moves uncommitted work, not the branch.
  writeFileSync(join(root, "a.txt"), "edited\n");
  const work1 = await read(worktree);
  expect(work1).not.toBe(work0);
  expect(await read(range)).toBe(range0);
  // So do a new untracked file and a change to its content.
  writeFileSync(join(root, "new.txt"), "x\n");
  const work2 = await read(worktree);
  expect(work2).not.toBe(work1);
  writeFileSync(join(root, "new.txt"), "y\n");
  expect(await read(worktree)).not.toBe(work2);
  // A commit moves the branch.
  git(root, "commit", "-q", "-am", "more");
  expect(await read(range)).not.toBe(range0);
});

test("an agent's session record brings in the repositories it edits", async () => {
  const work = mkdtempSync(join(tmpdir(), "roamgate-review-scan-"));
  directories.push(work);
  // The agent runs in a clean repository and writes in another one that
  // has nothing committed yet.
  const notes = join(work, "notes");
  mkdirSync(notes);
  git(notes, "init", "-q", "-b", "main");
  writeFileSync(join(notes, "n.txt"), "n\n");
  git(notes, "add", "n.txt");
  git(notes, "commit", "-q", "-m", "notes");
  const app = join(work, "elsewhere", "app");
  mkdirSync(join(app, "src"), { recursive: true });
  git(app, "init", "-q", "-b", "main");
  writeFileSync(join(app, "src", "main.rs"), "fn main() {}\n");
  const home = join(work, "home");
  const records = join(
    home,
    ".claude",
    "projects",
    notes.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  mkdirSync(records, { recursive: true });
  writeFileSync(
    join(records, "s.jsonl"),
    `${JSON.stringify({ input: { file_path: join(app, "src", "main.rs") } })}\n`,
  );
  // The scan reads the records under the host's HOME.
  const repos = await scanReviewRepos({
    shQuote,
    runProcessWithCodeTimeout: (argv, timeoutMs) =>
      runProcessWithCodeTimeout(["env", `HOME=${home}`, ...argv], timeoutMs),
    paths: [notes],
    agentPaths: [notes],
  });
  const own = repos.find((repo) => repo.seed);
  const edited = repos.find((repo) => repo.touched);
  expect(own?.dirty).toBe(false);
  expect(edited?.root).toBe(
    Bun.spawnSync(["realpath", app]).stdout.toString().trim(),
  );
  // New files count as work, though nothing is committed.
  expect(edited?.dirty).toBe(true);
  expect(edited?.ahead).toBe(0);
});

test("subprojects someone works in count, pinned ones and neighbors do not", async () => {
  const work = mkdtempSync(join(tmpdir(), "roamgate-review-scan-"));
  directories.push(work);
  const commit = (root: string, file: string) => {
    writeFileSync(join(root, file), `${file}\n`);
    git(root, "add", file);
    git(root, "commit", "-q", "-m", file);
  };
  const repo = (root: string) => {
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    commit(root, "a.txt");
    git(root, "switch", "-q", "-c", "topic");
    commit(root, "b.txt");
    return root;
  };
  // The reviewed checkout, its worktree on another branch and an unrelated
  // repository next to it, a subproject on a branch and one a build tool
  // pinned (detached): all with fresh work.
  const app = repo(join(work, "app"));
  const other = join(work, "other-branch");
  git(app, "worktree", "add", "-q", "-b", "elsewhere", other, "main");
  commit(other, "c.txt");
  const lib = repo(join(work, "lib"));
  const worked = repo(join(app, "subprojects", "worked"));
  const pinned = repo(join(app, "subprojects", "pinned"));
  git(pinned, "switch", "-q", "--detach", "HEAD");
  const real = (path: string) =>
    Bun.spawnSync(["realpath", path]).stdout.toString().trim();
  const roots = (await scanReviewRepos({ ...run, paths: [app] })).map(
    (each) => each.root,
  );
  expect(roots).toContain(real(app));
  expect(roots).toContain(real(worked));
  expect(roots).not.toContain(real(pinned));
  expect(roots).not.toContain(real(other));
  expect(roots).not.toContain(real(lib));
});
