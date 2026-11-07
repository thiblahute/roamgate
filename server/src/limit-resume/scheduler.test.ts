import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LIMIT_RESUME,
  type LimitPause,
  type LimitResumeSettings,
} from "../../../shared/limitResume";
import {
  answerRecord,
  BOOKKEEPING,
  jsonl,
  stopRecord,
  userRecord,
} from "../../../shared/limitResumeTesting";
import { settle } from "../conversation/testing";
import {
  createLimitResumer,
  type LimitConnection,
  type LimitPane,
} from "./scheduler";
import { createLimitResumeStore } from "./store";

/** Tonight's stop: 04:33:24Z, resetting at 04:40:00Z. */
const RESETS_S = 1794026400;
const RESET = RESETS_S * 1000;
const T0 = Date.parse("2026-11-07T04:33:30Z");

type FakePane = LimitPane & { tail: string };

function fakeConnection(id: string, panes: FakePane[]) {
  const sent: { paneId: string; owner: string; text: string }[] = [];
  const state = { failures: 0, down: false, again: null as null | number };
  const connection: LimitConnection = {
    id,
    panes: async () => {
      if (state.down) throw new Error("Herdr did not answer");
      return panes.map((each) => ({
        paneId: each.paneId,
        sessionId: each.sessionId,
        owner: each.owner,
        status: each.status,
      }));
    },
    transcriptTail: async (paneId) =>
      panes.find((pane) => pane.paneId === paneId)?.tail ?? null,
    deliver: async (pane, text) => {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error("Herdr did not answer");
      }
      sent.push({ paneId: pane.paneId, owner: pane.owner, text });
      const fake = panes.find((each) => each.paneId === pane.paneId)!;
      fake.tail += jsonl(userRecord(text));
      // Still limited: Claude Code stops on the limit again.
      if (state.again !== null)
        fake.tail += jsonl(stopRecord({ resetsAt: state.again, uuid: "re" }));
    },
  };
  return { connection, panes, sent, state };
}

function paused(
  paneId: string,
  options: {
    owner?: "terminal" | "conversation";
    status?: string;
    resetsAt?: number;
    kind?: string;
    sessionId?: string;
  } = {},
): FakePane {
  return {
    paneId,
    sessionId: options.sessionId ?? `session-${paneId}`,
    owner: options.owner ?? "terminal",
    status: options.status ?? "idle",
    tail: jsonl(
      userRecord("Fix the tests"),
      stopRecord({
        resetsAt: options.resetsAt ?? RESETS_S,
        kind: options.kind ?? "five_hour",
      }),
      ...BOOKKEEPING,
    ),
  };
}

const dirs: string[] = [];
function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "limit-resume-"));
  dirs.push(dir);
  return join(dir, "limit-resume.json");
}

function setup(
  connections: LimitConnection[],
  settings: Partial<LimitResumeSettings> = {},
  file: string | null = null,
) {
  const current: LimitResumeSettings = { ...DEFAULT_LIMIT_RESUME, ...settings };
  const changes: { connectionId: string; pauses: LimitPause[] }[] = [];
  const store = createLimitResumeStore({ file });
  const resumer = createLimitResumer({
    connections: () => connections,
    settings: async () => current,
    store,
    onChange: (connectionId, pauses) => changes.push({ connectionId, pauses }),
  });
  return { resumer, settings: current, changes, store };
}

async function advance(ms: number) {
  // Step by second so each timer's async work settles before the next.
  for (let left = ms; left > 0; left -= 1000) {
    jest.advanceTimersByTime(Math.min(1000, left));
    await settle(60);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});
afterEach(() => {
  jest.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

test("a 5-hour stop is resumed a minute after its reset, once, as the user would", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  const { resumer, changes } = setup([local.connection]);
  await resumer.scanAll();
  const [pause] = resumer.list("local");
  expect(pause).toMatchObject({
    pane_id: "w1:p1",
    session_id: "session-w1:p1",
    owner: "terminal",
    kind: "five_hour",
    resets_at: RESET,
    resume_at: RESET + 60_000,
    state: "scheduled",
  });
  expect(changes.at(-1)?.pauses).toHaveLength(1);

  await advance(RESET + 59_000 - T0);
  expect(local.sent).toEqual([]);
  await advance(1000);
  expect(local.sent).toEqual([
    {
      paneId: "w1:p1",
      owner: "terminal",
      text: DEFAULT_LIMIT_RESUME.message,
    },
  ]);
  // Its transcript shows the message: not paused any more.
  await advance(5000);
  expect(resumer.list("local")).toEqual([]);
  await advance(60 * 60_000);
  expect(local.sent).toHaveLength(1);
  resumer.stop();
});

test("a weekly stop is scheduled and resumed the same way, in conversation mode", async () => {
  const resetsAt = RESETS_S + 2 * 24 * 3600;
  const local = fakeConnection("local", [
    paused("w1:p2", { owner: "conversation", kind: "seven_day", resetsAt }),
  ]);
  const { resumer } = setup([local.connection], {
    message: "Go on.",
    margin_seconds: 120,
  });
  await resumer.scanAll();
  expect(resumer.list("local")[0]).toMatchObject({
    kind: "seven_day",
    state: "scheduled",
    resume_at: resetsAt * 1000 + 120_000,
  });
  jest.advanceTimersByTime(resetsAt * 1000 + 119_000 - T0);
  await settle(60);
  expect(local.sent).toEqual([]);
  await advance(1000);
  expect(local.sent).toEqual([
    { paneId: "w1:p2", owner: "conversation", text: "Go on." },
  ]);
  resumer.stop();
});

test("no resume when the user resumed it already", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  const { resumer } = setup([local.connection]);
  await resumer.scanAll();
  // At 04:50 the user typed "Keep going" and it went through.
  local.panes[0]!.tail += jsonl(userRecord("Keep going"), answerRecord());
  await advance(RESET + 120_000 - T0);
  expect(local.sent).toEqual([]);
  expect(resumer.list("local")).toEqual([]);
  resumer.stop();
});

