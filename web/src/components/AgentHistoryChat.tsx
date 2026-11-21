import { useRenderTrace } from "../renderTrace";
import { useMountWindow } from "./chatMountWindow";
import { ShellCommandBlock } from "./AgentChatShell";
import {
  type ComponentProps,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  Check,
  ChevronRight,
  CircleSlash,
  Copy,
  ExternalLink,
  Loader2,
  RotateCw,
  Pencil,
  RotateCcw,
  Square,
  Volume2,
  Mic,
  Wrench,
  X,
} from "lucide-react";
import { useChatSpeech } from "../useChatSpeech";
import { ChatMessageWorkButton } from "./ChatWork";
import { copyTextWithFeedback } from "../copyText";
import { heardAs, parseVoiceMessage } from "../voiceChat";
import {
  REWIND_CODE_HELP,
  REWIND_MODES,
  type RewindMode,
  rewindModeStates,
} from "../claudeRewind";
import type { AgentChatRewindCheck } from "../../../shared/agentChat";
import { useRewindCheck } from "./AgentRewindSheet";
import { type AgentTask, taskStatusLabel } from "../agentTasks";
import { formatUiDateTime } from "../uiLocale";
import { ChatRewoundNotice } from "./ChatRewoundNotice";
import { ChatFileEdit } from "./ChatFileEdit";
import {
  type FileEdit,
  fileEditFromArgumentText,
} from "../../../shared/fileEdits";
import { HISTORY_PREVIEW_CHARS } from "./AgentHistoryCard";
import type { OutboxMessage } from "./chatOutbox";
import {
  historyEntryLabel,
  isToolContentPending,
  sameHistoryEntry,
  type HistoryEntry,
} from "./agentHistory";
import {
  pairToolSteps,
  previewToolArgumentFields,
  takeQueuedToolLoads,
  toolPayloadKey,
  summarizeToolSteps,
  toolArgumentFields,
  collapsedToolProgress,
  toolStepSummary,
  toolStepWrite,
  type HistoryChatItem,
  type ToolStep,
} from "./agentHistoryView";
import { canOpenRoamgateWrite, openRoamgateWrite } from "../roamgateWrites";
import {
  type RoamgateWrite,
  toolDisplayName,
} from "../../../shared/toolSummary";
import { formatBytes } from "./agentSession";
import { MarkdownPreview } from "./markdown";
import { ForgeStreamingContext, useForgeSlotsContext } from "../forgeSlots";
import {
  type OlderMessages,
  reviewDelivery,
  useChatParts,
  useChatThreadedEntries,
} from "./ChatThreads";
import {
  type ChatAnchor,
  type ChatSeen,
  findChatAnchorItem,
  placeChatAnchor,
  readChatAnchor,
  readChatPlace,
  rememberChatPlace,
  scrollChatTo,
} from "../chatPlace";
import { NoteBody } from "./ReviewNoteBody";
import { messageImagePieces } from "../chatImages";
import { looksLikeMarkdown } from "../userMarkdown";
import { ImageLightbox } from "./ImageLightbox";
import { isSentImageGone } from "../sentImages";
import "./AgentHistoryChat.css";

// Treat the list as pinned while the reader is within this distance of the
// newest message, so polling refreshes keep following live output.
const FOLLOW_THRESHOLD_PX = 48;
// A place given back is held this long while what is drawn settles (lazy
// markdown, images, a page of older messages), unless the reader moves.
const PLACE_HOLD_MS = 1500;
// Pages of older messages read at most to give back a place among them.
const PLACE_SEEK_PAGES = 40;

const EMPTY_LOADING: ReadonlySet<string> = new Set();
const noop = () => {};
const NO_OUTBOX: readonly OutboxMessage[] = [];

// A history refresh hands over new entry objects even for messages that did
// not change: a bubble re-renders only when what it shows changed.
type BubbleProps = {
  entry: HistoryEntry;
  sequence: number;
  /** A slash command typed this many times in a row: "/exit ×11". */
  repeated?: number;
  firstSentAt?: string;
  highlighted: boolean;
  speech: ReturnType<typeof useChatSpeech>;
  onOpen: (entry: HistoryEntry) => void;
  onRemoveQueued?: (entry: HistoryEntry) => void;
  onEditQueued?: (entry: HistoryEntry) => void;
  /** Queued in the agent itself, past taking back. */
  queuedHandedOver?: boolean;
  onRewind?: (entry: HistoryEntry, mode: RewindMode) => void;
  onRewindCheck?: (entry: HistoryEntry) => Promise<AgentChatRewindCheck>;
  /** Sends one of the messages a rewind cut again (ChatRewoundNotice). */
  onSendAgain?: (text: string) => Promise<unknown> | void;
  /** Puts one of them back in the message box. */
  onEditAgain?: (text: string) => void;
  imageUrl?: (path: string) => string;
  sentImageUrl?: SentImageUrl;
};
// Not its sequence either: a window that slides by one message renumbers
// every bubble, so the list sets data-sequence on the bubbles itself
// (AgentHistoryChat) and a bubble that only moved is not drawn again.
function sameBubble(a: BubbleProps, b: BubbleProps): boolean {
  const x = a.entry;
  const y = b.entry;
  return (
    a.highlighted === b.highlighted &&
    a.repeated === b.repeated &&
    a.firstSentAt === b.firstSentAt &&
    a.speech === b.speech &&
    a.onOpen === b.onOpen &&
    a.imageUrl === b.imageUrl &&
    a.sentImageUrl === b.sentImageUrl &&
    a.onRemoveQueued === b.onRemoveQueued &&
    a.onEditQueued === b.onEditQueued &&
    a.queuedHandedOver === b.queuedHandedOver &&
    a.onRewind === b.onRewind &&
    a.onRewindCheck === b.onRewindCheck &&
    a.onSendAgain === b.onSendAgain &&
    a.onEditAgain === b.onEditAgain &&
    (x === y ||
      (x.id === y.id &&
        x.text === y.text &&
        x.role === y.role &&
        x.kind === y.kind &&
        x.sent_at === y.sent_at &&
        x.queued === y.queued &&
        x.compact_summary === y.compact_summary &&
        x.injected?.label === y.injected?.label &&
        x.rewound === y.rewound &&
        x.command?.name === y.command?.name &&
        x.command?.args === y.command?.args &&
        x.text_bytes === y.text_bytes &&
        x.text_hash === y.text_hash &&
        x.images === y.images &&
        x.uuid === y.uuid &&
        x.artifact?.url === y.artifact?.url &&
        x.shell?.status === y.shell?.status &&
        x.shell?.exit_code === y.shell?.exit_code &&
        x.shell?.host === y.shell?.host))
  );
}

