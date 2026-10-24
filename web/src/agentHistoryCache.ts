import type { AgentHistory } from "./components/agentHistory";
import type { AgentSessionSummary } from "./components/agentSession";

/**
 * The last history read for each open agent pane, so its chat shows at once,
 * after a reload too, while the refresh runs. Kept in memory and saved to
 * IndexedDB (a pane's window can weigh hundreds of KiB, too much for
 * localStorage); entries of panes that are gone are dropped.
 */
export type CachedAgentHistory = {
  history: AgentHistory | null;
  session: AgentSessionSummary | null;
};

const DB_NAME = "roamgate-agent-history";
const STORE = "histories";
const SAVE_DELAY_MS = 1000;

const memory = new Map<string, CachedAgentHistory>();
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
let database: Promise<IDBDatabase | null> | null = null;

/** Keyed by connection and pane: what a pane showed survives reconnects. */
export function agentHistoryCacheKey(
  connectionId: string | null,
  paneId: string,
  agent: string | undefined,
): string {
  return JSON.stringify([connectionId ?? "", paneId, agent ?? ""]);
}

function openDatabase(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return database;
}

let loaded: Promise<void> | null = null;

/** Reads the saved histories once; entries written meanwhile win. */
export function loadAgentHistoryCache(): Promise<void> {
  loaded ??= openDatabase().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
          const store = db.transaction(STORE, "readonly").objectStore(STORE);
          const keys = store.getAllKeys();
          const values = store.getAll();
          values.onsuccess = () => {
            keys.result.forEach((key, index) => {
              if (typeof key === "string" && !memory.has(key))
                memory.set(key, values.result[index] as CachedAgentHistory);
            });
            resolve();
          };
          values.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
  return loaded;
}

export function cachedAgentHistory(
  key: string,
): CachedAgentHistory | undefined {
  return memory.get(key);
}

function persist(key: string, value: CachedAgentHistory | null) {
  void openDatabase().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      if (value) store.put(value, key);
      else store.delete(key);
    } catch {
      // Storage may be unavailable; the history still holds for this page.
    }
  });
}

export function rememberAgentHistory(key: string, value: CachedAgentHistory) {
  memory.set(key, value);
  // A polled chat changes often; save it once it settles.
  const pending = pendingSaves.get(key);
  if (pending !== undefined) clearTimeout(pending);
  pendingSaves.set(
    key,
    setTimeout(() => {
      pendingSaves.delete(key);
      const current = memory.get(key);
      if (current) persist(key, current);
    }, SAVE_DELAY_MS),
  );
}

/**
 * Drops the histories of a connection's panes that are no longer open agent
 * panes. Only called with a pane list the connection reported.
 */
export function pruneAgentHistoryCache(
  connectionId: string | null,
  liveKeys: ReadonlySet<string>,
) {
  void loadAgentHistoryCache().then(() => {
    const prefix = JSON.stringify([connectionId ?? ""]).slice(0, -1) + ",";
    for (const key of [...memory.keys()]) {
      if (!key.startsWith(prefix) || liveKeys.has(key)) continue;
      memory.delete(key);
      const pending = pendingSaves.get(key);
      if (pending !== undefined) clearTimeout(pending);
      pendingSaves.delete(key);
      persist(key, null);
    }
  });
}
