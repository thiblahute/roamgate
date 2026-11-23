import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeThreadSpawns,
  spawnOffLoop,
  threadText,
  useSpawnThread,
} from "./spawn-thread";

// Other tests run commands on the event loop (see useSpawnThread).
beforeAll(() => useSpawnThread(true));
afterAll(() => useSpawnThread(false));

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("spawns from its own thread, never through the event loop's Bun.spawn", async () => {
  // The event loop's spawn stat-walks PATH and vforks on this thread: a
  // FUSE /usr on a busy disk stalled every call for seconds.
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("spawned on the event loop");
  });
  spies.push(spawn);
  const proc = spawnOffLoop(["sh", "-c", "printf out; printf err >&2; exit 3"]);
  expect(await proc.exited).toBe(3);
  expect(await threadText(proc.stdout)).toBe("out");
  expect(await threadText(proc.stderr)).toBe("err");
  expect(await proc.pid).toBeGreaterThan(0);
  expect(spawn).not.toHaveBeenCalled();
});

test("gives the command its directory, environment and input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roamgate-spawn-thread-"));
  try {
    const proc = spawnOffLoop(
      ["sh", "-c", 'pwd; printf %s "$ROAMGATE_TEST_VALUE"; cat'],
      {
        cwd: directory,
        env: { ...process.env, ROAMGATE_TEST_VALUE: "value '\"$" },
        stdin: "from stdin",
      },
    );
    expect(await threadText(proc.stdout)).toBe(
      `${await realpath(directory)}\nvalue '"$from stdin`,
    );
    expect(await proc.exited).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("kills a command, and fails one that cannot start", async () => {
  const sleeping = spawnOffLoop(["sleep", "30"]);
  await sleeping.pid;
  sleeping.kill();
  expect(await sleeping.exited).toBe(143);

  const missing = spawnOffLoop(["roamgate-no-such-command-for-test"]);
  const error = (await missing.exited.catch((e) => e)) as NodeJS.ErrnoException;
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("ENOENT");
  expect(await missing.stdout.catch(() => "rejected")).toBe("rejected");
});

test("tells its observers of each command, as the recorder hears Bun.spawn's", async () => {
  const seen: unknown[] = [];
  const stop = observeThreadSpawns({
    started: (argv, cwd, pid) => seen.push(["start", argv, cwd, pid > 0]),
    exited: (argv, pid, code, ms) =>
      seen.push(["exit", argv, pid > 0, code, ms >= 0]),
  });
  try {
    const proc = spawnOffLoop(["sh", "-c", "exit 0"], { cwd: tmpdir() });
    await proc.exited;
  } finally {
    stop();
  }
  expect(seen).toEqual([
    ["start", ["sh", "-c", "exit 0"], tmpdir(), true],
    ["exit", ["sh", "-c", "exit 0"], true, 0, true],
  ]);
});