const ChatBubble = memo(function ChatBubble({
  entry,
  sequence,
  repeated,
  firstSentAt,
  highlighted,
  speech,
  onOpen,
  onRemoveQueued,
  onEditQueued,
  queuedHandedOver = false,
  onRewind,
  onRewindCheck,
  onSendAgain,
  onEditAgain,
  imageUrl,
  sentImageUrl,
}: BubbleProps) {
  useRenderTrace("ChatBubble");
  // In a chat with threads, Claude's messages are in parts one comments on.
  const parts = useChatParts(entry);
  const [showHeard, setShowHeard] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const rewindStates = rewindModeStates(
    useRewindCheck(rewinding ? entry : null, onRewindCheck),
  );
  // Messages between agent sessions show what they say: they are the
  // conversation between the sessions, not Claude Code's bookkeeping.
  const [expanded, setExpanded] = useState(
    () => entry.injected?.kind === "session",
  );
  // A compaction summary is long and written by Claude Code, not the user:
  // one line, with the summary a tap away.
  if (entry.compact_summary)
    return (
      <div
        className="agent-history-chat-compacted"
        data-sequence={sequence}
        data-bubble-id={entry.id}
      >
        <span>Conversation compacted</span>
        <button type="button" onClick={() => onOpen(entry)}>
          Show the summary
        </button>
      </div>
    );
  // A `!` line the user ran (bash mode), as the transcript has it.
  if (entry.shell)
    return (
      <ShellCommandBlock
        command={entry.shell.command}
        stdout={entry.shell.stdout}
        stderr={entry.shell.stderr}
        truncated={entry.shell.truncated}
        status={entry.shell.status}
        exitCode={entry.shell.exit_code}
        startedAt={entry.shell.started_at}
        finishedAt={entry.shell.finished_at}
        host={entry.shell.host}
        cwd={entry.shell.cwd}
        sent
        sequence={sequence}
        bubbleId={entry.id}
      />
    );
  // What Claude Code put in the user's turn (a subagent's report, another
  // session's message, a task ending): not the user's words, one line in
  // its place, what it says a tap away.
  // Where a rewind cut the conversation: the user's messages it cut,
  // offered back.
  if (entry.injected?.kind === "rewound")
    return (
      <ChatRewoundNotice
        entry={entry}
        sequence={sequence}
        onSendAgain={onSendAgain}
        onEditAgain={onEditAgain}
      />
    );
  if (entry.injected) {
    const body = entry.text.trim();
    const more = !!body && body !== entry.injected.label;
    const shown = body.slice(0, HISTORY_PREVIEW_CHARS);
    return (
      <div
        className={`agent-history-chat-injected${entry.injected.kind === "session" ? " is-peer" : ""}`}
        data-sequence={sequence}
        data-bubble-id={entry.id}
        data-entry-id={entry.id}
      >
        <div className="agent-history-chat-compacted">
          <span title={entry.injected.label}>{entry.injected.label}</span>
          {more ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Hide it" : "Show it"}
            </button>
          ) : null}
        </div>
        {more && expanded ? (
          <div className="agent-history-chat-injected-body">
            <MarkdownPreview
              text={shown}
              className="agent-history-chat-markdown"
              breaks
            />
            {shown.length < body.length ? (
              <button
                type="button"
                className="agent-history-chat-more"
                onClick={() => onOpen(entry)}
              >
                View full message
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  // Review comments Roamgate handed to the agent: one line, the threads
  // being where they are read.
  const delivery =
    entry.role === "user" && entry.kind === "message"
      ? reviewDelivery(entry.text)
      : null;
  if (delivery)
    return (
      <div
        className="agent-history-chat-compacted"
        data-sequence={sequence}
        data-bubble-id={entry.id}
      >
        <span>
          {delivery.count
            ? `${delivery.count} review comment${delivery.count === 1 ? "" : "s"} sent to the agent`
            : "Review sent to the agent"}
          {` (${delivery.title})`}
        </span>
        <button type="button" onClick={() => onOpen(entry)}>
          Show it
        </button>
      </div>
    );
  // A message said by voice shows that as a label, not as its text.
  const spoken = entry.role === "user" ? parseVoiceMessage(entry.text) : null;
  const shownText = spoken?.voice ? spoken.text : entry.text;
  // A cleaned voice message keeps, in this browser, the words as heard.
  const raw = spoken?.voice ? heardAs(spoken.text) : null;
  const preview = shownText.slice(0, HISTORY_PREVIEW_CHARS);
  const truncated = preview.length < shownText.length;
  const label = historyEntryLabel(entry);
  const tone = entry.kind === "error" ? "is-error" : `is-${entry.role}`;
  const playback = speech.state?.messageId === entry.id ? speech.state : null;
  const speaking = playback?.status === "speaking";
  const status =
    playback?.status === "failed"
      ? playback.error
      : playback?.status === "completed"
        ? "Speech completed"
        : playback?.status === "stopped"
          ? "Speech stopped"
          : speaking
            ? "Speaking"
            : "";
  return (
    <article
      className={`agent-history-chat-message ${tone} ${highlighted ? "is-minimap-target" : ""}${entry.queued ? " is-queued" : ""}`}
      data-sequence={sequence}
      data-bubble-id={entry.id}
      data-entry-id={entry.id}
      // The same reply block, streamed then saved: what voice reads is
      // found in either.
      data-block-key={
        entry.message_id
          ? `${entry.message_id}:${entry.block_index ?? 0}`
          : undefined
      }
    >
      <div className="agent-history-chat-bubble">
        {spoken?.voice ? (
          <span
            className="agent-history-chat-voice"
            title={
              spoken.interruptedAt
                ? `Said by voice, interrupting the reading at: ${spoken.interruptedAt}`
                : "Said by voice"
            }
          >
            <Mic size={11} aria-hidden="true" />
            {spoken.interruptedAt
              ? `Interrupted at "${spoken.interruptedAt}"`
              : "Voice"}
            {raw ? (
              <button
                type="button"
                className="agent-history-chat-heard-toggle"
                aria-expanded={showHeard}
                onClick={() => setShowHeard((shown) => !shown)}
              >
                {showHeard
                  ? "Hide what was heard"
                  : "Cleaned: show what was heard"}
              </button>
            ) : null}
          </span>
        ) : null}
        {raw && showHeard ? (
          <p className="agent-history-chat-heard">{raw}</p>
        ) : null}
        {spoken?.context ? (
          // The companion's note of what the words referred to on its call.
          <p className="agent-history-chat-heard">
            Context given: {spoken.context}
          </p>
        ) : null}
        {entry.role === "user" && entry.command ? (
          // A slash command typed in the terminal: the command, as a chip.
          <span className="agent-history-chat-command">
            <code>{entry.command.name}</code>
            {entry.command.args ? (
              <span className="agent-history-chat-command-args">
                {entry.command.args}
              </span>
            ) : null}
            {repeated && repeated > 1 ? (
              <span
                className="agent-history-chat-command-count"
                title={`${repeated} times in a row${
                  firstSentAt ? `, from ${formatUiDateTime(firstSentAt)}` : ""
                }`}
              >
                ×{repeated}
              </span>
            ) : null}
          </span>
        ) : entry.role === "user" ? (
          <>
            {!preview && entry.images ? null : imageUrl ? (
              <UserText text={preview} imageUrl={imageUrl} />
            ) : (
              <UserMessageText text={preview} />
            )}
            {entry.images && entry.uuid && sentImageUrl ? (
              <SentImages
                uuid={entry.uuid}
                count={entry.images}
                sentImageUrl={sentImageUrl}
              />
            ) : null}
          </>
        ) : parts && entry.kind === "message" ? (
          <div className="agent-history-chat-markdown chat-review">
            <NoteBody text={preview} parts={parts} />
          </div>
        ) : (
          // A live turn's text is still being written: its last reference
          // may be cut short.
          <ForgeStreamingContext.Provider value={entry.id.startsWith("live:")}>
            <MarkdownPreview
              text={preview}
              className="agent-history-chat-markdown"
              breaks
            />
          </ForgeStreamingContext.Provider>
        )}
        {truncated ? (
          <button
            type="button"
            className="agent-history-chat-more"
            onClick={() => onOpen(entry)}
          >
            View full message
          </button>
        ) : null}
      </div>
      <div className="agent-history-chat-meta">
        {entry.queued ? (
          <span
            className="agent-history-chat-queued"
            title={
              queuedHandedOver
                ? "Handed to the agent already: it reads it at its next step"
                : "Waiting in the agent's queue: it reads it when it can"
            }
          >
            Queued
          </span>
        ) : null}
        {entry.queued && onEditQueued && !queuedHandedOver ? (
          <button
            type="button"
            className="agent-history-copy agent-history-chat-edit-queued"
            onClick={() => onEditQueued(entry)}
            aria-label="Edit this queued message"
            title="Take it back into the box to edit (Up in the empty box takes them all)"
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
        ) : null}
        {entry.queued && onRemoveQueued && !queuedHandedOver ? (
          <button
            type="button"
            className="agent-history-copy agent-history-chat-unqueue"
            onClick={() => onRemoveQueued(entry)}
            aria-label="Take this message out of the queue"
            title="Take it out of the queue: the agent never gets it"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
        <time dateTime={entry.sent_at} title={entry.sent_at}>
          {formatUiDateTime(entry.sent_at)}
        </time>
        <button
          type="button"
          className="agent-history-copy"
          onClick={() => void copyTextWithFeedback(entry.text)}
          aria-label={`Copy ${label.toLowerCase()} message`}
          title="Copy"
        >
          <Copy size={12} />
        </button>
        {entry.kind === "message" && !entry.queued ? (
          <ChatMessageWorkButton
            text={entry.text}
            entry={entry.id}
            className="agent-history-copy agent-history-chat-work"
          />
        ) : null}
        {onRewind &&
        entry.role === "user" &&
        entry.kind === "message" &&
        !entry.queued ? (
          <button
            type="button"
            className="agent-history-copy agent-history-chat-rewind"
            aria-expanded={rewinding}
            onClick={() => setRewinding((open) => !open)}
            aria-label="Rewind to before this message"
            title="Rewind to before this message, as /rewind does"
          >
            <RotateCcw size={12} />
          </button>
        ) : null}
        {entry.role === "assistant" ? (
          <button
            type="button"
            className={`agent-history-copy agent-history-speak${speaking ? " is-speaking" : ""}`}
            disabled={!speech.supported || !entry.text.trim()}
            aria-label={
              speaking ? "Stop speaking message" : "Speak assistant message"
            }
            aria-pressed={speaking}
            title={
              !speech.supported
                ? "Speech is not supported by this browser"
                : speaking
                  ? "Stop"
                  : "Speak"
            }
            onClick={() => speech.toggle(entry.id, entry.text)}
          >
            {speaking ? <Square size={12} /> : <Volume2 size={12} />}
          </button>
        ) : null}
        {status ? (
          <span className="agent-history-speech-status" role="status">
            {status}
          </span>
        ) : null}
      </div>
      {rewinding && onRewind ? (
        <div
          className="agent-history-chat-rewind-menu"
          role="group"
          aria-label="Rewind to before this message"
          onKeyDown={(event) => {
            if (event.key === "Escape") setRewinding(false);
          }}
        >
          <span>Rewind to before this message:</span>
          {REWIND_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              disabled={rewindStates.disabled.has(mode)}
              title={
                rewindStates.disabled.has(mode)
                  ? (rewindStates.note ?? undefined)
                  : mode === "conversation"
                    ? undefined
                    : REWIND_CODE_HELP
              }
              onClick={() => {
                setRewinding(false);
                onRewind(entry, mode);
              }}
            >
              {label}
            </button>
          ))}
          <button type="button" onClick={() => setRewinding(false)}>
            Cancel
          </button>
          {rewindStates.note ? (
            <p className="agent-history-chat-rewind-note" role="note">
              {rewindStates.note}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}, sameBubble);

// A message sent from the chat that the transcript does not show yet: on its
// way (dashed and dimmed, like a queued one) until its entry replaces it, or
// not delivered, with the ways out.
/**
 * What the user typed: as typed, unless written in Markdown (a code fence,
 * inline code, a list, a link), which renders as the agent's replies do,
 * sanitised the same way.
 */
export function UserMessageText({ text }: { text: string }) {
  const forge = useForgeSlotsContext();
  if (!looksLikeMarkdown(text)) return <p>{forge?.renderText(text) ?? text}</p>;
  return (
    <MarkdownPreview
      text={text}
      className="agent-history-chat-markdown is-user-markdown"
      breaks
    />
  );
}

/** A message of the user's, with the images it sent shown. */
function UserText({
  text,
  imageUrl,
}: {
  text: string;
  imageUrl: (path: string) => string;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const pieces = messageImagePieces(text);
  if (!pieces.some((piece) => "image" in piece))
    return <UserMessageText text={text} />;
  const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path;
  return (
    <>
      {pieces.map((piece, index) =>
        "image" in piece ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: pieces do not move
            key={index}
            className="agent-history-chat-image"
            href={imageUrl(piece.image)}
            target="_blank"
            rel="noreferrer"
            title={piece.image}
            // A click leaves the focus where it was (the message box), for
            // the image to give it back there: in the list, it would stop
            // the chat following new messages.
            onMouseDown={(event) => {
              if (event.button === 0) event.preventDefault();
            }}
            onClick={(event) => {
              // Cmd / Ctrl / Shift / middle click still open a tab.
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              setShown(piece.image);
            }}
          >
            <img
              src={imageUrl(piece.image)}
              alt={nameOf(piece.image)}
              loading="lazy"
            />
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces do not move
          <UserMessageText key={index} text={piece.text} />
        ),
      )}
      {shown ? (
        <ImageLightbox
          src={imageUrl(shown)}
          name={nameOf(shown)}
          onClose={() => setShown(null)}
        />
      ) : null}
    </>
  );
}

/** Loads an image sent inline in a message: its uuid, then its place. */
export type SentImageUrl = (uuid: string, index: number) => Promise<string>;

/**
 * The images a message carried inline (conversation mode sends them so, and
 * a pasted image is kept so): the transcript has no path for them, so they
 * load from the session itself.
 */
/** Waits between tries to load a sent image; the last repeats. */
export const SENT_IMAGE_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
/** How long a sent image loads before the chat says it still is. */
export const SENT_IMAGE_SLOW_MS = 8000;
/**
 * How near the chat's visible part a sent image starts loading: images on
 * screen, or about to be, go before the ones far up the conversation.
 */
const SENT_IMAGE_NEAR_MARGIN = "800px 0px";

export function SentImages({
  uuid,
  count,
  sentImageUrl,
}: {
  uuid: string;
  count: number;
  sentImageUrl: SentImageUrl;
}) {
  // An image: undefined while it loads, its URL, or null once it is known
  // not to be there.
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [slow, setSlow] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  // Images load once they near the chat's visible part (all at once where
  // that cannot be told), so those on screen are asked for first.
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const boxRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (near) return;
    const box = boxRef.current;
    if (!box) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      {
        root: box.closest(".agent-history-chat"),
        rootMargin: SENT_IMAGE_NEAR_MARGIN,
      },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    // A load that fails (the socket away while a phone sleeps, a request
    // lost or slow behind other work) is tried again while the chat shows
    // the message, and at once when the page or the network comes back. An
    // image is only said to be missing when the bridge says it is not there:
    // until then it shows as loading, and as still loading after a while.
    const failures: number[] = [];
    const loading: boolean[] = [];
    const done: boolean[] = [];
    const timers: (ReturnType<typeof setTimeout> | undefined)[] = [];
    const set = (index: number, url: string | null) =>
      setUrls((current) => {
        const next = [...current];
        next[index] = url;
        return next;
      });
    const load = (index: number) => {
      if (cancelled || loading[index] || done[index]) return;
      clearTimeout(timers[index]);
      loading[index] = true;
      sentImageUrl(uuid, index).then(
        (url) => {
          loading[index] = false;
          done[index] = true;
          if (!cancelled) set(index, url);
        },
        (error: unknown) => {
          loading[index] = false;
          if (cancelled) return;
          if (isSentImageGone(error)) {
            done[index] = true;
            set(index, null);
            return;
          }
          const failed = (failures[index] ?? 0) + 1;
          failures[index] = failed;
          timers[index] = setTimeout(
            () => load(index),
            SENT_IMAGE_RETRY_MS[
              Math.min(failed, SENT_IMAGE_RETRY_MS.length) - 1
            ],
          );
        },
      );
    };
    const again = () => {
      if (document.visibilityState === "hidden") return;
      for (let index = 0; index < count; index += 1)
        if (failures[index]) load(index);
    };
    setUrls([]);
    setSlow(false);
    const slowTimer = setTimeout(() => {
      if (!cancelled) setSlow(true);
    }, SENT_IMAGE_SLOW_MS);
    for (let index = 0; index < count; index += 1) load(index);
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    window.addEventListener("focus", again);
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      for (const timer of timers) clearTimeout(timer);
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
      window.removeEventListener("focus", again);
    };
  }, [uuid, count, sentImageUrl, near]);
  const name = (index: number) =>
    count === 1 ? "Image sent" : `Image ${index + 1} sent`;
  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        const url = urls[index];
        if (url === null)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: images do not move
            <p key={index} className="agent-history-chat-image-missing">
              [an image that could not be loaded]
            </p>
          );
        if (url === undefined)
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: images do not move
              key={index}
              ref={index === 0 ? boxRef : undefined}
              className="agent-history-chat-image is-loading"
              role="img"
              aria-label={`${name(index)}, ${slow ? "still loading" : "loading"}`}
            >
              {slow ? (
                <span className="agent-history-chat-image-slow">
                  Still loading
                </span>
              ) : null}
            </span>
          );
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: images do not move
            key={index}
            className="agent-history-chat-image"
            href={url}
            target="_blank"
            rel="noreferrer"
            title={name(index)}
            // A click leaves the focus where it was (the message box), for
            // the image to give it back there: in the list, it would stop
            // the chat following new messages.
            onMouseDown={(event) => {
              if (event.button === 0) event.preventDefault();
            }}
            onClick={(event) => {
              // Cmd / Ctrl / Shift / middle click still open a tab.
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              setShown(url);
            }}
          >
            <img src={url} alt={name(index)} />
          </a>
        );
      })}
      {shown ? (
        <ImageLightbox
          src={shown}
          name="Image sent"
          onClose={() => setShown(null)}
        />
      ) : null}
    </>
  );
}

