import { useCallback, useEffect, useSyncExternalStore } from "react";
import type {
  AgentChatEvent,
  AgentChatHandoverResult,
  AgentChatOwner,
  AgentChatQueued,
  AgentChatState,
  AgentChatVoiceAction,
} from "../../shared/agentChat";
import { bridge, type ConnectionClient, type HerdrEventMsg } from "./api";
import type { HistoryEntry } from "./components/agentHistory";
import {
  applyLiveEvent,
  EMPTY_LIVE_TURN,
  type LiveTurn,
  reconcileLiveTurn,
  withStreamedText,
} from "./components/liveTurn";

/**
 * Conversation mode in the browser: per pane, the bridge's state of the
 * session (who owns it, what the headless Claude does, its queue), the turn
 * being streamed, and the last handover refused. One subscription per pane
 * whatever the number of views on it; views re-render at most once a frame,
 * while event listeners (voice) hear each event as it comes.
 */
export type AgentChatSnapshot = {
  state: AgentChatState | null;
  live: LiveTurn;
  /** Why the last handover asked from here was refused. */
  refusal: string | null;
  /** A handover asked from here, still running. */
  handing: AgentChatOwner | null;
  /**
   * Messages the bridge took out of its queue to send, still shown as
   * queued until their replay (or the transcript) shows them.
   */
  departing: readonly DepartingQueued[];
};

/** A message on its way out of the bridge's queue. */
export type DepartingQueued = AgentChatQueued & { left_at: number };

/**
 * How long a message taken out of the queue waits for its replay before it
 * stops showing (a replay lost with a socket, a turn that never started).
 */
export const DEPARTING_MS = 30_000;

type Entry = {
  key: string;
  connectionId: string;
  paneId: string;
  client: ConnectionClient;
  refs: number;
  snapshot: AgentChatSnapshot;
  listeners: Set<() => void>;
  eventListeners: Set<(event: AgentChatEvent) => void>;
  frame: number | null;
  subscribed: boolean;
  /** What this browser shows of the pane now; the bridge arbitrates by it. */
  view: AgentChatView | null;
  /** Queue items this browser takes back: no replay will come for them. */
  withdrawn: Set<string>;
  /** Drops the departing messages whose replay did not come in time. */
  departTimer: ReturnType<typeof setTimeout> | null;
};

/** What a browser shows of a pane: its chat or its terminal. */
export type AgentChatView = "chat" | "terminal";

const EMPTY: AgentChatSnapshot = {
  state: null,
  live: EMPTY_LIVE_TURN,
  refusal: null,
  handing: null,
  departing: [],
};

const entries = new Map<string, Entry>();
let unlistenBridge: (() => void) | null = null;

const entryKey = (connectionId: string, paneId: string) =>
  `${connectionId}\u0000${paneId}`;

const nextFrame =
  typeof requestAnimationFrame === "function"
    ? (callback: () => void) => requestAnimationFrame(callback)
    : (callback: () => void) => setTimeout(callback, 16) as unknown as number;

function notify(entry: Entry, now = false) {
  const run = () => {
    entry.frame = null;
    for (const listener of entry.listeners) listener();
  };
  if (now) {
    run();
    return;
  }
  entry.frame ??= nextFrame(run);
}

function update(
  entry: Entry,
  patch: Partial<AgentChatSnapshot>,
  now = false,
): void {
  const next = { ...entry.snapshot, ...patch };
  if (
    next.state === entry.snapshot.state &&
    next.live === entry.snapshot.live &&
    next.refusal === entry.snapshot.refusal &&
    next.handing === entry.snapshot.handing &&
    next.departing === entry.snapshot.departing
  )
    return;
  entry.snapshot = next;
  notify(entry, now);
  armDepartTimer(entry);
}

function armDepartTimer(entry: Entry) {
  const oldest = entry.snapshot.departing[0];
  if (!oldest || entry.departTimer) return;
  entry.departTimer = setTimeout(
    () => {
      entry.departTimer = null;
      update(entry, {
        departing: expireDeparting(entry.snapshot.departing, Date.now()),
      });
      armDepartTimer(entry);
    },
    Math.max(0, oldest.left_at + DEPARTING_MS - Date.now()) + 50,
  );
}

