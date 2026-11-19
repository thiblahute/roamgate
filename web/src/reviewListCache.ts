import type { ReviewSnapshot } from "../../shared/review";
import { validReviewSnapshots } from "./reviewValidate";

/**
 * The last review list of each connection with its stamps, kept in
 * IndexedDB: after a reload the page sends those stamps back and only the
 * reviews that changed come again, instead of every review (megabytes on a
 * busy desktop, slow to carry on a mobile link). One entry per connection.
 */
export type CachedReviewList = {
  stamps: Record<string, string>;
  sessions: ReviewSnapshot[];
};

const DB_NAME = "roamgate-review-list";
const STORE = "lists";
const SAVE_DELAY_MS = 2000;
/** A slow storage never holds back the list: it is read without it then. */
const READ_TIMEOUT_MS = 1500;

let database: Promise<IDBDatabase | null> | null = null;
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

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

function parse(value: unknown): CachedReviewList | null {
  if (!value || typeof value !== "object") return null;
  const { stamps, sessions } = value as Record<string, unknown>;
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps))
    return null;
  const valid: Record<string, string> = {};
  for (const [id, stamp] of Object.entries(stamps))
    if (typeof stamp === "string") valid[id] = stamp;
  return { stamps: valid, sessions: validReviewSnapshots(sessions) };
}

export function readReviewListCache(
  connectionId: string,
): Promise<CachedReviewList | null> {
  const read = openDatabase().then(
    (db) =>
      new Promise<CachedReviewList | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = db
            .transaction(STORE, "readonly")
            .objectStore(STORE)
            .get(connectionId);
          request.onsuccess = () => resolve(parse(request.result));
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
  return Promise.race([
    read,
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), READ_TIMEOUT_MS),
    ),
  ]);
}

/** Saves a connection's list once loads settle. */
export function saveReviewListCache(
  connectionId: string,
  value: CachedReviewList,
) {
  const pending = pendingSaves.get(connectionId);
  if (pending !== undefined) clearTimeout(pending);
  pendingSaves.set(
    connectionId,
    setTimeout(() => {
      pendingSaves.delete(connectionId);
      void openDatabase().then((db) => {
        if (!db) return;
        try {
          db.transaction(STORE, "readwrite")
            .objectStore(STORE)
            .put(value, connectionId);
        } catch {
          // Storage may be full or unavailable: the next reload lists all.
        }
      });
    }, SAVE_DELAY_MS),
  );
}
