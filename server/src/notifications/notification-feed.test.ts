import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantTaskNotification } from "../../../shared/assistant";
import {
  createNotificationFeed,
  FEED_PING_INTERVAL_MS,
  type FeedSocket,
} from "./notification-feed";
import type { Device, PushTask } from "./web-push";
import { createLogger } from "../utils/logger";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roamgate-feed-"));
  clock = 1_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ORIGIN = "https://roamgate.example";
const blocked: PushTask = {
  kind: "blocked",
  connectionId: "alpha",
  runtimeGeneration: 3,
  workspaceId: "w1",
  workspaceLabel: "roamgate",
  paneId: "p1",
  agent: "Claude",
};
const completed: PushTask = { ...blocked, kind: "completed", paneId: "p2" };
const ranger: AssistantTaskNotification = {
  task_id: "e68b82c6-0d6b-4083-b6b3-c3a7de983f94",
  run_id: "9023a84e-e705-4c34-bcce-77c951e2de56",
  status: "succeeded",
  title: "Ranger task completed",
  body: "Check agent progress",
};

function socket() {
  const sent: Record<string, unknown>[] = [];
  const s = {
    sent,
    pings: 0,
    closed: null as number | null,
    send(text: string) {
      sent.push(JSON.parse(text));
    },
    close(code?: number) {
      s.closed = code ?? 1000;
    },
    ping() {
      s.pings++;
    },
  };
  return s satisfies FeedSocket;
}

function feed(extra: Parameters<typeof createNotificationFeed>[0] = {}) {
  return createNotificationFeed({
    path: join(root, "notifications.json"),
    now: () => clock,
    ...extra,
  });
}

function hello(
  f: ReturnType<typeof feed>,
  message: Record<string, unknown> = {},
) {
  const s = socket();
  f.open(s, ORIGIN, "session-1");
  f.message(
    s,
    JSON.stringify({
      op: "hello",
      since: null,
      client: "android",
      // A client that asked for finished work too, unless a test says.
      preferences: { completed: true, blocked: true },
      ...message,
    }),
  );
  return s;
}

test("a hello without preferences gets only what needs the user", () => {
  const f = feed();
  const s = socket();
  f.open(s, ORIGIN, "session-1");
  f.message(s, JSON.stringify({ op: "hello", since: null, client: "android" }));
  f.publish(completed);
  f.publish(blocked);
  expect(
    s.sent
      .filter((each) => each.event === "notification")
      .map((each) => each.kind),
  ).toEqual(["blocked"]);
  expect(f.status().clients[0]?.preferences).toEqual({
    completed: false,
    blocked: true,
  });
});

test("a notification is the push payload plus its id, time, kind, group and page", () => {
  const f = feed();
  const s = hello(f);
  expect(s.sent).toEqual([{ event: "ready", last: 0 }]);
  f.publish(blocked);
  const target = {
    connectionId: "alpha",
    runtimeGeneration: 3,
    workspaceId: "w1",
    paneId: "p1",
  };
  expect(s.sent[1]).toEqual({
    event: "notification",
    id: 1,
    at: clock,
    kind: "blocked",
    title: "Roamgate agent needs input",
    body: "Claude · roamgate · p1",
    tag: JSON.stringify(["roamgate-task", "alpha", 3, "p1"]),
    group: "roamgate",
    url: `${ORIGIN}/#roamgate-task=${encodeURIComponent(JSON.stringify(target))}`,
  });
  f.publish(ranger);
  expect(s.sent[2]).toMatchObject({
    id: 2,
    kind: "ranger_task",
    group: "Ranger",
    title: "Ranger task completed",
  });
  f.publish({ ...blocked, title: "Look", body: "at this" }, { kind: "review" });
  expect(s.sent[3]).toMatchObject({ id: 3, kind: "review", title: "Look" });
  f.stop();
});

test("hello replays what came after a numeric `since`, clears included", () => {
  const f = feed();
  f.publish(blocked);
  f.publish(completed);
  f.clearPane("alpha", "p1");
  f.publish(ranger);

  // A new install (`since: null`) gets no history, only what comes next.
  const fresh = hello(f);
  expect(fresh.sent).toEqual([{ event: "ready", last: 4 }]);

  const behind = hello(f, { since: 1 });
  expect(behind.sent.map((event) => [event.event, event.id ?? null])).toEqual([
    ["notification", 2],
    ["notification_clear", 3],
    ["notification", 4],
    ["ready", null],
  ]);
  expect(behind.sent[1]).toEqual({
    event: "notification_clear",
    id: 3,
    at: clock,
    tag: JSON.stringify(["roamgate-task", "alpha", 3, "p1"]),
  });

  // Beyond the last id: the server lost its feed, so all of it again.
  const ahead = hello(f, { since: 99 });
  expect(ahead.sent.map((event) => event.id ?? null)).toEqual([2, 4, null]);

  f.publish(blocked);
  expect(fresh.sent.slice(1)).toMatchObject([{ event: "notification", id: 5 }]);
  f.stop();
});

