import { useSyncExternalStore } from "react";
import type {
  AgentPermissionPrompt,
  AgentPromptAnswer,
  ReviewPush,
  ReviewSnapshot,
} from "../../shared/review";
import { bridge } from "./api";
import type { RpcCallOptions } from "./rpcLanes";
import { readReviewListCache, saveReviewListCache } from "./reviewListCache";
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
  /** Agents waiting on a permission answer, by connection. */
  prompts: ReadonlyMap<string, AgentPermissionPrompt[]>;
};

let state: ReviewState = {
  sessions: new Map(),
  openRequest: null,
  prompts: new Map(),
};

function setPrompts(connectionId: string, prompts: AgentPermissionPrompt[]) {
  const next = new Map(state.prompts);
  if (prompts.length) next.set(connectionId, prompts);
  else next.delete(connectionId);
  publish({ prompts: next });
}

/** The permission prompt a pane's agent waits on, if any. */
export function paneAgentPrompt(
  prompts: ReadonlyMap<string, AgentPermissionPrompt[]>,
  connectionId: string | null,
  paneId: string,
): AgentPermissionPrompt | undefined {
  return (connectionId ? prompts.get(connectionId) : undefined)?.find(
    (prompt) => prompt.paneId === paneId,
  );
}

/** Hands a prompt back to the terminal, which asks it there. */
export async function releaseAgentPrompt(
  connectionId: string,
  id: string,
): Promise<void> {
  await reviewClient(connectionId).call("review.prompt.answer", {
    id,
    release: true,
  });
}

/** Answers a prompt; false when the terminal already took it back. */
export async function answerAgentPrompt(
  connectionId: string,
  id: string,
  answer: AgentPromptAnswer,
): Promise<boolean> {
  const result = (await reviewClient(connectionId).call(
    "review.prompt.answer",
    typeof answer === "object"
      ? { id, answers: answer.answers }
      : { id, answer },
  )) as { answered?: boolean };
  return result.answered === true;
}
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
  if (push.type === "prompts") {
    setPrompts(push.connectionId, push.prompts);
    return;
  }
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

/** Shows a review the browser opened itself (a chat's merge request). */
export function requestReviewShown(connectionId: string, sessionId: string) {
  publish({ openRequest: { sessionId, connectionId } });
}

export function clearReviewOpenRequest() {
  publish({ openRequest: null });
}

export function rememberReviewSnapshot(snapshot: ReviewSnapshot) {
  const sessions = new Map(state.sessions);
  sessions.set(snapshot.session.id, snapshot);
  publish({ sessions });
}

/** Each connection's list being read: a second load waits for it. */
const runningLoads = new Map<string, Promise<void>>();

/**
 * Loads the connection's sessions; pushes keep them current afterwards.
 * A load asked while one runs joins it: on a slow link a list takes long
 * enough to be asked again, and each ask would queue the whole list again.
 */
export function loadReviews(connectionId: string): Promise<void> {
  const running = runningLoads.get(connectionId);
  if (running) {
    lastLoadedConnection = connectionId;
    return running;
  }
  const load = readReviews(connectionId).finally(() => {
    if (runningLoads.get(connectionId) === load)
      runningLoads.delete(connectionId);
  });
  runningLoads.set(connectionId, load);
  return load;
}

