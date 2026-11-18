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
