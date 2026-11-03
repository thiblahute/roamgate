import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRemoteUrl, parseRepoInfo, readRepoInfo } from "./repo-info";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

const run = async (_connection: string, script: string) => {
  const child = Bun.spawn(["/bin/sh", "-c", script], { stdout: "pipe" });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { code, stdout };
};

describe("repository info", () => {
  test("reads root, branch and remote of checkouts and linked worktrees", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-repo-")));
    dirs.push(base);
    const main = join(base, "gstreamer");
    git(base, "init", "-q", "-b", "main", main);
    git(main, "commit", "-q", "--allow-empty", "-m", "first");
    git(
      main,
      "remote",
      "add",
      "origin",
      "https://user:secret@gitlab.example.com/gst/gstreamer.git",
    );
    const linked = join(base, "gstreamer-ocio");
    git(main, "worktree", "add", "-q", "-b", "ocio", linked);
    const plain = join(base, "notes");
    Bun.spawnSync(["mkdir", plain]);
    const info = await readRepoInfo(run, "local", [
      main,
      linked,
      plain,
      join(base, "missing it's"),
    ]);
    expect(info.get(main)).toEqual({
      root: main,
      branch: "main",
      remoteUrl: "https://gitlab.example.com/gst/gstreamer.git",
      isWorktree: false,
    });
    expect(info.get(linked)).toEqual({
      root: main,
      branch: "ocio",
      remoteUrl: "https://gitlab.example.com/gst/gstreamer.git",
      isWorktree: true,
    });
    expect(info.get(plain)).toBeNull();
    expect(info.get(join(base, "missing it's"))).toBeNull();
  });

  test("a worktree of a repository with its git directory apart keeps no root", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-repo-")));
    dirs.push(base);
    const main = join(base, "gstreamer");
    git(
      base,
      "init",
      "-q",
      "-b",
      "main",
      "--separate-git-dir",
      join(base, "gstreamer.git"),
      main,
    );
    git(main, "commit", "-q", "--allow-empty", "-m", "first");
    const linked = join(base, "ocio");
    git(main, "worktree", "add", "-q", "-b", "ocio", linked);
    const info = await readRepoInfo(run, "local", [main, linked]);
    expect(info.get(main)?.root).toBe(main);
    expect(info.get(linked)).toMatchObject({
      root: null,
      branch: "ocio",
      isWorktree: true,
    });
  });

  test("a detached head has no branch; no remote is null", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rg-repo-")));
    dirs.push(base);
    git(base, "init", "-q", "-b", "main", ".");
    git(base, "commit", "-q", "--allow-empty", "-m", "first");
    git(base, "checkout", "-q", "--detach");
    const info = await readRepoInfo(run, "local", [base]);
    expect(info.get(base)).toEqual({
      root: base,
      branch: null,
      remoteUrl: null,
      isWorktree: false,
    });
  });

  test("credentials never leave a remote URL", () => {
    expect(cleanRemoteUrl("https://oauth2:tok@github.com/a/b")).toBe(
      "https://github.com/a/b",
    );
    expect(cleanRemoteUrl("ssh://git:pw@host:22/a/b.git")).toBe(
      "ssh://git@host:22/a/b.git",
    );
    expect(
      cleanRemoteUrl("git@gitlab.freedesktop.org:gstreamer/gstreamer"),
    ).toBe("git@gitlab.freedesktop.org:gstreamer/gstreamer");
    expect(cleanRemoteUrl("")).toBeNull();
  });

  test("output for unknown indexes or without markers is ignored", () => {
    const parsed = parseRepoInfo(
      "top /x\nM begin 5\ntop /y\nM end 5\n",
      ["/a"],
      "M",
    );
    expect(parsed.size).toBe(0);
  });
});
