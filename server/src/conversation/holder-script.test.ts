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
import {
  DISMISSED_PERMISSION_MESSAGE,
  DISMISSED_QUESTION_MESSAGE,
} from "../../../shared/review";
import { REVIEW_CLIENT_SCRIPT } from "../review/agent-client";
import { remoteSetupScript } from "../review/agent-remote";
import {
  CLAUDE_START_HOOK_COMMAND,
  CLAUDE_START_HOOK_INSTALL_SCRIPT,
} from "./claude-start-hook";
import {
  HOLD_CLIENT_CHECKSUM,
  HOLD_CLIENT_SCRIPT,
  holderCommand,
  resumeCommand,
  launchCommand,
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
  // The sessions these tests resume have transcripts (see the fresh one).
  const projects = join(dir, ".claude", "projects", "elsewhere");
  mkdirSync(projects, { recursive: true });
  for (const session of [
    "11111111-aaaa-bbbb-cccc-000000000000",
    "22222222-aaaa-bbbb-cccc-000000000000",
    "s-1",
  ])
    writeFileSync(join(projects, `${session}.jsonl`), "{}\n");
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
      " env ROAMGATE_CLAUDE_START=terminal claude --model haiku --resume abcdef12\r",
    );
    expect(resumeCommand("abcdef12", ["--append-system-prompt", "it's"])).toBe(
      " env ROAMGATE_CLAUDE_START=terminal claude --append-system-prompt 'it'\\''s' --resume abcdef12\r",
    );
    // A backslash reads differently in fish: no flags then.
    expect(resumeCommand("abcdef12", ["--settings", "a\\b"])).toBe(
      " env ROAMGATE_CLAUDE_START=terminal claude --resume abcdef12\r",
    );
    expect(() => resumeCommand("$(x)")).toThrow();
  });

  test("a session with no transcript yet is started with its id, not resumed", async () => {
    const fresh = "33333333-aaaa-bbbb-cccc-000000000000";
    const { dir, socket } = scratch(() => ({
      action: "resume",
      session_id: fresh,
      cwd: "/",
      args: ["--model", "haiku", "--resume", fresh],
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(
      join(bin, "claude"),
      '#!/bin/sh\necho "claude $* start=$ROAMGATE_CLAUDE_START"\n',
    );
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      [fresh],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      "",
      dir,
    );
    // And the claude it becomes stays in the terminal (no claude start).
    expect(result.stdout).toContain(
      `claude --model haiku --session-id ${fresh} start=terminal`,
    );
  });

  test("the claude it becomes is marked to stay in the terminal", async () => {
    const { dir, socket } = scratch(() => ({
      action: "resume",
      session_id: "s-1",
      cwd: "/",
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(
      join(bin, "claude"),
      '#!/bin/sh\necho "claude $* start=$ROAMGATE_CLAUDE_START"\n',
    );
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      "",
      dir,
    );
    expect(result.stdout).toContain("claude --resume s-1 start=terminal");
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

describe("roamgate-review claude-start (the SessionStart hook)", () => {
  const SESSION = "44444444-aaaa-bbbb-cccc-000000000000";
  const startup = JSON.stringify({
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: SESSION,
    cwd: "/tmp",
  });

  /** A ps: the hook's parent is a shell, whose parent is claude (4242). */
  function fakePs(dir: string, claudeArgs: string) {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/sh
case "$*" in
  *"-p 4242"*) echo "  1 claude ${claudeArgs}" ;;
  *) echo "  4242 /bin/sh -c ~/.cache/roamgate/bin/roamgate-review claude-start" ;;
esac
`,
    );
    chmodSync(join(bin, "ps"), 0o755);
  }

  test("tells Roamgate of a claude started by hand, printing nothing", async () => {
    const { dir, socket, requests } = scratch(() => ({
      action: "conversation",
    }));
    fakePs(dir, "--model haiku");
    const result = await run(
      REVIEW_CLIENT_SCRIPT,
      ["claude-start"],
      {
        HERDR_PANE_ID: "w1:p1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        ROAMGATE_REVIEW_SOCKET: socket,
      },
      startup,
      dir,
    );
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(requests).toEqual([
      [
        "claude_start",
        expect.objectContaining({
          pane: "w1:p1",
          herdr_socket: "/tmp/herdr.sock",
          session: SESSION,
          source: "startup",
          pid: "4242",
        }),
      ],
    ]);
  });

  test("steps aside: told to stay, headless, print mode, /clear, a subagent, no pane", async () => {
    const { dir, socket, requests } = scratch(() => ({}));
    const pane = { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket };
    const cases: [Record<string, string>, string, string][] = [
      [{ ...pane, ROAMGATE_CLAUDE_START: "terminal" }, startup, ""],
      [{ ...pane, ROAMGATE_HEADLESS: "1" }, startup, ""],
      [pane, startup, "-p hello"],
      [pane, startup, "--print"],
      [pane, JSON.stringify({ source: "clear", session_id: SESSION }), ""],
      [
        pane,
        JSON.stringify({
          source: "startup",
          session_id: SESSION,
          agent_id: "a1",
        }),
        "",
      ],
      [{ ROAMGATE_REVIEW_SOCKET: socket }, startup, ""],
    ];
    for (const [env, stdin, claudeArgs] of cases) {
      fakePs(dir, claudeArgs);
      const result = await run(
        REVIEW_CLIENT_SCRIPT,
        ["claude-start"],
        env,
        stdin,
        dir,
      );
      expect(result).toMatchObject({ code: 0, stdout: "" });
    }
    expect(requests).toEqual([]);
  });

  test("a resumed claude counts; Roamgate unreachable changes nothing", async () => {
    const { dir, socket, requests } = scratch(() => ({}));
    fakePs(dir, "--resume x");
    const resumed = JSON.stringify({ source: "resume", session_id: SESSION });
    await run(
      REVIEW_CLIENT_SCRIPT,
      ["claude-start"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: socket },
      resumed,
      dir,
    );
    expect(requests.map(([command, body]) => [command, body.source])).toEqual([
      ["claude_start", "resume"],
    ]);
    const gone = await run(
      REVIEW_CLIENT_SCRIPT,
      ["claude-start"],
      { HERDR_PANE_ID: "w1:p1", ROAMGATE_REVIEW_SOCKET: join(dir, "none") },
      resumed,
      dir,
    );
    expect(gone).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("the claude start hook's installer", () => {
  function home() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-hookinst-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("adds the hook once, beside the user's own hooks and settings", async () => {
    const dir = home();
    mkdirSync(join(dir, ".claude"));
    const own = {
      model: "opus",
      hooks: {
        SessionStart: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "my-hook session" }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "my-stop" }] }],
      },
    };
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(own));
    const first = await run(CLAUDE_START_HOOK_INSTALL_SCRIPT, [], {}, "", dir);
    expect(first.stdout.trim()).toBe("installed");
    const second = await run(CLAUDE_START_HOOK_INSTALL_SCRIPT, [], {}, "", dir);
    expect(second.stdout.trim()).toBe("present");
    const settings = JSON.parse(
      await Bun.file(join(dir, ".claude", "settings.json")).text(),
    );
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toEqual(own.hooks.Stop);
    expect(settings.hooks.SessionStart).toEqual([
      own.hooks.SessionStart[0],
      {
        matcher: "startup|resume",
        hooks: [
          { type: "command", command: CLAUDE_START_HOOK_COMMAND, timeout: 10 },
        ],
      },
    ]);
  });

  test("leaves settings it cannot read alone, and a host without Claude", async () => {
    const dir = home();
    expect(
      (
        await run(CLAUDE_START_HOOK_INSTALL_SCRIPT, [], {}, "", dir)
      ).stdout.trim(),
    ).toBe("no-claude");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), "{ // comment\n}");
    expect(
      (
        await run(CLAUDE_START_HOOK_INSTALL_SCRIPT, [], {}, "", dir)
      ).stdout.trim(),
    ).toBe("invalid");
    expect(await Bun.file(join(dir, ".claude", "settings.json")).text()).toBe(
      "{ // comment\n}",
    );
  });

  test("creates the settings file when Claude has none", async () => {
    const dir = home();
    mkdirSync(join(dir, ".claude"));
    expect(
      (
        await run(CLAUDE_START_HOOK_INSTALL_SCRIPT, [], {}, "", dir)
      ).stdout.trim(),
    ).toBe("installed");
    const settings = JSON.parse(
      await Bun.file(join(dir, ".claude", "settings.json")).text(),
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      CLAUDE_START_HOOK_COMMAND,
    );
  });
});

describe("roamgate-hold and agent profiles", () => {
  const ENV_PROBE =
    '#!/bin/sh\necho "$(basename "$0") $* BASE=${ANTHROPIC_BASE_URL:-none} KEY=${ANTHROPIC_API_KEY:-none} START=${ROAMGATE_CLAUDE_START:-none}"\n';

  test("--launch trades its token for the program and environment", async () => {
    const { dir, socket, requests } = scratch((command) =>
      command === "launch"
        ? {
            argv: ["glm-claude", "--resume", "s-1"],
            env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
            unset: ["ANTHROPIC_API_KEY"],
            agent: "claude",
            terminal: true,
          }
        : { error: "unexpected" },
    );
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "glm-claude"), ENV_PROBE);
    chmodSync(join(bin, "glm-claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["--socket", socket, "--launch", "0123456789abcdef0123456789abcdef"],
      { HERDR_PANE_ID: "w1:p1", ANTHROPIC_API_KEY: "pane-key" },
      "",
      dir,
    );
    expect(result.stdout.trim()).toBe(
      "glm-claude --resume s-1 BASE=https://gateway.example KEY=none START=terminal",
    );
    expect(requests).toEqual([
      ["launch", { pane: "w1:p1", token: "0123456789abcdef0123456789abcdef" }],
    ]);
  });

  test("--launch of a session with no transcript starts it by its id", async () => {
    const { dir, socket } = scratch(() => ({
      argv: ["claude", "--resume", "33333333-aaaa-bbbb-cccc-000000000000"],
      env: {},
      unset: [],
      agent: "claude",
      terminal: false,
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "claude"), ENV_PROBE);
    chmodSync(join(bin, "claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["--socket", socket, "--launch", "0123456789abcdef0123456789abcdef"],
      { HERDR_PANE_ID: "w1:p1" },
      "",
      dir,
    );
    expect(result.stdout).toContain(
      "claude --session-id 33333333-aaaa-bbbb-cccc-000000000000",
    );
    expect(result.stdout).toContain("START=none");
  });

  test("an expired launch says so and runs nothing", async () => {
    const { dir, socket } = scratch(
      () =>
        new Response(JSON.stringify({ error: "no such start" }), {
          status: 404,
        }),
    );
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["--socket", socket, "--launch", "0123456789abcdef0123456789abcdef"],
      { HERDR_PANE_ID: "w1:p1" },
      "",
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no such start");
  });

  test("a hand-back resumes with the session's profile environment", async () => {
    const { dir, socket } = scratch(() => ({
      action: "resume",
      session_id: "s-1",
      cwd: "/",
      argv: ["glm-claude", "--resume", "s-1"],
      args: ["--resume", "s-1"],
      agent: "claude",
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      unset: ["ANTHROPIC_API_KEY"],
    }));
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "glm-claude"), ENV_PROBE);
    chmodSync(join(bin, "glm-claude"), 0o755);
    const result = await run(
      HOLD_CLIENT_SCRIPT,
      ["s-1", "--socket", socket],
      { HERDR_PANE_ID: "w1:p1", ANTHROPIC_API_KEY: "pane-key" },
      "",
      dir,
    );
    expect(result.stdout).toContain(
      "glm-claude --resume s-1 BASE=https://gateway.example KEY=none START=terminal",
    );
  });

  test("launchCommand types only a token", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(launchCommand(token)).toBe(
      ` "$HOME/.cache/roamgate/bin/roamgate-hold" --launch ${token}\r`,
    );
    expect(
      launchCommand(token, {
        bin: "/h/bin/roamgate-hold",
        socket: "/h/r.sock",
      }),
    ).toBe(` /h/bin/roamgate-hold --socket /h/r.sock --launch ${token}\r`);
    expect(() => launchCommand("not a token; rm -rf ~")).toThrow();
  });
});
