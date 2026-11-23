import type { GuiActivitySettings } from "../config/gui-settings";
import { openActivityReader } from "./reader";
import type { SubjectOf } from "./subjects";
import { type Timeline, timelineRange } from "./timeline";

export type TimelineReply = Timeline | { recording: false };

/**
 * `bridge.activity.timeline {from?, to?}`: the timeline of whole local days
 * (dates, both included; today by default), without the connections in
 * `exclude.connections`. `{recording: false}` while the bridge does not
 * record.
 */
export async function readActivityTimeline(
  options: {
    settings: () => Promise<GuiActivitySettings>;
    /** True while the recorder records. */
    recording: () => Promise<boolean>;
    directory: () => string;
    /** Each workspace's subject (subject-settings.ts). */
    subjects?: () => Promise<SubjectOf>;
    now?: () => number;
  },
  params: unknown,
): Promise<TimelineReply> {
  const settings = await options.settings();
  if (!settings.enabled || !(await options.recording()))
    return { recording: false };
  const now = options.now ?? Date.now;
  const request =
    params && typeof params === "object"
      ? (params as { from?: unknown; to?: unknown })
      : {};
  const range = timelineRange(request, now(), settings.day_start);
  const subjectOf = await options.subjects?.();
  const reader = openActivityReader(options.directory(), now, { subjectOf });
  if (!reader) return { recording: false };
  try {
    // Connections in exclude.connections are left out, as by
    // `roamgate activity`.
    return reader.timeline(
      range,
      settings.day_start,
      settings.exclude.connections,
      settings.idle_seconds,
    );
  } finally {
    reader.close();
  }
}
