import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewSession, ReviewThread } from "../../../shared/review";
import { openReviewStorage, type ReviewStorage } from "./storage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-review-storage-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function open(dir: string): ReviewStorage {
  const storage = openReviewStorage(dir);
  cleanups.unshift(() => storage.close());
  return storage;
}

/** Runs SQL on the database file directly, as an older version left it. */
function raw(dir: string, run: (db: Database) => void) {
  const db = new Database(join(dir, "reviews.sqlite"));
  try {
    run(db);
  } finally {
    db.close();
  }
}

function session(id: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    id,
    connectionId: "local",
    root: "/repo",
    title: id,
    target: { kind: "worktree" },
    summary: "",
    agent: {},
    createdAt: updatedAt,
    updatedAt,
  } as ReviewSession;
}

function thread(id: string, sessionId: string, text = "hello") {
  return {
    id,
    sessionId,
    kind: "discussion",
    anchor: { kind: "review" },
    comments: [{ id: `${id}c`, author: "you", text }],
    resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ReviewThread;
}

test("sessions and threads come back after reopening", () => {
  const dir = directory();
  const storage = openReviewStorage(dir);
  storage.saveSession(session("s1", "2026-01-01T00:00:00.000Z"));
  storage.saveSession(session("s2", "2026-01-02T00:00:00.000Z"));
  storage.saveThread(thread("t1", "s1"));
  storage.saveThread(thread("t2", "s1", "edited"));
  storage.saveThread(thread("t2", "s1", "edited again"));
  storage.close();

  const reopened = open(dir);
  expect(reopened.loadSessions().map((s) => s.id)).toEqual(["s1", "s2"]);
  expect(reopened.loadThreads("s1")).toEqual([
    thread("t1", "s1"),
    thread("t2", "s1", "edited again"),
  ]);
  expect(reopened.loadThreads("s2")).toEqual([]);
  reopened.deleteThread("t1");
  expect(reopened.loadThreads("s1").map((t) => t.id)).toEqual(["t2"]);
});

test("deleting a session deletes its threads", () => {
  const dir = directory();
  const storage = open(dir);
  storage.saveSession(session("s1"));
  storage.saveThread(thread("t1", "s1"));
  storage.deleteSession("s1");
  expect(storage.loadSessions()).toEqual([]);
  expect(storage.loadThreads("s1")).toEqual([]);
  raw(dir, (db) => {
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM threads").get()!.n,
    ).toBe(0);
  });
});

test("a thread id of another review is refused and that thread kept", () => {
  const dir = directory();
  const storage = openReviewStorage(dir);
  storage.saveSession(session("s1"));
  storage.saveSession(session("s2"));
  storage.saveThread(thread("t1", "s1", "mine"));
  expect(() => storage.saveThread(thread("t1", "s2", "taken over"))).toThrow(
    "belongs to another review",
  );
  storage.close();

  const reopened = open(dir);
  expect(reopened.loadThreads("s1")).toEqual([thread("t1", "s1", "mine")]);
  expect(reopened.loadThreads("s2")).toEqual([]);
});

test("a review's threads are only those that name it", () => {
  const dir = directory();
  const storage = openReviewStorage(dir);
  storage.saveSession(session("s1"));
  storage.saveSession(session("s2"));
  storage.saveThread(thread("t1", "s1"));
  storage.close();
  // An older version could leave another review's thread in this row.
  raw(dir, (db) => {
    db.query(
      "INSERT INTO threads (id, session_id, created_at, data) VALUES (?, ?, ?, ?)",
    ).run("t2", "s1", "2026-01-02", JSON.stringify(thread("t2", "s2")));
  });

  const reopened = open(dir);
  expect(reopened.loadThreads("s1").map((t) => t.id)).toEqual(["t1"]);
});

test("a row that does not parse is skipped", () => {
  const dir = directory();
  const storage = openReviewStorage(dir);
  storage.saveSession(session("s1"));
  storage.saveThread(thread("t1", "s1"));
  storage.close();
  raw(dir, (db) => {
    db.query(
      "INSERT INTO threads (id, session_id, created_at, data) VALUES (?, ?, ?, ?)",
    ).run("t2", "s1", "2026-01-02", "{not json");
    db.query(
      "INSERT INTO sessions (id, connection_id, updated_at, data) VALUES (?, ?, ?, ?)",
    ).run("s2", "local", "2026-01-02", "{not json");
  });

  const reopened = open(dir);
  expect(reopened.loadSessions().map((s) => s.id)).toEqual(["s1"]);
  expect(reopened.loadThreads("s1").map((t) => t.id)).toEqual(["t1"]);
});

test("a database from an unknown version is refused", () => {
  const dir = directory();
  openReviewStorage(dir).close();
  raw(dir, (db) => {
    db.exec("PRAGMA user_version = 99");
  });
  expect(() => openReviewStorage(dir)).toThrow("Unsupported review database");
});
