import { useSyncExternalStore } from "react";
import type { ReviewPush, ReviewSnapshot } from "../../shared/review";
import { bridge } from "./api";
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
  reloadPending = true;
  triedRuntime = runtimeGeneration(connectionId);
  let result: { sessions?: ReviewSnapshot[] };
  try {
    result = (await reviewClient(connectionId).call("review.list")) as {
      sessions?: ReviewSnapshot[];
    };
  } catch (error) {
    // A connection not ready yet keeps the same runtime once it is: try
    // again a little later rather than wait for a change that never comes.
    retryLater(connectionId);
    throw error;
  }
  if (connectionId === lastLoadedConnection) {
    reloadPending = false;
    retryDelay = RETRY_FIRST_MS;
  }
  const sessions = new Map(
    [...state.sessions].filter(
      ([, snapshot]) => snapshot.session.connectionId !== connectionId,
    ),
  );
  for (const snapshot of result.sessions ?? [])
    sessions.set(snapshot.session.id, snapshot);
  publish({ sessions });
}

let lastLoadedConnection: string | null = null;
let reloadPending = false;
let triedRuntime: number | null = null;

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 15_000;
let retryDelay = RETRY_FIRST_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function retryLater(connectionId: string) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (reloadPending && lastLoadedConnection === connectionId)
      void loadReviews(connectionId).catch(() => {});
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

function runtimeGeneration(connectionId: string): number | null {
  return (
    store.get().connections.find((connection) => connection.id === connectionId)
      ?.generation ?? null
  );
}

/** A client for the connection's current runtime, as the store knows it. */
function reviewClient(connectionId: string) {
  return bridge.connection(connectionId, runtimeGeneration(connectionId));
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
    if (!reloadPending || !lastLoadedConnection) return;
    const runtime = runtimeGeneration(lastLoadedConnection);
    if (runtime === null || runtime === triedRuntime) return;
    void loadReviews(lastLoadedConnection).catch(() => {});
  });
  return () => {
    offReview();
    offStatus();
    offStore();
    clearTimeout(retryTimer);
  };
}

export function reviewCall<T = unknown>(
  connectionId: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  return reviewClient(connectionId).call(method, params, timeoutMs);
}
