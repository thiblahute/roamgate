import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellRunner, shellArgv, shellEnv } from "./shell";

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const directory = mkdtempSync(join(tmpdir(), "roamgate-shell-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
// An ssh that runs the remote command here, as the host would.
const fakeSsh = join(directory, "ssh");
writeFileSync(
  fakeSsh,
  '#!/bin/sh\nfor last in "$@"; do :; done\nexec /bin/sh -c "$last"\n',
);
chmodSync(fakeSsh, 0o755);

function runner(remote: boolean) {
  return createShellRunner({
    shQuote,
    argv: (cwd, command) => {
      const argv = shellArgv({
        ...(remote ? { sshHost: "builder" } : {}),
        cwd,
        command,
        shQuote,
        loginShell: "/bin/sh",
      });
      if (remote) argv[0] = fakeSsh;
      return argv;
    },
  });
}

for (const remote of [false, true]) {
  const where = remote ? "over ssh" : "locally";

  test(`a \`!\` line runs ${where} in the session's directory, a real shell, with live output and its exit code`, async () => {
    const seen: string[] = [];
    const run = runner(remote)({
      cwd: directory,
      command: 'FOO=bar; echo hi && pwd\necho "$FOO" >&2\nexit 3',
      onOutput: (output) => seen.push(output.stdout + output.stderr),
    });
    expect(await run.done).toEqual({ code: 3, stopped: false });
    const last = seen.at(-1)!;
    expect(last).toContain("hi\n");
    expect(last).toContain(`${directory}\n`);
    expect(last).toContain("bar\n");
    // No job-control notice of the wrapper's.
    expect(last).not.toContain("Done");
  });

  test(`Stop ends a \`!\` line ${where}, and what it started`, async () => {
    const marker = join(directory, `stopped-${remote}`);
    const run = runner(remote)({
      cwd: directory,
      command: `sleep 5; touch ${shQuote(marker)}`,
      onOutput: () => {},
    });
    await Bun.sleep(200);
    const started = Date.now();
    run.stop();
    expect(await run.done).toEqual({ code: null, stopped: true });
    expect(Date.now() - started).toBeLessThan(2000);
    await Bun.sleep(100);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test(`a long output ${where} is kept up to a bound, and says so`, async () => {
    let last = { stdout: "", stderr: "", truncated: false };
    const run = runner(remote)({
      cwd: directory,
      command: "yes | head -c 200000",
      onOutput: (output) => (last = output),
    });
    expect(await run.done).toEqual({ code: 0, stopped: false });
    expect(last.truncated).toBe(true);
    expect(last.stdout.length).toBeLessThan(40_000);
    expect(last.stdout.length).toBeGreaterThan(30_000);
  });
}

test("a directory that is gone fails the run with why", async () => {
  let last = { stdout: "", stderr: "", truncated: false };
  const run = runner(false)({
    cwd: join(directory, "missing"),
    command: "echo never",
    onOutput: (output) => (last = output),
  });
  expect((await run.done).code).toBe(126);
  expect(last.stderr).toContain("missing");
  expect(last.stdout).toBe("");
});

test("over ssh, the wrapper and its arguments are quoted for the host's sh", () => {
  const argv = shellArgv({
    sshHost: "builder",
    cwd: "/home/me/it's here",
    command: "echo 'a b' && ls",
    shQuote,
  });
  expect(argv[0]).toBe("ssh");
  expect(argv).toContain("builder");
  const remote = argv.at(-1)!;
  expect(remote).toStartWith("sh -c ");
  expect(remote).toContain(shQuote("/home/me/it's here"));
  expect(remote).toContain(shQuote("echo 'a b' && ls"));
});

test("Roamgate's own variables stay out of the user's commands", () => {
  expect(
    shellEnv({
      PATH: "/bin",
      ROAMGATE_PASSWORD: "secret",
      HERDR_PANE_ID: "w1:p1",
      HOME: "/home/me",
    }),
  ).toEqual({ PATH: "/bin", HOME: "/home/me" });
});
