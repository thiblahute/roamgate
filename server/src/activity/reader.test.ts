import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActivityReader, eventSeq, openActivityReader } from "./reader";
import { type ActivityStore, openActivityStore } from "./store";
import { dayBounds } from "./timeline";

const MIN = 60_000;
const at = (hh: number, mm = 0) => new Date(2026, 10, 2, hh, mm).getTime();

const directories: string[] = [];
const closers: { close(): void }[] = [];
afterEach(() => {
  for (const entry of closers.splice(0)) entry.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "roamgate-activity-reader-"));
  directories.push(path);
  return join(path, "roamgate");
}

function seed(path: string): ActivityStore {
  const store = openActivityStore(path);
  closers.push(store);
  const session = store.startSession(at(8));
  store.upsertWorkspace({
    id: "ws_a",
    connectionId: "local",
    name: "alpha",
    path: "/src/alpha",
    herdrWorkspaceId: "w1",
    repoRoot: "/src/alpha",
    repoIsWorktree: false,
    seenAt: at(8),
  });
  const focus = store.append({
    ts: at(9),
    kind: "workspace.focus",
    connectionId: "local",
    session,
    workspaceId: "ws_a",
    paneId: "w1:p1",
    client: { id: "c1", kind: "desktop" },
    source: "browser",
  });
  store.append({
    ts: at(10),
    kind: "workspace.blur",
    connectionId: "local",
    session,
    workspaceId: "ws_a",
    reason: "switch",
    client: { id: "c1", kind: "desktop" },
    source: "browser",
    span: focus,
  });
  // A state from yesterday still holds this morning.
  store.append({
    ts: at(7) - 24 * 60 * MIN,
    kind: "agent.state",
    connectionId: "local",
    session,
    workspaceId: "ws_a",
    paneId: "w1:p1",
    agent: { name: "claude", state: "working", task: null, sessionId: null },
  });
  store.append({
    ts: at(9, 30),
    kind: "agent.state",
    connectionId: "local",
    session,
    workspaceId: "ws_a",
    paneId: "w1:p1",
    agent: { name: "claude", state: "idle", task: null, sessionId: null },
  });
  store.addGap("local", at(11), at(11, 5), "disconnected");
  store.alive(session, at(12));
  return store;
}

function reader(path: string, now = at(12)): ActivityReader {
  const entry = openActivityReader(path, () => now)!;
  closers.push(entry);
  return entry;
}

test("no log: no reader", () => {
  expect(openActivityReader(directory())).toBeNull();
});

test("the timeline reads spans, states before the range, and gaps", () => {
  const path = directory();
  seed(path);
  const bounds = dayBounds("2026-11-02", "00:00");
  const timeline = reader(path).timeline(
    { from: bounds.start, to: bounds.end },
    "00:00",
  );
  const [day] = timeline.days;
  expect(day!.focus).toHaveLength(1);
  expect(day!.totals.attended_ms).toBe(60 * MIN);
  const lane = day!.agents[0]!;
  // Idle until now, but not while the connection was gone.
  expect(lane.spans.map((span) => span.state)).toEqual([
    "working",
    "idle",
    "idle",
  ]);
  expect(Date.parse(lane.spans[0]!.start)).toBe(bounds.start);
  expect(day!.gaps[0]).toMatchObject({
    connection_id: "local",
    reason: "disconnected",
    excluded: false,
  });
  expect(timeline.workspaces).toEqual([
    {
      id: "ws_a",
      connection_id: "local",
      name: "alpha",
      path: "/src/alpha",
      herdr_workspace_id: "w1",
    },
  ]);
});

test("pages are in id order and resume after an id", () => {
  const path = directory();
  seed(path);
  const log = reader(path);
  const first = log.page({ limit: 2 });
  expect(first.events.map((event) => event.kind)).toEqual([
    "workspace.focus",
    "workspace.blur",
  ]);
  expect(first.events[0]!.source).toBe("browser");
  expect(first.workspaces.map((entry) => entry.id)).toEqual(["ws_a"]);
  expect(first.next_cursor).toBe(first.events[1]!.id);
  const second = log.page({
    after: eventSeq(first.next_cursor!)!,
    limit: 2,
  });
  expect(second.events.map((event) => event.kind)).toEqual([
    "agent.state",
    "agent.state",
  ]);
  // Agent states carry no source.
  expect(second.events[0]!.source).toBeUndefined();
  expect(second.next_cursor).toBeNull();
  expect(
    log.page({ limit: 10, kinds: ["agent.state"], from: at(0) }).events,
  ).toHaveLength(1);
  expect(
    log.page({ limit: 10, excludeConnections: ["local"] }).events,
  ).toHaveLength(0);
  expect(eventSeq("0000000000000042")).toBe(42);
  expect(eventSeq("x")).toBeNull();
});

test("status tells a running recorder from a stopped one", () => {
  const path = directory();
  seed(path);
  const running = reader(path, at(12, 1)).status({
    enabled: true,
    retentionDays: 90,
    from: at(0),
    to: at(12, 1),
  });
  expect(running).toMatchObject({
    recording: true,
    retention_days: 90,
    connections: [{ id: "local", state: "ready" }],
  });
  expect(running.gaps).toHaveLength(1);
  const stopped = reader(path, at(15)).status({
    enabled: true,
    retentionDays: 90,
    from: at(0),
    to: at(15),
  });
  expect(stopped.recording).toBe(false);
  expect(stopped.connections[0]!.state).toBe("disconnected");
  expect(stopped.gaps.at(-1)).toMatchObject({
    connection_id: null,
    end: null,
    reason: "recorder",
  });
});

test("a log whose recorder stopped can still be read, and is not written", () => {
  const path = directory();
  const store = seed(path);
  store.close();
  const file = join(path, "activity.sqlite");
  const log = reader(path);
  expect(log.page({ limit: 10 }).events).toHaveLength(4);
  log.close();
  expect(existsSync(file)).toBe(true);
});
