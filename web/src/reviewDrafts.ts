import { useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/*
 * Text written in a comment box and not sent yet, by session and editor
 * (a review overlay's editorKey; another box's own key, its session a
 * place of its own: `work:ITEM`, `chat:...`). Kept in the browser so it
 * outlives the box: another view, a switch to another connection, a
 * review dropped from the kept ones, a review removed meanwhile or a page
 * reload. The oldest drafts go first once a session has too many or all
 * of them take too much room, and any older than DRAFT_MAX_AGE_MS. Images
 * a box holds as bytes until it sends (the Work board's new item) are kept
 * with their draft, in IndexedDB (too big for local storage), and go with
 * it.
 */

const DRAFTS_KEY = "reviewDrafts";
/** The most drafts kept for one review. */
export const DRAFTS_PER_SESSION = 20;
/** The most room all drafts take, in characters of their JSON. */
export const DRAFTS_MAX_CHARS = 200_000;
/** A draft left this long is dropped: 30 days. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Draft = { text: string; at: number };
type Drafts = Record<string, Record<string, Draft>>;

const listeners = new Set<() => void>();
/** Changes with every draft kept or dropped, for useDraftsVersion. */
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

/** Called as drafts are kept or dropped (this page's or another tab's). */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Draws again as drafts are kept or dropped: for a "Draft" marker. */
export function useDraftsVersion(): number {
  return useSyncExternalStore(
    subscribeDrafts,
    () => version,
    () => version,
  );
}

subscribeLocalStorage((key) => {
  if (key === null || key === DRAFTS_KEY) changed();
});

function readDrafts(now = Date.now()): Drafts {
  try {
    const all = JSON.parse(roamgateLocalStorage.getItem(DRAFTS_KEY) ?? "{}");
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    const drafts: Drafts = {};
    for (const [sessionId, entries] of Object.entries(all)) {
      if (!entries || typeof entries !== "object") continue;
      for (const [key, draft] of Object.entries(entries)) {
        const { text, at } = (draft ?? {}) as Partial<Draft>;
        if (typeof text !== "string" || typeof at !== "number") continue;
        if (now - at > DRAFT_MAX_AGE_MS) continue;
        (drafts[sessionId] ??= {})[key] = { text, at };
      }
    }
    return drafts;
  } catch {
    return {};
  }
}

/** The drafts within the caps, the oldest dropped first. */
function capped(drafts: Drafts): Drafts {
  const all = Object.entries(drafts).flatMap(([sessionId, entries]) =>
    Object.entries(entries)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, DRAFTS_PER_SESSION)
      .map(([key, draft]) => ({ sessionId, key, draft })),
  );
  // Newest first, each with its share of the room.
  all.sort((a, b) => b.draft.at - a.draft.at);
  const kept: Drafts = {};
  let chars = 2;
  for (const { sessionId, key, draft } of all) {
    const size =
      JSON.stringify(sessionId).length +
      JSON.stringify(key).length +
      JSON.stringify(draft).length +
      8;
    if (chars + size > DRAFTS_MAX_CHARS) continue;
    chars += size;
    (kept[sessionId] ??= {})[key] = draft;
  }
  return kept;
}

function writeDrafts(drafts: Drafts) {
  const kept = capped(drafts);
  try {
    const value = Object.keys(kept).length ? JSON.stringify(kept) : null;
    if (value === roamgateLocalStorage.getItem(DRAFTS_KEY)) return;
    if (value !== null) roamgateLocalStorage.setItem(DRAFTS_KEY, value);
    else roamgateLocalStorage.removeItem(DRAFTS_KEY);
  } catch {}
  dropImagesOutside(kept);
  changed();
}

/** Keeps a draft; empty text forgets it. */
export function keepReviewDraft(
  sessionId: string,
  key: string,
  text: string,
  at = Date.now(),
) {
  const drafts = readDrafts();
  if (text.trim()) (drafts[sessionId] ??= {})[key] = { text, at };
  else if (drafts[sessionId]) delete drafts[sessionId][key];
  writeDrafts(drafts);
}

