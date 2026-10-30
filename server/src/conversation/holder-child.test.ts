import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formOf } from "../review/agent-server";
import { holderStartCommand } from "./headless";
import { HOLD_CLIENT_SCRIPT } from "./holder-script";
import {
  createHolderChannel,
  type HolderChannel,
  parseHolderStatus,
} from "./pane-child";

/**
 * A stand-in for claude. Headless (-p): stream-json in and out, each user
 * message answered in a few lines, slowly, then a result; when stdin
 * closes it notes that it is gone. Otherwise (the TUI): it prints how it
 * was started and whether the headless one was gone by then.
 */
const FAKE_CLAUDE = `#!/usr/bin/env python3
import json, os, sys, time
args = sys.argv[1:]
gone = os.path.join(os.environ["HOME"], "headless-gone")
if "-p" not in args:
    print("claude " + " ".join(args) + (" after headless" if os.path.exists(gone) else " NEXT TO HEADLESS"))
    sys.exit(0)
def say(value):
    sys.stdout.write(json.dumps(value) + "\\n")
    sys.stdout.flush()
say({"type": "system", "subtype": "init", "session_id": args[args.index("--resume") + 1],
     "herdr": os.environ.get("HERDR_PANE_ID"), "key": os.environ.get("ANTHROPIC_API_KEY"),
     "marker": os.environ.get("ROAMGATE_HEADLESS"), "cwd": os.getcwd()})
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") != "user":
        say({"type": "echo", "of": message.get("type")})
        continue
    text = message["message"]["content"]
    # A long tool that prints nothing meanwhile.
    time.sleep(float(os.environ.get("FAKE_SILENT_S", "0")))
    say({"type": "user", "uuid": message.get("uuid"), "message": message["message"]})
    for index in range(int(os.environ.get("FAKE_STEPS", "3"))):
        time.sleep(float(os.environ.get("FAKE_STEP_S", "0.05")))
        say({"type": "step", "n": index, "of": text})
    say({"type": "result", "subtype": "success", "result": text})
time.sleep(0.3)
open(gone, "w").write("x")
`;

const PANE = "w1:p1";
const SESSION = "11111111-aaaa-bbbb-cccc-000000000000";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Roamgate's side of the review socket for one holder, with a real holder
 * channel behind it; `swap` replaces the channel (a new runtime) and
 * `down` makes the socket unreachable for a while (an SSH link that
 * dropped).
 */
function roamgate(dir: string, name = "r.sock") {
  const socket = join(dir, name);
  let channel: HolderChannel;
  let down = false;
  let resume: Record<string, unknown> | null = null;
  const handbacks: Record<string, string>[] = [];
  let wake: (() => void) | null = null;
  const make = (saved: ReturnType<HolderChannel["save"]> = null) =>
    createHolderChannel({
      paneId: PANE,
      saved,
      onWork: () => wake?.(),
    });
  channel = make();
  const server = Bun.serve({
    unix: socket,
    fetch: async (request) => {
      const command = new URL(request.url).pathname.replace("/v1/", "");
      const form = formOf(await request.text());
      if (down) return Response.json({ error: "not ready" }, { status: 503 });
      if (command === "hold_output")
        return Response.json(
          channel.receive({
            holderId: form.get("holder_id") ?? "",
            offset: Number(form.get("offset")),
            end: Number(form.get("end")),
            data: form.get("data") ?? "",
          }),
        );
      if (command === "handback") {
        handbacks.push(Object.fromEntries(form));
        return Response.json({ action: "refused", reason: "not now" });
      }
      const status = parseHolderStatus(form);
      if (status) channel.update(status);
      if (!resume && !channel.hasWork())
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 150);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      wake = null;
      if (resume) return Response.json(resume);
      return Response.json({
        action: "hold",
        session_id: SESSION,
        ...channel.work(),
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    socket,
    handbacks,
    channel: () => channel,
    /** A new runtime: it reads on from what the one before saved. */
    swap() {
      const saved = channel.save();
      channel.detach();
      channel = make(saved);
      return saved;
    },
    setDown(value: boolean) {
      down = value;
    },
    resume(reply: Record<string, unknown>) {
      resume = reply;
      wake?.();
    },
  };
}

function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-holdchild-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(dir, "hold.py"), HOLD_CLIENT_SCRIPT);
  const work = join(dir, "work");
  mkdirSync(work);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, work };
}

