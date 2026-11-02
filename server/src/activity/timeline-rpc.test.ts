import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACTIVITY_SETTINGS,
  type GuiActivitySettings,
} from "../config/gui-settings";
import { openActivityStore } from "./store";
import { readActivityTimeline } from "./timeline-rpc";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(settings: Partial<GuiActivitySettings>, recording = true) {
  const root = mkdtempSync(join(tmpdir(), "roamgate-activity-rpc-"));
  directories.push(root);
  const directory = join(root, "roamgate");
  return {
    directory,
    options: {
      settings: async () => ({ ...DEFAULT_ACTIVITY_SETTINGS, ...settings }),
      recording: async () => recording,
      directory: () => directory,
      now: () => new Date(2026, 10, 2, 5).getTime(),
    },
  };
}

test("not recording: says so", async () => {
  const off = setup({ enabled: false });
  expect(await readActivityTimeline(off.options, {})).toEqual({
    recording: false,
  });
  const failed = setup({ enabled: true }, false);
  expect(await readActivityTimeline(failed.options, {})).toEqual({
    recording: false,
  });
});

test("today by default, from the day start setting", async () => {
  const { directory, options } = setup({ enabled: true, day_start: "06:00" });
  const store = openActivityStore(directory);
  store.startSession(options.now() - 60_000);
  store.close();
  const result = await readActivityTimeline(options, null);
  if (!result.recording) throw new Error("not recording");
  expect(result.day_start).toBe("06:00");
  // 05:00 is still the previous day when days start at 06:00.
  expect(result.days.map((day) => day.date)).toEqual(["2026-11-01"]);
  await expect(readActivityTimeline(options, { from: "nope" })).rejects.toThrow(
    "from must be a date",
  );
});
