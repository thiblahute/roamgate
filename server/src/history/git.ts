import { setPriority } from "node:os";
import { join } from "node:path";

/**
 * Git for the history repo, through Bun.spawn: never the user's identity,
 * hooks, signing or system config; at a low priority when asked (a pass
 * yields the CPU to whatever the user runs).
 */

export type GitResult = { code: number; stdout: string; stderr: string };

export type GitRunner = (
  args: string[],
  options?: { env?: Record<string, string>; input?: string },
) => Promise<GitResult>;

/** The options every history command runs with, whatever the user's config says. */
const FIXED = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "init.defaultBranch=main",
  "-c",
  "advice.detachedHead=false",
];

/** The environment without anything that points git elsewhere. */
function cleanEnvironment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) out[key] = value;
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_TERMINAL_PROMPT = "0";
  out.LC_ALL = "C";
  return out;
}

export function gitRunner(
  repo: string,
  options: { git?: string; lowPriority?: boolean } = {},
): GitRunner {
  const git = options.git ?? "git";
  return async (args, run = {}) => {
    // A directory that never exists: none of the user's hooks run.
    const hooks = `core.hooksPath=${join(repo, ".git", "roamgate-no-hooks")}`;
    const child = Bun.spawn([git, "-C", repo, ...FIXED, "-c", hooks, ...args], {
      stdin: run.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...cleanEnvironment(), ...run.env },
    });
    if (options.lowPriority)
      try {
        setPriority(child.pid, 19);
      } catch {
        // Not allowed here, or the child is gone: it runs as it is.
      }
    if (run.input !== undefined && child.stdin) {
      child.stdin.write(run.input);
      await child.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(
      `git ${args[0]} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    );
  }
}

/** Runs and throws on a failure. */
export async function gitOk(
  run: GitRunner,
  args: string[],
  options?: Parameters<GitRunner>[1],
): Promise<string> {
  const result = await run(args, options);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout;
}
