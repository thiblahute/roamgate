import { useCallback, useEffect, useState } from "react";
import { roamgateLocalStorage } from "./browserStorage";

/**
 * How many unchanged lines the review draws around each change: none, git's
 * three, ten, or the whole file. Lines opened by hand (the gaps' buttons,
 * zo, a comment's line) show whatever this says.
 */
export type ReviewContext = 0 | 3 | 10 | "full";

export const REVIEW_CONTEXTS: readonly ReviewContext[] = [0, 3, 10, "full"];

/** Where the choice is kept: one for every review of this browser. */
export const REVIEW_CONTEXT_KEY = "review.context";

const listeners = new Set<(context: ReviewContext) => void>();

export function parseReviewContext(value: string | null): ReviewContext {
  return value === "full"
    ? "full"
    : value === "0"
      ? 0
      : value === "10"
        ? 10
        : 3;
}

function readContext(): ReviewContext {
  return parseReviewContext(roamgateLocalStorage.getItem(REVIEW_CONTEXT_KEY));
}

/** The review's context, remembered in the browser, the same in every view. */
export function useReviewContext(): [
  ReviewContext,
  (context: ReviewContext) => void,
] {
  const [context, setContext] = useState(readContext);
  useEffect(() => {
    listeners.add(setContext);
    return () => {
      listeners.delete(setContext);
    };
  }, []);
  const change = useCallback((next: ReviewContext) => {
    try {
      roamgateLocalStorage.setItem(REVIEW_CONTEXT_KEY, String(next));
    } catch {
      /* Kept for this page only when storage is not writable. */
    }
    for (const listener of listeners) listener(next);
  }, []);
  return [context, change];
}

/** The menu's words for a context. */
export function reviewContextLabel(context: ReviewContext): string {
  return context === "full"
    ? "Context: whole file"
    : context === 0
      ? "Context: none"
      : `Context: ${context} lines`;
}

/** What is said once it is chosen. */
export function reviewContextNotice(context: ReviewContext): string {
  return context === "full"
    ? "The whole file around the changes"
    : context === 0
      ? "No context around the changes"
      : `${context} lines of context around the changes`;
}
