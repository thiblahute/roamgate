/** Copy, compress and index session files. Never deletes anything. */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type AgentAdapter, type ParseState } from "./adapters";
import { clip } from "./extract";
import { completeLines, fileRange } from "./lines";
import {
  anyRuleMatches,
  type GuiArchiveSettings,
  type IndexLevel,
  indexLevelFor,
} from "./settings";
import { type ArchiveDb, setMeta } from "./store";
import { appendFrameAt } from "./zstd";

export type SyncStats = {
  new: number;
  grown: number;
  same: number;
  shrunk: number;
  replaced: number;
  error: number;
  excluded: number;
  docs: number;
  /** Source bytes compressed in this run. */
  bytes: number;
  unknown: Record<string, number>;
};

export function emptyStats(): SyncStats {
  return {
    new: 0,
    grown: 0,
    same: 0,
    shrunk: 0,
    replaced: 0,
    error: 0,
    excluded: 0,
    docs: 0,
    bytes: 0,
    unknown: {},
  };
}

export type SyncSource = {
  host: string;
  adapter: AgentAdapter;
  /** The directory holding the session files. */
  root: string;
  /** Single files outside the root (the Claude prompt history). */
  extra: Array<{ path: string; relpath: string; kind: "history" }>;
};

export type SyncContext = {
  db: ArchiveDb;
  archiveDir: string;
  settings: GuiArchiveSettings;
  log: (message: string) => void;
};

export function zstPath(
  archiveDir: string,
  host: string,
  agent: string,
  relpath: string,
): string {
  return join(archiveDir, "raw", host, agent, `${relpath}.zst`);
}

type FileRow = {
  id: number;
  src_size: number | null;
  src_mtime: number | null;
  archived_size: number;
  zst_size: number;
  indexed_bytes: number;
  title: string | null;
  cwd: string | null;
  project: string | null;
  index_level: IndexLevel;
};

const CHUNK_DOCS = 2000;
const HUGE_LINE = 100_000;

/** Session files under `root`, as relative paths with `/`. */
export function listFiles(
  root: string,
  adapter: AgentAdapter,
): Array<{ path: string; relpath: string; size: number; mtime: number }> {
  const out: Array<{
    path: string;
    relpath: string;
    size: number;
    mtime: number;
  }> = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const relpath = relative(root, path).split("\\").join("/");
        if (!adapter.accepts(relpath)) continue;
        try {
          const stat = statSync(path);
          out.push({
            path,
            relpath,
            size: stat.size,
            mtime: stat.mtimeMs / 1000,
          });
        } catch {
          // Vanished between listing and stat.
        }
      }
    }
  };
  walk(root);
  out.sort((a, b) => (a.relpath < b.relpath ? -1 : 1));
  return out;
}

function keepOldCopy(zst: string, mtime: number): void {
  if (!existsSync(zst)) return;
  let keep = `${zst}.${Math.trunc(mtime)}`;
  for (let n = 1; existsSync(keep); n += 1)
    keep = `${zst}.${Math.trunc(mtime)}.${n}`;
  renameSync(zst, keep);
}

function dropDocs(db: ArchiveDb, fileId: number): void {
  db.query(
    "DELETE FROM fts WHERE rowid IN (SELECT id FROM docs WHERE file_id = ?1)",
  ).run(fileId);
  db.query(
    "DELETE FROM fts_words WHERE rowid IN (SELECT id FROM docs WHERE file_id = ?1)",
  ).run(fileId);
  db.query("DELETE FROM docs WHERE file_id = ?1").run(fileId);
  db.query("UPDATE files SET indexed_bytes = 0 WHERE id = ?1").run(fileId);
}

type LineSource = AsyncIterable<Buffer>;

type IndexTarget = {
  db: ArchiveDb;
  fileId: number;
  adapter: AgentAdapter;
  kind: "transcript" | "history";
  level: IndexLevel;
  host: string;
  thinking: boolean;
  unknown: Map<string, number>;
};

/**
 * Index the complete lines of `chunks`, which start at byte `start` of the
 * source. Commits every few thousand documents so concurrent syncs of other
 * hosts are not held up. Returns the new indexed byte count and documents.
 */
