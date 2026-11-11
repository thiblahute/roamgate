import { roamgateLocalStorage } from "./browserStorage";

/*
 * The review's preferences, kept in the browser for every review: side by
 * side or unified, the file list hidden (Vim keys are the one setting of
 * vimKeys.ts). Damaged storage reads as no preference; a write keeps the
 * others.
 */

export const PREFS_KEY = "reviewPrefs";

export type ReviewPrefs = {
  split?: boolean;
  filesHidden?: boolean;
};

/** The width from which a review opens side by side, unless told. */
export const SPLIT_MIN_WIDTH = 1100;

export function readReviewPrefs(): ReviewPrefs {
  try {
    const prefs = JSON.parse(roamgateLocalStorage.getItem(PREFS_KEY) ?? "{}");
    return prefs && typeof prefs === "object" ? (prefs as ReviewPrefs) : {};
  } catch {
    return {};
  }
}

export function writeReviewPrefs(update: Partial<ReviewPrefs>) {
  try {
    roamgateLocalStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...readReviewPrefs(), ...update }),
    );
  } catch {}
}

/** Side by side as chosen, else when the window is wide enough. */
export function reviewSplitDefault(
  prefs: ReviewPrefs,
  width: number | undefined,
): boolean {
  return prefs.split ?? (width !== undefined && width >= SPLIT_MIN_WIDTH);
}