async function readReviews(connectionId: string) {
  lastLoadedConnection = connectionId;
  // Until it succeeds: a load made before the connection is ready (on a
  // page load or a reconnect) is tried again once it is.
  const load = loadState(connectionId);
  load.pending = true;
  load.triedRuntime = runtimeGeneration(connectionId);
  // The reviews held from the last list (this page's, else the one saved
  // before a reload): an unchanged one is not sent again.
  let held = listStamps.get(connectionId);
  let saved: Map<string, ReviewSnapshot> | null = null;
  if (!held) {
    const cached = await readReviewListCache(connectionId);
    if (cached) {
      held = cached.stamps;
      saved = new Map(
        cached.sessions
          .filter((snapshot) => snapshot.session.connectionId === connectionId)
          .map((snapshot) => [snapshot.session.id, snapshot]),
      );
    }
  }
  const heldSnapshot = (id: string) => {
    const shown = state.sessions.get(id);
    return shown?.session.connectionId === connectionId
      ? shown
      : saved?.get(id);
  };
  const known: Record<string, string> = {};
  if (held)
    for (const [id, stamp] of Object.entries(held))
      if (heldSnapshot(id)) known[id] = stamp;
  // The list comes in pages, most recently updated first, each page shown
  // as it comes: a device with nothing yet never gets megabytes at once.
  // The last page names every review there is (unchanged or sent).
  const got = new Map<string, ReviewSnapshot>();
  const gotStamps: Record<string, string> = {};
  let final: Set<string>;
  for (;;) {
    let result: {
      sessions?: unknown;
      stamps?: unknown;
      unchanged?: unknown;
      remaining?: unknown;
    };
    try {
      result = (await reviewClient(connectionId).call("review.list", {
        known: { ...known },
        limit: REVIEW_LIST_PAGE,
      })) as typeof result;
    } catch (error) {
      // A connection not ready yet keeps the same runtime once it is: try
      // again a little later rather than wait for a change that never comes.
      // The retry starts a load of its own.
      runningLoads.delete(connectionId);
      retryLater(connectionId);
      throw error;
    }
    const pageIds = new Set<string>();
    if (Array.isArray(result?.unchanged))
      for (const id of result.unchanged) {
        if (typeof id !== "string") continue;
        const kept = got.get(id) ?? heldSnapshot(id);
        if (kept) got.set(id, kept);
        pageIds.add(id);
      }
    // A malformed session is dropped rather than break the page.
    for (const snapshot of validReviewSnapshots(result?.sessions)) {
      got.set(snapshot.session.id, snapshot);
      pageIds.add(snapshot.session.id);
    }
    if (
      result?.stamps &&
      typeof result.stamps === "object" &&
      !Array.isArray(result.stamps)
    )
      for (const [id, stamp] of Object.entries(result.stamps))
        if (typeof stamp === "string") {
          known[id] = stamp;
          gotStamps[id] = stamp;
        }
    const remaining =
      typeof result?.remaining === "number" ? result.remaining : 0;
    if (remaining <= 0) {
      final = pageIds;
      break;
    }
    const shown = new Map(state.sessions);
    for (const [id, snapshot] of got) shown.set(id, snapshot);
    publish({ sessions: shown });
  }
  load.pending = false;
  load.retryDelay = RETRY_FIRST_MS;
  clearTimeout(load.retryTimer);
  const sessions = new Map(
    [...state.sessions].filter(
      ([, snapshot]) => snapshot.session.connectionId !== connectionId,
    ),
  );
  for (const id of final) {
    const snapshot = got.get(id);
    if (snapshot) sessions.set(id, snapshot);
  }
  const listed: Record<string, string> = {};
  for (const id of final) if (gotStamps[id]) listed[id] = gotStamps[id];
  if (Object.keys(listed).length) listStamps.set(connectionId, listed);
  else listStamps.delete(connectionId);
  if (!loaded.has(connectionId)) loaded = new Set([...loaded, connectionId]);
  publish({ sessions });
  const stamps = listStamps.get(connectionId);
  if (stamps)
    saveReviewListCache(connectionId, {
      stamps,
      sessions: [...sessions.values()].filter(
        (snapshot) =>
          snapshot.session.connectionId === connectionId &&
          stamps[snapshot.session.id] !== undefined,
      ),
    });
  // Prompts made while this page was away still wait.
  const waiting = (await reviewClient(connectionId)
    .call("review.prompts")
    .catch(() => ({}))) as { prompts?: AgentPermissionPrompt[] };
  setPrompts(connectionId, waiting.prompts ?? []);
}

let lastLoadedConnection: string | null = null;
/** Reviews per list page (see readReviews). */
const REVIEW_LIST_PAGE = 30;
/** Per connection, the stamps of the reviews its last list gave. */
const listStamps = new Map<string, Record<string, string>>();
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
