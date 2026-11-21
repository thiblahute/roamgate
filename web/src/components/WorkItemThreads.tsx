import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useThreadKeys } from "./useThreadKeys";

/**
 * A work item's comments: a review of the item (target `work`), whose
 * threads go to the item's owner session as review comments, answered
 * there in the thread. Read once, then kept by the review pushes; made by
 * the first comment.
 */

export type WorkItemThreadsApi = WorkItemView & {
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
  const view = useWorkItemView();
  return {
    ...view,
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
 * What the detail has open, shared by its description and its threads:
 * where j / k are (a part of a comment `q:COMMENT:PART`, a thread's
 * message `m:COMMENT`, a folded thread `t:THREAD`), the thread being
 * written on a part, the threads folded by hand, the answer being written.
 */
export type WorkItemView = {
  cursor: string | null;
  setCursor: (cursor: string | null) => void;
  /** A thread being written on a comment: the comment, the words quoted. */
  partDraft: ReviewMessagePart | null;
  setPartDraft: (part: ReviewMessagePart | null) => void;
  /** Threads folded or unfolded by hand: resolved ones start folded. */
  flipped: ReadonlySet<string>;
  toggleFold: (thread: ReviewThread) => void;
  /** The thread whose answer is being written. */
  replying: string | null;
  setReplying: (id: string | null) => void;
};

export function useWorkItemView(): WorkItemView {
  const [cursor, setCursor] = useState<string | null>(null);
  const [partDraft, setPartDraft] = useState<ReviewMessagePart | null>(null);
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [replying, setReplying] = useState<string | null>(null);
  const toggleFold = useCallback(
    (thread: ReviewThread) =>
      setFlipped((current) => {
        const next = new Set(current);
        if (next.has(thread.id)) next.delete(thread.id);
        else next.add(thread.id);
        return next;
      }),
    [],
  );
  return {
    cursor,
    setCursor,
    partDraft,
    setPartDraft,
    flipped,
    toggleFold,
    replying,
    setReplying,
  };
}

/** The threads on a comment (anchor `message`), in order. */
function threadsOn(
  threads: readonly ReviewThread[],
  comment: string,
): ReviewThread[] {
  return threads.filter((thread) => thread.anchor.message?.comment === comment);
}

/** A part's words, as the quote of a thread on it. */
function partText(part: HTMLElement): string {
  return (part.textContent ?? "").trim().slice(0, 4000);
}

/**
 * A comment of the item as a message in parts, as a chat's: the threads
 * on its parts drawn under them (and the one being written), the + in a
 * part's margin opening one, a click on a part putting j / k on it.
 */
function WorkMessageBody({
  api,
  item,
  thread,
  message,
  seen,
  single,
  onLeave,
}: {
  api: WorkItemThreadsApi;
  item: string;
  /** The thread the message is in (a thread on its parts is in it too). */
  thread: ReviewThread;
  message: ReviewComment;
  /** The threads this one is drawn in: not drawn again inside it. */
  seen: ReadonlySet<string>;
  /** A message in one part is a stop too (the description). */
  single?: boolean;
  onLeave: () => void;
}) {
  const notes = threadsOn(api.threads, message.id)
    .filter((nested) => !seen.has(nested.id))
    .map((nested) => ({
      key: nested.id,
      quote: nested.anchor.message?.quote ?? "",
      node: (
        <WorkThreadCard
          api={api}
          item={item}
          shown={nested}
          seen={new Set([...seen, nested.id])}
          onLeave={onLeave}
        />
      ),
    }));
  const draft = api.partDraft;
  if (draft?.comment === message.id)
    notes.push({
      key: "draft",
      quote: draft.quote ?? "",
      node: (
        <div className="chat-thread is-draft work-thread-draft">
          <ThreadEditor
            placeholder="Comment on this part..."
            onAddImage={api.addImage}
            onLeave={onLeave}
            onClose={() => {
              api.setPartDraft(null);
              onLeave();
            }}
            onSave={(text, id) =>
              api
                .send({
                  id,
                  kind: "discussion",
                  anchor: { work: { item }, message: draft },
                  text,
                })
                .then((ok) => {
                  if (!ok) return;
                  api.setPartDraft(null);
                  onLeave();
                })
            }
          />
        </div>
      ),
    });
  const at = `q:${message.id}:`;
  const parts: MessageParts = {
    notes,
    focused: api.cursor?.startsWith(at)
      ? Number(api.cursor.slice(at.length))
      : null,
    onComment: (quote) =>
      api.setPartDraft({
        thread: thread.id,
        comment: message.id,
        quote: quote.trim().slice(0, 4000),
      }),
    // A click on a part puts j / k on it; on the one part of a thread's
    // message, on the message, its stop (a phone shows its + then).
    onSelect: (index) => {
      const body = document.querySelector(
        `[data-message-id="${CSS.escape(message.id)}"]`,
      );
      const parts =
        body?.querySelectorAll(":scope > .rc-text > [data-part]").length ?? 0;
      api.setCursor(
        !single && parts <= 1 ? `m:${message.id}` : `${at}${index}`,
      );
    },
    ...(single ? { single: true } : {}),
  };
  return <NoteBody text={message.body} parts={parts} />;
}

/**
 * A thread's card: its messages as messages in parts, the threads on
 * their parts in them. The description's own thread shows its answers
 * only (its first comment is the description, drawn above).
 */
function WorkThreadCard({
  api,
  item,
  shown,
  description,
  seen,
  onLeave,
}: {
  api: WorkItemThreadsApi;
  item: string;
  shown: ReviewThread;
  description?: ReviewThread | null;
  seen: ReadonlySet<string>;
  onLeave: () => void;
}) {
  const thread =
    shown.id === description?.id
      ? { ...shown, comments: shown.comments.slice(1) }
      : shown;
  if (!thread.comments.length) return null;
  const part = thread.anchor.message;
  const pendingOf = (message: ReviewComment, index: number) =>
    api.pendingById.get(message.id) ??
    (index === 0 && thread === shown
      ? api.pendingById.get(thread.id)
      : undefined);
  return (
    <ThreadCard
      thread={thread}
      folded={thread.resolved !== api.flipped.has(thread.id)}
      cursor={api.cursor}
      onToggleFold={() => api.toggleFold(thread)}
      onReply={() => api.setReplying(thread.id)}
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
        ) : part && seen.size === 1 ? (
          // On a comment not drawn (one deleted): on its own, with the words.
          part.quote ? (
            <blockquote className="work-thread-quote">{part.quote}</blockquote>
          ) : (
            <p className="work-thread-on">On an earlier comment</p>
          )
        ) : undefined
      }
      messageClass={(message, index) =>
        pendingOf(message, index) ? " is-pending" : ""
      }
      authorExtra={(message, index) => {
        const pending = pendingOf(message, index);
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
        <WorkMessageBody
          api={api}
          item={item}
          thread={thread}
          message={message}
          seen={seen}
          onLeave={onLeave}
        />
      )}
      footer={
        api.replying === thread.id && !api.pendingById.has(thread.id) ? (
          <ThreadEditor
            placeholder="Reply..."
            onAddImage={api.addImage}
            onLeave={onLeave}
            onClose={() => {
              api.setReplying(null);
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
                  api.setReplying(null);
                  onLeave();
                })
            }
          />
        ) : undefined
      }
    />
  );
}