test("nothing is sent before hello", () => {
  const f = feed();
  const s = socket();
  f.open(s, ORIGIN);
  f.publish(blocked);
  expect(s.sent).toEqual([]);
  f.stop();
});

test("the feed and its ids live through a restart", () => {
  const first = feed();
  first.publish(blocked);
  first.publish(completed);
  first.stop();
  expect(
    JSON.parse(readFileSync(join(root, "notifications.json"), "utf8")).last,
  ).toBe(2);

  const second = feed();
  const s = hello(second, { since: 1 });
  expect(s.sent.map((event) => event.id ?? null)).toEqual([2, null]);
  expect(second.publish(ranger)).toBe(3);
  second.stop();
});

test("old events are dropped after a day, and beyond 200", () => {
  const f = feed();
  f.publish(blocked);
  clock += 25 * 60 * 60 * 1000;
  for (let n = 0; n < 205; n++)
    f.publish({ ...completed, paneId: `p${n + 10}` });
  const s = hello(f, { since: 0 });
  const ids = s.sent.filter((e) => e.event === "notification").map((e) => e.id);
  expect(ids.length).toBe(200);
  expect(ids[0]).toBe(7);
  expect(s.sent.at(-1)).toEqual({ event: "ready", last: 206 });
  f.stop();
});

test("a clear goes out only for a notification still out", () => {
  const f = feed();
  const s = hello(f);
  f.clearPane("alpha", "p1");
  expect(s.sent).toHaveLength(1);
  f.publish(blocked);
  f.publish(completed);
  // The agent went back to work: its blocked notification is withdrawn, the
  // completed one of another pane stays.
  f.clearBlockedPane("alpha", "p1");
  f.clearBlockedPane("alpha", "p2");
  expect(s.sent.slice(3)).toEqual([
    {
      event: "notification_clear",
      id: 3,
      at: clock,
      tag: JSON.stringify(["roamgate-task", "alpha", 3, "p1"]),
    },
  ]);
  f.clearPane("alpha", "p2");
  expect(s.sent.at(-1)).toMatchObject({ event: "notification_clear", id: 4 });
  f.stop();
});

test("the client's preferences filter notifications, never clears", () => {
  const f = feed();
  f.publish(completed);
  const s = hello(f, { preferences: { completed: false, blocked: true } });
  expect(s.sent).toEqual([{ event: "ready", last: 1 }]);
  f.publish(blocked);
  f.publish({ ...completed, paneId: "p9" });
  f.publish({ ...ranger, status: "failed" });
  f.clearPane("alpha", "p2");
  expect(s.sent.slice(1).map((e) => [e.event, e.kind ?? null])).toEqual([
    ["notification", "blocked"],
    ["notification", "ranger_task"],
    ["notification_clear", null],
  ]);
  f.stop();
});

test("an action answers the agent's permission prompt", () => {
  const answered: unknown[] = [];
  let open = true;
  const f = feed({
    answerPrompt: (prompt, answer) => {
      answered.push([prompt, answer]);
      const was = open;
      open = false;
      return was;
    },
  });
  const s = hello(f);
  const id = f.publish(blocked, {
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    prompt: { connectionId: "alpha", promptId: "prompt-1" },
  });
  expect(s.sent[1]).toMatchObject({
    id,
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  });
  expect(s.sent[1]).not.toHaveProperty("prompt");

  // A blocked status for the same pane keeps the prompt's actions.
  const again = f.publish(blocked);
  expect(s.sent[2]).toMatchObject({ id: again, actions: [{}, {}] });
  // Nor does the agent's status withdraw it: the prompt does.
  f.clearBlockedPane("alpha", "p1");
  expect(s.sent).toHaveLength(3);

  f.message(s, JSON.stringify({ op: "action", id: again, action: "maybe" }));
  expect(s.sent.at(-1)).toEqual({
    event: "action",
    id: again,
    error: "unknown",
  });
  f.message(s, JSON.stringify({ op: "action", id: 999, action: "allow" }));
  expect(s.sent.at(-1)).toEqual({ event: "action", id: 999, error: "unknown" });

  f.message(s, JSON.stringify({ op: "action", id: again, action: "deny" }));
  expect(answered).toEqual([
    [{ connectionId: "alpha", promptId: "prompt-1" }, "deny"],
  ]);
  expect(s.sent.slice(-2)).toEqual([
    { event: "action", id: again, ok: true },
    {
      event: "notification_clear",
      id: (again as number) + 1,
      at: clock,
      tag: JSON.stringify(["roamgate-task", "alpha", 3, "p1"]),
    },
  ]);

  // Answered elsewhere first: the prompt is gone.
  const late = f.publish(blocked, {
    actions: [{ id: "allow", label: "Allow" }],
    prompt: { connectionId: "alpha", promptId: "prompt-2" },
  });
  f.message(s, JSON.stringify({ op: "action", id: late, action: "allow" }));
  expect(s.sent.at(-1)).toEqual({ event: "action", id: late, error: "gone" });

  f.clearPrompt("prompt-2");
  expect(s.sent.at(-1)).toMatchObject({ event: "notification_clear" });
  f.stop();
});

