import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACTIVITY_SETTINGS } from "../config/gui-settings";
import { openActivityReader } from "../activity/reader";
import { openActivityStore } from "../activity/store";
import { subjectResolver } from "../activity/subjects";
import { dayBounds } from "../activity/timeline";
import type { Spawn } from "./provider";
import { createTimeReport, PREVIEW_TTL_MS } from "./rpc";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DATE = "2026-11-02";
const day = dayBounds(DATE, "00:00");
const at = (hh: number, mm = 0) => day.start + hh * 3_600_000 + mm * 60_000;

/** A log with work in two folders on two connections, one span each. */
function log() {
  const base = mkdtempSync(join(tmpdir(), "roamgate-time-report-"));
  dirs.push(base);
  const directory = join(base, "roamgate");
  const store = openActivityStore(directory);
  const session = store.startSession(at(8));
  const workspaces = [
    ["ws_gst", "local", "gst", "/Users/me/devel/gstreamer/gst"],
    ["ws_home", "local", "taxes", "/Users/me/private/taxes"],
    ["ws_box", "box", "box", "/home/me/devel/gstreamer/box"],
  ] as const;
  for (const [id, connectionId, name, path] of workspaces)
    store.upsertWorkspace({
      id,
      connectionId,
      name,
      path,
      herdrWorkspaceId: "w1",
      repoRoot: null,
      repoIsWorktree: null,
      seenAt: at(8),
    });
  let hour = 9;
  for (const [id, connectionId] of workspaces) {
    const focus = store.append({
      ts: at(hour),
      kind: "workspace.focus",
      connectionId,
      session,
      workspaceId: id,
      client: { id: "c1", kind: "desktop" },
      source: "browser",
    });
    store.append({
      ts: at(hour + 1),
      kind: "workspace.blur",
      connectionId,
      session,
      workspaceId: id,
      client: { id: "c1", kind: "desktop" },
      source: "browser",
      reason: "switch",
      span: focus,
    });
    hour += 1;
  }
  store.alive(session, at(18));
  store.close();
  return directory;
}

