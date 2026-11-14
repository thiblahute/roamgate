import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../archive/adapters";
import { resolveArchiveDir } from "../archive/dir";
import {
  type ArchiveRuntime,
  defaultExec,
  type Exec,
  resolveHosts,
  SSH_OPTIONS,
  type ResolvedHost,
  shQuote,
} from "../archive/hosts";
import {
  rebuildIndex,
  runIngest,
  runPush,
  runSync,
  openOrRebuild,
  type HostReport,
} from "../archive/engine";
import { archiveHealth } from "../archive/health";
import { openArchiveDb } from "../archive/store";
import { searchArchive } from "../archive/search";
import {
  catFile,
  catLines,
  localFileSource,
  lookupSession,
  resumeSession,
  type SessionLookup,
  sshFileSource,
} from "../archive/session";
import {
  type GuiArchiveSettings,
  normalizeArchiveSettings,
} from "../archive/settings";
import { roamgateEnv } from "../config/environment";
import {
  type CliCommand,
  type CliContext,
  EXIT_FAILURE,
  EXIT_OK,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";
import { readServiceSetup, runtimeDataRoot } from "./service-context";

function archiveHelp(): string {
  return `Archive agent sessions (Claude Code, Codex, Pi), searchable, without the server.

Usage:
  roamgate archive sync [--host H] [--agent A] [--local-only] [--push] [--json]
  roamgate archive ingest <host> [--json]
  roamgate archive search <terms...> [--agent A] [--host H] [--project P]
                          [--role R] [--kind K] [--since D] [--until D]
                          [--recent] [--history] [-n N] [--json]
  roamgate archive session <id> [--agent A] [--host H] [--json]
  roamgate archive cat <id> [--agent A] [--host H] [--file RELPATH]
                       [--from-line N --limit N]
  roamgate archive resume <id> [--agent A] [--host H] [--remote SSH]
                          [--dry-run] [--json]
  roamgate archive health [--check] [--json]
  roamgate archive rebuild-index

sync copies, compresses and indexes this machine's agent sessions, then
pulls every configured ssh host (unreachable hosts are recorded and skipped).
With --push (or archive.push in settings) it sends this machine's files to the
archive home and has it index them. Files under raw/ are the source of truth
and are never deleted; the index (index.sqlite) is rebuilt from them.
search matches substrings, case-insensitive (3+ characters). cat prints a
session byte-identical to the original. resume restores a session into this
machine's agent directory only where it does not exist, never overwriting.
health reports the last sync per host and agent and warns when stale
(--check exits 1 on any warning). Settings live under "archive" in
settings.json; --dir or ROAMGATE_ARCHIVE_DIR overrides the archive location.
`;
}

export type ArchiveCommandOptions = {
  exec?: Exec;
  write?: (chunk: Uint8Array) => Promise<void>;
  now?: () => Date;
};

function settingsPathFor(context: CliContext): string {
  let path: string | undefined;
  try {
    path = roamgateEnv("SETTINGS_PATH", readServiceSetup(context.runtime).env);
  } catch {
    // No usable service file: the default location.
  }
  return (
    path ??
    roamgateEnv("SETTINGS_PATH", context.runtime.env) ??
    join(runtimeDataRoot(context.runtime), "settings.json")
  );
}

export function loadArchiveSettings(context: CliContext): GuiArchiveSettings {
  try {
    const path = settingsPathFor(context);
    if (!existsSync(path)) return normalizeArchiveSettings(undefined);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { archive?: unknown };
    return normalizeArchiveSettings(raw.archive);
  } catch {
    return normalizeArchiveSettings(undefined);
  }
}

function archiveRuntime(context: CliContext): ArchiveRuntime {
  return {
    homeDir: context.runtime.homeDir,
    platform: context.runtime.platform,
    env: context.runtime.env,
    dataDir: runtimeDataRoot(context.runtime),
  };
}

function archiveDirFor(
  context: CliContext,
  settings: GuiArchiveSettings,
  flag?: string,
): string {
  return resolveArchiveDir(
    flag ?? context.runtime.env.ROAMGATE_ARCHIVE_DIR?.trim() ?? settings.dir,
    runtimeDataRoot(context.runtime),
    (message) => context.log(message),
  );
}

function indexBytes(dir: string): number {
  let total = 0;
  for (const name of ["index.sqlite", "index.sqlite-wal"]) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // Not there.
    }
  }
  return total;
}

