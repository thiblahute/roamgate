import type { GuiActivitySettings } from "../config/gui-settings";
import { openActivityReader } from "./reader";
import { type Timeline, timelineRange } from "./timeline";

export type TimelineReply = Timeline | { recording: false };

/**
 * `bridge.activity.timeline {from?, to?}`: the timeline of whole local days
 * (dates, both included; today by default). `{recording: false}` while the
 * bridge does not record.
 */
export async function readActivityTimeline(
  options: {
    settings: () => Promise<GuiActivitySettings>;
    /** True while the recorder records. */
    recording: () => Promise<boolean>;
    directory: () => string;
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
  const reader = openActivityReader(options.directory(), now);
  if (!reader) return { recording: false };
  try {
    return reader.timeline(range, settings.day_start);
  } finally {
    reader.close();
  }
}
