import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_CLIENT_INSTALLED_SCRIPT } from "./agent-server";
import { remoteForwardArgv, remoteSetupScript } from "./agent-remote";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runSetup(home: string) {
  const result = Bun.spawnSync(["sh", "-c", remoteSetupScript()], {
    env: { PATH: process.env.PATH, HOME: home },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("the host setup installs the client once and names the socket", () => {
  const home = mkdtempSync(join(tmpdir(), "rg-remote-home-"));
  directories.push(home);
  const first = runSetup(home);
  expect(first.stderr).toBe("");
  expect(first.stdout).toBe(join(home, ".cache/roamgate/review.sock"));
  const client = join(home, ".cache/roamgate/bin/roamgate-review");
  expect(readFileSync(client, "utf8")).toBe(REVIEW_CLIENT_INSTALLED_SCRIPT);
  expect(statSync(client).mode & 0o777).toBe(0o755);
  expect(statSync(join(home, ".cache/roamgate")).mode & 0o777).toBe(0o700);

  // The same version is left alone.
  const before = statSync(client).mtimeMs;
  Bun.sleepSync(20);
  expect(runSetup(home).code).toBe(0);
  expect(statSync(client).mtimeMs).toBe(before);
});

test("the host setup links the skill and client, not over the user's", () => {
  const home = mkdtempSync(join(tmpdir(), "rg-remote-home-"));
  directories.push(home);
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/roamgate-review"), "mine");
  const setup = runSetup(home);
  expect(setup.stderr).toBe("");
  expect(
    readFileSync(join(home, ".claude/skills/roamgate-review/SKILL.md"), "utf8"),
  ).toStartWith("---\nname: roamgate-review");
  expect(readFileSync(join(home, ".local/bin/roamgate-review"), "utf8")).toBe(
    "mine",
  );
  rmSync(join(home, ".local/bin/roamgate-review"));
  expect(runSetup(home).code).toBe(0);
  expect(readlinkSync(join(home, ".local/bin/roamgate-review"))).toBe(
    join(home, ".cache/roamgate/bin/roamgate-review"),
  );
});

test("the forward rides the master's control socket", () => {
  expect(
    remoteForwardArgv(
      "dev@host",
      "/c/ctl",
      "/home/dev/.cache/roamgate/review.sock",
      "/l/a.sock",
    ),
  ).toEqual(
    expect.arrayContaining([
      "-S",
      "/c/ctl",
      "-O",
      "forward",
      "-R",
      "/home/dev/.cache/roamgate/review.sock:/l/a.sock",
      "dev@host",
    ]),
  );
});
