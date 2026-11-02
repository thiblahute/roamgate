import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventId, isoTime } from "./protocol";
import { type ActivityStore, openActivityStore } from "./store";

const directories: string[] = [];
const stores: ActivityStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "roamgate-activity-store-"));
  directories.push(path);
  return join(path, "roamgate");
}

function open(path: string) {
  const store = openActivityStore(path);
  stores.push(store);
  return store;
}

function agentEvent(ts: number) {
  return {
    ts,
    kind: "agent.state" as const,
    connectionId: "local",
    session: 1,
    agent: {
      name: "claude",
      state: "working" as const,
      task: null,
      sessionId: null,
    },
  };
}

test("the log is a private WAL database with incremental vacuum", () => {
  const path = directory();
  const store = open(path);
  store.append(agentEvent(1));
  const file = join(path, "activity.sqlite");
  expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
  const db = new Database(file, { readonly: true });
  try {
    expect(
      db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
        ?.journal_mode,
    ).toBe("wal");
    // 2: incremental.
    expect(
      db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()
        ?.auto_vacuum,
    ).toBe(2);
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(1);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["connection_gaps", "events", "recorder_sessions", "workspaces"]);
  } finally {
    db.close();
  }
});

test("a database from a newer Roamgate is refused", () => {
  const path = directory();
  open(path).close();
  const db = new Database(join(path, "activity.sqlite"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  expect(() => openActivityStore(path)).toThrow(
    "Unsupported activity database",
  );
});

test("a symlinked log is refused", () => {
  const path = directory();
  mkdirSync(path, { recursive: true });
  const target = join(path, "elsewhere");
  writeFileSync(target, "");
  symlinkSync(target, join(path, "activity.sqlite"));
  expect(() => openActivityStore(path)).toThrow("symlink");
});

test("event ids keep their order across reopening and deletion", () => {
  const path = directory();
  const store = open(path);
  const first = store.append(agentEvent(1000));
  store.append(agentEvent(2000));
  store.purge(5000);
  store.close();
  const reopened = open(path);
  const next = reopened.append(agentEvent(6000));
  expect(next).toBeGreaterThan(first + 1);
  const [event] = reopened.readEvents();
  expect(event?.id).toBe(eventId(next));
  expect(eventId(9) < eventId(10)).toBe(true);
});

test("a vacuum returns the space retention freed", () => {
  const path = directory();
  const store = open(path);
  const task = "x".repeat(2000);
  for (let index = 0; index < 2000; index++)
    store.append({
      ...agentEvent(index),
      agent: { ...agentEvent(index).agent, task },
    });
  store.purge(Number.MAX_SAFE_INTEGER);
  const free = () => {
    const db = new Database(join(path, "activity.sqlite"), { readonly: true });
    try {
      return db
        .query<{ freelist_count: number }, []>("PRAGMA freelist_count")
        .get()!.freelist_count;
    } finally {
      db.close();
    }
  };
  expect(free()).toBeGreaterThan(256);
  store.vacuum();
  expect(free()).toBeLessThan(256);
});

test("times read back in local time with their offset", () => {
  const ms = Date.parse("2026-11-02T09:00:00.250Z");
  const text = isoTime(ms);
  expect(text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.250[+-]\d\d:\d\d$/);
  expect(Date.parse(text)).toBe(ms);
});
