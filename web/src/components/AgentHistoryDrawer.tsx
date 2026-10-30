import { useRenderTrace } from "../renderTrace";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { workspaceFileUrl } from "../workspaceFileUrl";
import {
  Check,
  Copy,
  Download,
  Eye,
  Info,
  MessagesSquare,
  RefreshCw,
  ListChecks,
  Search,
  Square,
  SquareCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  agentHistoryCacheKey,
  cachedAgentHistory,
  loadAgentHistoryCache,
  rememberAgentHistory,
} from "../agentHistoryCache";
import { store, useStoreSelector } from "../store";
import {
  type AgentChatSnapshot,
  cutOffNotice,
  dismissAgentChatInterrupted,
  interruptAgentChat,
  messageUuid,
  onAgentChatEvent,
  queuedEntries,
  queuedEntryId,
  removeAgentChatQueued,
  requestAgentChatHandover,
  sendAgentChat,
  sendAgentChatVoice,
  historyUserUuids,
  settleAgentChatLive,
  useAgentChat,
} from "../agentChat";
import {
  conversationActivity,
  conversationAgentStatus,
  conversationOwns,
  ownershipLabel,
} from "../agentChatOwnership";
import { watchAgentHistory } from "../agentHistoryPush";
import { messageImagePieces } from "../chatImages";
import { liveTurnEntries, reconcileLiveTurn } from "./liveTurn";
import { rewindClaude, type RewindMode } from "../claudeRewind";
import { AgentRewindSheet } from "./AgentRewindSheet";
import { copyTextWithFeedback } from "../copyText";
import { useConnectionClient } from "../useConnectionClient";
import {
  readTerminalComposerDraft,
  sendTerminalComposerText,
  terminalComposerDraftKey,
  writeTerminalComposerDraft,
} from "../terminalComposer";
import { uploadTerminalImage } from "../terminalImageUpload";
import type { AgentActivity, AgentPrompt } from "../agentPrompt";
import type { AgentPermissionPrompt } from "../../../shared/review";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentTasksSheet } from "./AgentTasksSheet";
import { AgentArtifactsMenu } from "./AgentArtifactsMenu";
import { useAgentArtifacts } from "../agentArtifacts";
import { useAgentTasks } from "../agentTasks";
import { isTasksCommand, onAgentTasksRequest } from "../agentTasksOpen";
import { shortcutTitle } from "../shortcutPreferences";
import {
  conversationCommands,
  conversationRefusal,
  useAgentCommands,
} from "../claudeCommands";
import type { Pane } from "../types";
import {
  DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  inspectorNavigationRatioAtPosition,
} from "../workspaceResource";
import { formatUiDateTime, formatUiRelativeTime } from "../uiLocale";
import { prefersReducedMotion, shortId } from "../utils";
import { AgentIcon } from "./AgentIcon";
import { AgentMessageContent } from "./AgentMessageContent";
import { AgentMessageDialog } from "./AgentMessageDialog";
import { AgentHistoryCard } from "./AgentHistoryCard";
import { AgentHistoryChat, type ChatCutOff } from "./AgentHistoryChat";
import { AgentHistoryComposer } from "./AgentHistoryComposer";
import { voiceTrace } from "../voiceChat";
import { useAgentSessionTitle } from "../agentSessionTitle";
import { agentStateKind } from "./agentSession";
import { useVoiceChat, type VoiceStream } from "./useVoiceChat";
import { VoiceChatOverlay } from "./VoiceChatOverlay";
import { AgentHistoryFilters } from "./AgentHistoryFilters";
import { ConversationMinimap } from "./ConversationMinimap";
import {
  groupHistoryChatItems,
  searchHistoryChatEntries,
  readAgentHistoryView,
  writeAgentHistoryView,
  type AgentHistoryView,
} from "./agentHistoryView";
import {
  ALL_HISTORY_FILTERS,
  historyEntryLabel,
  mergeAgentHistory,
  isToolContentPending,
  selectHistoryEntries,
  toolOverlayMatches,
  type ToolTextOverlay,
  type HistoryFilters,
  type AgentHistory,
  type AgentHistoryResponse,
  type HistoryEntry as AgentHistoryEntry,
} from "./agentHistory";
import { AgentSessionPreviewDialog } from "./AgentSessionPreviewDialog";
import {
  type AgentSessionSummary,
  downloadSession,
  formatBytes,
  formatCount,
  formatOptionalCompact,
  formatTokenTotal,
  tokenUsage,
} from "./agentSession";
import {
  newOutboxMessage,
  nextOutboxDeadline,
  releaseHeldOutbox,
  type OutboxMessage,
  outboxNotShown,
  settleOutbox,
} from "./chatOutbox";
import { promptKeyInput } from "./promptKeys";
import {
  handOffVoice,
  takeVoiceHandoff,
  voiceSessionId,
  voiceSessions,
} from "../voiceRoute";
import { setPaneView } from "../paneView";
import { ChatThreadsProvider } from "./ChatThreads";
import "./AgentHistoryDrawer.css";

