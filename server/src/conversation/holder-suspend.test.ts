import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLD_CLIENT_SCRIPT } from "./holder-script";

const SESSION = "11111111-aaaa-bbbb-cccc-000000000000";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Types lines into an interactive bash in a terminal (its job control on)
 * and prints what the terminal showed after each: the holder runs there
 * as a job of that shell, as in a pane.
 */
const DRIVER = `
import json, os, pty, select, sys, time
lines = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.environ["PS1"] = "$ "
    os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])
def read(until, seconds):
    out = b""
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
            if until and until.encode() in out:
                # What the shell prints next (its prompt) comes with it.
                until = None
                end = min(end, time.time() + 0.5)
    return out.decode("utf-8", "replace")
read("$ ", 5)
for line, until in lines:
    os.write(fd, line.encode() + b"\\r")
    sys.stdout.write("<<" + line + ">>" + read(until, 10))
    sys.stdout.flush()
os.write(fd, b"exit\\r")
`;

function scratch(
  answer: (command: string, body: Record<string, string>) => unknown,
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-hold-job-")));
  const socket = join(dir, "r.sock");
  const requests: [string, Record<string, string>][] = [];
  const projects = join(dir, ".claude", "projects", "elsewhere");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${SESSION}.jsonl`), "{}\n");
  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const command = new URL(request.url).pathname.replace("/v1/", "");
      const body = (await request.json()) as Record<string, string>;
      requests.push([command, body]);
      return Response.json(await answer(command, body));
    },
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "claude $* ran"\n');
  chmodSync(join(bin, "claude"), 0o755);
  const hold = join(bin, "roamgate-hold");
  writeFileSync(hold, HOLD_CLIENT_SCRIPT, { mode: 0o755 });
  writeFileSync(join(dir, "driver.py"), DRIVER);
  cleanups.push(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socket, requests, hold };
}

async function drive(
  setup: ReturnType<typeof scratch>,
  lines: [string, string][],
) {
  const child = Bun.spawn(
    ["python3", join(setup.dir, "driver.py"), JSON.stringify(lines)],
    {
      cwd: setup.dir,
      env: {
        PATH: `${setup.dir}/bin:/usr/bin:/bin`,
        HOME: setup.dir,
        TERM: "dumb",
        HERDR_PANE_ID: "w1:p1",
        ROAMGATE_REVIEW_SOCKET: setup.socket,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 60_000);
  const out = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(timer);
  return out;
}

const hasBash = Bun.spawnSync(["sh", "-c", "command -v bash"]).exitCode === 0;

describe.skipIf(!hasBash)("roamgate-hold as a shell job", () => {
  test("stops at Ctrl+Z, keeps the session, and fg brings it back to conversation mode", async () => {
    let holds = 0;
    let fgs = 0;
    const setup = scratch((command) => {
      if (command === "fg") {
        fgs += 1;
        return { action: "hold", session_id: SESSION };
      }
      holds += 1;
      // The first poll is told to stop; once back, it is handed back.
      if (holds === 1)
        return {
          action: "suspend",
          session_id: SESSION,
          cwd: "/",
          title: "Fix the build",
          terminal_args: ["--model", "haiku"],
        };
      return fgs
        ? {
            action: "resume",
            session_id: SESSION,
            cwd: "/",
            argv: ["claude", "--resume", SESSION],
          }
        : { action: "hold", session_id: SESSION };
    });
    const out = await drive(setup, [
      [`${setup.hold} ${SESSION}`, "[1]+"],
      ["jobs", "Stopped "],
      [`fg '%?${SESSION}'`, "ran"],
    ]);
    const [typed, jobs, back] = out.split("<<").slice(1);
    expect(typed).toContain(
      "Stopped: claude (conversation: Fix the build). fg brings it back.",
    );
    // The shell has its prompt, the holder as a stopped job.
    expect(jobs).toMatch(/\[1\]\+\s+Stopped/);
    expect(back).toContain("Bringing the conversation back...");
    expect(back).toContain(`claude --resume ${SESSION} ran`);
    const hold = setup.requests.find(([command]) => command === "hold");
    expect(hold?.[1]).toMatchObject({ job_control: 1, job: SESSION });
    const fg = setup.requests.find(([command]) => command === "fg");
    expect(fg?.[1]).toMatchObject({
      pane: "w1:p1",
      session: SESSION,
      cwd: "/",
      job_control: 1,
    });
    expect(JSON.parse(fg?.[1]?.terminal_args ?? "")).toEqual([
      "--model",
      "haiku",
    ]);
    // A new log: the conversation process starts afresh on the session.
    expect(fg?.[1]?.holder_id).not.toBe(hold?.[1]?.holder_id);
  }, 60_000);

  test("fg refused: it says why and stops again, fg retries", async () => {
    let holds = 0;
    let fgs = 0;
    const setup = scratch((command) => {
      if (command === "fg") {
        fgs += 1;
        return fgs === 1
          ? {
              action: "refused",
              reason: "claude runs the session in pane w2:p1",
            }
          : { action: "hold", session_id: SESSION };
      }
      holds += 1;
      if (holds === 1)
        return { action: "suspend", session_id: SESSION, cwd: "/" };
      return fgs > 1
        ? {
            action: "resume",
            session_id: SESSION,
            cwd: "/",
            argv: ["claude", "--resume", SESSION],
          }
        : { action: "hold", session_id: SESSION };
    });
    const out = await drive(setup, [
      [`${setup.hold} ${SESSION}`, "[1]+"],
      ["fg", "fg brings it back"],
      ["fg", "ran"],
    ]);
    const [, refused, back] = out.split("<<").slice(1);
    expect(refused).toContain(
      "Not brought back: claude runs the session in pane w2:p1",
    );
    expect(refused).toContain(`claude --resume ${SESSION}`);
    expect(back).toContain(`claude --resume ${SESSION} ran`);
    expect(fgs).toBe(2);
  }, 60_000);
});
