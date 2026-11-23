/** The archive's operations: sync, ingest, rebuild. The CLI and tests call these. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ADAPTERS } from "./adapters";
import {
  type ArchiveRuntime,
  enabledAdapters,
  type Exec,
  defaultExec,
  localRoot,
  mirrorDir,
  pullAgent,
  pushAgent,
  remoteHome,
  remoteIngest,
  resolveHosts,
  type ResolvedHost,
  SAFE_HOST,
  UnreachableHost,
} from "./hosts";
import { acquireHostLock } from "./lock";
import {
  scanLines,
  emptyStats,
  recordSync,
  syncSource,
  type SyncContext,
  type SyncSource,
  type SyncStats,
} from "./sync";
import { indexLevelFor, type GuiArchiveSettings } from "./settings";
import {
  type ArchiveDb,
  getMeta,
  openArchiveDb,
  readKeptMeta,
  removeArchiveDb,
  setMeta,
} from "./store";
import { readArchived } from "./zstd";

export type SyncOptions = {
  settings: GuiArchiveSettings;
  runtime: ArchiveRuntime;
  archiveDir: string;
  /** Only these hosts; default: this machine and every pullable host. */
  hosts?: string[];
  agents?: string[];
  /** Do not pull ssh hosts. */
  localOnly?: boolean;
  exec?: Exec;
  log: (message: string) => void;
};

export type HostReport = {
  host: string;
  status: "synced" | "skipped" | "locked" | "unreachable";
  message?: string;
  agents: Record<string, SyncStats>;
};

export type SyncReport = { hosts: HostReport[]; seconds: number };

/** Opens the archive's database, rebuilding it from the raw files when its version is unknown. */
export async function openOrRebuild(
  archiveDir: string,
  log: (message: string) => void,
  settings?: GuiArchiveSettings,
): Promise<ArchiveDb> {
  const opened = openArchiveDb(archiveDir);
  if (!opened.needsRebuild) return opened.db;
  log(
    "the archive database has an unknown version: rebuilding it from the raw files",
  );
  opened.db.close(false);
  return rebuildArchiveDb(archiveDir, settings, log);
}

function agentSources(
  settings: GuiArchiveSettings,
  host: ResolvedHost,
  runtime: ArchiveRuntime,
  archiveDir: string,
  only?: string[],
): SyncSource[] {
  return enabledAdapters(settings)
    .filter((adapter) => !only || only.includes(adapter.id))
    .map((adapter) => {
      if (host.self)
        return {
          host: host.id,
          adapter,
          root: localRoot(adapter, host, runtime),
          extra: (adapter.extraFiles ?? []).map((extra) => ({
            path: join(runtime.homeDir, extra.homePath),
            relpath: extra.relpath,
            kind: extra.kind,
          })),
        };
      const mirror = mirrorDir(archiveDir, host.id, adapter.id);
      return {
        host: host.id,
        adapter,
        root: join(mirror, "tree"),
        extra: (adapter.extraFiles ?? []).map((extra) => ({
          path: join(mirror, "extra", extra.relpath),
          relpath: extra.relpath,
          kind: extra.kind,
        })),
      };
    });
}

async function syncHost(
  ctx: SyncContext,
  host: ResolvedHost,
  options: SyncOptions & { pull: boolean },
  exec: Exec,
): Promise<HostReport> {
  const report: HostReport = { host: host.id, status: "synced", agents: {} };
  const release = acquireHostLock(ctx.archiveDir, host.id);
  if (!release)
    return {
      ...report,
      status: "locked",
      message: "another sync of this host is running",
    };
  try {
    if (!host.self && options.pull) {
      let home = host.home ?? getMeta(ctx.db, `home:${host.id}`);
      try {
        home ??= await remoteHome(exec, host.ssh as string);
        if (!home) throw new UnreachableHost(`cannot reach ${host.ssh}`);
        setMeta(ctx.db, `home:${host.id}`, home);
        for (const adapter of enabledAdapters(ctx.settings)) {
          if (options.agents && !options.agents.includes(adapter.id)) continue;
          await pullAgent(exec, ctx.archiveDir, host, adapter, home);
        }
      } catch (error) {
        if (
          error instanceof UnreachableHost ||
          /ssh|rsync/.test((error as Error).message)
        ) {
          const stamp = new Date().toISOString();
          setMeta(ctx.db, `last_attempt:${host.id}`, stamp);
          setMeta(
            ctx.db,
            `last_error:${host.id}`,
            `${stamp} ${(error as Error).message}`,
          );
          return {
            ...report,
            status: "unreachable",
            message: (error as Error).message,
          };
        }
        throw error;
      }
      setMeta(ctx.db, `last_error:${host.id}`, "");
    }
    for (const source of agentSources(
      ctx.settings,
      host,
      options.runtime,
      ctx.archiveDir,
      options.agents,
    )) {
      if (
        !existsSync(source.root) &&
        source.extra.every((extra) => !existsSync(extra.path))
      )
        continue;
      const stats = emptyStats();
      await syncSource(ctx, source, stats, new Map());
      recordSync(ctx.db, host.id, source.adapter.id, stats);
      report.agents[source.adapter.id] = stats;
    }
    return report;
  } finally {
    release();
  }
}

/**
 * Sync this machine's agents and pull every pullable ssh host. An
 * unreachable host is recorded and skipped; it never fails the run.
 */
