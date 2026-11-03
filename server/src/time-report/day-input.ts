import type { GuiActivitySettings } from "../config/gui-settings";
import type {
  ActivityEvent,
  ActivityWorkspace,
  RecordingGap,
} from "../activity/protocol";
import { isoTime } from "../activity/protocol";
import type { ActivityReader } from "../activity/reader";
import { PAGE_LIMIT_MAX } from "../activity/reader";
import { dayBounds } from "../activity/timeline";

/** What the provider gets for `day` and `refresh` (time-report DayInput). */
export type DayInput = {
  date: string;
  timezone: string;
  day_start: string;
  idle_seconds: number;
  events: ActivityEvent[];
  workspaces: ActivityWorkspace[];
  recording_gaps: RecordingGap[];
};

/** A workspace whose subject, or one of its groups, the user excluded. */
export function subjectExcluded(
  workspace: Pick<ActivityWorkspace, "subject">,
  excluded: readonly string[],
): boolean {
  const subject = workspace.subject;
  if (!subject || excluded.length === 0) return false;
  const names = new Set(excluded);
  return [subject, ...subject.groups].some(
    (group) => names.has(group.id) || names.has(group.label),
  );
}

/** Merges overlapping intervals. */
function union(spans: { start: number; end: number }[]) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Everything recorded for `date`, as it may leave Roamgate: excluded
 * connections and subjects are dropped, and the time they had the
 * attention goes as anonymous excluded gaps.
 */
export function buildDayInput(
  reader: ActivityReader,
  settings: GuiActivitySettings,
  date: string,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): DayInput {
  const bounds = dayBounds(date, settings.day_start);
  const excludedConnections = settings.exclude.connections;
  // Every connection, to place what excluded ones covered.
  const timeline = reader.timeline(
    { from: bounds.start, to: bounds.end },
    settings.day_start,
    [],
    settings.idle_seconds,
  );
  const day = timeline.days[0];
  const workspaceById = new Map(
    timeline.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const events: ActivityEvent[] = [];
  const workspaces = new Map<string, ActivityWorkspace>();
  for (let after = 0; ; ) {
    const page = reader.page({
      after,
      from: bounds.start,
      to: bounds.end,
      excludeConnections: excludedConnections,
      limit: PAGE_LIMIT_MAX,
    });
    for (const workspace of page.workspaces)
      workspaces.set(workspace.id, workspace);
    events.push(...page.events);
    if (!page.next_cursor) break;
    after = Number(page.next_cursor);
  }
  const dropped = new Set(
    [...workspaces.values()]
      .filter((workspace) =>
        subjectExcluded(workspace, settings.exclude.subjects),
      )
      .map((workspace) => workspace.id),
  );
  const leftOut = (connectionId: string | null, workspaceId: string | null) =>
    (connectionId !== null && excludedConnections.includes(connectionId)) ||
    (workspaceId !== null && dropped.has(workspaceId));
  // The attention spans that are left out, whoever's subject they are.
  const excludedTime = union(
    (day?.focus ?? [])
      .filter((span) => {
        if (excludedConnections.includes(span.connection_id)) return true;
        if (!span.workspace_id) return false;
        if (dropped.has(span.workspace_id)) return true;
        const workspace = workspaceById.get(span.workspace_id);
        return (
          !!workspace && subjectExcluded(workspace, settings.exclude.subjects)
        );
      })
      .map((span) => ({
        start: Date.parse(span.start),
        end: Date.parse(span.end),
      })),
  );
  const gaps: RecordingGap[] = (day?.gaps ?? []).filter(
    (gap) =>
      gap.connection_id === null ||
      !excludedConnections.includes(gap.connection_id),
  );
  for (const span of excludedTime)
    gaps.push({
      connection_id: null,
      start: isoTime(span.start),
      end: isoTime(span.end),
      reason: null,
      excluded: true,
    });
  gaps.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return {
    date,
    timezone,
    day_start: settings.day_start,
    idle_seconds: settings.idle_seconds,
    events: events.filter(
      (event) => !leftOut(event.connection_id, event.workspace_id),
    ),
    workspaces: [...workspaces.values()].filter(
      (workspace) => !leftOut(workspace.connection_id, workspace.id),
    ),
    recording_gaps: gaps,
  };
}