test("notifications without a prompt take no action", () => {
  const f = feed({ answerPrompt: () => true });
  const s = hello(f);
  const id = f.publish(blocked);
  expect(s.sent[1]).not.toHaveProperty("actions");
  f.message(s, JSON.stringify({ op: "action", id, action: "allow" }));
  expect(s.sent.at(-1)).toEqual({ event: "action", id, error: "unknown" });
  f.stop();
});

test("Web Push gets the same payload, and skips quiet devices while the Android app is there", () => {
  jest.useFakeTimers();
  try {
    const calls: {
      task: unknown;
      payload: unknown;
      skip: (device: Device) => boolean;
    }[] = [];
    const f = feed({
      webPush: {
        notify: (task, _isCurrent, options) =>
          calls.push({ task, payload: options.payload, skip: options.skip! }),
      },
    });
    const quiet = {
      preferences: {
        completed: true,
        blocked: true,
        quietWithAndroidApp: true,
      },
    } as Device;
    const loud = { preferences: { completed: true, blocked: true } } as Device;

    f.publish(blocked);
    expect(calls[0]!.task).toBe(blocked);
    expect(calls[0]!.payload).toMatchObject({
      title: "Roamgate agent needs input",
      tag: JSON.stringify(["roamgate-task", "alpha", 3, "p1"]),
      target: { paneId: "p1" },
    });
    expect(calls[0]!.payload).not.toHaveProperty("path");
    expect(calls[0]!.skip(quiet)).toBe(false);
    // A page path of its own (a work item's) travels in the push too, so
    // that the click lands on the item, not the app's root.
    f.publish(
      { ...blocked, paneId: "work:0123456789abcdef" },
      { kind: "work", path: "/#roamgate-work=0123456789abcdef" },
    );
    expect(calls[1]!.payload).toMatchObject({
      path: "/#roamgate-work=0123456789abcdef",
    });

    // A browser on the socket does not count; the Android app does.
    const browser = hello(f, { client: "web" });
    expect(f.androidConnected()).toBe(false);
    const app = hello(f);
    expect(f.androidConnected()).toBe(true);
    f.publish(completed);
    expect(calls[1]!.skip(quiet)).toBe(true);
    expect(calls[1]!.skip(loud)).toBe(false);

    // Pings go out; a pong keeps the app, silence drops it.
    clock += FEED_PING_INTERVAL_MS;
    jest.advanceTimersByTime(FEED_PING_INTERVAL_MS);
    expect(app.pings).toBe(1);
    f.pong(app);
    f.message(browser, JSON.stringify({ op: "ping" }));
    expect(browser.sent.at(-1)).toEqual({ event: "pong" });
    clock += FEED_PING_INTERVAL_MS * 2;
    jest.advanceTimersByTime(FEED_PING_INTERVAL_MS * 2);
    expect(app.closed).toBeNull();
    expect(f.androidConnected()).toBe(true);
    clock += FEED_PING_INTERVAL_MS * 2;
    jest.advanceTimersByTime(FEED_PING_INTERVAL_MS * 2);
    expect(app.closed).toBe(4000);
    expect(f.androidConnected()).toBe(false);
    expect(calls[1]!.skip(quiet)).toBe(false);
    f.stop();
  } finally {
    jest.useRealTimers();
  }
});

test("logging out closes that login's sockets", () => {
  const f = feed();
  const s = hello(f);
  const other = socket();
  f.open(other, ORIGIN, "session-2");
  f.closeSession("session-1");
  expect(s.closed).toBe(4001);
  expect(other.closed).toBeNull();
  f.publish(blocked);
  expect(s.sent).toHaveLength(1);
  f.stop();
});

test("bad messages are ignored", () => {
  const f = feed();
  const s = socket();
  f.open(s, ORIGIN);
  f.message(s, "not json");
  f.message(s, JSON.stringify([1]));
  f.message(s, "x".repeat(5000));
  f.message(s, JSON.stringify({ op: "action", id: 1, action: "allow" }));
  expect(s.sent).toEqual([]);
  f.stop();
});

