import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  REVIEW_USER,
  type ReviewComment,
  type ReviewMessagePart,
  type ReviewSnapshot,
  type ReviewThread,
  unheardComments,
} from "../../../shared/review";
import {
  anchorAt,
  anchorDetached,
  anchoredInFile,
  placeInFile,
} from "../../../shared/fileAnchors";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "../review";
import { writeReviewSession } from "../reviewSessionCall";
import {
  cellPlacement,
  markdownSource,
  quoteOccurrence,
  quoteOffset,
  quoteRange,
  renderedWhere,
} from "../renderedSource";
import { markdownSelectionTarget, type SlotWhere } from "./markdown";
import { MrThreadCard } from "./MrThreadCard";
import {
  isMessageStop,
  MessageNotes,
  messagePartsOf,
  messageStopKey,
  OnMessageHead,
  replyOnMessage,
  SelectionOffer,
  splitMessageThreads,
} from "./MessageThreads";
import { type MessageParts, NoteBody } from "./ReviewNoteBody";
import { ThreadCard } from "./ThreadCard";
import { ThreadEditor } from "./ThreadEditor";
import { ThreadsPanel, useOpenOnly } from "./ThreadsPanel";
import type { ThreadKeys } from "./useThreadKeys";
import type { NavPlace } from "../unresolvedThreads";
import { HELD_FOR_SEND, reviewImageMarkdown } from "../workspaceFeedback";

/*
 * The threads on what the Files preview shows: review threads, drawn in the
 * file and listed in the threads panel, like a chat's and a review's.
 */

/** The comments that did not reach the agent, and why (undeliveredComments). */
export type Undelivered = { reason: string; ids: ReadonlySet<string> } | null;

/** What is written on threads, each in its own review. */
export type ThreadWrites = {
  reply: (thread: ReviewThread, text: string, id: string) => Promise<void>;
  resolve: (thread: ReviewThread) => void;
  remove: (thread: ReviewThread) => void;
  /** Rewrites one of your comments (a draft on the forge too). */
  edit?: (
    thread: ReviewThread,
    comment: ReviewComment,
    text: string,
  ) => Promise<void>;
  /** Deletes one comment of a thread (a draft reply on the forge). */
  removeComment?: (thread: ReviewThread, comment: ReviewComment) => void;
  /** Brings a deleted thread back (a forge draft is written again). */
  restore?: (thread: ReviewThread) => Promise<void>;
  /**
   * A thread on a part of a thread's message, quoting it: in that
   * thread's review, its anchor the thread's own.
   */
  addPart?: (
    thread: ReviewThread,
    part: ReviewMessagePart,
    text: string,
    id: string,
  ) => Promise<void>;
  /**
   * Stores an image for a comment in the thread's review; the Markdown
   * for it (its file's path, which the agent reads).
   */
  addImage?: (thread: ReviewThread, file: File) => Promise<string>;
};

export type FileThreadsApi = ThreadWrites & {
  /** The threads drawn on the file (not those on parts of messages). */
  threads: readonly ReviewThread[];
  /** Every thread, those on parts of messages too. */
  all: readonly ReviewThread[];
  /** Threads on parts of a thread's message, by that message. */
  nested: ReadonlyMap<string, ReviewThread[]>;
  /** The review they are in, once there is one. */
  snapshot?: ReviewSnapshot;
  /** The reviews the threads are in: the file's own, the code reviews'. */
  owners: readonly ReviewSnapshot[];
};

/** A review of the checkout's code: a branch, a range, its work, an MR. */
function codeReview(snapshot: ReviewSnapshot): boolean {
  const { kind } = snapshot.session.target;
  return kind === "range" || kind === "worktree" || kind === "mr";
}

/**
 * The code reviews' threads on a file, by its absolute path: what its
 * rendered review shares (`shared`) before it has one.
 */
export function codeReviewThreadsOn(
  sessions: Iterable<ReviewSnapshot>,
  connectionId: string,
  absolute: string,
): ReviewThread[] {
  const found = new Map<string, ReviewThread>();
  for (const snapshot of sessions) {
    const { session } = snapshot;
    const root = session.root.replace(/\/+$/, "");
    if (
      session.connectionId !== connectionId ||
      !codeReview(snapshot) ||
      !absolute.startsWith(`${root}/`)
    )
      continue;
    const path = absolute.slice(root.length + 1);
    for (const thread of snapshot.threads)
      if (thread.anchor.path === path && !found.has(thread.id))
        found.set(thread.id, thread);
  }
  return [...found.values()];
}

/**
 * Where a thread is in the file as it reads now (shared/fileAnchors.ts, as
 * the server moves stored anchors): on its lines while they still read as
 * written and hold its words, else on the lines that do now (it moved, or
 * was reworded), else, as on a removed line (the old side), on no line:
 * listed with the comments, drawn on no line, never on whatever is on its
 * old lines now. One off its lines whose words are back is placed again.
 */
export function placedInSource(
  thread: ReviewThread,
  lines: readonly string[],
): ReviewThread {
  const { anchor } = thread;
  if (!lines.length) return thread;
  const detached = () => ({ ...thread, anchor: anchorDetached(anchor) });
  if (anchor.side === "old")
    return anchor.line === undefined ? thread : detached();
  if (!anchoredInFile(anchor)) return thread;
  const place = placeInFile(anchor, lines);
  if (!place) return anchor.line === undefined ? thread : detached();
  if (place.how === "kept") return thread;
  return { ...thread, anchor: anchorAt(anchor, place) };
}

/**
 * The threads on parts of other threads' messages, by the message, and
 * the others, as a chat draws them.
 */
