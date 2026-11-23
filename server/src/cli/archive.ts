import { existsSync, readFileSync, statSync } from "node:fs";
import { setPriority } from "node:os";
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
  rebuildArchiveDb,
  runIngest,
  runPush,
  runSync,
  openOrRebuild,
  type HostReport,
} from "../archive/engine";
import { archiveHealth } from "../archive/health";
import {
  archiveDbPath,
  existingArchiveDb,
  openArchiveDb,
} from "../archive/store";
import {
  NoTextRepo,
  type SearchQuery,
  type SearchResult,
  searchArchive,
} from "../archive/search";
import {
  fetchTextRepo,
  rebuildTextRepo,
  type TextPassReport,
  textRepoAgeMs,
  textRepoPath,
  textRepoStatus,
  updateTextRepo,
} from "../archive/text-repo";
import { gameModeActive } from "../utils/gamemode";
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
                          [--recent] [--history] [--regex] [--tool-output]
                          [-n N] [--json]
  roamgate archive session <id> [--agent A] [--host H] [--json]
  roamgate archive cat <id> [--agent A] [--host H] [--file RELPATH]
                       [--from-line N --limit N]
  roamgate archive resume <id> [--agent A] [--host H] [--remote SSH]
                          [--dry-run] [--json]
  roamgate archive health [--check] [--json]
  roamgate archive status [--json]
  roamgate archive rebuild-text [--now] [--json]
  roamgate archive fetch-text [--remote SSH] [--json]
  roamgate archive rebuild-db

