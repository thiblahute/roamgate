import type { ReviewSummary } from "../../shared/review";
import { validReviewSummaries } from "./reviewValidate";

/**
 * The last review list of each connection with its stamps, kept in
 * IndexedDB: after a reload the page sends those stamps back and only the
 * reviews that changed come again, instead of every review (slow to carry
 * on a mobile link). One entry per connection, under a key of its own
 * (`summaries:` and the connection): the entries of pages from before
 * summaries, whole snapshots, are left to those.
 */
export type CachedReviewList = {
  stamps: Record<string, string>;
  summaries: ReviewSummary[];
};

const KEY_PREFIX = "summaries:";

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
  const { stamps, summaries } = value as Record<string, unknown>;
  if (!stamps || typeof stamps !== "object" || Array.isArray(stamps))
    return null;
  const valid: Record<string, string> = {};
  for (const [id, stamp] of Object.entries(stamps))
    if (typeof stamp === "string") valid[id] = stamp;
  return { stamps: valid, summaries: validReviewSummaries(summaries) };
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
            .get(KEY_PREFIX + connectionId);
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
            .put(value, KEY_PREFIX + connectionId);
        } catch {
          // Storage may be full or unavailable: the next reload lists all.
        }
      });
    }, SAVE_DELAY_MS),
  );
}