const COMMON = {
  dir: { type: "string" },
  json: { type: "boolean" },
} as const;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

export function createArchiveCommand(
  options: ArchiveCommandOptions = {},
): CliCommand {
  const exec = options.exec ?? defaultExec;
  const write =
    options.write ??
    (async (chunk: Uint8Array) => {
      if (!process.stdout.write(chunk))
        await new Promise<void>((resolve) =>
          process.stdout.once("drain", resolve),
        );
    });
  return {
    name: "archive",
    summary: "archive and search Claude Code, Codex and Pi sessions",
    actions: [
      "sync",
      "ingest",
      "search",
      "session",
      "cat",
      "resume",
      "health",
      "rebuild-index",
    ],
    flags: [
      "--json",
      "--agent",
      "--host",
      "--project",
      "--since",
      "--until",
      "--dir",
      "--recent",
      "--history",
    ],
    help: archiveHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(archiveHelp());
        return EXIT_OK;
      }
      const json = args.includes("--json");
      try {
        return await run(action, args.slice(1), context);
      } catch (error) {
        if (!json || error instanceof UsageError) throw error;
        context.error(JSON.stringify({ error: (error as Error).message }));
        return EXIT_FAILURE;
      }
    },
  };

  async function run(
    action: string,
    rest: string[],
    context: CliContext,
  ): Promise<number> {
    const settings = loadArchiveSettings(context);
    const runtime = archiveRuntime(context);
    const log = (message: string) => context.error(message);
    switch (action) {
      case "sync": {
        const { values } = parseCommandArgs(rest, {
          ...COMMON,
          host: { type: "string", multiple: true },
          agent: { type: "string", multiple: true },
          "local-only": { type: "boolean" },
          push: { type: "boolean" },
        });
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const syncOptions = {
          settings,
          runtime,
          archiveDir,
          ...(values.host ? { hosts: values.host } : {}),
          ...(values.agent ? { agents: values.agent } : {}),
          localOnly: values["local-only"] === true,
          exec,
          log: values.json ? () => {} : log,
        };
        const started = Date.now();
        if (
          values.push ||
          (settings.push && !values["local-only"] && !values.host)
        ) {
          if (!settings.push)
            throw new UsageError("--push needs archive.push in settings.json");
          const report = await runPush(syncOptions);
          if (values.json)
            printJson(context, {
              push: report,
              seconds: (Date.now() - started) / 1000,
            });
          else
            context.log(
              `push to ${settings.push.target}: ${report.status}${report.message ? ` ${report.message}` : ""}`,
            );
          return EXIT_OK;
        }
        const report = await runSync(syncOptions);
        if (values.json) {
          printJson(context, report);
        } else {
          for (const host of report.hosts) context.log(describeHost(host));
          context.log(`done in ${Math.round(report.seconds)}s`);
        }
        const errors = report.hosts.reduce(
          (sum, host) =>
            sum +
            Object.values(host.agents).reduce((n, stats) => n + stats.error, 0),
          0,
        );
        return errors > 0 ? EXIT_FAILURE : EXIT_OK;
      }
      case "ingest": {
        const { values, positionals } = parseCommandArgs(rest, COMMON, 1);
        const host = positionals[0];
        if (!host) throw new UsageError("ingest needs a host name");
        const report = await runIngest({
          settings,
          runtime,
          archiveDir: archiveDirFor(context, settings, values.dir),
          host,
          exec,
          log: values.json ? () => {} : log,
        });
        if (values.json) printJson(context, report);
        else context.log(describeHost(report));
        return EXIT_OK;
      }
      case "search": {
        const { values, positionals } = parseCommandArgs(
          rest,
          {
            ...COMMON,
            agent: { type: "string" },
            host: { type: "string" },
            project: { type: "string" },
            role: { type: "string" },
            kind: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            recent: { type: "boolean" },
            history: { type: "boolean" },
            limit: { type: "string", short: "n" },
            remote: { type: "string" },
          },
          200,
        );
        if (positionals.length === 0)
          throw new UsageError("search needs terms");
        const limit = values.limit ? Number(values.limit) : 15;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500)
          throw new UsageError("-n must be 1 to 500");
        const remote = values.remote ?? settings.remote;
        const archiveDir = archiveDirFor(context, settings, values.dir);
        if (remote && !existsSync(join(archiveDir, "index.sqlite")))
          return passThrough(context, remote, [
            "search",
            ...rest.filter(
              (a, i) => a !== "--remote" && rest[i - 1] !== "--remote",
            ),
          ]);
        const db = await openOrRebuild(archiveDir, log, settings);
        try {
          const result = searchArchive(
            db,
            {
              terms: positionals,
              ...(values.agent ? { agent: values.agent } : {}),
              ...(values.host ? { host: values.host } : {}),
              ...(values.project ? { project: values.project } : {}),
              ...(values.role ? { role: values.role } : {}),
              ...(values.kind ? { kind: values.kind } : {}),
              ...(values.since ? { since: values.since } : {}),
              ...(values.until ? { until: values.until } : {}),
              recent: values.recent === true,
              history: values.history === true,
              limit,
            },
            settings,
          );
          if (values.json) {
            printJson(context, result);
            return EXIT_OK;
          }
          if (result.warning) context.error(`warning: ${result.warning}`);
          for (const hit of result.hits) {
            context.log(
              `${(hit.ts ?? "-").slice(0, 19)}  ${hit.session.slice(0, 8)}${hit.subagent ? " (subagent)" : ""}  ${hit.host}/${hit.agent}  ${hit.project.slice(-40)}`,
            );
            if (hit.title) context.log(`    title: ${hit.title}`);
            context.log(
              `    ${hit.role}/${hit.kind}${hit.tool ? `/${hit.tool}` : ""}: ${hit.snippet}`,
            );
          }
          for (const entry of result.history ?? [])
            context.log(
              `${entry.ts ?? "-"}  history  ${entry.host}  ${entry.project ?? ""}\n    ${entry.snippet}`,
            );
          context.log(
            `-- ${result.hits.length} of ${result.total} hit(s)${result.truncated ? " (truncated)" : ""}`,
          );
          return EXIT_OK;
        } finally {
          db.close(false);
        }
      }
      case "session":
      case "cat":
      case "resume": {
        const { values, positionals } = parseCommandArgs(
          rest,
          {
            ...COMMON,
            agent: { type: "string" },
            host: { type: "string" },
            file: { type: "string" },
            "from-line": { type: "string" },
            limit: { type: "string" },
            "dry-run": { type: "boolean" },
            remote: { type: "string" },
          },
          1,
        );
        const id = positionals[0];
        if (!id) throw new UsageError(`${action} needs a session id`);
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const self = resolveHosts(settings, runtime)[0] as ResolvedHost;
        const remote = values.remote ?? settings.remote;
        const lookupOptions = {
          ...(values.agent ? { agent: values.agent } : {}),
          ...(values.host ? { host: values.host } : {}),
          runtime,
          self,
        };
        let lookup: SessionLookup;
        let useRemote = false;
        if (existsSync(join(archiveDir, "index.sqlite")) && !values.remote) {
          const db = await openOrRebuild(archiveDir, log, settings);
          try {
            lookup = lookupSession(db, id, lookupOptions);
          } finally {
            db.close(false);
          }
        } else if (remote && action === "resume") {
          lookup = await remoteLookup(remote, id, values, runtime, self, exec);
          useRemote = true;
        } else {
          throw new Error(
            "no archive here; set archive.remote or pass --remote SSH",
          );
        }
        if (action === "session") {
          if (values.json) printJson(context, lookup);
          else context.log(describeLookup(lookup));
          return lookup.found ? EXIT_OK : EXIT_FAILURE;
        }
        if (!lookup.found) {
          const message = lookup.candidates
            ? `ambiguous session id: ${lookup.candidates.map((c) => `${c.agent}:${c.session}`).join(", ")}`
            : `session ${id} not found in the archive`;
          throw new Error(message);
        }
        if (action === "cat") {
          const chunks = catFile(archiveDir, lookup, values.file);
          if (values["from-line"] !== undefined || values.limit !== undefined) {
            const from = Number(values["from-line"] ?? 1);
            const limit = Number(values.limit ?? 50);
            if (
              !Number.isInteger(from) ||
              from < 1 ||
              !Number.isInteger(limit) ||
              limit < 1
            )
              throw new UsageError(
                "--from-line and --limit must be positive integers",
              );
            const slice = await catLines(chunks, from, limit, 1_000_000);
            await write(
              Buffer.from(slice.lines.map((line) => `${line}\n`).join("")),
            );
            return EXIT_OK;
          }
          for await (const chunk of chunks) await write(chunk);
          return EXIT_OK;
        }
        const result = await resumeSession(lookup, {
          runtime,
          self,
          source: useRemote
            ? sshFileSource(remote as string)
            : localFileSource(archiveDir),
          dryRun: values["dry-run"] === true,
          ...(options.now ? { now: options.now() } : {}),
        });
        if (values.json) printJson(context, result);
        else context.log(result.message);
        return EXIT_OK;
      }
      case "health": {
        const { values } = parseCommandArgs(rest, {
          ...COMMON,
          check: { type: "boolean" },
        });
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const db = await openOrRebuild(archiveDir, log, settings);
        try {
          const health = archiveHealth(
            db,
            archiveDir,
            settings,
            runtime,
            indexBytes(archiveDir),
            options.now?.(),
          );
          if (values.json) printJson(context, health);
          else {
            for (const host of health.hosts)
              context.log(
                `${host.host}: ${host.files} files, ${host.sessions} sessions, last sync ${host.last_sync ?? "never"}${host.stale ? " (STALE)" : ""}${host.agents.map((a) => `\n  ${a.agent}: ${a.files} files, ${a.last_sync ?? "never"}`).join("")}`,
              );
            context.log(
              `docs ${health.totals.docs}, history ${health.totals.history}, raw ${megabytes(health.sizes.raw_bytes)}, index ${megabytes(health.sizes.index_bytes)}, free ${health.disk.free_gb ?? "?"} GB`,
            );
            for (const warning of health.warnings)
              context.log(`warning: ${warning}`);
            const unknown = Object.entries(health.unknown_types);
            if (unknown.length)
              context.log(
                `unrecognised record types (not indexed): ${unknown.map(([k, n]) => `${k}=${n}`).join(", ")}`,
              );
          }
          return values.check && !health.ok ? EXIT_FAILURE : EXIT_OK;
        } finally {
          db.close(false);
        }
      }
      case "rebuild-index": {
        const { values } = parseCommandArgs(rest, COMMON);
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const db = await rebuildIndex(
          archiveDir,
          settings,
          values.json ? () => {} : log,
        );
        db.close(false);
        context.log(
          values.json ? JSON.stringify({ rebuilt: true }) : "index rebuilt",
        );
        return EXIT_OK;
      }
      default:
        throw new UsageError(`unknown archive action: ${action}`);
    }
  }

  async function passThrough(
    context: CliContext,
    ssh: string,
    args: string[],
  ): Promise<number> {
    const binary = '"$HOME/.local/bin/roamgate"';
    const result = await exec(
      [
        "ssh",
        ...SSH_OPTIONS,
        ssh,
        `exec ${binary} archive ${args.map(shQuote).join(" ")}`,
      ],
      120_000,
    );
    if (result.stdout) context.log(result.stdout.replace(/\n$/, ""));
    if (result.code !== 0) context.error(result.stderr.trim());
    return result.code === 0 ? EXIT_OK : EXIT_FAILURE;
  }

  async function remoteLookup(
    ssh: string,
    id: string,
    values: { agent?: string; host?: string },
    runtime: ArchiveRuntime,
    self: ResolvedHost,
    runner: Exec,
  ): Promise<SessionLookup> {
    const args = [
      "session",
      id,
      "--json",
      ...(values.agent ? ["--agent", values.agent] : []),
      ...(values.host ? ["--host", values.host] : []),
    ];
    const result = await runner(
      [
        "ssh",
        ...SSH_OPTIONS,
        ssh,
        `exec "$HOME/.local/bin/roamgate" archive ${args.map(shQuote).join(" ")}`,
      ],
      120_000,
    );
    let lookup: SessionLookup;
    try {
      lookup = JSON.parse(result.stdout) as SessionLookup;
    } catch {
      throw new Error(
        `ssh ${ssh}: archive session failed: ${result.stderr.trim().slice(0, 200)}`,
      );
    }
    // Liveness is about this machine, not the archive's.
    const adapter = lookup.agent ? ADAPTERS[lookup.agent] : undefined;
    const main = lookup.files.find((f) => !f.subagent);
    if (adapter && main && lookup.found) {
      const { localRoot } = await import("../archive/hosts");
      const target = adapter.restoreRelpath({
        relpath: main.relpath,
        session: lookup.session,
        sourceHome: null,
        targetHome: runtime.homeDir,
      });
      lookup.live = existsSync(join(localRoot(adapter, self, runtime), target));
      lookup.restorable = adapter.supportsResume && !lookup.live;
    }
    return lookup;
  }
}

