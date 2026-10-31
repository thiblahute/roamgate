import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  AssistantMention,
  AssistantMentionTarget,
  AssistantMessage,
  AssistantSnapshot,
  AssistantWorkspace,
  AssistantWorkspaceRef,
} from "../../../shared/assistant";
import { assistantQueueSupported, subscribeAssistant } from "../assistant";
import { adjustAssistantMentions } from "../assistantMentions";
import { rangerChatSource } from "../chatSource";
import {
  createRangerVoiceStream,
  rangerHistoryEntries,
  rangerReplyRunning,
} from "../rangerChat";
import { store } from "../store";
import {
  readTerminalComposerDraft,
  writeTerminalComposerDraft,
  writeTerminalComposerSelection,
} from "../terminalComposer";
import { subscribeVoiceRecording } from "../voiceLibrary";
import { voiceSessions } from "../voiceRoute";
import { setPaneView } from "../paneView";
import { AgentHistoryChat, type ChatItem } from "./AgentHistoryChat";
import { AgentHistoryComposer } from "./AgentHistoryComposer";
import { AssistantMentionComposer } from "./AssistantMentionComposer";
import type { HistoryEntry } from "./agentHistory";
import { AgentMessageDialog } from "./AgentMessageDialog";
import { scrollChatTo } from "./chatPaging";
import { ChatThreadsProvider } from "./ChatThreads";
import { ConversationMinimap } from "./ConversationMinimap";
import { useVoiceChat } from "./useVoiceChat";
import { VoiceChatOverlay } from "./VoiceChatOverlay";
import "./AgentHistoryDrawer.css";
import "./RangerChat.css";

/** What a Ranger message shows around its bubble, drawn by the panel. */
export type RangerMessageExtras = {
  /** Before the bubble: its reasoning. */
  before?: ReactNode;
  /** After it: action and task cards, the workspaces it read. */
  after?: ReactNode;
};

/** How a message is sent: while Ranger answers, it steers or queues. */
export type RangerSend = (
  text: string,
  mentions: AssistantMention[],
  whenBusy?: "steer" | "queue",
) => Promise<void>;

// The references picked in each draft, with the text they were bound in.
const draftMentions = new Map<
  string,
  { text: string; mentions: AssistantMention[] }
>();

/** The references `text`, the draft `key` holds now, keeps bound. */
function rangerDraftMentions(key: string, text: string) {
  const saved = draftMentions.get(key);
  if (!saved) return [];
  return saved.text === text
    ? saved.mentions
    : adjustAssistantMentions(saved.text, text, saved.mentions);
}

/**
 * Puts `text` in Ranger's box `key`, its caret at the end, with the
 * references it binds (a queued message taken back to edit).
 */
export function writeRangerDraft(
  key: string,
  text: string,
  mentions: AssistantMention[] = [],
) {
  draftMentions.set(key, { text, mentions });
  writeTerminalComposerDraft(key, text);
  writeTerminalComposerSelection(key, text.length, text.length);
}

/**
 * Puts a queued message back in Ranger's box `key`, after what it holds,
 * with the references of both.
 */
export function recallRangerQueued(
  key: string,
  item: { text: string; mentions?: AssistantMention[] },
) {
  const draft = readTerminalComposerDraft(key);
  const prefix = draft.trim() ? `${draft.trimEnd()}\n\n` : "";
  writeRangerDraft(key, `${prefix}${item.text}`, [
    ...(prefix ? rangerDraftMentions(key, draft) : []),
    ...(item.mentions ?? []).map((mention) => ({
      ...mention,
      start: mention.start + prefix.length,
      end: mention.end + prefix.length,
    })),
  ]);
}

/**
 * Ranger's conversation on the agent chats' shared pieces: the chat with
 * its Markdown bubbles, copy and speak buttons, comment threads, reading
 * highlight, minimap and search, the message box with Ranger's @mention
 * picker, and voice chat. What is Ranger's own (action and task cards,
 * reasoning, the workspaces read) the panel draws through `extras`, and
 * its model and permission controls come as `children`, under the box.
 */
