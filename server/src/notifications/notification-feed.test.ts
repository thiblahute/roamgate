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
    JSON.stringify({ op: "hello", since: null, client: "android", ...message }),
  );
  return s;
}

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

test("hello replays what came after `since`, clears included", () => {
  const f = feed();
  f.publish(blocked);
  f.publish(completed);
  f.clearPane("alpha", "p1");
  f.publish(ranger);

  const fresh = hello(f);
  // A fresh client gets the notifications still out, not the clears.
  expect(fresh.sent.map((event) => [event.event, event.id ?? null])).toEqual([
    ["notification", 2],
    ["notification", 4],
    ["ready", null],
  ]);
  expect(fresh.sent.at(-1)).toEqual({ event: "ready", last: 4 });

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
  const s = hello(f);
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
    expect(calls[0]!.skip(quiet)).toBe(false);

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
