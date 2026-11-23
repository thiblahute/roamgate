import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDbPath,
  existingArchiveDb,
  getMeta,
  legacyIndexPath,
  openArchiveDb,
} from "./store";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "roamgate-store-")), "archive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

/** An index.sqlite as version 1 wrote it, FTS tables included. */
function legacyIndex(): void {
  const db = new Database(legacyIndexPath(dir), { create: true });
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) STRICT;
    CREATE TABLE files(
      id INTEGER PRIMARY KEY,
      host TEXT NOT NULL, agent TEXT NOT NULL, relpath TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'transcript',
      project TEXT, session TEXT, subagent INTEGER NOT NULL DEFAULT 0,
      title TEXT, cost_usd REAL, cwd TEXT,
      src_size INTEGER, src_mtime REAL,
      archived_size INTEGER NOT NULL DEFAULT 0,
      zst_size INTEGER NOT NULL DEFAULT 0,
      indexed_bytes INTEGER NOT NULL DEFAULT 0,
      index_level TEXT NOT NULL DEFAULT 'full',
      first_ts TEXT, last_ts TEXT,
      UNIQUE(host, agent, relpath)
    ) STRICT;
    CREATE TABLE docs(id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL,
      ts TEXT, role TEXT, kind TEXT, tool TEXT) STRICT;
    CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='trigram');
    INSERT INTO files(host, agent, relpath, session, title, archived_size, zst_size)
      VALUES('desk', 'claude', 'p/s.jsonl', 's', 'A title', 100, 40);
    INSERT INTO meta VALUES('last_sync:desk', '2026-11-22T00:00:00Z');
    INSERT INTO docs(file_id, ts, role, kind) VALUES(1, 'x', 'user', 'text');
    INSERT INTO fts(rowid, text) VALUES(1, 'some indexed text');
    PRAGMA user_version = 1;
  `);
  db.close();
}

test("an old index.sqlite is read as is, then migrated by a writer and deleted", () => {
  legacyIndex();
  expect(existingArchiveDb(dir)).toBe(legacyIndexPath(dir));
  const read = openArchiveDb(dir, { readonly: true });
  expect(read.needsRebuild).toBe(false);
  expect(
    read.db.query("SELECT title FROM files").get() as { title: string },
  ).toEqual({ title: "A title" });
  read.db.close(false);
  expect(existsSync(archiveDbPath(dir))).toBe(false);

  const { db, needsRebuild } = openArchiveDb(dir);
  expect(needsRebuild).toBe(false);
  expect(
    db.query("SELECT host, relpath, archived_size, zst_size FROM files").all(),
  ).toEqual([
    { host: "desk", relpath: "p/s.jsonl", archived_size: 100, zst_size: 40 },
  ]);
  expect(getMeta(db, "last_sync:desk")).toBe("2026-11-22T00:00:00Z");
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE name IN ('docs', 'fts')")
      .all(),
  ).toEqual([]);
  db.close(false);
  expect(existsSync(legacyIndexPath(dir))).toBe(false);
  expect(existingArchiveDb(dir)).toBe(archiveDbPath(dir));
});

test("a fresh archive gets a database of the current version", () => {
  expect(existingArchiveDb(dir)).toBeNull();
  expect(() => openArchiveDb(dir, { readonly: true })).toThrow();
  const { db, needsRebuild } = openArchiveDb(dir);
  expect(needsRebuild).toBe(false);
  expect(
    (db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  ).toBe(2);
  db.close(false);
});
