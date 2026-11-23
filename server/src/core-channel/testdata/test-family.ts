/**
 * The test family's checks (contract/wire/core-channel.md), run against
 * the fake core (index.test.ts) and the real Rust core (hybrid.test.ts).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import {
  type CoreFront,
  type CoreFrontDeps,
  type PushMessage,
  startCoreFront,
} from "..";
import type { Logger } from "../../utils/logger";
import type { SpawnCore } from "../supervisor";

export type Harness = {
  front: CoreFront;
  pushes: PushMessage[];
  warnings: string[];
  dataDir: string;
  setOwners: (table: Record<string, unknown>) => Promise<void>;
};

const silent = {
  enabled: () => true,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Waits until `check` holds, up to `ms`. */
export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

/** A core front on `bin`, test family on, given test.echo to Rust. */
export async function startHarness(
  bin: string,
  extra: Partial<CoreFrontDeps> & { spawn?: SpawnCore } = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "core-front-test-"));
  const runtime = join(dataDir, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const write = (table: Record<string, unknown>) =>
    writeFileSync(join(runtime, "owners.json"), JSON.stringify(table));
  write({ version: 1, owners: { "test.echo": "rust" } });
  const pushes: PushMessage[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    ...silent,
    warn: (message: string) => {
      warnings.push(message);
    },
    child: () => logger,
  };
  const front = startCoreFront({
    env: { ...process.env, ROAMGATE_CORE_BIN: bin, ROAMGATE_CORE_TEST: "1" },
    dataDir,
    fromSource: true,
    deliverPush: (push) => pushes.push(push),
    reverseTargets: {},
    logger,
    shadowLogger: logger,
    gameMode: async () => false,
    ...extra,
  });
  if (!front) throw new Error("no core front");
  await until(() => front.supervisor.coreHello() !== null, 20_000);
  return {
    front,
    pushes,
    warnings,
    dataDir,
    setOwners: async (table) => {
      write(table);
      const owner = (table.owners as Record<string, string>)["test.echo"];
      await until(
        () => front.routesRpc("test.echo.read") === (owner === "rust"),
      );
    },
  };
}

/** Call, push, reverse call, HTTP both ways, then shadow reads. */
export async function exerciseTestFamily(harness: Harness): Promise<void> {
  const { front, pushes } = harness;
  expect(front.supervisor.coreHello()?.families).toContain("test.echo");

  // A call, with what the front knows of it.
  expect(front.routesRpc("test.echo.read")).toBe(true);
  expect(front.routesRpc("bridge.ping")).toBe(false);
  const ctx = { connection_id: "local", socket_id: 7, lane: "interactive" };
  expect(
    await front.callRpc("test.echo.read", { a: [1, "é"] }, ctx),
  ).toMatchObject({ params: { a: [1, "é"] }, ctx });

  // Pushes with a key: at least the newest arrives, with its key.
  pushes.length = 0;
  await front.callRpc(
    "test.echo.push",
    { key: "test-echo", message: { echo: "pushed" }, count: 5 },
    ctx,
  );
  await until(() => pushes.some((push) => push.key === "test-echo"));
  const keyed = pushes.filter((push) => push.key === "test-echo");
  expect(keyed.length).toBeGreaterThanOrEqual(1);
  expect(keyed.length).toBeLessThanOrEqual(5);
  expect(keyed.at(-1)!.message).toMatchObject({ echo: "pushed" });

  // A reverse call: the core calls the front's test.echo target back.
  const reversed = (await front.callRpc(
    "test.echo.reverse",
    { back: true },
    ctx,
  )) as { args: unknown };
  expect(reversed.args).toEqual({ back: true });

  // HTTP: a body echoed back, and a download streamed.
  expect(front.routesHttp("/api/test-echo/stream")).toBe(true);
  const upload = new Uint8Array(1_500_000);
  for (let i = 0; i < upload.length; i++) upload[i] = i % 251;
  const echoed = await front.forwardHttp(
    new Request("http://front/api/test-echo/stream", {
      method: "POST",
      body: upload,
    }),
    {},
  );
  expect(echoed.status).toBe(200);
  const back = new Uint8Array(await echoed.arrayBuffer());
  expect(back.length).toBe(upload.length);
  expect(Buffer.from(back).equals(Buffer.from(upload))).toBe(true);
  const download = await front.forwardHttp(
    new Request("http://front/api/test-echo/stream?bytes=9000000"),
    {},
  );
  expect(download.status).toBe(200);
  const text = await download.text();
  expect(text.length).toBe(9_000_000);
  expect(/^x+$/.test(text)).toBe(true);

  // Shadow reads: back with Bun, every read shadowed on the core.
  await harness.setOwners({
    version: 1,
    owners: { "test.echo": "bun" },
    shadow: { enabled: true, rate: 1 },
  });
  expect(front.routesRpc("test.echo.read")).toBe(false);
  const shadowFile = join(harness.dataDir, "runtime", "shadow.jsonl");
  const same = await front.observeReply("test.echo.read", { q: 1 }, ctx, {
    id: "1",
    result: { params: { q: 1 }, ctx },
  });
  expect(same).toBe("done");
  expect(existsSync(shadowFile)).toBe(false);
  // The same method again within 5 s: not shadowed.
  const differing = await front.observeReply("test.echo.read", { q: 2 }, ctx, {
    id: "2",
    result: { params: { q: 2 }, ctx },
  });
  expect(differing).toBe("skipped");
}

/** After a shadow that differs: the line in shadow.jsonl. */
export function shadowLines(dataDir: string): Record<string, unknown>[] {
  const path = join(dataDir, "runtime", "shadow.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
