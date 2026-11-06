import {
  createContext,
  Fragment,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  REVIEW_USER,
  type ReviewChatPart,
  type ReviewMessagePart,
  type ReviewSnapshot,
  type ReviewThread,
  unheardComments,
} from "../../../shared/review";
import { vimKeys } from "../vimKeys";
import { rememberReviewSnapshot, reviewCall, useReviewState } from "../review";
import { looseText } from "../reviewMessageParts";
import {
  newClientId,
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "../reviewPending";
import type { HistoryEntry } from "./agentHistory";
import { lazyWithReload } from "../lazyWithReload";
import { type MessageParts, NoteBody } from "./ReviewNoteBody";
import {
  type PanelThread,
  ThreadsChip,
  ThreadsPanel,
  type ThreadsPanelPlace,
  UnresolvedNav,
  useOpenOnly,
} from "./ThreadsPanel";
import {
  compareKeys,
  type NavPlace,
  stepNotice,
  stepUnresolved,
  unresolvedPosition,
} from "../unresolvedThreads";
import { formatUiDateTime } from "../uiLocale";
import { CHAT_PARTS_EVENT } from "./chatPaging";
import {
  commentOnPart,
  MessageNotes,
  MessageReplyButton,
  messagePartsOf,
  messageStopKey,
  messageStops,
  OnMessageHead,
  replyOnMessage,
  SelectionOffer,
  splitMessageThreads,
  useSelectedWords,
} from "./MessageThreads";
import "./ChatThreads.css";

/**
 * Comment threads on parts of an agent chat's messages: a review of the chat
 * (target `chat`), whose threads the agent gets as it gets review comments
 * and answers in them. Drawn under the part of the message they quote.
 */

type ChatThreads = {
  /** The parts of a message one comments on, and the threads on them. */
  partsFor: (entry: HistoryEntry) => MessageParts;
};

const ChatThreadsContext = createContext<ChatThreads | null>(null);

/** Parts and threads for a message, when the chat has threads. */
export function useChatParts(entry: HistoryEntry): MessageParts | undefined {
  return useContext(ChatThreadsContext)?.partsFor(entry);
}

/**
 * A message Roamgate typed for you to hand review comments (the chat's own
 * threads included) to the agent: shown as one line, the threads being
 * where they are read.
 */
export function reviewDelivery(
  text: string,
): { title: string; count: number } | null {
  const body = text.replace(/^\s*<pasted_content[^>]*>\s*/, "");
  const head = /^\[Roamgate review "([^"\n]*)" \(([^)\n]*)\)\]/.exec(body);
  if (!head) return null;
  const count = body.match(/^- \[[0-9a-f]{8}\]/gm)?.length ?? 0;
  return { title: head[2] === "chat" ? "this chat" : head[1]!, count };
}

