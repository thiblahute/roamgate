import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertSafeDataPath,
  dataRoot,
  replaceDataFile,
} from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import { type Logger, silentLogger } from "../utils/logger";
import {
  type Device,
  notificationPreference,
  type PushNotification,
  taskPushPayload,
} from "./web-push";

/**
 * One source for every notification Roamgate sends: it builds the message
 * once and hands it to two sinks, Web Push (browsers) and the notification
 * socket (`/api/notifications/ws`, the Android app's foreground service).
 * The socket's events are numbered and kept in the data directory, so a
 * client that reconnects (or a server that restarts) replays what it missed.
 * The contract is in docs/ARCHITECTURE.md.
 */

export type FeedKind =
  | "blocked"
  | "completed"
  | "review"
  | "ranger_task"
  | "effort"
  | "work";
export type FeedAction = { id: "allow" | "deny"; label: string };
/** What an action on a notification answers: an agent's permission prompt. */
export type FeedPrompt = { connectionId: string; promptId: string };

type StoredNotification = {
  event: "notification";
  id: number;
  at: number;
  kind: FeedKind;
  title: string;
  body: string;
  tag: string;
  group: string;
  /** The page path a click opens; each socket prefixes its own origin. */
  path: string;
  actions?: FeedAction[];
  /** Which client switch lets it through. */
  pref: "completed" | "blocked";
  /** `<connection>\n<pane>`, for clears by pane. */
  pane?: string;
  prompt?: FeedPrompt;
};
type StoredClear = {
  event: "notification_clear";
  id: number;
  at: number;
  tag: string;
};
type Stored = StoredNotification | StoredClear;
type Saved = { version: 1; last: number; events: Stored[] };

/** The socket as the feed uses it: Bun's ServerWebSocket fits. */
export type FeedSocket = {
  send(text: string): unknown;
  close(code?: number, reason?: string): void;
  ping?(): unknown;
};
type Client = {
  /** A number per socket, to follow one in the log. */
  socketId: number;
  origin: string;
  /** The peer's address, when the server knows it. */
  remote?: string;
  connectedAt: number;
  sessionToken?: string;
  /** Null until its hello: nothing is sent before. */
  client: string | null;
  preferences: { completed: boolean; blocked: boolean };
  lastSeen: number;
};

const MAX_EVENTS = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 4096;
/** A ping each interval; a client silent for the timeout is gone. */
export const FEED_PING_INTERVAL_MS = 25_000;
export const FEED_SILENCE_TIMEOUT_MS = 70_000;
const TITLE_CHARS = 200;
const BODY_CHARS = 1000;

export function notificationFeedPath(
  environment: Record<string, string | undefined> = process.env,
  root = dataRoot(),
): string {
  return (
    roamgateEnv("NOTIFICATIONS_PATH", environment) ??
    join(root, "notifications.json")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function load(path: string): Saved {
  const empty: Saved = { version: 1, last: 0, events: [] };
  try {
    assertSafeDataPath(path);
    if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return empty;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.last) ||
      !Array.isArray(value.events)
    )
      return empty;
    const events = value.events.filter(
      (event): event is Stored =>
        isRecord(event) &&
        (event.event === "notification" ||
          event.event === "notification_clear") &&
        Number.isSafeInteger(event.id) &&
        Number.isFinite(event.at) &&
        typeof event.tag === "string" &&
        (event.event === "notification_clear" ||
          (typeof event.title === "string" &&
            typeof event.body === "string" &&
            typeof event.path === "string" &&
            typeof event.group === "string" &&
            (event.pref === "completed" || event.pref === "blocked"))),
    );
    return { version: 1, last: value.last as number, events };
  } catch {
    return empty;
  }
}

/** The page a click on the notification opens: what the service worker does. */
export function notificationPath(target: unknown): string {
  return target
    ? `/#roamgate-task=${encodeURIComponent(JSON.stringify(target))}`
    : "/";
}

