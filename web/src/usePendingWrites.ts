import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewThread } from "../../shared/review";
import { keepReviewDraft, takeReviewDraft } from "./reviewDrafts";
import {
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "./reviewPending";
import { notSavedStatus, saveOrKeep } from "./reviewSave";
import type { ReviewSessionCall } from "./reviewSessionCall";

/*
 * A review's replies and new threads on their way: shown at once in their
 * thread, pending, until the review sent back has them. A write that
 * fails stays shown with its error, Retry and Discard, its text kept as
 * its editor's draft.
 */

export type PendingWrites = {
  /** The review's threads with the writes on their way in them. */
  threads: ReviewThread[];
  /** The writes on their way, by id. */
  pendingById: ReadonlyMap<string, PendingWrite>;
  /**
   * Sends a reply or a new thread, with its id: shown at once as pending;
   * failed, it stays shown with its error and Retry, its text kept (as the
   * draft of the editor `editorKeyOf`).
   */
  sendWrite: (write: PendingWrite, editorKeyOf: string) => void;
  /** Sends a failed write again, with the same id. */
  retryWrite: (write: PendingWrite) => void;
  /** Forgets a failed write; its text stays as the editor's draft. */
  discardWrite: (write: PendingWrite) => void;
};

export function usePendingWrites({
  threads: ownThreads,
  sessionId,
  call,
  setStatus,
  notify,
}: {
  /** The review's threads, as the server last sent them. */
  threads: ReviewThread[];
  sessionId: string;
  call: ReviewSessionCall;
  /** Says why a write failed. */
  setStatus: (status: string) => void;
  notify: (message: string, kind: "info", ms: number) => void;
}): PendingWrites {
  const [pendingWrites, setPendingWrites] = useState<PendingWrite[]>([]);
  const threads = useMemo(
    () => withPendingWrites(ownThreads, pendingWrites),
    [ownThreads, pendingWrites],
  );
  const pendingById = useMemo(
    () => new Map(pendingWrites.map((write) => [write.id, write])),
    [pendingWrites],
  );
  // Those the review now has are done with.
  useEffect(() => {
    setPendingWrites((writes) => {
      const left = writes.filter((write) => !writeLanded(ownThreads, write));
      return left.length === writes.length ? writes : left;
    });
  }, [ownThreads]);

  /** Pending writes being sent: a second send of one is ignored. */
  const sendingWrites = useRef(new Set<string>());
  /** The editor each pending write came from, whose draft keeps its text. */
  const writeDrafts = useRef(new Map<string, string>());
  function sendWrite(write: PendingWrite, editorKeyOf: string) {
    if (sendingWrites.current.has(write.id)) return;
    sendingWrites.current.add(write.id);
    writeDrafts.current.set(write.id, editorKeyOf);
    const sent = { ...write, error: undefined };
    setPendingWrites((writes) => [
      ...writes.filter((other) => other.id !== write.id),
      sent,
    ]);
    const { method, params } = pendingWriteCall(sent);
    void saveOrKeep(
      () => call(method, params),
      () => keepReviewDraft(sessionId, editorKeyOf, write.text),
    ).then((error) => {
      sendingWrites.current.delete(write.id);
      if (error) {
        setStatus(notSavedStatus(error));
        setPendingWrites((writes) =>
          writes.map((other) =>
            other.id === write.id ? { ...other, error } : other,
          ),
        );
        return;
      }
      // Saved: a draft kept by an earlier failure is done with.
      takeReviewDraft(sessionId, editorKeyOf);
    });
  }
  function retryWrite(write: PendingWrite) {
    sendWrite(write, writeDrafts.current.get(write.id) ?? "");
  }
  function discardWrite(write: PendingWrite) {
    setPendingWrites((writes) =>
      writes.filter((other) => other.id !== write.id),
    );
    notify("Not sent. Reopen the comment to find your text.", "info", 3000);
  }
  return { threads, pendingById, sendWrite, retryWrite, discardWrite };
}