/** How a message starts, for the agent to tell which one is meant. */
function excerptOf(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.replace(/[#>*_`[\]-]/g, " ").trim())
      .find(Boolean) ?? "";
  const words = line.replace(/\s+/g, " ");
  return words.length > 80 ? `${words.slice(0, 80)}…` : words;
}

/**
 * A write to a chat's review, then a read-back so what was written shows at
 * once. Only the write says whether it was saved: a read-back that fails
 * must not leave the box open for the same text to be sent again.
 */
export async function writeThenReadBack(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  remember: (snapshot: ReviewSnapshot) => void,
): Promise<void> {
  await call(method, { session_id: sessionId, ...params });
  void call("review.get", { session_id: sessionId }).then(
    (snapshot) => remember(snapshot as ReviewSnapshot),
    () => {},
  );
}

/**
 * What a message reads, compared with what a reader selected of it drawn:
 * no Markdown marks, no link targets, no spaces (a table's cells are read
 * without the bars between them).
 */
function compactText(text: string): string {
  return looseText(
    text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~#>|\\]/g, " "),
  ).replace(/\s+/g, "");
}

/**
 * The message a comment on a part of the chat is on, among those shown:
 * the one of its id, else (the history read another way gives the message
 * another id, a live message became the transcript's) the agent's message
 * written when the comment says, holding its words, else the one holding
 * them nearest that time. Null: not among those shown.
 */
export function chatPartEntry(
  part: ReviewChatPart,
  entries: readonly HistoryEntry[],
  ids: ReadonlySet<string> = new Set(entries.map((entry) => entry.id)),
  texts: Map<HistoryEntry, string> = new Map(),
): string | null {
  if (ids.has(part.entry)) return part.entry;
  const said = entries.filter(
    (entry) =>
      entry.kind === "message" &&
      entry.role === "assistant" &&
      !entry.compact_summary,
  );
  const words = compactText(
    part.quote.split("\n").find((line) => line.trim()) ?? "",
  ).slice(0, 80);
  const textOf = (entry: HistoryEntry) => {
    let text = texts.get(entry);
    if (text === undefined) {
      text = compactText(entry.text);
      texts.set(entry, text);
    }
    return text;
  };
  const holds = (entry: HistoryEntry) =>
    words ? textOf(entry).includes(words) : false;
  if (part.at) {
    const then = said.filter((entry) => entry.sent_at === part.at);
    const found =
      then.find(holds) ??
      (then.length === 1 || (part.excerpt && !words)
        ? then.find(
            (entry) => !part.excerpt || excerptOf(entry.text) === part.excerpt,
          )
        : undefined);
    if (found) return found.id;
  }
  const holding = said.filter(holds);
  if (!holding.length) return null;
  const at = part.at ? Date.parse(part.at) : Number.NaN;
  if (Number.isNaN(at)) return holding[holding.length - 1]!.id;
  const distance = (entry: HistoryEntry) => {
    const time = entry.sent_at ? Date.parse(entry.sent_at) : Number.NaN;
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : Math.abs(time - at);
  };
  return holding.reduce((best, entry) =>
    distance(entry) < distance(best) ? entry : best,
  ).id;
}

/**
 * The comments that did not reach the chat's agent, and why in plain
 * words; null while nothing failed (an agent busy with a question in its
 * pane gets them once it is free, by itself).
 */
export function undeliveredComments(
  snapshot: ReviewSnapshot | undefined,
  agent: string,
): { reason: string; ids: Set<string> } | null {
  const error = snapshot?.session.deliveryError;
  if (!snapshot || !error || /agent_blocked/.test(error)) return null;
  const since = snapshot.session.deliveredAt ?? "";
  const ids = new Set(
    snapshot.threads
      .filter((thread) => !thread.resolved && thread.kind === "discussion")
      .flatMap((thread) => unheardComments(thread, since))
      .map((comment) => comment.id),
  );
  if (!ids.size) return null;
  const name = agent.charAt(0).toUpperCase() + agent.slice(1);
  return {
    reason: /agent_not_found|not[_ ]found/i.test(error)
      ? `${name} for this chat is not running in any pane`
      : error,
    ids,
  };
}

/**
 * Where a chat's threads are drawn: under the message they are on, by its
 * id; `away`, those whose message is not among those shown (older than
 * them, or no longer in the chat), and the threads on those threads'
 * messages, which the panel lists so none is out of reach.
 */
export type ChatThreadPlaces = {
  byEntry: Map<string, ReviewThread[]>;
  away: Set<string>;
};

export function placeChatThreads(
  threads: readonly ReviewThread[],
  entries: readonly HistoryEntry[] | undefined,
): ChatThreadPlaces {
  const byEntry = new Map<string, ReviewThread[]>();
  const away = new Set<string>();
  const ids = entries ? new Set(entries.map((entry) => entry.id)) : null;
  const texts = new Map<HistoryEntry, string>();
  for (const thread of threads) {
    const part = thread.anchor.chat;
    if (!part) continue;
    const entry =
      entries && ids ? chatPartEntry(part, entries, ids, texts) : part.entry;
    if (entry) byEntry.set(entry, [...(byEntry.get(entry) ?? []), thread]);
    else away.add(thread.id);
  }
  // A thread on a thread's message is where that thread is.
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const isAway = (thread: ReviewThread, seen: Set<string>): boolean => {
    if (away.has(thread.id)) return true;
    const parent = thread.anchor.message?.thread;
    if (!parent || seen.has(thread.id)) return false;
    seen.add(thread.id);
    const holder = byId.get(parent);
    return !holder || isAway(holder, seen);
  };
  for (const thread of threads)
    if (thread.anchor.message && isAway(thread, new Set())) away.add(thread.id);
  return { byEntry, away };
}

/** Whether two placements put the same threads in the same places. */
export function samePlaces(a: ChatThreadPlaces, b: ChatThreadPlaces): boolean {
  if (a.away.size !== b.away.size || a.byEntry.size !== b.byEntry.size)
    return false;
  for (const id of a.away) if (!b.away.has(id)) return false;
  for (const [entry, threads] of a.byEntry) {
    const others = b.byEntry.get(entry);
    if (
      !others ||
      others.length !== threads.length ||
      others.some((thread, index) => thread !== threads[index])
    )
      return false;
  }
  return true;
}

/** Older messages read on demand, to go to a comment on one of them. */
export type OlderMessages = {
  /** Reads the page before those shown. */
  load: () => void;
  loading: boolean;
  /** Whether there are older ones to read. */
  more: boolean;
};

/** Pages read at most to find a comment's message before giving up. */
const SEEK_PAGES = 40;

// The editor is loaded with the first comment box, not with the chat.
const ReviewCommentEditor = lazyWithReload("review-comment-editor", () =>
  import("./ReviewCommentEditor").then((module) => ({
    default: module.ReviewCommentEditor,
  })),
);

/**
 * A comment box: Cmd+Enter or :w saves, Esc on an empty one closes. A save
 * is sent once: until it is answered (the box closes, or stays to try
 * again), Send says so and further saves are ignored. Each text goes with
 * an id made for it; sent again unchanged, the same id, so the server
 * writes it once.
 */
export function ThreadEditor({
  placeholder,
  onSave,
  onClose,
  onLeave,
  kept,
  autoFocus = true,
}: {
  placeholder: string;
  /** Sends the text with its id; settles once it is saved or failed. */
  onSave: (text: string, id: string) => Promise<unknown>;
  /** Closed: with the id of the text last sent, if any. */
  onClose: (id?: string) => void;
  /** Esc with words written: they stay, the keys go back to the chat. */
  onLeave: () => void;
  /**
   * Where its words (and the id they were sent with) are kept as they
   * change: the box drawn again, after the chat was not shown, has them.
   */
  kept?: ThreadBox;
  /** Takes the focus when drawn: not a box drawn again. */
  autoFocus?: boolean;
}) {
  const text = useRef(kept?.text ?? "");
  const [initial] = useState(() => kept?.text ?? "");
  const [vim] = useState(vimKeys);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const sent = useRef<{ text: string; id: string } | null>(kept?.sent ?? null);
  const close = () => onClose(sent.current?.id);
  const save = () => {
    if (sending.current || !text.current.trim()) return;
    sending.current = true;
    setBusy(true);
    const value = text.current;
    if (sent.current?.text !== value) {
      sent.current = { text: value, id: newClientId() };
      if (kept) kept.sent = sent.current;
    }
    void onSave(value, sent.current.id).finally(() => {
      sending.current = false;
      setBusy(false);
    });
  };
  return (
    <div className="chat-thread-editor">
      <Suspense fallback={null}>
        <ReviewCommentEditor
          value={initial}
          vimMode={vim}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(value) => {
            text.current = value;
            if (kept) kept.text = value;
          }}
          onCommit={(explicit) => {
            if (explicit && text.current.trim()) save();
            // Leaving a box with words in it keeps them.
            else if (!text.current.trim()) close();
            else if (!explicit) onLeave();
          }}
          onCancel={close}
          onSuggest={() => {}}
        />
      </Suspense>
      <div className="chat-thread-bar">
        <span className="chat-thread-hint">Cmd+Enter sends</span>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={busy}
          aria-busy={busy}
          onClick={save}
        >
          {busy ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}

/** A comment box's words, and the id they were last sent with. */
export type ThreadBox = { text: string; sent?: { text: string; id: string } };

/**
 * What a chat's threads have open: the comments on their way, the boxes
 * open, where j / k are, the threads folded or unfolded by hand, the
 * comments' panel.
 */
type ThreadsView = {
  pendingWrites: PendingWrite[];
  draft: ReviewChatPart | null;
  partDraft: ReviewMessagePart | null;
  replying: string | null;
  panelReply: string | null;
  cursor: string | null;
  flipped: ReadonlySet<string>;
  overviewOpen: boolean;
};

type ThreadsKeep = {
  get: () => ThreadsView;
  set: (change: (view: ThreadsView) => Partial<ThreadsView>) => void;
  subscribe: (listener: () => void) => () => void;
  /** The open boxes' words, by box (boxKeys): written as they are typed. */
  boxes: Map<string, ThreadBox>;
  /** Where the comments' panel is, while it is open. */
  panel: ThreadsPanelPlace | null;
};

// The key a box's words are kept under: what it comments on or answers.
const draftBox = (part: ReviewChatPart) => `draft:${part.entry}\0${part.quote}`;
const partBox = (part: ReviewMessagePart) =>
  `part:${part.comment}\0${part.quote ?? ""}`;
const replyBox = (thread: string) => `reply:${thread}`;
const panelBox = (thread: string) => `panel:${thread}`;

/** The boxes a view has open. */
function boxKeys(view: ThreadsView): string[] {
  const keys: string[] = [];
  if (view.draft) keys.push(draftBox(view.draft));
  if (view.partDraft) keys.push(partBox(view.partDraft));
  if (view.replying) keys.push(replyBox(view.replying));
  if (view.panelReply) keys.push(panelBox(view.panelReply));
  return keys;
}

function threadsKeep(): ThreadsKeep {
  let view: ThreadsView = {
    pendingWrites: [],
    draft: null,
    partDraft: null,
    replying: null,
    panelReply: null,
    cursor: null,
    flipped: new Set(),
    overviewOpen: false,
  };
  const listeners = new Set<() => void>();
  const keep: ThreadsKeep = {
    get: () => view,
    set: (change) => {
      const next = { ...view, ...change(view) };
      if (
        Object.keys(next).every((name) => {
          const field = name as keyof ThreadsView;
          return next[field] === view[field];
        })
      )
        return;
      view = next;
      // A box closed (or another opened in its place) lets its words go.
      const open = new Set(boxKeys(view));
      for (const key of keep.boxes.keys())
        if (!open.has(key)) keep.boxes.delete(key);
      if (!view.overviewOpen) keep.panel = null;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    boxes: new Map(),
    panel: null,
  };
  return keep;
}

// Kept in memory only: the boxes hold whatever was typed. Recent chats
// first; the least recently shown go.
const keptThreads = new Map<string, ThreadsKeep>();
const MAX_KEPT_THREADS = 50;

function keptThreadsFor(key: string): ThreadsKeep {
  const keep = keptThreads.get(key) ?? threadsKeep();
  keptThreads.delete(key);
  keptThreads.set(key, keep);
  while (keptThreads.size > MAX_KEPT_THREADS) {
    const oldest = keptThreads.keys().next().value;
    if (oldest === undefined) break;
    keptThreads.delete(oldest);
  }
  return keep;
}

type ChatThreadsProps = {
  connectionId: string;
  workspaceId: string;
  /** The chat: its agent session. */
  chat: string;
  /** The agent's directory. */
  path: string;
  agent: string;
  paneId: string;
  /**
   * The messages shown: a comment whose message id changed is put on its
   * message by its words; one whose message is not shown is listed apart.
   */
  entries?: readonly HistoryEntry[];
  /** Older messages, read to go to a comment on one of them. */
  older?: OlderMessages;
  /**
   * What the threads have open (a reply being written, the threads
   * unfolded, the comments' panel) is kept while the chat is not shown,
   * per connection, pane and chat, and comes back with it.
   */
  keep?: boolean;
  children: ReactNode;
};

export function ChatThreadsProvider(props: ChatThreadsProps) {
  // Another chat (a new session) starts with nothing open.
  const keepKey = props.keep
    ? JSON.stringify([props.connectionId, props.paneId, props.chat])
    : null;
  return <ChatThreadsScope key={keepKey ?? ""} {...props} keepKey={keepKey} />;
}

/** A field of the threads' view, set as with useState. */
function useKeptField<K extends keyof ThreadsView>(
  keep: ThreadsKeep,
  field: K,
): (
  change: ThreadsView[K] | ((current: ThreadsView[K]) => ThreadsView[K]),
) => void {
  return useCallback(
    (change) =>
      keep.set(
        (view) =>
          ({
            [field]:
              typeof change === "function"
                ? (change as (current: ThreadsView[K]) => ThreadsView[K])(
                    view[field],
                  )
                : change,
          }) as Partial<ThreadsView>,
      ),
    [keep, field],
  );
}

function ChatThreadsScope({
  connectionId,
  workspaceId,
  chat,
  path,
  agent,
  paneId,
  entries: shownEntries,
  older,
  keepKey,
  children,
}: ChatThreadsProps & { keepKey: string | null }) {
  // What its threads have open: kept for the chat, or for this view only.
  const [keep] = useState(() =>
    keepKey ? keptThreadsFor(keepKey) : threadsKeep(),
  );
  const view = useSyncExternalStore(keep.subscribe, keep.get);
  // The boxes open when the chat is drawn again do not take the focus:
  // the message box has it, and the place the reader was is kept.
  const [restored] = useState(() => new Set(boxKeys(keep.get())));
  for (const key of restored)
    if (!boxKeys(view).includes(key)) restored.delete(key);
  /** A box's kept words, and whether it takes the focus when drawn. */
  const boxOf = (key: string) => {
    let box = keep.boxes.get(key);
    if (!box) {
      box = { text: "" };
      keep.boxes.set(key, box);
    }
    return { kept: box, autoFocus: !restored.has(key) };
  };
  const reviews = useReviewState();
  const snapshot = useMemo(
    () =>
      [...reviews.sessions.values()].find(
        ({ session }) =>
          session.connectionId === connectionId &&
          session.target.kind === "chat" &&
          session.target.chat === chat,
      ),
    [reviews.sessions, connectionId, chat],
  );
  /**
   * Comments on their way: shown at once in their thread, pending, until
   * the review sent back has them; failed, marked so while the box keeps
   * the text to send again.
   */
  const pendingWrites = view.pendingWrites;
  const setPendingWrites = useKeptField(keep, "pendingWrites");
  const shownThreads = useMemo(
    () => withPendingWrites(snapshot?.threads ?? [], pendingWrites),
    [snapshot, pendingWrites],
  );
  const pendingById = useMemo(
    () => new Map(pendingWrites.map((write) => [write.id, write])),
    [pendingWrites],
  );
  /** Your comments the agent did not get, said on each with a Retry. */
  const undelivered = useMemo(
    () => undeliveredComments(snapshot, agent),
    [snapshot, agent],
  );
  useEffect(() => {
    const landed = snapshot?.threads ?? [];
    setPendingWrites((writes) => {
      const left = writes.filter((write) => !writeLanded(landed, write));
      return left.length === writes.length ? writes : left;
    });
  }, [snapshot, setPendingWrites]);
  /** A box closed: what it failed to send is no longer shown. */
  const dropFailed = (id?: string) =>
    setPendingWrites((writes) =>
      writes.filter((write) => write.id !== id || !write.error),
    );
  // Kept as it was while the threads land where they were: messages read
  // or added (a page of older ones) do not draw every message again.
  const placedRef = useRef<ChatThreadPlaces | null>(null);
  const placed = useMemo(() => {
    const next = placeChatThreads(shownThreads, shownEntries);
    const before = placedRef.current;
    return before && samePlaces(before, next) ? before : next;
  }, [shownThreads, shownEntries]);
  placedRef.current = placed;
  const { byEntry, away } = placed;
  const draft = view.draft;
  const setDraft = useKeptField(keep, "draft");
  // Threads on parts of the threads' own messages, by the message, and the
  // one being written.
  const byMessage = useMemo(() => {
    const threads = new Map<string, ReviewThread[]>();
    for (const thread of shownThreads) {
      const comment = thread.anchor.message?.comment;
      if (comment)
        threads.set(comment, [...(threads.get(comment) ?? []), thread]);
    }
    return threads;
  }, [shownThreads]);
  const partDraft = view.partDraft;
  const setPartDraft = useKeptField(keep, "partDraft");
  /**
   * Where j / k are: a part of a message (`p:ENTRY:PART`), a message of a
   * thread (`m:COMMENT`) or a folded thread (`t:THREAD`).
   */
  const cursor = view.cursor;
  const setCursor = useKeptField(keep, "cursor");
  /** Threads folded or unfolded by hand: resolved ones start folded. */
  const flipped = view.flipped;
  const setFlipped = useKeptField(keep, "flipped");
  /** Only the unresolved threads drawn (gH): the review's choice too. */
  const [openOnly, setOpenOnly] = useOpenOnly();
  /**
   * Resolved threads left out while only the unresolved ones are shown:
   * all of them but those holding an unresolved one on a part of their
   * messages.
   */
  const hidden = useMemo(() => {
    const left = new Set<string>();
    if (!openOnly) return left;
    const holdsOpen = (thread: ReviewThread, seen: Set<string>): boolean =>
      thread.comments.some((comment) =>
        (byMessage.get(comment.id) ?? []).some(
          (note) =>
            !seen.has(note.id) &&
            (seen.add(note.id), !note.resolved || holdsOpen(note, seen)),
        ),
      );
    for (const thread of shownThreads)
      if (thread.resolved && !holdsOpen(thread, new Set([thread.id])))
        left.add(thread.id);
    return left;
  }, [openOnly, shownThreads, byMessage]);
  const replying = view.replying;
  const setReplying = useKeptField(keep, "replying");
  const [error, setError] = useState("");
  const entries = useRef(new Map<string, HistoryEntry>());

  const sessionId = useRef<string | null>(null);
  sessionId.current = snapshot?.session.id ?? null;
  /** Writes, then reads the review back so what you wrote shows at once. */
  const write = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError("");
      try {
        let id = sessionId.current;
        if (!id) {
          const opened = await reviewCall<ReviewSnapshot>(
            connectionId,
            "review.open",
            {
              workspace_id: workspaceId,
              path,
              target: { kind: "chat", chat },
              title: `Chat with ${agent}`,
              agent,
              agent_pane: paneId,
            },
          );
          rememberReviewSnapshot(opened);
          id = opened.session.id;
        }
        await writeThenReadBack(
          (name, args) => reviewCall(connectionId, name, args),
          id,
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
    [connectionId, workspaceId, path, chat, agent, paneId],
  );

  /** Sends a comment with its id, shown at once as pending. */
  const send = useCallback(
    async (next: Omit<PendingWrite, "sessionId" | "at">) => {
      const pending: PendingWrite = {
        ...next,
        sessionId: sessionId.current ?? "",
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
    [write, setPendingWrites],
  );

  const comment = useCallback(
    (entry: HistoryEntry, quote: string) => {
      setDraft({
        entry: entry.id,
        quote: quote.trim().slice(0, 4000),
        ...(entry.sent_at ? { at: entry.sent_at } : {}),
        excerpt: excerptOf(entry.text),
      });
      window.getSelection()?.removeAllRanges();
    },
    [setDraft],
  );

  /**
   * A comment box closed (sent or not): the keys go back to the
   * conversation, where the cursor still is.
   */
  const backToConversation = () =>
    requestAnimationFrame(() =>
      scopeRef.current
        ?.querySelector<HTMLElement>(".agent-history-chat")
        ?.focus({ preventScroll: true }),
    );

  const toggleFold = (thread: ReviewThread) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });

  /**
   * A thread drawn where it is; `onMessage`: drawn under the message it is
   * on (Reply on it), its head says so.
   */
  const renderThread = (thread: ReviewThread, onMessage = false): ReactNode => {
    const folded = thread.resolved !== flipped.has(thread.id);
    const first = thread.comments[0];
    if (folded)
      return (
        <button
          type="button"
          className={`chat-thread is-folded${cursor === `t:${thread.id}` ? " is-focused" : ""}`}
          data-thread-id={thread.id}
          data-chat-stop={`t:${thread.id}`}
          onClick={() => toggleFold(thread)}
          title="Unfold"
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
        className={`chat-thread${thread.resolved ? " is-resolved" : ""}`}
        data-thread-id={thread.id}
      >
        {onMessage ? <OnMessageHead /> : null}
        {thread.comments.map((message, index) => {
          const pending =
            pendingById.get(message.id) ??
            (index === 0 ? pendingById.get(thread.id) : undefined);
          return (
            <div
              key={message.id}
              className={`chat-thread-message${message.author === REVIEW_USER ? "" : " from-agent"}${cursor === `m:${message.id}` ? " is-focused" : ""}${pending ? " is-pending" : ""}`}
              data-chat-stop={`m:${message.id}`}
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
                  ) : undelivered?.ids.has(message.id) ? (
                    <>
                      <span
                        className="chat-thread-pending is-failed"
                        role="status"
                      >
                        Not delivered: {undelivered.reason}
                      </span>
                      <button
                        type="button"
                        className="chat-thread-retry"
                        onClick={() => void write("review.retry", {})}
                      >
                        Retry
                      </button>
                    </>
                  ) : null}
                </span>
                <MessageReplyButton
                  onClick={() =>
                    setPartDraft({ thread: thread.id, comment: message.id })
                  }
                />
              </div>
              {/* Its parts take comments too, drawn under them. */}
              <div className="chat-thread-body" data-message-id={message.id}>
                <NoteBody
                  text={message.body}
                  parts={messageParts(thread, message.id)}
                />
                <MessageNotes
                  threads={
                    splitMessageThreads(byMessage.get(message.id)).onMessage
                  }
                  hidden={hidden}
                  renderThread={(nested) => (
                    <Fragment key={nested.id}>
                      {renderThread(nested, true)}
                    </Fragment>
                  )}
                  draft={
                    partDraft?.comment === message.id && !partDraft.quote
                      ? partEditor(partDraft, "Reply...")
                      : null
                  }
                />
              </div>
            </div>
          );
        })}
        {pendingById.has(thread.id) ? null : replying === thread.id ? (
          <ThreadEditor
            {...boxOf(replyBox(thread.id))}
            placeholder="Reply..."
            onLeave={backToConversation}
            onClose={(id) => {
              dropFailed(id);
              setReplying(null);
              backToConversation();
            }}
            onSave={(text, id) =>
              send({
                id,
                replyTo: thread.id,
                kind: thread.kind,
                anchor: thread.anchor,
                text,
              }).then((ok) => {
                if (!ok) return;
                setReplying(null);
                backToConversation();
              })
            }
          />
        ) : (
          <div className="chat-thread-bar">
            <button type="button" onClick={() => setReplying(thread.id)}>
              Reply
            </button>
            <button
              type="button"
              onClick={() =>
                void write("review.resolve", {
                  comment_id: thread.id,
                  resolved: !thread.resolved,
                })
              }
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
            <button type="button" onClick={() => toggleFold(thread)}>
              Fold
            </button>
            {thread.comments.length === 1 && first?.author === REVIEW_USER ? (
              <button
                type="button"
                onClick={() =>
                  void write("review.delete", { comment_id: thread.id })
                }
              >
                Delete
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  /**
   * The box of a thread being written on a part of a thread's message, or
   * on the whole of it (Reply on it, `placeholder` says so).
   */
  const partEditor = (
    part: ReviewMessagePart,
    placeholder = `Comment for ${agent}...`,
  ) => (
    <div className="chat-thread is-draft">
      <ThreadEditor
        {...boxOf(partBox(part))}
        placeholder={placeholder}
        onLeave={backToConversation}
        onClose={(id) => {
          dropFailed(id);
          setPartDraft(null);
          backToConversation();
        }}
        onSave={(text, id) =>
          send({
            id,
            kind: "discussion",
            anchor: { message: part },
            text,
          }).then((ok) => {
            if (!ok) return;
            setPartDraft(null);
            backToConversation();
          })
        }
      />
    </div>
  );

  /**
   * The parts of a thread's message, and the threads on them (those on
   * the whole message are drawn after it).
   */
  const messageParts = (thread: ReviewThread, comment: string): MessageParts =>
    messagePartsOf({
      key: `q:${comment}`,
      threads: splitMessageThreads(byMessage.get(comment)).onParts,
      hidden,
      renderThread,
      draft:
        partDraft?.comment === comment && partDraft.quote
          ? { quote: partDraft.quote, node: partEditor(partDraft) }
          : null,
      cursor,
      setCursor,
      onComment: (quote) =>
        setPartDraft({
          thread: thread.id,
          comment,
          quote: quote.trim().slice(0, 4000),
        }),
      messageStop: `m:${comment}`,
    });

  const partsFor = (entry: HistoryEntry): MessageParts => {
    entries.current.set(entry.id, entry);
    return messagePartsOf({
      key: `p:${entry.id}`,
      threads: byEntry.get(entry.id),
      hidden,
      renderThread,
      draft:
        draft?.entry === entry.id
          ? {
              quote: draft.quote,
              node: (
                <div className="chat-thread is-draft">
                  <ThreadEditor
                    {...boxOf(draftBox(draft))}
                    placeholder={`Comment for ${agent}...`}
                    onLeave={backToConversation}
                    onClose={(id) => {
                      dropFailed(id);
                      setDraft(null);
                      backToConversation();
                    }}
                    onSave={(text, id) =>
                      send({
                        id,
                        kind: "discussion",
                        anchor: { chat: draft },
                        text,
                      }).then((ok) => {
                        if (!ok) return;
                        setDraft(null);
                        backToConversation();
                      })
                    }
                  />
                </div>
              ),
            }
          : null,
      cursor,
      setCursor,
      onComment: (quote) => comment(entry, quote),
      single: true,
    });
  };

  // The keys: from the message box (k on its first line in normal mode, or
  // Alt+Up) into the conversation. There j / k step through the parts of
  // the agent's messages and the threads under them; c comments on a part
  // (or answers a thread), r resolves, za folds, zz / zt / zb place, and i
  // or Esc go back to the box.
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const threadsById = useMemo(
    () => new Map((snapshot?.threads ?? []).map((t) => [t.id, t])),
    [snapshot],
  );
  const flippedRef = useRef(flipped);
  flippedRef.current = flipped;
  // The chat's comments, open ones first, then the latest message.
  const overview = useMemo(
    () =>
      [...(snapshot?.threads ?? [])]
        .filter((thread) => thread.anchor.chat || thread.anchor.message)
        .map((thread) => ({
          thread,
          last: thread.comments.reduce(
            (latest, c) => (c.updatedAt > latest ? c.updatedAt : latest),
            thread.createdAt,
          ),
        }))
        .sort(
          (a, b) =>
            Number(a.thread.resolved) - Number(b.thread.resolved) ||
            b.last.localeCompare(a.last),
        )
        .map(({ thread }) => thread),
    [snapshot],
  );
  const overviewOpen = view.overviewOpen;
  const setOverviewOpen = useKeptField(keep, "overviewOpen");
  /** The threads open whose message is not shown. */
  const awayOpen = useMemo(
    () => overview.filter((thread) => !thread.resolved && away.has(thread.id)),
    [overview, away],
  );
  const awayWhere = older?.more
    ? "its message is older than those shown: Go to it reads them"
    : "its message is not in the chat shown";
  /** The thread answered from the panel. */
  const panelReply = view.panelReply;
  const setPanelReply = useKeptField(keep, "panelReply");
  const panelThreads = useMemo<PanelThread[]>(
    () =>
      overview.map((thread) => {
        const part = thread.anchor.chat;
        const nested = thread.anchor.message;
        const last = thread.comments[thread.comments.length - 1];
        return {
          id: thread.id,
          resolved: thread.resolved,
          where: ((part ?? nested)?.quote ?? "").split("\n")[0] ?? "",
          meta: `${
            nested
              ? "On a message of a thread"
              : `On ${agent}'s message${part?.at ? ` of ${new Date(part.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${part?.excerpt ? `: ${part.excerpt}` : ""}`
          }${away.has(thread.id) ? ` (${awayWhere})` : ""}`,
          when: last ? formatUiDateTime(last.updatedAt) : undefined,
          comments: thread.comments.map((comment) => ({
            id: comment.id,
            author: comment.author === REVIEW_USER ? "You" : comment.author,
            body: comment.body,
          })),
          canReply: true,
        };
      }),
    [overview, agent, away, awayWhere],
  );
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  // The chat's frame, found again whenever it is drawn anew (an empty chat,
  // a reload of its history).
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope) return;
    const find = () =>
      setFrame(
        scope.querySelector<HTMLElement>(".agent-history-chat-frame") ?? null,
      );
    find();
    const observer = new MutationObserver(find);
    observer.observe(scope, { childList: true });
    return () => observer.disconnect();
  }, []);
  /** Puts j / k on a thread (its first message, or its folded line). */
  const goToThread = useCallback(
    (id: string, commentId?: string) => {
      const list = scopeRef.current?.querySelector<HTMLElement>(
        ".agent-history-chat",
      );
      const element = list?.querySelector<HTMLElement>(
        `.chat-thread[data-thread-id="${CSS.escape(id)}"]`,
      );
      if (!list || !element) return false;
      // A comment of an open thread, else its first one (or its folded line).
      const stop = element.dataset.chatStop
        ? element
        : (commentId &&
            element.querySelector<HTMLElement>(
              `[data-chat-stop="m:${CSS.escape(commentId)}"]`,
            )) ||
          element.querySelector<HTMLElement>("[data-chat-stop]");
      if (stop?.dataset.chatStop) setCursor(stop.dataset.chatStop);
      (stop ?? element).scrollIntoView({ block: "center" });
      list.focus({ preventScroll: true });
      return true;
    },
    [setCursor],
  );
  const openOverview = useCallback(
    () => setOverviewOpen(true),
    [setOverviewOpen],
  );
  /**
   * The thread gone to whose message is older than those shown: older
   * messages are read, a page at a time, until it is drawn.
   */
  const [seeking, setSeeking] = useState<{ id: string; pages: number } | null>(
    null,
  );
  const olderRef = useRef(older);
  olderRef.current = older;
  /** Goes to a thread, reading older messages for it if need be. */
  const goTo = useCallback(
    (id: string) => {
      if (goToThread(id)) {
        setOverviewOpen(false);
        return;
      }
      if (!olderRef.current?.more) {
        setError(
          "That comment's message is not in the chat shown: its thread is in the comments (T).",
        );
        return;
      }
      setOverviewOpen(false);
      setSeeking({ id, pages: 0 });
    },
    [goToThread, setOverviewOpen],
  );
  useEffect(() => {
    if (!seeking) return;
    if (!away.has(seeking.id)) {
      // Drawn: there once the chat has it on screen.
      const frame = requestAnimationFrame(() => {
        goToThread(seeking.id);
        setSeeking(null);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (older?.loading) return;
    if (!older?.more || seeking.pages >= SEEK_PAGES) {
      setSeeking(null);
      setOverviewOpen(true);
      setError(
        "That comment's message is no longer in the chat: its thread is in the comments (T).",
      );
      return;
    }
    setSeeking({ id: seeking.id, pages: seeking.pages + 1 });
    older.load();
  }, [seeking, away, older, goToThread, setOverviewOpen]);
  /** g;: the comment written last, yours or the agent's. */
  const goToLatest = useCallback(() => {
    let latest: { thread: string; comment: string; at: string } | null = null;
    for (const thread of snapshot?.threads ?? [])
      if (thread.anchor.chat || thread.anchor.message)
        for (const comment of thread.comments) {
          const at =
            comment.updatedAt > comment.createdAt
              ? comment.updatedAt
              : comment.createdAt;
          if (!latest || at > latest.at)
            latest = { thread: thread.id, comment: comment.id, at };
        }
    if (latest) goToThread(latest.thread, latest.comment);
  }, [snapshot, goToThread]);
  /**
   * The chat's threads in the order they are read: those on messages not
   * shown first (older ones, by when), then message by message and, in a
   * message, by where the words they quote are; a thread on a part of a
   * thread's message right after that thread. Resolved ones too, so a step
   * starts from wherever the cursor is.
   */
  const chatOrder = useMemo(() => {
    const threads = (snapshot?.threads ?? []).filter(
      (thread) => thread.anchor.chat || thread.anchor.message,
    );
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const entryAt = new Map<string, number>();
    const entryIds = new Map<string, string>();
    for (const [entry, list] of byEntry)
      for (const thread of list) entryIds.set(thread.id, entry);
    shownEntries?.forEach((entry, index) => entryAt.set(entry.id, index));
    const texts = new Map<string, string>();
    const textOf = (id: string) => {
      let text = texts.get(id);
      if (text === undefined) {
        const entry = shownEntries?.find((e) => e.id === id);
        text = entry ? compactText(entry.text) : "";
        texts.set(id, text);
      }
      return text;
    };
    const keys = new Map<string, (number | string)[]>();
    const keyOf = (
      thread: ReviewThread,
      seen: Set<string>,
    ): (number | string)[] => {
      const known = keys.get(thread.id);
      if (known) return known;
      const holder = thread.anchor.message?.thread;
      const parent = holder ? byId.get(holder) : undefined;
      let key: (number | string)[];
      if (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        key = [...keyOf(parent, seen), thread.createdAt];
      } else {
        const part = thread.anchor.chat;
        const entry = entryIds.get(thread.id);
        if (!entry || away.has(thread.id))
          key = [0, part?.at ?? "", 0, thread.createdAt];
        else {
          const words = compactText(
            part?.quote.split("\n").find((line) => line.trim()) ?? "",
          ).slice(0, 80);
          const at = words ? textOf(entry).indexOf(words) : -1;
          key = [
            1,
            entryAt.get(entry) ?? Number.MAX_SAFE_INTEGER,
            Math.max(0, at),
            thread.createdAt,
          ];
        }
      }
      keys.set(thread.id, key);
      return key;
    };
    return threads
      .map((thread) => ({ thread, key: keyOf(thread, new Set([thread.id])) }))
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(({ thread }) => thread);
  }, [snapshot, byEntry, away, shownEntries]);
  /** The thread the cursor is in, if any. */
  const cursorThread = useMemo(() => {
    if (!cursor) return null;
    if (cursor.startsWith("t:")) return cursor.slice(2);
    const comment = cursor.startsWith("m:")
      ? cursor.slice(2)
      : cursor.startsWith("q:")
        ? cursor.slice(2, cursor.lastIndexOf(":"))
        : null;
    if (!comment) return null;
    return (
      chatOrder.find((thread) =>
        thread.comments.some((message) => message.id === comment),
      )?.id ?? null
    );
  }, [cursor, chatOrder]);
  const unresolvedTotal = chatOrder.filter((t) => !t.resolved).length;
  const unresolvedAt = unresolvedPosition(chatOrder, cursorThread);
  /** Where the cursor is among the threads: on one, or before one. */
  const chatPlace = (direction: 1 | -1): NavPlace => {
    const index = cursorThread
      ? chatOrder.findIndex((thread) => thread.id === cursorThread)
      : -1;
    if (index >= 0) return { index, on: true };
    // On a part of a message: before the first thread drawn after it.
    const list = scopeRef.current?.querySelector<HTMLElement>(
      ".agent-history-chat",
    );
    const here = list?.querySelector(".chat-review [data-part].is-focused");
    if (list && here) {
      const after = Array.from(
        list.querySelectorAll<HTMLElement>(".chat-thread[data-thread-id]"),
      ).find(
        (element) =>
          !!(
            here.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      );
      const at = after
        ? chatOrder.findIndex((t) => t.id === after.dataset.threadId)
        : -1;
      return { index: at < 0 ? chatOrder.length : at, on: false };
    }
    // Nowhere yet: from the start going down, from the end going up.
    return { index: direction === 1 ? 0 : chatOrder.length, on: false };
  };
  /**
   * To a thread: the threads it is in (and itself, folded by hand)
   * unfolded, older messages read if its message is not shown.
   */
  const goToUnresolved = (thread: ReviewThread) => {
    const byId = new Map(chatOrder.map((t) => [t.id, t]));
    const folds: string[] = [];
    let holder = thread.anchor.message?.thread;
    for (let seen = 0; holder && seen < 20; seen++) {
      const parent = byId.get(holder);
      if (!parent) break;
      if (parent.resolved !== flipped.has(parent.id)) folds.push(parent.id);
      holder = parent.anchor.message?.thread;
    }
    if (flipped.has(thread.id) && !thread.resolved) folds.push(thread.id);
    if (!folds.length) {
      goTo(thread.id);
      return;
    }
    setFlipped((current) => {
      const next = new Set(current);
      for (const id of folds) if (!next.delete(id)) next.add(id);
      return next;
    });
    requestAnimationFrame(() => goTo(thread.id));
  };
  /** gn / gN: the next or previous unresolved thread, wrapping around. */
  const jumpUnresolved = (direction: 1 | -1) => {
    const step = stepUnresolved(chatOrder, chatPlace(direction), direction);
    if (!step) {
      setError("No unresolved comment in this chat.");
      return;
    }
    if (step.wrapped) setNotice(stepNotice(step, direction));
    goToUnresolved(chatOrder[step.index]!);
  };
  /** A word on a step (wrapped around), gone after a moment. */
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const toggleOpenOnly = () => setOpenOnly(!openOnly);
  const closeOverview = () => {
    setOverviewOpen(false);
    setPanelReply(null);
    scopeRef.current
      ?.querySelector<HTMLElement>(".agent-history-chat")
      ?.focus({ preventScroll: true });
  };

  const keys = useRef({
    cursor,
    threadsById,
    comment,
    write,
    toggleFold,
    goToThread,
    openOverview,
    goToLatest,
    setPartDraft,
    jumpUnresolved,
    toggleOpenOnly,
    openOnly,
  });
  keys.current = {
    cursor,
    threadsById,
    comment,
    write,
    toggleFold,
    goToThread,
    openOverview,
    goToLatest,
    setPartDraft,
    jumpUnresolved,
    toggleOpenOnly,
    openOnly,
  };
  useEffect(() => {
    const messages = scopeRef.current?.closest<HTMLElement>(
      ".agent-history-messages",
    );
    const list = scopeRef.current?.querySelector<HTMLElement>(
      ".agent-history-chat",
    );
    if (!messages || !list) return;
    list.tabIndex = -1;
    const keyOf = (stop: HTMLElement) =>
      messageStopKey(
        stop,
        (part) =>
          `p:${part.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId}:${part.dataset.part}`,
      );
    // The conversation as shown: not what tool calls hold, nor what is
    // hidden.
    const stops = () =>
      messageStops(
        list,
        ".chat-review [data-part], [data-chat-stop]",
        (stop) => !stop.closest(".agent-history-chat-tools"),
      );
    const select = (stop: HTMLElement | undefined) => {
      if (!stop) return;
      setCursor(keyOf(stop));
      stop.scrollIntoView({ block: "nearest" });
      list.focus({ preventScroll: true });
    };
    const backToBox = () => {
      setCursor(null);
      list.style.paddingBottom = "";
      messages
        .querySelector<HTMLElement>(
          ".agent-history-composer :is(textarea, [contenteditable='true'])",
        )
        ?.focus({ preventScroll: true });
      // Back where the conversation goes on; at its end the chat follows
      // new messages again.
      list.scrollTop = list.scrollHeight;
    };
    const onEnter = () => {
      const all = stops();
      select(all[all.length - 1]);
    };
    let pending = "";
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== list || event.metaKey || event.ctrlKey) return;
      const {
        cursor,
        threadsById,
        comment,
        write,
        toggleFold,
        goToThread,
        openOverview,
        goToLatest,
      } = keys.current;
      const all = stops();
      const at = all.findIndex((stop) => keyOf(stop) === cursor);
      const here = all[at];
      const threadId =
        here?.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
      const thread = threadId ? threadsById.get(threadId) : undefined;
      const key = pending + event.key;
      pending = "";
      const place = (block: ScrollLogicalPosition) => {
        // As Vim does at the end of a file: room below the last messages,
        // until back in the box.
        if (block !== "end")
          list.style.paddingBottom = `${list.clientHeight}px`;
        here?.scrollIntoView({ block });
      };
      if (key === "j" || key === "ArrowDown") {
        // Past the last one: back down into the box.
        if (at >= all.length - 1) backToBox();
        else select(all[at + 1]);
      } else if (key === "k" || key === "ArrowUp")
        select(all[Math.max(0, at - 1)]);
      else if (key === "J" || key === "K") {
        // Message by message: the first part of the next one, or of this
        // one (then the one before) going up.
        const firsts = all.filter(
          (stop) => !stop.dataset.chatStop && stop.dataset.part === "0",
        );
        const entryOf = (stop: HTMLElement | undefined) =>
          stop?.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
        const mine = here
          ? firsts.findIndex((stop) => entryOf(stop) === entryOf(here))
          : firsts.length;
        const target =
          key === "J"
            ? firsts[mine + 1]
            : here && firsts[mine] && firsts[mine] !== here
              ? firsts[mine]
              : firsts[mine - 1];
        select(target);
      } else if (key === "n" || key === "N") {
        // The next or previous thread, from where the cursor is.
        const threads = Array.from(
          list.querySelectorAll<HTMLElement>(
            ".chat-thread[data-thread-id]:not(.is-draft)",
          ),
        );
        const from = here ?? all[all.length - 1];
        const own = from?.closest<HTMLElement>(".chat-thread");
        const after = (element: HTMLElement) =>
          !!from &&
          element !== own &&
          !!(
            from.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING
          );
        const next =
          key === "n"
            ? threads.find(after)
            : [...threads]
                .reverse()
                .find(
                  (element) =>
                    element !== own && !after(element) && element !== from,
                );
        if (next?.dataset.threadId) goToThread(next.dataset.threadId);
      } else if (key === "T") openOverview();
      else if (key === "gg") select(all[0]);
      else if (key === "G") select(all[all.length - 1]);
      else if (key === "zz") place("center");
      else if (key === "zt") place("start");
      else if (key === "zb") place("end");
      else if (key === "za" && thread) {
        // The cursor stays on the thread, folded or open.
        const folded = here?.dataset.chatStop?.startsWith("t:");
        setCursor(folded ? `m:${thread.comments[0]?.id}` : `t:${thread.id}`);
        toggleFold(thread);
      } else if (key === "g;") goToLatest();
      else if (key === "gn") keys.current.jumpUnresolved(1);
      else if (key === "gN") keys.current.jumpUnresolved(-1);
      else if (key === "gH") keys.current.toggleOpenOnly();
      else if (key === "g" || key === "z" || key === "d") pending = key;
      else if (key === "r" && thread) {
        // Resolving folds it: the cursor follows onto its one line.
        if (!thread.resolved && !flippedRef.current.has(thread.id))
          setCursor(`t:${thread.id}`);
        else if (thread.resolved && here?.dataset.chatStop?.startsWith("t:"))
          setCursor(`m:${thread.comments[0]?.id}`);
        void write("review.resolve", {
          comment_id: thread.id,
          resolved: !thread.resolved,
        });
        // Showing only the unresolved ones, it goes away: on to the next.
        if (keys.current.openOnly && !thread.resolved)
          keys.current.jumpUnresolved(1);
      } else if (key === "dd" && thread) {
        if (
          thread.comments.length === 1 &&
          thread.comments[0]?.author === REVIEW_USER
        )
          void write("review.delete", { comment_id: thread.id });
      } else if (
        (key === "c" || key === "Enter") &&
        commentOnPart(list, here, thread, keys.current.setPartDraft)
      ) {
        /* Taken up or commented on. */
      } else if (
        key === "R" &&
        replyOnMessage(list, here, thread, keys.current.setPartDraft)
      ) {
        /* A thread on the whole message. */
      } else if ((key === "c" || key === "Enter" || key === "R") && thread) {
        // An answer being written in that thread: back into it.
        const open = list.querySelector<HTMLElement>(
          `.chat-thread[data-thread-id="${CSS.escape(thread.id)}"] .chat-thread-editor .cm-content`,
        );
        if (open) open.focus();
        else setReplying(thread.id);
      } else if ((key === "c" || key === "Enter") && here) {
        const entry =
          here.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
        const message = entry ? entries.current.get(entry) : undefined;
        if (!message) return;
        const add = here.querySelector(":scope > .rc-part-add");
        comment(
          message,
          (here.textContent ?? "").replace(add?.textContent ?? "", "").trim(),
        );
      } else if (key === "i" || key === "a" || key === "Escape") backToBox();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    // The room zz made below the last messages goes with the keys, however
    // they leave (a click in the box, another pane).
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && list.contains(next)))
        list.style.paddingBottom = "";
    };
    messages.addEventListener(CHAT_PARTS_EVENT, onEnter);
    list.addEventListener("keydown", onKey);
    list.addEventListener("focusout", onFocusOut);
    return () => {
      messages.removeEventListener(CHAT_PARTS_EVENT, onEnter);
      list.removeEventListener("keydown", onKey);
      list.removeEventListener("focusout", onFocusOut);
      list.style.paddingBottom = "";
    };
  }, [setCursor, setReplying]);

  // Words selected in a message offer a comment on them.
  const [selection, clearSelection] = useSelectedWords((start) => {
    const message = start.closest<HTMLElement>(".chat-review [data-part]")
      ? start.closest<HTMLElement>("[data-entry-id]")
      : null;
    return message?.dataset.entryId ? { entry: message.dataset.entryId } : null;
  });

  // Rebuilt when what partsFor reads changes, not on every render.
  const value = useMemo<ChatThreads>(
    () => ({ partsFor }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      byEntry,
      byMessage,
      draft,
      partDraft,
      cursor,
      flipped,
      hidden,
      replying,
      write,
      comment,
      undelivered,
    ],
  );
  return (
    <ChatThreadsContext.Provider value={value}>
      <div ref={scopeRef} className="chat-threads-scope">
        {children}
      </div>
      {frame && overview.length
        ? createPortal(
            <>
              <div className="chat-threads-corner">
                {awayOpen.length ? (
                  // Comments drawn nowhere in the chat: listed in the panel.
                  <button
                    type="button"
                    className="chat-threads-away"
                    title="Comments on messages not shown here: open the list to read them or go to them"
                    onClick={openOverview}
                  >
                    {seeking
                      ? "Reading older messages..."
                      : `${awayOpen.length} on messages not shown`}
                  </button>
                ) : null}
                <ThreadsChip
                  className="chat-threads-chip"
                  threads={overview}
                  undelivered={
                    undelivered
                      ? {
                          count: undelivered.ids.size,
                          reason: undelivered.reason,
                        }
                      : undefined
                  }
                  open={overviewOpen}
                  onToggle={() =>
                    overviewOpen ? closeOverview() : openOverview()
                  }
                />
                <UnresolvedNav
                  className="chat-unresolved-nav"
                  total={unresolvedTotal}
                  position={unresolvedAt}
                  openOnly={openOnly}
                  onStep={jumpUnresolved}
                  onOpenOnly={setOpenOnly}
                />
                {notice ? (
                  <span className="chat-unresolved-notice" role="status">
                    {notice}
                  </span>
                ) : null}
              </div>
              {overviewOpen ? (
                <ThreadsPanel
                  className="chat-threads-panel"
                  place={
                    (keep.panel ??= {
                      query: "",
                      selectedId: null,
                      unfolded: [],
                      scrollTop: 0,
                    })
                  }
                  threads={panelThreads}
                  onClose={closeOverview}
                  onGo={goTo}
                  onResolve={(id) => {
                    const thread = threadsById.get(id);
                    if (thread)
                      void write("review.resolve", {
                        comment_id: id,
                        resolved: !thread.resolved,
                      });
                  }}
                  onReply={setPanelReply}
                  replying={
                    panelReply
                      ? {
                          id: panelReply,
                          editor: (
                            <ThreadEditor
                              key={panelReply}
                              {...boxOf(panelBox(panelReply))}
                              placeholder="Reply..."
                              onClose={(id) => {
                                dropFailed(id);
                                setPanelReply(null);
                              }}
                              onLeave={() => {}}
                              onSave={(text, id) => {
                                const thread = threadsById.get(panelReply);
                                return send({
                                  id,
                                  replyTo: panelReply,
                                  kind: thread?.kind ?? "discussion",
                                  anchor: thread?.anchor ?? {},
                                  text,
                                }).then((ok) => ok && setPanelReply(null));
                              }}
                            />
                          ),
                        }
                      : null
                  }
                  renderBody={(_, body) => <NoteBody text={body} />}
                />
              ) : null}
            </>,
            frame,
          )
        : null}
      {error ? (
        <div className="chat-thread-error" role="alert">
          {error}
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      {selection ? (
        <SelectionOffer
          at={selection}
          onClick={() => {
            const entry = entries.current.get(selection.entry);
            if (entry) comment(entry, selection.quote);
            clearSelection();
          }}
        />
      ) : null}
    </ChatThreadsContext.Provider>
  );
}