function formatRelativeTime(timestamp: string) {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return "Unknown";
  const seconds = Math.round((time.getTime() - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return formatUiRelativeTime(seconds, "second");
  if (absoluteSeconds < 3600)
    return formatUiRelativeTime(Math.round(seconds / 60), "minute");
  if (absoluteSeconds < 86400)
    return formatUiRelativeTime(Math.round(seconds / 3600), "hour");
  return formatUiRelativeTime(Math.round(seconds / 86400), "day");
}

/** Keys a menu in the agent's terminal answers to: label, input, name. */
const PROMPT_KEYS: [string, string, string][] = [
  ["\u2190", "\x1b[D", "Left: previous question"],
  ["\u2191", "\x1b[A", "Up"],
  ["\u2193", "\x1b[B", "Down"],
  ["\u2192", "\x1b[C", "Right: next question"],
  ["Tab", "\t", "Tab"],
  ["Enter", "\r", "Enter: confirm"],
  ["Esc", "\x1b", "Escape: cancel"],
];

/** How long a pane's chat waits for its transcript before saying why. */
const UNAVAILABLE_QUIET_MS = 20_000;

/** How often the history is read while the bridge pushes its changes. */
const PUSHED_POLL_MS = 30_000;
/** And while it cannot. */
const POLL_MS = 4000;

export function AgentHistoryDrawer({
  pane,
  open,
  embedded = false,
  wide = false,
  paneChat,
  onOpenChange,
}: {
  pane: Pane;
  open: boolean;
  embedded?: boolean;
  wide?: boolean;
  /**
   * Shown in the pane, in place of its terminal: the chat only, with what
   * the terminal asks while the agent is blocked.
   */
  paneChat?: {
    /** The blocked agent's prompt, read from its screen. */
    prompt: AgentPrompt | null;
    /** What the working agent says it is doing, from its screen. */
    activity?: AgentActivity | null;
    /** What its permission hook waits on, answered here. */
    permission?: AgentPermissionPrompt;
    onShowTerminal: () => void;
    /** Types into the terminal: an answer's key, or Esc to stop. */
    onKeys: (text: string) => void;
    /** The terminal's screen, as text: what its menus show. */
    readScreen: () => string[];
    /** Where the message box goes: the phone's bottom bar. */
    composerTarget?: HTMLElement | null;
    /**
     * A Claude pane's conversation mode: while it owns the session the chat
     * talks to its headless Claude instead of the terminal.
     */
    conversation?: AgentChatSnapshot | null;
  };
  onOpenChange: (open: boolean) => void;
}) {
  useRenderTrace("AgentHistoryDrawer");
  const workspaces = useStoreSelector((state) => state.workspaces);
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const connectionGeneration = useStoreSelector(
    (state) => state.connectionGeneration,
  );
  const connectionClient = useConnectionClient();
  // Images the user uploaded load from the pane's host.
  const imageUrl = useCallback(
    (path: string) =>
      workspaceFileUrl(connectionClient, pane.workspace_id, path, {
        inline: true,
      }),
    [connectionClient, pane.workspace_id],
  );
  const workspaceLabel =
    workspaces.find((workspace) => workspace.workspace_id === pane.workspace_id)
      ?.label ?? pane.workspace_id;
  const recentKey = agentHistoryCacheKey(
    activeConnectionId,
    pane.pane_id,
    pane.agent,
  );
  const recentKeyRef = useRef(recentKey);
  recentKeyRef.current = recentKey;
  const [history, setHistory] = useState<AgentHistory | null>(
    () => cachedAgentHistory(recentKey)?.history ?? null,
  );
  const [query, setQuery] = useState("");
  // Tool entries arrive redacted (metadata only) and are fetched on demand.
  const [filters, setFilters] = useState<HistoryFilters>({
    ...ALL_HISTORY_FILTERS,
    tool: false,
  });
  const [toolEntryTexts, setToolEntryTexts] = useState<
    ReadonlyMap<string, ToolTextOverlay>
  >(() => new Map());
  const [toolEntryLoading, setToolEntryLoading] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [session, setSession] = useState<AgentSessionSummary | null>(
    () => cachedAgentHistory(recentKey)?.session ?? null,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [view, setView] = useState<AgentHistoryView>(readAgentHistoryView);
  const chatView = !!paneChat || view === "chat";
  // In a pane, the conversation takes the room: search waits for its button.
  const [searchOpen, setSearchOpen] = useState(false);
  // What the session runs on the side, followed while the chat shows.
  const {
    tasks,
    session: tasksSession,
    loaded: tasksLoaded,
  } = useAgentTasks(pane, !!paneChat && open);
  const agentCommands = useAgentCommands(pane, open);
  const sessionTitle = useAgentSessionTitle(pane, open);
  const artifacts = useAgentArtifacts(pane, !!paneChat && open);
  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const runningTasks = tasks.filter((task) => task.status === "running").length;
  const [tasksOpen, setTasksOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = useCallback((id: string | null) => {
    setOpenTaskId(id);
    setTasksOpen(true);
  }, []);
  // Its shortcut and the command menu open (or close) the list here, where
  // it was left.
  const chatPaneId = paneChat ? pane.pane_id : null;
  useEffect(() => {
    if (!chatPaneId) return;
    return onAgentTasksRequest(chatPaneId, () => {
      setOpenTaskId(null);
      setTasksOpen((shown) => !shown);
    });
  }, [chatPaneId]);
  const [previewPane, setPreviewPane] = useState<Pane | null>(null);
  const [previewSummary, setPreviewSummary] =
    useState<AgentSessionSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [expandedMessage, setExpandedMessage] =
    useState<AgentHistoryEntry | null>(null);
  const [loading, setLoading] = useState(false);
  // Whether a load answered since the pane was switched to: until then what
  // shows is what it had last, and the chat says it is catching up.
  const [caughtUp, setCaughtUp] = useState(false);
  const [error, setError] = useState("");
  const [highlightedSequence, setHighlightedSequence] = useState<number | null>(
    null,
  );
  // Wide layout: the list sits in a resizable master column and the selected
  // entry opens in an inline detail panel instead of the modal dialog.
  const [wideListRatio, setWideListRatio] = useState(
    DEFAULT_INSPECTOR_NAVIGATION_RATIO,
  );
  const [wideSelectedId, setWideSelectedId] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wideSplitRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const sentRefreshTimerRef = useRef<number | null>(null);
  // Advances whenever polling stops (close, pane switch, unmount), so a send
  // that resolves afterwards does not schedule a refresh for a stale drawer.
  const pollScopeRef = useRef(0);
  const loadSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const historyRef = useRef<AgentHistory | null>(history);
  const sessionRef = useRef<AgentSessionSummary | null>(session);
  const inFlightRef = useRef<number | null>(null);
  // A change was pushed while a read was in flight: read again after it.
  const reloadRef = useRef(false);
  const loadHistoryRef = useRef<() => void>(() => {});
  const paneIdRef = useRef(pane.pane_id);
  paneIdRef.current = pane.pane_id;
  // Entries whose content fetch failed; suppresses auto-refetch loops while
  // keeping the card's manual Load button usable.
  const toolEntryFailedRef = useRef<Set<string>>(new Set());

  const loadHistory = useCallback(() => {
    if (!pane.agent || !connectionClient.isCurrent()) return;
    if (inFlightRef.current !== null) {
      reloadRef.current = true;
      return;
    }
    reloadRef.current = false;
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    inFlightRef.current = seq;
    setLoading(!historyRef.current);
    const requested = historyRef.current?.cursor ?? null;
    const params = {
      history_version: 2,
      cursor: requested,
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      agent: pane.agent,
    };
    Promise.allSettled([
      connectionClient.call("agent_history.get", params),
      connectionClient.call("agent_session.get", {
        pane_id: pane.pane_id,
        agent: pane.agent,
      }),
    ])
      .then(([historyResult, sessionResult]) => {
        if (!connectionClient.isCurrent() || loadSeqRef.current !== seq) return;
        if (historyResult.status === "fulfilled") {
          const merged = mergeAgentHistory(
            historyRef.current,
            historyResult.value as AgentHistoryResponse,
            requested,
          );
          historyRef.current = merged;
          setHistory(merged);
          rememberAgentHistory(recentKeyRef.current, {
            history: merged,
            session: sessionRef.current,
          });
          if (merged) {
            // Drop on-demand texts for entries that left the window or whose
            // content changed under the same id (hash or byte-length mismatch).
            setToolEntryTexts((current) => {
              if (current.size === 0) return current;
              const kept = new Map<string, ToolTextOverlay>();
              for (const message of merged.messages) {
                const overlay = current.get(message.id);
                if (
                  overlay !== undefined &&
                  toolOverlayMatches(overlay, message)
                ) {
                  kept.set(message.id, overlay);
                }
              }
              return kept.size === current.size ? current : kept;
            });
            // Failure marks for entries that left the window are dead weight;
            // drop them so the set cannot grow across refreshes. An entry
            // reappearing later may retry the fetch once.
            const windowedIds = new Set(
              merged.messages.map((message) => message.id),
            );
            for (const id of toolEntryFailedRef.current) {
              if (!windowedIds.has(id)) toolEntryFailedRef.current.delete(id);
            }
          }
          setExpandedMessage((entry) =>
            entry
              ? (merged?.messages.find((message) => message.id === entry.id) ??
                null)
              : null,
          );
        }
        if (sessionResult.status === "fulfilled") {
          const summary = sessionResult.value as AgentSessionSummary;
          sessionRef.current = summary;
          setSession(summary);
          rememberAgentHistory(recentKeyRef.current, {
            history: historyRef.current,
            session: summary,
          });
        }
        const errors = [historyResult, sessionResult]
          .filter((result) => result.status === "rejected")
          .map((result) =>
            result.status === "rejected"
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : "",
          )
          .filter(Boolean);
        setError(errors.join("\n"));
        // TEMPORARY: what a chat load got, to find why one never shows.
        voiceTrace(
          `chat load ${pane.pane_id}: history ${historyResult.status === "fulfilled" ? `${(historyResult.value as AgentHistoryResponse)?.status} ${JSON.stringify(historyResult.value).length}B` : "failed"}, session ${sessionResult.status === "fulfilled" ? (sessionResult.value as AgentSessionSummary)?.status : "failed"}${errors.length ? `, errors: ${errors.join(" | ")}` : ""}`,
        );
      })
      .finally(() => {
        if (inFlightRef.current === seq) inFlightRef.current = null;
        if (connectionClient.isCurrent() && loadSeqRef.current === seq) {
          setLoading(false);
          setCaughtUp(true);
          if (reloadRef.current) loadHistoryRef.current();
        }
      });
  }, [
    connectionClient,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  loadHistoryRef.current = loadHistory;

  useEffect(() => {
    // Resource-derived state belongs to one pane and one connection lease.
    // Invalidate old continuations before loading a colliding pane ID from a
    // switched connection or replacement runtime.
    loadSeqRef.current += 1;
    inFlightRef.current = null;
    // What this pane showed last comes back at once; the poll refreshes it.
    const recent = cachedAgentHistory(recentKeyRef.current);
    historyRef.current = recent?.history ?? null;
    sessionRef.current = recent?.session ?? null;
    previewSeqRef.current += 1;
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSequence(null);
    setWideSelectedId(null);
    setWideListRatio(DEFAULT_INSPECTOR_NAVIGATION_RATIO);
    setHistory(historyRef.current);
    setQuery("");
    setSession(sessionRef.current);
    setDetailsOpen(false);
    setExpandedMessage(null);
    setToolEntryTexts(new Map());
    setToolEntryLoading(new Set());
    toolEntryFailedRef.current.clear();
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewLoading(false);
    setPreviewError("");
    setLoading(false);
    setCaughtUp(false);
    setError("");
  }, [
    connectionClient,
    pane.agent,
    pane.pane_id,
    pane.workspace_id,
    pane.tab_id,
  ]);

  // Right after a reload the saved histories are still being read: show this
  // pane's once they are, unless the server answered first.
  useEffect(() => {
    if (historyRef.current) return;
    const key = recentKey;
    let cancelled = false;
    void loadAgentHistoryCache().then(() => {
      const saved = cachedAgentHistory(key);
      if (cancelled || historyRef.current || !saved?.history) return;
      historyRef.current = saved.history;
      sessionRef.current = saved.session;
      setHistory(saved.history);
      setSession(saved.session);
      setLoading(false);
      // A read in flight asked from no cursor and would be dropped against
      // the saved one: ask again from it.
      loadSeqRef.current += 1;
      inFlightRef.current = null;
      loadHistory();
    });
    return () => {
      cancelled = true;
    };
  }, [loadHistory, recentKey]);

  const loadToolEntry = useCallback(
    (entry: AgentHistoryEntry) => {
      if (!pane.agent || !connectionClient.isCurrent()) return;
      const paneId = pane.pane_id;
      setToolEntryLoading((current) => new Set(current).add(entry.id));
      connectionClient
        .call("agent_history.entry", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
          entry_id: entry.id,
        })
        .then((result) => {
          if (!connectionClient.isCurrent() || paneIdRef.current !== paneId)
            return;
          toolEntryFailedRef.current.delete(entry.id);
          const { text, text_hash } = result as {
            text?: unknown;
            text_hash?: unknown;
          };
          const value = typeof text === "string" ? text : "";
          setToolEntryTexts((current) =>
            new Map(current).set(entry.id, {
              text: value,
              bytes: new TextEncoder().encode(value).length,
              hash: typeof text_hash === "string" ? text_hash : undefined,
            }),
          );
        })
        .catch((value) => {
          if (!connectionClient.isCurrent() || paneIdRef.current !== paneId)
            return;
          toolEntryFailedRef.current.add(entry.id);
          setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          setToolEntryLoading((current) => {
            if (!current.has(entry.id)) return current;
            const next = new Set(current);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      connectionClient,
      pane.agent,
      pane.pane_id,
      pane.tab_id,
      pane.workspace_id,
    ],
  );

  // A rewind takes the turns from its message on out of Claude Code's
  // conversation at once, but out of its transcript only once the next
  // message hangs from before them (session-rewind.ts): until then, the
  // chat leaves them out itself.
  const [rewound, setRewound] = useState<{
    id: string;
    sent_at: string;
  } | null>(null);
  const messages = useMemo(() => {
    const all = history?.messages ?? [];
    const cut = rewound
      ? all.findIndex(
          (entry) =>
            entry.id === rewound.id && entry.sent_at === rewound.sent_at,
        )
      : -1;
    return cut < 0 ? all : all.slice(0, cut);
  }, [history?.messages, rewound]);
  // Substitute fetched tool payloads only while they still match the entry.
  const hydrateEntry = useCallback(
    (entry: AgentHistoryEntry): AgentHistoryEntry => {
      const overlay = toolEntryTexts.get(entry.id);
      return overlay !== undefined && toolOverlayMatches(overlay, entry)
        ? { ...entry, text: overlay.text }
        : entry;
    },
    [toolEntryTexts],
  );
  const hydratedMessages = useMemo(
    () => (toolEntryTexts.size === 0 ? messages : messages.map(hydrateEntry)),
    [messages, toolEntryTexts, hydrateEntry],
  );
  const timelineSelection = useMemo(
    () => selectHistoryEntries(hydratedMessages, filters, query),
    [hydratedMessages, filters, query],
  );
  // The chat view has no type filter: it shows every entry, with tool entries
  // collapsed into blocks between the conversation bubbles. Its search keeps
  // a tool call and its result together.
  const chatEntries = useMemo(
    () => (chatView ? searchHistoryChatEntries(hydratedMessages, query) : null),
    [chatView, hydratedMessages, query],
  );
  const visibleMessages = chatEntries ?? timelineSelection.visible;
  const counts = timelineSelection.counts;
  // Conversation mode: the turn being streamed, and the bridge's queue,
  // after the transcript, each item until the transcript shows it.
  // Outside a pane (the workspace inspector's history), the chat follows
  // conversation mode itself: what it sends must not reach the holder.
  const ownConversation = useAgentChat(
    connectionClient,
    pane.pane_id,
    !paneChat && open && pane.agent === "claude",
  );
  const conversation = paneChat?.conversation ?? ownConversation ?? null;
  const conversationState = conversation?.state ?? null;
  // A takeover asked from here counts from the moment it is asked: nothing
  // is typed into the pane while Claude exits and the holder starts.
  const owns = conversationOwns(conversationState) || !!conversation?.handing;
  const inConversation = conversationState?.phase === "conversation";
  // Read by the send paths when they run.
  const inConversationRef = useRef(inConversation);
  inConversationRef.current = inConversation;
  const ownsRef = useRef(owns);
  ownsRef.current = owns;
  const liveTurn = conversation?.live;
  const liveQueue = owns ? conversationState?.queue : undefined;
  // Taken out of the queue, not replayed yet: still shown as queued.
  const departing = owns ? conversation?.departing : undefined;
  const historyUuids = useMemo(() => historyUserUuids(messages), [messages]);
  // The live entries, and the uuids of every conversation-mode message the
  // chat shows (transcript, live turn, queue): the outbox hides those in
  // the same render, so no message is ever missing for a frame.
  const { liveEntries, shownUuids } = useMemo(() => {
    const shown = new Set(historyUuids);
    if (!liveTurn?.items.length && !liveQueue?.length && !departing?.length)
      return { liveEntries: [], shownUuids: shown };
    const turn = liveTurn
      ? reconcileLiveTurn(liveTurn, messages, Date.now())
      : null;
    for (const item of turn?.items ?? [])
      if (item.kind === "user" && item.uuid) shown.add(item.uuid);
    const queue = [
      ...(departing ?? []).filter((item) => !shown.has(item.id)),
      ...(liveQueue ?? []),
    ];
    for (const item of queue) shown.add(item.id);
    const live = turn ? liveTurnEntries(turn) : [];
    return {
      liveEntries: queue.length ? [...live, ...queuedEntries(queue)] : live,
      shownUuids: shown,
    };
  }, [departing, historyUuids, liveTurn, liveQueue, messages]);
  useEffect(() => {
    if (liveTurn?.items.length || departing?.length)
      settleAgentChatLive(activeConnectionId, pane.pane_id, messages);
  }, [activeConnectionId, departing, liveTurn, messages, pane.pane_id]);
  const chatItems = useMemo(
    () =>
      chatView
        ? groupHistoryChatItems(
            liveEntries.length && !query.trim()
              ? [...visibleMessages, ...liveEntries]
              : visibleMessages,
          )
        : [],
    [chatView, liveEntries, query, visibleMessages],
  );
  // The chat view reads full messages in the modal dialog at any width; only
  // the wide timeline uses the inline master-detail reader.
  const masterDetail = wide && !chatView;
  const wideSelectedEntry = masterDetail
    ? (visibleMessages.find((entry) => entry.id === wideSelectedId) ?? null)
    : null;
  const activeMessage = masterDetail
    ? !detailsOpen
      ? wideSelectedEntry
      : null
    : expandedMessage;

  // A refresh can swap the expanded entry for a redacted stub whose fetched
  // text was pruned (e.g. tool arguments rewritten under the same call id).
  // Refetch instead of showing a blank dialog; failed fetches are not
  // retried automatically (the card's manual Load button still works).
  useEffect(() => {
    if (
      !open ||
      !activeMessage ||
      !isToolContentPending(activeMessage) ||
      toolEntryLoading.has(activeMessage.id) ||
      toolEntryFailedRef.current.has(activeMessage.id)
    ) {
      return;
    }
    const overlay = toolEntryTexts.get(activeMessage.id);
    if (overlay !== undefined && toolOverlayMatches(overlay, activeMessage))
      return;
    loadToolEntry(activeMessage);
  }, [activeMessage, open, toolEntryTexts, toolEntryLoading, loadToolEntry]);

  // The bridge says when the session file changes (agent_history.changed):
  // the history is read then, and slowly otherwise in case a push is lost;
  // a bridge that cannot push is polled as before.
  useEffect(() => {
    if (!open) return;
    const visible = () => document.visibilityState === "visible";
    // Changed while hidden: read once shown again.
    let missed = false;
    if (visible()) loadHistory();
    const onChange = () => {
      if (visible()) loadHistory();
      else missed = true;
    };
    const onVisible = () => {
      if (visible() && missed) {
        missed = false;
        loadHistory();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const watch = pane.agent
      ? watchAgentHistory(
          connectionClient,
          {
            pane_id: pane.pane_id,
            workspace_id: pane.workspace_id,
            tab_id: pane.tab_id,
            agent: pane.agent,
          },
          onChange,
        )
      : null;
    let interval = POLL_MS;
    let timer = window.setInterval(onChange, interval);
    let live = true;
    void watch?.pushed.then((pushed) => {
      if (!live || !pushed) return;
      window.clearInterval(timer);
      interval = PUSHED_POLL_MS;
      timer = window.setInterval(onChange, interval);
    });
    return () => {
      live = false;
      watch?.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      pollScopeRef.current += 1;
      if (sentRefreshTimerRef.current !== null) {
        window.clearTimeout(sentRefreshTimerRef.current);
        sentRefreshTimerRef.current = null;
      }
      loadSeqRef.current += 1;
      inFlightRef.current = null;
      reloadRef.current = false;
    };
  }, [
    connectionClient,
    loadHistory,
    open,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);

  // Herdr saw the agent change state (a turn, /clear, a new session in the
  // pane): read now. The bridge's watcher may still follow the old session
  // file, and this read moves it to the new one.
  const stateSeq = pane.state_change_seq;
  const seenStateSeqRef = useRef(stateSeq);
  useEffect(() => {
    if (seenStateSeqRef.current === stateSeq) return;
    seenStateSeqRef.current = stateSeq;
    if (open && document.visibilityState === "visible") loadHistory();
  }, [loadHistory, open, stateSeq]);

  useEffect(() => {
    if (!open) {
      setExpandedMessage(null);
      setPreviewPane(null);
      setPreviewSummary(null);
      setPreviewError("");
    }
  }, [open]);

  const openSessionPreview = useCallback(() => {
    if (
      !pane.agent ||
      session?.status !== "ok" ||
      !connectionClient.isCurrent()
    ) {
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreviewPane(pane);
    setPreviewSummary(null);
    setPreviewError("");
    setPreviewLoading(true);
    connectionClient
      .call("agent_session.get", {
        pane_id: pane.pane_id,
        agent: pane.agent,
        include_text: true,
        include_trajectory: true,
        preview_limit: 1024 * 1024,
      })
      .then((result) => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewSummary(result as AgentSessionSummary);
        }
      })
      .catch((value) => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewError(
            value instanceof Error ? value.message : String(value),
          );
        }
      })
      .finally(() => {
        if (connectionClient.isCurrent() && previewSeqRef.current === seq) {
          setPreviewLoading(false);
        }
      });
  }, [connectionClient, pane, session?.status]);

  const closeSessionPreview = useCallback(() => {
    previewSeqRef.current += 1;
    setPreviewPane(null);
    setPreviewSummary(null);
    setPreviewError("");
  }, []);

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  const changeFilters = (next: HistoryFilters, nextQuery = query) => {
    setFilters(next);
    setQuery(nextQuery);
    setExpandedMessage((entry) =>
      entry &&
      (chatView
        ? searchHistoryChatEntries(hydratedMessages, nextQuery).some(
            (item) => item.id === entry.id,
          )
        : selectHistoryEntries([hydrateEntry(entry)], next, nextQuery).visible
            .length)
        ? entry
        : null,
    );
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    setHighlightedSequence(null);
    // The chat jumps back to its newest message itself (followKey).
    if (!chatView && contentRef.current) contentRef.current.scrollTop = 0;
  };

  // Stable identity so the message dialog's focus effect only re-runs when the
  // message itself changes, not on every drawer re-render.
  const closeExpandedMessage = useCallback(() => setExpandedMessage(null), []);

  const usage = tokenUsage(session);
  // Minimap entries: every visible timeline card, or every chat bubble (tool
  // chip rows are not indexed).
  const messageEntries = useMemo(
    () =>
      chatView
        ? chatItems.flatMap((item) =>
            item.type === "message"
              ? [{ message: item.entry, sequence: item.sequence }]
              : [],
          )
        : visibleMessages.map((message, index) => ({
            message,
            sequence: index + 1,
          })),
    [chatItems, chatView, visibleMessages],
  );

  const scrollToMessage = useCallback(
    (sequence: number) => {
      const card = timelineRef.current?.querySelector(
        `[data-sequence="${sequence}"]`,
      );
      if (!(card instanceof HTMLElement)) return;
      if (masterDetail) {
        // Master-detail: the minimap selects the entry in the detail panel
        // and scrolls its row into view instead of flashing a highlight.
        const message = messageEntries[sequence - 1]?.message;
        if (message) setWideSelectedId(message.id);
        card.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "nearest",
        });
        return;
      }
      const reduceMotion = prefersReducedMotion();
      card.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      setHighlightedSequence(sequence);
      highlightTimerRef.current = window.setTimeout(() => {
        highlightTimerRef.current = null;
        setHighlightedSequence(null);
      }, 1200);
    },
    [masterDetail, messageEntries],
  );
  const minimapEntries = useMemo(
    () =>
      messageEntries.map(({ message }) => ({
        id: message.id,
        role: message.role,
        label: historyEntryLabel(message),
        text: message.text,
      })),
    [messageEntries],
  );
  const selectMinimapEntry = useCallback(
    (index: number) => scrollToMessage(index + 1),
    [scrollToMessage],
  );

  const updateWideRatioFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const split = wideSplitRef.current;
      if (!split) return;
      const bounds = split.getBoundingClientRect();
      setWideListRatio(
        inspectorNavigationRatioAtPosition(
          event.clientX - bounds.left,
          bounds.width,
        ),
      );
    },
    [],
  );

  const handleWideResizerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const split = wideSplitRef.current;
      if (!split) return;
      const availableWidth = split.getBoundingClientRect().width;
      let next: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        next = inspectorNavigationRatioAtPosition(
          wideListRatio * availableWidth +
            (event.key === "ArrowLeft" ? -16 : 16),
          availableWidth,
        );
      } else if (event.key === "Home") {
        next = inspectorNavigationRatioAtPosition(0, availableWidth);
      } else if (event.key === "End") {
        next = inspectorNavigationRatioAtPosition(
          availableWidth,
          availableWidth,
        );
      }
      if (next === null) return;
      event.preventDefault();
      setWideListRatio(next);
    },
    [wideListRatio],
  );
  const sessionReady = session?.status === "ok";
  /** The chat its threads belong to: the agent's session. */
  const chatThreadsKey = sessionReady
    ? (session?.session?.value ?? session?.path ?? null)
    : null;
  const historyReady = history?.status === "ok" || messages.length > 0;
  const hasSessionData = sessionReady || historyReady;
  const unavailable = !loading && !hasSessionData;
  const unavailableDetail =
    session?.detail ||
    history?.detail ||
    error ||
    "No readable session transcript was reported for this agent.";
  const unavailableCommand = session?.command || history?.command;
  // A pane's chat waits quietly while the transcript cannot be read (a
  // server restart, an agent not yet started): the poll keeps trying, and
  // the reason shows only once it has lasted.
  const [unavailableSince, setUnavailableSince] = useState<number | null>(null);
  const [, setUnavailableTick] = useState(0);
  useEffect(() => {
    if (!unavailable) {
      setUnavailableSince(null);
      return;
    }
    setUnavailableSince((since) => since ?? Date.now());
    const timer = window.setTimeout(
      () => setUnavailableTick((tick) => tick + 1),
      UNAVAILABLE_QUIET_MS + 100,
    );
    return () => window.clearTimeout(timer);
  }, [unavailable]);
  const unavailableLasted =
    unavailableSince !== null &&
    Date.now() - unavailableSince >= UNAVAILABLE_QUIET_MS;
  const updatedAt = sessionReady
    ? session.updated_at
    : historyReady
      ? history?.updated_at
      : undefined;

  const sessionActions = sessionReady ? (
    <>
      <button
        type="button"
        className="agent-history-icon"
        onClick={openSessionPreview}
        aria-label="Open transcript"
        title="Open transcript"
      >
        <Eye size={14} />
      </button>
      <button
        type="button"
        className="agent-history-icon"
        onClick={() => downloadSession(pane, connectionClient)}
        aria-label="Export raw session"
        title="Export raw session"
      >
        <Download size={14} />
      </button>
    </>
  ) : null;

  const historySearch = (
    <div className="agent-history-search">
      <input
        type="search"
        aria-label="Search history messages"
        placeholder="Search loaded messages"
        title="Search loaded message text. Tool content is searchable after loading it."
        value={query}
        onChange={(event) => changeFilters(filters, event.currentTarget.value)}
      />
    </div>
  );
  const historyFilters = (
    <>
      {historySearch}
      <AgentHistoryFilters
        filters={filters}
        counts={counts}
        onToggle={(category) =>
          changeFilters({
            ...filters,
            [category]: !filters[category],
          })
        }
      />
    </>
  );
  // The timeline keeps a flat strip above its cards; the chat view gets the
  // side rail beside its bubbles.
  const historyMinimap = (orientation: "auto" | "horizontal") =>
    minimapEntries.length > 1 ? (
      <ConversationMinimap
        entries={minimapEntries}
        scrollerRef={contentRef}
        itemsRef={timelineRef}
        orientation={orientation}
        label="Jump to message"
        className={orientation === "horizontal" ? "agent-history-minimap" : ""}
        onSelect={selectMinimapEntry}
      />
    ) : null;
  const historyCards = (
    <div className="agent-history-timeline" ref={timelineRef}>
      {messageEntries.map(({ message, sequence }) => (
        <AgentHistoryCard
          entry={message}
          index={sequence}
          key={message.id}
          highlighted={highlightedSequence === sequence}
          selected={wide && wideSelectedId === message.id}
          contentLoading={toolEntryLoading.has(message.id)}
          onExpand={
            wide ? (entry) => setWideSelectedId(entry.id) : setExpandedMessage
          }
          onLoadContent={loadToolEntry}
        />
      ))}
    </div>
  );
  const historyEmptyState =
    loading && messages.length === 0 ? (
      <div className="agent-history-state">
        <span className="terminal-loading-dot" />
        Loading messages
      </div>
    ) : visibleMessages.length === 0 ? (
      <div className="agent-history-state">
        {messages.length > 0 ? (
          <>
            {chatView
              ? "No entries match the search."
              : query.trim()
                ? "No entries match the search and selected message types."
                : "No entries match the selected message types."}
            <button
              type="button"
              className="secondary-btn"
              onClick={() =>
                // The chat view only clears its search; the timeline's
                // hidden type filters keep their state.
                changeFilters(chatView ? filters : ALL_HISTORY_FILTERS, "")
              }
            >
              {chatView
                ? "Clear search"
                : query.trim()
                  ? "Reset filters"
                  : "Show all types"}
            </button>
          </>
        ) : (
          "No history entries were found in this session."
        )}
      </div>
    ) : null;
  const historyTimeline = (
    <div className="agent-history-content" ref={contentRef}>
      {historyEmptyState ?? historyCards}
    </div>
  );
  const paneChatShown = !!paneChat;
  const sendConversationRef = useRef<(text: string) => Promise<unknown>>(
    async () => {},
  );
  const sendMessage = useCallback(
    async (text: string) => {
      // Conversation mode has the session: its terminal only holds the
      // pane, and what is typed there would hand it back.
      if (inConversationRef.current) {
        const refused = conversationRefusal(text);
        if (refused) throw new Error(refused);
        await sendConversationRef.current(text);
        return;
      }
      if (ownsRef.current)
        throw new Error(
          "The session is being handed over; try again in a moment.",
        );
      const scope = pollScopeRef.current;
      // Writing a question's own answer ("Type something.") where Enter would
      // tick the box off again: the text alone.
      const answering = paneChat?.prompt?.options.find(
        (option) => option.cursor && option.freeText,
      );
      await sendTerminalComposerText(
        connectionClient,
        pane.pane_id,
        text,
        answering?.checked === undefined,
      );
      if (!connectionClient.isCurrent() || pollScopeRef.current !== scope)
        return;
      // The agent records the prompt in its transcript once it accepts it;
      // refresh shortly instead of waiting for the next poll. A poll still in
      // flight may predate the prompt, so wait for it and load again.
      const refresh = (delay: number) => {
        if (sentRefreshTimerRef.current !== null)
          window.clearTimeout(sentRefreshTimerRef.current);
        sentRefreshTimerRef.current = window.setTimeout(() => {
          sentRefreshTimerRef.current = null;
          if (inFlightRef.current !== null) refresh(500);
          else loadHistory();
        }, delay);
      };
      refresh(1000);
    },
    [connectionClient, loadHistory, pane.pane_id, paneChat?.prompt],
  );
  // Messages sent from the box that the transcript does not show yet
  // (chatOutbox): shown on their way, then replaced by their entries.
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const historyMessagesRef = useRef(history?.messages ?? []);
  historyMessagesRef.current = history?.messages ?? [];
  const settlePaneOutbox = useCallback(
    (entries: readonly AgentHistoryEntry[]) =>
      setOutbox((current) => {
        const mine = current.filter((each) => each.paneId === pane.pane_id);
        const settled = settleOutbox(mine, entries, Date.now());
        return settled === mine
          ? current
          : [
              ...current.filter((each) => each.paneId !== pane.pane_id),
              ...settled,
            ];
      }),
    [pane.pane_id],
  );
  useEffect(() => {
    settlePaneOutbox(history?.messages ?? []);
  }, [history?.messages, settlePaneOutbox]);
  const paneOutbox = useMemo(
    () => outbox.filter((each) => each.paneId === pane.pane_id),
    [outbox, pane.pane_id],
  );
  // What the chat draws: a message its queued, live or transcript bubble
  // shows is hidden here in that same render, then dropped.
  const chatShownUuids = query.trim() ? historyUuids : shownUuids;
  const visibleOutbox = useMemo(
    () => outboxNotShown(paneOutbox, chatShownUuids),
    [chatShownUuids, paneOutbox],
  );
  useEffect(() => {
    if (visibleOutbox === paneOutbox) return;
    setOutbox((current) =>
      current.filter(
        (each) =>
          each.paneId !== pane.pane_id ||
          !each.uuid ||
          !chatShownUuids.has(each.uuid),
      ),
    );
  }, [chatShownUuids, pane.pane_id, paneOutbox, visibleOutbox]);
  useEffect(() => {
    const deadline = nextOutboxDeadline(paneOutbox);
    if (deadline === null) return;
    const timer = window.setTimeout(
      () => settlePaneOutbox(historyMessagesRef.current),
      Math.max(0, deadline - Date.now()) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [paneOutbox, settlePaneOutbox]);
  /**
   * Conversation mode: the message goes to the headless Claude, its
   * uploaded images as images. Sent now, or queued by the bridge while a
   * turn runs (shown with the live turn).
   */
  const sendConversation = useCallback(
    (text: string, uuid?: string) => {
      const images: string[] = [];
      const words: string[] = [];
      for (const piece of messageImagePieces(text))
        if ("image" in piece) images.push(piece.image);
        else words.push(piece.text);
      return sendAgentChat(connectionClient, pane.pane_id, {
        text: images.length ? words.join("\n") : text,
        images,
        ...(uuid ? { uuid } : {}),
      });
    },
    [connectionClient, pane.pane_id],
  );
  sendConversationRef.current = sendConversation;
  /** Sends an outbox message to conversation mode under its own uuid. */
  const deliverConversation = useCallback(
    async (message: OutboxMessage & { uuid: string }) => {
      try {
        await sendConversation(message.text, message.uuid);
        // Sent or queued: the bubble stays until the queue, the live turn
        // or the transcript draws the message (visibleOutbox).
        setOutbox((current) =>
          current.map((each) =>
            each.id === message.id
              ? { ...each, state: "sent", sentAtMs: Date.now() }
              : each,
          ),
        );
      } catch (error) {
        setOutbox((current) =>
          current.map((each) =>
            each.id === message.id
              ? {
                  ...each,
                  state: "failed",
                  reason:
                    error instanceof Error ? error.message : String(error),
                }
              : each,
          ),
        );
      }
    },
    [sendConversation],
  );
  // Messages sent while the session was being handed over wait in the
  // outbox: they go out, in order and under their uuid, once conversation
  // mode has the session, and fail if it stays in the terminal.
  useEffect(() => {
    const held = paneOutbox.filter((each) => each.held);
    if (!held.length) return;
    if (inConversation) {
      const ids = new Set(held.map((each) => each.id));
      setOutbox((current) =>
        current.map((each) =>
          ids.has(each.id) ? { ...each, held: undefined } : each,
        ),
      );
      void (async () => {
        for (const message of held)
          if (message.uuid)
            await deliverConversation({ ...message, uuid: message.uuid });
      })();
    } else if (!owns)
      setOutbox((current) =>
        releaseHeldOutbox(
          current,
          pane.pane_id,
          "The session is in the terminal now; send it again",
        ),
      );
  }, [deliverConversation, inConversation, owns, pane.pane_id, paneOutbox]);
  const sendFromBox = useCallback(
    async (text: string, replacing?: string) => {
      const handingOver = ownsRef.current && !inConversationRef.current;
      if (handingOver || inConversationRef.current) {
        const refused = conversationRefusal(text);
        if (refused) throw new Error(refused);
        // Commands are not the user's words: no bubble on its way.
        if (/^\s*\//.test(text)) {
          if (handingOver)
            throw new Error(
              "The session is being handed over; try again in a moment.",
            );
          await sendConversation(text.trim());
          return;
        }
        const message = {
          ...newOutboxMessage(
            pane.pane_id,
            text,
            historyMessagesRef.current,
            Date.now(),
          ),
          uuid: messageUuid(),
          ...(handingOver ? { held: true as const } : {}),
        };
        setOutbox((current) => [
          ...current.filter((each) => each.id !== replacing),
          message,
        ]);
        if (!handingOver) await deliverConversation(message);
        return;
      }
      // An answer typed into a question, a /command or a ! shell line is
      // not recorded as the user's message: those are sent as before.
      const answering = paneChat?.prompt?.options.some(
        (option) => option.cursor && option.freeText,
      );
      if (answering || /^\s*[/!]/.test(text)) {
        await sendMessage(text);
        return;
      }
      const message = newOutboxMessage(
        pane.pane_id,
        text,
        historyMessagesRef.current,
        Date.now(),
      );
      const update = (patch: Partial<OutboxMessage>) =>
        setOutbox((current) =>
          current.map((each) =>
            each.id === message.id ? { ...each, ...patch } : each,
          ),
        );
      setOutbox((current) => [
        ...current.filter((each) => each.id !== replacing),
        message,
      ]);
      try {
        await sendMessage(text);
        update({ state: "sent", sentAtMs: Date.now() });
      } catch (error) {
        // Kept in the chat, marked, rather than put back in the box.
        update({
          state: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      deliverConversation,
      pane.pane_id,
      paneChat?.prompt,
      sendConversation,
      sendMessage,
    ],
  );
  const retrySend = useCallback(
    (message: OutboxMessage) => void sendFromBox(message.text, message.id),
    [sendFromBox],
  );
  const discardSend = useCallback(
    (message: OutboxMessage) =>
      setOutbox((current) => current.filter((each) => each.id !== message.id)),
    [],
  );
  // /rewind and /tasks typed in a Claude chat open the chat's own picker
  // (AgentRewindSheet) and list of what the session runs on the side, not
  // Claude Code's in its terminal, which would only show as its screen.
  const [rewindOpen, setRewindOpen] = useState(false);
  // In conversation mode, /rewind is done in the terminal: showing it hands
  // the session back once no turn runs.
  const showTerminalRef = useRef(paneChat?.onShowTerminal);
  showTerminalRef.current = paneChat?.onShowTerminal;
  const sendFromChatBox = useCallback(
    async (text: string) => {
      if (
        paneChatShown &&
        pane.agent === "claude" &&
        text.trim() === "/rewind"
      ) {
        if (inConversationRef.current) {
          store.notify({
            kind: "info",
            message: "Rewind in the terminal",
            detail:
              "Conversation mode hands the session back to the terminal; type /rewind there.",
          });
          showTerminalRef.current?.();
        } else setRewindOpen(true);
      } else if (chatPaneId && pane.agent === "claude" && isTasksCommand(text))
        openTask(null);
      else await sendFromBox(text);
    },
    [chatPaneId, openTask, pane.agent, paneChatShown, sendFromBox],
  );
  const notifyComposerError = useCallback((detail: string) => {
    store.notify({ kind: "error", message: "Message input failed", detail });
  }, []);
  const composerDraftKey = terminalComposerDraftKey(
    activeConnectionId,
    connectionGeneration,
    pane.pane_id,
  );
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const voiceStream = useMemo<VoiceStream | undefined>(() => {
    if (!activeConnectionId || pane.agent !== "claude") return undefined;
    const connectionId = activeConnectionId;
    const paneId = pane.pane_id;
    return {
      active: () => conversationRef.current?.state?.phase === "conversation",
      busy: () => {
        const status = conversationRef.current?.state?.status;
        return status === "working" || status === "blocked";
      },
      subscribe: (listener) => onAgentChatEvent(connectionId, paneId, listener),
      send: async (text, options) =>
        (
          await sendAgentChatVoice(connectionClient, paneId, {
            text,
            uuid: options.uuid,
            ...(options.stop ? { stop: true } : {}),
          })
        ).action,
    };
  }, [activeConnectionId, connectionClient, pane.agent, pane.pane_id]);
  const voice = useVoiceChat({
    entries: messages,
    agentStatus: inConversation
      ? conversationAgentStatus(conversationState!.status)
      : pane.agent_status,
    onSend: sendMessage,
    stream: voiceStream,
    onError: (detail) =>
      store.notify({ kind: "error", message: "Voice chat stopped", detail }),
    routeContext: () => ({
      current: voiceSessionId(activeConnectionId, pane.pane_id),
      sessions: voiceSessions(store.get()),
    }),
    onSwitch: (connectionId, paneId) => {
      setPaneView(connectionId, paneId, "chat");
      void store.jumpToConnectionPane(connectionId, paneId);
    },
    ...(paneChat && activeConnectionId
      ? { voiceKey: { connectionId: activeConnectionId, paneId: pane.pane_id } }
      : {}),
  });
  const stopVoice = voice.stop;
  // The chat rebuilt for the same pane (a reconnect does it) goes on with
  // its voice chat: left here when this one goes, before it stops.
  const voiceResumeRef = useRef(voice.resumePoint);
  voiceResumeRef.current = voice.resumePoint;
  const voicePaneRef = useRef({ activeConnectionId, paneId: pane.pane_id });
  voicePaneRef.current = { activeConnectionId, paneId: pane.pane_id };
  useEffect(
    () => () => {
      const point = voiceResumeRef.current();
      const { activeConnectionId: connectionId, paneId } = voicePaneRef.current;
      if (point && connectionId)
        handOffVoice({ connectionId, paneId, message: null, ...point });
    },
    [],
  );
  // Voice talks to one pane: switching panes ends it, unless the router
  // handed it to the pane shown next, which picks it up.
  useEffect(() => stopVoice, [stopVoice, pane.pane_id, activeConnectionId]);
  const takeOverVoice = voice.takeOver;
  useEffect(() => {
    const handed = takeVoiceHandoff(activeConnectionId, pane.pane_id);
    if (handed) takeOverVoice(handed.message, handed.resume);
  }, [takeOverVoice, pane.pane_id, activeConnectionId]);
  useEffect(
    () => voiceTrace(`chat on pane ${pane.pane_id}, ${activeConnectionId}`),
    [pane.pane_id, activeConnectionId],
  );
  // A running voice conversation floats over the chat, not in its box.
  const voiceOverlay =
    paneChat && voice.available && voice.state !== "off" ? (
      <VoiceChatOverlay
        state={voice.state}
        level={voice.level}
        muted={voice.muted}
        heard={voice.heard}
        speechRate={voice.speechRate}
        onToggle={voice.toggle}
        onToggleMute={voice.toggleMute}
        onCycleSpeechRate={voice.cycleSpeechRate}
        moveQuestion={voice.moveQuestion?.text ?? null}
        onAnswerMove={voice.answerMove}
      />
    ) : null;
  // Claude Code gives its whole queue back to the prompt on Up. Taking a
  // message out of the queue, or into the box to edit, goes through that:
  // the prompt is then emptied and what stays queued is sent again, in order.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const agentStatusRef = useRef(pane.agent_status);
  agentStatusRef.current = pane.agent_status;
  const takeQueueBack = useCallback(async (): Promise<
    { entry: AgentHistoryEntry; text: string }[] | null
  > => {
    const queued = messagesRef.current.filter(
      (entry) => entry.queued && entry.role === "user",
    );
    if (!queued.length) return null;
    // An agent that is done has taken its queue already: sending the kept
    // messages again would deliver them twice.
    if (agentStateKind(agentStatusRef.current) !== "working") {
      notifyComposerError("The agent already took its queue");
      return null;
    }
    const texts = await Promise.all(
      queued.map(async (entry) => {
        if (entry.text_bytes === undefined) return entry.text;
        const result = (await connectionClient.call("agent_history.entry", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
          entry_id: entry.id,
        })) as { text?: unknown };
        return typeof result.text === "string" ? result.text : entry.text;
      }),
    );
    const sleep = (ms: number) =>
      new Promise((resolve) => window.setTimeout(resolve, ms));
    await store.sendText(pane.pane_id, "\x1b[A");
    // Claude Code records the queue's return (popAll) once its prompt holds
    // it; emptying the prompt before then would leave the text behind.
    const ids = new Set(queued.map((entry) => entry.id));
    const deadline = Date.now() + 4000;
    while (
      Date.now() < deadline &&
      messagesRef.current.some((entry) => entry.queued && ids.has(entry.id))
    ) {
      loadHistory();
      await sleep(250);
    }
    await sleep(200);
    // Backspace and Delete, as the cursor may be at either end; neither
    // interrupts the agent, as Ctrl+C or Esc would. A few at a time: a write
    // split inside Delete's escape sequence leaves a lone Esc, which puts a
    // vim-mode prompt in normal mode, where Backspace only moves.
    const length = texts.reduce((total, text) => total + text.length + 1, 16);
    for (let sent = 0; sent < length; sent += 4)
      await store.sendText(pane.pane_id, "\x7f\x1b[3~".repeat(4));
    await sleep(300);
    return queued.map((entry, index) => ({ entry, text: texts[index]! }));
  }, [
    connectionClient,
    loadHistory,
    notifyComposerError,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  /**
   * Takes `only` out of the queue, or all of it with none given, and sends
   * the rest again; what was taken goes into the box to edit unless dropped.
   */
  const takeQueued = useCallback(
    async (only: AgentHistoryEntry | null, drop: boolean) => {
      // Claude Code's own queue is in its terminal, which conversation mode
      // does not type into.
      if (ownsRef.current) return;
      try {
        const taken = await takeQueueBack();
        if (!taken) return;
        const picked = taken.filter(
          ({ entry }) => !only || entry.id === only.id,
        );
        for (const { entry, text } of taken)
          if (!picked.some((each) => each.entry === entry))
            await sendMessage(text);
        if (!drop) {
          const draft = readTerminalComposerDraft(composerDraftKey);
          const text = picked.map((each) => each.text).join("\n");
          writeTerminalComposerDraft(
            composerDraftKey,
            draft ? `${text}\n${draft}` : text,
          );
        }
        loadHistory();
      } catch (error) {
        notifyComposerError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [
      composerDraftKey,
      loadHistory,
      notifyComposerError,
      sendMessage,
      takeQueueBack,
    ],
  );
  /**
   * Conversation mode's queue: a message taken out of the bridge's queue,
   * into the box to edit unless dropped.
   */
  const takeConversationQueued = useCallback(
    async (ids: string[], drop: boolean) => {
      try {
        const taken: string[] = [];
        for (const id of ids) {
          const { removed } = await removeAgentChatQueued(
            connectionClient,
            pane.pane_id,
            id,
          );
          // Gone already: sent with the turn that just ended.
          if (removed)
            taken.push(
              [removed.text, ...removed.images].filter(Boolean).join("\n"),
            );
        }
        if (drop || !taken.length) return;
        const draft = readTerminalComposerDraft(composerDraftKey);
        const text = taken.join("\n");
        writeTerminalComposerDraft(
          composerDraftKey,
          draft ? `${text}\n${draft}` : text,
        );
      } catch (error) {
        notifyComposerError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [composerDraftKey, connectionClient, notifyComposerError, pane.pane_id],
  );
  const removeQueued = useCallback(
    (entry: AgentHistoryEntry) => {
      const id = queuedEntryId(entry);
      if (id) void takeConversationQueued([id], true);
      else void takeQueued(entry, true);
    },
    [takeConversationQueued, takeQueued],
  );
  const editQueued = useCallback(
    (entry: AgentHistoryEntry) => {
      const id = queuedEntryId(entry);
      if (id) void takeConversationQueued([id], false);
      else void takeQueued(entry, false);
    },
    [takeConversationQueued, takeQueued],
  );
  // A turn cut short (a Roamgate restart, Claude's process exiting): the
  // chat says so after its last entry, with a Continue that sends a message
  // the usual way. Hidden once clicked, so it cannot go twice.
  const cutOffText =
    pane.agent === "claude" && inConversation
      ? cutOffNotice(conversationState)
      : null;
  const cutOffAt = cutOffText ? conversationState?.interrupted?.at : undefined;
  const [continuedAt, setContinuedAt] = useState<string | null>(null);
  const cutOff = useMemo<ChatCutOff | null>(
    () =>
      cutOffText && cutOffAt && continuedAt !== cutOffAt
        ? {
            text: cutOffText,
            onContinue: () => {
              setContinuedAt(cutOffAt);
              sendFromBox("continue").catch((error: unknown) => {
                setContinuedAt(null);
                store.notify({
                  kind: "error",
                  message: "Could not continue",
                  detail:
                    error instanceof Error ? error.message : String(error),
                });
              });
            },
            onDismiss: () => {
              setContinuedAt(cutOffAt);
              dismissAgentChatInterrupted(connectionClient, pane.pane_id).catch(
                () => setContinuedAt(null),
              );
            },
          }
        : null,
    [
      connectionClient,
      continuedAt,
      cutOffAt,
      cutOffText,
      pane.pane_id,
      sendFromBox,
    ],
  );
  // The rewind handler stays the same across renders, as bubbles compare
  // their handlers: it reads the screen and the status when it runs.
  const readScreenRef = useRef(paneChat?.readScreen);
  readScreenRef.current = paneChat?.readScreen;
  /** Rewinds the session to before `entry`, as /rewind does. */
  const rewind = useCallback(
    async (entry: AgentHistoryEntry, mode: RewindMode) => {
      const readScreen = readScreenRef.current;
      if (!readScreen) return;
      if (agentStatusRef.current.toLowerCase() === "working") {
        store.notify({
          kind: "error",
          message: "Rewind failed",
          detail: "Stop the agent first: Claude Code rewinds between turns.",
        });
        return;
      }
      const messages = messagesRef.current;
      const index = messages.findIndex(
        (each) => each.id === entry.id && each.sent_at === entry.sent_at,
      );
      const after = messages
        .slice(index + 1)
        .filter(
          (each) =>
            each.kind === "message" &&
            each.role === "user" &&
            !each.queued &&
            !each.compact_summary &&
            !each.injected,
        ).length;
      try {
        await rewindClaude(
          {
            readScreen,
            command: (text) =>
              sendTerminalComposerText(
                connectionClient,
                pane.pane_id,
                text,
                true,
              ),
            send: (text) => store.sendText(pane.pane_id, text),
          },
          entry.text,
          after,
          mode,
        );
        if (mode !== "code") {
          setRewound({ id: entry.id, sent_at: entry.sent_at });
          // Claude Code puts the message back in its prompt to edit: it is
          // edited here instead. Backspace and Delete, as in takeQueueBack.
          for (let sent = 0; sent < entry.text.length + 16; sent += 4)
            await store.sendText(pane.pane_id, "\x7f\x1b[3~".repeat(4));
          const draft = readTerminalComposerDraft(composerDraftKey);
          writeTerminalComposerDraft(
            composerDraftKey,
            draft ? `${entry.text}\n${draft}` : entry.text,
          );
        }
        loadHistory();
      } catch (error) {
        store.notify({
          kind: "error",
          message: "Rewind failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [composerDraftKey, connectionClient, loadHistory, pane.pane_id],
  );
  const rewindEntry = useCallback(
    (entry: AgentHistoryEntry, mode: RewindMode) => void rewind(entry, mode),
    [rewind],
  );
  const hasQueued = messages.some(
    (entry) => entry.queued && entry.role === "user",
  );
  const conversationQueue = inConversation ? conversationState!.queue : [];
  // The status the chat goes by: conversation mode's stream when it owns
  // the session, Herdr's otherwise.
  const chatAgentStatus = inConversation
    ? conversationAgentStatus(conversationState!.status)
    : pane.agent_status;
  const chatWorking = chatAgentStatus.toLowerCase() === "working";
  const historyComposer = (
    <AgentHistoryComposer
      // A pane or connection switch must never render, or send, the
      // previous draft before the new one loads.
      key={composerDraftKey}
      draftKey={composerDraftKey}
      onRecallQueued={
        inConversation
          ? conversationQueue.length
            ? () =>
                void takeConversationQueued(
                  conversationQueue.map((item) => item.id),
                  false,
                )
            : undefined
          : hasQueued && pane.agent === "claude"
            ? () => void takeQueued(null, false)
            : undefined
      }
      agent={pane.agent}
      status={chatAgentStatus}
      stateSeq={pane.state_change_seq}
      onStop={
        paneChat && inConversation
          ? conversationState!.status === "working" ||
            conversationState!.status === "blocked"
            ? () =>
                void interruptAgentChat(connectionClient, pane.pane_id).catch(
                  (error: Error) => notifyComposerError(error.message),
                )
            : undefined
          : paneChat && !owns && pane.agent_status.toLowerCase() === "working"
            ? () => paneChat.onKeys("\x1b")
            : undefined
      }
      onSend={sendFromChatBox}
      onUploadImage={(file) => uploadTerminalImage(connectionClient, file)}
      commands={
        inConversation ? conversationCommands(agentCommands) : agentCommands
      }
      onError={notifyComposerError}
      voice={
        paneChat && voice.available
          ? {
              state: voice.state,
              level: voice.level,
              muted: voice.muted,
              held: voice.held,
              onSendHeld: voice.sendHeld,
              onDropHeld: voice.dropHeld,
              onToggle: voice.toggle,
              onToggleMute: voice.toggleMute,
            }
          : undefined
      }
    />
  );
  // An agent's question takes the keys in its card, as in the terminal.
  const promptRef = useRef<HTMLDivElement | null>(null);
  // Blocked, or a menu on its screen though it still counts as working.
  const promptShown =
    !!paneChat &&
    !owns &&
    (pane.agent_status.toLowerCase() === "blocked" ||
      !!paneChat.prompt?.confirm ||
      !!paneChat.prompt?.tabs);
  const promptTyping = !!paneChat?.prompt?.options.some(
    (option) => option.cursor && option.freeText,
  );
  const focusChatBox = useCallback(() => {
    (paneChat?.composerTarget ?? document)
      .querySelector<HTMLElement>(
        ".agent-history-composer :is(textarea, [contenteditable='true'])",
      )
      ?.focus({ preventScroll: true });
  }, [paneChat?.composerTarget]);
  const onPromptKey = (
    event: Pick<
      ReactKeyboardEvent<HTMLDivElement>,
      | "key"
      | "shiftKey"
      | "ctrlKey"
      | "metaKey"
      | "altKey"
      | "preventDefault"
      | "stopPropagation"
    > & { nativeEvent: KeyboardEvent },
  ) => {
    if (!paneChat || event.nativeEvent.isComposing) return;
    const input = promptKeyInput(event, promptTyping);
    if (input === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (input === "box") focusChatBox();
    else paneChat.onKeys(input);
  };
  // The message box is hidden while a question only takes a choice; an
  // answer of one's own ("Type something.") is written in it.
  // A permission or the hook's questions have their own fields.
  const boxHidden = (promptShown && !promptTyping) || !!paneChat?.permission;
  // The box gets the keys back when the agent's permission prompt goes.
  const permissionId = paneChat?.permission?.id;
  const permissionWas = useRef(permissionId);
  useEffect(() => {
    const was = permissionWas.current;
    permissionWas.current = permissionId;
    if (!was || permissionId) return;
    const active = document.activeElement;
    if (!active || active === document.body)
      requestAnimationFrame(focusChatBox);
  }, [permissionId, focusChatBox]);
  // A question takes the keys when it comes, unless the user is writing; the
  // box gets them for an answer of one's own, and back when it goes.
  const promptWas = useRef<"none" | "choice" | "typing">("none");
  useEffect(() => {
    const now = !promptShown ? "none" : promptTyping ? "typing" : "choice";
    const was = promptWas.current;
    promptWas.current = now;
    if (now === was) return;
    const active = document.activeElement;
    const idle =
      !active ||
      active === document.body ||
      !!active.closest(".agent-history-composer, .agent-chat-prompt");
    if (now === "typing") {
      if (idle) requestAnimationFrame(focusChatBox);
    } else if (now === "choice") {
      if (
        idle &&
        (was === "typing" ||
          !readTerminalComposerDraft(composerDraftKey).trim())
      )
        requestAnimationFrame(() =>
          promptRef.current?.focus({ preventScroll: true }),
        );
    } else if (!active || active === document.body)
      requestAnimationFrame(focusChatBox);
  }, [promptShown, promptTyping, composerDraftKey, focusChatBox]);
  // With nothing focused (the hidden box had the keys, say), they still go
  // to the question.
  const onPromptKeyRef = useRef(onPromptKey);
  onPromptKeyRef.current = onPromptKey;
  useEffect(() => {
    if (!promptShown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target !== document.body) return;
      promptRef.current?.focus({ preventScroll: true });
      onPromptKeyRef.current({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        nativeEvent: event,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promptShown]);
  // Tab from an empty message box goes to the question. The box is a
  // child of the bottom bar on a phone, so this is caught on the drawer
  // (events come up through the portal), with no element around the box.
  const onComposerKeyCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      event.key !== "Tab" ||
      event.shiftKey ||
      !promptShown ||
      !(event.target as HTMLElement).closest?.(".agent-history-composer") ||
      readTerminalComposerDraft(composerDraftKey).trim()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    promptRef.current?.focus({ preventScroll: true });
  };
  // Hidden by not being drawn: its draft stays in the store.
  const shownComposer = boxHidden ? null : historyComposer;
  const paneComposer = paneChat?.composerTarget
    ? createPortal(shownComposer, paneChat.composerTarget)
    : shownComposer;
  // What the agent is doing, or asking, under the conversation; also shown
  // before it has one (a new session asking to trust its folder).
  const chatStatus = (
    <>
      {paneChat && inConversation && chatWorking ? (
        <div className="agent-chat-activity" role="status">
          <span className="agent-chat-activity-mark" aria-hidden="true" />
          <strong>{conversationActivity(conversationState!.activity)}</strong>
        </div>
      ) : paneChat &&
        !owns &&
        !promptShown &&
        pane.agent_status.toLowerCase() === "working" ? (
        <div className="agent-chat-activity" role="status">
          <span className="agent-chat-activity-mark" aria-hidden="true" />
          <strong>{paneChat.activity?.word ?? "Working…"}</strong>
          {paneChat.activity?.detail ? (
            <span>{paneChat.activity.detail}</span>
          ) : null}
        </div>
      ) : null}
      {promptShown ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the menu's keys
        <div
          ref={promptRef}
          className="agent-chat-prompt"
          role="status"
          tabIndex={-1}
          onKeyDown={onPromptKey}
        >
          <strong>{pane.agent ?? "The agent"} is waiting for you</strong>
          {paneChat.prompt?.tabs ? (
            // AskUserQuestion's questions: the one shown, and the others.
            <div className="agent-chat-prompt-tabs" role="tablist">
              {paneChat.prompt.tabs.map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  role="tab"
                  aria-selected={tab.current}
                  className={`${tab.current ? "is-current" : ""}${
                    tab.done ? " is-done" : ""
                  }`}
                  onClick={() => {
                    if (tab.input) paneChat.onKeys(tab.input);
                  }}
                >
                  {tab.done ? <Check size={13} aria-hidden="true" /> : null}
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
          {paneChat.prompt?.lines.length ? (
            <pre>
              {paneChat.prompt.lines
                .filter((line) =>
                  paneChat.prompt?.options.every(
                    (option) =>
                      !line.includes(
                        option.key
                          ? `${option.key}. ${option.label}`
                          : option.label,
                      ),
                  ),
                )
                .join("\n")}
            </pre>
          ) : null}
          <div
            className={`agent-chat-prompt-actions${
              paneChat.prompt?.options.some((option) => option.detail)
                ? " has-details"
                : ""
            }`}
          >
            {paneChat.prompt?.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`secondary-btn${option.cursor ? " is-cursor" : ""}`}
                aria-current={option.cursor ? "true" : undefined}
                onClick={() => paneChat.onKeys(option.input)}
              >
                {option.key ? <kbd>{option.key}</kbd> : null}{" "}
                {option.checked === undefined ? null : option.checked ? (
                  <SquareCheck size={15} aria-label="picked" />
                ) : (
                  <Square size={15} aria-label="not picked" />
                )}{" "}
                {option.label}
                {option.detail ? <small>{option.detail}</small> : null}
              </button>
            ))}
          </div>
          {paneChat.prompt?.submit ? (
            <button
              type="button"
              className="secondary-btn agent-chat-prompt-submit"
              onClick={() => {
                if (paneChat.prompt?.submit)
                  paneChat.onKeys(paneChat.prompt.submit);
              }}
            >
              Submit these answers
            </button>
          ) : null}
          <small className="agent-chat-prompt-hint">
            {promptTyping
              ? "Write your answer in the message box · Enter sends it"
              : "↑↓ or j k · 1–9 · Tab · Enter · Esc"}
          </small>
          {/* The menu's own keys: moving between questions and choices,
              confirming, cancelling. */}
          <div className="agent-chat-prompt-keys" aria-label="Keys">
            {PROMPT_KEYS.filter(
              // The tabs move between questions themselves.
              ([, input]) =>
                !paneChat.prompt?.tabs ||
                (input !== "\x1b[D" && input !== "\x1b[C"),
            ).map(([label, input, name]) => (
              <button
                key={name}
                type="button"
                className="secondary-btn"
                aria-label={name}
                title={name}
                onClick={() => paneChat.onKeys(input)}
              >
                <kbd>{label}</kbd>
              </button>
            ))}
            <button
              type="button"
              className="secondary-btn"
              onClick={paneChat.onShowTerminal}
            >
              <SquareTerminal size={13} /> Terminal
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
  const historyChat = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the box has its own keys
    <div
      className="agent-history-messages"
      role="region"
      aria-label="History messages"
      onClick={(event) => {
        // A click on the chat (not on a control, nor ending a selection)
        // goes to its message box, on a desktop; on a phone it would bring
        // the keyboard up with every tap.
        const target = event.target as Element;
        if (
          !paneComposer ||
          target.closest(
            "button, a, input, textarea, select, summary, label, [role='button'], [contenteditable='true'], .agent-history-composer",
          ) ||
          window.getSelection()?.isCollapsed === false ||
          window.matchMedia("(pointer: coarse)").matches
        )
          return;
        event.currentTarget
          .querySelector<HTMLElement>(
            ".agent-history-composer :is(textarea, [contenteditable='true'])",
          )
          ?.focus({ preventScroll: true });
      }}
    >
      {!paneChat || searchOpen || query ? historySearch : null}
      {paneChat && open && !caughtUp && messages.length > 0 ? (
        <div
          className="agent-chat-catching-up"
          role="status"
          aria-label="Updating the conversation"
          title="Updating the conversation"
        />
      ) : null}
      {(visibleOutbox.length ? null : historyEmptyState) ??
        (paneChat && chatThreadsKey && activeConnectionId ? (
          // The chat's threads: comments on parts of the agent's messages.
          <ChatThreadsProvider
            connectionId={activeConnectionId}
            workspaceId={pane.workspace_id}
            chat={chatThreadsKey}
            path={pane.foreground_cwd ?? pane.cwd ?? ""}
            agent={pane.agent ?? "agent"}
            paneId={pane.pane_id}
          >
            <div className="agent-history-chat-frame">
              <AgentHistoryChat
                items={chatItems}
                listRef={contentRef}
                contentRef={timelineRef}
                highlightedSequence={highlightedSequence}
                followKey={query}
                toolLoading={toolEntryLoading}
                onLoadTool={loadToolEntry}
                onOpen={setExpandedMessage}
                imageUrl={imageUrl}
                outbox={visibleOutbox}
                onRetrySend={retrySend}
                onDiscardSend={discardSend}
                tasks={paneChat ? tasksById : undefined}
                onOpenTask={openTask}
                onRemoveQueued={
                  paneChat && pane.agent === "claude" ? removeQueued : undefined
                }
                onEditQueued={
                  paneChat && pane.agent === "claude" ? editQueued : undefined
                }
                onRewind={
                  paneChat && pane.agent === "claude" && !owns
                    ? rewindEntry
                    : undefined
                }
                cutOff={cutOff}
              />
              {historyMinimap("auto")}
            </div>
          </ChatThreadsProvider>
        ) : (
          <div className="agent-history-chat-frame">
            <AgentHistoryChat
              items={chatItems}
              listRef={contentRef}
              contentRef={timelineRef}
              highlightedSequence={highlightedSequence}
              followKey={query}
              toolLoading={toolEntryLoading}
              onLoadTool={loadToolEntry}
              onOpen={setExpandedMessage}
              imageUrl={imageUrl}
              outbox={visibleOutbox}
              onRetrySend={retrySend}
              onDiscardSend={discardSend}
              tasks={paneChat ? tasksById : undefined}
              onOpenTask={openTask}
              onRemoveQueued={
                paneChat && pane.agent === "claude" ? removeQueued : undefined
              }
              onEditQueued={
                paneChat && pane.agent === "claude" ? editQueued : undefined
              }
              onRewind={
                paneChat && pane.agent === "claude" && !owns
                  ? rewindEntry
                  : undefined
              }
              cutOff={cutOff}
            />
            {historyMinimap("auto")}
          </div>
        ))}
      {voiceOverlay}
      {paneChat?.permission ? (
        <AgentPermissionCard prompt={paneChat.permission} />
      ) : (
        chatStatus
      )}
      {paneComposer}
    </div>
  );
  // Who has the session, in the chat's header: the terminal's Claude or
  // conversation mode, and why a takeover was refused.
  const owner =
    pane.agent === "claude" && conversationState
      ? ownershipLabel({
          chat: conversationState,
          refusal: conversation?.refusal ?? null,
          handing: conversation?.handing ?? null,
        })
      : null;
  const ownerChip = owner ? (
    <span
      className={`agent-chat-owner is-${owner.tone}`}
      role="status"
      title={owner.detail ?? owner.label}
    >
      {owner.label}
      {owner.detail && owner.tone === "terminal" ? (
        <small>{owner.detail}</small>
      ) : null}
      {owner.tone === "terminal" && conversationState?.phase === "terminal" ? (
        // The user's own switch: it goes ahead whatever other devices show.
        <button
          type="button"
          className="agent-chat-owner-switch ghost"
          title="Hand this session to conversation mode"
          onClick={() =>
            void requestAgentChatHandover(
              connectionClient,
              pane.pane_id,
              "conversation",
            )
          }
        >
          Switch here
        </button>
      ) : null}
    </span>
  ) : null;
  const changeView = (next: AgentHistoryView) => {
    setView(next);
    writeAgentHistoryView(next);
    setDetailsOpen(false);
    setExpandedMessage(null);
  };

  // Wide layout: master-detail. The left column is a resizable list of
  // compact entries; the right column reads the selected entry in full.
  const wideMessagesPanel = (
    <div
      className="agent-history-wide"
      ref={wideSplitRef}
      role="region"
      aria-label="History messages"
      style={
        {
          "--agent-history-list-width": `${wideListRatio * 100}%`,
        } as CSSProperties
      }
    >
      <div className="agent-history-wide-list">
        {historyFilters}
        {historyMinimap("horizontal")}
        {historyTimeline}
      </div>
      <div
        className="workspace-inspector-split-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize message list"
        aria-orientation="vertical"
        aria-valuemin={15}
        aria-valuemax={75}
        aria-valuenow={Math.round(wideListRatio * 100)}
        title="Drag to resize; double-click to reset"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          updateWideRatioFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateWideRatioFromPointer(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onDoubleClick={() =>
          setWideListRatio(DEFAULT_INSPECTOR_NAVIGATION_RATIO)
        }
        onKeyDown={handleWideResizerKeyDown}
      />
      <div className="agent-history-wide-detail">
        {wideSelectedEntry ? (
          <AgentMessageContent
            message={hydrateEntry(wideSelectedEntry)}
            embedded
            onClose={() => setWideSelectedId(null)}
          />
        ) : (
          <div className="agent-history-wide-placeholder">
            Select a message to read it here.
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {paneChat && rewindOpen ? (
        <AgentRewindSheet
          entries={messages}
          onRewind={rewindEntry}
          onClose={() => setRewindOpen(false)}
        />
      ) : null}
      {/* Once it is known which session's place to open on. */}
      {paneChat && tasksOpen && tasksLoaded ? (
        <AgentTasksSheet
          pane={pane}
          tasks={tasks}
          session={tasksSession}
          initialTaskId={openTaskId}
          onClose={() => setTasksOpen(false)}
        />
      ) : null}
      <aside
        className={`agent-history-drawer ${open ? "is-open" : ""} ${
          embedded ? "is-embedded" : ""
        } ${wide ? "is-wide" : ""}${paneChat ? " is-pane-chat" : ""}`}
        aria-label="Agent session"
        aria-hidden={!open}
        inert={!open}
        onKeyDownCapture={onComposerKeyCapture}
      >
        <div className="agent-history-drawer-head">
          {paneChat ? (
            <>
              <AgentIcon agent={pane.agent} />
              {/* The workspace names it until its title is read. */}
              <span
                className={`agent-chat-title${sessionTitle ? "" : " is-placeholder"}`}
                title={sessionTitle ?? workspaceLabel}
              >
                {sessionTitle ?? workspaceLabel}
              </span>
            </>
          ) : (
            <div className="agent-history-identity">
              <AgentIcon agent={pane.agent} />
              <div className="agent-history-title">
                <strong>
                  {sessionTitle ?? "Session"}
                  {messages.length > 0 ? (
                    <span
                      className="agent-history-count"
                      aria-label={`${visibleMessages.length} of ${messages.length} history entries`}
                      title="Most recent 200 messages with their tool entries"
                    >
                      {visibleMessages.length === messages.length
                        ? messages.length
                        : `${visibleMessages.length}/${messages.length}`}
                    </span>
                  ) : null}
                </strong>
                <span title={workspaceLabel}>
                  {workspaceLabel} · {pane.agent ?? "Agent"} ·{" "}
                  {shortId(pane.pane_id)}
                </span>
              </div>
            </div>
          )}
          {ownerChip}
          <span
            className={`agent-history-status is-${(paneChat ? chatAgentStatus : pane.agent_status).toLowerCase()}`}
          >
            {paneChat ? chatAgentStatus : pane.agent_status}
          </span>
          <div className="agent-history-actions">
            {paneChat ? (
              <>
                <AgentArtifactsMenu artifacts={artifacts} />
                {tasks.length ? (
                  <button
                    type="button"
                    className={`agent-history-icon agent-chat-tasks-button${runningTasks ? " is-running" : ""}`}
                    aria-label={`Background tasks: ${runningTasks} running`}
                    title={shortcutTitle(
                      "Background commands, subagents and workflows",
                      "pane.tasks",
                    )}
                    onClick={() => openTask(null)}
                  >
                    <ListChecks size={14} />
                    {runningTasks ? <span>{runningTasks}</span> : null}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="agent-history-icon"
                  aria-label="Search the conversation"
                  aria-pressed={searchOpen}
                  title="Search"
                  onClick={() => {
                    if (searchOpen) changeFilters(filters, "");
                    setSearchOpen(!searchOpen);
                  }}
                >
                  <Search size={14} />
                </button>
                <button
                  type="button"
                  className="agent-history-icon"
                  aria-label="Show the terminal"
                  title="Show the terminal"
                  onClick={paneChat.onShowTerminal}
                >
                  <SquareTerminal size={14} />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="agent-history-icon"
                  aria-label="Chat view"
                  aria-pressed={chatView && !detailsOpen}
                  title={
                    chatView && !detailsOpen
                      ? "Show as timeline"
                      : "Show as chat"
                  }
                  onClick={() =>
                    changeView(chatView && !detailsOpen ? "timeline" : "chat")
                  }
                  disabled={!hasSessionData}
                >
                  <MessagesSquare size={14} />
                </button>
                <button
                  type="button"
                  className="agent-history-icon"
                  aria-label="Session details"
                  aria-pressed={detailsOpen}
                  title={detailsOpen ? "Show history" : "Show session details"}
                  onClick={() => setDetailsOpen((current) => !current)}
                  disabled={!hasSessionData}
                >
                  <Info size={14} />
                </button>
              </>
            )}
            {paneChat ? null : sessionActions}
            <button
              type="button"
              className={`agent-history-icon ${loading ? "is-loading" : ""}`}
              onClick={loadHistory}
              aria-label="Refresh session"
              title="Refresh"
              disabled={loading}
            >
              <RefreshCw size={14} />
            </button>
            {!embedded ? (
              <button
                type="button"
                className="agent-history-icon"
                onClick={() => onOpenChange(false)}
                aria-label="Close session"
                title="Close"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        </div>

        {unavailable && paneChat ? (
          <div className="agent-chat-waiting" role="status">
            <span className="agent-chat-activity-mark" aria-hidden="true" />
            <span>No conversation yet</span>
            {unavailableLasted ? <small>{unavailableDetail}</small> : null}
          </div>
        ) : unavailable ? (
          <div className="agent-history-unavailable" role="status">
            <strong>Session unavailable</strong>
            <p>{unavailableDetail}</p>
            {unavailableCommand ? (
              <div className="agent-history-command-row">
                <code>{unavailableCommand}</code>
                <button
                  type="button"
                  className="agent-history-icon"
                  onClick={() => void copyTextWithFeedback(unavailableCommand)}
                  aria-label="Copy integration command"
                  title="Copy command"
                >
                  <Copy size={13} />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="secondary-btn"
              onClick={loadHistory}
            >
              <RefreshCw size={13} />
              Retry
            </button>
          </div>
        ) : null}
        {unavailable && paneChat ? (
          // A pane's chat still types into the agent, and answers its
          // questions, without its transcript.
          <>
            {voiceOverlay}
            {paneChat.permission ? (
              <AgentPermissionCard prompt={paneChat.permission} />
            ) : (
              chatStatus
            )}
            {paneComposer}
          </>
        ) : unavailable ? null : (
          <>
            {error ? <div className="agent-history-error">{error}</div> : null}
            {!detailsOpen ? (
              chatView ? (
                historyChat
              ) : wide ? (
                wideMessagesPanel
              ) : (
                <div
                  className="agent-history-messages"
                  role="region"
                  aria-label="History messages"
                >
                  {historyFilters}
                  {historyMinimap("horizontal")}
                  {historyTimeline}
                </div>
              )
            ) : (
              <div
                className="agent-history-details"
                role="region"
                aria-label="Session details"
              >
                {sessionReady ? (
                  <section
                    className="agent-history-overview"
                    aria-label="Session overview"
                  >
                    <div>
                      <strong>{formatCount(session.stats.turns)}</strong>
                      <span>Turns</span>
                    </div>
                    <div>
                      <strong>{formatTokenTotal(session)}</strong>
                      <span>Tokens</span>
                    </div>
                    <div>
                      <strong
                        title={
                          updatedAt ? formatUiDateTime(updatedAt) : undefined
                        }
                      >
                        {updatedAt ? formatRelativeTime(updatedAt) : "-"}
                      </strong>
                      <span>Updated</span>
                    </div>
                    <p>
                      Input {formatOptionalCompact(usage?.input_tokens)}
                      <span>·</span>
                      Cached {formatOptionalCompact(usage?.cached_input_tokens)}
                      <span>·</span>
                      Output {formatOptionalCompact(usage?.output_tokens)}
                    </p>
                  </section>
                ) : null}
                <DetailRow label="Workspace" value={workspaceLabel} />
                <DetailRow label="Agent" value={pane.agent ?? "-"} />
                <DetailRow label="Pane" value={shortId(pane.pane_id)} />
                <DetailRow
                  label="Session ID"
                  value={session?.session?.value || "-"}
                  copyable={!!session?.session?.value}
                />
                <DetailRow
                  label="Session file"
                  value={session?.path || history?.path || "-"}
                  copyable={!!(session?.path || history?.path)}
                />
                <DetailRow
                  label="Records"
                  value={
                    sessionReady ? formatCount(session.stats.records) : "-"
                  }
                />
                <DetailRow
                  label="File size"
                  value={sessionReady ? formatBytes(session.file?.size) : "-"}
                />
                <DetailRow
                  label="Reasoning"
                  value={formatOptionalCompact(usage?.reasoning_output_tokens)}
                />
                <DetailRow
                  label="Updated"
                  value={updatedAt ? formatUiDateTime(updatedAt) : "-"}
                />
              </div>
            )}
          </>
        )}
      </aside>
      <AgentMessageDialog
        message={
          !masterDetail && expandedMessage
            ? hydrateEntry(expandedMessage)
            : null
        }
        onClose={closeExpandedMessage}
      />
      <AgentSessionPreviewDialog
        pane={previewPane}
        summary={previewSummary}
        loading={previewLoading}
        error={previewError}
        onClose={closeSessionPreview}
      />
    </>
  );
}

function DetailRow({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="agent-history-detail-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
      {copyable ? (
        <button
          type="button"
          className="agent-history-icon"
          onClick={() => void copyTextWithFeedback(value)}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
        >
          <Copy size={13} />
        </button>
      ) : null}
    </div>
  );
}