function expireDeparting(
  departing: readonly DepartingQueued[],
  now: number,
): readonly DepartingQueued[] {
  const kept = departing.filter((item) => now - item.left_at < DEPARTING_MS);
  return kept.length === departing.length ? departing : kept;
}

/**
 * The messages on their way out of the bridge's queue, with one more event.
 * The bridge empties its queue as it writes it to Claude, and Claude's
 * replay of the message comes a moment later: until then the message stays
 * shown as queued, so the chat never loses it for a frame. Items this
 * browser took back are not on their way. The same array if unchanged.
 */
export function departingAfterEvent(
  departing: readonly DepartingQueued[],
  queueBefore: readonly AgentChatQueued[] | undefined,
  event: AgentChatEvent,
  withdrawn: ReadonlySet<string>,
  now: number,
): readonly DepartingQueued[] {
  const current = expireDeparting(departing, now);
  switch (event.type) {
    case "queue": {
      const queued = new Set(event.queue.map((item) => item.id));
      const kept = current.filter((item) => !queued.has(item.id));
      const known = new Set(kept.map((item) => item.id));
      const left = (queueBefore ?? []).filter(
        (item) =>
          !queued.has(item.id) &&
          !withdrawn.has(item.id) &&
          !known.has(item.id),
      );
      if (!left.length && kept.length === current.length) return current;
      return [...kept, ...left.map((item) => ({ ...item, left_at: now }))];
    }
    case "user": {
      if (!current.length) return current;
      const mine = current.filter((item) => item.id !== event.uuid);
      // Several queued messages go as one turn under a new uuid.
      return mine.length < current.length ? mine : [];
    }
    case "lease":
      return event.phase === "terminal" && current.length ? [] : current;
    default:
      return current;
  }
}

/** The bridge's state with one more event; the same object if unchanged. */
export function applyStateEvent(
  state: AgentChatState | null,
  event: AgentChatEvent,
): AgentChatState | null {
  if (!state) return state;
  switch (event.type) {
    case "status":
      return {
        ...state,
        status: event.status,
        tools_running: event.tools_running,
        activity: event.activity,
      };
    case "queue":
      return { ...state, queue: event.queue };
    case "lease":
      return {
        ...state,
        owner: event.owner,
        phase: event.phase,
        session_id: event.session_id,
        ...(event.phase === "terminal"
          ? {
              status: "stopped" as const,
              queue: [],
              activity: null,
              interrupted: null,
            }
          : {}),
      };
    case "session":
      return { ...state, session_id: event.session_id };
    case "result":
      return { ...state, tools_running: false, activity: null };
    case "interrupted":
      return { ...state, interrupted: event.interrupted };
    default:
      return state;
  }
}

/**
 * What the chat says after its last entry when the last turn was cut
 * short (a Roamgate restart, Claude's process exiting); null otherwise,
 * and while a turn runs again.
 */
export function cutOffNotice(state: AgentChatState | null): string | null {
  const interrupted = state?.interrupted;
  if (!interrupted || state.phase !== "conversation") return null;
  if (
    state.status === "working" ||
    state.status === "blocked" ||
    state.status === "starting"
  )
    return null;
  return interrupted.reason === "restart"
    ? "Cut off by a Roamgate restart"
    : "Claude stopped unexpectedly";
}

function handleEvent(message: HerdrEventMsg) {
  if (!message.event.startsWith("agent_chat.")) return;
  const data = message.data as unknown as AgentChatEvent & {
    pane_id?: string;
  };
  if (typeof data.pane_id !== "string") return;
  const entry = entries.get(entryKey(message.connection_id, data.pane_id));
  if (!entry) return;
  const event = {
    ...data,
    type: message.event.slice("agent_chat.".length),
  } as AgentChatEvent;
  const { snapshot } = entry;
  const now = Date.now();
  const departing = departingAfterEvent(
    snapshot.departing,
    snapshot.state?.queue,
    event,
    entry.withdrawn,
    now,
  );
  if (event.type === "queue")
    for (const id of entry.withdrawn)
      if (!event.queue.some((item) => item.id === id))
        entry.withdrawn.delete(id);
  update(
    entry,
    {
      state: applyStateEvent(snapshot.state, event),
      live: applyLiveEvent(snapshot.live, event, now),
      departing,
      ...(event.type === "lease" && event.phase !== "terminal"
        ? { refusal: null }
        : {}),
    },
    // A user replay takes over from the outbox or queued bubble it
    // replays: drawn at once, so the views never show neither.
    event.type === "user",
  );
  for (const listener of entry.eventListeners) listener(event);
}