/**
 * The item's description (the first comment of its description thread),
 * a message in parts as the comments are: the threads on its parts under
 * them, its + in the chat's gutter.
 */
export function WorkDescription({
  api,
  item,
  thread,
  onLeave,
}: {
  api: WorkItemThreadsApi;
  item: string;
  thread: ReviewThread;
  onLeave: () => void;
}) {
  const message = thread.comments[0];
  if (!message) return null;
  return (
    <div className="work-description" aria-label="Description">
      <div className="chat-review work-message" data-message-id={message.id}>
        <WorkMessageBody
          api={api}
          item={item}
          thread={thread}
          message={message}
          seen={new Set([thread.id])}
          single
          onLeave={onLeave}
        />
      </div>
    </div>
  );
}

/**
 * An item's threads in its detail, and a box for a new comment: `reply`
 * opens the box on the last thread, `compose` a new thread's box. The
 * description thread (the item's text when it was added, shown as the
 * detail's description) is drawn from its answers on. A thread on a part
 * of a comment (anchor `message`: the thread, the comment, the words) is
 * drawn under that part, in the comment, as a chat's threads on a
 * message's parts are; words selected in a comment offer Comment, a
 * thread quoting them.
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
  /** Esc in a box: the keys go back to the detail. */
  onLeave: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (compose === "comment") setComposing(true);
    else if (compose === "reply") {
      const live = api.threads.filter((t) => !t.resolved);
      const last = live[live.length - 1] ?? api.threads[api.threads.length - 1];
      if (last) api.setReplying(last.id);
      else setComposing(true);
    }
    if (compose) onComposeDone();
    // A later change of compose opens the box again; the threads read
    // then are the current ones.
  }, [compose]);
  /**
   * The comments drawn as messages (the description above when shown): a
   * thread on one of them is drawn in it; on another, on its own.
   */
  const drawn = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of api.threads)
      thread.comments.forEach((comment, index) => {
        if (thread.id !== description?.id || index > 0 || description)
          ids.add(comment.id);
      });
    return ids;
  }, [api.threads, description]);
  const roots = api.threads.filter((thread) => {
    const parent = thread.anchor.message?.comment;
    return !parent || !drawn.has(parent);
  });

  // Words selected in a comment (the description too) offer a thread on
  // it, quoting them.
  const [selection, setSelection] = useState<SelectedWords | null>(null);
  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = rootRef.current;
        setSelection(
          selectedWords(
            root?.closest<HTMLElement>("[data-work-keys]") ?? root,
            description?.id ?? null,
          ),
        );
      }, 200);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [description?.id]);

  return (
    <div
      className="work-threads chat-review"
      data-work-threads={item}
      ref={rootRef}
    >
      {api.error ? (
        <p className="work-threads-error" role="alert">
          {api.error}
        </p>
      ) : null}
      {roots.map((shown) => (
        <WorkThreadCard
          key={shown.id}
          api={api}
          item={item}
          shown={shown}
          description={description}
          seen={new Set([shown.id])}
          onLeave={onLeave}
        />
      ))}
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
              onClick={() => {
                api.setPartDraft({
                  thread: selection.thread,
                  comment: selection.comment,
                  quote: selection.quote,
                });
                setSelection(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              Comment
            </button>,
            document.body,
          )
        : null}
    </div>
  );
}