test("one resume per reset: stopped again on it, it waits for the next reset", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  local.state.again = RESETS_S;
  const { resumer } = setup([local.connection]);
  await resumer.scanAll();
  await advance(RESET + 60_000 - T0);
  expect(local.sent).toHaveLength(1);
  await advance(5000);
  expect(resumer.list("local")[0]).toMatchObject({
    state: "resumed",
    resume_at: null,
  });
  await advance(30 * 60_000);
  expect(local.sent).toHaveLength(1);

  // It hits the limit again with a new reset: scheduled again.
  const next = RESETS_S + 5 * 3600;
  local.state.again = null;
  local.panes[0]!.tail += jsonl(
    userRecord("Keep going"),
    stopRecord({ resetsAt: next, uuid: "new" }),
  );
  resumer.poke("local", "w1:p1");
  await advance(3000);
  expect(resumer.list("local")[0]).toMatchObject({
    state: "scheduled",
    resets_at: next * 1000,
  });
  await advance(next * 1000 + 60_000 - Date.now());
  expect(local.sent).toHaveLength(2);
  resumer.stop();
});

test("a server restart resumes what was seen in time, never what was not", async () => {
  const file = storeFile();
  const first = fakeConnection("local", [paused("w1:p1")]);
  const before = setup([first.connection], {}, file);
  await before.resumer.scanAll();
  expect(before.resumer.list("local")[0]?.state).toBe("scheduled");
  before.resumer.stop();

  // Down across the reset; back ten minutes after it.
  jest.setSystemTime(RESET + 10 * 60_000);
  const late = paused("w2:p1", { resetsAt: RESETS_S });
  const second = fakeConnection("local", [first.panes[0]!, late]);
  const after = setup([second.connection], {}, file);
  await after.resumer.scanAll();
  expect(
    after.resumer.list("local").map((each) => [each.pane_id, each.state]),
  ).toEqual([
    ["w1:p1", "scheduled"],
    ["w2:p1", "missed"],
  ]);
  await advance(1000);
  expect(second.sent.map((each) => each.paneId)).toEqual(["w1:p1"]);

  // Never seen in time: only "Resume now" sends it.
  await advance(10 * 60_000);
  expect(second.sent).toHaveLength(1);
  expect(await after.resumer.resumeNow("local", "w2:p1")).toEqual({
    ok: true,
  });
  expect(second.sent.map((each) => each.paneId)).toEqual(["w1:p1", "w2:p1"]);
  after.resumer.stop();
});

test("a pause long overdue is not resumed after a restart", async () => {
  const file = storeFile();
  const local = fakeConnection("local", [paused("w1:p1")]);
  const before = setup([local.connection], {}, file);
  await before.resumer.scanAll();
  before.resumer.stop();
  jest.setSystemTime(RESET + 2 * 24 * 3600_000);
  const after = setup([local.connection], {}, file);
  await after.resumer.scanAll();
  expect(after.resumer.list("local")[0]?.state).toBe("missed");
  await advance(5000);
  expect(local.sent).toEqual([]);
  after.resumer.stop();
});

test("Don't resume holds the session; undone, it is resumed at the reset", async () => {
  const local = fakeConnection("local", [paused("w1:p1"), paused("w1:p2")]);
  const { resumer, store } = setup([local.connection]);
  await resumer.scanAll();
  expect(await resumer.setSkip("local", "w1:p1", true)).toEqual({ ok: true });
  expect(store.get("session-w1:p1")?.skip).toBe(true);
  expect(resumer.list("local")[0]).toMatchObject({
    pane_id: "w1:p1",
    state: "skipped",
    resume_at: null,
  });
  await advance(RESET + 60_000 - T0);
  expect(local.sent.map((each) => each.paneId)).toEqual(["w1:p2"]);

  // Undone after the reset: it was seen in time, so it goes now.
  await resumer.setSkip("local", "w1:p1", false);
  await advance(1000);
  expect(local.sent.map((each) => each.paneId)).toEqual(["w1:p2", "w1:p1"]);
  resumer.stop();
});