/** The draft of an editor, left kept (it is the box's until sent). */
export function peekReviewDraft(
  sessionId: string,
  key: string,
): string | undefined {
  return readDrafts()[sessionId]?.[key]?.text;
}

/** The editors of a session with a draft. */
export function reviewDraftKeys(sessionId: string): string[] {
  return Object.keys(readDrafts()[sessionId] ?? {});
}

/** The sessions with a draft, those starting with `prefix`. */
export function draftSessionIds(prefix = ""): string[] {
  return Object.keys(readDrafts()).filter((id) => id.startsWith(prefix));
}

/** The draft of an editor, forgotten as it is handed back. */
export function takeReviewDraft(
  sessionId: string,
  key: string,
): string | undefined {
  const drafts = readDrafts();
  const draft = drafts[sessionId]?.[key];
  if (!draft) {
    // Images kept without their text (it was emptied) go too.
    dropDraftImages(sessionId, key);
    return undefined;
  }
  delete drafts[sessionId]![key];
  writeDrafts(drafts);
  return draft.text;
}

/** How many drafts a review has. */
export function reviewDraftCount(sessionId: string): number {
  return Object.keys(readDrafts()[sessionId] ?? {}).length;
}

/** Forgets every draft of a review, as it is deleted. */
export function discardReviewDrafts(sessionId: string) {
  const drafts = readDrafts();
  if (!drafts[sessionId]) return;
  delete drafts[sessionId];
  writeDrafts(drafts);
}

/** Where a kept draft was written, read back from its editor's key. */
export type ReviewDraftPlace =
  | {
      kind: "new";
      key: string;
      at: number;
      /** What it writes: a review comment or a discussion. */
      comment: string;
      path: string;
      line: number;
      side: "old" | "new";
      text: string;
    }
  | { kind: "reply"; key: string; at: number; threadId: string }
  | { kind: "edit"; key: string; at: number; commentId: string }
  | { kind: "overall"; key: string; at: number };

/** A draft's place from its key (reviewSave's editorKey); null: unknown. */
export function draftPlaceOf(key: string, at: number): ReviewDraftPlace | null {
  if (key === "overall") return { kind: "overall", key, at };
  if (key.startsWith("reply:"))
    return { kind: "reply", key, at, threadId: key.slice("reply:".length) };
  if (key.startsWith("edit:"))
    return { kind: "edit", key, at, commentId: key.slice("edit:".length) };
  const match = /^new:([^:]+):(\{.*\})$/s.exec(key);
  if (!match) return null;
  try {
    const anchor = JSON.parse(match[2]!) as {
      path?: unknown;
      line?: unknown;
      side?: unknown;
      text?: unknown;
    };
    if (
      typeof anchor.path !== "string" ||
      !anchor.path ||
      typeof anchor.line !== "number" ||
      (anchor.side !== "old" && anchor.side !== "new")
    )
      return null;
    return {
      kind: "new",
      key,
      at,
      comment: match[1]!,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
      text: typeof anchor.text === "string" ? anchor.text : "",
    };
  } catch {
    return null;
  }
}

/** A review's drafts and where each was written, the newest first. */
export function reviewDraftPlaces(sessionId: string): ReviewDraftPlace[] {
  return Object.entries(readDrafts()[sessionId] ?? {})
    .map(([key, draft]) => draftPlaceOf(key, draft.at))
    .filter((place): place is ReviewDraftPlace => place !== null)
    .sort((a, b) => b.at - a.at);
}

/**
 * Where a draft is, as the review says it: `play.c:144`, a reply on a
 * thread's place, the overall comment. `whereOf` names a thread's place
 * (a reply's thread, an edit's comment's); undefined when not shown.
 */
