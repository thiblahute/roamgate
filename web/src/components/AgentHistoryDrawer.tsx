import { useRenderTrace } from "../renderTrace";
import { shellLine } from "../../../shared/bashMode";
import {
  type AgentChatMcpRequest,
  chatCapabilities,
  isConversationAgent,
} from "../../../shared/agentChat";
import { ShellCommandBlock } from "./AgentChatShell";
import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { boxSuspends, isSuspendKey } from "../conversationSuspend";
import { workspaceFileUrl } from "../workspaceFileUrl";
import {
  Check,
  Copy,
  ChevronDown,
  Download,
  Eye,
  Info,
  MessagesSquare,
  Pause,
  RefreshCw,
  ListChecks,
  Search,
  Square,
  SquareCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import { useLayoutPreferences } from "../layoutPreferences";
import {
  agentHistoryCacheKey,
  cachedAgentHistory,
  loadAgentHistoryCache,
  rememberAgentHistory,
} from "../agentHistoryCache";
import { store, useStoreSelector } from "../store";
import { useInspectorCommands } from "../useInspectorCommands";
import {
  type AgentChatSnapshot,
  answerAgentChatApiKey,
  cutOffNotice,
  deliveryNotice,
  dismissAgentChatInterrupted,
  dismissAgentChatModelNotice,
  listAgentChatMcp,
  listAgentChatModels,
  runAgentChatMcpAction,
  setAgentChatModel,
  QUEUE_STALL_MS,
  queueWaiting,
  recoverAgentChat,
  interruptAgentChat,
  backgroundAgentChatTool,
  stopAgentChatTask,
  runAgentChatShell,
  stopAgentChatShell,
  lastUserUuid,
  rewindAgentChat,
  checkAgentChatRewind,
  messageUuid,
  onAgentChatEvent,
  queuedEntries,
  queuedEntryId,
  removeAgentChatQueued,
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
} from "../agentChatOwnership";
import { watchAgentHistory } from "../agentHistoryPush";
import { messageImagePieces } from "../chatImages";
import { liveTurnEntries, reconcileLiveTurn } from "./liveTurn";
import {
  listedFiles,
  noCheckpointQuestion,
  rewindClaude,
  type RewindMode,
} from "../claudeRewind";
import { AgentRewindSheet } from "./AgentRewindSheet";
import { AgentMcpSheet } from "./AgentMcpSheet";
import { AgentModelSheet } from "./AgentModelSheet";
import { parseModelCommand } from "../../../shared/agentModels";
import { copyTextWithFeedback } from "../copyText";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { sentImageUrl } from "../sentImages";
import {
  readTerminalComposerDraft,
  TerminalComposerSubmitKeyError,
  terminalComposerDraftKey,
  writeTerminalComposerDraft,
} from "../terminalComposer";
import { sendTerminalComposerText } from "../terminalComposerSend";
import { downscaleImage } from "../imageDownscale";
import {
  uploadTerminalFile,
  uploadTerminalImage,
} from "../terminalImageUpload";
import type { AgentActivity, AgentPrompt } from "../agentPrompt";
import { AgentArtifactsMenu } from "./AgentArtifactsMenu";
import { useAgentArtifacts } from "../agentArtifacts";
import type { AgentPermissionPrompt } from "../../../shared/review";
import { AgentPermissionCard } from "./AgentPermissionCard";
import { AgentTasksSheet, RunningNowLink } from "./AgentTasksSheet";
import { AgentStatusChip } from "./AgentStatusChip";
import { ModelChip } from "./ModelChip";
import { refreshSessionProfile } from "../sessionProfiles";
import { ProfileChip } from "./ProfileChip";
import { AgentChatOwnerChip } from "./AgentChatOwnerChip";
import { branchRequests, conversationRequests } from "../forgeRefs";
import { useForgeSession } from "../forgeStore";
import { type ForgeChat, ForgeChatProvider } from "./ForgeChip";
import { ForgeHeaderChips, ForgeRequestsMenu } from "./ForgeRequests";
import { useAgentTasks } from "../agentTasks";
import { isTasksCommand, onAgentTasksRequest } from "../agentTasksOpen";
import { shortcutTitle } from "../shortcutPreferences";
import {
  conversationCommands,
  conversationRefusal,
  isMcpCommand,
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
import {
  type ChatApiKeyQuestion,
  type ChatCutOff,
  type ChatDelivery,
  type ChatItem,
  type ChatModelNotice,
} from "./AgentHistoryChat";
import { DeferredAgentHistoryChat } from "./AgentHistoryChat";
import { AgentHistoryComposer } from "./AgentHistoryComposer";
import { withShellOutcomes } from "../shellOutcomes";
import { listenOrSayWhy } from "../speechEngine";
import { noteRewind, voiceFronting, voiceTrace } from "../voiceChat";
import { agentStateKind } from "./agentSession";
import { useVoiceChat, type VoiceStream } from "./useVoiceChat";
import { VoiceChatOverlay } from "./VoiceChatOverlay";
import { subscribeVoiceRecording } from "../voiceLibrary";
import { AgentHistoryFilters } from "./AgentHistoryFilters";
import { scrollChatTo } from "./chatPaging";
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
  addOlderPage,
  canLoadOlder,
  endOlder,
  historyLoadError,
  mergeAgentHistory,
  oldestShownEntry,
  retryOnceOnTimeout,
  slideOlder,
  withOlderEntries,
  type OlderHistory,
  type OlderHistoryPage,
  isToolContentPending,
  selectHistoryEntries,
  toolOverlayMatches,
  type ToolTextOverlay,
  type HistoryFilters,
  type AgentHistory,
  type AgentHistoryResponse,
  type HistoryEntry as AgentHistoryEntry,
} from "./agentHistory";
import {
  createHistoryRefreshGate,
  type HistoryRefreshGate,
} from "./historyRefresh";
import { AgentSessionPreviewDialog } from "./AgentSessionPreviewDialog";
import {
  type AgentSessionSummary,
  downloadSession,
  formatBytes,
  formatCount,
  formatOptionalCompact,
  formatTokenTotal,
  agentPromptWarning,
  tokenUsage,
} from "./agentSession";
import {
  newOutboxMessage,
  nextOutboxDeadline,
  releaseHeldOutbox,
  type OutboxMessage,
  outboxNotShown,
  readOutbox,
  settleOutbox,
  subscribeOutbox,
  updateOutbox,
} from "./chatOutbox";
import { promptKeyInput } from "./promptKeys";
import { handOffVoice, takeVoiceHandoff, voiceSessions } from "../voiceRoute";
import { callCompanion } from "../companionCallOpen";
import { answerAgentPrompt } from "../review";
import {
  answerPromptByVoice,
  questionFromPermission,
  questionFromPrompt,
  type QuestionAnswer,
  type VoiceQuestion,
} from "../voiceCompanion";
import { setPaneView } from "../paneView";
import { ChatThreadsProvider } from "./ChatThreads";
import { paneChatSource } from "../chatSource";
import { LimitPauseNotice } from "./LimitPauseChip";
import { chatPlaceKey } from "../chatPlace";
import { ConfirmDialog } from "./ModalDialogs";
import { ZenDock } from "./ZenIsland";
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
// How many entries scrolling to the top reads before what is shown.
const OLDER_PAGE_SIZE = 50;
// How close to the top of the list counts as scrolled to it.
const OLDER_TRIGGER_PX = 48;

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
    prompt?: AgentPrompt | null;
    /** What the working agent says it is doing, from its screen. */
    activity?: AgentActivity | null;
    /** What its permission hook waits on, answered here. */
    permission?: AgentPermissionPrompt;
    onShowTerminal: () => void;
    /**
     * Ctrl+Z, `:suspend` and the header's Suspend: the conversation is
     * suspended as a job of the pane's shell (`fg` there brings it back), with
     * its title for the stopped job's line. Conversation mode only.
     */
    onSuspend?: (title: string | null) => void;
    /**
     * The pane is the active one: only its question takes keys typed with
     * nothing focused, or moves the focus.
     */
    active?: boolean;
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
    /**
     * The chat is the pane's conversation mode (one view per mode): its
     * terminal button hands the session back to the terminal.
     */
    modeBound?: boolean;
  };
  onOpenChange: (open: boolean) => void;
}) {
  const { mobile } = useLayoutPreferences();
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const headerId = useId();
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mobile && searchOpen) searchInputRef.current?.focus();
  }, [mobile, searchOpen]);
  useRenderTrace("AgentHistoryDrawer");
  const workspaces = useStoreSelector((state) => state.workspaces);
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const connectionGeneration = useStoreSelector(
    (state) => state.connectionGeneration,
  );
  // Where `!` lines run, as the chat says it.
  const connectionLabel = useStoreSelector(
    (state) =>
      state.connections.find(
        (connection) => connection.id === state.activeConnectionId,
      )?.label,
  );
  const connectionClient = useConnectionClient();
  const mobileProfileChip = mobile ? (
    <ProfileChip
      client={connectionClient}
      paneId={pane.pane_id}
      enabled={isConversationAgent(pane.agent)}
      agentStatus={pane.agent_status}
      onError={(message) =>
        store.notify({
          kind: "error",
          message: "Profile switch refused",
          detail: message,
        })
      }
    />
  ) : null;
  // Paused by a usage limit: said at the chat's end, with its buttons.
  const hasPaneChat = !!paneChat;
  const limitNotice = useMemo(
    () =>
      hasPaneChat ? (
        <LimitPauseNotice client={connectionClient} paneId={pane.pane_id} />
      ) : null,
    [hasPaneChat, connectionClient, pane.pane_id],
  );
  // Images the user uploaded load from the pane's host.
  const imageUrl = useCallback(
    (path: string) =>
      workspaceFileUrl(connectionClient, pane.workspace_id, path, {
        inline: true,
      }),
    [connectionClient, pane.workspace_id],
  );
  // Images sent inline in a message load from the session itself.
  const sentImage = useCallback(
    (uuid: string, index: number) =>
      sentImageUrl(
        connectionClientScopeKey(connectionClient, pane.pane_id, uuid, index),
        () =>
          // Images fill in behind the conversation: background work.
          connectionClient.call(
            "agent_history.image",
            {
              pane_id: pane.pane_id,
              workspace_id: pane.workspace_id,
              tab_id: pane.tab_id,
              agent: pane.agent,
              uuid,
              index,
            },
            undefined,
            { lane: "background" },
          ),
      ),
    [
      connectionClient,
      pane.pane_id,
      pane.workspace_id,
      pane.tab_id,
      pane.agent,
    ],
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
  const agentCommands = useAgentCommands(pane, open);
  const artifacts = useAgentArtifacts(pane, !!paneChat && open);
  // What the session runs on the side, followed while the chat shows.
  const {
    tasks,
    runningNow: readRunningNow,
    session: tasksSession,
    loaded: tasksLoaded,
  } = useAgentTasks(pane, !!paneChat && open);
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
    return onAgentTasksRequest(chatPaneId, (request) => {
      if (request) {
        setOpenTaskId(request.taskId);
        setTasksOpen(true);
        return;
      }
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
  const drawerRef = useRef<HTMLElement>(null);
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
  // What scrolling up read before the window (agent_history.older).
  const [older, setOlder] = useState<OlderHistory | null>(null);
  const olderRef = useRef<OlderHistory | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const olderLoadingRef = useRef(false);
  const olderSeqRef = useRef(0);
  // The first entry in view when older ones were asked for, and where it
  // was: it stays there once they are put in front of it.
  const olderAnchorRef = useRef<{ element: Element; top: number } | null>(null);
  const sessionRef = useRef<AgentSessionSummary | null>(session);
  // One read at a time; pushes, polls and sends meanwhile fold into a single
  // read after it, a short pause later.
  const refreshGateRef = useRef<HistoryRefreshGate | null>(null);
  refreshGateRef.current ??= createHistoryRefreshGate();
  const refreshGate = refreshGateRef.current;
  const sessionReadRef = useRef<Promise<unknown> | null>(null);
  const paneIdRef = useRef(pane.pane_id);
  paneIdRef.current = pane.pane_id;
  // Entries whose content fetch failed; suppresses auto-refetch loops while
  // keeping the card's manual Load button usable.
  const toolEntryFailedRef = useRef<Set<string>>(new Set());

  const readHistory = useCallback(() => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(!historyRef.current);
    const isCurrentRead = () =>
      connectionClient.isCurrent() && loadSeqRef.current === seq;
    // The chat stops saying it catches up once the history answers, or is
    // first slow to: what it shows stays, and the session summary and a
    // retry carry on unseen.
    const slow = () => {
      if (isCurrentRead()) setCaughtUp(true);
    };
    const settled = () => {
      if (!isCurrentRead()) return;
      setLoading(false);
      setCaughtUp(true);
    };
    const requested = historyRef.current?.cursor ?? null;
    const params = {
      history_version: 2,
      cursor: requested,
      pane_id: pane.pane_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      agent: pane.agent,
    };
    const historyRead = retryOnceOnTimeout(
      () => connectionClient.call("agent_history.get", params),
      slow,
    );
    // A summary still being read is waited for, not asked again.
    let sessionRead = sessionReadRef.current;
    if (!sessionRead) {
      const read = retryOnceOnTimeout(() =>
        connectionClient.call("agent_session.get", {
          pane_id: pane.pane_id,
          agent: pane.agent,
        }),
      );
      sessionRead = read;
      sessionReadRef.current = read;
      const done = () => {
        if (sessionReadRef.current === read) sessionReadRef.current = null;
      };
      read.then(done, done);
    }
    // Each answer shows when it comes: a slow session summary holds back
    // neither the messages nor the end of the catching up.
    const historyShown = historyRead
      .then((value) => {
        if (!isCurrentRead()) return;
        const previous = historyRef.current;
        const merged = mergeAgentHistory(
          previous,
          value as AgentHistoryResponse,
          requested,
        );
        historyRef.current = merged;
        setHistory(merged);
        // Older entries read by scrolling up stay in front of the window:
        // what it let go of joins them, a reset drops them.
        const older = slideOlder(olderRef.current, previous, merged);
        if (older !== olderRef.current) {
          olderRef.current = older;
          setOlder(older);
        }
        const shown = withOlderEntries(older, merged);
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
            for (const message of shown) {
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
          const windowedIds = new Set(shown.map((message) => message.id));
          for (const id of toolEntryFailedRef.current) {
            if (!windowedIds.has(id)) toolEntryFailedRef.current.delete(id);
          }
        }
        setExpandedMessage((entry) =>
          entry
            ? (shown.find((message) => message.id === entry.id) ?? null)
            : null,
        );
      })
      .catch(() => {})
      .finally(settled);
    void sessionRead
      .then((value) => {
        if (!isCurrentRead()) return;
        const summary = value as AgentSessionSummary;
        sessionRef.current = summary;
        setSession(summary);
        rememberAgentHistory(recentKeyRef.current, {
          history: historyRef.current,
          session: summary,
        });
      })
      .catch(() => {});
    void Promise.allSettled([historyRead, sessionRead]).then(
      ([historyResult, sessionResult]) => {
        if (!isCurrentRead()) return;
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
        // A later read that succeeds clears it.
        setError(historyLoadError(errors));
      },
    );
    // The next read waits for this one's history, not for the summary.
    return historyShown;
  }, [
    connectionClient,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  // Pushes and polls wait out the pause after a read; what the reader asks
  // for (`urgent`: a refresh, a send, a rewind) does not.
  const loadHistory = useCallback(
    (urgent = false) => {
      if (!pane.agent || !connectionClient.isCurrent()) return;
      refreshGate.request(readHistory, urgent);
    },
    [connectionClient, pane.agent, readHistory, refreshGate],
  );

  // Scrolled to the top: one page of what came before, put in front.
  const loadOlder = useCallback(() => {
    const live = historyRef.current;
    if (
      !pane.agent ||
      !connectionClient.isCurrent() ||
      olderLoadingRef.current ||
      !canLoadOlder(olderRef.current, live)
    )
      return;
    const before = oldestShownEntry(olderRef.current, live);
    if (!live || !before) return;
    const scroller = contentRef.current;
    const items = timelineRef.current;
    if (scroller && items) {
      const top = scroller.getBoundingClientRect().top;
      const first = [...items.children].find(
        (child) => child.getBoundingClientRect().bottom > top,
      );
      if (first)
        olderAnchorRef.current = {
          element: first,
          top: first.getBoundingClientRect().top,
        };
    }
    const epoch = live.cursor.epoch;
    const seq = olderSeqRef.current + 1;
    olderSeqRef.current = seq;
    olderLoadingRef.current = true;
    setOlderLoading(true);
    const current = () =>
      olderSeqRef.current === seq && connectionClient.isCurrent();
    connectionClient
      .call("agent_history.older", {
        pane_id: pane.pane_id,
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        agent: pane.agent,
        before_id: before.id,
        limit: OLDER_PAGE_SIZE,
      })
      .then((page) => {
        if (!current()) return;
        const next = addOlderPage(
          olderRef.current,
          epoch,
          page as OlderHistoryPage,
          historyRef.current?.messages ?? [],
        );
        olderRef.current = next;
        setOlder(next);
      })
      .catch((error: unknown) => {
        if (!current()) return;
        // Gone from the history (a reset): nothing older for now.
        if (String(error).includes("no longer in the history")) {
          const next = endOlder(olderRef.current, epoch);
          olderRef.current = next;
          setOlder(next);
        }
      })
      .finally(() => {
        if (olderSeqRef.current !== seq) return;
        olderLoadingRef.current = false;
        setOlderLoading(false);
      });
  }, [
    connectionClient,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  useEffect(() => {
    // Resource-derived state belongs to one pane and one connection lease.
    // Invalidate old continuations before loading a colliding pane ID from a
    // switched connection or replacement runtime.
    loadSeqRef.current += 1;
    refreshGate.reset();
    sessionReadRef.current = null;
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
    olderRef.current = null;
    olderSeqRef.current += 1;
    olderAnchorRef.current = null;
    olderLoadingRef.current = false;
    setOlder(null);
    setOlderLoading(false);
    setQuery("");
    setHeaderExpanded(false);
    setSearchOpen(false);
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
    refreshGate,
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
      refreshGate.reset();
      loadHistory(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadHistory, recentKey, refreshGate]);

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
    const all = withOlderEntries(older, history);
    const cut = rewound
      ? all.findIndex(
          (entry) =>
            entry.id === rewound.id && entry.sent_at === rewound.sent_at,
        )
      : -1;
    return cut < 0 ? all : all.slice(0, cut);
  }, [history, older, rewound]);
  // Older entries put in front: the entry that was first in view stays
  // where it was, the reader reading on from it.
  // The loading row coming and going moves nothing either.
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    if (!anchor) return;
    const scroller = contentRef.current;
    if (scroller && anchor.element.isConnected) {
      scroller.scrollTop +=
        anchor.element.getBoundingClientRect().top - anchor.top;
      anchor.top = anchor.element.getBoundingClientRect().top;
    }
    if (!olderLoading) olderAnchorRef.current = null;
  }, [older, olderLoading]);
  // Scrolling to the top of the list (chat or timeline) reads one page more;
  // nothing is read before the reader goes there.
  // The list element changes with the view (chat, timeline), so it is
  // checked after every render.
  const olderSkipScrollRef = useRef(false);
  const olderScrollerRef = useRef<{
    element: HTMLElement;
    stop: () => void;
  } | null>(null);
  useEffect(() => {
    const scroller = contentRef.current;
    if (olderScrollerRef.current?.element === scroller) return;
    olderScrollerRef.current?.stop();
    olderScrollerRef.current = null;
    if (!scroller) return;
    const onScroll = () => {
      if (olderSkipScrollRef.current) {
        olderSkipScrollRef.current = false;
        return;
      }
      if (scroller.clientHeight > 0 && scroller.scrollTop <= OLDER_TRIGGER_PX)
        loadOlderRef.current();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    olderScrollerRef.current = {
      element: scroller,
      stop: () => scroller.removeEventListener("scroll", onScroll),
    };
  });
  useEffect(
    () => () => {
      olderScrollerRef.current?.stop();
      olderScrollerRef.current = null;
    },
    [],
  );
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
    !paneChat && open && isConversationAgent(pane.agent),
  );
  const conversation = paneChat?.conversation ?? ownConversation ?? null;
  const conversationState = conversation?.state ?? null;
  // A takeover asked from here counts from the moment it is asked: nothing
  // is typed into the pane while Claude exits and the holder starts.
  const owns = conversationOwns(conversationState) || !!conversation?.handing;
  const inConversation = conversationState?.phase === "conversation";
  // What the conversation's agent can do (an older bridge says nothing:
  // Claude's); the chat hides the rest.
  const capabilities = chatCapabilities(conversationState);
  const conversationAgent = isConversationAgent(pane.agent);
  // One view per mode: outside conversation mode, a Claude session's
  // History types into nothing; it is read only, its header offering the
  // switch to conversation mode.
  const readOnlyHistory =
    !paneChat &&
    conversationAgent &&
    !!conversation &&
    !conversation.unavailable &&
    !inConversation;
  const readOnlyHistoryRef = useRef(readOnlyHistory);
  readOnlyHistoryRef.current = readOnlyHistory;
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
  // Merge and pull requests: the repositories the session works in and
  // their branches' requests (the header), every request the conversation
  // names or created (the list), and chips in its messages.
  const forgePath = pane.foreground_cwd ?? pane.cwd ?? "";
  const forgeSession = useForgeSession(
    connectionClient,
    {
      workspaceId: pane.workspace_id,
      path: forgePath,
      agentPath: pane.cwd,
    },
    open,
  );
  const forgeDefault = forgeSession?.defaultProject ?? null;
  const forgeDefaultKey = forgeDefault ? JSON.stringify(forgeDefault) : "";
  const forgeChat = useMemo<ForgeChat>(
    () => ({
      client: connectionClient,
      workspaceId: pane.workspace_id,
      path: forgePath,
      defaultProject: forgeDefault,
    }),
    // Keyed by its value: a refreshed session does not redraw every chip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionClient, pane.workspace_id, forgePath, forgeDefaultKey],
  );
  const forgeGroups = useMemo(
    () => conversationRequests(messages, forgeSession),
    [messages, forgeSession],
  );
  const forgeBranches = useMemo(
    () => branchRequests(forgeSession),
    [forgeSession],
  );
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
  // `!` lines run from the chat: those Claude has not read yet, and the
  // last few sent (the transcript shows them, without how they ended).
  const allShells = owns ? conversationState?.shells : undefined;
  const liveShells = useMemo(
    () => allShells?.filter((shell) => !shell.delivered),
    [allShells],
  );
  const sentShells = useMemo(
    () => allShells?.filter((shell) => shell.delivered) ?? [],
    [allShells],
  );
  const shellItems = useMemo(
    (): ChatItem[] =>
      (liveShells ?? []).map((shell) => ({
        type: "custom" as const,
        id: `shell:${shell.id}`,
        node: (
          <ShellCommandBlock
            command={shell.command}
            stdout={shell.stdout}
            stderr={shell.stderr}
            status={shell.status}
            exitCode={shell.exit_code}
            truncated={shell.truncated}
            error={shell.error}
            host={connectionLabel}
            cwd={shell.cwd ?? conversationState?.cwd ?? undefined}
            startedAt={shell.started_at}
            finishedAt={shell.finished_at}
            pending
            onStop={() =>
              void stopAgentChatShell(
                connectionClient,
                pane.pane_id,
                shell.id,
              ).catch(() => {})
            }
          />
        ),
      })),
    [
      connectionClient,
      connectionLabel,
      conversationState?.cwd,
      liveShells,
      pane.pane_id,
    ],
  );
  // The transcript's `!` lines, with where they ran and, for those run
  // from here, how they ended.
  const shownMessages = useMemo(
    () => withShellOutcomes(visibleMessages, sentShells, connectionLabel),
    [connectionLabel, sentShells, visibleMessages],
  );
  // Above the oldest entry shown: older ones loading, or none left.
  const olderEnd =
    !!history && older?.epoch === history.cursor.epoch && !older.hasMore;
  // Older messages, read to go to a comment on one of them (ChatThreads).
  const olderMessages = useMemo(
    () => ({
      load: loadOlder,
      loading: olderLoading,
      more: canLoadOlder(older, history),
    }),
    [loadOlder, olderLoading, older, history],
  );
  const olderRow = useMemo(
    () =>
      olderLoading ? (
        <div className="agent-history-older" role="status">
          <span className="terminal-loading-dot" />
          Loading older messages
        </div>
      ) : olderEnd ? (
        <div className="agent-history-older is-end">
          Beginning of the conversation
        </div>
      ) : null,
    [olderEnd, olderLoading],
  );
  const chatItems = useMemo((): ChatItem[] => {
    if (!chatView) return [];
    const items: ChatItem[] = groupHistoryChatItems(
      liveEntries.length && !query.trim()
        ? [...shownMessages, ...liveEntries]
        : shownMessages,
    );
    if (olderRow)
      items.unshift({
        type: "custom",
        id: "older",
        node: olderRow,
        transient: true,
      });
    return query.trim() || !shellItems.length
      ? items
      : [...items, ...shellItems];
  }, [chatView, liveEntries, olderRow, query, shellItems, shownMessages]);
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
      refreshGate.reset();
    };
  }, [
    connectionClient,
    loadHistory,
    open,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
    refreshGate,
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
    if (!chatView && contentRef.current) {
      // Not the reader scrolling up: it reads nothing older.
      olderSkipScrollRef.current = contentRef.current.scrollTop !== 0;
      contentRef.current.scrollTop = 0;
    }
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
      const list = contentRef.current;
      if (!(card instanceof HTMLElement) || !list) return;
      // The conversation's own list scrolls, not the pane or page around it.
      const behavior = prefersReducedMotion() ? "auto" : "smooth";
      if (masterDetail) {
        // Master-detail: the minimap selects the entry in the detail panel
        // and scrolls its row into view instead of flashing a highlight.
        const message = messageEntries[sequence - 1]?.message;
        if (message) setWideSelectedId(message.id);
        scrollChatTo(list, card, { block: "nearest", behavior });
        return;
      }
      scrollChatTo(list, card, { behavior });
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
  const sessionTitle = session?.title || null;
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

  // Never hide an active desktop query after switching to mobile layout.
  const mobileSearchOpen = searchOpen || query.length > 0;
  const closeSearch = () => {
    changeFilters(filters, "");
    setSearchOpen(false);
    searchToggleRef.current?.focus();
  };
  const historySearch =
    !mobile || mobileSearchOpen ? (
      <div className="agent-history-search" id={searchId}>
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Search history messages"
          placeholder="Search loaded messages"
          title="Search loaded message text. Tool content is searchable after loading it."
          value={query}
          onChange={(event) =>
            changeFilters(filters, event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (mobile && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }
          }}
        />
        {mobile ? (
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Close search"
            title="Close search"
            onClick={closeSearch}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
    ) : null;
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
      {olderRow}
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
        // A `!` line runs, as Claude Code's bash mode: Claude reads it with
        // the next message.
        const command = shellLine(text);
        if (command !== null) {
          await runAgentChatShell(connectionClient, pane.pane_id, command);
          return;
        }
        const refused = conversationRefusal(text);
        if (refused) throw new Error(refused);
        await sendConversationRef.current(text);
        return;
      }
      if (ownsRef.current)
        throw new Error(
          "The session is being handed over; try again in a moment.",
        );
      // One view per mode: nothing is typed into a terminal-mode Claude
      // from a chat.
      if (paneChat?.modeBound || readOnlyHistoryRef.current)
        throw new Error("Claude is in terminal mode: switch it first.");
      const scope = pollScopeRef.current;
      // Writing a question's own answer ("Type something.") where Enter would
      // tick the box off again: the text alone.
      const answering = paneChat?.prompt?.options.find(
        (option) => option.cursor && option.freeText,
      );
      await sendTerminalComposerText(
        connectionClient,
        { paneId: pane.pane_id, agent: pane.agent },
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
          // One still running is followed by this one, at once.
          loadHistory(true);
        }, delay);
      };
      refresh(1000);
    },
    [
      connectionClient,
      loadHistory,
      pane.agent,
      pane.pane_id,
      paneChat?.modeBound,
      paneChat?.prompt,
    ],
  );
  // Messages sent from the box that the transcript does not show yet
  // (chatOutbox): shown on their way, then replaced by their entries. Kept
  // per pane outside this chat, which a switch to the terminal unmounts.
  const outboxKey = terminalComposerDraftKey(
    activeConnectionId,
    connectionGeneration,
    pane.pane_id,
    pane.terminal_id,
  );
  const paneOutbox = useSyncExternalStore(subscribeOutbox, () =>
    readOutbox(outboxKey),
  );
  // Bound to this pane's outbox when called: a send that settles late
  // updates the outbox of the pane it was sent from.
  const setOutbox = useCallback(
    (update: (current: readonly OutboxMessage[]) => readonly OutboxMessage[]) =>
      updateOutbox(outboxKey, update),
    [outboxKey],
  );
  const historyMessagesRef = useRef(history?.messages ?? []);
  historyMessagesRef.current = history?.messages ?? [];
  const settlePaneOutbox = useCallback(
    (entries: readonly AgentHistoryEntry[]) =>
      updateOutbox(outboxKey, (current) =>
        settleOutbox(current, entries, Date.now()),
      ),
    [outboxKey],
  );
  useEffect(() => {
    // Not before the history is read: a message would time out against an
    // empty one.
    if (history) settlePaneOutbox(history.messages);
  }, [history, settlePaneOutbox]);
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
  }, [chatShownUuids, pane.pane_id, paneOutbox, setOutbox, visibleOutbox]);
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
    [sendConversation, setOutbox],
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
  }, [
    deliverConversation,
    inConversation,
    owns,
    pane.pane_id,
    paneOutbox,
    setOutbox,
  ]);
  const sendFromBox = useCallback(
    async (text: string, replacing?: string) => {
      const handingOver = ownsRef.current && !inConversationRef.current;
      if (handingOver || inConversationRef.current) {
        const command = shellLine(text);
        if (command !== null) {
          if (handingOver)
            throw new Error(
              "The session is being handed over; try again in a moment.",
            );
          await runAgentChatShell(connectionClient, pane.pane_id, command);
          return;
        }
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
      // The pane's outbox at the time of sending, whatever this chat shows
      // by the time the send settles.
      const key = outboxKey;
      const message = newOutboxMessage(
        pane.pane_id,
        text,
        historyMessagesRef.current,
        Date.now(),
      );
      const update = (patch: Partial<OutboxMessage>) =>
        updateOutbox(key, (current) =>
          current.map((each) =>
            each.id === message.id ? { ...each, ...patch } : each,
          ),
        );
      updateOutbox(key, (current) => [
        ...current.filter((each) => each.id !== replacing),
        message,
      ]);
      try {
        await sendMessage(text);
        update({ state: "sent", sentAtMs: Date.now() });
      } catch (error) {
        if (error instanceof TerminalComposerSubmitKeyError) {
          // The text is in the terminal: kept as sent, never sent again.
          update({ state: "sent", sentAtMs: Date.now() });
          throw error;
        }
        // Kept in the chat, marked, rather than put back in the box.
        update({
          state: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      connectionClient,
      deliverConversation,
      outboxKey,
      pane.pane_id,
      paneChat?.prompt,
      sendConversation,
      sendMessage,
      setOutbox,
    ],
  );
  const retryContext = JSON.stringify([
    outboxKey,
    pane.agent,
    pane.agent_status,
    pane.state_change_seq,
    open,
  ]);
  const [retryConfirmation, setRetryConfirmation] = useState<{
    message: OutboxMessage;
    context: string;
  } | null>(null);
  useEffect(() => {
    if (retryConfirmation?.context !== retryContext) setRetryConfirmation(null);
  }, [retryConfirmation, retryContext]);
  const notifyComposerError = useCallback((detail: string) => {
    store.notify({ kind: "error", message: "Message input failed", detail });
  }, []);
  const resendMessage = useCallback(
    (message: OutboxMessage) => {
      void sendFromBox(message.text, message.id).catch((error) =>
        notifyComposerError(
          error instanceof Error ? error.message : String(error),
        ),
      );
    },
    [notifyComposerError, sendFromBox],
  );
  const retryWarning = agentPromptWarning(pane.agent, pane.agent_status);
  const retrySend = useCallback(
    (message: OutboxMessage) => {
      if (retryWarning)
        setRetryConfirmation({ message, context: retryContext });
      else resendMessage(message);
    },
    [retryWarning, retryContext, resendMessage],
  );
  const discardSend = useCallback(
    (message: OutboxMessage) =>
      updateOutbox(outboxKey, (current) =>
        current.filter((each) => each.id !== message.id),
      ),
    [outboxKey],
  );
  // /rewind and /tasks typed in a Claude chat open the chat's own picker
  // (AgentRewindSheet) and list of what the session runs on the side, not
  // Claude Code's in its terminal, which would only show as its screen.
  // /model alone in conversation mode opens the models its agent and
  // profile offer (AgentModelSheet); `/model <name>` goes to the bridge,
  // which switches the session at once. /mcp lists the session's MCP
  // servers with what can be done to them (AgentMcpSheet).
  const [rewindOpen, setRewindOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const sendFromChatBox = useCallback(
    async (text: string) => {
      if (
        paneChatShown &&
        conversationAgent &&
        capabilities.rewind &&
        text.trim() === "/rewind"
      )
        setRewindOpen(true);
      else if (
        conversationAgent &&
        capabilities.models &&
        inConversationRef.current &&
        parseModelCommand(text)?.model === null
      )
        setModelOpen(true);
      else if (
        conversationAgent &&
        capabilities.mcp &&
        inConversationRef.current &&
        isMcpCommand(text)
      )
        setMcpOpen(true);
      else if (
        chatPaneId &&
        conversationAgent &&
        capabilities.backgroundTasks &&
        isTasksCommand(text)
      )
        openTask(null);
      else await sendFromBox(text);
    },
    [
      capabilities.backgroundTasks,
      capabilities.mcp,
      capabilities.models,
      capabilities.rewind,
      chatPaneId,
      conversationAgent,
      openTask,
      paneChatShown,
      sendFromBox,
    ],
  );
  const loadModels = useCallback(
    () => listAgentChatModels(connectionClient, pane.pane_id),
    [connectionClient, pane.pane_id],
  );
  const pickModel = useCallback(
    (model: string) => setAgentChatModel(connectionClient, pane.pane_id, model),
    [connectionClient, pane.pane_id],
  );
  const loadMcp = useCallback(
    () => listAgentChatMcp(connectionClient, pane.pane_id),
    [connectionClient, pane.pane_id],
  );
  const actOnMcp = useCallback(
    (request: AgentChatMcpRequest) =>
      runAgentChatMcpAction(connectionClient, pane.pane_id, request),
    [connectionClient, pane.pane_id],
  );
  // Closed when conversation mode lets the session go.
  useEffect(() => {
    if (!inConversation) {
      setModelOpen(false);
      setMcpOpen(false);
    }
  }, [inConversation]);
  const composerDraftKey = terminalComposerDraftKey(
    activeConnectionId,
    connectionGeneration,
    pane.pane_id,
    pane.terminal_id,
  );
  // What the shared chat pieces read of this pane (chatSource.ts): its
  // threads' review and its voice session, as Ranger's chat gives its own.
  const chatSource = paneChatSource({
    pane,
    connectionId: activeConnectionId,
    draftKey: composerDraftKey,
    session: chatThreadsKey,
    entries: messages,
    status: pane.agent_status,
    claimsVoice: !!paneChat,
  });
  const threadsTarget = chatSource.threads;
  // Where the reader is in the pane's chat is kept per connection, pane and
  // session: the chat comes back there when shown again.
  const placeKey =
    paneChat && history?.path
      ? chatPlaceKey(activeConnectionId, pane.pane_id, history.path)
      : null;
  const voiceSession = chatSource.voiceSession;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const voiceStream = useMemo<VoiceStream | undefined>(() => {
    if (!activeConnectionId || !isConversationAgent(pane.agent))
      return undefined;
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
  // What the agent asks, for the voice companion to relay and answer.
  const paneChatRef = useRef(paneChat);
  paneChatRef.current = paneChat;
  const voiceQuestion = useCallback((agent: string): VoiceQuestion | null => {
    const chat = paneChatRef.current;
    if (chat?.permission) return questionFromPermission(chat.permission, agent);
    if (chat?.prompt) return questionFromPrompt(chat.prompt, agent);
    return null;
  }, []);
  const answerVoiceQuestion = useCallback(
    async (question: VoiceQuestion, answer: QuestionAnswer) => {
      const chat = paneChatRef.current;
      const permission = chat?.permission;
      if (permission && question.key === `permission:${permission.id}`)
        return answerPromptByVoice(
          permission,
          question,
          answer,
          answerAgentPrompt,
        );
      // A question on the terminal's screen: Esc puts it away there.
      if (chat?.prompt && "dismiss" in answer) {
        chat.onKeys("\x1b");
        return true;
      }
      if (!chat?.prompt || !("option" in answer)) return false;
      const label = question.options[answer.option]?.label;
      const option = chat.prompt.options.find((entry) => entry.label === label);
      if (!option) return false;
      chat.onKeys(option.input);
      return true;
    },
    [],
  );
  const voice = useVoiceChat({
    question: voiceQuestion,
    answerQuestion: answerVoiceQuestion,
    entries: messages,
    agentStatus: inConversation
      ? conversationAgentStatus(conversationState!.status)
      : pane.agent_status,
    onSend: sendMessage,
    stream: voiceStream,
    onError: (detail) =>
      store.notify({ kind: "error", message: "Voice chat stopped", detail }),
    routeContext: () => ({
      current: voiceSession,
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
  // While a voice is recorded (Configuration's Speech section), the voice
  // conversation is muted, so what is read aloud is not sent to the agent.
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
  // A running voice conversation floats over the chat, not in its box.
  const voiceOverlay =
    paneChat && voice.available && voice.state !== "off" ? (
      <VoiceChatOverlay
        state={voice.state}
        level={voice.level}
        muted={voice.muted}
        heard={voice.heard}
        speechRate={voice.speechRate}
        agent={pane.agent}
        place={workspaceLabel}
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
      loadHistory(true);
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
        loadHistory(true);
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
  // Ctrl+B and the tool blocks' Background: a running command or subagent
  // goes on in the background and the turn with it, as in the terminal.
  const canBackground =
    !!paneChat && inConversation && capabilities.backgroundTools === true;
  const runningToolIds = conversationState?.running_tools;
  const runningTools = useMemo(
    () => (canBackground ? new Set(runningToolIds ?? []) : undefined),
    [canBackground, runningToolIds],
  );
  const backgroundTool = useCallback(
    async (toolUseId?: string): Promise<boolean> => {
      const result = await backgroundAgentChatTool(
        connectionClient,
        pane.pane_id,
        toolUseId,
      );
      if (!result.ok) {
        store.notify({
          kind: "error",
          message: "Could not move it to the background",
          detail: result.reason,
        });
        return false;
      }
      if (result.backgrounded === false) {
        store.notify({
          kind: "info",
          message: "It no longer runs in the foreground",
        });
        return false;
      }
      return true;
    },
    [connectionClient, pane.pane_id],
  );
  const stopTask = useCallback(
    async (taskId: string): Promise<string | null> => {
      const result = await stopAgentChatTask(
        connectionClient,
        pane.pane_id,
        taskId,
      );
      return result.ok ? null : result.reason;
    },
    [connectionClient, pane.pane_id],
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
  // In conversation mode only Roamgate's own queue can give a message back:
  // one Claude Code queued (spoken while it ran tools) is its already.
  const queuedHandedOver = useCallback(
    (entry: AgentHistoryEntry) => owns && !queuedEntryId(entry),
    [owns],
  );
  // A turn cut short (a Roamgate restart, Claude's process exiting): the
  // chat says so after its last entry, with a Continue that sends a message
  // the usual way. Hidden once clicked, so it cannot go twice.
  const cutOffText =
    conversationAgent && inConversation
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
  // What the last /model did, after the chat's last entry, until the next
  // message goes or it is dismissed (in every browser).
  const modelNoticeState =
    conversationAgent && inConversation
      ? (conversationState?.model_notice ?? null)
      : null;
  // A /model's switch shows on the header's model chip at once.
  const modelNoticeAt = modelNoticeState?.at;
  useEffect(() => {
    if (modelNoticeAt)
      void refreshSessionProfile(connectionClient, pane.pane_id);
  }, [connectionClient, modelNoticeAt, pane.pane_id]);
  const modelNotice = useMemo<ChatModelNotice | null>(
    () =>
      modelNoticeState
        ? {
            text: modelNoticeState.text,
            ok: modelNoticeState.ok,
            onDismiss: () => {
              dismissAgentChatModelNotice(connectionClient, pane.pane_id).catch(
                (error: unknown) =>
                  store.notify({
                    kind: "error",
                    message: "Could not dismiss the notice",
                    detail:
                      error instanceof Error ? error.message : String(error),
                  }),
              );
            },
          }
        : null,
    [connectionClient, modelNoticeState, pane.pane_id],
  );
  // Nothing sent goes out: the conversation process is lost, or the queue
  // has waited, with nothing at work, longer than a start takes. Timed in
  // this browser (its clock may differ from the bridge's).
  const waiting =
    conversationAgent && inConversation && queueWaiting(conversationState);
  const oldestQueued = waiting ? conversationState?.queue[0]?.id : undefined;
  const [stalledQueue, setStalledQueue] = useState<string | null>(null);
  useEffect(() => {
    if (!oldestQueued) return;
    const timer = setTimeout(
      () => setStalledQueue(oldestQueued),
      QUEUE_STALL_MS,
    );
    return () => clearTimeout(timer);
  }, [oldestQueued]);
  const deliveryNoticeNow =
    conversationAgent && inConversation
      ? deliveryNotice(
          conversationState,
          !!oldestQueued && stalledQueue === oldestQueued,
        )
      : null;
  const deliveryText = deliveryNoticeNow?.text;
  const deliveryDetail = deliveryNoticeNow?.detail ?? null;
  const deliveryStuck = deliveryNoticeNow?.stuck;
  const [recovering, setRecovering] = useState(false);
  const delivery = useMemo<ChatDelivery | null>(
    () =>
      deliveryText
        ? {
            text: deliveryText,
            detail: deliveryDetail,
            recovering,
            ...(deliveryStuck
              ? {
                  stuck: deliveryStuck,
                  onInterrupt: () =>
                    void interruptAgentChat(
                      connectionClient,
                      pane.pane_id,
                    ).catch((error: Error) =>
                      store.notify({
                        kind: "error",
                        message: "Could not interrupt Claude",
                        detail: error.message,
                      }),
                    ),
                }
              : {}),
            onRecover: () => {
              setRecovering(true);
              recoverAgentChat(connectionClient, pane.pane_id)
                .then((result) => {
                  if (!result.ok)
                    store.notify({
                      kind: "error",
                      message: deliveryStuck
                        ? "Could not restart Claude"
                        : "Could not recover the conversation",
                      detail: result.reason,
                    });
                  else setStalledQueue(null);
                })
                .catch((error: unknown) =>
                  store.notify({
                    kind: "error",
                    message: "Could not recover the conversation",
                    detail:
                      error instanceof Error ? error.message : String(error),
                  }),
                )
                .finally(() => setRecovering(false));
            },
          }
        : null,
    [
      connectionClient,
      deliveryDetail,
      deliveryStuck,
      deliveryText,
      pane.pane_id,
      recovering,
    ],
  );
  // Claude waits to start until the user answers the API key question.
  const apiKeyAsked =
    conversationAgent &&
    inConversation &&
    !!conversationState?.api_key_question;
  const apiKeyQueued = apiKeyAsked ? (conversationState?.queue.length ?? 0) : 0;
  const [answeringApiKey, setAnsweringApiKey] = useState(false);
  const apiKeyQuestion = useMemo<ChatApiKeyQuestion | null>(
    () =>
      apiKeyAsked
        ? {
            queued: apiKeyQueued,
            answering: answeringApiKey,
            onAnswer: (use) => {
              setAnsweringApiKey(true);
              answerAgentChatApiKey(connectionClient, pane.pane_id, use)
                .then((result) => {
                  if (!result.ok)
                    store.notify({
                      kind: "error",
                      message: "Could not answer the API key question",
                      detail: result.reason,
                    });
                })
                .catch((error: unknown) =>
                  store.notify({
                    kind: "error",
                    message: "Could not answer the API key question",
                    detail:
                      error instanceof Error ? error.message : String(error),
                  }),
                )
                .finally(() => setAnsweringApiKey(false));
            },
          }
        : null,
    [
      answeringApiKey,
      apiKeyAsked,
      apiKeyQueued,
      connectionClient,
      pane.pane_id,
    ],
  );
  // The rewind handler stays the same across renders, as bubbles compare
  // their handlers: it reads the screen and the status when it runs.
  const readScreenRef = useRef(paneChat?.readScreen);
  readScreenRef.current = paneChat?.readScreen;
  const conversationStateRef = useRef(conversationState);
  conversationStateRef.current = conversationState;
  /** Puts the message rewound to in the chat's box, before any draft. */
  const restoreDraft = useCallback(
    (text: string) => {
      const draft = readTerminalComposerDraft(composerDraftKey);
      writeTerminalComposerDraft(
        composerDraftKey,
        draft ? `${text}\n${draft}` : text,
      );
    },
    [composerDraftKey],
  );
  /**
   * Conversation mode: the headless Claude Code rewinds itself, between
   * turns, over its control protocol (the bridge's agent_chat.rewind); the
   * code too, from its checkpoints.
   */
  const rewindConversation = useCallback(
    async (entry: AgentHistoryEntry, mode: RewindMode) => {
      const state = conversationStateRef.current;
      if (!entry.uuid) {
        store.notify({
          kind: "error",
          message: "Rewind failed",
          detail:
            "This message is not in the transcript yet; try again in a moment.",
        });
        return;
      }
      if (state?.queue.length) {
        store.notify({
          kind: "error",
          message: "Rewind failed",
          detail:
            "Messages wait in the queue: send them or take them back first.",
        });
        return;
      }
      const running =
        state?.status === "working" ||
        state?.status === "blocked" ||
        state?.status === "starting";
      if (
        running &&
        !window.confirm("Claude is working. Stop the turn and rewind?")
      )
        return;
      // Nothing goes on reading what is about to be rewound away.
      if (mode !== "code") noteRewind();
      const result = await rewindAgentChat(connectionClient, pane.pane_id, {
        uuid: entry.uuid,
        mode,
        lastSeen: lastUserUuid(messagesRef.current),
        interrupt: running,
      });
      if (!result.ok) {
        // Edits from before checkpoints were on: nothing was rewound, and
        // the conversation alone still can be.
        if (result.no_checkpoint) {
          if (
            mode === "both" &&
            window.confirm(noCheckpointQuestion(result.files))
          )
            await rewindConversation(entry, "conversation");
          else if (mode === "code")
            store.notify({
              kind: "error",
              message: "Code not restored",
              detail: result.files?.length
                ? `${result.reason}: ${listedFiles(result.files)}.`
                : `${result.reason}.`,
            });
          return;
        }
        store.notify({
          kind: "error",
          message: "Rewind failed",
          detail: result.reason,
        });
        return;
      }
      if (mode !== "code") {
        setRewound({ id: entry.id, sent_at: entry.sent_at });
        restoreDraft(result.prefill ?? entry.text);
      }
      if (mode !== "conversation")
        store.notify(
          result.code === "none"
            ? {
                kind: "info",
                message: "No code changes to restore",
                detail:
                  mode === "both"
                    ? "Claude edited no file after this message: the conversation alone was rewound."
                    : "Claude edited no file after this message.",
              }
            : {
                kind: "info",
                message: "Code restored",
                detail: result.files?.length
                  ? `${result.files.length} file${result.files.length === 1 ? "" : "s"} changed back.`
                  : "No file needed changing.",
              },
        );
      loadHistory(true);
    },
    [connectionClient, loadHistory, pane.pane_id, restoreDraft],
  );
  /** What a rewind to before `entry` could do to the code (the sheet's). */
  const rewindCheck = useCallback(
    (entry: AgentHistoryEntry) =>
      entry.uuid
        ? checkAgentChatRewind(connectionClient, pane.pane_id, entry.uuid)
        : Promise.resolve({ code: "unknown" as const }),
    [connectionClient, pane.pane_id],
  );
  /** Rewinds the session to before `entry`, as /rewind does. */
  const rewind = useCallback(
    async (entry: AgentHistoryEntry, mode: RewindMode) => {
      if (inConversationRef.current) {
        await rewindConversation(entry, mode);
        return;
      }
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
                { paneId: pane.pane_id, agent: pane.agent },
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
          noteRewind();
          setRewound({ id: entry.id, sent_at: entry.sent_at });
          // Claude Code puts the message back in its prompt to edit: it is
          // edited here instead. Backspace and Delete, as in takeQueueBack.
          for (let sent = 0; sent < entry.text.length + 16; sent += 4)
            await store.sendText(pane.pane_id, "\x7f\x1b[3~".repeat(4));
          restoreDraft(entry.text);
        }
        loadHistory(true);
      } catch (error) {
        store.notify({
          kind: "error",
          message: "Rewind failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      connectionClient,
      loadHistory,
      pane.pane_id,
      restoreDraft,
      rewindConversation,
    ],
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
  // The foreground commands the turn waits on: in conversation mode those
  // its stream says run, else while the agent works.
  const conversationRunning = conversationState?.running_tools;
  const runningNow = useMemo(() => {
    if (!readRunningNow.length) return readRunningNow;
    if (inConversation) {
      const ids = new Set(conversationRunning ?? []);
      return readRunningNow.filter((task) => ids.has(task.id));
    }
    return pane.agent_status.toLowerCase() === "idle" ? [] : readRunningNow;
  }, [readRunningNow, inConversation, conversationRunning, pane.agent_status]);
  // Ctrl+Z, `:suspend` and the header's Suspend (below).
  const suspendHere =
    paneChat?.onSuspend && inConversation && !conversation?.handing
      ? () => paneChat.onSuspend?.(sessionTitle)
      : null;
  const suspendRef = useRef(suspendHere);
  suspendRef.current = suspendHere;
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
          : hasQueued && conversationAgent
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
      onSuspend={suspendHere ?? undefined}
      shell={
        inConversation && capabilities.shellLines
          ? { host: connectionLabel, cwd: conversationState?.cwd }
          : undefined
      }
      nextPrompt={
        inConversation &&
        capabilities.promptSuggestions &&
        conversationState?.next_prompt &&
        voice.state === "off"
          ? {
              key: conversationState.next_prompt.uuid,
              text: conversationState.next_prompt.text,
            }
          : null
      }
      // Uploaded to the session's host (an SSH one too), where it reads
      // them: a photo made the size a model takes, any file as it is.
      onUploadImage={async (file) =>
        uploadTerminalImage(connectionClient, await downscaleImage(file))
      }
      onUploadFile={(file) => uploadTerminalFile(connectionClient, file)}
      commands={
        inConversation ? conversationCommands(agentCommands) : agentCommands
      }
      onError={notifyComposerError}
      voice={
        paneChat && (voice.available || voice.unavailable)
          ? {
              listen: voice.available,
              state: voice.state,
              level: voice.level,
              muted: voice.muted,
              held: voice.held,
              onSendHeld: voice.sendHeld,
              onDropHeld: voice.dropHeld,
              onToggle: () => {
                const toggle = () => {
                  // With a front, the call is with the companion, above
                  // any pane (switching workspace never cuts it): this
                  // session is only where work goes by default.
                  if (
                    voice.state === "off" &&
                    voiceFronting() &&
                    activeConnectionId
                  )
                    callCompanion(voiceSession);
                  else voice.toggle();
                };
                // Unavailable may be a failure to ask: the tap asks again.
                if (voice.available) toggle();
                else void listenOrSayWhy(toggle);
              },
              onToggleMute: voice.toggleMute,
            }
          : undefined
      }
    />
  );
  // An agent's question takes the keys in its card, as in the terminal.
  const paneActive = paneChat?.active !== false;
  // Ctrl+Z, as in a shell: the conversation stops as a job of the pane's
  // shell, and `fg` there brings it back. Never where Ctrl+Z undoes: in a
  // message box with text (outside Vim's normal mode; Cmd+Z undoes on a
  // Mac), or another field. Caught ahead of the box's own keys.
  useEffect(() => {
    if (!paneChat?.onSuspend || !paneActive) return;
    const onKey = (event: KeyboardEvent) => {
      const suspend = suspendRef.current;
      if (
        !suspend ||
        event.defaultPrevented ||
        event.isComposing ||
        !isSuspendKey(event) ||
        document.querySelector(
          ".modal-backdrop, .agent-tasks-backdrop, .command-popover",
        )
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      const box = target?.closest(".agent-history-composer");
      const here =
        !target ||
        target === document.body ||
        !!drawerRef.current?.contains(target) ||
        (!!box && !!paneChat.composerTarget?.contains(box));
      if (!here) return;
      if (box) {
        const vimNormal = !!target
          ?.closest(".cm-editor")
          ?.querySelector(".cm-scroller.cm-vimMode");
        if (
          !boxSuspends({
            text: readTerminalComposerDraft(composerDraftKey),
            vimNormal,
          })
        )
          return;
      } else if (
        target &&
        target !== document.body &&
        (target.closest("input, textarea, select, [contenteditable='true']") ||
          (target as HTMLElement).isContentEditable)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      suspend();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    paneChat?.onSuspend,
    paneChat?.composerTarget,
    paneActive,
    composerDraftKey,
  ]);
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
    (paneChat?.composerTarget ?? drawerRef.current)
      ?.querySelector<HTMLElement>(
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
    else
      paneChat.onKeys(
        // A number answers as its choice does: on an editable rule, the
        // arrows and Enter rather than the digit itself.
        paneChat.prompt?.options.find((option) => option.key === input)
          ?.input ?? input,
      );
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
    if (now === was || !paneActive) return;
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
    } else if ((!active || active === document.body) && !mobile)
      // Not on a phone: the box's focus brings its keyboard up over the
      // chat, after an answer tapped on the card.
      requestAnimationFrame(focusChatBox);
  }, [
    promptShown,
    promptTyping,
    composerDraftKey,
    focusChatBox,
    paneActive,
    mobile,
  ]);
  // With nothing focused (the hidden box had the keys, say), they still go
  // to the question.
  const onPromptKeyRef = useRef(onPromptKey);
  onPromptKeyRef.current = onPromptKey;
  useEffect(() => {
    if (!promptShown || !paneActive) return;
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
  }, [promptShown, paneActive]);
  // Tab from an empty message box goes to the question. The box is a
  // child of the bottom bar on a phone, so this is caught on the drawer
  // (events come up through the portal), with no element around the box.
  const onComposerKeyCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Ctrl+B while a tool runs: what the turn waits for goes on in the
    // background, as in the terminal. Otherwise the key is left alone.
    if (
      event.key.toLowerCase() === "b" &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      runningTools?.size
    ) {
      event.preventDefault();
      event.stopPropagation();
      void backgroundTool();
      return;
    }
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
  const shownComposer = readOnlyHistory ? (
    <p className="agent-history-readonly" role="note">
      Claude is in terminal mode: write to it in its terminal, or switch to
      conversation mode to write here.
    </p>
  ) : boxHidden ? null : (
    historyComposer
  );
  // The History view on a phone writes through the bottom bar's Message box.
  const paneComposer = paneChat?.composerTarget
    ? createPortal(shownComposer, paneChat.composerTarget)
    : mobile && !paneChat
      ? null
      : shownComposer;
  // What the agent is doing, or asking, under the conversation; also shown
  // before it has one (a new session asking to trust its folder).
  const chatStatus = (
    <>
      {paneChat && inConversation && chatWorking ? (
        <div className="agent-chat-activity" role="status">
          <span className="agent-chat-activity-mark" aria-hidden="true" />
          <strong>{conversationActivity(conversationState!.activity)}</strong>
          {runningNow[0] ? (
            <RunningNowLink task={runningNow[0]} onOpen={openTask} />
          ) : null}
        </div>
      ) : paneChat &&
        !owns &&
        !promptShown &&
        pane.agent_status.toLowerCase() === "working" ? (
        <div className="agent-chat-activity" role="status">
          <span className="agent-chat-activity-mark" aria-hidden="true" />
          <strong>{paneChat.activity?.word ?? "Working..."}</strong>
          {runningNow[0] ? (
            <RunningNowLink task={runningNow[0]} onOpen={openTask} />
          ) : paneChat.activity?.detail ? (
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
  // Until a pane's transcript can be read, its chat says so in place of the
  // conversation; a message sent meanwhile shows instead, on its way.
  const paneWaiting =
    paneChat && unavailable ? (
      <div className="agent-chat-waiting" role="status">
        <span className="agent-chat-activity-mark" aria-hidden="true" />
        <span>No conversation yet</span>
        {unavailableLasted ? <small>{unavailableDetail}</small> : null}
      </div>
    ) : null;
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
          !paneChat ||
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
      {(visibleOutbox.length || shellItems.length
        ? null
        : (paneWaiting ?? historyEmptyState)) ??
        (paneChat && threadsTarget ? (
          // The chat's threads: comments on parts of the agent's messages.
          <ChatThreadsProvider
            {...threadsTarget}
            entries={chatSource.entries}
            older={olderMessages}
            keep
          >
            <div className="agent-history-chat-frame">
              <DeferredAgentHistoryChat
                items={chatItems}
                speechActive={open}
                speechScopeKey={JSON.stringify([
                  composerDraftKey,
                  history?.path,
                  session?.session?.value,
                ])}
                listRef={contentRef}
                contentRef={timelineRef}
                highlightedSequence={highlightedSequence}
                followKey={query}
                toolLoading={toolEntryLoading}
                onLoadTool={loadToolEntry}
                onOpen={setExpandedMessage}
                imageUrl={imageUrl}
                sentImageUrl={sentImage}
                outbox={visibleOutbox}
                onRetrySend={retrySend}
                onDiscardSend={discardSend}
                tasks={paneChat ? tasksById : undefined}
                onOpenTask={openTask}
                running={runningTools}
                onBackground={canBackground ? backgroundTool : undefined}
                onRemoveQueued={
                  paneChat && conversationAgent ? removeQueued : undefined
                }
                onEditQueued={
                  paneChat && conversationAgent ? editQueued : undefined
                }
                queuedHandedOver={queuedHandedOver}
                onRewind={
                  paneChat &&
                  (owns
                    ? conversationAgent &&
                      !!capabilities.rewind &&
                      inConversation &&
                      !conversation?.handing
                    : pane.agent === "claude")
                    ? rewindEntry
                    : undefined
                }
                onRewindCheck={rewindCheck}
                onSendAgain={paneChat ? sendFromBox : undefined}
                onEditAgain={paneChat ? restoreDraft : undefined}
                cutOff={cutOff}
                modelNotice={modelNotice}
                delivery={delivery}
                apiKeyQuestion={apiKeyQuestion}
                notices={limitNotice}
                placeKey={placeKey}
                placeReady={caughtUp}
                older={olderMessages}
              />
              {historyMinimap("auto")}
            </div>
          </ChatThreadsProvider>
        ) : (
          <div className="agent-history-chat-frame">
            <DeferredAgentHistoryChat
              items={chatItems}
              speechActive={open}
              speechScopeKey={JSON.stringify([
                composerDraftKey,
                history?.path,
                session?.session?.value,
              ])}
              listRef={contentRef}
              contentRef={timelineRef}
              highlightedSequence={highlightedSequence}
              followKey={query}
              toolLoading={toolEntryLoading}
              onLoadTool={loadToolEntry}
              onOpen={setExpandedMessage}
              imageUrl={imageUrl}
              sentImageUrl={sentImage}
              outbox={visibleOutbox}
              onRetrySend={retrySend}
              onDiscardSend={discardSend}
              tasks={paneChat ? tasksById : undefined}
              onOpenTask={openTask}
              running={runningTools}
              onBackground={canBackground ? backgroundTool : undefined}
              onRemoveQueued={
                paneChat && conversationAgent ? removeQueued : undefined
              }
              onEditQueued={
                paneChat && conversationAgent ? editQueued : undefined
              }
              queuedHandedOver={queuedHandedOver}
              onRewind={
                paneChat &&
                (owns
                  ? conversationAgent &&
                    !!capabilities.rewind &&
                    inConversation &&
                    !conversation?.handing
                  : pane.agent === "claude")
                  ? rewindEntry
                  : undefined
              }
              onRewindCheck={rewindCheck}
              onSendAgain={paneChat ? sendFromBox : undefined}
              onEditAgain={paneChat ? restoreDraft : undefined}
              cutOff={cutOff}
              modelNotice={modelNotice}
              delivery={delivery}
              apiKeyQuestion={apiKeyQuestion}
              notices={limitNotice}
              placeKey={placeKey}
              placeReady={caughtUp}
              older={olderMessages}
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
  // Who has the session, in the chat's header, when it is worth saying: the
  // terminal's Claude and the user's switch, a switch on its way, and why
  // one was refused. Conversation mode alone shows nothing.
  const ownerChip =
    conversationAgent && conversationState ? (
      <AgentChatOwnerChip
        client={connectionClient}
        paneId={pane.pane_id}
        chat={conversationState}
        refusal={conversation?.refusal ?? null}
        handing={conversation?.handing ?? null}
        agentStatus={pane.agent_status}
      />
    ) : null;
  const changeView = (next: AgentHistoryView) => {
    setView(next);
    writeAgentHistoryView(next);
    setDetailsOpen(false);
    setExpandedMessage(null);
  };

  const chatViewToggle = (
    <button
      type="button"
      className="agent-history-icon"
      aria-label="Chat view"
      aria-pressed={chatView && !detailsOpen}
      title={chatView && !detailsOpen ? "Show as timeline" : "Show as chat"}
      onClick={() => changeView(chatView && !detailsOpen ? "timeline" : "chat")}
      disabled={!hasSessionData}
    >
      <MessagesSquare size={mobile ? 16 : 14} />
    </button>
  );

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

  /*
   * History's `:` commands in the inspector's prompt, each a button of its
   * header or its search field.
   */
  useInspectorCommands(
    embedded && open && !paneChat
      ? {
          commands: [
            ...(loading
              ? []
              : [
                  {
                    name: "reload",
                    aliases: ["e", "edit", "refresh"],
                    description: "refresh the session (the Refresh button)",
                    run: () => loadHistory(true),
                  },
                ]),
            {
              name: "search",
              aliases: ["find"],
              description:
                "search the loaded messages (:search WORDS, the search field)",
              run: (argument: string) => {
                if (argument) changeFilters(filters, argument);
                setDetailsOpen(false);
                setSearchOpen(true);
                requestAnimationFrame(() =>
                  searchInputRef.current?.focus({ preventScroll: true }),
                );
              },
            },
            ...(hasSessionData
              ? [
                  {
                    name: "chat",
                    description: "the history as a chat (Chat view)",
                    run: () => changeView("chat"),
                  },
                  {
                    name: "timeline",
                    description: "the history as a timeline (Chat view)",
                    run: () => changeView("timeline"),
                  },
                  {
                    name: "details",
                    description: detailsOpen
                      ? "back to the history (Session details)"
                      : "the session's details (Session details)",
                    run: () => setDetailsOpen((current) => !current),
                  },
                ]
              : []),
            ...(sessionReady
              ? [
                  {
                    name: "transcript",
                    description: "open the transcript (Open transcript)",
                    run: openSessionPreview,
                  },
                  {
                    name: "export",
                    description: "export the raw session (Export raw session)",
                    run: () => downloadSession(pane, connectionClient),
                  },
                ]
              : []),
          ],
        }
      : null,
  );

  // The chat's chips, its header's and its list of requests share one
  // context: where to ask, and what `!12` means here.
  return (
    <ForgeChatProvider chat={forgeChat}>
      {paneChat && rewindOpen ? (
        <AgentRewindSheet
          entries={messages}
          onRewind={rewindEntry}
          onClose={() => setRewindOpen(false)}
          check={rewindCheck}
        />
      ) : null}
      {modelOpen ? (
        <AgentModelSheet
          load={loadModels}
          onPick={pickModel}
          onClose={() => setModelOpen(false)}
        />
      ) : null}
      {mcpOpen ? (
        <AgentMcpSheet
          load={loadMcp}
          act={actOnMcp}
          onClose={() => setMcpOpen(false)}
        />
      ) : null}
      {/* Once it is known which session's place to open on. */}
      {paneChat && tasksOpen && tasksLoaded ? (
        <AgentTasksSheet
          key={openTaskId ?? ""}
          pane={pane}
          tasks={tasks}
          runningNow={runningNow}
          session={tasksSession}
          initialTaskId={openTaskId}
          onStop={canBackground ? stopTask : undefined}
          onClose={() => setTasksOpen(false)}
        />
      ) : null}
      <aside
        ref={drawerRef}
        className={`agent-history-drawer ${open ? "is-open" : ""} ${
          embedded ? "is-embedded" : ""
        } ${wide ? "is-wide" : ""}${paneChat ? " is-pane-chat" : ""}`}
        data-view={detailsOpen ? "details" : view}
        aria-label="Agent session"
        aria-hidden={!open}
        inert={!open}
        onKeyDownCapture={onComposerKeyCapture}
      >
        {mobile && !paneChat ? (
          <div className="agent-history-mobile-head">
            <button
              type="button"
              className="agent-history-session-toggle"
              aria-expanded={headerExpanded}
              aria-controls={headerId}
              onClick={() => setHeaderExpanded((current) => !current)}
            >
              <ChevronDown size={14} aria-hidden="true" />
              <span>Session</span>
              <span className="agent-history-count">{messages.length}</span>
              <span className="agent-history-mobile-agent">
                {pane.agent ?? "Agent"}
              </span>
            </button>
            <span
              className={`agent-history-status is-${pane.agent_status.toLowerCase()}`}
            >
              {pane.agent_status}
            </span>
            {mobileProfileChip}
            {chatViewToggle}
            <button
              ref={searchToggleRef}
              type="button"
              className="agent-history-icon"
              aria-label="Search history messages"
              title="Search history messages"
              aria-expanded={mobileSearchOpen}
              aria-controls={mobileSearchOpen ? searchId : undefined}
              onClick={() => {
                if (mobileSearchOpen) closeSearch();
                else {
                  setDetailsOpen(false);
                  setSearchOpen(true);
                }
              }}
            >
              <Search size={16} />
            </button>
            <button
              type="button"
              className="agent-history-icon"
              aria-label="Close session"
              title="Close"
              onClick={() => onOpenChange(false)}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        <div
          className="agent-history-drawer-head"
          id={headerId}
          hidden={mobile && !paneChat && !headerExpanded}
        >
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
          <ForgeHeaderChips branches={forgeBranches} />
          <AgentStatusChip
            status={paneChat ? chatAgentStatus : pane.agent_status}
            tasks={tasks}
            onOpenTasks={() => openTask(null)}
          />
          <ModelChip
            client={connectionClient}
            paneId={pane.pane_id}
            enabled={!!pane.agent}
            agentStatus={paneChat ? chatAgentStatus : pane.agent_status}
          />
          <div className="agent-history-actions">
            {paneChat ? mobileProfileChip : null}
            {paneChat ? (
              <>
                <AgentArtifactsMenu artifacts={artifacts} />
                <ForgeRequestsMenu groups={forgeGroups} />
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
                {/* Ctrl+Z: suspended as a job of the pane's shell; fg there
                    brings it back. Also on a phone, which has no Ctrl+Z. */}
                {paneChat.onSuspend && paneChat.modeBound ? (
                  <button
                    type="button"
                    className="agent-history-icon"
                    aria-label="Suspend"
                    title="Suspend to the shell (Ctrl+Z): fg brings it back"
                    disabled={!suspendHere}
                    onClick={() => suspendHere?.()}
                  >
                    <Pause size={14} />
                  </button>
                ) : null}
                {/* A phone's way to the terminal is its bottom bar's. */}
                {!mobile ? (
                  <button
                    type="button"
                    className="agent-history-icon"
                    aria-label={
                      paneChat.modeBound
                        ? "Open in terminal"
                        : "Show the terminal"
                    }
                    title={
                      paneChat.modeBound
                        ? "Open in terminal: hand the session back to Claude in the terminal"
                        : "Show the terminal"
                    }
                    disabled={paneChat.modeBound && !inConversation}
                    onClick={paneChat.onShowTerminal}
                  >
                    <SquareTerminal size={14} />
                  </button>
                ) : null}
              </>
            ) : (
              <>
                {!mobile ? chatViewToggle : null}
                <ForgeRequestsMenu groups={forgeGroups} />
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
              onClick={() => loadHistory(true)}
              aria-label="Refresh session"
              title="Refresh"
              disabled={loading}
            >
              <RefreshCw size={14} />
            </button>
            {!embedded && !mobile ? (
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
            {/* A pane's chat: its header ends with the pane's own buttons,
                which take Zen's way out (TerminalView). */}
            {paneChat ? null : <ZenDock buttonClassName="agent-history-icon" />}
          </div>
        </div>

        {unavailable && !paneChat ? (
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
              onClick={() => loadHistory(true)}
            >
              <RefreshCw size={13} />
              Retry
            </button>
          </div>
        ) : null}
        {/* A pane's chat still types into the agent, and answers its
            questions, without its transcript: its message box stays where
            it is, so a transcript appearing or going away keeps the focus
            and what is being typed. */}
        {unavailable && !paneChat ? null : (
          <>
            {/* Without a transcript, a pane's chat gives the reason once it lasted. */}
            {error && !paneWaiting ? (
              <div className="agent-history-error">{error}</div>
            ) : null}
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
      <ConfirmDialog
        open={open && retryConfirmation?.context === retryContext}
        title="Send this message again?"
        message={retryWarning ?? "Send the message to the agent's terminal."}
        confirmLabel="Send anyway"
        onClose={() => setRetryConfirmation(null)}
        onConfirm={() => {
          if (retryConfirmation?.context !== retryContext) return;
          const message = readOutbox(outboxKey).find(
            (each) =>
              each.id === retryConfirmation.message.id &&
              each.state === "failed",
          );
          if (message) resendMessage(message);
          setRetryConfirmation(null);
        }}
      />
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
    </ForgeChatProvider>
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
