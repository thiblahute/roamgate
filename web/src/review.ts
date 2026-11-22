import { useEffect, useSyncExternalStore } from "react";
import {
  type AgentPermissionPrompt,
  type AgentPromptAnswer,
  REVIEW_SNAPSHOTS_MAX,
  REVIEW_SUMMARIES_VERSION,
  type ReviewPush,
  type ReviewSnapshot,
  type ReviewSummary,
  type ReviewTarget,
  summarizeReview,
} from "../../shared/review";
import { bridge } from "./api";
import { trimRoot } from "./filesystemPaths";
import type { RpcCallOptions } from "./rpcLanes";
import { readReviewListCache, saveReviewListCache } from "./reviewListCache";
import { validReviewSnapshots, validReviewSummaries } from "./reviewValidate";
import { store } from "./store";

export type ReviewOpenRequest = {
  sessionId: string;
  connectionId: string;
  paneId?: string;
  message?: string;
};

type ReviewState = {
  /**
   * Every known review by id, across connections: its summary (the
   * session, counts of its threads). The connection's list gives them;
   * pushes keep them current.
   */
  summaries: ReadonlyMap<string, ReviewSummary>;
  /**
   * The whole reviews read for what the page shows (useReviewSnapshots),
   * by id, kept current by pushes. One no view wants is let go after a
   * while.
   */
  snapshots: ReadonlyMap<string, ReviewSnapshot>;
  /** The latest "open" from an agent, until the app shows it. */
  openRequest: ReviewOpenRequest | null;
  /** Agents waiting on a permission answer, by connection. */
  prompts: ReadonlyMap<string, AgentPermissionPrompt[]>;
};

