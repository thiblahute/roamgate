import { roamgateLocalStorage } from "./browserStorage";

/*
 * Text written in a review and not sent yet, by session and editor (the
 * overlay's editorKey). Kept in the browser so it outlives the overlay: a
 * switch to another connection, a review dropped from the kept ones, a
 * review removed meanwhile or a page reload. The oldest drafts go first
 * once a session has too many or all of them take too much room.
 */

const DRAFTS_KEY = "reviewDrafts";
/** The most drafts kept for one review. */
export const DRAFTS_PER_SESSION = 20;
/** The most room all drafts take, in characters of their JSON. */
export const DRAFTS_MAX_CHARS = 200_000;

type Draft = { text: string; at: number };
type Drafts = Record<string, Record<string, Draft>>;

function readDrafts(): Drafts {
  try {
    const all = JSON.parse(roamgateLocalStorage.getItem(DRAFTS_KEY) ?? "{}");
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    const drafts: Drafts = {};
    for (const [sessionId, entries] of Object.entries(all)) {
      if (!entries || typeof entries !== "object") continue;
      for (const [key, draft] of Object.entries(entries)) {
        const { text, at } = (draft ?? {}) as Partial<Draft>;
        if (typeof text !== "string" || typeof at !== "number") continue;
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
  try {
    const kept = capped(drafts);
    if (Object.keys(kept).length)
      roamgateLocalStorage.setItem(DRAFTS_KEY, JSON.stringify(kept));
    else roamgateLocalStorage.removeItem(DRAFTS_KEY);
  } catch {}
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

/** The draft of an editor, forgotten as it is handed back. */
export function takeReviewDraft(
  sessionId: string,
  key: string,
): string | undefined {
  const drafts = readDrafts();
  const draft = drafts[sessionId]?.[key];
  if (!draft) return undefined;
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
