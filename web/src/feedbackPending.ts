import { useSyncExternalStore } from "react";
import type { ReviewAnnotation } from "./annotations";

/*
 * The comments written in the inspector's views that are on their way to the
 * review store: drawn under their line as "Sending...", or, once the server
 * refused them, as "Not saved" with Retry and Discard. A refused one is also
 * kept in this browser, where it is saved on the next load.
 */

export type PendingFeedback = {
  note: ReviewAnnotation;
  /** Why the server did not take it; absent while it is on its way. */
  error?: string;
  /** A refusal kept it in this browser: written, it must leave there. */
  kept?: boolean;
  retry: () => void;
  discard: () => void;
};

let pending: ReadonlyMap<string, PendingFeedback> = new Map();
const listeners = new Set<() => void>();

function set(next: Map<string, PendingFeedback>) {
  pending = next;
  for (const listener of listeners) listener();
}

export const pendingFeedback = {
  /** A write begins (or begins again, after Retry). */
  start(
    note: ReviewAnnotation,
    actions: { retry: () => void; discard: () => void },
  ) {
    const kept = pending.get(note.id)?.kept;
    set(
      new Map(pending).set(note.id, {
        note,
        ...actions,
        ...(kept ? { kept } : {}),
      }),
    );
  },
  /** The server refused it. */
  fail(id: string, error: string) {
    const entry = pending.get(id);
    if (entry) set(new Map(pending).set(id, { ...entry, error, kept: true }));
  },
  /** It is written, or discarded. */
  done(id: string) {
    if (!pending.has(id)) return;
    const next = new Map(pending);
    next.delete(id);
    set(next);
  },
  get(id: string): PendingFeedback | undefined {
    return pending.get(id);
  },
  all(): ReadonlyMap<string, PendingFeedback> {
    return pending;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePendingFeedback(): ReadonlyMap<string, PendingFeedback> {
  return useSyncExternalStore(
    pendingFeedback.subscribe,
    pendingFeedback.all,
    pendingFeedback.all,
  );
}