let state: ReviewState = {
  summaries: new Map(),
  snapshots: new Map(),
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
  if (next.summaries || next.snapshots) scheduleReconcile();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A review's whole snapshot, when the page has read it. */
export function getReviewSnapshot(sessionId: string) {
  return state.snapshots.get(sessionId);
}

/** A review's summary: every review of a listed connection has one. */
export function getReviewSummary(sessionId: string) {
  return state.summaries.get(sessionId);
}

/** The connections whose list was loaded. */
export function loadedReviewConnections(): ReadonlySet<string> {
  return loaded;
}

export function useReviewState(): ReviewState {
  return useSyncExternalStore(subscribe, () => state);
}

/** A whole review, come with a push or a write: kept, with its summary. */
function keepSnapshot(snapshot: ReviewSnapshot) {
  const id = snapshot.session.id;
  versions.set(id, (versions.get(id) ?? 0) + 1);
  stale.delete(id);
  const summaries = new Map(state.summaries);
  summaries.set(id, summarizeReview(snapshot));
  const snapshots = new Map(state.snapshots);
  snapshots.set(id, snapshot);
  publish({ summaries, snapshots });
}

export function acceptReviewPush(push: ReviewPush) {
  if (push.type === "prompts") {
    setPrompts(push.connectionId, push.prompts);
    return;
  }
  if (push.type === "session") keepSnapshot(push.snapshot);
  else if (push.type === "removed") {
    versions.set(push.sessionId, (versions.get(push.sessionId) ?? 0) + 1);
    const summaries = new Map(state.summaries);
    summaries.delete(push.sessionId);
    const snapshots = new Map(state.snapshots);
    snapshots.delete(push.sessionId);
    publish({ summaries, snapshots });
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
  keepSnapshot(snapshot);
}

/*
 * The whole snapshots a page reads: those of the reviews its views want.
 * A view says which (a checkout's, a workspace's, a chat's...) with
 * useReviewSnapshots while it shows; the reviews of every want that the
 * summaries match are read in one call per connection, and those no want
 * matches any longer are let go after SNAPSHOT_KEEP_MS (a view shown again
 * soon finds them still there).
 */

/** What a view shows the threads of: any of these, on its connection. */
export type ReviewWant = {
  /** Unset: on any connection. */
  connectionId?: string | null;
  ids?: readonly (string | null | undefined)[];
  /** The reviews of these checkouts. */
  roots?: readonly (string | null | undefined)[];
  /** The reviews of the checkouts holding this file (an absolute path). */
  file?: string | null;
  /** A site's rendered review. */
  url?: string | null;
  /**
   * The workspace's reviews that have threads: its views list threads,
   * and a review without (an idle range, a chat not commented) has none to
   * give.
   */
  workspaceId?: string | null;
  /** A chat's review (its agent session). */
  chat?: string | null;
  effort?: string | null;
};

/** Whether a review is one a want names. */
export function reviewWanted(
  want: ReviewWant,
  summary: Pick<ReviewSummary, "session" | "counts">,
): boolean {
  const { session } = summary;
  if (want.connectionId && session.connectionId !== want.connectionId)
    return false;
  if (want.ids?.includes(session.id)) return true;
  // An effort's review has no checkout.
  const root = session.root ? trimRoot(session.root) : "";
  if (root && want.roots?.some((each) => !!each && trimRoot(each) === root))
    return true;
  if (want.file && root && want.file.startsWith(`${root}/`)) return true;
  if (
    want.workspaceId &&
    session.workspaceId === want.workspaceId &&
    summary.counts.threads > 0
  )
    return true;
  // A session read from elsewhere may name no target.
  const target: Partial<ReviewTarget> = session.target ?? {};
  if (want.url && target.kind === "rendered" && target.url === want.url)
    return true;
  if (want.chat && target.kind === "chat" && target.chat === want.chat)
    return true;
  return (
    !!want.effort && target.kind === "effort" && target.effort === want.effort
  );
}

/** A want's key: the same want, the same key; null when it wants none. */
function wantKey(want: ReviewWant): string | null {
  const list = (values?: readonly (string | null | undefined)[]) => {
    const kept = [
      ...new Set((values ?? []).filter((each): each is string => !!each)),
    ].sort();
    return kept.length ? kept : undefined;
  };
  const ids = list(want.ids);
  const roots = list(want.roots);
  const value: ReviewWant = {
    ...(want.connectionId ? { connectionId: want.connectionId } : {}),
    ...(ids ? { ids } : {}),
    ...(roots ? { roots } : {}),
    ...(want.file ? { file: want.file } : {}),
    ...(want.url ? { url: want.url } : {}),
    ...(want.workspaceId ? { workspaceId: want.workspaceId } : {}),
    ...(want.chat ? { chat: want.chat } : {}),
    ...(want.effort ? { effort: want.effort } : {}),
  };
  return Object.keys(value).some((key) => key !== "connectionId")
    ? JSON.stringify(value)
    : null;
}

/** How long a snapshot no view wants is kept. */
const SNAPSHOT_KEEP_MS = 2 * 60_000;

/** The wants of the views shown, by key, with how many views want each. */
const wants = new Map<string, { want: ReviewWant; views: number }>();
/** Each review's changes this page took (pushes, writes, removals). */
const versions = new Map<string, number>();
/** Snapshots read again before they are trusted (a reconnect missed pushes). */
const stale = new Set<string>();
/** The reviews being read. */
const reading = new Set<string>();
/** A review whose read failed, and the summary it was read for. */
const failed = new Map<string, ReviewSummary>();
/** Since when no view wants a snapshot held. */
const unwantedSince = new Map<string, number>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileQueued = false;

/** A view wants these reviews' snapshots until it calls what is returned. */
export function wantReviews(want: ReviewWant): () => void {
  const key = wantKey(want);
  return key ? addWant(key) : () => {};
}

function addWant(key: string): () => void {
  const held = wants.get(key);
  if (held) held.views += 1;
  else wants.set(key, { want: JSON.parse(key) as ReviewWant, views: 1 });
  scheduleReconcile();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const entry = wants.get(key);
    if (!entry) return;
    entry.views -= 1;
    if (entry.views <= 0) wants.delete(key);
    scheduleReconcile();
  };
}

/**
 * The whole snapshots the page holds, those of `want` among them once
 * read: read while the view shows, kept current by pushes. A view finds
 * the reviews it shows in the summaries (useReviewState), and their
 * threads here.
 */
export function useReviewSnapshots(
  want: ReviewWant | null,
): ReadonlyMap<string, ReviewSnapshot> {
  const key = want ? wantKey(want) : null;
  useEffect(() => (key ? addWant(key) : undefined), [key]);
  return useSyncExternalStore(subscribe, () => state).snapshots;
}

function scheduleReconcile() {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    reconcile();
  });
}

/** The ids of the reviews some view wants. */
function wantedIds(): Set<string> {
  const ids = new Set<string>();
  if (!wants.size) return ids;
  const all = [...wants.values()].map((entry) => entry.want);
  for (const summary of state.summaries.values())
    if (all.some((want) => reviewWanted(want, summary)))
      ids.add(summary.session.id);
  return ids;
}