test("with the setting off, paused sessions are shown but not resumed", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  const { resumer, settings } = setup([local.connection], { enabled: false });
  await resumer.scanAll();
  expect(resumer.list("local")[0]?.state).toBe("off");
  await advance(RESET + 5 * 60_000 - T0);
  expect(local.sent).toEqual([]);
  // Turned on before the reset of a later stop: scheduled.
  settings.enabled = true;
  local.panes[0]!.tail += jsonl(
    userRecord("again"),
    stopRecord({ resetsAt: RESETS_S + 3600, uuid: "later" }),
  );
  resumer.poke("local", "w1:p1");
  await advance(3000);
  expect(resumer.list("local")[0]?.state).toBe("scheduled");
  resumer.stop();
});

test("a busy terminal is waited for, never typed into", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  const { resumer } = setup([local.connection]);
  await resumer.scanAll();
  local.panes[0]!.status = "blocked";
  await advance(RESET + 60_000 - T0);
  expect(local.sent).toEqual([]);
  await advance(60_000);
  expect(local.sent).toEqual([]);
  local.panes[0]!.status = "idle";
  await advance(60_000);
  expect(local.sent).toHaveLength(1);
  resumer.stop();
});

test("a failed send is tried again, then given up", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  local.state.failures = 1;
  const { resumer } = setup([local.connection]);
  await resumer.scanAll();
  await advance(RESET + 60_000 - T0);
  expect(local.sent).toEqual([]);
  expect(resumer.list("local")[0]).toMatchObject({
    state: "failed",
    reason: "Herdr did not answer",
  });
  await advance(30_000);
  expect(local.sent).toHaveLength(1);

  // Failing every time: five tries, then it waits for the user.
  const other = fakeConnection("local", [paused("w1:p1")]);
  other.state.failures = 100;
  const again = setup([other.connection]);
  jest.setSystemTime(T0);
  await again.resumer.scanAll();
  await advance(RESET + 60_000 - T0 + 10 * 60_000);
  expect(other.state.failures).toBe(95);
  expect(again.resumer.list("local")[0]).toMatchObject({
    state: "failed",
    resume_at: null,
  });
  resumer.stop();
  again.resumer.stop();
});

test("Resume now before the reset does not use up the reset's resume", async () => {
  const local = fakeConnection("local", [paused("w1:p1")]);
  local.state.again = RESETS_S;
  const { resumer } = setup([local.connection]);
  await resumer.scanAll();
  expect(await resumer.resumeNow("local", "w1:p1")).toEqual({ ok: true });
  expect(local.sent).toHaveLength(1);
  local.state.again = null;
  await advance(5000);
  // Still limited: paused by the same reset, which resumes it.
  expect(resumer.list("local")[0]?.state).toBe("scheduled");
  await advance(RESET + 60_000 - Date.now());
  expect(local.sent).toHaveLength(2);
  resumer.stop();
});

test("every connection is looked at, remote ones included", async () => {
  const local = fakeConnection("local", [
    {
      paneId: "w1:p1",
      sessionId: "fine",
      owner: "terminal",
      status: "idle",
      tail: jsonl(userRecord("hi"), answerRecord()),
    },
  ]);
  const desktop = fakeConnection("desktop", [
    paused("w3:p1", { owner: "conversation" }),
  ]);
  const connections = [local.connection, desktop.connection];
  const { resumer, changes } = setup(connections);
  await resumer.scanAll();
  expect(resumer.list("local")).toEqual([]);
  expect(resumer.list("desktop")[0]?.connection_id).toBe("desktop");
  expect(changes.map((each) => each.connectionId)).toContain("desktop");

  // The host does not answer for a while: what was known stays.
  desktop.state.down = true;
  await resumer.scanAll();
  expect(resumer.list("desktop")).toHaveLength(1);
  desktop.state.down = false;

  await advance(RESET + 60_000 - T0);
  expect(desktop.sent).toEqual([
    {
      paneId: "w3:p1",
      owner: "conversation",
      text: DEFAULT_LIMIT_RESUME.message,
    },
  ]);
  expect(local.sent).toEqual([]);

  // A connection removed loses its pauses.
  desktop.panes[0]!.tail = paused("w3:p1").tail;
  desktop.state.again = null;
  connections.pop();
  await resumer.scanAll();
  expect(resumer.list("desktop")).toEqual([]);
  expect(changes.at(-1)).toEqual({ connectionId: "desktop", pauses: [] });
  resumer.stop();
});