/** What the notification is about, for the client to group by. */
function groupOf(task: PushNotification): string {
  if ("task_id" in task) return "Ranger";
  return (
    task.workspaceLabel?.trim() ||
    task.workspaceId ||
    task.connectionLabel?.trim() ||
    task.connectionId
  ).slice(0, 80);
}

function kindOf(task: PushNotification): FeedKind {
  return "task_id" in task ? "ranger_task" : task.kind;
}

function wire(event: Stored, origin: string): string {
  if (event.event === "notification_clear")
    return JSON.stringify({
      event: event.event,
      id: event.id,
      at: event.at,
      tag: event.tag,
    });
  return JSON.stringify({
    event: event.event,
    id: event.id,
    at: event.at,
    kind: event.kind,
    title: event.title,
    body: event.body,
    tag: event.tag,
    group: event.group,
    url: origin + event.path,
    ...(event.actions?.length ? { actions: event.actions } : {}),
  });
}

export function createNotificationFeed(options: {
  path?: string;
  now?: () => number;
  /** The Web Push sink; absent in tests that only watch the socket. */
  webPush?: {
    notify(
      task: PushNotification,
      isCurrent: () => boolean,
      options: {
        payload?: ReturnType<typeof taskPushPayload>;
        skip?: (device: Device) => boolean;
      },
    ): void;
  };
  /** Answers an agent's permission prompt; false when it is gone. */
  answerPrompt?: (prompt: FeedPrompt, answer: "allow" | "deny") => boolean;
  warn?: (message: string) => void;
  /** Connections, hellos and closes at info; each event sent at debug. */
  logger?: Logger;
}) {
  const path = options.path ?? notificationFeedPath();
  const now = options.now ?? Date.now;
  const warn = options.warn ?? (() => {});
  const logger = options.logger ?? silentLogger;
  const saved = load(path);
  let last = saved.last;
  let events = saved.events;
  const clients = new Map<FeedSocket, Client>();
  let socketIds = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function prune() {
    const oldest = now() - MAX_AGE_MS;
    events = events.filter((event) => event.at >= oldest);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  }

  function save() {
    prune();
    try {
      replaceDataFile(
        path,
        JSON.stringify({ version: 1, last, events } satisfies Saved) + "\n",
      );
    } catch {
      warn("Unable to save the notification feed; events stay in memory.");
    }
  }

  function send(socket: FeedSocket, text: string) {
    try {
      socket.send(text);
    } catch {
      // A closing socket: its close handler removes it.
    }
  }

  function deliver(event: Stored) {
    let to = 0;
    for (const [socket, client] of clients) {
      if (client.client === null) continue;
      if (event.event === "notification" && !client.preferences[event.pref])
        continue;
      send(socket, wire(event, client.origin));
      to++;
    }
    logger.debug("notification feed sent", {
      event: event.event,
      id: event.id,
      ...(event.event === "notification" ? { kind: event.kind } : {}),
      tag: event.tag,
      clients: to,
    });
  }

  /** Forgets a socket's client, logging how long it lived. */
  function drop(socket: FeedSocket, code?: number, reason?: string) {
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);
    logger.info("notification client disconnected", {
      socket: client.socketId,
      client: client.client ?? "none",
      code,
      reason: reason || undefined,
      lived_ms: now() - client.connectedAt,
      clients: clients.size,
    });
    if (!clients.size) stopHeartbeat();
  }

  function append(event: Stored) {
    events.push(event);
    save();
    deliver(event);
  }

  /** An Android app holds the socket and answered within the timeout. */
  function androidConnected(): boolean {
    const fresh = now() - FEED_SILENCE_TIMEOUT_MS;
    for (const client of clients.values())
      if (client.client === "android" && client.lastSeen >= fresh) return true;
    return false;
  }

  function live(tag: string) {
    return events.some(
      (event) => event.event === "notification" && event.tag === tag,
    );
  }

  /** Withdraws the notifications with this tag, if any is still out. */
  function clearTag(tag: string) {
    if (!live(tag)) return;
    events = events.filter((event) => event.tag !== tag);
    append({ event: "notification_clear", id: ++last, at: now(), tag });
  }

  function clearWhere(match: (event: StoredNotification) => boolean) {
    const tags = new Set<string>();
    for (const event of events)
      if (event.event === "notification" && match(event)) tags.add(event.tag);
    for (const tag of tags) clearTag(tag);
  }

  function heartbeatTick() {
    const silent = now() - FEED_SILENCE_TIMEOUT_MS;
    for (const [socket, client] of clients) {
      if (client.lastSeen < silent) {
        drop(socket, 4000, "No heartbeat");
        try {
          socket.close(4000, "No heartbeat");
        } catch {
          // Already closed.
        }
        continue;
      }
      try {
        socket.ping?.();
      } catch {
        // A closing socket.
      }
    }
    if (!clients.size) stopHeartbeat();
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function hello(socket: FeedSocket, client: Client, message: unknown) {
    if (!isRecord(message)) return;
    const since =
      Number.isSafeInteger(message.since) && (message.since as number) >= 0
        ? (message.since as number)
        : null;
    client.client =
      typeof message.client === "string" && message.client
        ? message.client.slice(0, 40)
        : "unknown";
    const preferences = isRecord(message.preferences)
      ? message.preferences
      : {};
    client.preferences = {
      // Finished work only when the client asks for it: by default, only
      // what needs the user notifies.
      completed: preferences.completed === true,
      blocked: preferences.blocked !== false,
    };
    prune();
    // No id (a new install): no history, only what comes next. An id beyond
    // the last means the server lost its feed: replay all of it.
    const from = since === null ? last : since <= last ? since : null;
    let replayed = 0;
    for (const event of events) {
      if (from !== null ? event.id <= from : event.event !== "notification")
        continue;
      if (event.event === "notification" && !client.preferences[event.pref])
        continue;
      send(socket, wire(event, client.origin));
      replayed++;
    }
    send(socket, JSON.stringify({ event: "ready", last }));
    logger.info("notification client hello", {
      socket: client.socketId,
      client: client.client,
      since: since ?? "none",
      completed: client.preferences.completed,
      blocked: client.preferences.blocked,
      replayed,
      last,
    });
  }

  function action(socket: FeedSocket, message: Record<string, unknown>) {
    const id = message.id;
    const reply = (result: { ok: true } | { error: string }) =>
      send(
        socket,
        JSON.stringify({
          event: "action",
          id: Number.isSafeInteger(id) ? id : null,
          ...result,
        }),
      );
    const event = events.find(
      (each): each is StoredNotification =>
        each.event === "notification" && each.id === id,
    );
    const chosen = event?.actions?.find((each) => each.id === message.action);
    if (!event || !chosen || !event.prompt || !options.answerPrompt)
      return reply({ error: "unknown" });
    if (!options.answerPrompt(event.prompt, chosen.id))
      return reply({ error: "gone" });
    reply({ ok: true });
    clearTag(event.tag);
  }

  return {
    /**
     * Sends one notification to both sinks. `kind` overrides the one the
     * notification implies (an agent's own `notify` is a "review").
     */
    publish(
      task: PushNotification,
      extra: {
        kind?: FeedKind;
        isCurrent?: () => boolean;
        actions?: FeedAction[];
        prompt?: FeedPrompt;
        /** The page path a click opens, when not the task's pane. */
        path?: string;
      } = {},
    ) {
      const isCurrent = extra.isCurrent ?? (() => true);
      if (!isCurrent()) return;
      // A page path of its own (a work item's) travels in the push too.
      const payload = taskPushPayload(task, extra.path);
      const event: StoredNotification = {
        event: "notification",
        id: ++last,
        at: now(),
        kind: extra.kind ?? kindOf(task),
        title: payload.title.slice(0, TITLE_CHARS),
        body: payload.body.slice(0, BODY_CHARS),
        tag: payload.tag,
        group: groupOf(task),
        path: extra.path ?? notificationPath(payload.target),
        ...(extra.actions?.length && extra.prompt
          ? { actions: extra.actions, prompt: extra.prompt }
          : {}),
        pref: notificationPreference(task),
        ...("task_id" in task || !task.paneId
          ? {}
          : { pane: `${task.connectionId}\n${task.paneId}` }),
      };
      // A newer notification replaces one with its tag, as on the device;
      // an agent still waiting on a permission prompt keeps its actions.
      const waiting = events.find(
        (each): each is StoredNotification =>
          each.event === "notification" && each.tag === event.tag,
      );
      if (!event.prompt && waiting?.prompt && waiting.actions) {
        event.prompt = waiting.prompt;
        event.actions = waiting.actions;
      }
      events = events.filter((each) => each.tag !== event.tag);
      append(event);
      options.webPush?.notify(task, isCurrent, {
        payload,
        skip: (device) =>
          device.preferences.quietWithAndroidApp === true && androidConnected(),
      });
      return event.id;
    },
    clearTag,
    /** The user looked at the pane: its notifications are done with. */
    clearPane(connectionId: string, paneId: string) {
      const pane = `${connectionId}\n${paneId}`;
      clearWhere((event) => event.pane === pane);
    },
    /** The pane's agent stopped waiting on the user. */
    clearBlockedPane(connectionId: string, paneId: string) {
      const pane = `${connectionId}\n${paneId}`;
      // A permission prompt's notification goes with the prompt instead.
      clearWhere(
        (event) =>
          event.pane === pane && event.kind === "blocked" && !event.prompt,
      );
    },
    /** The prompt was answered, or went back to the terminal. */
    clearPrompt(promptId: string) {
      clearWhere((event) => event.prompt?.promptId === promptId);
    },
    androidConnected,
    open(
      socket: FeedSocket,
      origin: string,
      sessionToken?: string,
      remote?: string,
    ) {
      const client: Client = {
        socketId: ++socketIds,
        origin,
        ...(remote ? { remote } : {}),
        connectedAt: now(),
        ...(sessionToken ? { sessionToken } : {}),
        client: null,
        preferences: { completed: false, blocked: true },
        lastSeen: now(),
      };
      clients.set(socket, client);
      heartbeat ??= setInterval(heartbeatTick, FEED_PING_INTERVAL_MS);
      logger.info("notification client connected", {
        socket: client.socketId,
        remote: remote || "unknown",
        clients: clients.size,
      });
    },
    message(socket: FeedSocket, data: string | Buffer) {
      const client = clients.get(socket);
      if (!client) return;
      client.lastSeen = now();
      const text = typeof data === "string" ? data : data.toString();
      if (text.length > MAX_MESSAGE_BYTES) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.op === "hello") hello(socket, client, message);
      else if (message.op === "ping")
        send(socket, JSON.stringify({ event: "pong" }));
      else if (message.op === "action" && client.client !== null)
        action(socket, message);
    },
    /** A pong to the server's ping: the client is still there. */
    pong(socket: FeedSocket) {
      const client = clients.get(socket);
      if (client) client.lastSeen = now();
    },
    close(socket: FeedSocket, code?: number, reason?: string) {
      drop(socket, code, reason);
    },
    /** Logging out closes the sockets that login opened. */
    closeSession(sessionToken: string) {
      for (const [socket, client] of clients) {
        if (client.sessionToken !== sessionToken) continue;
        drop(socket, 4001, "Logged out");
        try {
          socket.close(4001, "Logged out");
        } catch {
          // Already closed.
        }
      }
    },
    /** The sockets open now, for `bridge.notifications.status`. */
    status() {
      const at = now();
      return {
        last,
        events: events.length,
        android_connected: androidConnected(),
        clients: [...clients.values()].map((client) => ({
          socket: client.socketId,
          client: client.client,
          remote: client.remote ?? null,
          connected_at: client.connectedAt,
          last_seen: client.lastSeen,
          silent_ms: at - client.lastSeen,
          preferences: { ...client.preferences },
        })),
      };
    },
    stop() {
      stopHeartbeat();
      for (const socket of clients.keys())
        try {
          socket.close(1001, "Server stopping");
        } catch {
          // Already closed.
        }
      clients.clear();
    },
  };
}

export type NotificationFeed = ReturnType<typeof createNotificationFeed>;