export function describeDraftPlace(
  place: ReviewDraftPlace,
  whereOf: (ids: {
    threadId?: string;
    commentId?: string;
  }) => string | undefined,
): string {
  if (place.kind === "overall") return "the overall comment";
  if (place.kind === "new") return `${place.path}:${place.line}`;
  const where =
    place.kind === "reply"
      ? whereOf({ threadId: place.threadId })
      : whereOf({ commentId: place.commentId });
  const what = place.kind === "reply" ? "a reply" : "an edit";
  return where ? `${what} on ${where}` : what;
}

/**
 * An image a box holds as bytes until it sends, named in its text by a
 * token (the Work board's new item: WorkAddForm).
 */
export type DraftImage = {
  token: string;
  name: string;
  type: string;
  /** Base64. */
  data: string;
};

const IMAGES_DB = "roamgate-draft-images";
const IMAGES_STORE = "images";
/** This page's images of each draft (`session\0key`), read or kept. */
const images = new Map<string, DraftImage[]>();
let imagesDatabase: Promise<IDBDatabase | null> | null = null;
let imagesPruned = false;

const imagesKey = (sessionId: string, key: string) => `${sessionId}\0${key}`;

function openImages(): Promise<IDBDatabase | null> {
  imagesDatabase ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(IMAGES_DB, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(IMAGES_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return imagesDatabase;
}

function imagesStore(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest | undefined,
): Promise<unknown> {
  return openImages().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const request = use(
            db.transaction(IMAGES_STORE, mode).objectStore(IMAGES_STORE),
          );
          if (!request) return resolve(undefined);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

function validImages(value: unknown): DraftImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (image): image is DraftImage =>
      !!image &&
      typeof image.token === "string" &&
      typeof image.name === "string" &&
      typeof image.type === "string" &&
      typeof image.data === "string",
  );
}

/** Keeps the images of a draft (none: forgets them). */
export function keepDraftImages(
  sessionId: string,
  key: string,
  kept: readonly DraftImage[],
) {
  const id = imagesKey(sessionId, key);
  if (!kept.length) return dropDraftImages(sessionId, key);
  images.set(id, [...kept]);
  void imagesStore("readwrite", (store) => store.put([...kept], id));
}

/** Forgets the images of a draft. */
export function dropDraftImages(sessionId: string, key: string) {
  const id = imagesKey(sessionId, key);
  images.delete(id);
  void imagesStore("readwrite", (store) => store.delete(id));
}

/** The images of a draft this page has, at once (none read yet: []). */
export function draftImagesNow(sessionId: string, key: string): DraftImage[] {
  return images.get(imagesKey(sessionId, key)) ?? [];
}

/** The images of a draft, read back from the browser after a reload. */
export async function readDraftImages(
  sessionId: string,
  key: string,
): Promise<DraftImage[]> {
  const id = imagesKey(sessionId, key);
  const known = images.get(id);
  if (known) return known;
  if (peekReviewDraft(sessionId, key) === undefined) return [];
  const read = validImages(
    await imagesStore("readonly", (store) => store.get(id)),
  );
  // Kept meanwhile: those win.
  const now = images.get(id);
  if (now) return now;
  if (read.length) images.set(id, read);
  return read;
}

/** Drops the images whose draft is gone (sent, cancelled, too old). */
function dropImagesOutside(kept: Drafts) {
  const has = (id: string) => {
    const [sessionId, key] = id.split("\0", 2) as [string, string];
    return kept[sessionId]?.[key] !== undefined;
  };
  for (const id of [...images.keys()]) if (!has(id)) images.delete(id);
  if (imagesPruned) return;
  imagesPruned = true;
  void imagesStore("readonly", (store) => store.getAllKeys()).then((keys) => {
    if (!Array.isArray(keys)) return;
    const gone = keys.filter(
      (id): id is string =>
        typeof id === "string" && !has(id) && !images.has(id),
    );
    if (gone.length)
      void imagesStore("readwrite", (store) => {
        for (const id of gone) store.delete(id);
        return undefined;
      });
  });
}
