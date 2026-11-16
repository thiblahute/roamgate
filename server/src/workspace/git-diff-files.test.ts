import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LARGE_DIFF_PATCH_BYTES } from "../../../shared/gitDiffLimits";
import type { RunProcessWithCodeTimeout } from "./file-types";
import {
  GIT_DIFF_FILES_MAX,
  readDiffFile,
  readDiffFiles,
  runScriptBatch,
} from "./git-diff";

setDefaultTimeout(30_000);

let processes = 0;
const runProcessWithCodeTimeout: RunProcessWithCodeTimeout = async (argv) => {
  processes += 1;
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function git(root: string, ...args: string[]) {
  const result = await runProcessWithCodeTimeout(
    ["git", "-C", root, ...args],
    5000,
  );
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

/** main with a.txt..e.txt, a branch changing each, and working changes. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-diff-files-"));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  for (const name of ["a", "b", "c", "d", "e"])
    await writeFile(join(root, `${name}.txt`), `${name} one\n${name} two\n`);
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  await git(root, "checkout", "-qb", "feature");
  for (const name of ["a", "b", "c", "d", "e"])
    await writeFile(join(root, `${name}.txt`), `${name} one\n${name} 2\n`);
  await git(root, "commit", "-qam", "change");
  return root;
}

describe("git.diff_files", () => {
  test("reads several files of a branch review with one shell command, each its own patch", async () => {
    const root = await repository();
    try {
      const paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
      const one = await Promise.all(
        paths.map((path) =>
          readDiffFile({
            workspaceId: "w",
            root,
            params: { mode: "branch-main", path, kind: "branch" },
            shQuote,
            runProcessWithCodeTimeout,
          }),
        ),
      );
      processes = 0;
      const read = await readDiffFiles({
        workspaceId: "w",
        root,
        params: {
          mode: "branch-main",
          entries: paths.map((path) => ({ path, kind: "branch" })),
        },
        shQuote,
        runProcessWithCodeTimeout,
      });
      // The base resolved within the last seconds is reused: only the
      // batch itself runs.
      expect(processes).toBe(1);
      expect(read.files.map((file) => file.path)).toEqual(paths);
      read.files.forEach((file, index) => {
        expect(file).toEqual(one[index]!);
        expect("diff" in file && file.diff).toContain(`+${paths[index]![0]} 2`);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("gives each file of the working review its combined diff, and a failing file its own error", async () => {
    const root = await repository();
    try {
      await writeFile(join(root, "a.txt"), "a one\na staged\n");
      await git(root, "add", "a.txt");
      await writeFile(join(root, "a.txt"), "a one\na staged\nand more\n");
      await writeFile(join(root, "new.txt"), "brand new\n");
      // A FIFO is refused (git would block on it).
      await Bun.spawn(["mkfifo", join(root, "pipe")]).exited;
      const read = await readDiffFiles({
        workspaceId: "w",
        root,
        params: {
          mode: "working",
          entries: [
            { path: "a.txt", kind: "combined" },
            { path: "pipe", kind: "combined" },
            { path: "new.txt", kind: "combined" },
          ],
        },
        shQuote,
        runProcessWithCodeTimeout,
      });
      const [a, pipe, created] = read.files;
      const single = await readDiffFile({
        workspaceId: "w",
        root,
        params: { mode: "working", path: "a.txt", kind: "combined" },
        shQuote,
        runProcessWithCodeTimeout,
      });
      expect(a).toEqual(single);
      expect(a && "staged" in a && a.staged).toBeTruthy();
      expect(pipe && "error" in pipe && pipe.error).toContain(
        "not a regular file",
      );
      expect(created).toMatchObject({ path: "new.txt", untracked: true });
      expect(created && "diff" in created && created.diff).toContain(
        "+brand new",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the per-file caps: a large automatic file is deferred, not sent", async () => {
    const root = await repository();
    try {
      await writeFile(
        join(root, "b.txt"),
        `${"x".repeat(LARGE_DIFF_PATCH_BYTES + 10)}\n`,
      );
      const read = await readDiffFiles({
        workspaceId: "w",
        root,
        params: {
          mode: "working",
          automatic: true,
          entries: [
            { path: "a.txt", kind: "unstaged" },
            { path: "b.txt", kind: "unstaged" },
          ],
        },
        shQuote,
        runProcessWithCodeTimeout,
      });
      expect(read.files[1]).toMatchObject({ deferred: true, diff: "" });
      expect(read.files[0]).not.toHaveProperty("deferred");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses no entries and more than its maximum", async () => {
    const args = {
      workspaceId: "w",
      root: "/nowhere",
      shQuote,
      runProcessWithCodeTimeout,
    };
    await expect(
      readDiffFiles({ ...args, params: { entries: [] } }),
    ).rejects.toThrow("requires entries");
    await expect(
      readDiffFiles({
        ...args,
        params: {
          entries: Array.from({ length: GIT_DIFF_FILES_MAX + 1 }, (_, i) => ({
            path: `f${i}`,
          })),
        },
      }),
    ).rejects.toThrow("at most");
  });
});

describe("runScriptBatch", () => {
  test("frames each script's output, error output and exit code, past a login profile's noise", async () => {
    const outputs = await runScriptBatch({
      scripts: [
        "printf 'one\\n\\ntwo'",
        "echo oops >&2; exit 3",
        "trap 'echo bye' 0; printf 'last\\n'",
      ],
      runProcessWithCodeTimeout: async (argv, timeoutMs) => {
        const result = await runProcessWithCodeTimeout(argv, timeoutMs);
        return { ...result, stdout: `profile noise\n${result.stdout}` };
      },
    });
    expect(outputs).toEqual([
      { code: 0, stdout: "one\n\ntwo", stderr: "" },
      { code: 3, stdout: "", stderr: "oops\n" },
      { code: 0, stdout: "last\nbye\n", stderr: "" },
    ]);
  });

  test("a batch cut short gives the unanswered scripts the failure", async () => {
    const outputs = await runScriptBatch({
      scripts: ["printf ok", "kill -9 $$", "printf never"],
      runProcessWithCodeTimeout,
    });
    expect(outputs[0]).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(outputs[2]!.code).not.toBe(0);
    expect(outputs[2]!.stderr).toBeTruthy();
  });
});
