/**
 * The time-report provider, through the bridge (`bridge.time_report`,
 * server/src/time-report/rpc.ts). Shapes follow docs/time-report.schema.json.
 */
import { bridge } from "./api";
import type { Subject } from "./activityTimelineModel";

export type Target = {
  id: string;
  label: string;
  group?: string | null;
  active?: boolean;
};

export type TaskType = { id: string; label: string; active?: boolean };

export type Health = {
  ok: boolean;
  provider: string;
  version?: string;
  capabilities?: string[];
  ai?: { backend?: string; deferred?: boolean };
};

/** A share of a mapping's time; `target` null is a share not logged. */
export type Allocation = {
  target: Target | null;
  task_type?: string | null;
  /** Whole percent; a mapping's shares add up to 100. */
  percent: number;
};

export type Mapping = {
  scope: "subject" | "workspace";
  workspace_id: string;
  workspace_name: string;
  subject_label?: string;
  allocations: Allocation[];
  remembered_at: string;
};

export type MappingSet = {
  workspace_id: string;
  workspace_name: string;
  subject?: Subject;
  allocations: Allocation[];
  remember: boolean;
};

/** "Just remote 60% · STF 40%", or the one project. */
export function allocationLabel(allocations: readonly Allocation[]): string {
  const name = (entry: Allocation) => entry.target?.label ?? "Do not log";
  if (allocations.length === 1) return name(allocations[0]!);
  return allocations
    .map((entry) => `${name(entry)} ${entry.percent}%`)
    .join(" · ");
}

/** A provider failure, with the protocol's code (or not_configured). */
export class TimeReportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly partial: unknown = null,
  ) {
    super(message);
  }
}

/** Above the provider's own limit (60 s by default), so its error shows. */
const CALL_TIMEOUT_MS = 650_000;

export async function timeReport<T = unknown>(
  op: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const reply = (await bridge.call(
    "bridge.time_report",
    { op, ...params },
    CALL_TIMEOUT_MS,
  )) as
    | { ok: true; value: T }
    | { ok: false; error: string; code: string; partial?: unknown };
  if (!reply.ok)
    throw new TimeReportError(reply.error, reply.code, reply.partial ?? null);
  return reply.value;
}

/**
 * Where a workspace goes, as the provider remembers it: its own mapping
 * first, then its subject's (nearest group first).
 */
export function mappingFor(
  mappings: readonly Mapping[],
  workspace: { id: string; subject?: Subject | null },
): Mapping | null {
  const own = mappings.find(
    (entry) =>
      entry.scope === "workspace" && entry.workspace_id === workspace.id,
  );
  if (own) return own;
  const subject = workspace.subject;
  if (!subject) return null;
  const labels = [
    subject.label,
    ...[...subject.groups].reverse().map((group) => group.label),
  ];
  for (const label of labels) {
    const match = mappings.find(
      (entry) => entry.scope === "subject" && entry.subject_label === label,
    );
    if (match) return match;
  }
  return null;
}
