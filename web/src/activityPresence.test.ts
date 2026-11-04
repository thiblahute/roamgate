import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  activityClientId,
  activityClientKind,
  CAUSE_INPUT_MS,
  PRESENCE_REPEAT_MS,
  watchActivityPresence,
} from "./activityPresence";
import type { store } from "./store";

type Snapshot = ReturnType<typeof store.get>;

const rect = { x: 0, y: 0, width: 80, height: 24 };

function layout(workspace: string, panes: string[], focused = panes[0]) {
  return {
    workspace_id: workspace,
    tab_id: `${workspace}:t1`,
    zoomed: false,
    area: rect,
    splits: [],
    focused_pane_id: focused,
    panes: panes.map((id) => ({
      pane_id: id,
      focused: id === focused,
      rect,
    })),
  };
}

const last = <T>(values: T[]): T | undefined => values[values.length - 1];

const tick = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

function harness({
  paneShown = true,
  visible = true,
  answer = { recording: true, idle_seconds: 300 } as unknown,
} = {}) {
  let snapshot = {
    selectedPaneId: null,
    layout: layout("w1", ["w1:p1", "w1:p2"]),
  } as unknown as Snapshot;
  const listeners = new Set<() => void>();
  const calls: Record<string, unknown>[] = [];
  const reply = answer;
  let focused = true;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: (visible
      ? "visible"
      : "hidden") as DocumentVisibilityState,
    hasFocus: () => focused,
  });
  const stop = watchActivityPresence({
    client: {
      call: async (method: string, params?: Record<string, unknown>) => {
        expect(method).toBe("activity.presence");
        calls.push(params!);
        return reply;
      },
    },
    clientId: "c1",
    clientKind: "desktop",
    paneShown,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    win: win as unknown as Window,
    doc: doc as unknown as Document,
    now: () => Date.now(),
  });
  return {
    calls,
    stop,
    win,
    doc,
    listeners,
    setFocused: (value: boolean) => {
      focused = value;
      win.dispatchEvent(new Event(value ? "focus" : "blur"));
    },
    setVisible: (value: boolean) => {
      doc.visibilityState = value ? "visible" : "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    input: (type = "keydown") => doc.dispatchEvent(new Event(type)),
    update: (change: (value: Snapshot) => Snapshot) => {
      snapshot = change(snapshot);
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse("2026-11-02T09:00:00Z"));
});
afterEach(() => jest.useRealTimers());

test("the page says where the user looks, at once and on each change", async () => {
  const h = harness();
  await tick();
  expect(h.calls).toEqual([
    {
      client_id: "c1",
      client_kind: "desktop",
      workspace_id: "w1",
      tab_id: "w1:t1",
      pane_id: "w1:p1",
      visible: true,
      focused: true,
      // Loaded in front of the user: no input yet, so nobody yet.
      input_age_ms: null,
      cause: "page_load",
    },
  ]);
  // Store updates that change nothing on screen say nothing.
  h.update((snapshot) => ({ ...snapshot }));
  expect(h.calls).toHaveLength(1);
  h.update((snapshot) => ({ ...snapshot, selectedPaneId: "w1:p2" }));
  h.update((snapshot) => ({
    ...snapshot,
    selectedPaneId: null,
    layout: layout("w2", ["w2:p1"]),
  }));
  expect(
    h.calls.map((call) => [call.workspace_id, call.tab_id, call.pane_id]),
  ).toEqual([
    ["w1", "w1:t1", "w1:p1"],
    ["w1", "w1:t1", "w1:p2"],
    ["w2", "w2:t1", "w2:p1"],
  ]);
  expect(h.calls.map((call) => call.cause)).toEqual([
    "page_load",
    "page_load",
    "page_load",
  ]);
  h.stop();
});

test("it repeats every minute while looked at, says when idle, and wakes on input", async () => {
  const h = harness();
  await tick();
  // The bridge counted the load as attention (an older bridge): input
  // sends nothing of its own.
  h.input();
  expect(h.calls).toHaveLength(1);
  jest.advanceTimersByTime(PRESENCE_REPEAT_MS);
  await tick();
  expect(h.calls.map((call) => call.input_age_ms)).toEqual([null, 60_000]);
  // Input moves the threshold without a report of its own.
  jest.advanceTimersByTime(30_000);
  h.input("pointerdown");
  expect(h.calls).toHaveLength(2);
  jest.advanceTimersByTime(4 * PRESENCE_REPEAT_MS);
  await tick();
  expect(h.calls.map((call) => call.input_age_ms)).toEqual([
    null,
    60_000,
    30_000,
    90_000,
    150_000,
    210_000,
  ]);
  // The threshold, then nothing more while idle.
  jest.advanceTimersByTime(90_000);
  await tick();
  expect(last(h.calls)?.input_age_ms).toBe(300_000);
  const idleCount = h.calls.length;
  jest.advanceTimersByTime(10 * PRESENCE_REPEAT_MS);
  expect(h.calls).toHaveLength(idleCount);
  // Input after idle is reported at once.
  h.input("wheel");
  expect(h.calls).toHaveLength(idleCount + 1);
  expect(last(h.calls)).toMatchObject({ input_age_ms: 0, cause: "user_input" });
  h.stop();
});