function OutboxBubble({
  message,
  onRetry,
  onDiscard,
}: {
  message: OutboxMessage;
  onRetry?: (message: OutboxMessage) => void;
  onDiscard?: (message: OutboxMessage) => void;
}) {
  const failed = message.state === "failed";
  return (
    <article
      className={`agent-history-chat-message is-user is-outbox is-${message.state}`}
      data-outbox-id={message.id}
    >
      <div className="agent-history-chat-bubble">
        <UserMessageText text={message.text.slice(0, HISTORY_PREVIEW_CHARS)} />
      </div>
      <div className="agent-history-chat-meta">
        {failed ? (
          <>
            <span
              className="agent-history-chat-undelivered"
              title={message.reason}
            >
              Not delivered
            </span>
            {onRetry ? (
              <button
                type="button"
                className="agent-history-copy"
                onClick={() => onRetry(message)}
                aria-label="Send this message again"
                title="Send again"
              >
                <RotateCw size={12} />
              </button>
            ) : null}
            {onDiscard ? (
              <button
                type="button"
                className="agent-history-copy"
                onClick={() => onDiscard(message)}
                aria-label="Discard this message"
                title="Discard"
              >
                <X size={12} />
              </button>
            ) : null}
          </>
        ) : (
          <span
            className="agent-history-chat-sending"
            role="status"
            title={
              message.state === "sending"
                ? "Sending it to the agent"
                : "Sent: waiting for the agent's session to show it"
            }
          >
            <span
              className="agent-history-chat-sending-mark"
              aria-hidden="true"
            />
            {message.state === "sending" ? "Sending…" : "On its way"}
          </span>
        )}
        <button
          type="button"
          className="agent-history-copy"
          onClick={() => void copyTextWithFeedback(message.text)}
          aria-label="Copy the message"
          title="Copy"
        >
          <Copy size={12} />
        </button>
      </div>
    </article>
  );
}

/** A turn cut short, after the conversation's last entry. */
export type ChatCutOff = {
  text: string;
  onContinue: () => void;
  onDismiss: () => void;
};

