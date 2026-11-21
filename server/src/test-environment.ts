import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The shell's path when it is installed and runs, else null: a test
 * needing it is skipped then. A name found on PATH is not enough: a
 * wrapper for a shell that is not installed (a toolbox's, forwarding to
 * the host) fails each run.
 */
export function runnableShell(name: string): string | null {
  const path = Bun.which(name);
  if (!path) return null;
  try {
    const run = Bun.spawnSync([path, "-c", "exit 0"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return run.exitCode === 0 ? path : null;
  } catch {
    return null;
  }
}

/**
 * For a test file standing in for an SSH host with a local shell: its
 * login shells (`bash -lc`) read an empty HOME for the file's tests, not
 * the developer's profile, which is not a host's and can take a second
 * to run each time.
 */
export function standInHostHome(): void {
  let saved: string | undefined;
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "roamgate-host-home-"));
    saved = process.env.HOME;
    process.env.HOME = home;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
}