sync copies, compresses and indexes this machine's agent sessions, then
pulls every configured ssh host (unreachable hosts are recorded and skipped).
With --push (or archive.push in settings) it sends this machine's files to the
archive home and has it index them. Files under raw/ are the source of truth
and are never deleted; archive.sqlite (what each file holds, when each host
synced) is rebuilt from them by rebuild-db. After
each sync the conversation text goes into text.git (one commit, deferred while
GameMode runs); rebuild-text builds it again from raw/, status shows it.
search greps that text: substrings, case-insensitive, every word in one
message ("phrases", OR, NOT), or a Perl regex with --regex; one line per
session, most matching messages first (--recent: newest first), including
this machine's sessions grown since the last commit. Tool output is only
searched with --tool-output, which reads all of raw/ (slow). fetch-text
copies the archive home's text repo (archive.remote) for local search. cat
prints a session byte-identical to the original. resume restores a session into this
machine's agent directory only where it does not exist, never overwriting.
health reports the last sync per host and agent and warns when stale
(--check exits 1 on any warning). Settings live under "archive" in
settings.json; --dir or ROAMGATE_ARCHIVE_DIR overrides the archive location.
`;
}

export type ArchiveCommandOptions = {
  exec?: Exec;
  /** Whether GameMode runs (default: ask gamemoded). */
  gameMode?: () => Promise<boolean | null>;
  /** The ssh program for fetch-text (tests run a local stand-in). */
  sshProgram?: string;
  /** Lowers this process's priority before a rebuild (default: nice 19). */
  lowerPriority?: () => void;
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

function dbBytes(dir: string): number {
  let total = 0;
  const path = existingArchiveDb(dir) ?? archiveDbPath(dir);
  for (const file of [path, `${path}-wal`]) {
    try {
      total += statSync(file).size;
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
  const gameMode = options.gameMode ?? (() => gameModeActive());
  const sshProgram = options.sshProgram ?? "ssh";
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
      "status",
      "rebuild-text",
      "fetch-text",
      "rebuild-db",
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
      "--regex",
      "--tool-output",
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
          let fetched: string;
          try {
            const result = fetchTextRepo(
              archiveDir,
              settings.push.target,
              SSH_OPTIONS,
              settings.push.archive_dir,
              sshProgram,
            );
            fetched = result.updated ? "updated" : "unchanged";
          } catch (error) {
            fetched = `not fetched: ${(error as Error).message}`;
          }
          if (values.json)
            printJson(context, {
              push: report,
              text_fetch: fetched,
              seconds: (Date.now() - started) / 1000,
            });
          else
            context.log(
              `push to ${settings.push.target}: ${report.status}${report.message ? ` ${report.message}` : ""}\ntext repo: ${fetched}`,
            );
          return EXIT_OK;
        }
        const report = await runSync(syncOptions);
        const text = await textPass(
          archiveDir,
          settings,
          runtime,
          syncOptions.log,
          gameMode,
        );
        if (values.json) {
          printJson(context, { ...report, text });
        } else {
          for (const host of report.hosts) context.log(describeHost(host));
          context.log(describeText(text));
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
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const report = await runIngest({
          settings,
          runtime,
          archiveDir,
          host,
          exec,
          log: values.json ? () => {} : log,
        });
        const text = await textPass(
          archiveDir,
          settings,
          runtime,
          values.json ? () => {} : log,
          gameMode,
        );
        if (values.json) printJson(context, { ...report, text });
        else context.log(`${describeHost(report)}\n${describeText(text)}`);
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
            regex: { type: "boolean" },
            "tool-output": { type: "boolean" },
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
        const hasText = existsSync(join(textRepoPath(archiveDir), "HEAD"));
        const hasIndex = existingArchiveDb(archiveDir) !== null;
        if (remote && !hasIndex && !values["tool-output"]) {
          // A machine without its own archive: the home's text repo, fetched.
          if (textRepoAgeMs(archiveDir) > TEXT_FETCH_EVERY_MS)
            try {
              fetchTextRepo(
                archiveDir,
                remote,
                SSH_OPTIONS,
                settings.remote_dir,
                sshProgram,
              );
            } catch (error) {
              if (!hasText) {
                log(
                  `could not fetch the text repo: ${(error as Error).message}`,
                );
                return passThrough(context, remote, [
                  "search",
                  ...rest.filter(
                    (a, i) => a !== "--remote" && rest[i - 1] !== "--remote",
                  ),
                ]);
              }
              log(
                `searching the last fetched text: ${(error as Error).message}`,
              );
            }
        } else if (remote && !hasIndex && !hasText)
          return passThrough(context, remote, [
            "search",
            ...rest.filter(
              (a, i) => a !== "--remote" && rest[i - 1] !== "--remote",
            ),
          ]);
        const query: SearchQuery = {
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
          regex: values.regex === true,
          toolOutput: values["tool-output"] === true,
          limit,
        };
        let result: SearchResult;
        if (query.toolOutput && !values.json)
          context.error(
            "searching tool output reads every archived transcript in raw/: this is slow",
          );
        let shown = -1;
        try {
          result = await searchArchive(archiveDir, query, settings, {
            runtime,
            onProgress: (done, total) => {
              const percent = Math.floor((done * 100) / Math.max(1, total));
              if (values.json || percent < shown + 10) return;
              shown = percent;
              context.error(`  ${percent}% of ${total} files`);
            },
          });
        } catch (error) {
          if (error instanceof NoTextRepo)
            throw new Error(error.message, { cause: error });
          throw error;
        }
        if (values.json) {
          printJson(context, result);
          return EXIT_OK;
        }
        if (result.warning) context.error(`warning: ${result.warning}`);
        for (const hit of result.hits) {
          context.log(
            `${(hit.ts ?? "-").slice(0, 19)}  ${hit.session.slice(0, 8)}${hit.subagent ? " (subagent)" : ""}  ${hit.host}/${hit.agent}  ${hit.project.slice(-40)}${hit.matches ? `  ${hit.matches} match(es)` : ""}`,
          );
          if (hit.title) context.log(`    title: ${hit.title}`);
          const snippets = hit.snippets?.length ? hit.snippets : [hit.snippet];
          if (hit.snippets?.length)
            for (const snippet of snippets) context.log(`    ${snippet}`);
          else
            context.log(
              `    ${hit.role}/${hit.kind}${hit.tool ? `/${hit.tool}` : ""}: ${hit.snippet}`,
            );
        }
        for (const entry of result.history ?? [])
          context.log(
            `${entry.ts ?? "-"}  history  ${entry.host}  ${entry.project ?? ""}\n    ${entry.snippet}`,
          );
        context.log(
          result.sessions !== undefined
            ? `-- ${result.hits.length} of ${result.sessions} session(s), ${result.total} matching message(s)`
            : `-- ${result.hits.length} of ${result.total} hit(s)${result.truncated ? " (truncated)" : ""}`,
        );
        return EXIT_OK;
      }
      case "status": {
        const { values } = parseCommandArgs(rest, COMMON);
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const status = textRepoStatus(archiveDir, settings);
        if (values.json) printJson(context, { text: status });
        else if (!status.exists)
          context.log(
            `text repo: none yet at ${status.path} (built by the next sync, or \`roamgate archive rebuild-text\`)`,
          );
        else
          context.log(
            [
              `text repo: ${status.path}`,
              `  ${status.files} file(s), ${megabytes(status.pack_bytes)}, last commit ${status.last_commit ?? "never"}, last repack ${status.last_repack ?? "never"}`,
              `  secret-looking values redacted: ${status.redactions}`,
              ...(status.stale_render
                ? [
                    "  the render settings changed: run `roamgate archive rebuild-text`",
                  ]
                : []),
            ].join("\n"),
          );
        return EXIT_OK;
      }
      case "rebuild-text": {
        const { values } = parseCommandArgs(rest, {
          ...COMMON,
          now: { type: "boolean" },
        });
        const archiveDir = archiveDirFor(context, settings, values.dir);
        if (!values.now && (await gameMode()) === true) {
          context.error(
            "GameMode runs: the rebuild waits for the game to end (--now builds anyway, at the lowest priority)",
          );
          return EXIT_TEMPFAIL;
        }
        (options.lowerPriority ?? lowerPriority)();
        const report = await rebuildTextRepo({
          archiveDir,
          settings,
          host: resolveHosts(settings, runtime)[0]?.id ?? "host",
          log: values.json ? () => {} : log,
        });
        if (values.json) printJson(context, { text: report });
        else context.log(describeText(report));
        return report.status === "locked" ? EXIT_FAILURE : EXIT_OK;
      }
      case "fetch-text": {
        const { values } = parseCommandArgs(rest, {
          ...COMMON,
          remote: { type: "string" },
        });
        const remote =
          values.remote ?? settings.remote ?? settings.push?.target;
        if (!remote)
          throw new UsageError(
            "fetch-text needs archive.remote (or --remote SSH): the archive home",
          );
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const report = fetchTextRepo(
          archiveDir,
          remote,
          SSH_OPTIONS,
          values.remote
            ? undefined
            : (settings.remote_dir ?? settings.push?.archive_dir),
          sshProgram,
        );
        if (values.json) printJson(context, { fetch: report });
        else
          context.log(
            `text repo from ${remote}: ${report.updated ? "updated" : "unchanged"} (${report.head?.slice(0, 12) ?? "empty"})`,
          );
        return EXIT_OK;
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
        if (existingArchiveDb(archiveDir) && !values.remote) {
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
            dbBytes(archiveDir),
            options.now?.(),
          );
          if (values.json) printJson(context, health);
          else {
            for (const host of health.hosts)
              context.log(
                `${host.host}: ${host.files} files, ${host.sessions} sessions, last sync ${host.last_sync ?? "never"}${host.stale ? " (STALE)" : ""}${host.agents.map((a) => `\n  ${a.agent}: ${a.files} files, ${a.last_sync ?? "never"}`).join("")}`,
              );
            context.log(
              `${health.totals.sessions} sessions, raw ${megabytes(health.sizes.raw_bytes)}, database ${megabytes(health.sizes.db_bytes)}, free ${health.disk.free_gb ?? "?"} GB`,
            );
            context.log(
              health.text.exists
                ? `text repo: ${health.text.files} file(s), ${megabytes(health.text.pack_bytes)}, last commit ${health.text.last_commit ?? "never"}`
                : "text repo: none yet (built by the next sync)",
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
      case "rebuild-db":
      case "rebuild-index": {
        const { values } = parseCommandArgs(rest, COMMON);
        const archiveDir = archiveDirFor(context, settings, values.dir);
        const db = await rebuildArchiveDb(
          archiveDir,
          settings,
          values.json ? () => {} : log,
        );
        db.close(false);
        context.log(
          values.json
            ? JSON.stringify({ rebuilt: true })
            : "archive database rebuilt",
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

/** Between two fetches of the archive home's text repo, at most. */
const TEXT_FETCH_EVERY_MS = 10 * 60 * 1000;
/** sysexits' EX_TEMPFAIL: try again later. */
const EXIT_TEMPFAIL = 75;

/** Background work: the lowest CPU priority (the timer adds idle I/O). */
function lowerPriority(): void {
  try {
    setPriority(19);
  } catch {
    // Not permitted here: as is.
  }
}

/** The hourly text pass after a sync, deferred while GameMode runs. */
async function textPass(
  archiveDir: string,
  settings: GuiArchiveSettings,
  runtime: ArchiveRuntime,
  log: (message: string) => void,
  gameMode: () => Promise<boolean | null>,
): Promise<TextPassReport | { status: "failed"; message: string }> {
  try {
    return await updateTextRepo({
      archiveDir,
      settings,
      host: resolveHosts(settings, runtime)[0]?.id ?? "host",
      log,
      busy: async () => (await gameMode()) === true,
    });
  } catch (error) {
    return { status: "failed", message: (error as Error).message };
  }
}

function describeText(
  report: TextPassReport | { status: "failed"; message: string },
): string {
  if (report.status === "failed") return `text repo: failed: ${report.message}`;
  if (report.status !== "committed")
    return `text repo: ${report.status}${report.message ? ` (${report.message})` : ""}`;
  return `text repo: ${report.files} file(s), ${report.lines} line(s) committed${report.redactions ? `, ${report.redactions} secret(s) redacted` : ""}${report.repacked ? ", repacked" : ""} in ${report.seconds.toFixed(1)}s`;
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
  if (!existingArchiveDb(archiveDir))
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
        detail: "the archive database needs a rebuild",
        hint: "Run `roamgate archive rebuild-db`.",
      };
    }
    try {
      const health = archiveHealth(
        opened.db,
        archiveDir,
        settings,
        archiveRuntime(context),
        dbBytes(archiveDir),
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