function describeHost(report: HostReport): string {
  const parts = Object.entries(report.agents).map(
    ([agent, s]) =>
      `${agent} new ${s.new} grown ${s.grown} same ${s.same} shrunk ${s.shrunk} replaced ${s.replaced} errors ${s.error} docs ${s.docs}`,
  );
  const unknown = Object.entries(report.agents).flatMap(([, s]) =>
    Object.entries(s.unknown),
  );
  return [
    `${report.host}: ${report.status}${report.message ? ` (${report.message})` : ""}`,
    ...parts.map((p) => `  ${p}`),
    ...(unknown.length
      ? [
          `  unrecognised record types (not indexed): ${unknown.map(([k, n]) => `${k}=${n}`).join(", ")}`,
        ]
      : []),
  ].join("\n");
}

function describeLookup(lookup: SessionLookup): string {
  if (!lookup.found)
    return lookup.candidates
      ? `ambiguous: ${lookup.candidates.map((c) => `${c.agent}:${c.session}`).join(", ")}`
      : `session ${lookup.session} not found`;
  return [
    `${lookup.agent} ${lookup.session}${lookup.title ? `  ${lookup.title}` : ""}`,
    `  host ${lookup.host}, project ${lookup.project}, cwd ${lookup.cwd ?? "?"}`,
    `  ${lookup.first_ts ?? "?"} to ${lookup.last_ts ?? "?"}, ${lookup.files.length} file(s), ${lookup.copies.length} copy(ies)`,
    `  live here: ${lookup.live}, restorable: ${lookup.restorable}${lookup.resume ? `, resume: ${lookup.resume}` : ""}`,
  ].join("\n");
}

