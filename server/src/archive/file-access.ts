/**
 * Reads of session files that are gone from their agent's directory, served
 * from the archive: what AgentSessionFileAccess falls back to when a
 * transcript was deleted by the agent's own cleanup.
 */
import { ADAPTERS } from "./adapters";
import { type ArchiveRuntime, resolveHosts } from "./hosts";
import { anyRuleMatches, type GuiArchiveSettings } from "./settings";
import { existingArchiveDb, openArchiveDb } from "./store";
import { zstPath } from "./sync";
import { readArchived } from "./zstd";

export type ArchivedSessionFile = {
  path: string;
  mtimeMs: number;
  size: number;
  identity: string;
  changeToken: string;
};

export type ArchivedSessionReader = {
  stat(path: string): Promise<ArchivedSessionFile | null>;
  /** Bytes [start, end) of the file as archived; null when it is not archived. */
  range(path: string, start: number, end: number): Promise<Uint8Array | null>;
};

export type ArchivedReaderDeps = {
  settings: () => Promise<GuiArchiveSettings>;
  archiveDir: (settings: GuiArchiveSettings) => string;
  runtime: () => ArchiveRuntime;
};

type Resolved = {
  zst: string;
  size: number;
  mtime: number;
  id: number;
};

type Row = {
  id: number;
  host: string;
  relpath: string;
  project: string | null;
  archived_size: number;
  src_mtime: number | null;
};

export function createArchivedSessionReader(
  deps: ArchivedReaderDeps,
): ArchivedSessionReader {
  async function resolve(path: string): Promise<Resolved | null> {
    const runtime = deps.runtime();
    const settings = await deps.settings();
    for (const adapter of Object.values(ADAPTERS)) {
      if (!settings.agents.includes(adapter.id)) continue;
      const root = adapter.rootFor(runtime.homeDir, runtime.env);
      if (!path.startsWith(`${root}/`)) continue;
      const relpath = path.slice(root.length + 1);
      const archiveDir = deps.archiveDir(settings);
      if (!existingArchiveDb(archiveDir)) return null;
      const { db, needsRebuild } = openArchiveDb(archiveDir, {
        readonly: true,
      });
      try {
        if (needsRebuild) return null;
        const self = resolveHosts(settings, runtime)[0]?.id ?? "";
        const row = db
          .query<Row, [string, string, string]>(
            `SELECT id, host, relpath, project, archived_size, src_mtime FROM files
             WHERE agent = ?1 AND relpath = ?2 AND kind = 'transcript'
             ORDER BY (host = ?3) DESC, archived_size DESC LIMIT 1`,
          )
          .get(adapter.id, relpath, self);
        if (!row) return null;
        if (
          anyRuleMatches(settings.hide, {
            host: row.host,
            agent: adapter.id,
            project: row.project ?? "",
          })
        )
          return null;
        return {
          zst: zstPath(archiveDir, row.host, adapter.id, row.relpath),
          size: row.archived_size,
          mtime: (row.src_mtime ?? 0) * 1000,
          id: row.id,
        };
      } finally {
        db.close(false);
      }
    }
    return null;
  }
  return {
    async stat(path) {
      const found = await resolve(path);
      if (!found) return null;
      return {
        path,
        mtimeMs: found.mtime,
        size: found.size,
        identity: `archive:${found.id}`,
        changeToken: String(found.size),
      };
    },
    async range(path, start, end) {
      const found = await resolve(path);
      if (!found) return null;
      const stop = Math.min(end, found.size);
      const parts: Buffer[] = [];
      let offset = 0;
      for await (const chunk of readArchived(found.zst)) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(stop - offset, chunk.length);
        if (to > from) parts.push(chunk.subarray(from, to));
        offset += chunk.length;
        if (offset >= stop) break;
      }
      return new Uint8Array(Buffer.concat(parts));
    },
  };
}