function harness(
  options: {
    exclude?: { connections: string[]; subjects: string[] };
    configured?: boolean;
    answer?: (argv: string[], stdin: string) => unknown;
  } = {},
) {
  const directory = log();
  const calls: { argv: string[]; stdin: string }[] = [];
  let now = at(18);
  let running = 0;
  let overlapped = false;
  const spawn: Spawn = async (argv, { stdin }) => {
    calls.push({ argv, stdin });
    running++;
    if (running > 1) overlapped = true;
    await Bun.sleep(5);
    running--;
    const op = argv[2];
    const value =
      options.answer?.(argv, stdin) ??
      (op === "submit-preview"
        ? {
            changes: [],
            total_minutes: 60,
            confirm_token: `tok-${calls.length}`,
            expires_at: "2026-11-02T19:00:00+01:00",
          }
        : { ok: true, op });
    return {
      code: 0,
      stdout: JSON.stringify(value),
      stderr: "",
      timedOut: false,
    };
  };
  const report = createTimeReport({
    settings: async () => ({
      activity: {
        ...DEFAULT_ACTIVITY_SETTINGS,
        enabled: true,
        idle_seconds: 120,
        subject_roots: ["~/devel/gstreamer", "~/private"],
        exclude: options.exclude ?? { connections: [], subjects: [] },
      },
      timeReport:
        options.configured === false
          ? null
          : { command: ["olmo", "provider"], timeout_seconds: 60 },
    }),
    openReader: async () =>
      openActivityReader(directory, () => now, {
        subjectOf: subjectResolver({
          roots: ["~/devel/gstreamer", "~/private"],
          home: "/Users/me",
        }),
      }),
    spawn,
    now: () => now,
    timezone: "Europe/Madrid",
  });
  return {
    report,
    calls,
    overlapped: () => overlapped,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("day passes the whole day with subjects, idle_seconds and the zone", async () => {
  const { report, calls } = harness();
  expect(await report.handle({ op: "day", date: DATE })).toEqual({
    ok: true,
    op: "day",
  });
  expect(calls[0]!.argv).toEqual(["olmo", "provider", "day", DATE]);
  const input = JSON.parse(calls[0]!.stdin);
  expect(input).toMatchObject({
    date: DATE,
    timezone: "Europe/Madrid",
    day_start: "00:00",
    idle_seconds: 120,
  });
  expect(input.events).toHaveLength(6);
  expect(
    Object.fromEntries(
      input.workspaces.map((w: { id: string; subject: { label: string } }) => [
        w.id,
        w.subject?.label,
      ]),
    ),
  ).toEqual({ ws_gst: "gst", ws_home: "taxes", ws_box: "box" });
  expect(input.recording_gaps).toEqual([]);
});

test("excluded connections and subjects leave as anonymous excluded gaps", async () => {
  const { report, calls } = harness({
    exclude: { connections: ["box"], subjects: ["private"] },
  });
  await report.handle({ op: "refresh", date: DATE });
  const input = JSON.parse(calls[0]!.stdin);
  expect(input.workspaces.map((w: { id: string }) => w.id)).toEqual(["ws_gst"]);
  expect(
    input.events.every(
      (e: { workspace_id: string }) => e.workspace_id === "ws_gst",
    ),
  ).toBe(true);
  expect(input.recording_gaps).toEqual([
    {
      connection_id: null,
      start: expect.any(String),
      end: expect.any(String),
      reason: null,
      excluded: true,
    },
  ]);
  const gap = input.recording_gaps[0];
  expect([Date.parse(gap.start), Date.parse(gap.end)]).toEqual([
    at(10),
    at(12),
  ]);
  expect(JSON.stringify(input)).not.toContain("taxes");
});

test("operations map to the provider's command line", async () => {
  const { report, calls } = harness();
  await report.handle({ op: "health" });
  await report.handle({ op: "targets" });
  await report.handle({ op: "days", from: "2026-11-01", to: DATE });
  await report.handle({
    op: "block-create",
    date: DATE,
    body: {
      start: "2026-11-02T13:00:00+01:00",
      end: "2026-11-02T14:00:00+01:00",
      target: "10",
    },
  });
  await report.handle({
    op: "block-update",
    date: DATE,
    block: "b1",
    body: { description: "x" },
  });
  await report.handle({
    op: "block-answer",
    date: DATE,
    block: "b1",
    body: { option_id: "skip", remember: true },
  });
  await report.handle({
    op: "block-split",
    date: DATE,
    block: "b1",
    at: "2026-11-02T13:30:00+01:00",
  });
  await report.handle({ op: "block-delete", date: DATE, block: "b1" });
  await report.handle({ op: "block-accept", date: DATE, block: "b1" });
  await report.handle({ op: "block-explain", date: DATE, block: "b1" });
  await report.handle({
    op: "submit-preview",
    date: DATE,
    blocks: ["b1", "b2"],
  });
  await report.handle({ op: "mappings" });
  await report.handle({
    op: "mapping-set",
    body: { workspace_id: "ws_gst", target: null, remember: true },
  });
  await report.handle({
    op: "mapping-delete",
    body: { workspace_id: "ws_gst" },
  });
  expect(calls.map((call) => call.argv.slice(2).join(" "))).toEqual([
    "health",
    "targets",
    "days --from 2026-11-01 --to 2026-11-02",
    "block-create 2026-11-02",
    "block-update 2026-11-02 b1",
    "block-answer 2026-11-02 b1",
    "block-split 2026-11-02 b1 --at 2026-11-02T13:30:00+01:00",
    "block-delete 2026-11-02 b1",
    "block-accept 2026-11-02 b1",
    "block-explain 2026-11-02 b1",
    "submit-preview 2026-11-02 --block b1 --block b2",
    "mappings",
    "mapping-set",
    "mapping-delete",
  ]);
  expect(JSON.parse(calls[5]!.stdin)).toEqual({
    option_id: "skip",
    remember: true,
  });
});

test("arguments are checked before anything runs", async () => {
  const { report, calls } = harness();
  for (const request of [
    { op: "rm -rf" },
    { op: "day", date: "today" },
    { op: "block-delete", date: DATE, block: "--all" },
    { op: "block-split", date: DATE, block: "b1", at: "noon" },
    { op: "block-update", date: DATE, block: "b1" },
    { op: "submit-preview", date: DATE, blocks: ["; rm"] },
  ])
    await expect(report.handle(request)).rejects.toMatchObject({
      code: "invalid",
    });
  expect(calls).toEqual([]);
  const off = harness({ configured: false });
  await expect(off.report.handle({ op: "health" })).rejects.toMatchObject({
    code: "not_configured",
  });
});

test("one provider process at a time per day", async () => {
  const { report, overlapped, calls } = harness();
  await Promise.all([
    report.handle({ op: "refresh", date: DATE }),
    report.handle({ op: "block-accept", date: DATE, block: "b1" }),
    report.handle({ op: "day", date: DATE }),
  ]);
  expect(calls).toHaveLength(3);
  expect(overlapped()).toBe(false);
});

test("submit needs the explicit confirmation and this bridge's own fresh preview, once", async () => {
  const { report, calls, advance } = harness();
  const submits = () => calls.filter((call) => call.argv[2] === "submit");
  // No preview, no confirmation, a made-up token: nothing runs.
  await expect(
    report.handle({
      op: "submit",
      date: DATE,
      confirm_token: "made-up",
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  const preview = (await report.handle({
    op: "submit-preview",
    date: DATE,
  })) as {
    confirm_token: string;
  };
  await expect(
    report.handle({
      op: "submit",
      date: DATE,
      confirm_token: preview.confirm_token,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    report.handle({
      op: "submit",
      date: "2026-11-01",
      confirm_token: preview.confirm_token,
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(submits()).toEqual([]);
  // Confirmed: once.
  await report.handle({
    op: "submit",
    date: DATE,
    confirm_token: preview.confirm_token,
    confirmed: true,
  });
  expect(submits()).toHaveLength(1);
  expect(JSON.parse(submits()[0]!.stdin)).toEqual({
    confirm_token: preview.confirm_token,
  });
  await expect(
    report.handle({
      op: "submit",
      date: DATE,
      confirm_token: preview.confirm_token,
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  // An old preview: preview again.
  const stale = (await report.handle({ op: "submit-preview", date: DATE })) as {
    confirm_token: string;
  };
  advance(PREVIEW_TTL_MS + 1);
  await expect(
    report.handle({
      op: "submit",
      date: DATE,
      confirm_token: stale.confirm_token,
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(submits()).toHaveLength(1);
});
