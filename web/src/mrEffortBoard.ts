import type { MrInboxEntry, MrPlan } from "../../shared/mrReviews";

/**
 * An effort's Board: one card per planned request, in the column of where
 * it stands. Planned (no part yet), Not proposed yet (a part, no request),
 * then its request's own lane in the inbox, and Done once merged (or all
 * of its commits upstream).
 */
export type MrEffortColumn =
  | "planned"
  | "not_sent"
  | "your_move"
  | "waiting"
  | "merging"
  | "blocked"
  | "stale"
  | "done";

export const MR_EFFORT_COLUMNS: MrEffortColumn[] = [
  "planned",
  "not_sent",
  "your_move",
  "waiting",
  "merging",
  "blocked",
  "stale",
  "done",
];

export const MR_EFFORT_COLUMN_TITLE: Record<MrEffortColumn, string> = {
  planned: "Planned",
  not_sent: "Not proposed yet",
  your_move: "Needs you",
  waiting: "Waiting",
  merging: "Merging",
  blocked: "Blocked",
  stale: "Stale",
  done: "Done",
};

/**
 * A plan's column: its request's lane once it has one (a branch row is
 * not one), else whether it has a part. `upstream`: every commit of the
 * plan is upstream already.
 */
export function mrEffortColumn(
  plan: Pick<MrPlan, "part">,
  entry: MrInboxEntry | undefined,
  upstream = false,
): MrEffortColumn {
  if (upstream) return "done";
  if (entry && !entry.branch) {
    if (entry.state !== "open") return "done";
    switch (entry.lane) {
      case "your_move":
      case "waiting":
      case "merging":
      case "blocked":
      case "stale":
        return entry.lane;
      case "done":
        return "done";
      case "not_sent":
        return "not_sent";
      default:
        return "waiting";
    }
  }
  return plan.part ? "not_sent" : "planned";
}
