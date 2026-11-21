import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  REVIEW_USER,
  type ReviewComment,
  type ReviewMessagePart,
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
import { type MessageParts, NoteBody } from "./ReviewNoteBody";
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
 * is the description. A thread on a comment of another thread (anchor
 * `message`: that thread, the comment, and the words quoted when some
 * were) is drawn under that comment, indented, under the words it quotes,
 * as a chat's are under a message's part: "Reply to this" on a comment
 * opens one, and so does Comment on words selected in a comment.
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
  /** A thread being written on a comment: the comment, the words quoted. */
  const [partDraft, setPartDraft] = useState<ReviewMessagePart | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
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
  /** The threads on a comment of another thread, by that comment. */
  const onComment = useMemo(() => {
    const map = new Map<string, ReviewThread[]>();
    for (const thread of api.threads) {
      const comment = thread.anchor.message?.comment;
      if (comment) map.set(comment, [...(map.get(comment) ?? []), thread]);
    }
    return map;
  }, [api.threads]);
  /**
   * The comments drawn (not the description, shown above): a thread on a
   * comment not among them stands on its own, saying what it quoted.
   */
  const drawn = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of api.threads)
      thread.comments.forEach((comment, index) => {
        if (thread.id !== description?.id || index > 0) ids.add(comment.id);
      });
    return ids;
  }, [api.threads, description]);
  const roots = api.threads.filter((thread) => {
    const parent = thread.anchor.message?.comment;
    return !parent || !drawn.has(parent);
  });

  // Words selected in a comment offer a thread on it, quoting them.
  const [selection, setSelection] = useState<SelectedWords | null>(null);
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setSelection(selectedWords(rootRef.current)),
        200,
      );
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);
  /** Opens the box of a thread on a comment (on its words, when quoted). */
  const openPart = (part: ReviewMessagePart) => {
    setPartDraft(part);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const pendingOf = (
    shown: ReviewThread,
    thread: ReviewThread,
    message: ReviewComment,
    index: number,
  ) =>
    api.pendingById.get(message.id) ??
    (index === 0 && thread === shown
      ? api.pendingById.get(thread.id)
      : undefined);

  /**
   * The threads on a message, drawn under the words they quote (under the
   * whole message when none), and the one being written on it.
   */
  const partsOf = (
    message: ReviewComment,
    seen: Set<string>,
  ): MessageParts | undefined => {
    const notes = (onComment.get(message.id) ?? [])
      .filter((nested) => !seen.has(nested.id))
      .map((nested) => ({
        key: nested.id,
        quote: nested.anchor.message?.quote ?? "",
        node: renderThread(nested, new Set([...seen, nested.id])),
      }));
    if (partDraft?.comment === message.id)
      notes.push({
        key: "draft",
        quote: partDraft.quote ?? "",
        node: (
          <div className="chat-thread is-draft work-thread-draft">
            <ThreadEditor
              placeholder={
                partDraft.quote
                  ? "Comment on these words..."
                  : "Reply to this comment..."
              }
              onAddImage={api.addImage}
              onLeave={onLeave}
              onClose={() => {
                setPartDraft(null);
                onLeave();
              }}
              onSave={(text, id) =>
                api
                  .send({
                    id,
                    kind: "discussion",
                    anchor: { work: { item }, message: partDraft },
                    text,
                  })
                  .then((ok) => {
                    if (!ok) return;
                    setPartDraft(null);
                    onLeave();
                  })
              }
            />
          </div>
        ),
      });
    return notes.length ? { notes, focused: null } : undefined;
  };

  /** A thread's card, its nested threads drawn in its messages. */
  const renderThread = (shown: ReviewThread, seen: Set<string>): ReactNode => {
    // The description's own thread: its answers, under the description.
    const thread =
      shown.id === description?.id
        ? { ...shown, comments: shown.comments.slice(1) }
        : shown;
    if (!thread.comments.length) return null;
    const isFolded =
      folded.has(thread.id) ||
      (thread.resolved && !folded.has(`open:${thread.id}`));
    const part = thread.anchor.message;
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
          ) : part && !drawn.has(part.comment) ? (
            // On a comment not drawn here (the description's, one deleted).
            part.quote ? (
              <blockquote className="work-thread-quote">
                {part.quote}
              </blockquote>
            ) : (
              <p className="work-thread-on">On an earlier comment</p>
            )
          ) : undefined
        }
        messageClass={(message, index) =>
          pendingOf(shown, thread, message, index) ? " is-pending" : ""
        }
        authorExtra={(message, index) => {
          const pending = pendingOf(shown, thread, message, index);
          if (pending)
            return (
              <span
                className={`chat-thread-pending${pending.error ? " is-failed" : ""}`}
                role={pending.error ? "alert" : "status"}
              >
                {pending.error ? "Not saved: Send tries again" : "Sending..."}
              </span>
            );
          if (api.undelivered.has(message.id) && api.waiting)
            return (
              <>
                <span className="chat-thread-pending is-failed" role="status">
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
        body={(message) => (
          <NoteBody text={message.body} parts={partsOf(message, seen)} />
        )}
        messageBar={(message, index) =>
          pendingOf(shown, thread, message, index) ||
          partDraft?.comment === message.id ? null : (
            <div className="work-thread-message-bar">
              <button
                type="button"
                className="work-thread-reply"
                title="Answer this comment in a thread of its own, under it (select its words to quote them)"
                onClick={() =>
                  openPart({ thread: thread.id, comment: message.id })
                }
              >
                Reply to this
              </button>
            </div>
          )
        }
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
  };

  return (
    <div className="work-threads" data-work-threads={item} ref={rootRef}>
      {api.error ? (
        <p className="work-threads-error" role="alert">
          {api.error}
        </p>
      ) : null}
      {roots.map((shown) => renderThread(shown, new Set([shown.id])))}
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
      {selection
        ? createPortal(
            <button
              type="button"
              className="chat-thread-select work-thread-select"
              style={{ left: selection.x, top: selection.y }}
              // Keeps the selection while the button is pressed.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() =>
                openPart({
                  thread: selection.thread,
                  comment: selection.comment,
                  quote: selection.quote,
                })
              }
            >
              Comment
            </button>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Words selected in a comment: its thread, the comment, where Comment goes. */
export type SelectedWords = {
  thread: string;
  comment: string;
  quote: string;
  x: number;
  y: number;
};

/**
 * The words selected in a comment of the threads under `root` (not in a
 * box being written): the thread and comment they are in (a nested
 * thread's own, for words of its messages), and where to offer Comment.
 */
export function selectedWords(root: HTMLElement | null): SelectedWords | null {
  const current = window.getSelection();
  const range =
    current && !current.isCollapsed && current.rangeCount === 1
      ? current.getRangeAt(0)
      : null;
  const start =
    range?.startContainer instanceof Element
      ? range.startContainer
      : range?.startContainer.parentElement;
  const quote = current?.toString().trim() ?? "";
  if (
    !range ||
    !start ||
    !quote ||
    !root?.contains(start) ||
    start.closest(".chat-thread-editor, input, textarea")
  )
    return null;
  const body = start.closest<HTMLElement>(".chat-thread-body[data-message-id]");
  const comment = body?.dataset.messageId;
  const thread = body?.closest<HTMLElement>(".chat-thread[data-thread-id]")
    ?.dataset.threadId;
  if (!comment || !thread) return null;
  const rect = range.getBoundingClientRect();
  // On a touch screen the selection's handles hang under its ends: Comment
  // goes below them, 44px high, where a finger reaches it.
  const touch = window.matchMedia?.("(pointer: coarse)").matches;
  return {
    thread,
    comment,
    quote: quote.slice(0, 4000),
    x: Math.max(8, Math.min(rect.left, window.innerWidth - 120)),
    y: Math.max(
      8,
      Math.min(
        rect.bottom + (touch ? 32 : 8),
        window.innerHeight - (touch ? 52 : 44),
      ),
    ),
  };
}

/** Whether a thread's last word is the user's (for the card's badge). */
export function lastByUser(thread: ReviewThread): boolean {
  return thread.comments[thread.comments.length - 1]?.author === REVIEW_USER;
}
