import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryStatus } from "../../../shared/history";
import type { ReviewSession, ReviewThread } from "../../../shared/review";
import { formatBytes } from "../../../shared/voiceSetup";
import { historyPaths, type ReviewSource } from "../history/area";
import { historyAreas, historyHost, historyPlace } from "../history/place";
import { HistoryRepo } from "../history/repo";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  printJson,
  wantsHelp,
} from "./command";
import { readServiceSetup } from "./service-context";

function historyHelp(): string {
  return `Local history: a git repository of what was authored in Roamgate.

Usage:
  roamgate history status [--json]
  roamgate history commit [--json]

status shows where the history repository is, whether it is written, its
last commit, its size, how many files each area has, and what the last
pass kept out (a secret found in a file) or could not write.

commit writes every area now and commits what changed, as the server does
on its own 30 seconds after a change (at most 5 minutes after the first).
It waits for nothing: run while the server runs, the two take turns.

The repository is <data>/history unless Settings, History and backup, sets
another location. ROAMGATE_HISTORY=off turns it off by default (test
servers); the setting can turn it on again.
`;
}

/** The service's environment over this one: the paths the server uses. */
function environmentOf(
  context: CliContext,
): Record<string, string | undefined> {
  let service: Record<string, string> = {};
  try {
    service = readServiceSetup(context.runtime).env;
  } catch {
    // No usable service file: this environment.
  }
  return { ...context.runtime.env, ...service };
}

function readSettings(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** The review store, read only (the server may have it open). */
function reviewSource(dir: string): ReviewSource & { close(): void } {
  const path = join(dir, "reviews.sqlite");
  if (!existsSync(path))
    return { loadSessions: () => [], loadThreads: () => [], close() {} };
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const parse = <T>(rows: { data: string }[]): T[] =>
    rows.flatMap((row) => {
      try {
        return [JSON.parse(row.data) as T];
      } catch {
        return [];
      }
    });
  const sessions = db.query<{ data: string }, []>(
    "SELECT data FROM sessions ORDER BY updated_at",
  );
  const threads = db.query<{ data: string }, [string]>(
    "SELECT data FROM threads WHERE session_id = ? ORDER BY created_at, id",
  );
  return {
    loadSessions: () => parse<ReviewSession>(sessions.all()),
    loadThreads: (id) =>
      parse<ReviewThread>(threads.all(id)).filter(
        (thread) => thread.sessionId === id,
      ),
    close: () => db.close(),
  };
}

function setup(context: CliContext) {
  const env = environmentOf(context);
  const paths = historyPaths(
    env,
    context.runtime.homeDir,
    context.runtime.platform,
    context.runtime.appDataDir,
  );
  const place = historyPlace(
    readSettings(paths.settings) as never,
    paths.data,
    env,
    context.runtime.homeDir,
  );
  return { paths, place };
}

export function describeStatus(
  status: HistoryStatus,
  show: (path: string) => string = (path) => path,
): string[] {
  const lines = [
    `Local history: ${status.enabled ? "on" : "off"}`,
    `Location: ${show(status.location)}${status.location === status.defaultLocation ? " (default)" : ""}`,
  ];
  if (!status.exists) {
    lines.push("No repository there yet.");
    return lines;
  }
  lines.push(
    status.lastCommit
      ? `Last commit: ${status.lastCommit.at} ${status.lastCommit.sha.slice(0, 10)} ${status.lastCommit.subject}`
      : "No commit yet.",
    `Commits: ${status.commits}, size ${formatBytes(status.sizeBytes)}`,
  );
  const areas = Object.entries(status.files).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (areas.length)
    lines.push(`Files: ${areas.map(([area, n]) => `${area} ${n}`).join(", ")}`);
  if (status.lastPass)
    lines.push(
      `Last pass: ${status.lastPass.at}, ${status.lastPass.commits} commit${status.lastPass.commits === 1 ? "" : "s"}, ${status.lastPass.ms} ms`,
    );
  if (status.pending.length)
    lines.push(`Waiting: ${status.pending.join(", ")}`);
  if (status.deferred) lines.push(`Deferred: ${status.deferred}`);
  for (const hit of status.blocked)
    lines.push(
      `Kept out: ${hit.file}:${hit.line} holds a secret (${hit.kind}); remove it from where it was written`,
    );
  for (const error of status.errors)
    lines.push(
      `Error${error.area ? ` (${error.area})` : ""}: ${error.message}`,
    );
  return lines;
}

export function createHistoryCommand(
  options: { host?: string } = {},
): CliCommand {
  return {
    name: "history",
    summary: "show or commit the local history of what was authored",
    actions: ["status", "commit"],
    flags: ["--json"],
    help: historyHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(historyHelp());
        return EXIT_OK;
      }
      const json = args.includes("--json");
      const unknown = args.slice(1).filter((arg) => arg !== "--json");
      if (unknown.length) {
        context.error(`Unknown argument: ${unknown[0]}`);
        return EXIT_USAGE;
      }
      const { paths, place } = setup(context);
      const host = options.host ?? historyHost();
      const repo = new HistoryRepo({ dir: place.location, host });
      const statusOf = async (): Promise<HistoryStatus> => ({
        enabled: place.enabled,
        location: place.location,
        defaultLocation: place.defaultLocation,
        ...(await repo.status()),
        pending: [],
        running: false,
        deferred: null,
      });
      const show = (path: string) => displayPath(path, context.runtime);
      if (action === "status") {
        const status = await statusOf();
        if (json) printJson(context, status);
        else for (const line of describeStatus(status, show)) context.log(line);
        return EXIT_OK;
      }
      if (action === "commit") {
        if (!place.enabled) {
          context.error(
            "Local history is off (Settings, History and backup, or ROAMGATE_HISTORY).",
          );
          return EXIT_FAILURE;
        }
        const reviews = reviewSource(paths.reviews);
        try {
          const result = await repo.pass({
            areas: historyAreas(paths, () => reviews).map((area) => ({
              area,
              ids: null,
            })),
          });
          if (json) {
            printJson(context, { ...result, status: await statusOf() });
            return result.errors.length || result.locked
              ? EXIT_FAILURE
              : EXIT_OK;
          }
          if (result.locked) {
            context.error(
              "Another pass is running (the server's): try again in a moment.",
            );
            return EXIT_FAILURE;
          }
          context.log(
            result.commits
              ? `Committed in ${show(place.location)} (${result.commits} commit${result.commits === 1 ? "" : "s"}).`
              : `Nothing changed in ${show(place.location)}.`,
          );
          for (const hit of result.blocked)
            context.log(
              `Kept out: ${hit.file}:${hit.line} holds a secret (${hit.kind})`,
            );
          for (const error of result.errors)
            context.error(
              `Error${error.area ? ` (${error.area})` : ""}: ${error.message}`,
            );
          return result.errors.length ? EXIT_FAILURE : EXIT_OK;
        } finally {
          reviews.close();
        }
      }
      context.error(`Unknown history action: ${action}`);
      return EXIT_USAGE;
    },
  };
}
