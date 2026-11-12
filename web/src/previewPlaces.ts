import { roamgateLocalStorage } from "./browserStorage";
import type { PreviewHistory, PreviewPlace } from "./previewHistory";

/*
 * Where each Files preview tab was left, per checkout: its Back / Forward
 * history (with each place's scroll and a page's frame URL), the cursor,
 * the threads folded or opened against their default, the Comments panel
 * and the Source switch. The preview gives it back when it shows the tab
 * again: after another view, another workspace (the inspector is drawn
 * anew for it) or a page reload, as the tabs themselves are kept. In
 * memory, and in localStorage beside the tabs, a little after each change.
 */

export type PreviewTabPlace = {
  history: PreviewHistory;
  cursor: string | null;
  flipped: readonly string[];
  mode: "rendered" | "raw";
  threadsOpen: boolean;
};

/** Tabs kept per checkout: the ones left last. */
export const PREVIEW_PLACES_KEPT = 40;
/** How long after a change it is written to localStorage. */
export const PREVIEW_PLACES_WRITE_MS = 400;

const STORAGE_PREFIX = "roamgate.previewPlaces.v1:";
const scopes = new Map<string, Map<string, PreviewTabPlace>>();
const writes = new Map<string, ReturnType<typeof setTimeout>>();

function storageKey(scope: string) {
  return `${STORAGE_PREFIX}${scope}`;
}

function validPlace(value: unknown): value is PreviewPlace {
  const place = value as PreviewPlace | null;
  return (
    !!place &&
    typeof place.path === "string" &&
    typeof place.scroll === "number" &&
    Number.isFinite(place.scroll) &&
    (place.fragment === undefined || typeof place.fragment === "string") &&
    (place.framePage === undefined || typeof place.framePage === "string")
  );
}

/**
 * A place as kept, without what an older build kept beside it: a frame's
 * URL under the token it was shown in (`frameUrl`), which a token serving
 * another directory read as another page, its path doubled.
 */
function keptPlace(place: PreviewPlace): PreviewPlace {
  if (!("frameUrl" in place)) return place;
  const kept: PreviewPlace & { frameUrl?: unknown } = { ...place };
  delete kept.frameUrl;
  return kept;
}

/** A kept tab's place as read back, or null when it is not one. */
export function parsePreviewTabPlace(value: unknown): PreviewTabPlace | null {
  const raw = value as Partial<PreviewTabPlace> | null;
  const history = raw?.history as PreviewHistory | undefined;
  if (
    !raw ||
    !history ||
    !Array.isArray(history.places) ||
    !history.places.length ||
    !history.places.every(validPlace) ||
    !Number.isInteger(history.at) ||
    history.at < 0 ||
    history.at >= history.places.length
  )
    return null;
  return {
    history: { places: history.places.map(keptPlace), at: history.at },
    cursor: typeof raw.cursor === "string" ? raw.cursor : null,
    flipped: Array.isArray(raw.flipped)
      ? raw.flipped.filter((id): id is string => typeof id === "string")
      : [],
    mode: raw.mode === "raw" ? "raw" : "rendered",
    threadsOpen: raw.threadsOpen === true,
  };
}

function loaded(scope: string): Map<string, PreviewTabPlace> {
  let places = scopes.get(scope);
  if (places) return places;
  places = new Map();
  try {
    const raw = JSON.parse(
      roamgateLocalStorage.getItem(storageKey(scope)) ?? "[]",
    ) as unknown;
    if (Array.isArray(raw))
      for (const pair of raw) {
        if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
        const place = parsePreviewTabPlace(pair[1]);
        if (place) places.set(pair[0], place);
      }
  } catch {
    /* Unreadable: nothing kept. */
  }
  scopes.set(scope, places);
  return places;
}

/** Where the tab `path` of `scope` was left, if it was. */
export function readPreviewTabPlace(
  scope: string,
  path: string,
): PreviewTabPlace | null {
  return loaded(scope).get(path) ?? null;
}

/** Writes `scope`'s tabs to localStorage now (a page going away). */
export function flushPreviewTabPlaces(scope?: string) {
  for (const [each, timer] of [...writes]) {
    if (scope !== undefined && each !== scope) continue;
    clearTimeout(timer);
    writes.delete(each);
    const places = scopes.get(each);
    if (!places) continue;
    try {
      roamgateLocalStorage.setItem(
        storageKey(each),
        JSON.stringify([...places]),
      );
    } catch {
      /* Full or unavailable: kept in memory. */
    }
  }
}

/** The tab `path` of `scope` is left as `place`. */
export function keepPreviewTabPlace(
  scope: string,
  path: string,
  place: PreviewTabPlace,
) {
  const places = loaded(scope);
  // Last kept, last in the map: the oldest go first.
  places.delete(path);
  places.set(path, place);
  while (places.size > PREVIEW_PLACES_KEPT)
    places.delete(places.keys().next().value!);
  if (writes.has(scope)) return;
  writes.set(
    scope,
    setTimeout(() => flushPreviewTabPlaces(scope), PREVIEW_PLACES_WRITE_MS),
  );
}

/** Forgets what is kept in memory (tests; localStorage stays). */
export function resetPreviewTabPlacesForTests() {
  for (const timer of writes.values()) clearTimeout(timer);
  writes.clear();
  scopes.clear();
}

if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => flushPreviewTabPlaces());
