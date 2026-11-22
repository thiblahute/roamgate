import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { readCompareRefs } from "./diff-base";

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

function commit(root: string, file: string, at: number) {
  writeFileSync(join(root, file), file);
  git(root, "add", file);
  const date = `@${at} +0000`;
  const result = Bun.spawnSync(
    ["git", "-C", root, "commit", "-q", "-m", file],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

test("the scope picker's refs: branches with their dates, the newest tags, HEAD's upstream, its stack's neighbours and Automatic's base", async () => {
  const root = mkdtempSync(join(tmpdir(), "roamgate-compare-refs-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  commit(root, "base", 1_000);
  git(root, "tag", "v1.0");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    root,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  git(root, "switch", "-q", "-c", "up/one");
  commit(root, "one", 2_000);
  git(root, "switch", "-q", "-c", "up/two");
  commit(root, "two", 3_000);
  git(root, "switch", "-q", "-c", "up/three");
  commit(root, "three", 4_000);
  git(root, "branch", "backup/old", "up/one");
  git(root, "switch", "-q", "up/two");
  git(root, "remote", "add", "origin", "https://example.test/repo.git");
  git(root, "config", "branch.up/two.remote", "origin");
  git(root, "config", "branch.up/two.merge", "refs/heads/main");

  const refs = await readCompareRefs({
    root,
    shQuote,
    runProcessWithCodeTimeout,
  });
  expect(refs.current).toBe("refs/heads/up/two");
  expect(refs.upstream).toBe("refs/remotes/origin/main");
  expect(refs.base).toBe("refs/remotes/origin/main");
  // Below HEAD (its stack's lower layers), then above it.
  expect(refs.near).toContain("refs/heads/up/one");
  expect(refs.near.at(-1)).toBe("refs/heads/up/three");
  expect(refs.near).not.toContain("refs/heads/up/two");
  const byName = new Map(refs.refs.map((ref) => [ref.name, ref.date]));
  expect(byName.get("refs/heads/up/three")).toBe(4_000);
  expect(byName.get("refs/tags/v1.0")).toBe(1_000);
  expect(byName.has("refs/remotes/origin/main")).toBe(true);
  // A remote's HEAD is no ref of its own.
  expect(byName.has("refs/remotes/origin/HEAD")).toBe(false);
});