function reconcile() {
  const wanted = wantedIds();
  const now = Date.now();
  // Reads what is wanted and not held (or held stale), per connection.
  const toRead = new Map<string, string[]>();
  for (const id of wanted) {
    unwantedSince.delete(id);
    if (reading.has(id)) continue;
    if (state.snapshots.has(id) && !stale.has(id)) continue;
    const summary = state.summaries.get(id);
    if (!summary || failed.get(id) === summary) continue;
    const connectionId = summary.session.connectionId;
    toRead.set(connectionId, [...(toRead.get(connectionId) ?? []), id]);
  }
  for (const [connectionId, ids] of toRead)
    for (let at = 0; at < ids.length; at += REVIEW_SNAPSHOTS_MAX)
      void readSnapshots(
        connectionId,
        ids.slice(at, at + REVIEW_SNAPSHOTS_MAX),
      );
  // Lets go of what no view wants for a while (a stale one at once).
  let dropped: Map<string, ReviewSnapshot> | null = null;
  let waiting = false;
  for (const id of state.snapshots.keys()) {
    if (wanted.has(id)) continue;
    const since = unwantedSince.get(id) ?? now;
    unwantedSince.set(id, since);
    if (stale.has(id) || now - since >= SNAPSHOT_KEEP_MS) {
      dropped ??= new Map(state.snapshots);
      dropped.delete(id);
      unwantedSince.delete(id);
      stale.delete(id);
    } else waiting = true;
  }
  for (const id of unwantedSince.keys())
    if (!state.snapshots.has(id)) unwantedSince.delete(id);
  clearTimeout(sweepTimer);
  sweepTimer = waiting
    ? setTimeout(scheduleReconcile, SNAPSHOT_KEEP_MS)
    : undefined;
  if (dropped) publish({ snapshots: dropped });
}

async function readSnapshots(connectionId: string, ids: string[]) {
  for (const id of ids) reading.add(id);
  const asked = new Map(ids.map((id) => [id, versions.get(id) ?? 0]));
  const summaryOf = new Map(ids.map((id) => [id, state.summaries.get(id)]));
  let got: ReviewSnapshot[] = [];
  let missing: string[] = [];
  try {
    const result = (await reviewClient(connectionId).call("review.snapshots", {
      ids,
    })) as { snapshots?: unknown; missing?: unknown };
    got = validReviewSnapshots(result?.snapshots);
    missing = Array.isArray(result?.missing)
      ? result.missing.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    // A server from before review.snapshots: one review.get each.
    const each = await Promise.all(
      ids.map((id) =>
        reviewClient(connectionId)
          .call("review.get", { session_id: id })
          .then(
            (value) => validReviewSnapshots([value])[0] ?? null,
            () => null,
          ),
      ),
    );
    got = each.filter((snapshot): snapshot is ReviewSnapshot => !!snapshot);
  } finally {
    for (const id of ids) reading.delete(id);
  }
  const read = new Set(got.map((snapshot) => snapshot.session.id));
  for (const id of ids) {
    const summary = summaryOf.get(id);
    if (read.has(id)) failed.delete(id);
    else if (summary) failed.set(id, summary);
  }
  // A review changed (pushed, written, removed) while it was read keeps
  // that newer state.
  const current = (id: string) => (versions.get(id) ?? 0) === asked.get(id);
  const fresh = got.filter((snapshot) => current(snapshot.session.id));
  const gone = missing.filter(current);
  if (!fresh.length && !gone.length) return;
  const summaries = new Map(state.summaries);
  const snapshots = new Map(state.snapshots);
  for (const snapshot of fresh) {
    const id = snapshot.session.id;
    stale.delete(id);
    summaries.set(id, summarizeReview(snapshot));
    snapshots.set(id, snapshot);
  }
  for (const id of gone) {
    stale.delete(id);
    snapshots.delete(id);
  }
  publish({ summaries, snapshots });
}

/** Each connection's list being read: a second load waits for it. */
const runningLoads = new Map<string, Promise<void>>();

