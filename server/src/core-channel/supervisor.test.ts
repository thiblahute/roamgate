import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timers } from "./channel";
import {
  channelPath,
  CoreSupervisor,
  MAX_SOCKET_PATH,
  removeStaleSockets,
} from "./supervisor";
import { spawnFake } from "./testdata/spawn-fake";
import { until } from "./testdata/test-family";

/** Real timers a hundred times faster: 10 s are 100 ms. */
const fast: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms / 100),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now() * 100,
};

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function supervisor(mode: string, spawned: string[][] = []) {
  const dir = mkdtempSync(join(tmpdir(), "core-sup-"));
  const logs: string[] = [];
  const sup = new CoreSupervisor({
    bin: "/nonexistent/roamgate",
    runtimeDir: join(dir, "runtime"),
    env: { ...process.env },
    welcome: () => ({ owners: {}, shadow: { enabled: true, rate: 0.1 } }),
    handlers: {},
    log: (level, message) => logs.push(`${level} ${message}`),
    spawn: spawnFake({ FAKE_CORE_MODE: mode }, spawned),
    timers: fast,
  });
  stops.push(async () => {
    await sup.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sup, logs, dir };
}

describe("the core's process", () => {
  test("a core that says hello is connected, in a private directory", async () => {
    const spawned: string[][] = [];
    const { sup, dir } = supervisor("ok", spawned);
    await sup.start();
    await until(() => sup.coreHello() !== null);
    expect(sup.coreHello()).toMatchObject({
      version: "fake",
      families: ["test.echo"],
    });
    expect(spawned[0]).toEqual(["/nonexistent/roamgate", "core"]);
    expect(statSync(join(dir, "runtime")).mode & 0o777).toBe(0o700);
    expect(sup.socketPath()).toBe(
      join(dir, "runtime", `core-${process.pid}.sock`),
    );
  });

  test("a core with no hello is killed and started again, ever later", async () => {
    const spawned: string[][] = [];
    const { sup, logs } = supervisor("silent", spawned);
    await sup.start();
    // Hello timeout 10 s (100 ms), then 1 s, 2 s, 4 s (10, 20, 40 ms).
    await until(() => spawned.length >= 3, 5000);
    expect(sup.channel()).toBeNull();
    expect(logs.some((line) => line.includes("no hello within 10 s"))).toBe(
      true,
    );
    expect(logs).toContain("debug starting the core again in 1000 ms");
    expect(logs).toContain("debug starting the core again in 2000 ms");
  });

  test("a crashing core is started again with a doubling delay", async () => {
    const spawned: string[][] = [];
    const { sup, logs } = supervisor("crash", spawned);
    await sup.start();
    await until(() => spawned.length >= 5, 10_000);
    expect(sup.channel()).toBeNull();
    const delays = logs
      .filter((line) => line.startsWith("debug starting the core again"))
      .map((line) => Number(/in (\d+) ms/.exec(line)![1]));
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(logs.some((line) => line.includes("exited (code 3)"))).toBe(true);
  });

  for (const [mode, reason] of [
    ["badtoken", "wrong token"],
    ["oldprotocol", "protocol 100, not 1"],
  ] as const)
    test(`a core with the ${reason} is refused`, async () => {
      const { sup, logs } = supervisor(mode);
      await sup.start();
      await until(() =>
        logs.some((line) => line.includes(`was refused (${reason})`)),
      );
      expect(sup.coreHello()).toBeNull();
    });
});

describe("where the channel listens", () => {
  test("in the runtime directory, else a private temporary one, else a pipe", () => {
    expect(channelPath("/data/runtime", 42, "linux")).toEqual({
      path: "/data/runtime/core-42.sock",
      tempDir: null,
    });
    const long = `/${"d".repeat(MAX_SOCKET_PATH)}/runtime`;
    const far = channelPath(long, 42, "linux");
    expect(far.path).toBe(join(far.tempDir!, "core.sock"));
    expect(statSync(far.tempDir!).mode & 0o777).toBe(0o700);
    rmSync(far.tempDir!, { recursive: true });
    expect(channelPath("C:\\data", 42, "win32").path).toMatch(
      /^\\\\\.\\pipe\\roamgate-core-42-[0-9a-f]{16}$/,
    );
  });

  test("sockets of processes that are gone are removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-stale-"));
    mkdirSync(dir, { recursive: true });
    const gone = 2 ** 22 + 12345;
    for (const name of [
      `core-${gone}.sock`,
      `core-${process.pid}.sock`,
      `core-${process.ppid}.sock`,
      "owners.json",
    ])
      writeFileSync(join(dir, name), "");
    removeStaleSockets(dir, process.pid);
    expect(existsSync(join(dir, `core-${gone}.sock`))).toBe(false);
    expect(existsSync(join(dir, `core-${process.pid}.sock`))).toBe(true);
    expect(existsSync(join(dir, `core-${process.ppid}.sock`))).toBe(true);
    expect(existsSync(join(dir, "owners.json"))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