/**
 * The turn streamed before a new subscription, once the bridge says none
 * runs (a Roamgate restart killed it): ended, so its items go once the
 * transcript has them, or after their grace.
 */
export function liveAfterSubscribe(
  live: LiveTurn,
  state: AgentChatState,
  now: number,
): LiveTurn {
  if (live.endedAt !== null) return live;
  if (state.status === "working" || state.status === "blocked") return live;
  return { ...live, endedAt: now };
}

/**
 * Delays before asking again for a subscription refused: a socket back
 * from a Roamgate restart says hello before the browser knows the new
 * runtime's generation, and its first calls are refused.
 */
export const SUBSCRIBE_RETRY_MS = [
  250, 500, 1000, 2000, 4000, 4000, 4000, 4000,
];

function subscribe(entry: Entry, attempt = 0) {
  entry.subscribed = true;
  const client = entry.client;
  const current = () =>
    entries.get(entry.key) === entry && entry.client === client;
  Promise.resolve()
    .then(() =>
      client.call("agent_chat.subscribe", {
        pane_id: entry.paneId,
        view: entry.view,
      }),
    )
    .then((result) => {
      if (!current()) return;
      const { streamed, ...rest } = (result ?? {}) as AgentChatState;
      const state = result ? (rest as AgentChatState) : null;
      const now = Date.now();
      const departing = entry.snapshot.departing.filter(
        (item) => !state?.queue.some((each) => each.id === item.id),
      );
      update(
        entry,
        {
          state,
          live: state
            ? liveAfterSubscribe(
                withStreamedText(entry.snapshot.live, streamed, now),
                state,
                now,
              )
            : entry.snapshot.live,
          ...(departing.length < entry.snapshot.departing.length
            ? { departing }
            : {}),
        },
        true,
      );
    })
    .catch(() => {
      // Another client took over: it subscribed itself.
      if (!current()) return;
      const delay = SUBSCRIBE_RETRY_MS[attempt];
      // An older bridge, or a Windows host: no conversation mode here.
      if (delay === undefined || entry.refs <= 0) {
        entry.subscribed = false;
        return;
      }
      setTimeout(() => {
        if (!current()) return;
        if (entry.refs > 0) subscribe(entry, attempt + 1);
        else entry.subscribed = false;
      }, delay);
    });
}

/**
 * Follows a pane's conversation mode while the returned function is not
 * called. A new client (a reconnect) subscribes again.
 */
export function watchAgentChat(
  client: ConnectionClient,
  paneId: string,
): () => void {
  // A test's stand-in bridge may have no events.
  if (!unlistenBridge && typeof bridge.onEvent === "function") {
    unlistenBridge = bridge.onEvent(handleEvent);
    // A new socket has no subscriptions: each pane followed asks again.
    bridge.onHello?.(() => {
      for (const each of entries.values()) if (each.refs > 0) subscribe(each);
    });
  }
  const key = entryKey(client.connectionId, paneId);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      connectionId: client.connectionId,
      paneId,
      client,
      refs: 0,
      snapshot: EMPTY,
      listeners: new Set(),
      eventListeners: new Set(),
      frame: null,
      subscribed: false,
      view: null,
      withdrawn: new Set(),
      departTimer: null,
    };
    entries.set(key, entry);
  }
  entry.refs += 1;
  if (entry.client !== client || !entry.subscribed) {
    entry.client = client;
    subscribe(entry);
  }
  const watched = entry;
  return () => {
    watched.refs -= 1;
    if (watched.refs > 0) return;
    // Kept a moment: a view remounting (pane view switch) takes it back.
    setTimeout(() => {
      if (watched.refs > 0 || entries.get(watched.key) !== watched) return;
      entries.delete(watched.key);
      if (watched.departTimer) clearTimeout(watched.departTimer);
      if (watched.subscribed && watched.client.isCurrent())
        void watched.client
          .call("agent_chat.unsubscribe", { pane_id: watched.paneId })
          .catch(() => {});
    }, 1000);
  };
}

