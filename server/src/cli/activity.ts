import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventKind } from "../activity/protocol";
import {
  type ActivityReader,
  eventSeq,
  openActivityReader,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
} from "../activity/reader";
import { activityStoragePath } from "../activity/store";
import {
  dayBounds,
  isDate,
  type Timeline,
  timelineRange,
} from "../activity/timeline";
import { roamgateEnv } from "../config/environment";
import {
  type GuiActivitySettings,
  normalizeActivitySettings,
} from "../config/gui-settings";
import {
  type CliCommand,
  type CliContext,
  displayPath,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  parseCommandArgs,
  UsageError,
  wantsHelp,
} from "./command";
import { readServiceSetup, runtimeDataRoot } from "./service-context";

const KINDS: readonly EventKind[] = [
  "workspace.focus",
  "workspace.blur",
  "agent.state",
  "session.idle",
  "session.active",
  "ui.visibility",
];

function activityHelp(): string {
  return `Read the activity log (docs/activity.md), without the server.

Usage:
  roamgate activity today [--json]
  roamgate activity day <YYYY-MM-DD> [--json]
  roamgate activity range <from> <to> [--json]
  roamgate activity events [--after ID] [--from T] [--to T]
                           [--connection ID] [--workspace ID]
                           [--kind K[,K...]] [--limit N] [--json | --ndjson]
  roamgate activity workspaces [--from T] [--to T] [--connection ID] [--json]
  roamgate activity status [--json]

today, day and range print attended time and agent working and blocked
time per workspace; with --json, the timeline (days of spans and totals).
Days start at the activity.day_start setting, in local time.

events prints events in log (id) order. --after resumes after an event id
(a page's next_cursor); ts is not monotonic in id order. --from and --to are
dates or ISO 8601 times. --limit defaults to ${PAGE_LIMIT_DEFAULT}, at most ${PAGE_LIMIT_MAX}.
--json prints an ActivityPage, --ndjson one Event per line.

status says whether the log is recording, the recorder's last alive stamp,
each connection's state and today's recording gaps.

Connections listed in activity.exclude.connections are left out of
everything but status. The log is opened read-only.
`;
}

type Format = "text" | "json" | "ndjson";

function activitySettingsFor(context: CliContext): GuiActivitySettings {
  let path: string | undefined;
  try {
    path = roamgateEnv("SETTINGS_PATH", readServiceSetup(context.runtime).env);
  } catch {
    // No usable service file: the default location.
  }
  path ??=
    roamgateEnv("SETTINGS_PATH", context.runtime.env) ??
    join(runtimeDataRoot(context.runtime), "settings.json");
  try {
    if (!existsSync(path)) return normalizeActivitySettings(undefined);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return normalizeActivitySettings(parsed?.activity);
  } catch {
    return normalizeActivitySettings(undefined);
  }
}

