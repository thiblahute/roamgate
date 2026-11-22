import { useSyncExternalStore } from "react";
import type { ReviewPush, ReviewSnapshot } from "../../shared/review";
import { bridge } from "./api";
import type { RpcCallOptions } from "./rpcLanes";
import { validReviewSnapshots } from "./reviewValidate";
import { store } from "./store";

export type ReviewOpenRequest = {
  sessionId: string;
  connectionId: string;
  paneId?: string;
  message?: string;
};

type ReviewState = {
  /** Every known session by id, across connections. */
  sessions: ReadonlyMap<string, ReviewSnapshot>;
  /** The latest "open" from an agent, until the app shows it. */
  openRequest: ReviewOpenRequest | null;
};

let state: ReviewState = { sessions: new Map(), openRequest: null };
const listeners = new Set<() => void>();

function publish(next: Partial<ReviewState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getReviewSnapshot(sessionId: string) {
  return state.sessions.get(sessionId);
}

/** The connections whose list was loaded. */
export function loadedReviewConnections(): ReadonlySet<string> {
  return loaded;
}

export function useReviewState(): ReviewState {
  return useSyncExternalStore(subscribe, () => state);
}

export function acceptReviewPush(push: ReviewPush) {
  const sessions = new Map(state.sessions);
  if (push.type === "session") {
    sessions.set(push.snapshot.session.id, push.snapshot);
    publish({ sessions });
  } else if (push.type === "removed") {
    sessions.delete(push.sessionId);
    publish({ sessions });
  } else {
    publish({
      openRequest: {
        sessionId: push.sessionId,
        connectionId: push.connectionId,
        paneId: push.paneId,
        message: push.message,
      },
    });
  }
}

export function clearReviewOpenRequest() {
  publish({ openRequest: null });
}

export function rememberReviewSnapshot(snapshot: ReviewSnapshot) {
  const sessions = new Map(state.sessions);
  sessions.set(snapshot.session.id, snapshot);
  publish({ sessions });
}

/** Loads the connection's sessions; pushes keep them current afterwards. */
export async function loadReviews(connectionId: string) {
  lastLoadedConnection = connectionId;
  // Until it succeeds: a load made before the connection is ready (on a
  // page load or a reconnect) is tried again once it is.
  const load = loadState(connectionId);
  load.pending = true;
  load.triedRuntime = runtimeGeneration(connectionId);
  let result: { sessions?: unknown };
  try {
    result = (await reviewClient(connectionId).call("review.list")) as {
      sessions?: unknown;
    };
  } catch (error) {
    // A connection not ready yet keeps the same runtime once it is: try
    // again a little later rather than wait for a change that never comes.
    retryLater(connectionId);
    throw error;
  }
  load.pending = false;
  load.retryDelay = RETRY_FIRST_MS;
  clearTimeout(load.retryTimer);
  const sessions = new Map(
    [...state.sessions].filter(
      ([, snapshot]) => snapshot.session.connectionId !== connectionId,
    ),
  );
  // A malformed session is dropped rather than break the page.
  for (const snapshot of validReviewSnapshots(result?.sessions))
    sessions.set(snapshot.session.id, snapshot);
  if (!loaded.has(connectionId)) loaded = new Set([...loaded, connectionId]);
  publish({ sessions });
}

let lastLoadedConnection: string | null = null;
/**
 * The connections whose list was loaded: their sessions are all known.
 * Set before the list's sessions are published.
 */
let loaded: ReadonlySet<string> = new Set();

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 15_000;

/** Each connection's loading: one failing never stops another's retries. */
type LoadState = {
  /** Loaded since asked: tried again until it is. */
  pending: boolean;
  /** The runtime the last try was made against. */
  triedRuntime: number | null;
  retryDelay: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
};
const loads = new Map<string, LoadState>();

function loadState(connectionId: string): LoadState {
  let load = loads.get(connectionId);
  if (!load) {
    load = {
      pending: false,
      triedRuntime: null,
      retryDelay: RETRY_FIRST_MS,
      retryTimer: undefined,
    };
    loads.set(connectionId, load);
  }
  return load;
}

function retryLater(connectionId: string) {
  const load = loadState(connectionId);
  clearTimeout(load.retryTimer);
  load.retryTimer = setTimeout(() => {
    if (load.pending && lastLoadedConnection === connectionId)
      void loadReviews(connectionId).catch(() => {});
  }, load.retryDelay);
  load.retryDelay = Math.min(load.retryDelay * 2, RETRY_MAX_MS);
}

function runtimeGeneration(connectionId: string): number | null {
  return (
    store.get().connections.find((connection) => connection.id === connectionId)
      ?.generation ?? null
  );
}

/**
 * A client for the review's own connection: a review names its connection,
 * so its reads and writes go there even while the page has another one
 * active (a Work item's review on the desktop while the page shows the
 * Mac), and a switch during a send does not drop it.
 */
function reviewClient(connectionId: string) {
  return {
    call: (
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs?: number,
      options?: RpcCallOptions,
    ) =>
      bridge.callConnection(connectionId, method, params, timeoutMs, options),
  };
}

export function startReviewClient(): () => void {
  const offReview = bridge.onReview(acceptReviewPush);
  // Pushes made while the socket was down are lost; reload on reconnect.
  const offStatus = bridge.onStatus((status) => {
    if (status === "connected" && lastLoadedConnection)
      void loadReviews(lastLoadedConnection).catch(() => {});
  });
  // The connection's runtime becomes known after the socket: a load that
  // failed for want of it is made again then.
  const offStore = store.subscribe(() => {
    if (!lastLoadedConnection) return;
    const load = loads.get(lastLoadedConnection);
    if (!load?.pending) return;
    const runtime = runtimeGeneration(lastLoadedConnection);
    if (runtime === null || runtime === load.triedRuntime) return;
    void loadReviews(lastLoadedConnection).catch(() => {});
  });
  return () => {
    offReview();
    offStatus();
    offStore();
    for (const load of loads.values()) clearTimeout(load.retryTimer);
  };
}

export function reviewCall<T = unknown>(
  connectionId: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
  options?: RpcCallOptions,
): Promise<T> {
  return reviewClient(connectionId).call(method, params, timeoutMs, options);
}
