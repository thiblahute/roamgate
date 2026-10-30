import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISMISSED_PERMISSION_MESSAGE,
  DISMISSED_QUESTION_MESSAGE,
} from "../../../shared/review";
import { REVIEW_CLIENT_SCRIPT } from "../review/agent-client";
import { remoteSetupScript } from "../review/agent-remote";
import {
  HOLD_CLIENT_CHECKSUM,
  HOLD_CLIENT_SCRIPT,
  holderCommand,
  resumeCommand,
} from "./holder-script";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A scratch HOME with a fake Roamgate socket answering each command. */
function scratch(
  answer: (command: string, body: Record<string, string>) => unknown,
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-hold-")));
  const socket = join(dir, "r.sock");
  const requests: [string, Record<string, string>][] = [];
  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const command = new URL(request.url).pathname.replace("/v1/", "");
      const body = (await request.json()) as Record<string, string>;
      requests.push([command, body]);
      const reply = answer(command, body);
      return reply instanceof Response ? reply : Response.json(reply);
    },
  });
  cleanups.push(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, socket, requests };
}

async function run(
  script: string,
  args: string[],
  env: Record<string, string>,
  stdin: string,
  dir: string,
) {
  const path = join(dir, "script.py");
  writeFileSync(path, script, { mode: 0o755 });
  const child = Bun.spawn(["python3", path, ...args], {
    cwd: dir,
    env: { PATH: `${dir}/bin:/usr/bin:/bin`, HOME: dir, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, code };
}

describe("roamgate-hold", () => {
  test("execs claude --resume in the session's directory once Roamgate says so", async () => {
    const { dir, socket, requests } = scratch(() => ({
      action: "resume",
      session_id: "22222222-aaaa-bbbb-cccc-000000000000",
      cwd: "/",
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(
      join(bin, "claude"),
      '#!/bin/sh\necho "claude $* in $(pwd)"\n',
    );
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["11111111-aaaa-bbbb-cccc-000000000000"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      "",
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "conversation mode; Enter takes it back here",
    );
    expect(result.stdout).toContain(
      "claude --resume 22222222-aaaa-bbbb-cccc-000000000000 in /",
    );
    expect(requests[0]).toEqual([
      "hold",
      expect.objectContaining({
        pane: "w1:p1",
        session: "11111111-aaaa-bbbb-cccc-000000000000",
      }),
    ]);
  });

  test("Enter asks for the session back, and a refusal keeps holding", async () => {
    let handbacks = 0;
    const { dir, socket, requests } = scratch((command) => {
      if (command === "handback") {
        handbacks += 1;
        return handbacks === 1
          ? { action: "refused", reason: "Claude is in the middle of a turn" }
          : { action: "resume", session_id: "s-1", cwd: "/" };
      }
      return { action: "hold", session_id: "s-1" };
    });
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "claude $*"\n');
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      "\n\n",
      dir,
    );
    expect(result.stdout).toContain("Claude is in the middle of a turn");
    expect(result.stdout).toContain("claude --resume s-1");
    expect(requests.filter(([command]) => command === "handback")).toHaveLength(
      2,
    );
  });

  test("Roamgate gone, it will not resume next to a headless claude on an earlier id", async () => {
    // /clear moved the lease to s-2, but the process still says --resume s-1.
    let holds = 0;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-hold-")));
    const socket = join(dir, "r.sock");
    const server = Bun.serve({
      unix: socket,
      fetch: async (request) => {
        await request.text();
        holds += 1;
        if (holds === 1)
          return Response.json({ action: "hold", session_id: "s-2" });
        // The next poll waits, as a long poll does, until Roamgate dies.
        return new Promise<Response>(() => {});
      },
    });
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(
      join(bin, "ps"),
      "#!/bin/sh\necho '  42 claude -p --resume s-1 --input-format stream-json'\n",
    );
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "claude $*"\n');
    chmodSync(join(bin, "ps"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(dir, "hold.py"), HOLD_CLIENT_SCRIPT);
    const child = Bun.spawn(["python3", join(dir, "hold.py"), "s-1"], {
      cwd: dir,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        HERDR_PANE_ID: "w1:p1",
        ROAMGATE_REVIEW_SOCKET: socket,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(() => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    });
    const output = new Response(child.stdout).text();
    const deadline = Date.now() + 10_000;
    while (holds < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(holds).toBe(2);
    server.stop(true);
    rmSync(socket, { force: true });
    child.stdin.write("\n");
    child.stdin.flush();
    await Bun.sleep(1500);
    child.kill();
    const stdout = await output;
    expect(stdout).toContain(
      "a conversation process still runs, so not resuming",
    );
    expect(stdout).not.toContain("claude --resume");
  }, 20_000);

  test("--socket names Roamgate's socket, and claude resumes with its flags", async () => {
    const { dir, socket } = scratch(() => ({
      action: "resume",
      session_id: "s-1",
      cwd: "/",
      args: ["--model", "haiku", "--resume", "s-1"],
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "claude $*"\n');
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1", "--socket", socket],
      { HERDR_PANE_ID: "w1:p1" },
      "",
      dir,
    );
    expect(result.stdout).toContain("claude --model haiku --resume s-1");
  });

  test("a reply's full argv is what resumes, over claude's args alone", async () => {
    const { dir, socket } = scratch(() => ({
      action: "resume",
      session_id: "s-1",
      cwd: "/",
      // An older holder reads `args` (and runs claude); this one the argv.
      argv: ["other-agent", "resume", "s-1"],
      args: ["--resume", "s-1"],
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    for (const name of ["claude", "other-agent"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1", "--socket", socket],
      { HERDR_PANE_ID: "w1:p1" },
      "",
      dir,
    );
    // Not claude: its arguments are left as they are (no --session-id).
    expect(result.stdout).toContain("other-agent resume s-1");
    expect(result.stdout).not.toContain("claude ");
  });

  test("text that reaches the pane is no hand-back; Enter alone is", async () => {
    const { dir, socket, requests } = scratch((command) =>
      command === "handback"
        ? { action: "resume", session_id: "s-1", cwd: "/" }
        : { action: "hold", session_id: "s-1" },
    );
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "claude $*"\n');
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      "Explain how tides work\n\n",
      dir,
    );
    expect(result.stdout).toContain("Press Enter alone");
    expect(result.stdout).toContain("claude --resume s-1");
    expect(requests.filter(([command]) => command === "handback")).toHaveLength(
      1,
    );
  });

  test("a Roamgate that cannot answer for the pane does not trap it", async () => {
    const { dir, socket } = scratch(() =>
      Response.json({ error: "this connection is not ready" }, { status: 503 }),
    );
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "ps"), "#!/bin/sh\necho '  1 /sbin/launchd'\n");
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "claude $*"\n');
    chmodSync(join(bin, "ps"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      "\n",
      dir,
    );
    // No headless claude on the host (asked twice): claude resumes.
    expect(result.stdout).toContain("claude --resume s-1");
  }, 20_000);

  test("a log write that fails (a full disk) waits and goes on: no line lost, cut or doubled, and the child's exit is noted", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-hold-full-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "hold.py"), HOLD_CLIENT_SCRIPT);
    // The script's Child, its log failing twice (ENOSPC), then taking a
    // few bytes at a time; a child that prints three lines and exits.
    const probe = `
import errno, importlib.util, json, subprocess, sys, threading, time
spec = importlib.util.spec_from_file_location("hold", sys.argv[1] + "/hold.py")
hold = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hold)
child = hold.Child(sys.argv[1] + "/headless")
real = child.log
class Flaky:
    fails = 2
    def write(self, data):
        if Flaky.fails:
            Flaky.fails -= 1
            raise OSError(errno.ENOSPC, "No space left on device")
        return real.write(bytes(data[:7]))
child.log = Flaky()
with child.lock:
    child.start({"argv": [sys.executable, "-c", "print('{\\"a\\":1}'); print('{\\"b\\":2}'); print('{\\"c\\":3}')"]})
deadline = time.time() + 10
while time.time() < deadline:
    with child.lock:
        if child.proc is None:
            break
    time.sleep(0.05)
with open(child.path, "rb") as log:
    lines = [json.loads(line) for line in log.read().splitlines()]
print(json.dumps({"lines": lines, "size": child.size, "alive": child.proc is not None}))
`;
    writeFileSync(join(dir, "probe.py"), probe);
    const result = Bun.spawnSync(["python3", join(dir, "probe.py"), dir], {
      env: { PATH: "/usr/bin:/bin", HOME: dir },
    });
    expect(result.stderr.toString()).toBe("");
    const out = JSON.parse(result.stdout.toString()) as {
      lines: Record<string, unknown>[];
      alive: boolean;
    };
    expect(out.alive).toBe(false);
    expect(out.lines.map((line) => line.event ?? Object.keys(line)[0])).toEqual(
      ["start", "a", "b", "c", "exit"],
    );
  });

  test("needs a pane and a session", async () => {
    const { dir, socket } = scratch(() => ({}));
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      [],
      { ROAMGATE_REVIEW_SOCKET: socket },
      "",
      dir,
    );
    expect(result.code).toBe(2);
  });

  test("the typed command checks the session id", () => {
    expect(holderCommand("11111111-aaaa-bbbb-cccc-000000000000")).toBe(
      ' "$HOME/.cache/roamgate/bin/roamgate-hold" 11111111-aaaa-bbbb-cccc-000000000000\r',
    );
    expect(() => holderCommand("x; rm -rf /")).toThrow();
    // Locally, the holder and the socket are named whole.
    expect(
      holderCommand("11111111-aaaa-bbbb-cccc-000000000000", {
        bin: "/Users/me/.cache/roamgate/bin/roamgate-hold",
        socket: "/Users/me/My Files/review.sock",
      }),
    ).toBe(
      " /Users/me/.cache/roamgate/bin/roamgate-hold 11111111-aaaa-bbbb-cccc-000000000000 --socket '/Users/me/My Files/review.sock'\r",
    );
  });

  test("the typed resume keeps the flags every shell reads alike", () => {
    expect(resumeCommand("abcdef12", ["--model", "haiku"])).toBe(
      " claude --model haiku --resume abcdef12\r",
    );
    expect(resumeCommand("abcdef12", ["--append-system-prompt", "it's"])).toBe(
      " claude --append-system-prompt 'it'\\''s' --resume abcdef12\r",
    );
    // A backslash reads differently in fish: no flags then.
    expect(resumeCommand("abcdef12", ["--settings", "a\\b"])).toBe(
      " claude --resume abcdef12\r",
    );
    expect(() => resumeCommand("$(x)")).toThrow();
  });

  test("is installed on SSH hosts", () => {
    expect(remoteSetupScript()).toContain(
      `roamgate-hold ${HOLD_CLIENT_CHECKSUM}`,
    );
  });
});

describe("roamgate-review hooks in a headless run", () => {
  const hook = JSON.stringify({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });

  test("answer in an ordinary pane", async () => {
    const { dir, socket } = scratch(() => ({ answer: "allow" }));
    const result = await run(
      REVIEW_CLIENT_SCRIPT,
      ["permission"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      hook,
      dir,
    );
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision).toEqual({
      behavior: "allow",
    });
  });

  test("a dismissed permission or question denies it, saying the user dismissed it", async () => {
    const { dir, socket } = scratch(() => ({
      answer: "dismiss",
      answers: null,
      dismissed: true,
    }));
    const permission = await run(
      REVIEW_CLIENT_SCRIPT,
      ["permission"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      hook,
      dir,
    );
    expect(JSON.parse(permission.stdout).hookSpecificOutput.decision).toEqual({
      behavior: "deny",
      message: DISMISSED_PERMISSION_MESSAGE,
    });
    const question = await run(
      REVIEW_CLIENT_SCRIPT,
      ["questions"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      JSON.stringify({ tool_input: { questions: [{ question: "Q?" }] } }),
      dir,
    );
    expect(JSON.parse(question.stdout).hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DISMISSED_QUESTION_MESSAGE,
    });
  });

  test("step aside when ROAMGATE_HEADLESS=1", async () => {
    const { dir, socket, requests } = scratch(() => ({ answer: "allow" }));
    for (const command of ["permission", "questions"]) {
      const result = await run(
        REVIEW_CLIENT_SCRIPT,
        [command],
        {
          HERDR_PANE_ID: "w1:p1",
          ROAMGATE_REVIEW_SOCKET: socket,
          ROAMGATE_HEADLESS: "1",
        },
        command === "questions"
          ? JSON.stringify({ tool_input: { questions: [{ question: "Q?" }] } })
          : hook,
        dir,
      );
      expect(result).toMatchObject({ code: 0, stdout: "" });
    }
    expect(requests).toEqual([]);
  });
});