function entryFor(connectionId: string | null, paneId: string | undefined) {
  return connectionId && paneId
    ? entries.get(entryKey(connectionId, paneId))
    : undefined;
}

/** The pane's conversation mode now, outside React. */
export function agentChatSnapshot(
  connectionId: string | null,
  paneId: string | undefined,
): AgentChatSnapshot {
  return entryFor(connectionId, paneId)?.snapshot ?? EMPTY;
}

/** Hears every event of a pane's stream, as it comes. */
export function onAgentChatEvent(
  connectionId: string,
  paneId: string,
  listener: (event: AgentChatEvent) => void,
): () => void {
  const entry = entryFor(connectionId, paneId);
  if (!entry) return () => {};
  entry.eventListeners.add(listener);
  return () => entry.eventListeners.delete(listener);
}

/**
 * A Claude pane's conversation mode, followed while `enabled`: null for
 * other panes.
 */
export function useAgentChat(
  client: ConnectionClient,
  paneId: string | undefined,
  enabled: boolean,
): AgentChatSnapshot | null {
  useEffect(() => {
    if (!enabled || !paneId) return;
    return watchAgentChat(client, paneId);
  }, [client, enabled, paneId]);
  const connectionId = client.connectionId;
  const subscribeSnapshot = useCallback(
    (listener: () => void) => {
      if (!enabled || !paneId) return () => {};
      // The entry may only exist once the effect above ran.
      let attached: Entry | undefined;
      const attach = () => {
        const entry = entryFor(connectionId, paneId);
        if (entry && entry !== attached) {
          attached?.listeners.delete(listener);
          entry.listeners.add(listener);
          attached = entry;
          listener();
        }
      };
      attach();
      const timer = attached ? null : setTimeout(attach, 0);
      return () => {
        if (timer) clearTimeout(timer);
        attached?.listeners.delete(listener);
      };
    },
    [connectionId, enabled, paneId],
  );
  const read = () =>
    enabled && paneId ? agentChatSnapshot(connectionId, paneId) : EMPTY;
  const snapshot = useSyncExternalStore(subscribeSnapshot, read, read);
  return enabled && paneId ? snapshot : null;
}

/**
 * Drops the streamed items, and the messages on their way out of the queue,
 * that the transcript now shows.
 */
export function settleAgentChatLive(
  connectionId: string | null,
  paneId: string,
  history: readonly HistoryEntry[],
) {
  const entry = entryFor(connectionId, paneId);
  if (!entry) return;
  const { departing } = entry.snapshot;
  const recorded = departing.length ? historyUserUuids(history) : null;
  const kept = recorded
    ? departing.filter((item) => !recorded.has(item.id))
    : departing;
  update(entry, {
    live: reconcileLiveTurn(entry.snapshot.live, history, Date.now()),
    departing: kept.length === departing.length ? departing : kept,
  });
}

/** The uuids of the transcript's user messages. */
export function historyUserUuids(
  history: readonly HistoryEntry[],
): Set<string> {
  const uuids = new Set<string>();
  for (const entry of history)
    if (entry.uuid && entry.role === "user") uuids.add(entry.uuid);
  return uuids;
}

/**
 * Tells the bridge what this browser shows of the pane (null: nothing
 * visible). An automatic handover goes ahead only when no other browser
 * shows the pane in the other view.
 */
export function setAgentChatView(
  client: ConnectionClient,
  paneId: string,
  view: AgentChatView | null,
) {
  const entry = entryFor(client.connectionId, paneId);
  if (!entry || entry.view === view) return;
  entry.view = view;
  // Not subscribed yet: the subscription carries it.
  if (entry.subscribed && entry.client === client && client.isCurrent())
    void client
      .call("agent_chat.view", { pane_id: paneId, view })
      .catch(() => {});
}

