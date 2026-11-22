import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  REVIEW_USER,
  type ReviewMessagePart,
  type ReviewSession,
  type ReviewSnapshot,
  type ReviewThread,
  WORK_NO_OWNER,
} from "../../../shared/review";
import {
  rememberReviewSnapshot,
  reviewCall,
  useReviewSnapshots,
} from "../review";
import {
  newClientId,
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "../reviewPending";
import { workDescriptionIsDocument } from "../../../shared/work";
import { workCall } from "../work";
import { reviewImageMarkdown } from "../workspaceFeedback";
import {
  ThreadEditor,
  undeliveredComments,
  writeThenReadBack,
} from "./ChatThreads";
import {
  commentOnPart,
  MessageThread,
  type MessageThreadsScope,
  messageStopKey,
  messageStops,
  replyOnMessage,
  SelectionOffer,
  ThreadMessageBody,
  useSelectedWords,
} from "./MessageThreads";
import { useThreadKeys } from "./useThreadKeys";

/**
 * A work item's comments: a review of the item (target `work`), whose
 * threads go to the item's owner session as review comments, answered
 * there in the thread. Read once, then kept by the review pushes; made by
 * the first comment.
 */

/** The item's review, made when it has none yet: its session. */
export async function openWorkItemReview(item: string): Promise<ReviewSession> {
  const answer = await workCall<{ snapshot: ReviewSnapshot | null }>(
    "threads",
    { item, open: true },
  );
  if (!answer?.snapshot)
    throw new Error("the item's thread could not be opened");
  rememberReviewSnapshot(answer.snapshot);
  return answer.snapshot.session;
}

/** A write to the item's review, then read back: every comment's path. */
export function writeWorkItemReview(
  session: Pick<ReviewSession, "id" | "connectionId">,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  return writeThenReadBack(
    (name, args) => reviewCall(session.connectionId, name, args),
    session.id,
    method,
    params,
    rememberReviewSnapshot,
  );
}

/** A new comment on the item itself (the Comment box's): its owner's. */
export function workCommentWrite(
  item: string,
  text: string,
  id: string = newClientId(),
): Omit<PendingWrite, "sessionId" | "at"> {
  return { id, kind: "discussion", anchor: { work: { item } }, text };
}

/**
 * The user's comment on an item from outside its detail (a card's answer
 * or reply): the Comment box's write, the review made first when the item
 * has none. Sent again with the same `id`, the server writes it once.
 */
export async function postWorkItemComment(
  item: string,
  text: string,
  id?: string,
): Promise<void> {
  const session = await openWorkItemReview(item);
  const { method, params } = pendingWriteCall({
    ...workCommentWrite(item, text, id),
    sessionId: session.id,
    at: new Date().toISOString(),
  });
  await writeWorkItemReview(session, method, params);
}

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
  const snapshots = useReviewSnapshots({ work: item });
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
      (sessionId ? snapshots.get(sessionId) : undefined) ??
      [...snapshots.values()].find(
        ({ session }) =>
          session.target?.kind === "work" && session.target.item === item,
      ),
    [snapshots, sessionId, item],
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
    const session = await openWorkItemReview(item);
    setSessionId(session.id);
    return session;
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
        await writeWorkItemReview(await openSession(), method, params);
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

/**
 * The item's threads as the chat's are drawn (MessageThreads): a thread
 * on a part is anchored on the item, its box takes the item's images, a
 * thread's head says where it was written.
 */
export function workThreadsScope(
  api: WorkItemThreadsApi,
  item: string,
  description: ReviewThread | null | undefined,
  onLeave: () => void,
): MessageThreadsScope {
  const byMessage = new Map<string, ReviewThread[]>();
  const drawn = new Set<string>();
  for (const thread of api.threads) {
    for (const comment of thread.comments) drawn.add(comment.id);
    const comment = thread.anchor.message?.comment;
    if (comment)
      byMessage.set(comment, [...(byMessage.get(comment) ?? []), thread]);
  }
  return {
    byMessage,
    cursor: api.cursor,
    setCursor: api.setCursor,
    flipped: api.flipped,
    toggleFold: api.toggleFold,
    replying: api.replying,
    setReplying: api.setReplying,
    partDraft: api.partDraft,
    setPartDraft: api.setPartDraft,
    partAnchor: (part) => ({ work: { item }, message: part }),
    partPlaceholder: "Comment on this part...",
    pendingById: api.pendingById,
    undelivered: api.waiting
      ? {
          ids: api.undelivered,
          text: api.waiting.noOwner
            ? "Waiting for the owner session"
            : `Not delivered: ${api.waiting.reason}`,
        }
      : null,
    write: api.write,
    send: api.send,
    box: () => ({ onAddImage: api.addImage }),
    onLeave,
    head: (thread) => {
      const part = thread.anchor.message;
      if (thread.anchor.work?.quote)
        return (
          <blockquote className="work-thread-quote">
            {thread.anchor.work.quote}
          </blockquote>
        );
      if (thread.id === description?.id)
        return <p className="work-thread-on">On the description</p>;
      // On a comment not drawn (one deleted): on its own, with the words.
      if (part && !drawn.has(part.comment))
        return part.quote ? (
          <blockquote className="work-thread-quote">{part.quote}</blockquote>
        ) : (
          <p className="work-thread-on">On an earlier comment</p>
        );
      return undefined;
    },
  };
}

/**
 * The item's description (the first comment of its description thread),
 * a message in parts as the comments are: the threads on its parts under
 * them, its + in the chat's gutter, Reply under it (a thread on the whole
 * description) and the threads on the whole of it after.
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
  const scope = workThreadsScope(api, item, thread, onLeave);
  // A design doc: its lines are its source's wrapping, its headings and
  // tables read as a document's.
  const document = workDescriptionIsDocument(message.body);
  return (
    <div
      className={`work-description${document ? " is-document" : ""}`}
      aria-label="Description"
    >
      <div className="chat-review" data-message-id={message.id}>
        <ThreadMessageBody
          scope={scope}
          thread={thread}
          message={message}
          single
          actions
          breaks={!document}
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
 * message's parts are (MessageThreads); words selected in a comment offer
 * Comment, a thread quoting them.
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
  const scope = workThreadsScope(api, item, description, onLeave);
  // A thread on a comment is drawn in it; one on a comment not drawn (one
  // deleted), on its own.
  const roots = api.threads.filter((thread) => {
    const parent = thread.anchor.message?.comment;
    return !parent || !drawnIn(api, parent);
  });

  // Words selected in a comment (the description too) offer a thread on
  // it, quoting them.
  const [selection, clearSelection] = useSelectedWords((start) =>
    workWordsLocate(
      rootRef.current?.closest<HTMLElement>("[data-work-keys]") ??
        rootRef.current,
      description?.id ?? null,
    )(start),
  );

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
      {roots.map((shown) => {
        // The description's own thread: its answers, under the description.
        const thread =
          shown.id === description?.id
            ? { ...shown, comments: shown.comments.slice(1) }
            : shown;
        return thread.comments.length ? (
          <MessageThread key={thread.id} thread={thread} scope={scope} />
        ) : null;
      })}
      {composing ? (
        <div className="chat-thread is-draft">
          <ThreadEditor
            placeholder="Comment for the owner session..."
            onAddImage={api.addImage}
            onLeave={onLeave}
            onClose={() => {
              setComposing(false);
              onLeave();
            }}
            onSave={(text, id) =>
              api.send(workCommentWrite(item, text, id)).then((ok) => {
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
      {selection ? (
        <SelectionOffer
          at={selection}
          // Over the board's floating panel.
          className="work-thread-select"
          onClick={() => {
            api.setPartDraft({
              thread: selection.thread,
              comment: selection.comment,
              quote: selection.quote.slice(0, 4000),
            });
            clearSelection();
            window.getSelection()?.removeAllRanges();
          }}
        />
      ) : null}
    </div>
  );
}

/** Whether a comment of the item's threads is drawn (any of them is). */
function drawnIn(api: WorkItemThreadsApi, comment: string): boolean {
  return api.threads.some((thread) =>
    thread.comments.some((each) => each.id === comment),
  );
}

/**
 * Where words selected in the detail are: the thread and comment they are
 * in (a nested thread's own for words of its messages; the description's
 * thread for its words), not in a box being written.
 */
export function workWordsLocate(
  root: HTMLElement | null,
  description: string | null,
): (start: Element) => { thread: string; comment: string } | null {
  return (start) => {
    if (
      !root?.contains(start) ||
      start.closest(".chat-thread-editor, input, textarea")
    )
      return null;
    const body = start.closest<HTMLElement>("[data-message-id]");
    const comment = body?.dataset.messageId;
    const thread =
      body?.closest<HTMLElement>(".chat-thread[data-thread-id]")?.dataset
        .threadId ?? (body?.closest(".work-description") ? description : null);
    return comment && thread ? { thread, comment } : null;
  };
}

/**
 * The chat threads' keys on an item's detail (`list`: its description and
 * threads): j / k through the parts of its comments and the threads'
 * messages, c on a part comments on it (a thread on it, quoting it), on
 * a message answers its thread, R on a message (the description too)
 * answers the whole message, r resolves, za folds, n / N thread to
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
    // The detail does not scroll: the board's body around it does.
    outerScroller: true,
    stops: messageStops,
    keyOf: messageStopKey,
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
    // A part of a comment (the description's too): a thread on it.
    commentFirst: (here, thread) =>
      commentOnPart(getList(), here, thread, api.setPartDraft, (part) =>
        part.closest(".work-description") ? description?.id : undefined,
      ),
    // R on a comment (the description too): a thread on the whole of it.
    replyMessage: (here, thread) =>
      replyOnMessage(getList(), here, thread, api.setPartDraft, (part) =>
        part.closest(".work-description") ? description?.id : undefined,
      ),
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

/** Whether a thread's last word is the user's (for the card's badge). */
export function lastByUser(thread: ReviewThread): boolean {
  return thread.comments[thread.comments.length - 1]?.author === REVIEW_USER;
}
