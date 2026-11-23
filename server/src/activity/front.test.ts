import { expect, test } from "bun:test";
import { type ActivityCore, createActivityFront, HOLD_MS } from "./front";
import type { ActivityRecorder } from "./recorder";

/** A recorder that notes what it was told, with the times given. */
function fakeRecorder(log: string[], name = "bun") {
  const recorder = {
    ready: async () => true,
    connectionStatus: (id: string, state: string, ts?: number) =>
      log.push(`${name} status ${id} ${state} @${ts ?? "now"}`),
    herdrEvent: (id: string, _event: unknown, ts?: number) =>
      log.push(`${name} event ${id} @${ts ?? "now"}`),
    paneList: (id: string, _result: unknown, _at: number, ts?: number) =>
      log.push(`${name} panes ${id} @${ts ?? "now"}`),
    ownedAgentChanged: (id: string, pane: string, ts?: number) =>
      log.push(`${name} owned ${id} ${pane} @${ts ?? "now"}`),
    presence: async () => {
      log.push(`${name} presence`);
      return { recording: true, idle_seconds: 300, attention: true };
    },
    socketClosed: (_socket: object, ts?: number) =>
      log.push(`${name} closed @${ts ?? "now"}`),
    flush: async () => {},
    stop: async () => {
      log.push(`${name} stop`);
    },
    stopNow: () => log.push(`${name} stopNow`),
    store: () => null,
  };
  return recorder as unknown as ActivityRecorder;
}

function fakeCore(log: string[]) {
  const state = { owned: false, expected: true };
  const core: ActivityCore = {
    owned: () => state.owned,
    expected: () => state.expected,
    call: async (op, params) => {
      const signals = (params as { signals?: { op: string; ts: number }[] })
        .signals;
      log.push(
        signals
          ? `core ${op} ${signals.map((s) => `${s.op}@${s.ts}`).join(",")}`
          : `core ${op}`,
      );
      return { ok: true };
    },
    presence: async () => {
      log.push("core presence");
      return { recording: true, idle_seconds: 300, attention: false };
    },
  };
  return { state, core };
}

/** Timers run by hand. */
function fakeTimers() {
  const timers: { run: () => void; at: number }[] = [];
  let now = 1000;
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const timer = { run, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      const index = timers.indexOf(timer as never);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("without a core, calls go to Bun's recorder as they come", async () => {
  const log: string[] = [];
  const front = createActivityFront({
    createRecorder: () => fakeRecorder(log),
    core: null,
    heldAtStart: false,
    socketId: () => 1,
  });
  front.connectionStatus("local", "ready");
  front.herdrEvent("local", { event: "pane.output", data: {} });
  await front.presence({}, "local", {});
  front.socketClosed({});
  expect(log).toEqual([
    "bun status local ready @now",
    "bun event local @now",
    "bun presence",
    "bun closed @now",
  ]);
});

test("held signals go to the core in order once it takes the family, with the time they came", async () => {
  const log: string[] = [];
  const timers = fakeTimers();
  const { state, core } = fakeCore(log);
  const front = createActivityFront({
    createRecorder: () => fakeRecorder(log),
    core: () => core,
    heldAtStart: true,
    socketId: () => 7,
    ...timers,
  });
  front.connectionStatus("local", "ready");
  timers.advance(10);
  // Herdr's output events are not the log's: never forwarded.
  front.herdrEvent("local", { event: "pane.output", data: {} });
  front.herdrEvent("local", { event: "pane.agent_status_changed", data: {} });
  front.socketClosed({});
  state.owned = true;
  front.ownershipChanged();
  await settle();
  await settle();
  expect(log).toEqual([
    "core start",
    "core signals connection_status@1000,herdr_event@1010,socket_closed@1010",
  ]);
  front.paneList("local", { panes: [] }, 1010);
  await settle();
  expect(log.at(-1)).toBe("core signals pane_list@1010");
});

test("held signals go to Bun's recorder when no core takes the family in time", async () => {
  const log: string[] = [];
  const timers = fakeTimers();
  const { core } = fakeCore(log);
  const front = createActivityFront({
    createRecorder: () => fakeRecorder(log),
    core: () => core,
    heldAtStart: true,
    socketId: () => 7,
    ...timers,
  });
  front.connectionStatus("local", "ready");
  timers.advance(HOLD_MS);
  await settle();
  expect(log).toEqual(["bun status local ready @1000"]);
  front.ownedAgentChanged("local", "p1");
  expect(log.at(-1)).toBe(`bun owned local p1 @${1000 + HOLD_MS}`);
});

test("a handover stops Bun's recorder before the core's starts, which hears the connections as they are", async () => {
  const log: string[] = [];
  const timers = fakeTimers();
  const { state, core } = fakeCore(log);
  const front = createActivityFront({
    createRecorder: () => fakeRecorder(log),
    core: () => core,
    heldAtStart: false,
    socketId: () => 7,
    ...timers,
  });
  front.connectionStatus("local", "ready");
  front.connectionStatus("box", "connecting");
  timers.advance(500);
  state.owned = true;
  front.ownershipChanged();
  await settle();
  await settle();
  expect(log).toEqual([
    "bun status local ready @1000",
    "bun status box connecting @1000",
    "bun stop",
    "core start",
    "core signals connection_status@1500,connection_status@1500",
  ]);
  // And back: the core's recorder stops before a fresh Bun one starts.
  log.length = 0;
  state.owned = false;
  front.ownershipChanged();
  await settle();
  await settle();
  expect(log).toEqual([
    "core stop",
    "bun status local ready @1500",
    "bun status box connecting @1500",
  ]);
});

test("a stop ends recording where it runs", async () => {
  const log: string[] = [];
  const timers = fakeTimers();
  const { state, core } = fakeCore(log);
  const front = createActivityFront({
    createRecorder: () => fakeRecorder(log),
    core: () => core,
    heldAtStart: true,
    socketId: () => 7,
    ...timers,
  });
  state.owned = true;
  front.ownershipChanged();
  await settle();
  await front.stop();
  expect(log).toEqual(["core start", "core stop"]);
});