export const archiveCommand = createArchiveCommand();

/** The session archive's health as a `roamgate doctor` check. */
export function archiveCheck(context: CliContext, now = new Date()) {
  const settings = loadArchiveSettings(context);
  const archiveDir = archiveDirFor(context, settings);
  if (!existsSync(join(archiveDir, "index.sqlite")))
    return {
      name: "Archive",
      status: "skip" as const,
      detail: "not set up (roamgate archive sync)",
    };
  try {
    const opened = openArchiveDb(archiveDir, { readonly: true });
    if (opened.needsRebuild) {
      opened.db.close(false);
      return {
        name: "Archive",
        status: "warn" as const,
        detail: "the index needs a rebuild",
        hint: "Run `roamgate archive rebuild-index`.",
      };
    }
    try {
      const health = archiveHealth(
        opened.db,
        archiveDir,
        settings,
        archiveRuntime(context),
        indexBytes(archiveDir),
        now,
      );
      return health.ok
        ? {
            name: "Archive",
            status: "ok" as const,
            detail: `${health.totals.sessions} sessions on ${health.hosts.length} host(s), all synced within ${settings.stale_hours} hours`,
          }
        : {
            name: "Archive",
            status: "warn" as const,
            detail: health.warnings.join("; "),
            hint: "Run `roamgate archive sync` and `roamgate archive health`.",
          };
    } finally {
      opened.db.close(false);
    }
  } catch (error) {
    return {
      name: "Archive",
      status: "fail" as const,
      detail: (error as Error).message,
    };
  }
}
