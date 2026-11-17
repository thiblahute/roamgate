import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { MrConnection } from "./clones";

/**
 * Git repositories for tests, built in a temp directory: a "forge" of bare
 * repositories reached through an https URL (git's insteadOf maps it to
 * the files), clones with branches, and a connection that runs scripts
 * here as a Herdr connection would on its host.
 */

export const FORGE_HOST = "gitlab.example.org";

export type GitFixture = {
  root: string;
  /** git in a directory; throws on failure, gives stdout. */
  git: (dir: string, ...args: string[]) => string;
  /** A bare project on the forge, with a first commit on main. */
  project: (path: string) => string;
  /** A clone of a forge project, its origin the project's https URL. */
  clone: (path: string, name: string) => string;
  /** A commit of `file` with `content` (a fixed date unless given). */
  commit: (
    dir: string,
    file: string,
    content: string,
    message: string,
    at?: number,
  ) => string;
  /** A connection running scripts in a shell here, with these workspaces. */
  connection: (
    workspaces: {
      workspace_id: string;
      label: string;
      cwd: string;
      /** Herdr's worktree metadata, when the test needs it. */
      worktree?: Record<string, unknown>;
    }[],
    id?: string,
  ) => MrConnection & { scripts: string[] };
  cleanup: () => void;
};

export function createGitFixture(): GitFixture {
  const root = realpathSync(mkdtempSync("/tmp/rg-git-"));
  const home = join(root, "home");
  mkdirSync(home);
  // Every repository here sees the forge through its https URL.
  writeFileSync(
    join(home, ".gitconfig"),
    [
      "[user]",
      "\tname = Test",
      "\temail = test@example.org",
      `[url "file://${root}/forge/"]`,
      `\tinsteadOf = https://${FORGE_HOST}/`,
      "[init]",
      "\tdefaultBranch = main",
      "[advice]",
      "\tdetachedHead = false",
      "",
    ].join("\n"),
  );
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const git = (dir: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", dir, ...args], { env });
    if (result.exitCode !== 0)
      throw new Error(
        `git ${args.join(" ")}: ${result.stderr.toString().trim()}`,
      );
    return result.stdout.toString();
  };
  // Recent: a branch quiet for months is Stale.
  let clock = Math.floor(Date.now() / 1000) - 86_400;
  const commit: GitFixture["commit"] = (dir, file, content, message, at) => {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    git(dir, "add", file);
    const when = `@${at ?? (clock += 60)} +0000`;
    const result = Bun.spawnSync(
      ["git", "-C", dir, "commit", "-q", "-m", message],
      { env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } },
    );
    if (result.exitCode !== 0)
      throw new Error(`commit: ${result.stderr.toString()}`);
    return git(dir, "rev-parse", "HEAD").trim();
  };
  const project = (path: string) => {
    const bare = join(root, "forge", `${path}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare");
    const seed = join(root, "seed", path);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q");
    commit(seed, "README", "hello\n", "Start");
    git(seed, "push", "-q", bare, "main");
    return bare;
  };
  const clone = (path: string, name: string) => {
    const dir = join(root, "clones", name);
    mkdirSync(dirname(dir), { recursive: true });
    const result = Bun.spawnSync(
      ["git", "clone", "-q", `https://${FORGE_HOST}/${path}.git`, dir],
      { env },
    );
    if (result.exitCode !== 0)
      throw new Error(`clone: ${result.stderr.toString()}`);
    git(dir, "remote", "set-head", "origin", "main");
    return dir;
  };
  const connection: GitFixture["connection"] = (workspaces, id = "local") => {
    const scripts: string[] = [];
    return {
      id,
      label: id === "local" ? "Desktop" : id,
      scripts,
      run: async (script) => {
        scripts.push(script);
        const result = Bun.spawnSync(["sh", "-c", script], { env });
        return {
          code: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
      dirs: async () => workspaces.map((each) => each.cwd),
      // As Herdr answers: a workspace's folder is its panes'.
      herdr: async (method: string) =>
        method === "workspace.list"
          ? {
              workspaces: workspaces.map(
                ({ workspace_id, label, worktree }) => ({
                  workspace_id,
                  label,
                  ...(worktree ? { worktree } : {}),
                }),
              ),
            }
          : {
              panes: workspaces.map((each) => ({
                pane_id: `${each.workspace_id}:p1`,
                workspace_id: each.workspace_id,
                cwd: each.cwd,
              })),
            },
    };
  };
  return {
    root,
    git,
    project,
    clone,
    commit,
    connection,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
