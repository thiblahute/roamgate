import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeModError, createClaudeModHub } from "./claude-mod";
import { type ClaudeModMirror, createClaudeModFront } from "./claude-mod-front";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const POLL = {
  connectionId: "local",
  paneId: "w1-2",
  sessionId: "11111111-2222",
  client: "c1",
  claude: "2.1.319",
  protocol: 1,
  after: 0,
  waitMs: 0,
};

function front() {
  const dir = mkdtempSync(join(tmpdir(), "claude-mod-front-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = 1_000_000;
  const handed: string[] = [];
  const made = createClaudeModFront({
    make: () =>
      createClaudeModHub({
        file: join(dir, "claude-mod-inbox.json"),
        now: () => at,
        sweepMs: 3_600_000,
      }),
    deliverOnCore: (connectionId, paneId, text, kind) =>
      handed.push(`${connectionId}/${paneId} ${kind}: ${text}`),
    now: () => at,
  });
  cleanups.push(() => made.dispose());
  return {
    front: made,
    handed,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function mirror(waiting = 0, liveUntil: number | null = null): ClaudeModMirror {
  return {
    mods: [
      {
        gone: false,
        live_until: liveUntil,
        pane: {
          connection_id: "local",
          pane_id: "w1-2",
          session_id: "11111111-2222",
          claude: "2.1.319",
          protocol: 1,
          status: "idle",
          waiting,
          held: 0,
          since: "1970-01-01T00:16:40.000Z",
          updated_at: "1970-01-01T00:16:40.000Z",
        },
      },
    ],
    tools: [
      {
        connection_id: "local",
        pane_id: "w1-2",
        fresh_until: 1_000_000 + 600_000,
        work: true,
        rules: false,
      },
    ],
  };
}

test("Bun's own hub answers while it runs in Bun", async () => {
  const { front: f, handed } = front();
  expect(f.onCore()).toBe(false);
  await f.poll(POLL);
  expect(f.live("local", "w1-2")).toBe(true);
  expect(f.deliver("local", "w1-2", "hello", "message")).toEqual({ id: 1 });
  expect(handed).toEqual([]);
});

test("the inbox goes to the core through its file, and comes back from it", async () => {
  const { front: f } = front();
  await f.poll(POLL);
  f.deliver("local", "w1-2", "kept", "message");
  f.toCore();
  expect(f.onCore()).toBe(true);
  // What Bun had is on disk: a hub reading the file again has it.
  f.toBun();
  expect(f.waiting("local", "w1-2")).toBe(1);
});

test("while the core runs it, the mirror answers and deliveries go to the core", async () => {
  const { front: f, handed, advance } = front();
  f.toCore();
  expect(f.deliver("local", "w1-2", "hello")).toBeNull();
  f.mirror(mirror(0, 1_000_000 + 45_000));
  expect(f.live("local", "w1-2")).toBe(true);
  expect(f.pane("local", "w1-2")?.session_id).toBe("11111111-2222");
  expect(f.panes("local")).toHaveLength(1);
  expect(f.hasTools("local", "w1-2")).toBe(true);
  expect(f.hasWorkTools("local", "w1-2")).toBe(true);
  expect(f.hasRules("local", "w1-2")).toBe(false);
  const delivered = f.deliver("local", "w1-2", "hello", "companion");
  expect(delivered?.id).toBeLessThan(0);
  expect(handed).toEqual(["local/w1-2 companion: hello"]);
  // Counted until the core's next mirror.
  expect(f.waiting("local", "w1-2")).toBe(1);
  expect(f.deliver("local", "w1-2", "   ")).toBeNull();
  // Live and the tools age as the hub's would.
  advance(46_000);
  expect(f.live("local", "w1-2")).toBe(false);
  expect(f.deliver("local", "w1-2", "late")).toBeNull();
  advance(600_000);
  expect(f.hasTools("local", "w1-2")).toBe(false);
  expect(f.toolsState()).toEqual([]);
});

test("a full inbox refuses at once, as the hub does", () => {
  const { front: f, handed } = front();
  f.toCore();
  f.mirror(mirror(50));
  expect(() => f.deliver("local", "w1-2", "one more")).toThrow(ClaudeModError);
  expect(handed).toEqual([]);
});

test("a mod's own requests are the core's while it runs the hub", async () => {
  const { front: f } = front();
  f.toCore();
  await expect(f.poll(POLL)).rejects.toThrow("Rust core");
});
