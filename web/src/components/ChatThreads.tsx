import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { FileEdit } from "../../../shared/fileEdits";
import {
  REVIEW_USER,
  type ReviewAnchor,
  type ReviewChatPart,
  type ReviewMessagePart,
  type ReviewSnapshot,
  type ReviewThread,
  unheardComments,
} from "../../../shared/review";
import {
  fileEditAnchor,
  fileEditEntry,
  type FileEditParts,
  FileEditThreadsContext,
  onFileEdit,
  selectedRows,
} from "../fileEditComments";
import {
  rememberReviewSnapshot,
  reviewCall,
  useReviewSnapshots,
} from "../review";
import { looseText } from "../reviewMessageParts";
import {
  type PendingWrite,
  pendingWriteCall,
  withPendingWrites,
  writeLanded,
} from "../reviewPending";
import type { HistoryEntry } from "./agentHistory";
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
  MessageThread,
  type MessageThreadsScope,
  messagePartsOf,
  messageStopKey,
  messageStops,
  replyOnMessage,
  SelectionOffer,
  useSelectedWords,
} from "./MessageThreads";
import { ThreadEditor, type ThreadBox } from "./ThreadEditor";
import { reviewImageMarkdown } from "../workspaceFeedback";
import { useThreadKeys } from "./useThreadKeys";
export { ThreadEditor };
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

