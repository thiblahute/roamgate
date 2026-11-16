import { useMemo, useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

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
    return parseReviewPrefs(roamgateLocalStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** The preferences in stored text; damaged text reads as none. */
function parseReviewPrefs(raw: string): ReviewPrefs {
  try {
    const prefs = JSON.parse(raw || "{}");
    return prefs && typeof prefs === "object" ? (prefs as ReviewPrefs) : {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();

export function writeReviewPrefs(update: Partial<ReviewPrefs>) {
  try {
    roamgateLocalStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ ...readReviewPrefs(), ...update }),
    );
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window's choice applies here too.
  const unsubscribe = subscribeLocalStorage((key) => {
    if (key === null || key === PREFS_KEY) listener();
  });
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

/**
 * The preferences' raw text, for useSyncExternalStore: the same string
 * while nothing changed.
 */
function snapshot(): string {
  try {
    return roamgateLocalStorage.getItem(PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The review's preferences, rendering again when they change. */
export function useReviewPrefs(): ReviewPrefs {
  const raw = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => parseReviewPrefs(raw), [raw]);
}

/** Side by side as chosen, else when the window is wide enough. */
export function reviewSplitDefault(
  prefs: ReviewPrefs,
  width: number | undefined,
): boolean {
  return prefs.split ?? (width !== undefined && width >= SPLIT_MIN_WIDTH);
}
