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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formOf, REVIEW_AGENT_MAX_BODY_BYTES } from "../review/agent-server";
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
 * closes it notes that it is gone. Of an API key it says only the end. Otherwise (the TUI): it prints how it
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
     "herdr": os.environ.get("HERDR_PANE_ID"), "pane": os.environ.get("ROAMGATE_PANE_ID"),
     "herdr_socket": os.environ.get("ROAMGATE_HERDR_SOCKET_PATH"), "key": (os.environ.get("ANTHROPIC_API_KEY") or "")[-8:] or None,
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
    # A tool result with screenshots: one line past a megabyte.
    if os.environ.get("FAKE_BIG"):
        say({"type": "big", "text": os.environ["FAKE_BIG"] * 200000})
    for index in range(int(os.environ.get("FAKE_STEPS", "3"))):
        time.sleep(float(os.environ.get("FAKE_STEP_S", "0.05")))
        say({"type": "step", "n": index, "of": text})
    say({"type": "result", "subtype": "success", "result": text})
time.sleep(0.3)
open(gone, "w").write("x")
`;

const PANE = "w1:p1";
// The pane's API key, unless a test gives another. Never sent anywhere.
const PANE_KEY = "sk-ant-api03-should-not-pass-0123456789abcdefghij";
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
  // The largest log chunk the holder sent, in bytes.
  let largest = 0;
  let wake: (() => void) | null = null;
  // Every request the holder made, as sent.
  const bodies: string[] = [];
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
      const body = await request.text();
      bodies.push(body);
      // The agent socket's limit: a log chunk must fit it.
      if (Buffer.byteLength(body) > REVIEW_AGENT_MAX_BODY_BYTES)
        return Response.json({ error: "too large" }, { status: 413 });
      if (command === "hold_output")
        largest = Math.max(largest, Buffer.byteLength(body));
      const form = formOf(body);
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
    bodies,
    largest: () => largest,
    channel: () => channel,
    /** A new runtime: it reads on from what the one before saved. */
    swap(resume?: NonNullable<ReturnType<HolderChannel["save"]>>["resume"]) {
      const read = channel.save();
      const saved = read && resume ? { ...read, resume } : read;
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
  // The session has a transcript: it is resumed (none: started anew).
  mkdirSync(join(dir, ".claude", "projects", "elsewhere"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "projects", "elsewhere", `${SESSION}.jsonl`),
    "{}\n",
  );
  // The pane's API key (startHolder's) was turned down in Claude Code.
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      customApiKeyResponses: { approved: [], rejected: [PANE_KEY.slice(-20)] },
    }),
  );
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
      ANTHROPIC_API_KEY: PANE_KEY,
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
    startHolder(dir, bin, rg.socket, {
      HERDR_SOCKET_PATH: "/run/herdr.sock",
    });
    const child = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    expect(child.pid).toBeGreaterThan(0);
    const lines = child.lines[Symbol.asyncIterator]();
    const seen: string[] = [];
    await readUntil(lines, seen, (line) => line.includes('"init"'));
    expect(JSON.parse(seen[0]!)).toMatchObject({
      session_id: SESSION,
      // Not its pane's: Herdr's hook must not claim the pane.
      herdr: null,
      // Under Roamgate's names: the review client tells its pane.
      pane: PANE,
      herdr_socket: "/run/herdr.sock",
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

  test("a reader with a saved state takes the lines after it only, each once", async () => {
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
    // Asking for the next line marks the last one handled.
    const pending = firstLines.next();
    await Bun.sleep(0);
    const position = first.position!()!;
    expect(position.offset).toBeGreaterThan(position.epoch_offset);
    rg.setDown(true);
    await Bun.sleep(400);
    rg.swap({ ...position, state: { handled: read.length } });
    void pending;
    rg.setDown(false);
    const second = (await rg.channel().spawn({
      command: {},
      attachOnly: true,
    }))!;
    expect(second.replayed).toBe(0);
    expect(second.resume).toEqual({ handled: read.length });
    const again: string[] = [];
    await readUntil(second.lines[Symbol.asyncIterator](), again, (line) =>
      line.includes('"result"'),
    );
    // Nothing handled before comes again; every later step comes once.
    const steps = [...read, ...again]
      .filter((line) => line.includes('"step"'))
      .map((line) => JSON.parse(line).n as number);
    expect(steps).toEqual([...Array(12).keys()]);
    expect(again.filter((line) => line.includes('"result"'))).toHaveLength(1);
    second.end();
    expect(await second.exited).toBe(0);
  }, 30_000);

  test("a line past the socket's limit comes through, in pieces", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    // Characters of 1 to 4 bytes, so pieces are cut between them.
    startHolder(dir, bin, rg.socket, { FAKE_BIG: "aé€😀", FAKE_STEPS: "1" });
    const child = (await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    }))!;
    const lines = child.lines[Symbol.asyncIterator]();
    const seen: string[] = [];
    await readUntil(lines, seen, (line) => line.includes('"init"'));
    child.write(userLine("screenshot"));
    await readUntil(lines, seen, (line) => line.includes('"result"'));
    const big = seen.find((line) => line.startsWith('{"type": "big"'))!;
    expect(JSON.parse(big).text).toBe("aé€😀".repeat(200_000));
    expect(Buffer.byteLength(big)).toBeGreaterThan(REVIEW_AGENT_MAX_BODY_BYTES);
    // Every chunk fit the socket's limit.
    expect(rg.largest()).toBeLessThan(REVIEW_AGENT_MAX_BODY_BYTES);
    child.end();
    expect(await child.exited).toBe(0);
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

describe("roamgate-hold and the pane's Anthropic API key", () => {
  const SUFFIX = PANE_KEY.slice(-20);

  /** The key the headless claude got, from its init line. */
  async function startedKey(
    child: Awaited<ReturnType<HolderChannel["spawn"]>>,
  ) {
    const seen: string[] = [];
    await readUntil(child!.lines[Symbol.asyncIterator](), seen, (line) =>
      line.includes('"init"'),
    );
    child!.end();
    await child!.exited;
    return JSON.parse(seen.at(-1)!).key as string | null;
  }

  /** What the fake says of the pane's key: its last 8 characters. */
  function told(key: string | null) {
    return key ? key.slice(-8) : null;
  }

  /** The key appears in nothing the holder sent Roamgate. */
  function neverSent(rg: ReturnType<typeof roamgate>, key = PANE_KEY) {
    expect(rg.bodies.length).toBeGreaterThan(0);
    for (const body of rg.bodies) expect(body).not.toContain(key);
  }

  test("approved in Claude Code: the headless claude keeps it", async () => {
    const { dir, bin, work } = scratch();
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ customApiKeyResponses: { approved: [SUFFIX] } }),
    );
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    const child = await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    });
    expect(rg.channel().status()?.apiKey).toBe("approved");
    expect(await startedKey(child)).toBe(told(PANE_KEY));
    neverSent(rg);
  }, 20_000);

  test("rejected in Claude Code: it is dropped", async () => {
    const { dir, bin, work } = scratch();
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    const child = await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    });
    expect(rg.channel().status()?.apiKey).toBe("rejected");
    expect(await startedKey(child)).toBeNull();
    neverSent(rg);
  }, 20_000);

  test("no key in the pane: nothing to ask, nothing written", async () => {
    const { dir, bin, work } = scratch();
    rmSync(join(dir, ".claude.json"));
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket, { ANTHROPIC_API_KEY: "" });
    const child = await rg.channel().spawn({
      command: holderStartCommand({ sessionId: SESSION, cwd: work }),
    });
    expect(rg.channel().status()?.apiKey).toBe("none");
    expect(await startedKey(child)).toBeNull();
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
  }, 20_000);

  test("not answered yet: it says so, and starts nothing without an answer", async () => {
    const { dir, bin, work } = scratch();
    rmSync(join(dir, ".claude.json"));
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    await expect(
      rg.channel().spawn({
        command: holderStartCommand({ sessionId: SESSION, cwd: work }),
      }),
    ).rejects.toThrow("the API key question is not answered yet");
    expect(rg.channel().status()?.apiKey).toBe("new");
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
    neverSent(rg);
  }, 20_000);

  for (const [answer, list, kept] of [
    ["approve", "approved", true],
    ["reject", "rejected", false],
  ] as const)
    test(`the user's answer (${answer}) is filed as Claude Code files it, the rest of its config kept, and used`, async () => {
      const { dir, bin, work } = scratch();
      const config = join(dir, ".claude.json");
      const before = {
        numStartups: 42,
        theme: "dark",
        projects: {
          "/w": { allowedTools: ["Bash"], hasTrustDialogAccepted: true },
        },
        oauthAccount: { emailAddress: "me@example.com" },
        customApiKeyResponses: {
          approved: ["aaaaaaaaaaaaaaaaaaaa"],
          rejected: ["bbbbbbbbbbbbbbbbbbbb"],
        },
        "unicode é": "✓",
      };
      writeFileSync(config, JSON.stringify(before), { mode: 0o600 });
      chmodSync(config, 0o600);
      const rg = roamgate(dir);
      startHolder(dir, bin, rg.socket);
      const child = await rg.channel().spawn({
        command: holderStartCommand({
          sessionId: SESSION,
          cwd: work,
          apiKeyAnswer: answer,
        }),
      });
      expect(await startedKey(child)).toBe(told(kept ? PANE_KEY : null));
      const after = JSON.parse(readFileSync(config, "utf8"));
      expect(after).toEqual({
        ...before,
        customApiKeyResponses: {
          ...before.customApiKeyResponses,
          [list]: [...before.customApiKeyResponses[list], SUFFIX],
        },
      });
      // Written whole, in place of the old one: no temporary file or lock
      // left beside it, and only the user may read it, as before.
      expect(
        readdirSync(dir).filter((name) => name.startsWith(".claude.json")),
      ).toEqual([".claude.json"]);
      expect(statSync(config).mode & 0o777).toBe(0o600);
      // The holder reports it as answered from now on.
      await until(() => rg.channel().status()?.apiKey === list);
      expect(readFileSync(config, "utf8")).not.toContain(PANE_KEY);
      neverSent(rg);
    }, 20_000);

  test("a host's own config directory ($CLAUDE_CONFIG_DIR) is the one read and written", async () => {
    const { dir, bin, work } = scratch();
    rmSync(join(dir, ".claude.json"));
    const configDir = join(dir, "remote-claude");
    mkdirSync(configDir);
    // The session's transcript lives in that directory too.
    mkdirSync(join(configDir, "projects", "elsewhere"), { recursive: true });
    writeFileSync(
      join(configDir, "projects", "elsewhere", `${SESSION}.jsonl`),
      "{}\n",
    );
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify({ userID: "x" }),
    );
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket, { CLAUDE_CONFIG_DIR: configDir });
    await until(() => rg.channel().status()?.apiKey === "new");
    const child = await rg.channel().spawn({
      command: holderStartCommand({
        sessionId: SESSION,
        cwd: work,
        apiKeyAnswer: "reject",
      }),
    });
    expect(await startedKey(child)).toBeNull();
    expect(
      JSON.parse(readFileSync(join(configDir, ".claude.json"), "utf8")),
    ).toEqual({
      userID: "x",
      customApiKeyResponses: { rejected: [SUFFIX] },
    });
    // The home directory's is left alone.
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
  }, 20_000);

  test("an answer Claude Code filed meanwhile (in a terminal) stands: nothing is written", async () => {
    const { dir, bin, work } = scratch();
    const config = join(dir, ".claude.json");
    const text = JSON.stringify({
      customApiKeyResponses: { approved: [SUFFIX] },
    });
    writeFileSync(config, text);
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    const child = await rg.channel().spawn({
      command: holderStartCommand({
        sessionId: SESSION,
        cwd: work,
        apiKeyAnswer: "approve",
      }),
    });
    expect(await startedKey(child)).toBe(told(PANE_KEY));
    expect(readFileSync(config, "utf8")).toBe(text);
  }, 20_000);

  test("a config it cannot read is left as it is; the answer still holds for this start", async () => {
    const { dir, bin, work } = scratch();
    const config = join(dir, ".claude.json");
    writeFileSync(config, "{ not json");
    const rg = roamgate(dir);
    startHolder(dir, bin, rg.socket);
    await until(() => rg.channel().status()?.apiKey === "new");
    const child = await rg.channel().spawn({
      command: holderStartCommand({
        sessionId: SESSION,
        cwd: work,
        apiKeyAnswer: "reject",
      }),
    });
    expect(await startedKey(child)).toBeNull();
    expect(readFileSync(config, "utf8")).toBe("{ not json");
  }, 20_000);
});