function CutOffNotice({ cutOff }: { cutOff: ChatCutOff }) {
  return (
    <div className="agent-history-chat-cut-off" role="status">
      <span>{cutOff.text}</span>
      <button
        type="button"
        className="agent-history-chat-cut-off-continue"
        onClick={cutOff.onContinue}
        title="Ask Claude to go on with the answer"
      >
        Continue
      </button>
      <button
        type="button"
        className="agent-history-copy"
        onClick={cutOff.onDismiss}
        aria-label="Dismiss this notice"
        title="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** What the last /model did, after the conversation's last entry. */
export type ChatModelNotice = {
  text: string;
  ok: boolean;
  onDismiss: () => void;
};

function ModelNotice({ notice }: { notice: ChatModelNotice }) {
  return (
    <div
      className={`agent-history-chat-cut-off ${
        notice.ok ? "is-model" : "agent-history-chat-lost"
      }`}
      role={notice.ok ? "status" : "alert"}
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className="agent-history-copy"
        onClick={notice.onDismiss}
        aria-label="Dismiss this notice"
        title="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * Nothing sent goes out: the conversation process is lost, or the queue
 * has waited too long. Recover starts a new process with the queue. A turn
 * that seems to hang (`stuck`) offers Interrupt (while Stop may still
 * work) and Restart Claude, the same recover.
 */
export type ChatDelivery = {
  text: string;
  detail: string | null;
  recovering: boolean;
  onRecover: () => void;
  stuck?: "silent" | "stop_unanswered";
  onInterrupt?: () => void;
};

function DeliveryNotice({ delivery }: { delivery: ChatDelivery }) {
  const restart = !!delivery.stuck;
  return (
    <div
      className="agent-history-chat-cut-off agent-history-chat-lost"
      role="alert"
    >
      <span>
        <strong>{delivery.text}</strong>
        {delivery.detail ? (
          <span className="agent-history-chat-lost-detail">
            {delivery.detail}
          </span>
        ) : null}
      </span>
      {delivery.stuck === "silent" && delivery.onInterrupt ? (
        <button
          type="button"
          className="agent-history-chat-cut-off-continue"
          onClick={delivery.onInterrupt}
          disabled={delivery.recovering}
          title="Stop the turn; Claude keeps what it wrote"
        >
          Interrupt
        </button>
      ) : null}
      <button
        type="button"
        className="agent-history-chat-cut-off-continue"
        onClick={delivery.onRecover}
        disabled={delivery.recovering}
        title={
          restart
            ? "End this Claude process and resume the session in a new one, with the queued messages; what the turn was doing stops"
            : "End the conversation process Roamgate cannot reach and resume the session in a new one, with the queued messages"
        }
      >
        {delivery.recovering
          ? restart
            ? "Restarting..."
            : "Recovering..."
          : restart
            ? "Restart Claude"
            : "Recover"}
      </button>
    </div>
  );
}

/**
 * The pane's environment has an Anthropic API key Claude Code has no
 * answer for: Claude starts in conversation mode once the user says which
 * pays, as the TUI asks. What was typed meanwhile waits in the queue.
 */
export type ChatApiKeyQuestion = {
  /** How many messages wait for the answer. */
  queued: number;
  answering: boolean;
  onAnswer: (use: "api_key" | "login") => void;
};

function ApiKeyQuestionNotice({ question }: { question: ChatApiKeyQuestion }) {
  return (
    <div className="agent-history-chat-cut-off" role="alert">
      <span>
        <strong>This session's environment has an Anthropic API key.</strong>
        <span className="agent-history-chat-lost-detail">
          Use it (billed to the API), or use your subscription login? Claude
          starts once you answer, and Claude Code keeps the answer, so the
          terminal will not ask again.
          {question.queued
            ? ` ${question.queued === 1 ? "A queued message waits" : `${question.queued} queued messages wait`} for it.`
            : ""}
        </span>
      </span>
      <button
        type="button"
        className="agent-history-chat-cut-off-continue"
        onClick={() => question.onAnswer("api_key")}
        disabled={question.answering}
        title="Claude uses the API key from this session's environment; usage is billed to the API"
      >
        Use the API key
      </button>
      <button
        type="button"
        className="agent-history-chat-cut-off-continue"
        onClick={() => question.onAnswer("login")}
        disabled={question.answering}
        title="Claude leaves the API key out and uses your Claude subscription login (recommended)"
      >
        Use my subscription login
      </button>
    </div>
  );
}

// Opening a block fetches small arguments so each row can show a headline;
// larger payloads (e.g. whole-file writes) wait until their step is opened.
const AUTO_LOAD_ARGUMENT_BYTES = 16 * 1024;
// Background headline fetches run through a queue with this many requests in
// flight, so opening a long block does not fire one request per call at once.
const BACKGROUND_LOADS_IN_FLIGHT = 3;

type ToolContentLoader = {
  loading: ReadonlySet<string>;
  // Fetch now (the reader asked for this payload).
  load: (entry: HistoryEntry) => void;
  // Fetch when a background slot frees up.
  enqueue: (entry: HistoryEntry) => void;
};

function ToolContentLoad({
  entry,
  label,
  loader,
}: {
  entry: HistoryEntry;
  label: string;
  loader: ToolContentLoader;
}) {
  const loading = loader.loading.has(entry.id);
  return (
    <button
      type="button"
      className="agent-history-tool-load"
      disabled={loading}
      onClick={() => loader.load(entry)}
    >
      {loading
        ? "Loading…"
        : `Load ${label} (${formatBytes(entry.text_bytes)})`}
    </button>
  );
}

function ToolArguments({
  call,
  onOpen,
}: {
  call: HistoryEntry;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const allFields = toolArgumentFields(call.text);
  if (allFields.length === 0) {
    return <p className="agent-history-chat-step-empty">No arguments</p>;
  }
  const { fields, truncated } = previewToolArgumentFields(
    allFields,
    HISTORY_PREVIEW_CHARS,
  );
  return (
    <>
      <dl className="agent-history-chat-args">
        {fields.map((field, index) => (
          <div
            key={field.key || index}
            className={field.code ? "is-code" : undefined}
          >
            {field.key ? <dt>{field.key}</dt> : null}
            <dd>{field.code ? <pre>{field.value}</pre> : field.value}</dd>
          </div>
        ))}
      </dl>
      {truncated ? (
        <button
          type="button"
          className="agent-history-chat-more"
          onClick={() => onOpen(call)}
        >
          View full arguments
        </button>
      ) : null}
    </>
  );
}

function ToolStepDetail({
  step,
  loader,
  onOpen,
}: {
  step: ToolStep;
  loader: ToolContentLoader;
  onOpen: (entry: HistoryEntry) => void;
}) {
  const { call, result } = step;
  const output = result?.text.slice(0, HISTORY_PREVIEW_CHARS) ?? "";
  return (
    <div className="agent-history-chat-step-detail">
      {call ? (
        <section>
          <h4>Arguments</h4>
          {isToolContentPending(call) ? (
            <ToolContentLoad entry={call} label="arguments" loader={loader} />
          ) : (
            <ToolArguments call={call} onOpen={onOpen} />
          )}
        </section>
      ) : null}
      <section>
        <h4>{result?.is_error ? "Error" : "Output"}</h4>
        {!result ? (
          <p className="agent-history-chat-step-empty">
            No output recorded yet
          </p>
        ) : isToolContentPending(result) ? (
          <ToolContentLoad entry={result} label="output" loader={loader} />
        ) : output ? (
          <>
            <pre className="agent-history-chat-step-output">{output}</pre>
            {output.length < result.text.length ? (
              <button
                type="button"
                className="agent-history-chat-more"
                onClick={() => onOpen(result)}
              >
                View full output
              </button>
            ) : null}
          </>
        ) : (
          <p className="agent-history-chat-step-empty">Empty output</p>
        )}
      </section>
    </div>
  );
}

/** What a call wrote in Roamgate, its row opened: the words, whole. */
function WrittenDetail({
  step,
  write,
  loader,
  onOpen,
}: {
  step: ToolStep;
  write: RoamgateWrite;
  loader: ToolContentLoader;
  onOpen: (entry: HistoryEntry) => void;
}) {
  // Cut, or nothing to show: the call's arguments and output, as any call.
  if (!write.text || write.clipped)
    return <ToolStepDetail step={step} loader={loader} onOpen={onOpen} />;
  return (
    <div className="agent-history-chat-step-detail">
      <section>
        <h4>{write.where ? `Written on ${write.where}` : "Written"}</h4>
        <MarkdownPreview
          text={write.text}
          className="agent-history-chat-markdown agent-history-chat-step-written"
          breaks
        />
      </section>
    </div>
  );
}

const WRITE_LINK_TITLES: Record<RoamgateWrite["action"], string> = {
  reply: "Open the thread at this reply",
  comment: "Open the thread",
  draft: "Open the review comment",
  edit: "Open the thread at this comment",
};

function ToolStepRow({
  step,
  expanded,
  loader,
  onToggle,
  onOpen,
  write,
}: {
  step: ToolStep;
  expanded: boolean;
  loader: ToolContentLoader;
  onToggle: () => void;
  onOpen: (entry: HistoryEntry) => void;
  /** What the call wrote in Roamgate: the row links to it. */
  write?: RoamgateWrite;
}) {
  const { call, result } = step;
  // Dismissed from Roamgate, unanswered: said so, not as a failure.
  const status = stepStatus(step);
  const headline =
    toolStepSummary(step) ||
    (call && loader.loading.has(call.id) ? "Loading…" : "");
  const sentAt = (call ?? result)?.sent_at;
  return (
    <li
      className={`agent-history-chat-step is-${status} ${expanded ? "is-expanded" : ""}${write ? " is-write" : ""}`}
    >
      <button
        type="button"
        className="agent-history-chat-step-row"
        aria-expanded={expanded}
        title={sentAt ? formatUiDateTime(sentAt) : undefined}
        onClick={onToggle}
      >
        {status === "done" ? (
          <Check size={12} aria-label="Succeeded" />
        ) : status === "error" ? (
          <X size={12} aria-label="Failed" />
        ) : status === "dismissed" ? (
          <CircleSlash size={12} aria-label="Dismissed" />
        ) : (
          <Wrench size={12} aria-label="No output yet" />
        )}
        <span className="agent-history-chat-step-name">
          {toolDisplayName(step.name)}
        </span>
        {status === "dismissed" ? (
          <span className="agent-history-chat-step-dismissed">Dismissed</span>
        ) : null}
        <span className="agent-history-chat-step-headline">{headline}</span>
      </button>
      {write && canOpenRoamgateWrite(write) ? (
        <button
          type="button"
          className="agent-history-chat-step-link"
          title={WRITE_LINK_TITLES[write.action]}
          aria-label={WRITE_LINK_TITLES[write.action]}
          onClick={() => openRoamgateWrite(write)}
        >
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      ) : null}
      {expanded ? (
        write ? (
          <WrittenDetail
            step={step}
            write={write}
            loader={loader}
            onOpen={onOpen}
          />
        ) : (
          <ToolStepDetail step={step} loader={loader} onOpen={onOpen} />
        )
      ) : null}
    </li>
  );
}

function stepStatus(step: ToolStep) {
  const { result } = step;
  return !result
    ? "pending"
    : result.dismissed
      ? "dismissed"
      : result.is_error
        ? "error"
        : "done";
}

// A collapsed group's progress: what its running steps and its last finished
// ones do, one line each.
export function ToolProgress({ steps }: { steps: readonly ToolStep[] }) {
  const { visible, earlier } = collapsedToolProgress(steps);
  if (!visible.length) return null;
  return (
    <ul className="agent-history-chat-progress" aria-label="Tool progress">
      {earlier > 0 ? (
        <li className="agent-history-chat-progress-earlier">
          +{earlier} earlier
        </li>
      ) : null}
      {visible.map((step) => {
        const status = stepStatus(step);
        const summary = toolStepSummary(step);
        return (
          <li
            key={step.id}
            className={`agent-history-chat-progress-step is-${status}`}
          >
            {status === "done" ? (
              <Check size={11} aria-label="Succeeded" />
            ) : status === "error" ? (
              <X size={11} aria-label="Failed" />
            ) : status === "dismissed" ? (
              <CircleSlash size={11} aria-label="Dismissed" />
            ) : (
              <Loader2
                size={11}
                className="agent-history-chat-progress-spin"
                aria-label="Running"
              />
            )}
            <span className="agent-history-chat-progress-text">
              {summary || toolDisplayName(step.name)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The file edits of a block's calls: what the transcript's entry says
 * (Claude Code's patch, kept when the payload is withheld), else what a
 * streamed call's arguments ask. A failed call changed nothing. With the
 * call, which comments on the change are on.
 */
export function stepFileEdits(steps: readonly ToolStep[]): {
  id: string;
  edit: FileEdit;
  pending: boolean;
  call: HistoryEntry;
}[] {
  return steps.flatMap((step) => {
    const { call, result } = step;
    if (!call || result?.is_error) return [];
    const edit =
      call.file_edit ??
      (isToolContentPending(call)
        ? null
        : fileEditFromArgumentText(step.name, call.text));
    return edit ? [{ id: step.id, edit, pending: !result, call }] : [];
  });
}

// Collapsed by default; the block keeps its open state across polling
// refreshes because its key follows the first entry's id.
type ToolBlockProps = {
  /** The block's item id: where a reader's place is kept by. */
  placeId: string;
  entries: HistoryEntry[];
  loader: ToolContentLoader;
  // Called before the reader opens or closes part of the block.
  onToggle: () => void;
  onOpen: (entry: HistoryEntry) => void;
  tasks?: ReadonlyMap<string, AgentTask>;
  onOpenTask?: (id: string) => void;
  /** The tool calls that run now, by tool_use id (conversation mode). */
  running?: ReadonlySet<string>;
  /** Moves a running command or subagent to the background. */
  onBackground?: (toolUseId: string) => Promise<boolean> | void;
};

/** Tools whose running call can go on in the background (Ctrl+B). */
const BACKGROUND_TOOLS = new Set(["Bash", "Agent", "Task"]);

/**
 * The block's calls that run in the foreground and can be moved to the
 * background: a command or a subagent the agent waits for.
 */
export function backgroundableSteps(
  steps: readonly ToolStep[],
  running: ReadonlySet<string> | undefined,
): { id: string; step: ToolStep }[] {
  if (!running?.size) return [];
  return steps.flatMap((step) => {
    const id = step.call?.source_call_id;
    return id &&
      !step.result &&
      running.has(id) &&
      BACKGROUND_TOOLS.has(step.name)
      ? [{ id, step }]
      : [];
  });
}

/** Whether the block's calls run now as they did: only its own calls count. */
function sameBlockRunning(
  entries: readonly HistoryEntry[],
  a: ToolBlockProps["running"],
  b: ToolBlockProps["running"],
): boolean {
  if (a === b) return true;
  return entries.every((entry) => {
    const id = entry.kind === "tool_call" ? entry.source_call_id : undefined;
    return !id || (a?.has(id) ?? false) === (b?.has(id) ?? false);
  });
}
/**
 * Whether the background tasks the block's calls started are the same: the
 * session's task list is read anew every few seconds, and only a block
 * whose own tasks changed is drawn again.
 */
function sameBlockTasks(
  entries: readonly HistoryEntry[],
  a: ToolBlockProps["tasks"],
  b: ToolBlockProps["tasks"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const entry of entries) {
    const id = entry.kind === "tool_call" ? entry.source_call_id : undefined;
    if (!id) continue;
    const x = a.get(id);
    const y = b.get(id);
    if (x !== y && (!x || !y || JSON.stringify(x) !== JSON.stringify(y)))
      return false;
  }
  return true;
}

/**
 * Whether the loader is the same for the block: its set of payloads being
 * fetched changes with every fetch of any block, and only the blocks whose
 * own payloads started or finished loading are drawn again.
 */
function sameBlockLoader(
  entries: readonly HistoryEntry[],
  a: ToolContentLoader,
  b: ToolContentLoader,
): boolean {
  if (a === b) return true;
  if (a.load !== b.load || a.enqueue !== b.enqueue) return false;
  return entries.every(
    (entry) => a.loading.has(entry.id) === b.loading.has(entry.id),
  );
}

// Grouping builds a new entries list on every refresh: a block re-renders
// only when one of its entries, or one of the tasks they started, changed.
function sameToolBlock(a: ToolBlockProps, b: ToolBlockProps): boolean {
  return (
    a.placeId === b.placeId &&
    sameBlockLoader(b.entries, a.loader, b.loader) &&
    a.onToggle === b.onToggle &&
    a.onOpen === b.onOpen &&
    a.onOpenTask === b.onOpenTask &&
    a.onBackground === b.onBackground &&
    sameBlockRunning(b.entries, a.running, b.running) &&
    a.entries.length === b.entries.length &&
    a.entries.every((entry, index) =>
      sameHistoryEntry(entry, b.entries[index]!),
    ) &&
    sameBlockTasks(b.entries, a.tasks, b.tasks)
  );
}

const ToolBlock = memo(function ToolBlock({
  placeId,
  entries,
  loader,
  onToggle,
  onOpen,
  tasks,
  onOpenTask,
  running,
  onBackground,
}: ToolBlockProps) {
  useRenderTrace("ToolBlock");
  // The pages these calls published, the latest version of each.
  const artifacts = [
    ...new Map(
      entries.flatMap((entry) =>
        entry.artifact ? [[entry.artifact.url, entry.artifact] as const] : [],
      ),
    ).values(),
  ];
  // The background commands and subagents these calls started.
  const started = tasks
    ? entries.flatMap((entry) => {
        const task =
          entry.kind === "tool_call" && entry.source_call_id
            ? tasks.get(entry.source_call_id)
            : undefined;
        return task ? [task] : [];
      })
    : [];
  const [open, setOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const listId = useId();
  const steps = useMemo(() => pairToolSteps(entries), [entries]);
  // The files these calls changed, shown as the terminal shows them.
  const edits = useMemo(() => stepFileEdits(steps), [steps]);
  // What these calls wrote in Roamgate (replies in threads, new threads):
  // shown as their rows, linking there, while the block is closed too.
  const writes = useMemo(
    () =>
      new Map(
        steps.flatMap((step) => {
          const write = toolStepWrite(step);
          return write ? [[step.id, write] as const] : [];
        }),
      ),
    [steps],
  );
  // The commands and subagents the turn waits for, which can go on in the
  // background; the ones asked to, until their call returns.
  const foreground = onBackground ? backgroundableSteps(steps, running) : [];
  const [moving, setMoving] = useState<ReadonlySet<string>>(() => new Set());
  // Each payload version is queued and fetched directly at most once per
  // block, so a failed fetch does not loop on every polling refresh; the Load
  // buttons still retry. A payload rewritten under the same id is a new
  // version and loads again. Opening a step fetches directly even if its
  // arguments are still waiting in the background queue.
  const queuedRef = useRef(new Set<string>());
  const fetchedRef = useRef(new Set<string>());
  const { load, enqueue } = loader;
  useEffect(() => {
    if (!open) return;
    for (const { call } of steps) {
      if (
        !call ||
        !isToolContentPending(call) ||
        (call.text_bytes ?? 0) > AUTO_LOAD_ARGUMENT_BYTES ||
        queuedRef.current.has(toolPayloadKey(call)) ||
        fetchedRef.current.has(toolPayloadKey(call))
      )
        continue;
      queuedRef.current.add(toolPayloadKey(call));
      enqueue(call);
    }
  }, [enqueue, open, steps]);
  useEffect(() => {
    const step = steps.find((item) => item.id === expandedStep);
    if (!step) return;
    for (const entry of [step.call, step.result]) {
      if (
        !entry ||
        !isToolContentPending(entry) ||
        fetchedRef.current.has(toolPayloadKey(entry))
      )
        continue;
      fetchedRef.current.add(toolPayloadKey(entry));
      load(entry);
    }
  }, [expandedStep, load, steps]);
  const summary = summarizeToolSteps(steps);
  const callsLabel = `${summary.calls} tool ${summary.calls === 1 ? "call" : "calls"}`;
  const toolsLabel = summary.tools
    .map(({ name, count }) => {
      const label = toolDisplayName(name);
      return count > 1 ? `${label} ×${count}` : label;
    })
    .join(", ");
  return (
    <div
      className={`agent-history-chat-tools ${open ? "is-open" : ""}`}
      data-place-id={placeId}
    >
      <button
        type="button"
        className="agent-history-chat-tools-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={open ? "Collapse tool calls" : "Expand tool calls"}
        onClick={() => {
          onToggle();
          setOpen((current) => !current);
        }}
      >
        <ChevronRight
          size={12}
          className="agent-history-chat-tools-chevron"
          aria-hidden="true"
        />
        <Wrench size={12} aria-hidden="true" />
        <span className="agent-history-chat-tools-label">
          <strong>{callsLabel}</strong>
          <span className="agent-history-chat-tools-names">{toolsLabel}</span>
          {summary.errors > 0 ? (
            <span className="agent-history-chat-tools-errors">
              {summary.errors} {summary.errors === 1 ? "error" : "errors"}
            </span>
          ) : null}
          {summary.dismissed > 0 ? (
            <span className="agent-history-chat-step-dismissed">
              {summary.dismissed === 1
                ? "Dismissed"
                : `${summary.dismissed} dismissed`}
            </span>
          ) : null}
        </span>
      </button>
      {artifacts.length ? (
        <div className="agent-history-chat-artifacts">
          {artifacts.map((artifact) => (
            <a
              key={artifact.url}
              className="agent-history-chat-artifact"
              href={artifact.url}
              target="_blank"
              rel="noopener noreferrer"
              title={artifact.url}
            >
              <ExternalLink size={12} aria-hidden="true" />
              <span>{artifact.title}</span>
              <span className="agent-history-chat-artifact-version">
                {artifact.version ? `v${artifact.version}` : "New"}
              </span>
            </a>
          ))}
        </div>
      ) : null}
      {started.length ? (
        <div className="agent-history-chat-tasks">
          {started.map((task) => (
            <button
              key={task.id}
              type="button"
              className="agent-history-chat-task"
              onClick={() => onOpenTask?.(task.id)}
            >
              <span>{task.title}</span>
              <span className={`agent-task-status is-${task.status}`}>
                {taskStatusLabel(task)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {foreground.length ? (
        <div className="agent-history-chat-tasks">
          {foreground.map(({ id, step }) => (
            <button
              key={id}
              type="button"
              className="agent-history-chat-task is-foreground"
              disabled={moving.has(id)}
              title="Move it to the background (Ctrl+B): the turn goes on while it runs"
              onClick={() => {
                setMoving((current) => new Set(current).add(id));
                // Not moved (it ended meanwhile, or the agent refused):
                // the button is offered again while it runs.
                void Promise.resolve(onBackground?.(id)).then((moved) => {
                  if (moved === false)
                    setMoving((current) => {
                      const next = new Set(current);
                      next.delete(id);
                      return next;
                    });
                });
              }}
            >
              <span>{toolStepSummary(step) || toolDisplayName(step.name)}</span>
              <span className="agent-task-status">
                <ArrowDownToLine size={11} aria-hidden="true" />
                {moving.has(id) ? "Moving…" : "Background"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {edits.length ? (
        <div className="agent-history-chat-edits">
          {edits.map(({ id, edit, pending, call }) => (
            <ChatFileEdit
              key={id}
              edit={edit}
              state={pending ? "running" : "done"}
              call={call}
            />
          ))}
        </div>
      ) : null}
      {!open && writes.size ? (
        <ul
          className="agent-history-chat-tools-list agent-history-chat-writes"
          aria-label="Written in Roamgate"
        >
          {steps
            .filter((step) => writes.has(step.id))
            .map((step) => (
              <ToolStepRow
                key={step.id}
                step={step}
                expanded={expandedStep === step.id}
                loader={loader}
                onToggle={() => {
                  onToggle();
                  setExpandedStep((current) =>
                    current === step.id ? null : step.id,
                  );
                }}
                onOpen={onOpen}
                write={writes.get(step.id)}
              />
            ))}
        </ul>
      ) : null}
      {!open ? (
        <ToolProgress
          steps={
            writes.size ? steps.filter((step) => !writes.has(step.id)) : steps
          }
        />
      ) : null}
      {open ? (
        <ul id={listId} className="agent-history-chat-tools-list">
          {steps.map((step) => (
            <ToolStepRow
              key={step.id}
              step={step}
              expanded={expandedStep === step.id}
              loader={loader}
              onToggle={() => {
                onToggle();
                setExpandedStep((current) =>
                  current === step.id ? null : step.id,
                );
              }}
              onOpen={onOpen}
              write={writes.get(step.id)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}, sameToolBlock);

// The drawer owns the scroll and content refs so its minimap can track and
// jump to bubbles through their data-sequence, as it does for timeline cards.
// Memoized: the pane around it re-renders on every pane update (status,
// activity), several times a second while the agent works, and a long
// conversation is too costly to render each time; its props only change
// with the history.
/**
 * What the chat lists: its messages and tool blocks, and what a surface
 * draws between them itself (Ranger's action and task cards, its reasoning
 * and the workspaces it read), keyed by `id`.
 */
export type ChatItem =
  | HistoryChatItem
  | {
      type: "custom";
      id: string;
      node: ReactNode;
      /** Not what a reader's place is kept by: a loading row. */
      transient?: boolean;
    };

/** The reply block a message shows, the same streamed then saved. */
function blockOf(entry: HistoryEntry): string | undefined {
  return entry.message_id
    ? `${entry.message_id}:${entry.block_index ?? 0}`
    : undefined;
}

function itemTime(item: ChatItem): number {
  const at =
    item.type === "message"
      ? item.entry.sent_at
      : item.type === "tools"
        ? item.entries[0]?.sent_at
        : undefined;
  return at ? Date.parse(at) : Number.NaN;
}

function itemKey(item: ChatItem): string {
  return item.type === "message" ? item.entry.id : item.id;
}

/** What an item's message says of itself, for a place kept on it. */
function describeItem(
  items: readonly ChatItem[],
  id: string,
): Pick<ChatAnchor, "block" | "at"> {
  const item = items.find((candidate) => itemKey(candidate) === id);
  if (!item || item.type === "custom") return {};
  const entry = item.type === "message" ? item.entry : item.entries[0];
  const block = item.type === "message" ? blockOf(item.entry) : undefined;
  return {
    ...(block ? { block } : {}),
    ...(entry?.sent_at ? { at: entry.sent_at } : {}),
  };
}

/** The newest message: the last one a reader at the end has seen. */
function lastSeen(items: readonly ChatItem[]): ChatSeen | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.type !== "message") continue;
    const block = blockOf(item.entry);
    return {
      id: item.entry.id,
      ...(block ? { block } : {}),
      ...(item.entry.sent_at ? { at: item.entry.sent_at } : {}),
    };
  }
  return null;
}

/** How many messages came after the one seen last at the end. */
function unseenAfter(
  items: readonly ChatItem[],
  seen: ChatSeen | null,
): number {
  if (!seen) return 0;
  const messages = items.filter(
    (item): item is Extract<ChatItem, { type: "message" }> =>
      item.type === "message",
  );
  let at = messages.findIndex((item) => item.entry.id === seen.id);
  if (at < 0 && seen.block)
    at = messages.findIndex((item) => blockOf(item.entry) === seen.block);
  if (at >= 0) return messages.length - 1 - at;
  // Under another id, or past the window: by when it was written.
  const time = seen.at ? Date.parse(seen.at) : Number.NaN;
  if (Number.isNaN(time)) return 0;
  return messages.filter((item) => itemTime(item) > time).length;
}

export const AgentHistoryChat = memo(function AgentHistoryChat({
  items,
  listRef,
  contentRef,
  highlightedSequence = null,
  followKey,
  toolLoading = EMPTY_LOADING,
  onLoadTool = noop,
  speechActive = true,
  speechScopeKey = "",
  onOpen,
  outbox = NO_OUTBOX,
  onRetrySend,
  onDiscardSend,
  tasks,
  onOpenTask,
  running,
  onBackground,
  onRemoveQueued,
  onEditQueued,
  queuedHandedOver,
  onRewind,
  onRewindCheck,
  onSendAgain,
  onEditAgain,
  imageUrl,
  sentImageUrl,
  cutOff = null,
  modelNotice = null,
  delivery = null,
  apiKeyQuestion = null,
  notices = null,
  placeKey = null,
  placeReady = true,
  older,
}: {
  items: ChatItem[];
  listRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  highlightedSequence?: number | null;
  // Changing this (e.g. a new search) jumps back to the newest message.
  followKey?: string;
  // Tool entries whose redacted payload is being fetched.
  toolLoading?: ReadonlySet<string>;
  onLoadTool?: (entry: HistoryEntry) => void;
  speechActive?: boolean;
  speechScopeKey?: string;
  onOpen: (entry: HistoryEntry) => void;
  /** Messages sent that the transcript does not show yet, oldest first. */
  outbox?: readonly OutboxMessage[];
  onRetrySend?: (message: OutboxMessage) => void;
  onDiscardSend?: (message: OutboxMessage) => void;
  /** The session's background tasks, by the tool call that started each. */
  tasks?: ReadonlyMap<string, AgentTask>;
  onOpenTask?: (id: string) => void;
  /** The tool calls that run now, by tool_use id (conversation mode). */
  running?: ReadonlySet<string>;
  /** Moves a running command or subagent to the background (Ctrl+B). */
  onBackground?: (toolUseId: string) => Promise<boolean> | void;
  /** Takes a queued message back before the agent reads it. */
  onRemoveQueued?: (entry: HistoryEntry) => void;
  /** Takes a queued message back into the box to edit. */
  onEditQueued?: (entry: HistoryEntry) => void;
  /** A queued message the agent holds already, which cannot be taken back. */
  queuedHandedOver?: (entry: HistoryEntry) => boolean;
  /** Rewinds the session to before a message of the user's. */
  onRewind?: (entry: HistoryEntry, mode: RewindMode) => void;
  /** What a rewind to before a message could do to the code. */
  onRewindCheck?: (entry: HistoryEntry) => Promise<AgentChatRewindCheck>;
  /** Sends again a message of the user's a rewind cut. */
  onSendAgain?: (text: string) => Promise<unknown> | void;
  /** Puts a message of the user's a rewind cut back in the box. */
  onEditAgain?: (text: string) => void;
  /** Where an image the user uploaded loads from; none shows the path. */
  imageUrl?: (path: string) => string;
  /** Where an image sent inline in a message loads from. */
  sentImageUrl?: SentImageUrl;
  /** The last turn was cut short: said after the last entry. */
  cutOff?: ChatCutOff | null;
  /** What the last /model did: said after the last entry. */
  modelNotice?: ChatModelNotice | null;
  /** Nothing sent goes out (a lost process, a stalled queue): Recover. */
  delivery?: ChatDelivery | null;
  /** Claude waits to start until the user says which account pays. */
  apiKeyQuestion?: ChatApiKeyQuestion | null;
  /** Roamgate's own notices after the last message (a usage limit pause). */
  notices?: ReactNode;
  /**
   * Where the reader is is kept under this key (chatPlace.ts) and given
   * back when the chat is shown again: after another pane, workspace or
   * connection, the terminal in its place, a reload. None: the chat opens
   * at its end. Messages coming in under a kept place do not move it; a
   * pill says how many came.
   */
  placeKey?: string | null;
  /**
   * The conversation was read since the chat showed: a place not among
   * the messages shown is looked for (or given up) only then.
   */
  placeReady?: boolean;
  /** Older messages, read to give back a place among them. */
  older?: OlderMessages;
}) {
  const speech = useChatSpeech(speechActive, speechScopeKey);
  useRenderTrace("AgentHistoryChat");
  // What the bubbles and blocks are given keeps its identity: the drawer makes new
  // callbacks as its state moves (a send, a turn, the message box), and the
  // speech state changes with every message read aloud; either drew every
  // bubble of a long conversation again, a keystroke or a stream update
  // waiting behind it. The bubbles call the latest ones.
  const latest = useRef({
    onOpen,
    onRemoveQueued,
    onEditQueued,
    onRewind,
    onRewindCheck,
    onSendAgain,
    onEditAgain,
    onOpenTask,
    onBackground,
    speech,
  });
  latest.current = {
    onOpen,
    onRemoveQueued,
    onEditQueued,
    onRewind,
    onRewindCheck,
    onSendAgain,
    onEditAgain,
    onOpenTask,
    onBackground,
    speech,
  };
  const stable = useMemo(
    () => ({
      onOpen: (entry: HistoryEntry) => latest.current.onOpen(entry),
      onRemoveQueued: (entry: HistoryEntry) =>
        latest.current.onRemoveQueued?.(entry),
      onEditQueued: (entry: HistoryEntry) =>
        latest.current.onEditQueued?.(entry),
      onRewind: (entry: HistoryEntry, mode: RewindMode) =>
        latest.current.onRewind?.(entry, mode),
      onRewindCheck: (entry: HistoryEntry) =>
        latest.current.onRewindCheck
          ? latest.current.onRewindCheck(entry)
          : Promise.reject(new Error("rewind is not available")),
      onSendAgain: (text: string) => latest.current.onSendAgain?.(text),
      onEditAgain: (text: string) => latest.current.onEditAgain?.(text),
      onOpenTask: (id: string) => latest.current.onOpenTask?.(id),
      onBackground: (id: string) => latest.current.onBackground?.(id),
      toggleSpeech: (messageId: string, markdown: string) =>
        latest.current.speech.toggle(messageId, markdown),
    }),
    [],
  );
  // Only the bubble being read aloud gets the speech state.
  const quietSpeech = useMemo<BubbleProps["speech"]>(
    () => ({
      supported: speech.supported,
      state: null,
      toggle: stable.toggleSpeech,
    }),
    [speech.supported, stable],
  );
  const followRef = useRef(true);
  const queueRef = useRef<HistoryEntry[]>([]);
  const [queueVersion, setQueueVersion] = useState(0);
  const enqueue = useCallback((entry: HistoryEntry) => {
    queueRef.current.push(entry);
    setQueueVersion((version) => version + 1);
  }, []);
  // Payload versions already fetched by any path; the queue skips them.
  const startedRef = useRef(new Set<string>());
  const load = useCallback(
    (entry: HistoryEntry) => {
      startedRef.current.add(toolPayloadKey(entry));
      onLoadTool(entry);
    },
    [onLoadTool],
  );
  // Start queued fetches whenever a slot frees up: the loading set shrinks as
  // the drawer's fetches settle, which re-runs this effect.
  useEffect(() => {
    const { start, rest } = takeQueuedToolLoads(queueRef.current, {
      inFlight: toolLoading.size,
      limit: BACKGROUND_LOADS_IN_FLIGHT,
      started: startedRef.current,
      loadingIds: toolLoading,
    });
    queueRef.current = rest;
    for (const entry of start) load(entry);
  }, [load, queueVersion, toolLoading]);
  const loader = useMemo(
    () => ({ loading: toolLoading, load, enqueue }),
    [toolLoading, load, enqueue],
  );
  // Opening a block or step grows the list under the reader; stop following
  // so that growth (and the payloads it loads) does not scroll it away.
  // Scrolling back to the bottom resumes following.
  const pauseFollow = useCallback(() => {
    followRef.current = false;
  }, []);

  // Only the items near the view are drawn (chatMountWindow), and those
  // a jump goes to: the message a search highlights, those with comment
  // threads (the threads' panel and j / k go to them).
  const mountWindow = useMountWindow(listRef, contentRef, items.length);
  const threaded = useChatThreadedEntries();
  const pinnedItem = useCallback(
    (item: ChatItem) =>
      item.type === "message"
        ? item.sequence === highlightedSequence ||
          (threaded?.has(item.entry.id) ?? false)
        : item.type === "tools" &&
          !!threaded &&
          item.entries.some((entry) => threaded.has(entry.id)),
    [highlightedSequence, threaded],
  );

  // What a place needs of the items: their ids, blocks and times.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const olderRef = useRef(older);
  olderRef.current = older;
  const placeReadyRef = useRef(placeReady);
  placeReadyRef.current = placeReady;
  const placeKeyRef = useRef(placeKey);
  /**
   * A kept place being given back: looked for (older messages read for
   * it), then held a moment while what is drawn settles.
   */
  const restoreRef = useRef<{
    anchor: ChatAnchor;
    found: boolean;
    pages: number;
    until: number;
  } | null>(null);
  // Where the reader was when the list last showed: hidden and shown
  // again (the phone's workspaces sheet), it lost its scroll.
  const shownRef = useRef<ChatAnchor | null>(null);
  // The last message the reader saw at the end, and how many came since.
  const seenRef = useRef<ChatSeen | null>(null);
  const [unseen, setUnseen] = useState(0);

  useLayoutEffect(() => {
    followRef.current = true;
    restoreRef.current = null;
  }, [followKey]);

  // The chat drawn again: the place kept for it comes back, else its end.
  useLayoutEffect(() => {
    placeKeyRef.current = placeKey;
    const place = placeKey ? readChatPlace(placeKey) : null;
    seenRef.current = place?.seen ?? null;
    shownRef.current = place?.anchor ?? null;
    restoreRef.current = place?.anchor
      ? { anchor: place.anchor, found: false, pages: 0, until: 0 }
      : null;
    followRef.current = !restoreRef.current;
  }, [placeKey]);

  // Keys in the conversation (j / k, a comment being written): what arrives
  // or grows does not move it under the reader.
  const reading = useCallback(() => {
    const list = listRef.current;
    const active = document.activeElement;
    return !!list && !!active && list.contains(active);
  }, [listRef]);

  /** Keeps where the reader is, for when the chat is drawn again. */
  const record = useCallback(() => {
    const key = placeKeyRef.current;
    const list = listRef.current;
    const content = contentRef.current;
    const restoring = restoreRef.current;
    // Hidden, or still looking for the place: what shows is not it.
    if (!list || !content || list.clientHeight === 0) return;
    if (restoring && !restoring.found) return;
    const anchor = followRef.current
      ? null
      : readChatAnchor(list, content, (id) =>
          describeItem(itemsRef.current, id),
        );
    shownRef.current = anchor;
    const seen = seenRef.current;
    if (key) rememberChatPlace(key, { anchor, ...(seen ? { seen } : {}) });
  }, [listRef, contentRef]);

  /**
   * Puts the place being given back in view, reading older messages for
   * it when it is older than those shown. Gone from the chat (a rewind
   * cut it, the window moved past it), the first message written since
   * takes its place, else the end does.
   */
  const restore = useCallback(() => {
    const restoring = restoreRef.current;
    const list = listRef.current;
    const content = contentRef.current;
    if (!restoring || !list || !content || list.clientHeight === 0) return;
    if (
      restoring.found &&
      (followRef.current || Date.now() > restoring.until)
    ) {
      restoreRef.current = null;
      return;
    }
    if (placeChatAnchor(list, content, restoring.anchor)) {
      if (!restoring.found) {
        restoring.found = true;
        restoring.until = Date.now() + PLACE_HOLD_MS;
      }
      followRef.current = false;
      return;
    }
    // Shown, then gone: the view stays where it is.
    if (restoring.found) {
      restoreRef.current = null;
      return;
    }
    if (!placeReadyRef.current) return;
    const items = itemsRef.current;
    const older = olderRef.current;
    const at = restoring.anchor.at
      ? Date.parse(restoring.anchor.at)
      : Number.NaN;
    const oldest = items.map(itemTime).find((time) => !Number.isNaN(time));
    const before = Number.isNaN(at) || oldest === undefined || at <= oldest;
    if (before && older?.more && restoring.pages < PLACE_SEEK_PAGES) {
      if (!older.loading) {
        restoring.pages += 1;
        older.load();
      }
      return;
    }
    if (older?.loading) return;
    restoreRef.current = null;
    const since = Number.isNaN(at)
      ? undefined
      : items.find((item) => itemTime(item) >= at);
    const element = since
      ? findChatAnchorItem(content, { id: itemKey(since) })
      : null;
    if (element) {
      followRef.current = false;
      scrollChatTo(list, element, restoring.anchor.offset);
    } else {
      followRef.current = true;
      list.scrollTop = list.scrollHeight;
    }
  }, [listRef, contentRef]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    if (restoreRef.current) {
      restore();
      // Again once the drawer moved the list itself in this commit (older
      // messages put in front keep its first one in place), before the
      // frame is drawn.
      frame = requestAnimationFrame(restore);
    }
    const following = !restoreRef.current && followRef.current && !reading();
    if (following) list.scrollTop = list.scrollHeight;
    // At the end, or back somewhere with nothing said of what was seen:
    // what shows is seen. Only a chat that keeps places says what came.
    if (placeKeyRef.current) {
      if (following || !seenRef.current) seenRef.current = lastSeen(items);
      setUnseen(following ? 0 : unseenAfter(items, seenRef.current));
    }
    return frame ? () => cancelAnimationFrame(frame) : undefined;
  }, [items, listRef, reading, restore]);

  // A page of older messages read, or the conversation read: the place
  // being looked for may be among them now.
  const olderLoading = older?.loading;
  const olderMore = older?.more;
  useLayoutEffect(() => {
    if (restoreRef.current) restore();
  }, [olderLoading, olderMore, placeReady, restore]);

  // The reader moving (wheel, touch, keys, the scrollbar) is where they
  // want to be: a place still being given back gives way.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const moved = () => {
      restoreRef.current = null;
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const name of events)
      list.addEventListener(name, moved, { passive: true });
    return () => {
      for (const name of events) list.removeEventListener(name, moved);
    };
  }, [listRef]);

  /** The pill under new messages: to the end, following again. */
  const toEnd = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    restoreRef.current = null;
    followRef.current = true;
    list.scrollTop = list.scrollHeight;
    seenRef.current = lastSeen(itemsRef.current);
    setUnseen(0);
    record();
  }, [listRef, record]);

  // Bubbles skip drawing when only their place in the window moved (see
  // sameBubble): their data-sequence, which the minimap and its jumps go by,
  // is kept current here.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const sequences = new Map<string, number>();
    for (const item of items)
      if (item.type === "message") sequences.set(item.entry.id, item.sequence);
    for (const bubble of content.querySelectorAll<HTMLElement>(
      ":scope > [data-bubble-id]",
    )) {
      const sequence = sequences.get(bubble.dataset.bubbleId ?? "");
      if (sequence !== undefined && bubble.dataset.sequence !== `${sequence}`)
        bubble.dataset.sequence = `${sequence}`;
    }
  }, [items, contentRef]);

  // A message just sent is shown where the conversation goes on. One on
  // its way when the chat is drawn again leaves the reader's place be.
  const lastOutboxId = outbox[outbox.length - 1]?.id;
  const outboxShownRef = useRef(lastOutboxId);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (outboxShownRef.current === lastOutboxId) return;
    outboxShownRef.current = lastOutboxId;
    if (!list || !lastOutboxId) return;
    restoreRef.current = null;
    followRef.current = true;
    list.scrollTop = list.scrollHeight;
  }, [lastOutboxId, listRef]);

  // Re-pin after layout changes the list did not cause itself: the inspector
  // revealing a hidden view, a resized pane, or lazy markdown (diagrams,
  // images) growing a bubble after its first paint.
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    let shown = list.clientHeight > 0;
    // Where the reader was when the list was hidden (null: at the end).
    let hiddenAt: ChatAnchor | null = null;
    const observer = new ResizeObserver(() => {
      const visible = list.clientHeight > 0;
      const hidden = !visible && shown;
      const reshown = visible && !shown;
      shown = visible;
      // Hidden (the phone's workspaces sheet): nothing to pin, and the
      // reader's place stays theirs.
      if (hidden)
        hiddenAt =
          followRef.current && !restoreRef.current ? null : shownRef.current;
      if (!visible) return;
      // Shown again, the list lost its scroll: the place it had comes back,
      // else its end.
      if (reshown && !restoreRef.current) {
        if (hiddenAt)
          restoreRef.current = {
            anchor: hiddenAt,
            found: false,
            pages: 0,
            until: 0,
          };
        else followRef.current = true;
      }
      if (restoreRef.current) {
        restore();
        if (restoreRef.current) return;
      }
      // A list that does not overflow is at its newest message already.
      if (list.scrollHeight <= list.clientHeight) followRef.current = true;
      if (followRef.current && !reading()) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, [listRef, contentRef, reading, restore]);

  return (
    <div
      ref={listRef}
      className="agent-history-chat"
      onScroll={(event) => {
        const list = event.currentTarget;
        // A hidden list reports zero geometry; keep the last pin state.
        if (list.clientHeight === 0) return;
        // Still looking for the place: what shows meanwhile is not it.
        const restoring = restoreRef.current;
        if (restoring && !restoring.found) return;
        const atEnd =
          list.scrollHeight - list.scrollTop - list.clientHeight <
          FOLLOW_THRESHOLD_PX;
        followRef.current = atEnd;
        if (atEnd) {
          seenRef.current = lastSeen(itemsRef.current);
          setUnseen(0);
        }
        record();
      }}
    >
      <div ref={contentRef} className="agent-history-chat-content">
        {items.map((item, index) =>
          item.type !== "custom" &&
          !mountWindow.drawn(itemKey(item), index) &&
          !pinnedItem(item) ? (
            <div
              key={itemKey(item)}
              className="agent-history-chat-away"
              data-mount-placeholder="true"
              {...(item.type === "message"
                ? {
                    "data-bubble-id": item.entry.id,
                    "data-sequence": item.sequence,
                  }
                : { "data-place-id": item.id })}
              style={{ height: mountWindow.heightOf(itemKey(item)) }}
            />
          ) : item.type === "custom" ? (
            <div
              key={item.id}
              className="agent-history-chat-custom"
              data-place-id={item.transient ? undefined : item.id}
            >
              {item.node}
            </div>
          ) : item.type === "message" ? (
            <ChatBubble
              key={item.entry.id}
              entry={item.entry}
              sequence={item.sequence}
              repeated={item.repeated}
              firstSentAt={item.firstSentAt}
              highlighted={highlightedSequence === item.sequence}
              speech={
                speech.state?.messageId === item.entry.id ? speech : quietSpeech
              }
              onOpen={stable.onOpen}
              onRemoveQueued={
                onRemoveQueued ? stable.onRemoveQueued : undefined
              }
              onEditQueued={onEditQueued ? stable.onEditQueued : undefined}
              queuedHandedOver={
                item.entry.queued === true &&
                queuedHandedOver?.(item.entry) === true
              }
              onRewind={onRewind ? stable.onRewind : undefined}
              onRewindCheck={onRewindCheck ? stable.onRewindCheck : undefined}
              onSendAgain={onSendAgain ? stable.onSendAgain : undefined}
              onEditAgain={onEditAgain ? stable.onEditAgain : undefined}
              imageUrl={imageUrl}
              sentImageUrl={sentImageUrl}
            />
          ) : (
            <ToolBlock
              key={item.id}
              placeId={item.id}
              entries={item.entries}
              loader={loader}
              onToggle={pauseFollow}
              onOpen={stable.onOpen}
              tasks={tasks}
              onOpenTask={onOpenTask ? stable.onOpenTask : undefined}
              running={running}
              onBackground={onBackground ? stable.onBackground : undefined}
            />
          ),
        )}
        {outbox.map((message) => (
          <OutboxBubble
            key={message.id}
            message={message}
            onRetry={onRetrySend}
            onDiscard={onDiscardSend}
          />
        ))}
        {cutOff ? <CutOffNotice cutOff={cutOff} /> : null}
        {modelNotice ? <ModelNotice notice={modelNotice} /> : null}
        {delivery ? <DeliveryNotice delivery={delivery} /> : null}
        {apiKeyQuestion ? (
          <ApiKeyQuestionNotice question={apiKeyQuestion} />
        ) : null}
        {notices}
      </div>
      {placeKey && unseen > 0 ? (
        // Stuck to the bottom of the view, taking no room in the list.
        <div className="agent-history-chat-latest-dock">
          <button
            type="button"
            className="agent-history-chat-latest"
            title="Go to the newest message"
            onClick={toEnd}
          >
            <ArrowDown size={13} aria-hidden="true" />
            {unseen === 1 ? "1 new message" : `${unseen} new messages`}
          </button>
        </div>
      ) : null}
    </div>
  );
});

/**
 * The chat drawn behind what the user does: a stream update or a history
 * refresh of a long conversation renders at low priority, and a key typed
 * meanwhile is handled first (React sets that render aside for it). Every
 * prop moves together, so the chat never sees messages of one moment with
 * a place, an outbox or older pages of another.
 */
export function DeferredAgentHistoryChat(
  props: ComponentProps<typeof AgentHistoryChat>,
) {
  const shown = useDeferredValue(props);
  return <AgentHistoryChat {...shown} />;
}
