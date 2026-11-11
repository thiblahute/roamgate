import { roamgateLocalStorage } from "./browserStorage";

/*
 * Where you were in each review (its view and line), kept in the browser
 * so a page reload goes back there. The places of the PLACES_KEPT reviews
 * last moved in are kept; damaged storage reads as none.
 */

export const PLACE_KEY = "reviewPlace";
/** The most reviews whose place is kept across reloads. */
export const PLACES_KEPT = 50;

/** Where you were in a review: its view and line, back after a reload. */
export type ReviewPlace = {
  /** The commit shown, or null for all changes. */
  commit: string | null;
  /** That commit's subject and place, to find it again once rewritten. */
  subject?: string;
  index?: number;
  count?: number;
  path?: string;
  old?: number | null;
  new?: number | null;
  /** How far down the review the line stood, in pixels (a reload). */
  offset?: number;
};

function readPlaces(): Record<string, ReviewPlace> {
  try {
    const all = JSON.parse(roamgateLocalStorage.getItem(PLACE_KEY) ?? "{}");
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

export function readReviewPlace(sessionId: string): ReviewPlace | null {
  const place = readPlaces()[sessionId];
  return place && typeof place === "object" ? place : null;
}

/** Remembers a review's place, the latest of the reviews kept. */
export function writeReviewPlace(sessionId: string, place: ReviewPlace) {
  try {
    const kept = Object.entries(readPlaces())
      .filter(([id]) => id !== sessionId)
      .slice(-(PLACES_KEPT - 1));
    roamgateLocalStorage.setItem(
      PLACE_KEY,
      JSON.stringify(Object.fromEntries([...kept, [sessionId, place]])),
    );
  } catch {}
}