/** A date (its day start) or an ISO 8601 time, as epoch ms. */
function parseTime(
  value: string | undefined,
  flag: string,
  dayStart: string,
  end = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (isDate(value)) {
    const bounds = dayBounds(value, dayStart);
    return end ? bounds.end : bounds.start;
  }
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms))
    throw new UsageError(`${flag} must be a date or an ISO 8601 time`);
  return ms;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, "0")}m` : `${hours}h`;
}

/** Totals summed over the timeline's days, one line per workspace. */
export function timelineSummary(timeline: Timeline): string {
  const names = new Map(
    timeline.workspaces.map((workspace) => [workspace.id, workspace.name]),
  );
  const rows = new Map<
    string,
    { attended: number; herdr: number; working: number; blocked: number }
  >();
  let attended = 0;
  let idle = 0;
  let unrecorded = 0;
  for (const day of timeline.days) {
    attended += day.totals.attended_ms;
    idle += day.totals.idle_ms;
    unrecorded += day.totals.unrecorded_ms;
    for (const entry of day.totals.workspaces) {
      const row = rows.get(entry.workspace_id) ?? {
        attended: 0,
        herdr: 0,
        working: 0,
        blocked: 0,
      };
      row.attended += entry.attended_ms;
      row.herdr += entry.herdr_ms;
      row.working += entry.working_ms;
      row.blocked += entry.blocked_ms;
      rows.set(entry.workspace_id, row);
    }
  }
  const first = timeline.days[0]?.date ?? "";
  const last = timeline.days.at(-1)?.date ?? "";
  const title = first === last ? first : `${first} to ${last}`;
  const lines = [
    `${title}  attended ${formatDuration(attended)}  idle ${formatDuration(idle)}${unrecorded ? `  not recorded ${formatDuration(unrecorded)}` : ""}${timeline.recorder_running ? "" : "  (recorder not running)"}`,
  ];
  if (rows.size === 0) {
    lines.push("  no activity");
    return lines.join("\n");
  }
  const sorted = [...rows.entries()].sort(
    (a, b) => b[1].attended - a[1].attended || b[1].working - a[1].working,
  );
  const label = (id: string) => names.get(id) ?? id;
  const width = Math.max(
    "workspace".length,
    ...sorted.map(([id]) => label(id).length),
  );
  const cell = (ms: number) => (ms ? formatDuration(ms) : "-").padStart(8);
  lines.push(
    `  ${"workspace".padEnd(width)}  ${"attended".padStart(8)}  ${"of herdr".padStart(8)}  ${"working".padStart(8)}  ${"blocked".padStart(8)}`,
  );
  for (const [id, row] of sorted)
    lines.push(
      `  ${label(id).padEnd(width)}  ${cell(row.attended)}  ${cell(row.herdr)}  ${cell(row.working)}  ${cell(row.blocked)}`,
    );
  return lines.join("\n");
}

function formatFlag(values: { json?: boolean; ndjson?: boolean }): Format {
  if (values.json && values.ndjson)
    throw new UsageError("--json and --ndjson are exclusive");
  return values.ndjson ? "ndjson" : values.json ? "json" : "text";
}

export function createActivityCommand(
  options: { now?: () => number } = {},
): CliCommand {
  const now = options.now ?? Date.now;
  return {
    name: "activity",
    summary: "read the activity log: day summaries, events, status",
    actions: ["today", "day", "range", "events", "workspaces", "status"],
    flags: [
      "--json",
      "--ndjson",
      "--after",
      "--from",
      "--to",
      "--connection",
      "--workspace",
      "--kind",
      "--limit",
    ],
    help: activityHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(activityHelp());
        return EXIT_OK;
      }
      const json = args.includes("--json") || args.includes("--ndjson");
      try {
        return run(action, args.slice(1), context);
      } catch (error) {
        if (!json) throw error;
        // Machine readers get the error as JSON too.
        context.error(JSON.stringify({ error: (error as Error).message }));
        return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
      }
    },
  };

  function run(action: string, rest: string[], context: CliContext): number {
    const settings = activitySettingsFor(context);
    const directory = runtimeDataRoot(context.runtime);
    const excluded = settings.exclude.connections;
    const withReader = (use: (reader: ActivityReader) => number) => {
      const reader = openActivityReader(directory, now);
      if (!reader)
        throw new Error(
          `no activity log at ${displayPath(activityStoragePath(directory), context.runtime)}; set activity.enabled in settings.json`,
        );
      try {
        return use(reader);
      } finally {
        reader.close();
      }
    };
    const print = (format: Format, value: unknown, text: () => string) => {
      context.log(format === "text" ? text() : JSON.stringify(value, null, 2));
    };

    if (action === "today" || action === "day" || action === "range") {
      const count = { today: 0, day: 1, range: 2 }[action];
      const { values, positionals } = parseCommandArgs(
        rest,
        { json: { type: "boolean" } },
        count,
      );
      if (positionals.length !== count)
        throw new UsageError(
          action === "day"
            ? "day needs a date, YYYY-MM-DD"
            : "range needs two dates, YYYY-MM-DD",
        );
      let range: { from: number; to: number };
      try {
        range = timelineRange(
          { from: positionals[0], to: positionals[1] ?? positionals[0] },
          now(),
          settings.day_start,
        );
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
      return withReader((reader) => {
        const timeline = reader.timeline(
          range,
          settings.day_start,
          excluded,
          settings.idle_seconds,
        );
        print(formatFlag(values), timeline, () => timelineSummary(timeline));
        return EXIT_OK;
      });
    }

    if (action === "events") {
      const { values } = parseCommandArgs(rest, {
        json: { type: "boolean" },
        ndjson: { type: "boolean" },
        after: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        connection: { type: "string" },
        workspace: { type: "string" },
        kind: { type: "string" },
        limit: { type: "string" },
      });
      const format = formatFlag(values);
      const after =
        values.after === undefined ? undefined : eventSeq(values.after);
      if (after === null) throw new UsageError("--after must be an event id");
      const limit =
        values.limit === undefined ? PAGE_LIMIT_DEFAULT : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX)
        throw new UsageError(`--limit must be 1 to ${PAGE_LIMIT_MAX}`);
      const kinds = values.kind
        ?.split(",")
        .map((kind) => kind.trim())
        .filter(Boolean) as EventKind[] | undefined;
      for (const kind of kinds ?? [])
        if (!KINDS.includes(kind))
          throw new UsageError(`unknown event kind: ${kind}`);
      const from = parseTime(values.from, "--from", settings.day_start);
      const to = parseTime(values.to, "--to", settings.day_start, true);
      return withReader((reader) => {
        const page = reader.page({
          after,
          from,
          to,
          connection: values.connection,
          workspace: values.workspace,
          kinds,
          excludeConnections: excluded,
          limit,
        });
        if (format === "ndjson") {
          for (const event of page.events) context.log(JSON.stringify(event));
          return EXIT_OK;
        }
        print(format, page, () => {
          const names = new Map(
            page.workspaces.map((workspace) => [workspace.id, workspace.name]),
          );
          const lines = page.events.map((event) => {
            const detail = event.agent
              ? `${event.agent.name} ${event.agent.state}`
              : (event.reason ??
                (event.visible === undefined
                  ? ""
                  : `visible=${event.visible}`));
            const where = event.workspace_id
              ? (names.get(event.workspace_id) ?? event.workspace_id)
              : "";
            const by = event.client
              ? event.client.kind
              : event.source === "herdr"
                ? "herdr"
                : "";
            return [
              event.id,
              event.ts,
              event.kind,
              event.connection_id,
              where,
              by,
              detail,
            ]
              .filter(Boolean)
              .join("  ");
          });
          if (page.next_cursor) lines.push(`more: --after ${page.next_cursor}`);
          return lines.join("\n") || "no events";
        });
        return EXIT_OK;
      });
    }

    if (action === "workspaces") {
      const { values } = parseCommandArgs(rest, {
        json: { type: "boolean" },
        from: { type: "string" },
        to: { type: "string" },
        connection: { type: "string" },
      });
      const from = parseTime(values.from, "--from", settings.day_start);
      const to = parseTime(values.to, "--to", settings.day_start, true);
      return withReader((reader) => {
        const workspaces = reader
          .workspaces({ from, to, connection: values.connection })
          .filter((workspace) => !excluded.includes(workspace.connection_id));
        print(formatFlag(values), { workspaces }, () =>
          workspaces.length
            ? workspaces
                .map(
                  (workspace) =>
                    `${workspace.name}  ${workspace.connection_id}  ${workspace.path ?? "-"}`,
                )
                .join("\n")
            : "no workspaces",
        );
        return EXIT_OK;
      });
    }

    if (action === "status") {
      const { values } = parseCommandArgs(rest, { json: { type: "boolean" } });
      const at = now();
      const range = timelineRange({}, at, settings.day_start);
      const reader = openActivityReader(directory, now);
      const status = reader
        ? (() => {
            try {
              return reader.status({
                enabled: settings.enabled,
                retentionDays: settings.retention_days,
                from: range.from,
                to: at,
              });
            } finally {
              reader.close();
            }
          })()
        : {
            recording: false,
            retention_days: settings.retention_days,
            last_alive: null,
            gaps: [],
            connections: [],
          };
      print(formatFlag(values), status, () => {
        const lines = [
          `recording: ${status.recording ? "yes" : "no"}${settings.enabled ? "" : " (activity.enabled is off)"}`,
          `last alive: ${status.last_alive ?? "never"}`,
          `retention: ${status.retention_days} days`,
          ...status.connections.map(
            (entry) =>
              `connection ${entry.id}: ${entry.state}${entry.recording_since ? ` since ${entry.recording_since}` : ""}`,
          ),
          ...status.gaps.map(
            (gap) =>
              `gap ${gap.connection_id ?? "(recorder)"}: ${gap.start} to ${gap.end ?? "now"}${gap.reason ? ` (${gap.reason})` : ""}`,
          ),
        ];
        return lines.join("\n");
      });
      return EXIT_OK;
    }

    throw new UsageError(`unknown activity action: ${action}`);
  }
}