/** A stop of the detail's keys: its place, as the cursor holds it. */
function workStopKey(stop: HTMLElement): string {
  if (stop.dataset.chatStop) return stop.dataset.chatStop;
  const message =
    stop.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  return `q:${message}:${stop.dataset.part}`;
}

/**
 * A thread's message in several parts: each is a stop, after the message
 * itself (one part: the message is the stop). The description's parts
 * are stops as they are.
 */
function partOfLongMessage(stop: HTMLElement): boolean {
  const body = stop.closest<HTMLElement>(".chat-thread-body");
  if (!body) return true;
  return (
    body.querySelectorAll(":scope [data-part]").length -
      body.querySelectorAll(":scope .rc-part-notes [data-part]").length >
    1
  );
}

/** The stops of the detail's j / k, in order: parts, messages, folded lines. */
export function workStops(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLElement>(
      ".chat-review [data-part], [data-chat-stop]",
    ),
  ).filter(
    (stop) =>
      (stop.dataset.chatStop || partOfLongMessage(stop)) &&
      stop.getClientRects().length > 0,
  );
}

/**
 * The chat threads' keys on an item's detail (`list`: its description and
 * threads): j / k through the parts of its comments and the threads'
 * messages, c on a part comments on it (a thread on it, quoting it), on
 * a message answers its thread, r resolves, za folds, n / N thread to
 * thread. `fallback` takes the detail's own keys (s, t, o, dd), and c /
 * r with no stop under the cursor (a new comment, an answer to the last
 * thread).
 */