/**
 * Asks the bridge to hand the session over; a refusal is kept, with its
 * reason, for the chat header and the terminal's notice. `auto` marks one
 * that follows the view shown: the bridge refuses it while another device
 * shows the other view, where the user's own switch goes ahead.
 */
export async function requestAgentChatHandover(
  client: ConnectionClient,
  paneId: string,
  to: AgentChatOwner,
  options: {
    interrupt?: boolean;
    sessionId?: string | null;
    auto?: boolean;
  } = {},
): Promise<AgentChatHandoverResult> {
  const entry = entryFor(client.connectionId, paneId);
  if (entry) update(entry, { handing: to }, true);
  let result: AgentChatHandoverResult;
  try {
    result = (await client.call(
      "agent_chat.handover",
      {
        pane_id: paneId,
        to,
        ...(options.interrupt ? { interrupt: true } : {}),
        ...(options.auto ? { auto: true } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
      },
      // Taking over waits for Claude to exit and the holder to start.
      90_000,
    )) as AgentChatHandoverResult;
  } catch (error) {
    result = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const current = entryFor(client.connectionId, paneId);
  if (current) {
    let state = current.snapshot.state;
    try {
      state = (await client.call("agent_chat.state", {
        pane_id: paneId,
      })) as AgentChatState;
    } catch {
      // The lease event says it too.
    }
    update(
      current,
      {
        handing: null,
        refusal: result.ok ? null : result.reason,
        state,
      },
      true,
    );
  }
  return result;
}

export type AgentChatSendResult = {
  status: "sent" | "queued";
  id: string;
};

export function sendAgentChat(
  client: ConnectionClient,
  paneId: string,
  input: { text: string; images?: string[]; uuid?: string },
): Promise<AgentChatSendResult> {
  return client.call("agent_chat.send", {
    pane_id: paneId,
    text: input.text,
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.uuid ? { uuid: input.uuid } : {}),
  });
}

/** Speech for the session: the bridge picks interrupt, steer or send. */
export function sendAgentChatVoice(
  client: ConnectionClient,
  paneId: string,
  input: { text: string; stop?: boolean; uuid?: string },
): Promise<{ action: AgentChatVoiceAction; id?: string }> {
  return client.call("agent_chat.voice", {
    pane_id: paneId,
    text: input.text,
    ...(input.stop ? { stop: true } : {}),
    ...(input.uuid ? { uuid: input.uuid } : {}),
  });
}

export function interruptAgentChat(
  client: ConnectionClient,
  paneId: string,
): Promise<{ interrupted: boolean }> {
  return client.call("agent_chat.interrupt", { pane_id: paneId });
}

/** Drops the notice of a turn cut short, for every browser. */
export function dismissAgentChatInterrupted(
  client: ConnectionClient,
  paneId: string,
): Promise<{ ok: boolean }> {
  return client.call("agent_chat.interrupted.dismiss", { pane_id: paneId });
}

/** Takes a message back out of the bridge's queue: it is not sent. */
export async function removeAgentChatQueued(
  client: ConnectionClient,
  paneId: string,
  id: string,
): Promise<{ removed: AgentChatQueued | null }> {
  const entry = entryFor(client.connectionId, paneId);
  // The queue event comes before the answer: it must not show as sent.
  entry?.withdrawn.add(id);
  try {
    return (await client.call("agent_chat.queue.remove", {
      pane_id: paneId,
      id,
    })) as { removed: AgentChatQueued | null };
  } catch (error) {
    entry?.withdrawn.delete(id);
    throw error;
  }
}

/** The bridge's queue as chat entries, after the live turn. */
export function queuedEntries(
  queue: readonly AgentChatQueued[],
): HistoryEntry[] {
  return queue.map((item) => ({
    id: `queue:${item.id}`,
    role: "user",
    kind: "message",
    text: [item.text, ...item.images].filter(Boolean).join("\n"),
    sent_at: item.queued_at,
    queued: true,
  }));
}

/** The queue item a `queued` entry from queuedEntries stands for. */
export function queuedEntryId(entry: Pick<HistoryEntry, "id">): string | null {
  return entry.id.startsWith("queue:") ? entry.id.slice(6) : null;
}

/** A uuid for a message, so its replay settles its bubble. */
export function messageUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