export async function indexLines(
  target: IndexTarget,
  chunks: LineSource,
  start: number,
  row: Pick<FileRow, "title" | "cwd" | "project">,
): Promise<{ position: number; docs: number }> {
  const { db, fileId, adapter } = target;
  const state: ParseState = {
    thinking: target.thinking,
    unknown: target.unknown,
    ...(row.cwd ? { cwd: row.cwd } : {}),
  };
  let lastTitle = row.title;
  let title: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let position = start;
  let docs = 0;
  let pending = 0;
  let open = false;
  const insertDoc = db.query(
    "INSERT INTO docs(file_id, ts, role, kind, tool) VALUES(?1, ?2, ?3, ?4, ?5)",
  );
  const insertFts = db.query("INSERT INTO fts(rowid, text) VALUES(?1, ?2)");
  const insertWords = db.query(
    "INSERT INTO fts_words(rowid, text) VALUES(?1, ?2)",
  );
  const insertHistory = db.query(
    "INSERT OR IGNORE INTO history(host, agent, ts, project, text) VALUES(?1, ?2, ?3, ?4, ?5)",
  );
  const insertHistoryFts = db.query(
    "INSERT INTO hist_fts(rowid, text) VALUES(?1, ?2)",
  );
  const update = db.query(
    `UPDATE files SET indexed_bytes = ?1, title = COALESCE(?2, title), cost_usd = COALESCE(?3, cost_usd),
       cwd = COALESCE(?4, cwd), project = COALESCE(NULLIF(project, ''), ?5, project),
       first_ts = COALESCE(first_ts, ?6), last_ts = COALESCE(?7, last_ts) WHERE id = ?8`,
  );
  const flush = () => {
    update.run(
      position,
      title,
      state.cost ?? null,
      state.cwd ?? null,
      state.project ?? null,
      firstTs,
      lastTs,
      fileId,
    );
    if (open) db.exec("COMMIT");
    open = false;
    pending = 0;
    title = null;
    firstTs = null;
    lastTs = null;
  };
  const begin = () => {
    if (!open) {
      db.exec("BEGIN IMMEDIATE");
      open = true;
    }
  };
  try {
    for await (const { line, length } of completeLines(chunks)) {
      position += length;
      if (line.length > HUGE_LINE) {
        const head = line.subarray(0, 400).toString("latin1");
        if (head.includes('"type":"api-request')) continue;
      }
      if (line.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      if (target.kind === "history") {
        const entry = record as {
          display?: unknown;
          timestamp?: unknown;
          project?: unknown;
        };
        const text =
          typeof entry.display === "string" ? entry.display.trim() : "";
        if (!text) continue;
        const ts =
          typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString().slice(0, 19)
            : null;
        begin();
        const result = insertHistory.run(
          target.host,
          adapter.id,
          ts,
          typeof entry.project === "string" ? entry.project : null,
          text,
        );
        if (result.changes > 0) {
          insertHistoryFts.run(
            Number(result.lastInsertRowid),
            clip(text, 20_000),
          );
          docs += 1;
          pending += 1;
        }
      } else {
        const ts = adapter.timestampOf(record);
        if (ts) {
          firstTs ??= ts;
          lastTs = ts;
        }
        for (const doc of adapter.parse(record, state)) {
          if (doc.kind === "title") {
            if (lastTitle === doc.text) continue;
            title = doc.text;
            lastTitle = doc.text;
          }
          if (target.level === "none") continue;
          begin();
          const id = Number(
            insertDoc.run(fileId, ts, doc.role, doc.kind, doc.tool)
              .lastInsertRowid,
          );
          (target.level === "words" ? insertWords : insertFts).run(
            id,
            doc.text,
          );
          docs += 1;
          pending += 1;
        }
      }
      if (pending >= CHUNK_DOCS) {
        flush();
        begin();
      }
    }
    begin();
    flush();
  } catch (error) {
    if (open) db.exec("ROLLBACK");
    throw error;
  }
  return { position, docs };
}

async function snapshotSqlite(
  source: string,
): Promise<{ path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-archive-"));
  const copy = join(dir, "snapshot.db");
  const live = new Database(source, { readonly: true });
  try {
    live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  } finally {
    live.close(false);
  }
  return {
    path: copy,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type Candidate = {
  path: string;
  relpath: string;
  size: number;
  mtime: number;
  kind: "transcript" | "history";
};

export async function syncOneFile(
  ctx: SyncContext,
  source: SyncSource,
  file: Candidate,
  stats: SyncStats,
  unknown: Map<string, number>,
): Promise<void> {
  const { db } = ctx;
  const { adapter, host } = source;
  const row = db
    .query<FileRow, [string, string, string]>(
      `SELECT id, src_size, src_mtime, archived_size, zst_size, indexed_bytes, title, cwd, project, index_level
       FROM files WHERE host = ?1 AND agent = ?2 AND relpath = ?3`,
    )
    .get(host, adapter.id, file.relpath);
  if (
    row &&
    row.src_size === file.size &&
    Math.trunc(row.src_mtime ?? 0) === Math.trunc(file.mtime) &&
    row.archived_size === file.size
  ) {
    stats.same += 1;
    return;
  }
  if (
    row &&
    adapter.mode === "append" &&
    row.archived_size === file.size &&
    row.src_size === file.size
  ) {
    // Same bytes, new mtime (touched, or an index rebuilt from the raw files).
    db.query("UPDATE files SET src_mtime = ?1 WHERE id = ?2").run(
      file.mtime,
      row.id,
    );
    stats.same += 1;
    return;
  }
  const meta =
    file.kind === "history"
      ? { project: "", session: "history", subagent: false }
      : adapter.classify(file.relpath);
  const level = indexLevelFor(ctx.settings, {
    host,
    agent: adapter.id,
    project: meta.project,
  });
  const zst = zstPath(ctx.archiveDir, host, adapter.id, file.relpath);
  let fileId: number;
  let outcome: "new" | "grown" | "shrunk" | "replaced";
  let from = 0;
  let keep = 0;
  let indexFrom = 0;
  if (!row) {
    const inserted = db
      .query(
        `INSERT INTO files(host, agent, relpath, kind, project, session, subagent, index_level)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        host,
        adapter.id,
        file.relpath,
        file.kind,
        meta.project,
        meta.session,
        meta.subagent ? 1 : 0,
        level,
      );
    fileId = Number(inserted.lastInsertRowid);
    outcome = "new";
    if (existsSync(zst)) keepOldCopy(zst, 0);
  } else {
    fileId = row.id;
    if (adapter.mode === "replace" || file.size < row.archived_size) {
      keepOldCopy(zst, row.src_mtime ?? 0);
      dropDocs(db, fileId);
      outcome = adapter.mode === "replace" ? "replaced" : "shrunk";
    } else {
      from = row.archived_size;
      keep = row.zst_size;
      indexFrom = row.indexed_bytes;
      outcome = "grown";
    }
  }
  const current =
    row && outcome === "grown"
      ? row
      : { title: null, cwd: null, project: row?.project ?? meta.project };
  let snapshot: { path: string; cleanup: () => void } | undefined;
  try {
    let sourcePath = file.path;
    let size = file.size;
    if (adapter.snapshot === "sqlite") {
      snapshot = await snapshotSqlite(file.path);
      sourcePath = snapshot.path;
      size = statSync(sourcePath).size;
    }
    const frame = await appendFrameAt(sourcePath, from, size, zst, keep);
    db.query(
      `UPDATE files SET src_size = ?1, src_mtime = ?2, archived_size = ?3, zst_size = ?4 WHERE id = ?5`,
    ).run(file.size, file.mtime, size, keep + frame.zstBytes, fileId);
    stats.bytes += frame.bytes;
    const indexable = adapter.indexable || file.kind === "history";
    if (indexable) {
      const fileLevel = row?.index_level ?? level;
      const result = await indexLines(
        {
          db,
          fileId,
          adapter,
          kind: file.kind,
          level: fileLevel,
          host,
          thinking: ctx.settings.thinking,
          unknown,
        },
        fileRange(file.path, indexFrom, size),
        indexFrom,
        current,
      );
      stats.docs += result.docs;
    }
    if (outcome === "new") stats.new += 1;
    else if (outcome === "grown") stats.grown += 1;
    else if (outcome === "shrunk") stats.shrunk += 1;
    else stats.replaced += 1;
  } finally {
    snapshot?.cleanup();
  }
}

/** Sync one agent's files of one host. Per-file failures are counted, not thrown. */
export async function syncSource(
  ctx: SyncContext,
  source: SyncSource,
  stats: SyncStats,
  unknown: Map<string, number>,
): Promise<void> {
  const { adapter, host } = source;
  const candidates: Candidate[] = [];
  for (const file of listFiles(source.root, adapter)) {
    const { project } = adapter.classify(file.relpath);
    if (
      anyRuleMatches(ctx.settings.exclude, { host, agent: adapter.id, project })
    ) {
      stats.excluded += 1;
      continue;
    }
    candidates.push({ ...file, kind: "transcript" });
  }
  for (const extra of source.extra) {
    try {
      const stat = statSync(extra.path);
      candidates.push({
        path: extra.path,
        relpath: extra.relpath,
        size: stat.size,
        mtime: stat.mtimeMs / 1000,
        kind: extra.kind,
      });
    } catch {
      // No history file on this host.
    }
  }
  let done = 0;
  for (const file of candidates) {
    try {
      await syncOneFile(ctx, source, file, stats, unknown);
    } catch (error) {
      stats.error += 1;
      ctx.log(
        `error: ${host}/${adapter.id}/${file.relpath}: ${(error as Error).message}`,
      );
    }
    done += 1;
    if (done % 200 === 0)
      ctx.log(`  ${host}/${adapter.id}: ${done}/${candidates.length} files`);
  }
  for (const [type, count] of unknown)
    stats.unknown[`${adapter.id}:${type}`] =
      (stats.unknown[`${adapter.id}:${type}`] ?? 0) + count;
}

export function recordSync(
  db: ArchiveDb,
  host: string,
  agent: string,
  stats: SyncStats,
  now = new Date(),
): void {
  const stamp = now.toISOString();
  setMeta(db, `last_attempt:${host}`, stamp);
  setMeta(db, `last_attempt:${host}:${agent}`, stamp);
  // The run reached the host and finished: file errors are recorded apart.
  setMeta(db, `last_sync:${host}`, stamp);
  setMeta(db, `last_sync:${host}:${agent}`, stamp);
  setMeta(
    db,
    `last_error:${host}:${agent}`,
    stats.error > 0 ? `${stamp} ${stats.error} file error(s)` : "",
  );
  setMeta(db, `unknown:${host}:${agent}`, JSON.stringify(stats.unknown));
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
