import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EFFORT_NO_LEADER,
  REVIEW_USER,
  type ReviewEffortItemKind,
  type ReviewEffortPart,
  type ReviewEffortTab,
  type ReviewMessagePart,
  type ReviewSnapshot,
  type ReviewThread,
} from "../../../shared/review";
import { mrReviewsCall } from "../mrReviews";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "../review";
import {
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "../reviewPending";
import {
  ThreadEditor,
  undeliveredComments,
  writeThenReadBack,
} from "./ChatThreads";
import {
  MessageNotes,
  MessageReplyButton,
  OnMessageHead,
  selectedWords,
  useSelectedWords,
} from "./MessageThreads";
import { NoteBody } from "./ReviewNoteBody";

/**
 * Comment threads on what an upstreaming effort's view shows: a review of
 * the effort (target `effort`), whose threads go to its leader session as
 * review comments, answered there in the thread. Each is anchored to the
 * tab and what was pointed at in it (a plan, a commit by its ledger key, a
 * count, a directory, a feeder, a part of What changed), with the words
 * selected, so it stays on its item across refreshes and rebases.
 */

/** What one points at in the view: a tab, an item of it, a plan's row. */
export type EffortPoint = {
  tab: ReviewEffortTab;
  item?: { kind: ReviewEffortItemKind; key: string; label?: string };
  plan?: string;
};

/** The same place, whatever its label says now. */
export function pointKey(point: EffortPoint): string {
  return [
    point.tab,
    point.item?.kind ?? "",
    point.item?.key ?? "",
    point.plan ?? "",
  ].join("\n");
}

function partPoint(part: ReviewEffortPart): EffortPoint {
  return {
    tab: part.tab,
    ...(part.item ? { item: part.item } : {}),
    ...(part.plan ? { plan: part.plan } : {}),
  };
}

/** The attributes that make an element a place one comments on. */
export function effortItemProps(
  point: EffortPoint,
  pointed: EffortPoint | null,
): Record<string, string | undefined> {
  return {
    "data-effort-item": point.item?.kind,
    "data-effort-key": point.item?.key,
    "data-effort-label": point.item?.label,
    "data-effort-plan": point.plan,
    "data-pointed":
      pointed && pointKey(pointed) === pointKey(point) ? "true" : undefined,
  };
}

/** The place an element of the view stands for (or its tab). */
export function pointOf(
  element: Element | null,
  tab: ReviewEffortTab,
): EffortPoint {
  const item = element?.closest<HTMLElement>("[data-effort-item]");
  const kind = item?.dataset.effortItem as ReviewEffortItemKind | undefined;
  const key = item?.dataset.effortKey;
  if (!item || !kind || !key) return { tab };
  return {
    tab,
    item: {
      kind,
      key,
      ...(item.dataset.effortLabel ? { label: item.dataset.effortLabel } : {}),
    },
    ...(item.dataset.effortPlan ? { plan: item.dataset.effortPlan } : {}),
  };
}

type Draft = { point: EffortPoint; quote?: string };

export type EffortThreads = {
  snapshot: ReviewSnapshot | undefined;
  threads: ReviewThread[];
  /** Threads at a place, oldest first. */
  at: (point: EffortPoint) => ReviewThread[];
  open: number;
  /** Your comments waiting for the leader, and why. */
  waiting: { count: number; noLeader: boolean; reason: string } | null;
  draft: Draft | null;
  comment: (point: EffortPoint, quote?: string) => void;
  cancel: () => void;
  /** Threads on the whole of a thread's message (Reply on it), by the message. */
  byMessage: ReadonlyMap<string, ReviewThread[]>;
  /** The thread being written on a message: an answer to the whole of it. */
  messageDraft: ReviewMessagePart | null;
  /** Reply on a message: opens its box. */
  replyMessage: (part: ReviewMessagePart) => void;
  write: (method: string, params: Record<string, unknown>) => Promise<boolean>;
  send: (next: Omit<PendingWrite, "sessionId" | "at">) => Promise<boolean>;
  pendingById: Map<string, PendingWrite>;
  undelivered: Set<string>;
  error: string;
  clearError: () => void;
  /** Back to the view's keys once a box closes. */
  back: () => void;
};

const EffortThreadsContext = createContext<EffortThreads | null>(null);

export function useEffortThreadsContext(): EffortThreads | null {
  return useContext(EffortThreadsContext);
}

export const EffortThreadsProvider = EffortThreadsContext.Provider;

/** The effort's review: read once, then kept by the review pushes. */
export function useEffortThreads(
  effort: string,
  back: () => void,
): EffortThreads {
  const reviews = useReviewState();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void mrReviewsCall<{ snapshot: ReviewSnapshot | null }>("effort.threads", {
      id: effort,
    })
      .then((answer) => {
        if (!live || !answer?.snapshot) return;
        rememberReviewSnapshot(answer.snapshot);
        setSessionId(answer.snapshot.session.id);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [effort]);
  const snapshot = useMemo(
    () =>
      (sessionId ? reviews.sessions.get(sessionId) : undefined) ??
      [...reviews.sessions.values()].find(
        ({ session }) =>
          session.target?.kind === "effort" && session.target.effort === effort,
      ),
    [reviews.sessions, sessionId, effort],
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
      withPendingWrites(snapshot?.threads ?? [], pendingWrites).filter(
        (thread) => !!thread.anchor.effort,
      ),
    [snapshot, pendingWrites],
  );
  // A thread on a message of another (Reply on it) is drawn in that one,
  // not at its place.
  const { roots, byMessage } = useMemo(() => {
    const comments = new Set(
      threads.flatMap((thread) => thread.comments.map((each) => each.id)),
    );
    const roots: ReviewThread[] = [];
    const byMessage = new Map<string, ReviewThread[]>();
    for (const thread of threads) {
      const part = thread.anchor.message;
      if (part && comments.has(part.comment))
        byMessage.set(part.comment, [
          ...(byMessage.get(part.comment) ?? []),
          thread,
        ]);
      else roots.push(thread);
    }
    for (const list of byMessage.values())
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { roots, byMessage };
  }, [threads]);
  const byPlace = useMemo(() => {
    const places = new Map<string, ReviewThread[]>();
    for (const thread of roots) {
      const key = pointKey(partPoint(thread.anchor.effort!));
      places.set(key, [...(places.get(key) ?? []), thread]);
    }
    for (const list of places.values())
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return places;
  }, [roots]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [messageDraft, setMessageDraft] = useState<ReviewMessagePart | null>(
    null,
  );
  const [error, setError] = useState("");

  const write = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError("");
      try {
        let session = snapshotRef.current?.session;
        if (!session) {
          // The first comment opens the effort's review.
          const answer = await mrReviewsCall<{
            snapshot: ReviewSnapshot | null;
          }>("effort.threads", { id: effort, open: true });
          if (!answer?.snapshot)
            throw new Error("the effort's review could not be opened");
          rememberReviewSnapshot(answer.snapshot);
          setSessionId(answer.snapshot.session.id);
          session = answer.snapshot.session;
        }
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
    [effort],
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
  const open = threads.filter((thread) => !thread.resolved).length;
  return {
    snapshot,
    threads,
    at: (point) => byPlace.get(pointKey(point)) ?? [],
    open,
    waiting: undelivered
      ? {
          count: undelivered.ids.size,
          noLeader: snapshot?.session.deliveryError === EFFORT_NO_LEADER,
          reason: undelivered.reason,
        }
      : null,
    draft,
    comment: (point, quote) => {
      const words = quote?.trim().slice(0, 4000);
      setMessageDraft(null);
      setDraft({ point, ...(words ? { quote: words } : {}) });
      window.getSelection()?.removeAllRanges();
    },
    cancel: () => {
      setDraft(null);
      setMessageDraft(null);
    },
    byMessage,
    messageDraft,
    replyMessage: (part) => {
      setDraft(null);
      setMessageDraft(part);
    },
    write,
    send,
    pendingById,
    undelivered: undelivered?.ids ?? new Set(),
    error,
    clearError: () => setError(""),
    back,
  };
}

/**
 * A thread on the effort's view: its messages (Reply on each: a thread on
 * the whole of it, drawn under it), then Reply and Resolve. `onMessage`:
 * drawn under the message it is on, its head says so.
 */
function EffortThreadCard({
  thread,
  api,
  onMessage = false,
}: {
  thread: ReviewThread;
  api: EffortThreads;
  onMessage?: boolean;
}) {
  const [folded, setFolded] = useState(thread.resolved);
  const [replying, setReplying] = useState(false);
  const pendingKey = useRef("");
  useEffect(() => setFolded(thread.resolved), [thread.resolved]);
  const first = thread.comments[0];
  const quote = thread.anchor.effort?.quote;
  const resolve = () =>
    void api.write("review.resolve", {
      comment_id: thread.id,
      resolved: !thread.resolved,
    });
  const remove = () =>
    void api.write("review.delete", { comment_id: thread.id });
  const own = thread.comments.length === 1 && first?.author === REVIEW_USER;
  if (folded)
    return (
      <button
        type="button"
        className="chat-thread is-folded mr-effort-thread"
        data-thread-id={thread.id}
        data-resolved={thread.resolved ? "true" : undefined}
        onClick={() => setFolded(false)}
        title="Unfold (za)"
      >
        <span className="chat-thread-mark">
          {thread.resolved ? "✓ Resolved" : "▸ Folded"}
        </span>
        <span className="chat-thread-summary">
          {(first?.body ?? "").split("\n")[0]}
        </span>
        <span className="chat-thread-count">
          {thread.comments.length} message
          {thread.comments.length === 1 ? "" : "s"}
        </span>
      </button>
    );
  return (
    <div
      className={`chat-thread mr-effort-thread${thread.resolved ? " is-resolved" : ""}`}
      data-thread-id={thread.id}
      data-resolved={thread.resolved ? "true" : undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        // za folds, dd deletes your lone comment: z and d wait for it.
        const key = pendingKey.current + event.key;
        pendingKey.current = "";
        let handled = true;
        if (key === "r") resolve();
        else if (key === "R" || key === "c" || key === "Enter")
          setReplying(true);
        else if (key === "za") setFolded(true);
        else if (key === "dd") {
          if (own) remove();
        } else if (key === "z" || key === "d") pendingKey.current = key;
        else if (key === "Escape") api.back();
        else handled = false;
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {onMessage ? <OnMessageHead /> : null}
      {quote ? (
        <blockquote className="mr-effort-quote">{quote}</blockquote>
      ) : null}
      {thread.comments.map((message, index) => {
        const pending =
          api.pendingById.get(message.id) ??
          (index === 0 ? api.pendingById.get(thread.id) : undefined);
        const replyDraft = api.messageDraft;
        return (
          <div
            key={message.id}
            className={`chat-thread-message${message.author === REVIEW_USER ? "" : " from-agent"}${pending ? " is-pending" : ""}`}
          >
            <div className="chat-thread-message-head">
              <span className="chat-thread-author">
                {message.author === REVIEW_USER ? "You" : message.author}
                {pending ? (
                  <span
                    className={`chat-thread-pending${pending.error ? " is-failed" : ""}`}
                    role={pending.error ? "alert" : "status"}
                  >
                    {pending.error
                      ? "Not saved: Send tries again"
                      : "Sending..."}
                  </span>
                ) : api.undelivered.has(message.id) && api.waiting ? (
                  <>
                    <span
                      className="chat-thread-pending is-failed"
                      role="status"
                    >
                      {api.waiting.noLeader
                        ? "Waiting for the leader session"
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
                ) : null}
              </span>
              <MessageReplyButton
                onClick={() =>
                  api.replyMessage({ thread: thread.id, comment: message.id })
                }
              />
            </div>
            <div className="chat-thread-body">
              <NoteBody text={message.body} />
              <MessageNotes
                threads={api.byMessage.get(message.id) ?? []}
                renderThread={(note) => (
                  <EffortThreadCard
                    key={note.id}
                    thread={note}
                    api={api}
                    onMessage
                  />
                )}
                draft={
                  replyDraft?.comment === message.id ? (
                    <EffortMessageReply
                      thread={thread}
                      draft={replyDraft}
                      api={api}
                    />
                  ) : null
                }
              />
            </div>
          </div>
        );
      })}
      {api.pendingById.has(thread.id) ? null : replying ? (
        <ThreadEditor
          placeholder="Reply..."
          onLeave={api.back}
          onClose={() => {
            setReplying(false);
            api.back();
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
                setReplying(false);
                api.back();
              })
          }
        />
      ) : (
        <div className="chat-thread-bar">
          <button type="button" onClick={() => setReplying(true)}>
            Reply
          </button>
          <button type="button" onClick={resolve}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
          <button type="button" onClick={() => setFolded(true)}>
            Fold
          </button>
          {own ? (
            <button type="button" onClick={remove}>
              Delete
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The box of a thread on the whole of a thread's message (Reply on it). */
function EffortMessageReply({
  thread,
  draft,
  api,
}: {
  thread: ReviewThread;
  draft: ReviewMessagePart;
  api: EffortThreads;
}) {
  const effort = thread.anchor.effort;
  return (
    <div className="chat-thread is-draft mr-effort-thread">
      <ThreadEditor
        placeholder="Reply..."
        onLeave={api.back}
        onClose={() => {
          api.cancel();
          api.back();
        }}
        onSave={(text, id) =>
          api
            .send({
              id,
              kind: "discussion",
              anchor: { ...(effort ? { effort } : {}), message: draft },
              text,
            })
            .then((ok) => {
              if (!ok) return;
              api.cancel();
              api.back();
            })
        }
      />
    </div>
  );
}

/** The threads at a place of the view, and the comment being written there. */
export function EffortThreadsAt({
  point,
  extra = [],
}: {
  point: EffortPoint;
  /** Threads drawn here though anchored elsewhere (their item is gone). */
  extra?: ReviewThread[];
}): ReactNode {
  const api = useEffortThreadsContext();
  if (!api) return null;
  const threads = [...api.at(point), ...extra];
  const drafting =
    api.draft && pointKey(api.draft.point) === pointKey(point)
      ? api.draft
      : null;
  if (!threads.length && !drafting) return null;
  return (
    <div className="mr-effort-threads" data-effort-threads={pointKey(point)}>
      {threads.map((thread) => (
        <EffortThreadCard key={thread.id} thread={thread} api={api} />
      ))}
      {drafting ? (
        <div className="chat-thread is-draft mr-effort-thread">
          {drafting.quote ? (
            <blockquote className="mr-effort-quote">
              {drafting.quote}
            </blockquote>
          ) : null}
          <ThreadEditor
            placeholder="Comment for the leader session..."
            onLeave={api.back}
            onClose={() => {
              api.cancel();
              api.back();
            }}
            onSave={(text, id) =>
              api
                .send({
                  id,
                  kind: "discussion",
                  anchor: {
                    effort: {
                      ...drafting.point,
                      ...(drafting.quote ? { quote: drafting.quote } : {}),
                    },
                  },
                  text,
                })
                .then((ok) => {
                  if (!ok) return;
                  api.cancel();
                  api.back();
                })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/** Words selected in the view: where they are, and a Comment button. */
export function useEffortSelection(
  root: React.RefObject<HTMLElement | null>,
): { quote: string; element: Element; x: number; y: number } | null {
  return useSelectedWords(wordsIn(root.current))[0];
}

/** The words selected in an element (not in a thread or a box). */
export function selectedIn(
  root: HTMLElement | null,
): { quote: string; element: Element; x: number; y: number } | null {
  return selectedWords(wordsIn(root));
}

/** Where words selected in `root` are: their element, when they count. */
const wordsIn =
  (root: HTMLElement | null) =>
  (start: Element): { element: Element } | null =>
    root?.contains(start) &&
    !start.closest(".mr-effort-thread, input, textarea")
      ? { element: start }
      : null;