export function useWorkItemKeys({
  api,
  description,
  getList,
  fallback,
}: {
  api: WorkItemThreadsApi;
  description: ReviewThread | null | undefined;
  getList: () => HTMLElement | null;
  fallback: (key: string) => boolean;
}) {
  const threadsById = useMemo(
    () => new Map(api.threads.map((thread) => [thread.id, thread])),
    [api.threads],
  );
  const goToThread = (id: string, commentId?: string) => {
    const list = getList();
    const element = list?.querySelector<HTMLElement>(
      `.chat-thread[data-thread-id="${CSS.escape(id)}"]`,
    );
    if (!list || !element) return;
    const stop = element.dataset.chatStop
      ? element
      : (commentId &&
          element.querySelector<HTMLElement>(
            `[data-chat-stop="m:${CSS.escape(commentId)}"]`,
          )) ||
        element.querySelector<HTMLElement>("[data-chat-stop]");
    if (stop?.dataset.chatStop) api.setCursor(stop.dataset.chatStop);
    (stop ?? element).scrollIntoView({ block: "center" });
    list.focus({ preventScroll: true });
  };
  const jumpUnresolved = (direction: 1 | -1) => {
    const list = getList();
    if (!list) return;
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>(
        ".chat-thread[data-thread-id]:not(.is-draft)",
      ),
    ).filter((card) => {
      const thread = threadsById.get(card.dataset.threadId ?? "");
      return !!thread && !thread.resolved;
    });
    if (!cards.length) return;
    const here = list
      .querySelector("[data-chat-stop].is-focused, .rc-part.is-focused")
      ?.closest<HTMLElement>(".chat-thread[data-thread-id]");
    const at = here ? cards.indexOf(here) : direction === 1 ? -1 : 0;
    const next = cards[(at + direction + cards.length) % cards.length];
    if (next?.dataset.threadId) goToThread(next.dataset.threadId);
  };
  const draftOpen = () => {
    const draft = getList()?.querySelector<HTMLElement>(
      ".chat-thread.is-draft .cm-content",
    );
    if (draft) draft.focus();
    return !!draft;
  };
  useThreadKeys(getList, undefined, {
    stops: workStops,
    keyOf: workStopKey,
    stopAt: (target) =>
      target.closest<HTMLElement>("[data-chat-stop], [data-part]"),
    cursor: api.cursor,
    setCursor: api.setCursor,
    threadsById,
    flipped: api.flipped,
    openOnly: false,
    toggleFold: api.toggleFold,
    goToThread,
    goToComment: (thread, comment) => goToThread(thread.id, comment),
    openOverview: () => {},
    jumpUnresolved,
    toggleOpenOnly: () => {},
    resolve: (thread) =>
      void api.write("review.resolve", {
        comment_id: thread.id,
        resolved: !thread.resolved,
      }),
    remove: (thread) =>
      void api.write("review.delete", { comment_id: thread.id }),
    reply: (thread) => api.setReplying(thread.id),
    commentFirst: (here, thread) => {
      // A comment being written: back into it.
      if (draftOpen()) return true;
      if (here?.dataset.part === undefined) return false;
      // A part of a comment (the description's too): a thread on it.
      const message =
        here.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
      const owner =
        thread?.id ??
        (here.closest(".work-description") ? description?.id : undefined);
      if (!message || !owner) return false;
      api.setPartDraft({
        thread: owner,
        comment: message,
        quote: partText(here),
      });
      return true;
    },
    comment: () => false,
    otherKey: (key, at) => {
      const inThread = !!at.here?.closest("[data-thread-id]");
      if (key === "c" || key === "Enter") {
        if (at.here) return false;
        return draftOpen() || fallback(key === "Enter" ? "c" : key);
      }
      if ((key === "r" || key === "dd") && inThread) return false;
      return fallback(key);
    },
  });
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
 * The words selected in a comment under `root` (not in a box being
 * written): the thread and comment they are in (a nested thread's own,
 * for words of its messages; the description's thread for its words),
 * and where to offer Comment.
 */
export function selectedWords(
  root: HTMLElement | null,
  description: string | null = null,
): SelectedWords | null {
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
  const body = start.closest<HTMLElement>("[data-message-id]");
  const comment = body?.dataset.messageId;
  const thread =
    body?.closest<HTMLElement>(".chat-thread[data-thread-id]")?.dataset
      .threadId ?? (body?.closest(".work-description") ? description : null);
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