/** Where a thread on a file a call changed is: the file and its lines. */
export function fileThreadPlace(anchor: ReviewAnchor): string {
  const lines = anchor.line
    ? `:${anchor.line}${anchor.endLine ? `-${anchor.endLine}` : ""}${anchor.side === "old" ? " (before the change)" : ""}`
    : "";
  return `On ${anchor.path ?? "a file"}${lines}`;
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
    // On a file a call changed: that call's card, never a message.
    const entry =
      entries && ids
        ? onFileEdit(thread.anchor)
          ? fileEditEntry(part, entries, ids)
          : chatPartEntry(part, entries, ids, texts)
        : part.entry;
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

/**
 * What a chat's threads have open: the comments on their way, the boxes
 * open, where j / k are, the threads folded or unfolded by hand, the
 * comments' panel.
 */
type ThreadsView = {
  pendingWrites: PendingWrite[];
  draft: ReviewChatPart | null;
  partDraft: ReviewMessagePart | null;
  /** A comment being written on a file a call changed: its anchor. */
  fileDraft: ReviewAnchor | null;
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
const fileBox = (anchor: ReviewAnchor) =>
  `file:${anchor.chat?.entry}\0${anchor.side ?? ""}${anchor.line ?? ""}-${anchor.endLine ?? ""}\0${anchor.chat?.quote}`;
const replyBox = (thread: string) => `reply:${thread}`;
const panelBox = (thread: string) => `panel:${thread}`;

/** The boxes a view has open. */
function boxKeys(view: ThreadsView): string[] {
  const keys: string[] = [];
  if (view.draft) keys.push(draftBox(view.draft));
  if (view.partDraft) keys.push(partBox(view.partDraft));
  if (view.fileDraft) keys.push(fileBox(view.fileDraft));
  if (view.replying) keys.push(replyBox(view.replying));
  if (view.panelReply) keys.push(panelBox(view.panelReply));
  return keys;
}

function threadsKeep(): ThreadsKeep {
  let view: ThreadsView = {
    pendingWrites: [],
    draft: null,
    partDraft: null,
    fileDraft: null,
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

/** A stop of the chat's keys: a part of a chat message is `p:ENTRY:PART`. */
function chatStopKey(stop: HTMLElement): string {
  return messageStopKey(
    stop,
    (part) =>
      `p:${part.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId}:${part.dataset.part}`,
  );
}

/**
 * The stops of the chat's j / k, in order: the conversation as shown, not
 * what tool calls hold (but the files they changed), nor what is hidden.
 */
function chatStops(list: HTMLElement): HTMLElement[] {
  return messageStops(
    list,
    ".chat-review [data-part], .chat-file-edit [data-part], [data-chat-stop]",
    (stop) =>
      !stop.closest(".agent-history-chat-tools") ||
      !!stop.closest(".chat-file-edit"),
  );
}

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
    return {
      kept: box,
      autoFocus: !restored.has(key),
      onAddImage: (file: File) => addImage(file),
      // Its words outlive the page too: a reload, the chat closed.
      draft: { session: `chat:${connectionId}:${chat}`, key },
    };
  };
  const snapshots = useReviewSnapshots({ connectionId, chat });
  const snapshot = useMemo(
    () =>
      [...snapshots.values()].find(
        ({ session }) =>
          session.connectionId === connectionId &&
          session.target.kind === "chat" &&
          session.target.chat === chat,
      ),
    [snapshots, connectionId, chat],
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
  const fileDraft = view.fileDraft;
  const setFileDraft = useKeptField(keep, "fileDraft");
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
  /** The file changes drawn as cards, by their call's entry id. */
  const cards = useRef(
    new Map<string, { call: HistoryEntry; edit: FileEdit }>(),
  );

  const sessionId = useRef<string | null>(null);
  sessionId.current = snapshot?.session.id ?? null;
  /** The chat's review, opened by its first comment (or image). */
  const openSession = useCallback(async () => {
    if (sessionId.current) return sessionId.current;
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
    sessionId.current = opened.session.id;
    return opened.session.id;
  }, [connectionId, workspaceId, path, chat, agent, paneId]);
  /** An image for a comment, kept with the chat's review: its Markdown. */
  const addImage = useCallback(
    async (file: File) =>
      reviewImageMarkdown(
        (method, params) => reviewCall(connectionId, method, params),
        await openSession(),
        file,
      ),
    [connectionId, openSession],
  );
  /** Writes, then reads the review back so what you wrote shows at once. */
  const write = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setError("");
      try {
        const id = await openSession();
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
    [connectionId, openSession],
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

  /** A comment on the rows `from` to `to` of a call's card (-1: the file). */
  const commentFile = useCallback(
    (entry: string, from: number, to: number) => {
      const card = cards.current.get(entry);
      if (!card) return;
      setFileDraft(fileEditAnchor(card.call, card.edit, from, to));
      window.getSelection()?.removeAllRanges();
    },
    [setFileDraft],
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

  /** What the chat's threads share: drawn by the one MessageThread. */
  const scope: MessageThreadsScope = {
    byMessage,
    hidden,
    cursor,
    setCursor,
    flipped,
    toggleFold,
    replying,
    setReplying,
    partDraft,
    setPartDraft,
    partAnchor: (part) => ({ message: part }),
    partPlaceholder: `Comment for ${agent}...`,
    pendingById,
    undelivered: undelivered
      ? { ids: undelivered.ids, text: `Not delivered: ${undelivered.reason}` }
      : null,
    write,
    send,
    box: (key) =>
      boxOf("reply" in key ? replyBox(key.reply) : partBox(key.part)),
    onCloseBox: dropFailed,
    onLeave: backToConversation,
  };
  const renderThread = (thread: ReviewThread): ReactNode => (
    <MessageThread key={thread.id} thread={thread} scope={scope} />
  );

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

  /**
   * A call's card: the threads on the file it changed and the comment
   * being written there, drawn by the card under the lines they are on.
   */
  const fileParts = (call: HistoryEntry, edit: FileEdit): FileEditParts => {
    cards.current.set(call.id, { call, edit });
    const notes: FileEditParts["notes"][number][] = (byEntry.get(call.id) ?? [])
      .filter((thread) => !hidden.has(thread.id))
      .map((thread) => ({
        key: thread.id,
        anchor: thread.anchor,
        node: renderThread(thread),
      }));
    if (fileDraft?.chat?.entry === call.id)
      notes.push({
        key: "draft",
        anchor: fileDraft,
        node: (
          <div className="chat-thread is-draft">
            <ThreadEditor
              {...boxOf(fileBox(fileDraft))}
              placeholder={`Comment for ${agent}...`}
              onLeave={backToConversation}
              onClose={(id) => {
                dropFailed(id);
                setFileDraft(null);
                backToConversation();
              }}
              onSave={(text, id) =>
                send({
                  id,
                  kind: "discussion",
                  anchor: fileDraft,
                  text,
                }).then((ok) => {
                  if (!ok) return;
                  setFileDraft(null);
                  backToConversation();
                })
              }
            />
          </div>
        ),
      });
    return {
      notes,
      focused: cursor?.startsWith(`p:${call.id}:`)
        ? Number(cursor.slice(call.id.length + 3))
        : null,
      onComment: (from, to) => commentFile(call.id, from, to),
      onSelect: (part) => setCursor(`p:${call.id}:${part}`),
    };
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
  const olderMore = !!older?.more;
  /** The thread answered from the panel. */
  const panelReply = view.panelReply;
  const setPanelReply = useKeptField(keep, "panelReply");
  const panelThreads = useMemo<PanelThread[]>(
    () =>
      overview.map((thread) => {
        const part = thread.anchor.chat;
        const nested = thread.anchor.message;
        const file = onFileEdit(thread.anchor);
        const last = thread.comments[thread.comments.length - 1];
        const time = part?.at
          ? new Date(part.at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        const what = file ? "change" : "message";
        const awayWhere = olderMore
          ? `its ${what} is older than those shown: Go to it reads them`
          : `its ${what} is not in the chat shown`;
        return {
          id: thread.id,
          resolved: thread.resolved,
          where: ((part ?? nested)?.quote ?? "").split("\n")[0] ?? "",
          meta: `${
            nested
              ? "On a message of a thread"
              : file
                ? `${fileThreadPlace(thread.anchor)}${time ? `, changed at ${time}` : ""}`
                : `On ${agent}'s message${time ? ` of ${time}` : ""}${part?.excerpt ? `: ${part.excerpt}` : ""}`
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
    [overview, agent, away, olderMore],
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
  const [seeking, setSeeking] = useState<{
    id: string;
    comment?: string;
    pages: number;
  } | null>(null);
  const olderRef = useRef(older);
  olderRef.current = older;
  /** Goes to a thread, reading older messages for it if need be. */
  const goTo = useCallback(
    (id: string, comment?: string) => {
      if (goToThread(id, comment)) {
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
      setSeeking({ id, ...(comment ? { comment } : {}), pages: 0 });
    },
    [goToThread, setOverviewOpen],
  );
  useEffect(() => {
    if (!seeking) return;
    if (!away.has(seeking.id)) {
      // Drawn: there once the chat has it on screen.
      const frame = requestAnimationFrame(() => {
        goToThread(seeking.id, seeking.comment);
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
    setSeeking({ ...seeking, pages: seeking.pages + 1 });
    older.load();
  }, [seeking, away, older, goToThread, setOverviewOpen]);
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
        else if (onFileEdit(thread.anchor))
          // On a file change: by its line in the card.
          key = [
            1,
            entryAt.get(entry) ?? Number.MAX_SAFE_INTEGER,
            thread.anchor.line ?? 0,
            thread.createdAt,
          ];
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

  /** The chat's list and the message box under it. */
  const chatList = () => {
    const messages = scopeRef.current?.closest<HTMLElement>(
      ".agent-history-messages",
    );
    const list = scopeRef.current?.querySelector<HTMLElement>(
      ".agent-history-chat",
    );
    return messages && list ? { messages, list } : null;
  };
  const backToBox = () => {
    const found = chatList();
    if (!found) return;
    const { messages, list } = found;
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
  useThreadKeys(() => chatList()?.list ?? null, undefined, {
    stops: chatStops,
    keyOf: chatStopKey,
    cursor,
    setCursor,
    threadsById,
    flipped,
    openOnly,
    toggleFold,
    goToThread,
    // g; (the comment written last, yours or the agent's, on the chat), a
    // link to a comment: older messages read for it if need be.
    goToComment: (thread, comment) => goTo(thread.id, comment),
    latestAmong: (thread) => !!(thread.anchor.chat || thread.anchor.message),
    openOverview,
    jumpUnresolved,
    toggleOpenOnly,
    resolve: (thread) =>
      void write("review.resolve", {
        comment_id: thread.id,
        resolved: !thread.resolved,
      }),
    remove: (thread) => void write("review.delete", { comment_id: thread.id }),
    reply: (thread) => setReplying(thread.id),
    commentFirst: (here, thread) =>
      commentOnPart(chatList()?.list ?? null, here, thread, setPartDraft),
    // R on a thread's message: a thread on the whole of it.
    replyMessage: (here, thread) =>
      replyOnMessage(chatList()?.list ?? null, here, thread, setPartDraft),
    comment: (here) => {
      if (here.dataset.part !== undefined && here.closest(".chat-file-edit")) {
        // A file a call changed: its head comments on the file, a row on
        // that line.
        const entry =
          here.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
        const row = Number(here.dataset.part) - 1;
        if (entry) commentFile(entry, row, row);
        return true;
      }
      const entry =
        here.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
      const message = entry ? entries.current.get(entry) : undefined;
      if (!message) return false;
      const add = here.querySelector(":scope > .rc-part-add");
      comment(
        message,
        (here.textContent ?? "").replace(add?.textContent ?? "", "").trim(),
      );
      return true;
    },
    pastEnd: backToBox,
    leave: backToBox,
    otherKey: (key, { here, all }, select) => {
      if (key !== "J" && key !== "K") return false;
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
      return true;
    },
  });
  // Up from the message box: on the conversation's last stop.
  useEffect(() => {
    const found = chatList();
    if (!found) return;
    const { messages, list } = found;
    const onEnter = () => {
      const all = chatStops(list);
      const last = all[all.length - 1];
      if (!last) return;
      setCursor(chatStopKey(last));
      last.scrollIntoView({ block: "nearest" });
      list.focus({ preventScroll: true });
    };
    messages.addEventListener(CHAT_PARTS_EVENT, onEnter);
    return () => messages.removeEventListener(CHAT_PARTS_EVENT, onEnter);
    // biome-ignore lint/correctness/useExhaustiveDependencies: found once, as the keys are
  }, [setCursor]);

  // Words selected in a message offer a comment on them; lines selected in
  // a file a call changed, a comment on those lines.
  const [selection, clearSelection] = useSelectedWords((start, range) => {
    const card = start.closest(".chat-thread")
      ? null
      : start.closest<HTMLElement>(
          ".chat-file-edit.is-commentable[data-entry-id]",
        );
    const message = card
      ? card
      : start.closest<HTMLElement>(".chat-review [data-part]")
        ? start.closest<HTMLElement>("[data-entry-id]")
        : null;
    if (
      !message?.dataset.entryId ||
      (card && !scopeRef.current?.contains(card))
    )
      return null;
    return {
      entry: message.dataset.entryId,
      ...(card ? { rows: selectedRows(card, range) } : {}),
    };
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
  // The same for the files the chat's calls changed.
  const fileValue = useMemo(
    () => ({ partsFor: fileParts }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      byEntry,
      byMessage,
      partDraft,
      fileDraft,
      cursor,
      flipped,
      hidden,
      replying,
      write,
      commentFile,
    ],
  );
  return (
    <ChatThreadsContext.Provider value={value}>
      <FileEditThreadsContext.Provider value={fileValue}>
        <div ref={scopeRef} className="chat-threads-scope">
          {children}
        </div>
      </FileEditThreadsContext.Provider>
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
            if (selection.rows) commentFile(selection.entry, ...selection.rows);
            else {
              const entry = entries.current.get(selection.entry);
              if (entry) comment(entry, selection.quote);
            }
            clearSelection();
          }}
        />
      ) : null}
    </ChatThreadsContext.Provider>
  );
}