function startHolder(
  dir: string,
  bin: string,
  socket: string,
  env: Record<string, string> = {},
) {
  const child = Bun.spawn(["python3", join(dir, "hold.py"), SESSION], {
    cwd: dir,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      HERDR_PANE_ID: PANE,
      ANTHROPIC_API_KEY: "sk-should-not-pass",
      ROAMGATE_REVIEW_SOCKET: socket,
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(() => child.kill(9));
  const stdout = new Response(child.stdout).text();
  return { child, stdout };
}

/** The holders' state directories under a scratch HOME. */
function holderDirs(home: string): string[] {
  const root = join(home, ".cache", "roamgate", "headless");
  return existsSync(root)
    ? readdirSync(root).map((name) => join(root, name))
    : [];
}

/** The one holder's state directory. */
function holderDir(home: string): string {
  const dirs = holderDirs(home);
  expect(dirs).toHaveLength(1);
  return dirs[0]!;
}

function userLine(text: string) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  });
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** Reads lines until one matches (or the stream ends). */
async function readUntil(
  lines: AsyncIterator<string>,
  into: string[],
  done: (line: string) => boolean,
) {
  for (;;) {
    const next = await lines.next();
    if (next.done) return;
    into.push(next.value);
    if (done(next.value)) return;
  }
}