test("hidden or unfocused pages report it, then stay quiet; returning is input", async () => {
  const h = harness();
  await tick();
  h.input();
  jest.advanceTimersByTime(400_000);
  await tick();
  const before = h.calls.length;
  h.setVisible(false);
  expect(last(h.calls)).toMatchObject({ visible: false, focused: true });
  jest.advanceTimersByTime(10 * PRESENCE_REPEAT_MS);
  expect(h.calls).toHaveLength(before + 1);
  h.setVisible(true);
  expect(last(h.calls)).toMatchObject({
    visible: true,
    input_age_ms: 0,
    cause: "user_focus",
  });
  h.setFocused(false);
  expect(last(h.calls)).toMatchObject({ visible: true, focused: false });
  h.setFocused(true);
  expect(last(h.calls)).toMatchObject({ focused: true });
  h.stop();
});

test("a page hidden from the start waits until it is looked at", async () => {
  const h = harness({ visible: false });
  await tick();
  expect(h.calls).toEqual([]);
  h.setVisible(true);
  expect(h.calls).toHaveLength(1);
  h.stop();
});

test("a phone away from the pane reports the workspace only", async () => {
  const h = harness({ paneShown: false });
  await tick();
  expect(h.calls[0]).toMatchObject({ workspace_id: "w1", pane_id: null });
  h.stop();
});

test("nothing more is sent once the bridge is not recording", async () => {
  const h = harness({ answer: { recording: false, idle_seconds: 300 } });
  await tick();
  expect(h.calls).toHaveLength(1);
  jest.advanceTimersByTime(10 * PRESENCE_REPEAT_MS);
  h.update((snapshot) => ({ ...snapshot, selectedPaneId: "w1:p2" }));
  h.setVisible(false);
  expect(h.calls).toHaveLength(1);
  h.stop();
});

test("the bridge's idle threshold is followed", async () => {
  const h = harness({ answer: { recording: true, idle_seconds: 90 } });
  await tick();
  h.input();
  jest.advanceTimersByTime(PRESENCE_REPEAT_MS);
  await tick();
  jest.advanceTimersByTime(30_000);
  await tick();
  expect(h.calls.map((call) => call.input_age_ms)).toEqual([
    null,
    60_000,
    90_000,
  ]);
  h.stop();
});

test("a page brought to the front before any input is still loading", async () => {
  const h = harness({ visible: false });
  await tick();
  h.setVisible(true);
  expect(h.calls).toEqual([
    expect.objectContaining({ input_age_ms: null, cause: "page_load" }),
  ]);
  h.stop();
});

test("input after a report that was no attention is reported at once, once", async () => {
  const h = harness({
    answer: { recording: true, idle_seconds: 300, attention: false },
  });
  await tick();
  jest.advanceTimersByTime(2_000);
  h.input("touchstart");
  // Asked, not answered yet: more input waits for the answer.
  h.input("keydown");
  expect(h.calls.map((call) => [call.cause, call.input_age_ms])).toEqual([
    ["page_load", null],
    ["user_input", 0],
  ]);
  h.stop();
});

test("a view that moves without input follows Herdr or Roamgate, and says so", async () => {
  const h = harness();
  await tick();
  h.input();
  // Shared navigation (the store's default): Herdr moved it.
  jest.advanceTimersByTime(CAUSE_INPUT_MS + 1);
  h.update((snapshot) => ({
    ...snapshot,
    navigationMode: "shared",
    layout: layout("w2", ["w2:p1"]),
  }));
  h.update((snapshot) => ({
    ...snapshot,
    navigationMode: "browser-local",
    layout: layout("w3", ["w3:p1"]),
  }));
  // A switch right after a key: the user did it.
  h.input();
  jest.advanceTimersByTime(300);
  h.update((snapshot) => ({ ...snapshot, layout: layout("w1", ["w1:p1"]) }));
  expect(h.calls.map((call) => [call.workspace_id, call.cause])).toEqual([
    ["w1", "page_load"],
    ["w2", "follow_herdr"],
    ["w3", "app"],
    ["w1", "user_input"],
  ]);
  h.stop();
});

test("a stopped watcher sends nothing", async () => {
  const h = harness();
  await tick();
  h.stop();
  h.input();
  h.setVisible(false);
  h.update((snapshot) => ({ ...snapshot, selectedPaneId: "w1:p2" }));
  jest.advanceTimersByTime(10 * PRESENCE_REPEAT_MS);
  expect(h.calls).toHaveLength(1);
  expect(h.listeners.size).toBe(0);
});

test("the client id is kept, and phones are told from desktops", () => {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
  };
  const id = activityClientId(storage, () => "1b2c-3d4e");
  expect(id).toBe("1b2c-3d4e");
  expect(activityClientId(storage, () => "other")).toBe(id);
  expect(
    activityClientKind({ userAgent: "x", userAgentData: { mobile: true } }),
  ).toBe("phone");
  expect(
    activityClientKind({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile",
    }),
  ).toBe("phone");
  expect(
    activityClientKind({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }),
  ).toBe("desktop");
});