/**
 * Loads the connection's summaries; pushes keep them current afterwards.
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
  let saved: Map<string, ReviewSummary> | null = null;
  if (!held) {
    const cached = await readReviewListCache(connectionId);
    if (cached) {
      held = cached.stamps;
      saved = new Map(
        cached.summaries
          .filter((summary) => summary.session.connectionId === connectionId)
          .map((summary) => [summary.session.id, summary]),
      );
    }
  }
  const heldSummary = (id: string) => {
    const shown = state.summaries.get(id);
    return shown?.session.connectionId === connectionId
      ? shown
      : saved?.get(id);
  };
  const known: Record<string, string> = {};
  if (held)
    for (const [id, stamp] of Object.entries(held))
      if (heldSummary(id)) known[id] = stamp;
  // The list comes in pages, most recently updated first, each page shown
  // as it comes. The last page names every review there is (unchanged or
  // sent).
  const got = new Map<string, ReviewSummary>();
  /** Whole snapshots, from a server from before summaries. */
  const whole = new Map<string, ReviewSnapshot>();
  const gotStamps: Record<string, string> = {};
  let final: Set<string>;
  for (;;) {
    let result: {
      summaries?: unknown;
      sessions?: unknown;
      stamps?: unknown;
      unchanged?: unknown;
      remaining?: unknown;
      version?: unknown;
    };
    try {
      result = (await reviewClient(connectionId).call("review.list", {
        known: { ...known },
        limit: REVIEW_LIST_PAGE,
        summaries: REVIEW_SUMMARIES_VERSION,
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
    // Summaries name the unchanged ones on the last page only, without
    // their stamps: those the page sent.
    if (Array.isArray(result?.unchanged))
      for (const id of result.unchanged) {
        if (typeof id !== "string") continue;
        const kept = got.get(id) ?? heldSummary(id);
        if (kept) got.set(id, kept);
        pageIds.add(id);
        if (known[id] !== undefined) gotStamps[id] = known[id];
      }
    // A malformed review is dropped rather than break the page.
    if (result?.version === REVIEW_SUMMARIES_VERSION)
      for (const summary of validReviewSummaries(result.summaries)) {
        got.set(summary.session.id, summary);
        pageIds.add(summary.session.id);
      }
    else
      for (const snapshot of validReviewSnapshots(result?.sessions)) {
        got.set(snapshot.session.id, summarizeReview(snapshot));
        whole.set(snapshot.session.id, snapshot);
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
    const shown = new Map(state.summaries);
    for (const [id, summary] of got) shown.set(id, summary);
    publish({ summaries: shown });
  }
  load.pending = false;
  load.retryDelay = RETRY_FIRST_MS;
  clearTimeout(load.retryTimer);
  const summaries = new Map(
    [...state.summaries].filter(
      ([, summary]) => summary.session.connectionId !== connectionId,
    ),
  );
  for (const id of final) {
    const summary = got.get(id);
    if (summary) summaries.set(id, summary);
  }
  // Pushes made while the page was away are lost: the snapshots held are
  // read again (those no view wants, let go); one gone is dropped.
  const snapshots = new Map(state.snapshots);
  for (const [id, snapshot] of state.snapshots) {
    if (snapshot.session.connectionId !== connectionId) continue;
    if (!summaries.has(id)) snapshots.delete(id);
    else if (!whole.has(id)) stale.add(id);
  }
  for (const [id, snapshot] of whole)
    if (final.has(id)) {
      snapshots.set(id, snapshot);
      stale.delete(id);
    }
  for (const id of final) failed.delete(id);
  const listed: Record<string, string> = {};
  for (const id of final) if (gotStamps[id]) listed[id] = gotStamps[id];
  if (Object.keys(listed).length) listStamps.set(connectionId, listed);
  else listStamps.delete(connectionId);
  if (!loaded.has(connectionId)) loaded = new Set([...loaded, connectionId]);
  publish({ summaries, snapshots });
  const stamps = listStamps.get(connectionId);
  if (stamps)
    saveReviewListCache(connectionId, {
      stamps,
      summaries: [...summaries.values()].filter(
        (summary) =>
          summary.session.connectionId === connectionId &&
          stamps[summary.session.id] !== undefined,
      ),
    });
  // Prompts made while this page was away still wait.
  const waiting = (await reviewClient(connectionId)
    .call("review.prompts")
    .catch(() => ({}))) as { prompts?: AgentPermissionPrompt[] };
  setPrompts(connectionId, waiting.prompts ?? []);
}

let lastLoadedConnection: string | null = null;
/** Summaries per list page (see readReviews). */
const REVIEW_LIST_PAGE = 1000;
/** Per connection, the stamps of the reviews its last list gave. */
const listStamps = new Map<string, Record<string, string>>();
/**
 * The connections whose list was loaded: their reviews are all known.
 * Set before the list's summaries are published.
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
    clearTimeout(sweepTimer);
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
