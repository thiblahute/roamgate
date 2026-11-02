import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openActivityStore } from "../activity/store";
import { createActivityCommand, formatDuration } from "./activity";
import { runCli } from "./index";
import { createTestCli, type TestCli } from "./test-context";

const MIN = 60_000;
const at = (hh: number, mm = 0) => new Date(2026, 10, 2, hh, mm).getTime();
const clis: TestCli[] = [];
afterEach(() => {
  for (const cli of clis.splice(0)) cli.cleanup();
});

function setup(activity: Record<string, unknown> = { enabled: true }) {
  const cli = createTestCli();
  clis.push(cli);
  const directory = join(cli.home, ".config", "roamgate");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({ version: 1, activity }),
  );
  return { cli, directory };
}

function seed(directory: string) {
  const store = openActivityStore(directory);
  const session = store.startSession(at(8));
  for (const [id, connectionId, name] of [
    ["ws_a", "local", "alpha"],
    ["ws_b", "work", "beta"],
  ] as const)
    store.upsertWorkspace({
      id,
      connectionId,
      name,
      path: `/src/${name}`,
      herdrWorkspaceId: null,
      repoRoot: null,
      repoIsWorktree: null,
      seenAt: at(8),
    });
  for (const [start, end, workspaceId, connectionId] of [
    [at(9), at(10, 30), "ws_a", "local"],
    [at(11), at(11, 20), "ws_b", "work"],
  ] as const) {
    const span = store.append({
      ts: start,
      kind: "workspace.focus",
      connectionId,
      session,
      workspaceId,
      client: { id: "c1", kind: "desktop" },
      source: "browser",
    });
    store.append({
      ts: end,
      kind: "workspace.blur",
      connectionId,
      session,
      workspaceId,
      reason: "switch",
      client: { id: "c1", kind: "desktop" },
      source: "browser",
      span,
    });
  }
  store.append({
    ts: at(9),
    kind: "agent.state",
    connectionId: "local",
    session,
    workspaceId: "ws_a",
    paneId: "p1",
    agent: { name: "claude", state: "working", task: null, sessionId: null },
  });
  store.append({
    ts: at(10),
    kind: "agent.state",
    connectionId: "local",
    session,
    workspaceId: "ws_a",
    paneId: "p1",
    agent: { name: "claude", state: "idle", task: null, sessionId: null },
  });
  store.alive(session, at(12));
  store.close();
}

async function run(cli: TestCli, ...args: string[]) {
  const command = createActivityCommand({ now: () => at(12, 1) });
  return runCli(["activity", ...args], cli.context, [command]);
}

test("durations read as hours and minutes", () => {
  expect(formatDuration(5 * MIN)).toBe("5m");
  expect(formatDuration(90 * MIN)).toBe("1h30m");
  expect(formatDuration(120 * MIN)).toBe("2h");
});

test("today prints attended and agent time per workspace", async () => {
  const { cli, directory } = setup();
  seed(directory);
  expect(await run(cli, "today")).toBe(0);
  const text = cli.output.join("\n");
  expect(text).toContain("2026-11-02  attended 1h50m");
  expect(text).toMatch(/alpha\s+1h30m\s+-\s+1h\s+-/);
  expect(text).toMatch(/beta\s+20m/);
});

test("excluded connections are left out; --json gives the timeline", async () => {
  const { cli, directory } = setup({
    enabled: true,
    exclude: { connections: ["work"] },
  });
  seed(directory);
  expect(await run(cli, "day", "2026-11-02", "--json")).toBe(0);
  const timeline = JSON.parse(cli.output.join("\n"));
  expect(timeline.days[0].totals.attended_ms).toBe(90 * MIN);
  expect(timeline.workspaces.map((entry: { id: string }) => entry.id)).toEqual([
    "ws_a",
  ]);
});

test("events page in id order and resume after an id", async () => {
  const { cli, directory } = setup();
  seed(directory);
  expect(await run(cli, "events", "--limit", "3", "--json")).toBe(0);
  const page = JSON.parse(cli.output.join("\n"));
  expect(page.events).toHaveLength(3);
  expect(page.next_cursor).toBe(page.events[2].id);
  cli.output.length = 0;
  expect(
    await run(cli, "events", "--after", page.next_cursor, "--ndjson"),
  ).toBe(0);
  const rest = cli.output.map((line) => JSON.parse(line));
  expect(rest.map((event) => event.kind)).toEqual([
    "workspace.blur",
    "agent.state",
    "agent.state",
  ]);
  expect(rest[1].source).toBeUndefined();
});

test("status reports the recorder and the connections", async () => {
  const { cli, directory } = setup();
  seed(directory);
  expect(await run(cli, "status", "--json")).toBe(0);
  const status = JSON.parse(cli.output.join("\n"));
  expect(status).toMatchObject({
    recording: true,
    retention_days: 90,
    connections: [
      { id: "local", state: "ready" },
      { id: "work", state: "ready" },
    ],
  });
});

test("errors: usage, a missing log, JSON errors for JSON readers", async () => {
  const { cli } = setup();
  expect(await run(cli, "today")).toBe(1);
  expect(cli.errors.join("\n")).toContain("no activity log");
  expect(await run(cli, "day")).toBe(2);
  cli.errors.length = 0;
  expect(await run(cli, "events", "--after", "x", "--json")).toBe(2);
  expect(JSON.parse(cli.errors[0]!)).toEqual({
    error: "--after must be an event id",
  });
  expect(await run(cli, "status", "--json")).toBe(0);
  expect(JSON.parse(cli.output.join("\n")).recording).toBe(false);
});