export async function runSync(options: SyncOptions): Promise<SyncReport> {
  const started = Date.now();
  const exec = options.exec ?? defaultExec;
  const db = await openOrRebuild(
    options.archiveDir,
    options.log,
    options.settings,
  );
  const ctx: SyncContext = {
    db,
    archiveDir: options.archiveDir,
    settings: options.settings,
    log: options.log,
  };
  try {
    const hosts = resolveHosts(options.settings, options.runtime).filter(
      (host) =>
        (!options.hosts || options.hosts.includes(host.id)) &&
        (host.self || (host.enabled && !options.localOnly)),
    );
    const pull = !options.settings.push && !options.localOnly;
    const reports: HostReport[] = [];
    for (const host of hosts)
      reports.push(await syncHost(ctx, host, { ...options, pull }, exec));
    return { hosts: reports, seconds: (Date.now() - started) / 1000 };
  } finally {
    db.close(false);
  }
}

/** Index what a host pushed into its mirror. */
export async function runIngest(
  options: Omit<SyncOptions, "hosts" | "localOnly"> & { host: string },
): Promise<HostReport> {
  if (!SAFE_HOST.test(options.host))
    throw new Error(`invalid host name: ${options.host}`);
  const db = await openOrRebuild(
    options.archiveDir,
    options.log,
    options.settings,
  );
  const ctx: SyncContext = {
    db,
    archiveDir: options.archiveDir,
    settings: options.settings,
    log: options.log,
  };
  try {
    const host: ResolvedHost = {
      id: options.host,
      self: false,
      pathStyle: "posix",
      roots: {},
      enabled: true,
    };
    return await syncHost(
      ctx,
      host,
      { ...options, pull: false },
      options.exec ?? defaultExec,
    );
  } finally {
    db.close(false);
  }
}

/** On a pushing machine: send this machine's files to the archive home, then have it ingest them. */
export async function runPush(options: SyncOptions): Promise<HostReport> {
  const push = options.settings.push;
  if (!push) throw new Error("no archive.push target is configured");
  const exec = options.exec ?? defaultExec;
  const self = resolveHosts(
    options.settings,
    options.runtime,
  )[0] as ResolvedHost;
  const report: HostReport = { host: self.id, status: "synced", agents: {} };
  try {
    for (const adapter of enabledAdapters(options.settings)) {
      if (options.agents && !options.agents.includes(adapter.id)) continue;
      if (adapter.snapshot) continue;
      await pushAgent(
        exec,
        push,
        self.id,
        adapter,
        localRoot(adapter, self, options.runtime),
        (adapter.extraFiles ?? []).map((extra) => ({
          path: join(options.runtime.homeDir, extra.homePath),
          relpath: extra.relpath,
        })),
      );
    }
    const result = await remoteIngest(exec, push, self.id);
    if (result.code !== 0) {
      return {
        ...report,
        status: "unreachable",
        message: `ingest failed: exit ${result.code} ${result.stderr.trim().slice(0, 300)}`,
      };
    }
    report.message = result.stdout.trim().slice(0, 2000);
    return report;
  } catch (error) {
    if (error instanceof UnreachableHost)
      return { ...report, status: "unreachable", message: error.message };
    throw error;
  }
}

function* rawFiles(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* rawFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".zst")) yield path;
  }
}

/** Drop the archive's database and build it again from the raw files. */
export async function rebuildArchiveDb(
  archiveDir: string,
  settings: GuiArchiveSettings | undefined,
  log: (message: string) => void,
): Promise<ArchiveDb> {
  let kept: Array<[string, string]> = [];
  try {
    const old = openArchiveDb(archiveDir);
    kept = readKeptMeta(old.db);
    old.db.close(false);
  } catch {
    // No readable index: nothing to keep.
  }
  removeArchiveDb(archiveDir);
  const { db } = openArchiveDb(archiveDir);
  for (const [key, value] of kept) setMeta(db, key, value);
  const config =
    settings ??
    (await import("./settings")).normalizeArchiveSettings(undefined);
  const raw = join(archiveDir, "raw");
  let count = 0;
  for (const path of rawFiles(raw)) {
    const [host, agent, ...rest] = relative(raw, path).split("/");
    const relpath = rest.join("/").replace(/\.zst$/, "");
    const adapter = agent ? ADAPTERS[agent] : undefined;
    if (!host || !adapter || !relpath) continue;
    const history = relpath.startsWith("@");
    const meta = history
      ? { project: "", session: "history", subagent: false }
      : adapter.classify(relpath);
    const level = indexLevelFor(config, {
      host,
      agent: adapter.id,
      project: meta.project,
    });
    const inserted = db
      .query(
        `INSERT INTO files(host, agent, relpath, kind, project, session, subagent, index_level, zst_size)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .run(
        host,
        adapter.id,
        relpath,
        history ? "history" : "transcript",
        meta.project,
        meta.session,
        meta.subagent ? 1 : 0,
        level,
        statSync(path).size,
      );
    const fileId = Number(inserted.lastInsertRowid);
    let total = 0;
    const counted = (async function* () {
      for await (const chunk of readArchived(path)) {
        total += chunk.length;
        yield chunk;
      }
    })();
    try {
      if (adapter.indexable || history) {
        await scanLines(
          {
            db,
            fileId,
            adapter,
            kind: history ? "history" : "transcript",
            thinking: config.thinking,
            unknown: new Map(),
          },
          counted,
          0,
          { title: null, cwd: null, project: meta.project },
        );
      } else {
        for await (const _ of counted) void _;
      }
      db.query(
        "UPDATE files SET src_size = ?1, archived_size = ?1, src_mtime = 0 WHERE id = ?2",
      ).run(total, fileId);
    } catch (error) {
      log(`rebuild: ${relpath}: ${(error as Error).message}`);
    }
    count += 1;
    if (count % 200 === 0) log(`  rebuilt ${count} files`);
  }
  log(`rebuilt the archive database from ${count} archived file(s)`);
  return db;
}