describe("roamgate-hold runs the headless claude", () => {
  test("starts it with the headless environment and relays a turn", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    const child = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    expect(child.pid).toBeGreaterThan(0);
    const lines = child.lines[Symbol.asyncIterator]();
    const seen: string[] = [];
    await readUntil(lines, seen, (line) => line.includes('"init"'));
    expect(JSON.parse(seen[0]!)).toMatchObject({
      session_id: SESSION,
      // Its own pane's: Herdr's hook tells Herdr the session.
      herdr: PANE,
      key: null,
      marker: "1",
      cwd: work,
    });
    child.write(userLine("hello"));
    await readUntil(lines, seen, (line) => line.includes('"result"'));
    expect(seen.filter((line) => line.includes('"step"'))).toHaveLength(3);
    // The holder notes each write just before it.
    expect(
      seen.find((line) => line.startsWith('{"type":"roamgate_input"')),
    ).toContain('"kind":"user"');
    child.end();
    expect(await child.exited).toBe(0);
  }, 20_000);

  test("a reader that goes mid-turn loses nothing; the next reads each line once", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket, { FAKE_STEPS: "12", FAKE_STEP_S: "0.1" });
    const first = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    first.write(userLine("long turn"));
    const firstLines = first.lines[Symbol.asyncIterator]();
    const read: string[] = [];
    await readUntil(firstLines, read, (line) => line.includes('"n": 2'));
    // The link drops, and the runtime goes: the turn runs on.
    rg.setDown(true);
    await Bun.sleep(400);
    const saved = rg.swap();
    expect(saved?.offset).toBeGreaterThan(0);
    rg.setDown(false);
    const second = (await rg.channel().spawn({
      command: {},
      attachOnly: true,
    }))!;
    // Replayed: all the runtime before took from the holder (it may have
    // taken a line or two its reader had not got to).
    expect(second.replayed).toBeGreaterThanOrEqual(read.length);
    const again: string[] = [];
    await readUntil(second.lines[Symbol.asyncIterator](), again, (line) =>
      line.includes('"result"'),
    );
    // The replayed head is what was read; the rest follows once each.
    expect(again.slice(0, read.length)).toEqual(read);
    const steps = again
      .filter((line) => line.includes('"step"'))
      .map((line) => JSON.parse(line).n as number);
    expect(steps).toEqual([...Array(12).keys()]);
    expect(again.at(-1)).toContain('"result"');
    expect(again.filter((line) => line.includes('"result"'))).toHaveLength(1);
    second.end();
    expect(await second.exited).toBe(0);
  }, 30_000);

  test("an input sent twice (its answer lost) reaches claude once", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    const child = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    // Unconfirmed when the runtime goes: the next sends it again.
    child.write(userLine("once"));
    const saved = rg.swap()!;
    expect(saved.pending?.length ?? 0).toBeLessThanOrEqual(1);
    const again = (await rg.channel().spawn({
      command: {},
      attachOnly: true,
    }))!;
    const seen: string[] = [];
    await readUntil(again.lines[Symbol.asyncIterator](), seen, (line) =>
      line.includes('"result"'),
    );
    again.end();
    await again.exited;
    const log = readFileSync(join(holderDir(dir), "out.jsonl"), "utf8");
    expect(log.match(/"type": "user"/g)).toHaveLength(1);
  }, 20_000);

  test("handing back ends its child first, then resumes claude: never both", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    const { child: holder, stdout } = startHolder(dir, bin, rg.socket);
    const child = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    child.write(userLine("hi"));
    await Bun.sleep(300);
    // Told to resume while its child still runs (Roamgate lost track):
    // the holder closes the child's stdin and waits for it.
    rg.resume({ action: "resume", session_id: SESSION, cwd: work });
    expect(await holder.exited).toBe(0);
    const out = await stdout;
    expect(out).toContain(`claude --resume ${SESSION} after headless`);
    expect(out).not.toContain("NEXT TO HEADLESS");
    expect(holderDirs(dir)).toEqual([]);
  }, 20_000);

  test("Roamgate away, Enter does not resume while its child runs", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    const { child: holder, stdout } = startHolder(dir, bin, rg.socket);
    (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    rg.setDown(true);
    holder.stdin.write("\n");
    holder.stdin.flush();
    await Bun.sleep(1500);
    holder.kill();
    const out = await stdout;
    expect(out).toContain("the conversation process still runs here");
    expect(out).not.toContain("Resuming");
  }, 20_000);

  test("an idle child runs on with nobody reading", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    const child = (await rg.channel().spawn({
      // An older Roamgate's idle time is ignored.
      command: {
        ...holderStartCommand({ sessionId: SESSION, cwd: work }),
        idle_ms: 1,
      },
    }))!;
    rg.setDown(true);
    await Bun.sleep(2500);
    rg.setDown(false);
    expect(existsSync(join(dir, "headless-gone"))).toBe(false);
    child.end();
    expect(await child.exited).toBe(0);
  }, 20_000);

  test("holders on one session keep their own logs", async () => {
    const { dir, bin, work } = scratch();
    const first = roamgate(dir);
    startHolder(dir, bin, first.socket);
    const child = (await first.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    const lines = child.lines[Symbol.asyncIterator]();
    // Another pane holds the same session (resumed there after a /clear
    // here), and hands it back.
    const second = roamgate(dir, "r2.sock");
    const { child: other } = startHolder(dir, bin, second.socket);
    await until(() => holderDirs(dir).length === 2);
    second.resume({ action: "resume", session_id: SESSION, cwd: work });
    expect(await other.exited).toBe(0);
    expect(holderDirs(dir)).toHaveLength(1);
    // The first holder's log is whole and still read.
    const seen: string[] = [];
    child.write(userLine("still here"));
    await readUntil(lines, seen, (line) => line.includes('"result"'));
    expect(seen.some((line) => line.includes('"init"'))).toBe(true);
    expect(seen.at(-1)).toContain("still here");
    child.end();
    expect(await child.exited).toBe(0);
  }, 20_000);

  test("a holder killed outright takes its child with it", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    const { child: holder } = startHolder(dir, bin, rg.socket, {
      FAKE_SILENT_S: "30",
    });
    const child = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    child.write(userLine("long silent tool"));
    await Bun.sleep(300);
    const pid = child.pid!;
    expect(() => process.kill(pid, 0)).not.toThrow();
    holder.kill(9);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
  }, 20_000);

  for (const signal of ["SIGHUP", "SIGTERM"] as const)
    test(`a pane that closes (${signal}) takes its child and log with it`, async () => {
      const { dir, bin, work } = scratch();
      const rg = roamgate(dir);
      const { child: holder } = startHolder(dir, bin, rg.socket, {
        FAKE_SILENT_S: "30",
      });
      const child = (await rg.channel().spawn({
        command: holderStartCommand({ sessionId: SESSION, cwd: work }),
      }))!;
      child.write(userLine("long silent tool"));
      await Bun.sleep(300);
      const pid = child.pid!;
      expect(existsSync(join(holderDir(dir), "out.jsonl"))).toBe(true);
      holder.kill(signal);
      await holder.exited;
      expect(holderDirs(dir)).toEqual([]);
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 5000);
    }, 20_000);

  test("Roamgate away, Enter twice ends its child and resumes claude", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    const { child: holder, stdout } = startHolder(dir, bin, rg.socket);
    (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    rg.setDown(true);
    holder.stdin.write("\n");
    holder.stdin.flush();
    await Bun.sleep(500);
    holder.stdin.write("\n");
    holder.stdin.flush();
    expect(await holder.exited).toBe(0);
    const out = await stdout;
    expect(out).toContain("Press Enter again");
    expect(out).toContain(`claude --resume ${SESSION} after headless`);
    expect(out).not.toContain("NEXT TO HEADLESS");
  }, 20_000);
});