export function RangerChat({
  snapshot,
  connectionId,
  mobile,
  composerTarget,
  searchOpen = false,
  onSearchOpenChange,
  workspaces,
  disabled,
  blocked = false,
  executing = false,
  extras,
  empty,
  onSend,
  onStop,
  onRemoveQueued,
  onError,
  children,
  canSteer = true,
  currentWorkspace,
  onOpenMention,
}: {
  snapshot: AssistantSnapshot;
  /** The connection on screen: the chat's comment threads are kept there. */
  connectionId: string;
  mobile: boolean;
  /** Where the message box goes on a phone: its bottom bar. */
  composerTarget?: HTMLElement | null;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /** The workspaces Ranger may read, offered by the @mention picker. */
  workspaces: AssistantWorkspace[];
  /** Why nothing can be sent now (no model, no scope, a sign-in). */
  disabled: string | null;
  /** Send is off for now (an action running, a request on its way). */
  blocked?: boolean;
  /** A confirmed action runs: the conversation is busy. */
  executing?: boolean;
  extras: (message: AssistantMessage) => RangerMessageExtras;
  /** Shown when the chat has no message yet. */
  empty: ReactNode;
  onSend: RangerSend;
  onStop: () => void;
  /** Takes a queued message out of Ranger's queue; false when it failed. */
  onRemoveQueued: (id: string) => Promise<boolean>;
  onError: (message: string) => void;
  children?: ReactNode;
  /**
   * While it answers, Send steers its turn and Queue keeps a message for
   * after it; an agent that cannot be steered has Send alone.
   */
  canSteer?: boolean;
  /** The workspace on screen: its references come first in the picker. */
  currentWorkspace?: AssistantWorkspaceRef;
  /**
   * Opens what a reference names. With it, the box has the @mention
   * picker, whose picks become references bound to the message.
   */
  onOpenMention?: (target: AssistantMentionTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<HistoryEntry | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const highlightTimer = useRef<number | null>(null);
  const entries = useMemo(() => rangerHistoryEntries(snapshot), [snapshot]);
  const source = rangerChatSource(snapshot, connectionId, entries);
  const draftKey = source.draftKey;

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
    else setQuery("");
  }, [searchOpen]);
  useEffect(
    () => () => {
      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  // Its messages, its own cards around them, and a word while it works.
  const needle = query.trim().toLocaleLowerCase();
  const { items, minimap } = useMemo(() => {
    const items: ChatItem[] = [];
    const minimap: {
      id: string;
      role: "user" | "assistant";
      label: string;
      text: string;
    }[] = [];
    snapshot.messages.forEach((message, index) => {
      const entry = entries[index]!;
      if (needle && !message.text.toLocaleLowerCase().includes(needle)) return;
      const running = rangerReplyRunning(snapshot, message);
      const around = needle ? {} : extras(message);
      if (around.before)
        items.push({
          type: "custom",
          id: `before:${message.id}`,
          node: around.before,
        });
      if (message.text || message.role === "user") {
        minimap.push({
          id: message.id,
          role: message.role,
          label: message.role === "user" ? "You" : "Ranger",
          text: message.text,
        });
        items.push({ type: "message", entry, sequence: minimap.length });
      } else if (!running && !around.after)
        items.push({
          type: "custom",
          id: `empty:${message.id}`,
          node: (
            <span className="assistant-hint">
              No response text was received.
            </span>
          ),
        });
      if (message.role === "assistant" && message.text.length >= 32_000)
        items.push({
          type: "custom",
          id: `limit:${message.id}`,
          node: (
            <span className="assistant-hint">
              Response text reached the display limit.
            </span>
          ),
        });
      if (around.after)
        items.push({
          type: "custom",
          id: `after:${message.id}`,
          node: around.after,
        });
    });
    const last = snapshot.messages[snapshot.messages.length - 1];
    if (
      !needle &&
      snapshot.running &&
      last?.role === "assistant" &&
      !last.text &&
      !last.thinking?.length
    )
      items.push({
        type: "custom",
        id: "working",
        node: <span className="assistant-hint">Working...</span>,
      });
    return { items, minimap };
  }, [snapshot, entries, extras, needle]);

  const selectMinimap = useCallback((index: number) => {
    const sequence = index + 1;
    const card = contentRef.current?.querySelector(
      `[data-sequence="${sequence}"]`,
    );
    const list = listRef.current;
    if (!(card instanceof HTMLElement) || !list) return;
    // Only the chat's own list moves, at once, as upstream's Ranger did: not
    // the panel or the page around it.
    scrollChatTo(list, card, { margin: 12 });
    if (highlightTimer.current !== null)
      window.clearTimeout(highlightTimer.current);
    setHighlighted(sequence);
    highlightTimer.current = window.setTimeout(() => {
      highlightTimer.current = null;
      setHighlighted(null);
    }, 1200);
  }, []);

  // Chips added or removed leave the text as it is: draw the box again.
  const [, setMentionsChanged] = useState(0);

  const running = snapshot.running;
  // While Ranger answers, Send steers its turn and Queue (Alt+Enter) keeps
  // the message for after it.
  const send = useCallback(
    async (text: string, whenBusy: "steer" | "queue" = "steer") => {
      if (disabled) throw new Error(disabled);
      const mentions = onOpenMention ? rangerDraftMentions(draftKey, text) : [];
      await onSend(text, mentions, running ? whenBusy : undefined);
      draftMentions.delete(draftKey);
    },
    [disabled, draftKey, onSend, onOpenMention, running],
  );
  const queueSend = useCallback((text: string) => send(text, "queue"), [send]);

  // Up in the empty box takes the last waiting message back to edit.
  const queue = snapshot.queue ?? [];
  const lastQueued = [...queue]
    .reverse()
    .find((item) => item.mode === "follow_up");
  const recallQueued = lastQueued
    ? () =>
        void onRemoveQueued(lastQueued.id).then((removed) => {
          if (removed) recallRangerQueued(draftKey, lastQueued);
        })
    : undefined;

  // Voice chat with Ranger: what is said goes to it, its answers are read
  // as they are written, its tools narrated.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const voiceStream = useMemo(
    () =>
      createRangerVoiceStream({
        read: () => snapshotRef.current,
        subscribe: subscribeAssistant,
        send: async (text, busy) => {
          await sendRef.current(text, [], busy ? "queue" : undefined);
          return busy ? "queued" : "sent";
        },
        stop: async () => stopRef.current(),
      }),
    [],
  );
  const voice = useVoiceChat({
    entries,
    agentStatus: source.status,
    onSend: (text) => sendRef.current(text, [], running ? "queue" : undefined),
    stream: voiceStream,
    onError: (detail) =>
      store.notify({ kind: "error", message: "Voice chat stopped", detail }),
    routeContext: () => ({
      current: source.voiceSession,
      sessions: voiceSessions(store.get()),
    }),
    onSwitch: (connection, paneId) => {
      setPaneView(connection, paneId, "chat");
      void store.jumpToConnectionPane(connection, paneId);
    },
    voiceKey: source.voiceKey,
  });
  // Another chat shown: voice chat was with the one before.
  const stopVoice = voice.stop;
  useEffect(() => stopVoice, [stopVoice, snapshot.session_id]);
  // While a voice is recorded, voice chat is muted, as in the agent chats.
  const voiceToggleMute = voice.toggleMute;
  const voiceMutedRef = useRef(voice.muted);
  voiceMutedRef.current = voice.muted;
  useEffect(() => {
    let mutedForRecording = false;
    return subscribeVoiceRecording((recording) => {
      if (recording && !voiceMutedRef.current) {
        mutedForRecording = true;
        voiceToggleMute();
      } else if (!recording && mutedForRecording) {
        mutedForRecording = false;
        if (voiceMutedRef.current) voiceToggleMute();
      }
    });
  }, [voiceToggleMute]);

  const frame = (
    <div className="agent-history-chat-frame">
      <AgentHistoryChat
        items={items}
        listRef={listRef}
        contentRef={contentRef}
        highlightedSequence={highlighted}
        followKey={`${snapshot.session_id ?? ""}:${query}`}
        speechScopeKey={draftKey}
        onOpen={setOpened}
      />
      {minimap.length > 1 ? (
        <ConversationMinimap
          key={snapshot.session_id ?? snapshot.instance_id}
          entries={minimap}
          scrollerRef={listRef}
          itemsRef={contentRef}
          orientation={mobile ? "horizontal" : "auto"}
          label="Ranger conversation navigation"
          emptyText="No response text yet"
          onSelect={selectMinimap}
        />
      ) : null}
    </div>
  );

  // On a phone the box alone goes in the bottom bar, as an agent chat's
  // does, so it gets the same room beside the navigation and the same
  // layout; Ranger's own controls stay above it, in the panel.
  const docked = mobile && !!composerTarget;
  const box = (
    <AgentHistoryComposer
      key={draftKey}
      draftKey={draftKey}
      agent="Ranger"
      status={source.status}
      placeholder="Ask about your workspaces, or @mention one"
      onSend={send}
      onQueue={
        running && canSteer && assistantQueueSupported(snapshot)
          ? queueSend
          : undefined
      }
      input={
        onOpenMention
          ? (input) => (
              <div className={`ranger-chat-input${mobile ? " is-mobile" : ""}`}>
                <AssistantMentionComposer
                  value={input.value}
                  mentions={rangerDraftMentions(draftKey, input.value)}
                  workspaces={workspaces}
                  currentWorkspace={currentWorkspace}
                  draftKey={draftKey}
                  inputRef={input.inputRef}
                  mobile={mobile}
                  onChange={(text, picked, _inputType, edit) => {
                    const saved = draftMentions.get(draftKey);
                    draftMentions.set(draftKey, {
                      text,
                      mentions:
                        picked ??
                        (saved
                          ? adjustAssistantMentions(
                              saved.text,
                              text,
                              saved.mentions,
                              saved.text === input.value ? edit : undefined,
                            )
                          : []),
                    });
                    setMentionsChanged((count) => count + 1);
                    input.onChange(text);
                  }}
                  onSubmit={input.onSubmit}
                  onCompositionChange={input.onCompositionChange}
                  onOpenMention={onOpenMention}
                  onError={onError}
                />
              </div>
            )
          : undefined
      }
      onRecallQueued={recallQueued}
      onStop={running ? onStop : undefined}
      sendTo="Ranger"
      sendBlocked={blocked || !!disabled}
      stop={{
        label: "Stop",
        title:
          "Stop the model response; confirmed actions continue and waiting messages are kept",
      }}
      onError={onError}
      voice={
        voice.available || voice.unavailable
          ? {
              listen: voice.available,
              state: voice.state,
              level: voice.level,
              muted: voice.muted,
              held: voice.held,
              onSendHeld: voice.sendHeld,
              onDropHeld: voice.dropHeld,
              onToggle: voice.available
                ? voice.toggle
                : () =>
                    store.notify({
                      kind: "info",
                      message: "Voice chat cannot listen here",
                      detail:
                        "Listening needs Roamgate's voice engine on the server (docs/DEPLOYMENT.md, Voice chat). Speak still reads replies aloud with this browser's voice.",
                    }),
              onToggleMute: voice.toggleMute,
            }
          : undefined
      }
    />
  );
  const composer = (
    <div
      className={`assistant-panel-footer ranger-chat-footer${mobile ? " is-mobile" : ""}${docked ? " is-docked" : ""}`}
    >
      {disabled ? (
        <p className="assistant-hint ranger-chat-disabled">{disabled}</p>
      ) : null}
      {docked ? null : box}
      {children}
    </div>
  );

  return (
    <div className="agent-history-messages ranger-chat">
      {searchOpen ? (
        <div className="agent-history-search ranger-chat-search">
          <input
            ref={searchRef}
            type="search"
            aria-label="Search Ranger messages"
            placeholder="Search this chat"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              onSearchOpenChange?.(false);
            }}
          />
        </div>
      ) : null}
      <div
        className="assistant-conversation ranger-chat-conversation"
        aria-label="Ranger conversation"
        aria-busy={running || executing}
      >
        {!snapshot.messages.length ? (
          empty
        ) : needle && !items.length ? (
          <div className="agent-history-state">
            No messages match the search.
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setQuery("")}
            >
              Clear search
            </button>
          </div>
        ) : source.threads ? (
          // Comments on parts of Ranger's messages, answered in their
          // threads as it answers.
          <ChatThreadsProvider {...source.threads} entries={source.entries}>
            {frame}
          </ChatThreadsProvider>
        ) : (
          frame
        )}
        {voice.available && voice.state !== "off" ? (
          <VoiceChatOverlay
            state={voice.state}
            level={voice.level}
            muted={voice.muted}
            heard={voice.heard}
            speechRate={voice.speechRate}
            agent="Ranger"
            place="Roamgate"
            onToggle={voice.toggle}
            onToggleMute={voice.toggleMute}
            onEnd={voice.stop}
            onCycleSpeechRate={voice.cycleSpeechRate}
            reader={voice.reader}
            moveQuestion={voice.moveQuestion?.text ?? null}
            onAnswerMove={voice.answerMove}
            notSent={voice.notSent}
            onSendAnyway={voice.sendNotSent}
          />
        ) : null}
      </div>
      {composer}
      {docked && composerTarget ? createPortal(box, composerTarget) : null}
      <AgentMessageDialog message={opened} onClose={() => setOpened(null)} />
    </div>
  );
}
