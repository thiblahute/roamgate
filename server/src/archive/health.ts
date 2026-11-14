import { statfsSync } from "node:fs";
import { legacyArchiveWarning } from "./dir";
import { resolveHosts, type ArchiveRuntime } from "./hosts";
import type { GuiArchiveSettings } from "./settings";
import { type ArchiveDb, getMeta } from "./store";

export type AgentHealth = {
  agent: string;
  files: number;
  sessions: number;
  last_sync: string | null;
  last_attempt: string | null;
  last_error: string | null;
  stale: boolean;
};

export type HostHealth = {
  host: string;
  last_sync: string | null;
  last_attempt: string | null;
  last_error: string | null;
  age_hours: number | null;
  stale: boolean;
  files: number;
  sessions: number;
  agents: AgentHealth[];
};

export type ArchiveHealth = {
  ok: boolean;
  archive_dir: string;
  now: string;
  stale_hours: number;
  hosts: HostHealth[];
  totals: { files: number; sessions: number; docs: number; history: number };
  sizes: { raw_bytes: number; index_bytes: number; source_bytes: number };
  disk: { free_gb: number | null; low: boolean };
  unknown_types: Record<string, number>;
  warnings: string[];
};

function hoursSince(stamp: string | null, now: Date): number | null {
  if (!stamp) return null;
  const time = Date.parse(stamp);
  return Number.isNaN(time) ? null : (now.getTime() - time) / 3_600_000;
}

function errorText(value: string | null): string | null {
  return value ? value : null;
}

export function archiveHealth(
  db: ArchiveDb,
  archiveDir: string,
  settings: GuiArchiveSettings,
  runtime: ArchiveRuntime,
  indexBytes: number,
  now = new Date(),
): ArchiveHealth {
  const warnings: string[] = [];
  const perAgent = db
    .query<
      { host: string; agent: string; files: number; sessions: number },
      []
    >(
      `SELECT host, agent, count(*) AS files, count(DISTINCT session) AS sessions
       FROM files WHERE kind = 'transcript' GROUP BY host, agent`,
    )
    .all();
  const hostIds = new Set<string>(perAgent.map((row) => row.host));
  for (const host of resolveHosts(settings, runtime))
    if (host.self || host.enabled) hostIds.add(host.id);
  const hosts: HostHealth[] = [...hostIds].sort().map((host) => {
    const agents: AgentHealth[] = perAgent
      .filter((row) => row.host === host)
      .map((row) => {
        const lastSync = getMeta(db, `last_sync:${host}:${row.agent}`);
        const age = hoursSince(lastSync, now);
        return {
          agent: row.agent,
          files: row.files,
          sessions: row.sessions,
          last_sync: lastSync,
          last_attempt: getMeta(db, `last_attempt:${host}:${row.agent}`),
          last_error: errorText(getMeta(db, `last_error:${host}:${row.agent}`)),
          stale: age === null || age > settings.stale_hours,
        };
      });
    const lastSync = getMeta(db, `last_sync:${host}`);
    const age = hoursSince(lastSync, now);
    const stale = age === null || age > settings.stale_hours;
    const lastError =
      errorText(getMeta(db, `last_error:${host}`)) ??
      agents.map((a) => a.last_error).find(Boolean) ??
      null;
    if (lastSync === null) warnings.push(`${host}: never synced`);
    else if (stale)
      warnings.push(
        `${host}: last sync ${Math.floor(age ?? 0)} hours ago (stale after ${settings.stale_hours})`,
      );
    if (lastError) warnings.push(`${host}: ${lastError}`);
    return {
      host,
      last_sync: lastSync,
      last_attempt: getMeta(db, `last_attempt:${host}`),
      last_error: lastError,
      age_hours: age === null ? null : Math.round(age * 10) / 10,
      stale,
      files: agents.reduce((sum, a) => sum + a.files, 0),
      sessions: agents.reduce((sum, a) => sum + a.sessions, 0),
      agents,
    };
  });
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  const raw = db
    .query<{ n: number | null; s: number | null }, []>(
      "SELECT sum(zst_size) AS n, sum(archived_size) AS s FROM files",
    )
    .get();
  const freeGb = (() => {
    try {
      const stat = statfsSync(archiveDir);
      return Math.round((Number(stat.bavail) * Number(stat.bsize)) / 1e8) / 10;
    } catch {
      return null;
    }
  })();
  const legacy = legacyArchiveWarning(archiveDir);
  if (legacy) warnings.push(legacy);
  const low = freeGb !== null && freeGb < settings.min_free_gb;
  if (low)
    warnings.push(
      `only ${freeGb} GB free under the archive (warning below ${settings.min_free_gb} GB)`,
    );
  const unknown: Record<string, number> = {};
  for (const row of db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM meta WHERE key LIKE 'unknown:%'",
    )
    .all()) {
    try {
      for (const [type, n] of Object.entries(
        JSON.parse(row.value) as Record<string, number>,
      ))
        unknown[type] = (unknown[type] ?? 0) + n;
    } catch {
      // Ignore a damaged entry.
    }
  }
  return {
    ok: warnings.length === 0,
    archive_dir: archiveDir,
    now: now.toISOString(),
    stale_hours: settings.stale_hours,
    hosts,
    totals: {
      files: count("SELECT count(*) AS n FROM files WHERE kind = 'transcript'"),
      sessions: count(
        "SELECT count(*) AS n FROM (SELECT DISTINCT agent, session FROM files WHERE kind = 'transcript')",
      ),
      docs: count("SELECT count(*) AS n FROM docs"),
      history: count("SELECT count(*) AS n FROM history"),
    },
    sizes: {
      raw_bytes: raw?.n ?? 0,
      index_bytes: indexBytes,
      source_bytes: raw?.s ?? 0,
    },
    disk: { free_gb: freeGb, low },
    unknown_types: unknown,
    warnings,
  };
}