test("status lists the open sockets: kind, address, since and last seen", () => {
  const f = feed();
  expect(f.status()).toEqual({
    last: 0,
    events: 0,
    android_connected: false,
    clients: [],
  });
  const s = socket();
  f.open(s, ORIGIN, "session-1", "192.0.2.7");
  const pending = socket();
  f.open(pending, ORIGIN);
  clock += 5_000;
  f.message(
    s,
    JSON.stringify({
      op: "hello",
      since: null,
      client: "android",
      preferences: { completed: false },
    }),
  );
  f.publish(blocked);
  clock += 1_000;
  expect(f.status()).toEqual({
    last: 1,
    events: 1,
    android_connected: true,
    clients: [
      {
        socket: 1,
        client: "android",
        remote: "192.0.2.7",
        connected_at: 1_000_000,
        last_seen: 1_005_000,
        silent_ms: 1_000,
        preferences: { completed: false, blocked: true },
      },
      {
        socket: 2,
        client: null,
        remote: null,
        connected_at: 1_000_000,
        last_seen: 1_000_000,
        silent_ms: 6_000,
        preferences: { completed: false, blocked: true },
      },
    ],
  });
  f.close(pending, 1000, "");
  expect(f.status().clients.map((each) => each.socket)).toEqual([1]);
  f.stop();
  expect(f.status().clients).toEqual([]);
});

test("connections, hellos, sends and closes are logged", () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    scope: "bridge.notifications",
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
  const f = feed({ logger });
  f.publish(completed);
  const s = socket();
  f.open(s, ORIGIN, "session-1", "192.0.2.7");
  f.message(
    s,
    JSON.stringify({
      op: "hello",
      since: 0,
      client: "android",
      preferences: { completed: true, blocked: true },
    }),
  );
  f.publish(blocked);
  clock += 2_000;
  f.close(s, 1001, "Going away");
  f.close(s, 1001, "Going away");
  const text = lines.join("\n");
  expect(lines.filter((line) => line.includes(" INFO "))).toHaveLength(3);
  expect(text).toContain(
    "notification client connected socket=1 remote=192.0.2.7 clients=1",
  );
  expect(text).toContain(
    "notification client hello socket=1 client=android since=0 completed=true blocked=true replayed=1 last=1",
  );
  expect(text).toContain(
    "notification feed sent event=notification id=2 kind=blocked tag=",
  );
  expect(text).toMatch(/id=2 kind=blocked tag=\S+ clients=1/);
  expect(text).toContain(
    'notification client disconnected socket=1 client=android code=1001 reason="Going away" lived_ms=2000 clients=0',
  );
});

test("while the Rust core owns the feed, Bun only relays: it asks the core, sends what the core gives back and reads the file again when it returns", async () => {
  const saved = feed();
  saved.publish(blocked);
  const calls: [string, Record<string, unknown>][] = [];
  const state = JSON.parse(
    readFileSync(join(root, "notifications.json"), "utf8"),
  );
  const f = feed();
  const s = hello(f);
  await f.useCore({
    call: async (op, params) => {
      calls.push([op, params]);
      return op === "state" ? state : { ok: true };
    },
  });
  let current = true;
  f.publish(completed, { isCurrent: () => current });
  f.clearTag("t");
  f.clearPane("alpha", "p1");
  f.clearBlockedPane("alpha", "p1");
  f.clearPrompt("q1");
  expect(calls.map(([op]) => op)).toEqual([
    "state",
    "publish",
    "clear_tag",
    "clear_pane",
    "clear_blocked_pane",
    "clear_prompt",
  ]);
  const publish = calls[1]![1];
  expect(publish).toMatchObject({ task: completed, android_connected: true });
  // The core asks whether what it queued is still current, by token.
  expect(f.currentCheck(publish.current as number)).toBe(true);
  current = false;
  expect(f.currentCheck(publish.current as number)).toBe(false);
  expect(f.currentCheck(999)).toBe(false);
  // Nothing written by Bun while the core owns the file.
  expect(readFileSync(join(root, "notifications.json"), "utf8")).toBe(
    `${JSON.stringify(state)}\n`,
  );
  // The core's events after a change: the copy, and what to send now.
  const event = {
    event: "notification",
    id: 2,
    at: clock,
    kind: "completed",
    title: "done",
    body: "b",
    tag: "x",
    group: "roamgate",
    path: "/",
    pref: "completed",
  };
  s.sent.length = 0;
  f.applyCore({ last: 2, events: [...state.events, event] }, [2]);
  expect(s.sent).toEqual([
    {
      event: "notification",
      id: 2,
      at: clock,
      kind: "completed",
      title: "done",
      body: "b",
      tag: "x",
      group: "roamgate",
      url: `${ORIGIN}/`,
    },
  ]);
  expect(f.status()).toMatchObject({ last: 2, events: 2 });
  // Back to Bun: the file is read again (the core's last write).
  await f.useCore(null);
  expect(f.status()).toMatchObject({ last: 1, events: 1 });
});
