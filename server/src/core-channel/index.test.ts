import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bunOwns, sessionIdOf, socketIdOf, startCoreFront } from ".";
import { spawnFake } from "./testdata/spawn-fake";
import {
  exerciseTestFamily,
  type Harness,
  shadowLines,
  startHarness,
  until,
} from "./testdata/test-family";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.front.stop();
    rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

async function harness(extra: Record<string, string> = {}) {
  const started = await startHarness("/nonexistent/roamgate", {
    spawn: spawnFake(extra),
  });
  harnesses.push(started);
  return started;
}

describe("without ROAMGATE_CORE_BIN", () => {
  test("there is no core front at all", () => {
    for (const value of [undefined, ""])
      expect(
        startCoreFront({
          env: { ROAMGATE_CORE_BIN: value },
          dataDir: "/nonexistent",
          fromSource: true,
          deliverPush: () => {},
          reverseTargets: {},
        }),
      ).toBeNull();
    expect(bunOwns("test.echo")).toBe(true);
  });
});

describe("with a core", () => {
  test("the test family goes through the channel", async () => {
    const h = await harness();
    await exerciseTestFamily(h);
    expect(shadowLines(h.dataDir)).toEqual([]);
  });

  test("the core gets the owners table in its welcome and on each change", async () => {
    const h = await harness();
    await until(() =>
      h.pushes.some((push) => push.message.fake_core === "welcome"),
    );
    expect(
      h.pushes.find((push) => push.message.fake_core === "welcome")!.message
        .owners,
    ).toEqual({ "test.echo": "rust" });
    expect(bunOwns("test.echo")).toBe(false);
    await h.setOwners({ version: 1, owners: {} });
    await until(() =>
      h.pushes.some((push) => push.message.fake_core === "owner"),
    );
    expect(bunOwns("test.echo")).toBe(true);
  });

  test("a shadow that differs is logged and written down", async () => {
    const h = await harness();
    await h.setOwners({
      version: 1,
      owners: {},
      shadow: { enabled: true, rate: 1 },
    });
    expect(
      await h.front.observeReply(
        "test.echo.read",
        { q: 1 },
        {},
        { id: "1", result: { params: { q: 2 }, ctx: {}, more: 1 } },
      ),
    ).toBe("done");
    const lines = shadowLines(h.dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      method: "test.echo.read",
      family: "test.echo",
      owner: "bun",
      diffs: [
        { path: "$.params.q", kind: "value" },
        { path: "$.more", kind: "missing" },
      ],
      truncated: false,
    });
    expect(
      h.warnings.some((line) =>
        line.startsWith("test.echo.read on rust 2 difference(s)"),
      ),
    ).toBe(true);
    // Errors are not shadowed, nor methods that are no shadowed read.
    expect(
      h.front.observeReply("test.echo.read", {}, {}, { id: "2", error: {} }),
    ).toBeUndefined();
    expect(
      h.front.observeReply("test.echo.push", {}, {}, { id: "3", result: 1 }),
    ).toBeUndefined();
  });

  test("a family Rust is given comes back to Bun while the core is down", async () => {
    const h = await harness();
    expect(h.front.routesRpc("test.echo.read")).toBe(true);
    const child = h.front.supervisor;
    // Kill the fake core: until it is back, Bun serves.
    const pid = child.coreHello()!.pid!;
    process.kill(pid, "SIGKILL");
    await until(() => !h.front.routesRpc("test.echo.read"));
    expect(bunOwns("test.echo")).toBe(true);
    // It comes back after a second.
    await until(() => h.front.routesRpc("test.echo.read"), 10_000);
  });

  test("stopping says bye, ends the core and removes the socket", async () => {
    const h = harnesses.pop() ?? (await harness());
    const runtime = join(h.dataDir, "runtime");
    expect(readdirSync(runtime).some((name) => name.endsWith(".sock"))).toBe(
      true,
    );
    await h.front.stop();
    expect(readdirSync(runtime).some((name) => name.endsWith(".sock"))).toBe(
      false,
    );
    expect(h.front.routesRpc("test.echo.read")).toBe(false);
    rmSync(h.dataDir, { recursive: true, force: true });
  });
});

test("ids of sockets and sessions", () => {
  const a = {};
  const b = {};
  expect(socketIdOf(a)).toBe(socketIdOf(a));
  expect(socketIdOf(a)).not.toBe(socketIdOf(b));
  expect(sessionIdOf(null)).toBeUndefined();
  expect(sessionIdOf("token")).toBe(
    new Bun.CryptoHasher("sha256").update("token").digest("hex").slice(0, 16),
  );
  expect(sessionIdOf("token")).toHaveLength(16);
});
