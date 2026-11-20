import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  REVIEW_USER,
  type ReviewSnapshot,
  type ReviewThread,
  WORK_NO_OWNER,
} from "../../../shared/review";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "../review";
import {
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "../reviewPending";
import { workCall } from "../work";
import { reviewImageMarkdown } from "../workspaceFeedback";
import {
  ThreadEditor,
  undeliveredComments,
  writeThenReadBack,
} from "./ChatThreads";
import { NoteBody } from "./ReviewNoteBody";
import { ThreadCard } from "./ThreadCard";

/**
 * A work item's comments: a review of the item (target `work`), whose
 * threads go to the item's owner session as review comments, answered
 * there in the thread. Read once, then kept by the review pushes; made by
 * the first comment.
 */

export type WorkItemThreadsApi = {
  snapshot: ReviewSnapshot | undefined;
  threads: ReviewThread[];
  open: number;
  /** Your comments waiting for the owner, and why. */
  waiting: { count: number; noOwner: boolean; reason: string } | null;
  write: (method: string, params: Record<string, unknown>) => Promise<boolean>;
  addImage: (file: File) => Promise<string>;
  send: (next: Omit<PendingWrite, "sessionId" | "at">) => Promise<boolean>;
  pendingById: Map<string, PendingWrite>;
  undelivered: Set<string>;
  error: string;
};

export function useWorkItemThreads(item: string): WorkItemThreadsApi {
  const reviews = useReviewState();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void workCall<{ snapshot: ReviewSnapshot | null }>("threads", { item })
      .then((answer) => {
        if (!live || !answer?.snapshot) return;
        rememberReviewSnapshot(answer.snapshot);
        setSessionId(answer.snapshot.session.id);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item]);
  const snapshot = useMemo(
    () =>
      (sessionId ? reviews.sessions.get(sessionId) : undefined) ??
      [...reviews.sessions.values()].find(
        ({ session }) =>
          session.target?.kind === "work" && session.target.item === item,
      ),
    [reviews.sessions, sessionId, item],
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [pendingWrites, setPendingWrites] = useState<PendingWrite[]>([]);
  useEffect(() => {
    const landed = snapshot?.threads ?? [];
    setPendingWrites((writes) => {
      const left = writes.filter((write) => !writeLanded(landed, write));
      return left.length === writes.length ? writes : left;
    });
  }, [snapshot]);
  const threads = useMemo(
    () =>
      withPendingWrites(snapshot?.threads ?? [], pendingWrites).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    [snapshot, pendingWrites],
  );
  const [error, setError] = useState("");

  /** The item's review, opened by the first comment (or image). */
  const openSession = useCallback(async () => {
    const known = snapshotRef.current?.session;
    if (known) return known;
    const answer = await workCall<{ snapshot: ReviewSnapshot | null }>(
      "threads",
      { item, open: true },
    );
    if (!answer?.snapshot)
      throw new Error("the item's thread could not be opened");
    rememberReviewSnapshot(answer.snapshot);
    setSessionId(answer.snapshot.session.id);
    return answer.snapshot.session;
  }, [item]);
  const addImage = useCallback(
    async (file: File) => {
      const session = await openSession();
      return reviewImageMarkdown(
        (method, params) => reviewCall(session.connectionId, method, params),
        session.id,
        file,
      );
    },
    [openSession],
  );
  const write = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError("");
      try {
        const session = await openSession();
        const connectionId = session.connectionId;
        await writeThenReadBack(
          (name, args) => reviewCall(connectionId, name, args),
          session.id,
          method,
          params,
          rememberReviewSnapshot,
        );
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [openSession],
  );
  const send = useCallback(
    async (next: Omit<PendingWrite, "sessionId" | "at">) => {
      const pending: PendingWrite = {
        ...next,
        sessionId: snapshotRef.current?.session.id ?? "",
        at: new Date().toISOString(),
      };
      setPendingWrites((writes) => [
        ...writes.filter((other) => other.id !== next.id),
        pending,
      ]);
      const { method, params } = pendingWriteCall(pending);
      const ok = await write(method, params);
      if (!ok)
        setPendingWrites((writes) =>
          writes.map((other) =>
            other.id === next.id ? { ...other, error: "not saved" } : other,
          ),
        );
      return ok;
    },
    [write],
  );
  const undelivered = useMemo(
    () => undeliveredComments(snapshot, "Claude"),
    [snapshot],
  );
  const pendingById = useMemo(
    () => new Map(pendingWrites.map((each) => [each.id, each])),
    [pendingWrites],
  );
  return {
    snapshot,
    threads,
    open: threads.filter((thread) => !thread.resolved).length,
    waiting: undelivered
      ? {
          count: undelivered.ids.size,
          noOwner: snapshot?.session.deliveryError === WORK_NO_OWNER,
          reason: undelivered.reason,
        }
      : null,
    write,
    addImage,
    send,
    pendingById,
    undelivered: undelivered?.ids ?? new Set(),
    error,
  };
}

/**
 * An item's threads in its detail, and a box for a new comment: `reply`
 * opens the box on the last thread, `compose` a new thread's box. The
 * description thread (the item's text when it was added, shown as the
 * detail's description) is drawn from its answers on: its first comment
 * is the description.
 */
export function WorkItemThreads({
  item,
  api,
  description,
  compose,
  onComposeDone,
  onLeave,
}: {
  item: string;
  api: WorkItemThreadsApi;
  /** The thread holding the item's description, shown above. */
  description?: ReviewThread | null;
  /** The box to open now: a new comment, or a reply to the last thread. */
  compose: "comment" | "reply" | null;
  onComposeDone: () => void;
  /** Esc in a box: the keys go back to the board. */
  onLeave: () => void;
}) {
  const [replying, setReplying] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (compose === "comment") setComposing(true);
    else if (compose === "reply") {
      const live = api.threads.filter((t) => !t.resolved);
      const last = live[live.length - 1] ?? api.threads[api.threads.length - 1];
      if (last) setReplying(last.id);
      else setComposing(true);
    }
    if (compose) onComposeDone();
    // A later change of compose opens the box again; the threads read
    // then are the current ones.
  }, [compose]);
  const toggleFold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="work-threads" data-work-threads={item}>
      {api.error ? (
        <p className="work-threads-error" role="alert">
          {api.error}
        </p>
      ) : null}
      {api.threads.map((shown) => {
        // The description's own thread: its answers, under the description.
        const thread =
          shown.id === description?.id
            ? { ...shown, comments: shown.comments.slice(1) }
            : shown;
        if (!thread.comments.length) return null;
        const isFolded =
          folded.has(thread.id) ||
          (thread.resolved && !folded.has(`open:${thread.id}`));
        return (
          <ThreadCard
            key={thread.id}
            thread={thread}
            folded={isFolded}
            cursor={null}
            onToggleFold={() =>
              thread.resolved
                ? toggleFold(`open:${thread.id}`)
                : toggleFold(thread.id)
            }
            onReply={() => setReplying(thread.id)}
            onResolve={() =>
              void api.write("review.resolve", {
                comment_id: thread.id,
                resolved: !thread.resolved,
              })
            }
            onDelete={() =>
              void api.write("review.delete", { comment_id: thread.id })
            }
            head={
              thread.anchor.work?.quote ? (
                <blockquote className="work-thread-quote">
                  {thread.anchor.work.quote}
                </blockquote>
              ) : thread.id === description?.id ? (
                <p className="work-thread-on">On the description</p>
              ) : undefined
            }
            messageClass={(message, index) =>
              (api.pendingById.get(message.id) ??
              (index === 0 && thread === shown
                ? api.pendingById.get(thread.id)
                : undefined))
                ? " is-pending"
                : ""
            }
            authorExtra={(message, index) => {
              const pending =
                api.pendingById.get(message.id) ??
                (index === 0 && thread === shown
                  ? api.pendingById.get(thread.id)
                  : undefined);
              if (pending)
                return (
                  <span
                    className={`chat-thread-pending${pending.error ? " is-failed" : ""}`}
                    role={pending.error ? "alert" : "status"}
                  >
                    {pending.error
                      ? "Not saved: Send tries again"
                      : "Sending..."}
                  </span>
                );
              if (api.undelivered.has(message.id) && api.waiting)
                return (
                  <>
                    <span
                      className="chat-thread-pending is-failed"
                      role="status"
                    >
                      {api.waiting.noOwner
                        ? "Waiting for the owner session"
                        : `Not delivered: ${api.waiting.reason}`}
                    </span>
                    <button
                      type="button"
                      className="chat-thread-retry"
                      onClick={() => void api.write("review.retry", {})}
                    >
                      Retry
                    </button>
                  </>
                );
              return null;
            }}
            body={(message) => <NoteBody text={message.body} />}
            footer={
              replying === thread.id && !api.pendingById.has(thread.id) ? (
                <ThreadEditor
                  placeholder="Reply..."
                  onAddImage={api.addImage}
                  onLeave={onLeave}
                  onClose={() => {
                    setReplying(null);
                    onLeave();
                  }}
                  onSave={(text, id) =>
                    api
                      .send({
                        id,
                        replyTo: thread.id,
                        kind: thread.kind,
                        anchor: thread.anchor,
                        text,
                      })
                      .then((ok) => {
                        if (!ok) return;
                        setReplying(null);
                        onLeave();
                      })
                  }
                />
              ) : undefined
            }
          />
        );
      })}
      {composing ? (
        <div className="chat-thread is-draft work-thread-draft">
          <ThreadEditor
            placeholder="Comment for the owner session..."
            onAddImage={api.addImage}
            onLeave={onLeave}
            onClose={() => {
              setComposing(false);
              onLeave();
            }}
            onSave={(text, id) =>
              api
                .send({
                  id,
                  kind: "discussion",
                  anchor: { work: { item } },
                  text,
                })
                .then((ok) => {
                  if (!ok) return;
                  setComposing(false);
                  onLeave();
                })
            }
          />
        </div>
      ) : (
        <div className="work-threads-bar">
          <button
            type="button"
            className="primary"
            onClick={() => setComposing(true)}
          >
            Comment (c)
          </button>
          {api.waiting ? (
            <span className="work-threads-waiting" role="status">
              {api.waiting.noOwner
                ? `${api.waiting.count} waiting: no owner session runs`
                : `${api.waiting.count} not delivered`}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Whether a thread's last word is the user's (for the card's badge). */
export function lastByUser(thread: ReviewThread): boolean {
  return thread.comments[thread.comments.length - 1]?.author === REVIEW_USER;
}