export function nestThreads(threads: readonly ReviewThread[]): {
  top: ReviewThread[];
  nested: Map<string, ReviewThread[]>;
} {
  const comments = new Set(
    threads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  const nested = new Map<string, ReviewThread[]>();
  const top: ReviewThread[] = [];
  for (const thread of threads) {
    const part = thread.anchor.message;
    if (part && comments.has(part.comment))
      nested.set(part.comment, [...(nested.get(part.comment) ?? []), thread]);
    else top.push(thread);
  }
  return { top, nested };
}

/**
 * A file by its absolute path on the host, or a site by its URL: the
 * threads of its rendered review, with those the checkout's code reviews
 * have on it, each written in its own review. `source`, the file's text,
 * puts each on the line it is on now.
 */
export function useFileThreads(
  connectionId: string,
  file: { absolute?: string; url?: string },
  source?: string | null,
): FileThreadsApi {
  const { sessions } = useReviewState();
  const { absolute, url } = file;
  const snapshot = useMemo(() => {
    for (const each of sessions.values()) {
      const { session } = each;
      if (
        session.connectionId !== connectionId ||
        session.target.kind !== "rendered"
      )
        continue;
      if (url ? session.target.url === url : false) return each;
      if (
        absolute &&
        session.target.path &&
        `${session.root.replace(/\/+$/, "")}/${session.target.path}` ===
          absolute
      )
        return each;
    }
    return undefined;
  }, [sessions, connectionId, absolute, url]);
  const all = useMemo(() => {
    const listed = snapshot
      ? [...snapshot.threads, ...(snapshot.shared ?? [])]
      : absolute
        ? codeReviewThreadsOn(sessions.values(), connectionId, absolute)
        : [];
    const lines = source ? markdownSource(source).split("\n") : [];
    return listed.map((thread) => placedInSource(thread, lines));
  }, [snapshot, sessions, connectionId, absolute, source]);
  const { top, nested } = useMemo(() => nestThreads(all), [all]);
  const owners = useMemo(() => {
    const ids = new Set(all.map((thread) => thread.sessionId));
    if (snapshot) ids.add(snapshot.session.id);
    return [...ids].flatMap((id) => {
      const owner = sessions.get(id);
      return owner ? [owner] : [];
    });
  }, [all, snapshot, sessions]);
  // The file read again and changed (a reload, after "Changed on disk"):
  // each review with threads on it moves them to where their words are
  // now, and keeps that (the agent reads the same lines).
  const read = useRef<{ absolute?: string; source?: string | null }>({});
  useEffect(() => {
    const previous = read.current;
    read.current = { absolute, source };
    if (
      !absolute ||
      !source ||
      previous.absolute !== absolute ||
      !previous.source ||
      previous.source === source
    )
      return;
    for (const owner of owners) {
      const root = owner.session.root.replace(/\/+$/, "");
      if (!absolute.startsWith(`${root}/`)) continue;
      void reviewCall<ReviewSnapshot>(connectionId, "review.reanchor", {
        session_id: owner.session.id,
        path: absolute.slice(root.length + 1),
      })
        .then(rememberReviewSnapshot)
        .catch(() => {});
    }
  }, [connectionId, absolute, owners, source]);
  const writes = useMemo(() => threadWrites(connectionId), [connectionId]);
  return {
    threads: top,
    all,
    nested,
    owners,
    ...(snapshot ? { snapshot } : {}),
    ...writes,
  };
}

/**
 * The comments of some reviews that did not reach their agent, and why,
 * as a chat says it (undeliveredComments); null while nothing failed (an
 * agent busy with a question gets them once it is free, by itself).
 */
export function reviewsUndelivered(
  snapshots: Iterable<ReviewSnapshot | undefined>,
): Undelivered {
  const ids = new Set<string>();
  let reason = "";
  for (const snapshot of snapshots) {
    const error = snapshot?.session.deliveryError;
    if (!snapshot || !error || /agent_blocked/.test(error)) continue;
    const since = snapshot.session.deliveredAt ?? "";
    const before = ids.size;
    for (const thread of snapshot.threads)
      if (!thread.resolved && thread.kind === "discussion")
        for (const comment of unheardComments(thread, since))
          ids.add(comment.id);
    if (ids.size > before && !reason) {
      const agent = snapshot.session.agent.name ?? "the agent";
      reason = /agent_not_found|not[_ ]found/i.test(error)
        ? `${agent.charAt(0).toUpperCase()}${agent.slice(1)} is not running in any pane`
        : error;
    }
  }
  return ids.size ? { reason, ids } : null;
}

/**
 * Answering, resolving and deleting threads of any review of a connection,
 * each in its own review, read back so the change shows at once.
 */
export function threadWrites(connectionId: string): Required<ThreadWrites> {
  const write = (
    thread: ReviewThread,
    method: string,
    params: Record<string, unknown>,
  ) => writeReviewSession(connectionId, thread.sessionId, method, params);
  return {
    reply: (thread, text, id) =>
      write(thread, "review.reply", {
        comment_id: thread.id,
        new_comment_id: id,
        text,
      }),
    resolve: (thread) =>
      void write(thread, "review.resolve", {
        comment_id: thread.id,
        resolved: !thread.resolved,
      }),
    remove: (thread) =>
      void write(thread, "review.delete", { comment_id: thread.id }),
    edit: (thread, comment, text) =>
      write(thread, "review.edit", { comment_id: comment.id, text }),
    removeComment: (thread, comment) =>
      void write(thread, "review.delete", { comment_id: comment.id }),
    restore: (thread) =>
      thread.gitlab
        ? write(thread, "review.thread.add", {
            kind: "draft",
            anchor: thread.anchor,
            text: thread.comments[0]?.body ?? "",
          })
        : write(thread, "review.restore", { thread }),
    addImage: (thread, file) =>
      reviewImageMarkdown(
        (method, params) => reviewCall(connectionId, method, params),
        thread.sessionId,
        file,
      ),
    addPart: (thread, part, text, id) =>
      write(thread, "review.thread.add", {
        kind: "discussion",
        anchor: { ...thread.anchor, message: part },
        new_thread_id: id,
        text,
      }),
  };
}

function snapshotUrl(thread: ReviewThread): string | null {
  const path = thread.anchor.render?.snapshot;
  const match = path
    ? /\/([0-9a-f]{16})\/([0-9a-f]{16}\.(?:png|jpg|gif|webp))$/.exec(path)
    : null;
  return match
    ? `/api/review/image?session=${match[1]}&name=${match[2]}`
    : null;
}

/** The forge of a merge or pull request review's thread: its labels. */
function forgeOf(
  sessions: ReadonlyMap<string, ReviewSnapshot>,
  thread: ReviewThread,
) {
  const target = sessions.get(thread.sessionId)?.session.target;
  return target?.kind === "mr" && /\/pull\/\d+/.test(target.url)
    ? "GitHub"
    : "GitLab";
}

/**
 * One thread, as a chat's are drawn (ThreadCard); a merge request's
 * discussion as MrThreadCard draws it. The parts of its messages take
 * threads of their own (+, words selected, c on a part), as in a chat,
 * drawn under the part they quote.
 */
/**
 * A thread as the review in Changes draws it: its
 * marks and buttons under each message, its own bar, its editors in place.
 */
export type ReviewThreadLook = {
  messageBar: (
    thread: ReviewThread,
    message: ReviewComment,
    index: number,
  ) => ReactNode;
  /** In place of the thread's buttons: the review's, an editor, or none. */
  threadBar: (thread: ReviewThread) => ReactNode;
  /** The agent saying it works on this thread (review_working), or null. */
  working?: (thread: ReviewThread) => ReactNode;
  /** A message being rewritten: its editor, in its place. */
  messageEditor: (
    thread: ReviewThread,
    message: ReviewComment,
  ) => ReactNode | null;
  messageClass: (
    thread: ReviewThread,
    message: ReviewComment,
    index: number,
  ) => string;
  /** A file's lines on the new side, by number: what a suggestion replaces. */
  newLines?: (path: string) => ReadonlyMap<number, string> | undefined;
  /**
   * The editor of a comment on a part of a message (the review's), in place
   * of the plain one; `done` closes it.
   */
  partEditor?: (
    thread: ReviewThread,
    part: ReviewMessagePart,
    done: () => void,
  ) => ReactNode;
  /**
   * A forge discussion (a merge request's review in Changes): found again on
   * today's line, folded by hand (r), its draft reply in the review's editor.
   */
  forge?: {
    /** Found again in today's file: the line it was written on. */
    outdatedLine: (thread: ReviewThread) => number | undefined;
    /** The draft reply's editor (a reply when `comment` is null). */
    editor: (thread: ReviewThread, comment: ReviewComment | null) => ReactNode;
  };
};

export function FileThread({
  thread,
  api,
  view,
  undelivered,
  nested,
  review,
  top = false,
  placeNote,
  onMessage = false,
}: {
  thread: ReviewThread;
  api: ThreadWrites;
  view: FileThreadView;
  undelivered?: Undelivered;
  /** Threads on parts of messages, by the message. */
  nested?: ReadonlyMap<string, ReviewThread[]>;
  review?: ReviewThreadLook;
  /** Listed above the diff, with the review's general comments. */
  top?: boolean;
  /** Said first in the card's head: where it was written, when not drawn there. */
  placeNote?: string;
  /** Drawn under the message it is on (a thread on the whole of it): its head says so. */
  onMessage?: boolean;
}) {
  const { sessions } = useReviewState();
  const close = () => {
    view.setReplying(null);
    view.setEditing(null);
    view.backToKeys();
  };
  if (thread.kind === "merge-request") {
    // In the review: the forge's editor and the review's look.
    const forge = review?.forge;
    const outdatedLine = forge?.outdatedLine(thread);
    const editor = (comment: ReviewComment | null) =>
      forge ? (
        forge.editor(thread, comment)
      ) : !comment ? (
        <ThreadEditor
          placeholder="Draft reply..."
          {...imageStore(api, thread)}
          onLeave={view.backToKeys}
          onClose={close}
          onSave={(text, id) => api.reply(thread, text, id).then(close)}
        />
      ) : api.edit ? (
        <ThreadEditor
          kept={{ text: comment.body }}
          placeholder="Your draft reply..."
          {...imageStore(api, thread)}
          onLeave={view.backToKeys}
          onClose={close}
          onSave={(text) => api.edit!(thread, comment, text).then(close)}
        />
      ) : undefined;
    return (
      <MrThreadCard
        thread={thread}
        forge={forgeOf(sessions, thread)}
        root={sessions.get(thread.sessionId)?.session.root}
        {...(forge
          ? {
              top,
              flipped: view.flipped.has(thread.id),
              newLines: thread.anchor.path
                ? review?.newLines?.(thread.anchor.path)
                : undefined,
            }
          : {})}
        {...(outdatedLine !== undefined ? { outdatedLine } : {})}
        focusedComment={
          view.cursor?.startsWith("m:") ? view.cursor.slice(2) : null
        }
        replying={view.replying === thread.id ? editor(null) : undefined}
        editing={(comment) =>
          view.editing === comment.id ? editor(comment) : undefined
        }
        onDraftReply={() => {
          if (forge) view.setEditing(null);
          view.setReplying(thread.id);
        }}
        onEditReply={(comment) => {
          if (forge) view.setReplying(null);
          view.setEditing(comment.id);
        }}
        onDeleteReply={(comment) => api.removeComment?.(thread, comment)}
      />
    );
  }
  const snapshot = snapshotUrl(thread);
  const held = thread.held !== undefined;
  const moment = thread.anchor.render?.moment;
  const where = thread.anchor.render?.graphic ?? thread.anchor.render?.selector;
  // Your review comment on the forge (a GitLab draft note): rewritten or
  // deleted, not answered there.
  const forgeDraft = thread.gitlab?.draftId !== undefined;
  const first = thread.comments[0];
  // The threads on this thread's messages: on their parts, under the words
  // they quote; on the whole of one, under it after them (Reply on it).
  const canAddPart = !!api.addPart && !forgeDraft;
  const nestedThread = (note: ReviewThread, onWhole = false) => (
    <FileThread
      key={note.id}
      thread={note}
      api={api}
      view={view}
      undelivered={undelivered}
      nested={nested}
      onMessage={onWhole}
      {...(review ? { review } : {})}
    />
  );
  const shownOf = (notes: readonly ReviewThread[]) =>
    notes.filter((note) => !(view.openOnly && note.resolved));
  /** The thread being written on a message of this thread, if any. */
  const draftOn = (comment: string): ReviewMessagePart | null => {
    const draft = view.partDraft;
    return canAddPart &&
      draft?.comment === comment &&
      draft.thread === thread.id
      ? draft
      : null;
  };
  /** Its box: the review's editor in Changes, else the plain one. */
  const draftBox = (draft: ReviewMessagePart, placeholder: string) => {
    const addPart = api.addPart;
    if (!addPart) return null;
    const done = () => {
      view.setPartDraft(null);
      view.backToKeys();
    };
    return review?.partEditor ? (
      review.partEditor(thread, draft, done)
    ) : (
      <div className="chat-thread is-draft">
        <ThreadEditor
          placeholder={placeholder}
          {...imageStore(api, thread)}
          onLeave={view.backToKeys}
          onClose={done}
          onSave={(text, id) => addPart(thread, draft, text, id).then(done)}
        />
      </div>
    );
  };
  const partsOf = (comment: string): MessageParts | undefined => {
    if (!canAddPart) return undefined;
    const draft = draftOn(comment);
    return messagePartsOf({
      key: `q:${comment}`,
      threads: shownOf(splitMessageThreads(nested?.get(comment)).onParts),
      renderThread: (note) => nestedThread(note),
      draft: draft?.quote
        ? { quote: draft.quote, node: draftBox(draft, "Comment...") }
        : null,
      cursor: view.cursor,
      setCursor: view.setCursor,
      onComment: (quote) =>
        view.setPartDraft({
          thread: thread.id,
          comment,
          quote: quote.trim().slice(0, 4000),
        }),
      messageStop: `m:${comment}`,
    });
  };
  /** The threads on the whole of a message, and the one being written. */
  const notesOn = (comment: string) => {
    if (!canAddPart) return null;
    const draft = draftOn(comment);
    return (
      <MessageNotes
        threads={shownOf(splitMessageThreads(nested?.get(comment)).onMessage)}
        renderThread={(note) => nestedThread(note, true)}
        draft={draft && !draft.quote ? draftBox(draft, "Reply...") : null}
      />
    );
  };
  return (
    <ThreadCard
      thread={thread}
      folded={view.folded(thread)}
      cursor={view.cursor}
      onToggleFold={() => view.toggleFold(thread)}
      onReply={() => view.setReplying(thread.id)}
      {...(canAddPart
        ? {
            onReplyMessage: (message: ReviewComment) =>
              view.setPartDraft({ thread: thread.id, comment: message.id }),
          }
        : {})}
      onResolve={() => api.resolve(thread)}
      onDelete={() => api.remove(thread)}
      head={
        <>
          {onMessage ? <OnMessageHead /> : null}
          {placeNote || where || moment ? (
            <div className="chat-thread-count">
              {[placeNote, where, moment ? `paused at ${moment}` : ""]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
          {snapshot ? (
            <img
              className="file-thread-snapshot"
              src={snapshot}
              alt="What was pointed at"
            />
          ) : null}
        </>
      }
      {...(review
        ? {
            messageBar: (message: ReviewComment, index: number) =>
              review.messageBar(thread, message, index),
            messageClass: (message: ReviewComment, index: number) =>
              review.messageClass(thread, message, index),
          }
        : {})}
      authorExtra={(message) =>
        review ? null : held ? (
          <span className="chat-thread-pending"> {HELD_FOR_SEND}</span>
        ) : undelivered?.ids.has(message.id) ? (
          <span className="chat-thread-pending is-failed" role="status">
            Not delivered: {undelivered.reason}
          </span>
        ) : null
      }
      body={(message) =>
        review?.messageEditor(thread, message) ?? (
          // biome-ignore lint/a11y/noStaticElementInteractions: words selected offer a comment
          <div
            onMouseUp={(event) => {
              if (forgeDraft || !api.addPart) return;
              const body =
                event.currentTarget.querySelector<HTMLElement>(".rc-text") ??
                event.currentTarget;
              const target = markdownSelectionTarget(body);
              view.setPartSelection(
                target
                  ? {
                      thread: thread.id,
                      comment: message.id,
                      quote: target.quote,
                      x: target.x,
                      y: target.y,
                    }
                  : null,
              );
            }}
          >
            <NoteBody
              text={message.body}
              path={thread.anchor.path}
              root={sessions.get(thread.sessionId)?.session.root}
              parts={partsOf(message.id)}
              {...(review?.newLines && thread.anchor.path
                ? {
                    newLines: review.newLines(thread.anchor.path),
                    line: thread.anchor.endLine ?? thread.anchor.line,
                  }
                : {})}
            />
            {notesOn(message.id)}
            {view.partSelection?.comment === message.id &&
            view.partSelection.thread === thread.id ? (
              <SelectionOffer
                at={view.partSelection}
                onClick={() => {
                  const { quote } = view.partSelection!;
                  view.setPartSelection(null);
                  window.getSelection()?.removeAllRanges();
                  view.setPartDraft({
                    thread: thread.id,
                    comment: message.id,
                    quote: quote.trim().slice(0, 4000),
                  });
                }}
              />
            ) : null}
          </div>
        )
      }
      footer={
        review ? (
          <>
            {review.working?.(thread) ?? null}
            {review.threadBar(thread) ?? null}
          </>
        ) : held ? null : forgeDraft && first ? (
          view.editing === first.id && api.edit ? (
            <ThreadEditor
              kept={{ text: first.body }}
              placeholder="Your review comment..."
              {...imageStore(api, thread)}
              onLeave={view.backToKeys}
              onClose={close}
              onSave={(text) => api.edit!(thread, first, text).then(close)}
            />
          ) : (
            <div className="chat-thread-bar">
              <span className="chat-thread-count">
                {forgeOf(sessions, thread)} draft
              </span>
              <button type="button" onClick={() => view.setEditing(first.id)}>
                Edit
              </button>
              <button type="button" onClick={() => api.remove(thread)}>
                Delete
              </button>
            </div>
          )
        ) : view.replying === thread.id ? (
          <ThreadEditor
            placeholder="Reply..."
            {...imageStore(api, thread)}
            onLeave={view.backToKeys}
            onClose={close}
            onSave={(text, id) => api.reply(thread, text, id).then(close)}
          />
        ) : undefined
      }
    />
  );
}

/** A thread's comment box takes images, stored in the thread's review. */
export function imageStore(
  api: Pick<ThreadWrites, "addImage">,
  thread: ReviewThread,
): { onAddImage?: (file: File) => Promise<string> } {
  const { addImage } = api;
  return addImage ? { onAddImage: (file) => addImage(thread, file) } : {};
}

/** The narrowest a thread's card is drawn in a table's column. */
export const CELL_CARD_MIN_WIDTH = 240;

/**
 * The threads a slot of a Markdown preview holds (MarkdownPreview's
 * threadsFor): those whose line and quote go to one of its stops, in the
 * chat's palette, grouped by the stop they are on, in the order of their
 * stops (a row's cells by column) and, on a stop, of their quotes. Under a
 * table's row, a cell's threads are in its column, or under the row from
 * there with a pointer at the cell when a card does not fit in it.
 */
export function SlotThreads({
  stops,
  stopOf,
  threads,
  api,
  view,
  undelivered,
  where,
  nested,
  draft,
}: {
  stops: readonly string[];
  stopOf: (line: number, quote?: string) => string | undefined;
  threads: readonly ReviewThread[];
  api: ThreadWrites;
  view: FileThreadView;
  undelivered?: Undelivered;
  where?: SlotWhere;
  /** Threads on parts of messages, by the message. */
  nested?: ReadonlyMap<string, ReviewThread[]>;
  /**
   * A comment being written on a line and words: its box, drawn under
   * their stop after its threads, as wide as they are.
   */
  draft?: { line: number; quote?: string; node: ReactNode };
}) {
  if (!stops.length) return null;
  const groups = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.anchor.line === undefined) continue;
    if (view.openOnly && thread.resolved) continue;
    const stop = stopOf(thread.anchor.line, thread.anchor.render?.quote);
    if (stop === undefined || !stops.includes(stop)) continue;
    groups.set(stop, [...(groups.get(stop) ?? []), thread]);
  }
  const draftStop = draft ? stopOf(draft.line, draft.quote) : undefined;
  if (draftStop !== undefined && stops.includes(draftStop))
    groups.set(draftStop, groups.get(draftStop) ?? []);
  if (!groups.size) return null;
  const at = (stop: string, thread: ReviewThread) => {
    const quote = thread.anchor.render?.quote;
    const offset = quote && where ? where.quoteAt(stop, quote) : -1;
    return offset < 0 ? Number.MAX_SAFE_INTEGER : offset;
  };
  const columns = where?.columns;
  const cards = stops.flatMap((stop) => {
    const under = groups.get(stop);
    if (!under) return [];
    under.sort(
      (a, b) =>
        at(stop, a) - at(stop, b) || a.createdAt.localeCompare(b.createdAt),
    );
    // A table cell's (b:<line>:<column>): in its column, or under the row.
    const column = Number(stop.split(":")[2]);
    const place =
      columns?.length && Number.isInteger(column)
        ? cellPlacement(columns, column, CELL_CARD_MIN_WIDTH)
        : null;
    // In the chat's palette (.chat-review), as a chat's threads are.
    return [
      <div
        key={stop}
        className={`chat-review${place?.under ? " is-under-row" : ""}`}
        data-for-stop={stop}
        style={
          place
            ? ({
                gridColumn: `${place.start + 1} / ${place.end + 1}`,
                "--md-thread-pointer": `${Math.round(place.pointer)}px`,
              } as CSSProperties)
            : undefined
        }
      >
        {under.map((thread) => (
          <FileThread
            key={thread.id}
            thread={thread}
            api={api}
            view={view}
            undelivered={undelivered}
            nested={nested}
          />
        ))}
        {draft && stop === draftStop ? draft.node : null}
      </div>,
    ];
  });
  return columns?.length ? (
    <div
      className="md-thread-grid"
      style={{
        gridTemplateColumns: columns
          .map((each) => `${Math.max(0, Math.round(each.width))}px`)
          .join(" "),
      }}
    >
      {cards}
    </div>
  ) : (
    <>{cards}</>
  );
}

/**
 * The threads of the Files preview drawn on no line: written on the whole
 * file, or whose lines are gone from it (deleted, or reworded past
 * finding), each with the words it was written on, listed above the file
 * as the review in Changes lists its general comments, rather than drawn
 * on whatever is on their old lines now.
 */
export function DetachedFileThreads({
  threads,
  api,
  view,
  undelivered,
  nested,
}: {
  threads: readonly ReviewThread[];
  api: ThreadWrites;
  view: FileThreadView;
  undelivered?: Undelivered;
  /** Threads on parts of messages, by the message. */
  nested?: ReadonlyMap<string, ReviewThread[]>;
}) {
  const shown = threads.filter(
    (thread) =>
      thread.anchor.line === undefined &&
      thread.kind !== "merge-request" &&
      !(view.openOnly && thread.resolved),
  );
  if (!shown.length) return null;
  return (
    <div
      className="diff-review-general file-preview-detached"
      data-testid="file-preview-detached"
    >
      <section className="diff-review-general-part">
        <h3>Comments on the review, or on code not shown here</h3>
        {shown.map((thread) => (
          <div key={thread.id} className="chat-review diff-review-thread">
            <FileThread
              thread={thread}
              api={api}
              view={view}
              undelivered={undelivered}
              nested={nested}
              placeNote={renderedWhere(thread.anchor)}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

/**
 * What the Files preview's threads have open, as a chat's: where j / k
 * are, the threads folded or unfolded by hand (resolved ones start
 * folded), the one answered, and only the unresolved ones shown (gH).
 */
export type FileThreadView = {
  cursor: string | null;
  setCursor: (key: string | null) => void;
  flipped: ReadonlySet<string>;
  /** The threads folded or opened against their default, all at once. */
  setFlipped: (ids: ReadonlySet<string>) => void;
  folded: (thread: ReviewThread) => boolean;
  toggleFold: (thread: ReviewThread) => void;
  unfold: (ids: readonly string[]) => void;
  replying: string | null;
  setReplying: (id: string | null) => void;
  /** A comment being rewritten (a draft on the forge): its id. */
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** A thread being written on a part of a thread's message. */
  partDraft: ReviewMessagePart | null;
  setPartDraft: (part: ReviewMessagePart | null) => void;
  /** Words selected in a thread's message: Comment is offered there. */
  partSelection: PartSelection | null;
  setPartSelection: (selection: PartSelection | null) => void;
  openOnly: boolean;
  setOpenOnly: (on: boolean) => void;
  /** The keys back on the preview, once a box closes. */
  backToKeys: () => void;
};

/** Words selected in a thread's message, and where to offer Comment. */
export type PartSelection = {
  thread: string;
  comment: string;
  quote: string;
  x: number;
  y: number;
};

export function useFileThreadView(
  keysRoot: () => HTMLElement | null,
): FileThreadView {
  const [cursor, setCursor] = useState<string | null>(null);
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [replying, setReplying] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [partDraft, setPartDraft] = useState<ReviewMessagePart | null>(null);
  const [partSelection, setPartSelection] = useState<PartSelection | null>(
    null,
  );
  // The offer goes with the selection.
  useEffect(() => {
    if (!partSelection) return;
    const onChange = () => {
      if (window.getSelection()?.isCollapsed !== false) setPartSelection(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [partSelection]);
  const [openOnly, setOpenOnly] = useOpenOnly();
  const rootRef = useRef(keysRoot);
  rootRef.current = keysRoot;
  const toggleFold = useCallback(
    (thread: ReviewThread) =>
      setFlipped((current) => {
        const next = new Set(current);
        if (!next.delete(thread.id)) next.add(thread.id);
        return next;
      }),
    [],
  );
  const unfold = useCallback(
    (ids: readonly string[]) =>
      setFlipped((current) => {
        const next = new Set(current);
        for (const id of ids) if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const backToKeys = useCallback(
    () =>
      requestAnimationFrame(() =>
        rootRef.current()?.focus({ preventScroll: true }),
      ),
    [],
  );
  return {
    cursor,
    setCursor,
    flipped,
    setFlipped,
    folded: (thread) => thread.resolved !== flipped.has(thread.id),
    toggleFold,
    unfold,
    replying,
    setReplying,
    editing,
    setEditing,
    partDraft,
    setPartDraft,
    partSelection,
    setPartSelection,
    openOnly,
    setOpenOnly,
    backToKeys,
  };
}

/**
 * A stop of a Markdown preview (a block, a list item: b:<line>, a table
 * cell: b:<line>:<column>), as j / k's cursor holds it.
 */
export function fileStopKey(stop: HTMLElement): string {
  // A part of a thread's message (q:<comment>:<part>), as in a chat.
  return messageStopKey(
    stop,
    (block) => block.dataset.stop ?? `b:${block.dataset.line}`,
  );
}

/**
 * The Files preview's stops, in reading order: its blocks, but each list
 * item (nested ones too) and table cell rather than the list or table,
 * and its threads' messages.
 */
export function fileStops(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".md-source-block, .md-source-item, [data-chat-stop], .chat-thread-body [data-part]",
    ),
  ).filter(
    (stop) =>
      // A list or table: its items are the stops; a thread's message in
      // several parts, each part, as in a chat.
      (isMessageStop(stop) ||
        stop.classList.contains("md-source-item") ||
        stop.dataset.stop !== undefined) &&
      stop.getClientRects().length > 0,
  );
}

/**
 * The stop of a Markdown preview a source line is in: the innermost block,
 * list item or table cell whose lines hold it, else the block after it.
 */
export function fileStopForLine(
  root: HTMLElement,
  line: number,
): HTMLElement | null {
  let best: HTMLElement | null = null;
  let after: HTMLElement | null = null;
  for (const stop of fileStops(root)) {
    if (stop.dataset.line === undefined) continue;
    const start = Number(stop.dataset.line);
    const end = Number(stop.dataset.end || start);
    if (start <= line && line <= end) best = stop;
    else if (start > line && !after) after = stop;
  }
  return best ?? after;
}

/**
 * The stop of a Markdown preview a click at `target` is on: its block,
 * list item (the innermost) or table cell.
 */
export function fileStopAt(target: Element): HTMLElement | null {
  return target.closest<HTMLElement>(
    ".md-source-item, .md-source-block[data-stop]",
  );
}

/**
 * What c / Enter on a stop of a Markdown preview comments on: a block's,
 * a list item's (not its nested items') or a table cell's own source
 * lines and words. Null on any other stop.
 */
export function fileStopAnchor(
  stop: HTMLElement,
  maxQuote: number,
): { line: number; endLine?: number; quote: string } | null {
  if (
    !stop.classList.contains("md-source-block") &&
    !stop.classList.contains("md-source-item")
  )
    return null;
  const line = Number(stop.dataset.line);
  const end = Number(stop.dataset.end);
  return {
    line,
    ...(end && end !== line ? { endLine: end } : {}),
    quote: (stop.textContent ?? "").trim().slice(0, maxQuote),
  };
}

/**
 * The threads in the order of the file: by their lines, on a line by
 * where their quotes are on it (a table row's cells by column), then as
 * written.
 */
export function fileThreadOrder(
  threads: readonly ReviewThread[],
  text?: string | null,
): ReviewThread[] {
  const lines = text ? markdownSource(text).split("\n") : [];
  const at = (thread: ReviewThread) => {
    const { line, render } = thread.anchor;
    const source = line === undefined ? undefined : lines[line - 1];
    const offset =
      source !== undefined && render?.quote
        ? quoteOffset(source, render.quote)
        : -1;
    return offset < 0 ? Number.MAX_SAFE_INTEGER : offset;
  };
  return [...threads].sort(
    (a, b) =>
      (a.anchor.line ?? Number.MAX_SAFE_INTEGER) -
        (b.anchor.line ?? Number.MAX_SAFE_INTEGER) ||
      at(a) - at(b) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** The Files preview's thread keys (useThreadKeys), as a chat's. */
export function fileThreadKeys({
  view,
  api,
  threadsById,
  goToThread,
  openOverview,
  jumpUnresolved,
  comment,
}: {
  view: FileThreadView;
  api: Pick<FileThreadsApi, "resolve" | "remove">;
  threadsById: ReadonlyMap<string, ReviewThread>;
  goToThread: (thread: ReviewThread) => void;
  openOverview: () => void;
  jumpUnresolved: (direction: 1 | -1) => void;
  /** c / Enter on a block. */
  comment: (block: HTMLElement) => boolean;
}): ThreadKeys {
  return {
    stops: fileStops,
    stopAt: fileStopAt,
    keyOf: fileStopKey,
    cursor: view.cursor,
    setCursor: view.setCursor,
    threadsById,
    flipped: view.flipped,
    openOnly: view.openOnly,
    toggleFold: view.toggleFold,
    goToThread: (id) => {
      const thread = threadsById.get(id);
      if (thread) goToThread(thread);
    },
    // g;: the comment written last, unfolded and shown, as in the review
    // pane and a chat.
    goToComment: (thread, comment) => {
      if (view.folded(thread)) view.unfold([thread.id]);
      requestAnimationFrame(() => {
        goToThread(thread);
        const stop = document.querySelector<HTMLElement>(
          `[data-chat-stop="m:${CSS.escape(comment)}"]`,
        );
        if (!stop) return;
        view.setCursor(`m:${comment}`);
        stop.scrollIntoView?.({ block: "center" });
      });
    },
    openOverview,
    jumpUnresolved,
    toggleOpenOnly: () => view.setOpenOnly(!view.openOnly),
    resolve: api.resolve,
    remove: api.remove,
    reply: (thread) => view.setReplying(thread.id),
    // R on a thread's message: a thread on the whole of it.
    replyMessage: (here, thread) =>
      replyOnMessage(null, here, thread, view.setPartDraft),
    // c on a part of a thread's message: a thread on it, quoting it.
    commentFirst: (here, thread) => {
      if (here?.dataset.part === undefined || !thread) return false;
      const message =
        here.closest<HTMLElement>(".chat-thread-body")?.dataset.messageId;
      if (!message) return false;
      const add = here.querySelector(":scope > .rc-part-add");
      view.setPartDraft({
        thread: thread.id,
        comment: message,
        quote: (here.textContent ?? "")
          .replace(add?.textContent ?? "", "")
          .trim()
          .slice(0, 4000),
      });
      return true;
    },
    comment,
  };
}

/**
 * The blocks with threads under them, in the comments' color, and the one
 * j / k are on, as a chat marks its parts.
 */
export function useMarkedBlocks(
  element: HTMLElement | null,
  cursor: string | null,
) {
  useLayoutEffect(() => {
    if (!element) return;
    const mark = () => {
      const noted = new Set(
        [
          ...element.querySelectorAll<HTMLElement>(
            ".md-thread-slot [data-for-stop]",
          ),
        ]
          .filter((group) => group.querySelector(".chat-thread"))
          .map((group) => group.dataset.forStop),
      );
      for (const stop of element.querySelectorAll<HTMLElement>(
        ".md-source-block, .md-source-item",
      )) {
        // A list or table is no stop: its items and cells are.
        const own =
          stop.classList.contains("md-source-item") ||
          stop.dataset.stop !== undefined;
        const key = fileStopKey(stop);
        stop.classList.toggle("has-notes", own && noted.has(key));
        stop.classList.toggle("is-focused", own && cursor === key);
      }
    };
    mark();
    // The document drawn anew, its threads drawn or gone: marked again.
    const observer = new MutationObserver(mark);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [element, cursor]);
}

/** The highlight the open threads' quotes are drawn with (markdown.css). */
const QUOTE_HIGHLIGHT = "roamgate-quote";
/** Each preview's quotes: one highlight shows them all. */
const quoteRanges = new Map<object, Range[]>();

function showQuotes() {
  const registry = globalThis.CSS?.highlights;
  if (!registry || typeof Highlight === "undefined") return;
  const ranges = [...quoteRanges.values()].flat();
  if (ranges.length) registry.set(QUOTE_HIGHLIGHT, new Highlight(...ranges));
  else registry.delete(QUOTE_HIGHLIGHT);
}

/**
 * The words the open threads drawn in a Markdown preview quote, highlighted
 * where they are in their stop (with the CSS Custom Highlight API: the
 * document's text is left as it is). A quote said more than once on its stop
 * is found by the line it was written on (`text`: the file's source).
 */
export function useQuoteHighlights(
  element: HTMLElement | null,
  threadsById: ReadonlyMap<string, ReviewThread>,
  text: string | null | undefined,
) {
  useLayoutEffect(() => {
    if (!element) return;
    const key = {};
    const lines = text ? markdownSource(text).split("\n") : [];
    const mark = () => {
      const ranges: Range[] = [];
      for (const card of element.querySelectorAll<HTMLElement>(
        ".md-thread-slot [data-for-stop] .chat-thread[data-thread-id]",
      )) {
        const thread = threadsById.get(card.dataset.threadId ?? "");
        const quote = thread?.anchor.render?.quote;
        if (!thread || thread.resolved || !quote) continue;
        const forStop =
          card.closest<HTMLElement>("[data-for-stop]")?.dataset.forStop;
        const stop = forStop
          ? element.querySelector<HTMLElement>(
              `[data-stop="${CSS.escape(forStop)}"]`,
            )
          : null;
        if (!stop) continue;
        const range = quoteRange(
          stop,
          quote,
          quoteOccurrence(
            lines,
            Number(stop.dataset.line),
            thread.anchor.line ?? 0,
            quote,
          ),
        );
        if (range) ranges.push(range);
      }
      quoteRanges.set(key, ranges);
      showQuotes();
    };
    mark();
    // The document drawn anew, its threads drawn or gone: found again.
    const observer = new MutationObserver(mark);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      quoteRanges.delete(key);
      showQuotes();
    };
  }, [element, threadsById, text]);
}

/** j / k on a thread drawn in the file (its first message, or its folded line). */
export function focusFileThread(
  root: HTMLElement | null,
  thread: ReviewThread,
  setCursor: (key: string | null) => void,
) {
  const element = root?.querySelector<HTMLElement>(
    `.chat-thread[data-thread-id="${CSS.escape(thread.id)}"]`,
  );
  if (!root || !element) return;
  const stop = element.dataset.chatStop
    ? element
    : element.querySelector<HTMLElement>("[data-chat-stop]");
  if (stop?.dataset.chatStop) setCursor(stop.dataset.chatStop);
  (stop ?? element).scrollIntoView({ block: "center" });
  root.focus({ preventScroll: true });
}

/** Where the cursor is among the file's threads: on one, or before one. */
export function fileThreadPlace(
  order: readonly ReviewThread[],
  cursor: string | null,
  cursorThread: string | null,
  direction: 1 | -1,
): NavPlace {
  const index = cursorThread
    ? order.findIndex((thread) => thread.id === cursorThread)
    : -1;
  if (index >= 0) return { index, on: true };
  // On a block: before the first thread on or after its lines.
  if (cursor?.startsWith("b:")) {
    const line = Number(cursor.slice(2).split(":")[0]);
    const at = order.findIndex(
      (thread) => (thread.anchor.line ?? Number.MAX_SAFE_INTEGER) >= line,
    );
    return { index: at < 0 ? order.length : at, on: false };
  }
  return { index: direction === 1 ? 0 : order.length, on: false };
}

/** The threads panel over some threads: open ones first. */
export function ThreadsList({
  threads,
  api,
  onGo,
  onClose,
  className,
  title = "Comments",
  editor,
  whereNote,
}: {
  threads: readonly ReviewThread[];
  /** Said after where a thread is (another view's: its commit). */
  whereNote?: (thread: ReviewThread) => string | undefined;
  api: Pick<FileThreadsApi, "reply" | "resolve" | "addImage">;
  onGo: (thread: ReviewThread) => void;
  onClose: () => void;
  className?: string;
  title?: string;
  /** The reply's editor, in place of the chat's (the review's, in Changes). */
  editor?: (thread: ReviewThread, close: () => void) => ReactNode;
}) {
  const [replying, setReplying] = useState<string | null>(null);
  const { sessions } = useReviewState();
  const byId = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  return (
    <ThreadsPanel
      className={className}
      title={title}
      threads={threads.map((thread) => {
        const where =
          thread.anchor.terminal !== undefined
            ? `Terminal: ${thread.anchor.terminal.title}`
            : renderedWhere(thread.anchor);
        const note = whereNote?.(thread);
        return {
          id: thread.id,
          resolved: thread.resolved,
          where: note ? `${where} (${note})` : where,
          comments: thread.comments.map((comment) => ({
            id: comment.id,
            author: comment.author === REVIEW_USER ? "You" : comment.author,
            body: comment.body,
          })),
          canReply: thread.kind === "discussion",
        };
      })}
      onClose={onClose}
      onGo={(id) => {
        const thread = byId.get(id);
        if (thread) onGo(thread);
      }}
      onResolve={(id) => {
        const thread = byId.get(id);
        if (thread) api.resolve(thread);
      }}
      onReply={setReplying}
      replying={
        replying && byId.has(replying)
          ? {
              id: replying,
              editor: editor ? (
                editor(byId.get(replying)!, () => setReplying(null))
              ) : (
                <ThreadEditor
                  placeholder="Reply..."
                  {...imageStore(api, byId.get(replying)!)}
                  onLeave={() => {}}
                  onClose={() => setReplying(null)}
                  onSave={(text, id) =>
                    api
                      .reply(byId.get(replying)!, text, id)
                      .then(() => setReplying(null))
                  }
                />
              ),
            }
          : null
      }
      renderBody={(thread, body) => {
        const own = byId.get(thread.id);
        return (
          <NoteBody
            text={body}
            path={own?.anchor.path}
            root={own ? sessions.get(own.sessionId)?.session.root : undefined}
          />
        );
      }}
    />
  );
}

/**
 * All the workspace's review threads the agent has (held comments are the
 * list above them), in the workspace's threads panel: open ones first, each
 * going to its review at its place.
 */
export function WorkspaceConversations({
  connectionId,
  workspaceId,
  onGo,
  onClose,
}: {
  connectionId: string;
  workspaceId: string;
  onGo: (thread: ReviewThread, snapshot: ReviewSnapshot) => void;
  /** Closes the panel it is in (Esc, q in the list). */
  onClose: () => void;
}) {
  const { sessions } = useReviewState();
  const found = useMemo(() => {
    const list: { thread: ReviewThread; snapshot: ReviewSnapshot }[] = [];
    for (const snapshot of sessions.values()) {
      if (
        snapshot.session.connectionId !== connectionId ||
        snapshot.session.workspaceId !== workspaceId
      )
        continue;
      for (const thread of snapshot.threads)
        if (thread.held === undefined && thread.kind === "discussion")
          list.push({ thread, snapshot });
    }
    return list.sort((a, b) =>
      b.thread.updatedAt.localeCompare(a.thread.updatedAt),
    );
  }, [sessions, connectionId, workspaceId]);
  const of = (id: string) =>
    found.find((entry) => entry.thread.id === id)?.snapshot;
  const api = threadWrites(connectionId);
  return (
    <div className="annotation-conversations">
      <ThreadsList
        className="annotation-conversations-list"
        title="Conversations"
        threads={found.map((entry) => entry.thread)}
        api={api}
        onGo={(thread) => {
          const snapshot = of(thread.id);
          if (snapshot) onGo(thread, snapshot);
        }}
        onClose={onClose}
      />
    </div>
  );
}
