import { MobileBottomBar } from "./components/MobileBottomBar";
import { createPortal, flushSync } from "react-dom";
import { bridge } from "./api";
import {
  listenForTaskNotificationActivation,
  isNotificationTarget,
  isRangerTaskNotificationTarget,
  type NotificationTarget,
  type RangerTaskNotificationTarget,
} from "./taskNotifications";
import { useReviewAnnotationDraft } from "./useReviewAnnotationDraft";
import {
  annotationDraftStorageKey,
  compileReviewFeedback,
  createReviewAnnotation,
  moveReviewAnnotation,
  parseReviewAnnotation,
  removeDeliveredReviewAnnotations,
  reanchorDiffReviewAnnotations,
  reanchorFileReviewAnnotations,
  reviewAgentPanes,
  type NewReviewAnnotation,
  type ReviewAnnotation,
} from "./annotations";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
import { passwordManagerIgnore } from "./passwordManagerIgnore";
import {
  getReviewSnapshot,
  loadReviews,
  startReviewClient,
  useReviewState,
} from "./review";
import {
  livePins,
  pinHolds,
  reviewPinKey as makeReviewPinKey,
} from "./reviewPins";
import { LAYOUT_CHANGE_EVENT, useLayoutPreferences } from "./layoutPreferences";
import { useSystemBack } from "./systemBack";
import { startFrontendFreshness } from "./frontendFreshness";
import { paneView, togglePaneView, usePaneView } from "./paneView";
import {
  shortcutMatches,
  shortcutTitle,
  useShortcutPreferences,
} from "./shortcutPreferences";
import { SHORTCUT_NUMBERS, type ShortcutId } from "./shortcutBindings";
import { activeTerminalInput, blurActiveInput } from "./activeTerminalInput";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Command,
  Compass,
  FileDiff,
  FolderTree,
  GitGraph,
  GitPullRequestArrow,
  Settings,
  SquarePlus,
  History,
  Info,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  MessagesSquare,
  Minimize2,
  PanelTop,
  SquareTerminal,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ITheme } from "@xterm/xterm";
import packageJson from "../package.json";
import {
  type AccentColor,
  normalizeAccentColor,
  normalizeTerminalFontFamily,
  normalizeTerminalFontScale,
  terminalFontFamilyStack,
  normalizeThemePreference,
  normalizeUiScale,
  normalizeBlackBackground,
  normalizeZenMode,
  serializeBlackBackground,
  serializeZenMode,
  UI_SCALE_DEFAULT,
  type ResolvedTheme,
  resolveSystemTheme,
  SYSTEM_THEME_QUERY,
  type ThemePreference,
} from "./appearance";
import { AgentIcon } from "./components/AgentIcon";
import { agentStateKind, paneHasAgentHistory } from "./components/agentSession";
import { CloseButton } from "./components/CloseButton";
import { Toast } from "./components/Toast";
import { focusIfUnchanged } from "./components/dialogFocus";
import {
  COMMAND_MENU_OPENING,
  CommandCombobox,
} from "./components/CommandCombobox";
import { CONFIG_MENU_ID, ConfigMenu } from "./components/ConfigMenu";
import { openConfiguration } from "./configurationOpen";
import { ConnectionSwitcher } from "./components/ConnectionSwitcher";
import {
  type ActiveDiffSelection,
  clearDiffViewerResourceCache,
  prefetchDiffViewerWorkspace,
} from "./components/DiffViewerPanel";
import { clearDiffContentResourceState } from "./components/diffContentState";
import {
  clearFileExplorerResourceCache,
  prefetchFileExplorerWorkspace,
  requestFilePreview,
} from "./components/fileExplorerResources";
import { type ActiveFilePreviewSelection } from "./components/FilePreviewContent";
import { AnnotationPanel } from "./components/AnnotationPanel";
import {
  assistantActionExecuting,
  onAssistantOpenRequest,
  onAssistantShow,
  useAssistantState,
} from "./assistant";

// Ranger showing a workspace or session switches this browser to it.
onAssistantShow((show) => {
  if (show.pane_id)
    void store.jumpToConnectionPane(show.connection_id, show.pane_id);
  else
    void store.jumpToConnectionWorkspace(show.connection_id, show.workspace_id);
});
import type { AssistantSource } from "../../shared/assistant";
import { GlobalTooltip } from "./components/GlobalTooltip";
import { MobileTabSheet } from "./components/MobileTabSheet";
import { requestClosePane, requestCloseTab, TabBar } from "./components/TabBar";
import type { TerminalWorkspaceFileRequest } from "./components/TerminalView";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { isIosDevice } from "./downloadFile";
import { lazyWithReload } from "./lazyWithReload";
import {
  LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
  type MobileTerminalShortcutRows,
  type MobileTerminalSideShortcuts,
  parseMobileTerminalShortcutRows,
  parseMobileTerminalSideShortcuts,
  serializeMobileTerminalShortcutRows,
  serializeMobileTerminalSideShortcuts,
} from "./mobileTerminalShortcuts";
import {
  CUSTOM_TERMINAL_THEMES_STORAGE_KEY,
  type CustomTerminalTheme,
  parseCustomTerminalThemes,
  parseTerminalThemeSelection,
  resolveTerminalTheme,
  serializeCustomTerminalThemes,
  serializeTerminalThemeSelection,
  TERMINAL_THEME_SELECTION_STORAGE_KEY,
  type TerminalThemeSelection,
} from "./terminalThemes";
import {
  activePaneIdForSnapshot,
  type PaneJumpEntry,
  paneJumpConnectionTarget,
  paneJumpDefaultIndex,
  paneJumpEntries,
  paneJumpLocation,
  type PaneJumpRoundTrip,
  type PaneJumpScope,
  paneJumpTargetId,
  paneSearchEntries,
  parseWorkspaceHistory,
  type PointerPosition,
  pointerLeftOrigin,
  recordWorkspaceVisit,
  workspaceHistoryKey,
} from "./paneJump";
import { usePaneJumpScope } from "./paneJumpScope";
import { useConnectionSessions } from "./components/useConnectionSessions";
import {
  type Notice,
  noticeAutoDismissDelay,
  shallowEqual,
  store,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  taskNotificationTargetFromNotice,
  taskNotificationTargetIsCurrent,
  useStoreSelector,
  WORKTREE_REMOVED_EVENT,
  type WorktreeRemovedTarget,
} from "./store";
import { paneShortcutAction } from "./paneShortcuts";
import { pluginActionShortcut } from "./pluginActionShortcuts";
import {
  adjacentTabId,
  closeShortcutTarget,
  tabShortcutAction,
} from "./tabShortcuts";
import { orderTabsForDisplay, tabPinsFor } from "./tabPins";
import { copyTextFromUserGesture } from "./terminalClipboard";
import { terminalPasteRequest } from "./terminalPaste";
import {
  activateTerminalComposerDraftScope,
  readTerminalComposerDraft,
  sendTerminalComposerText,
  terminalComposerDraftKey,
  writeTerminalComposerDraft,
} from "./terminalComposer";
import { terminalMountKey } from "./terminalConnection";
import type { FileExplorerEntry, GitDiffEntry, Pane } from "./types";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "./useConnectionClient";
import { agentClass } from "./utils";
import {
  INSPECTOR_MIN_BOTTOM,
  INSPECTOR_MIN_RIGHT,
  type InspectorDock,
  type InspectorView,
  inspectorMaximumSize,
  isWorkspaceInspectorShortcut,
  preferencesStorageKey,
  readInspectorPreferences,
  readResourceFileSelection,
  relativePathWithinCheckout,
  resolveWorkspaceForScope,
  resourceOwnerKey,
  resourceScopeForWorkspace,
  resourceStateKey,
  sameResourceOwner,
  WORKSPACE_INSPECTOR_REQUEST_EVENT,
  type ResourceScope,
  WORKSPACE_ANNOTATION_REQUEST_EVENT,
  type WorkspaceAnnotationRequest,
  type WorkspaceInspectorRequest,
  type WorkspaceInspectorState,
  writeInspectorPreferences,
  writeResourceFileSelection,
} from "./workspaceResource";
import "./styles/layout/app.css";
import "./styles/layout/topbar.css";
import "./styles/layout/sidebar.css";
import "./styles/layout/toast.css";
import "./styles/layout/mobile-nav.css";
import "./components/AssistantPanel.css";
import "./components/markdown.css";

const AssistantPanel = lazyWithReload("assistant", () =>
  import("./components/AssistantPanel").then((module) => ({
    default: module.AssistantPanel,
  })),
);

/** Reviews kept mounted besides the pinned ones. */
const REVIEWS_KEPT = 6;
const REVIEW_PINS_KEY = "reviewPins";
const REVIEW_CLOSED_KEY = "reviewClosed";

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = roamgateLocalStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key: string, value: unknown) {
  try {
    roamgateLocalStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const ReviewHost = lazyWithReload("review", () =>
  import("./components/ReviewHost").then((module) => ({
    default: module.ReviewHost,
  })),
);

const ReviewList = lazyWithReload("review-list", () =>
  import("./components/ReviewList").then((module) => ({
    default: module.ReviewList,
  })),
);

const ShortcutCheatSheet = lazyWithReload("shortcut-cheatsheet", () =>
  import("./components/ShortcutLookupDialog").then((module) => ({
    default: module.ShortcutCheatSheet,
  })),
);

const WorkspaceInspectorHost = lazyWithReload("workspace-inspector", () =>
  import("./components/WorkspaceInspectorHost").then((module) => ({
    default: module.WorkspaceInspectorHost,
  })),
);

/**
 * Shortcuts that take you to another workspace, tab or pane: from the
 * review they put it away (it is kept) and go on.
 */
const REVIEW_LEAVING_SHORTCUTS: ShortcutId[] = [
  "panes.search",
  "panes.recent",
  "workspaces.open",
  "tab.next",
  "tab.previous",
  "pane.left",
  "pane.right",
  "pane.up",
  "pane.down",
  ...SHORTCUT_NUMBERS.map((n): ShortcutId => `tab.${n}`),
];

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 560;
const DEFAULT_SIDEBAR = 284;
const THEME_KEY = "theme";
const ACCENT_COLOR_KEY = "accentColor";
const UI_SCALE_KEY = "uiScale";
const TERMINAL_FONT_SCALE_KEY = "terminalFontScale";
const TERMINAL_FONT_FAMILY_KEY = "terminalFontFamily";
const ZEN_MODE_KEY = "zenMode";
const BLACK_BACKGROUND_KEY = "blackBackground";
// Agent chats show their saved history at once after a reload: read it early,
// outside the first bundle.
const agentHistoryCache = import("./agentHistoryCache");
void agentHistoryCache.then((cache) => cache.loadAgentHistoryCache());

const LazyTerminalView = lazyWithReload("terminal-view", () =>
  import("./components/TerminalView").then((module) => ({
    default: module.TerminalView,
  })),
);

// xterm.js is heavy; keep the overlay's own copy out of the initial bundle the
// same way LazyTerminalView does, since most sessions never open a popup.
const LazyPopupOverlay = lazyWithReload("popup-overlay", () =>
  import("./components/PopupOverlay").then((module) => ({
    default: module.PopupOverlay,
  })),
);

function PopupOverlay({
  terminalTheme,
  terminalFontFamily,
  terminalFontScale,
}: {
  terminalTheme: ITheme;
  terminalFontFamily: string;
  terminalFontScale: number;
}) {
  // Gate the dynamic import on popup presence, not just its content, so a
  // session that never opens one never fetches xterm.js for it.
  const hasPopup = useStoreSelector((s) => s.popup !== null);
  if (!hasPopup) return null;
  return (
    <Suspense fallback={null}>
      <LazyPopupOverlay
        terminalTheme={terminalTheme}
        terminalFontFamily={terminalFontFamily}
        terminalFontScale={terminalFontScale}
      />
    </Suspense>
  );
}

type TerminalViewProps = {
  paneId?: string;
  visible?: boolean;
  mobileInputTarget?: HTMLElement | null;
  onActivateTerminalSurface?: () => void;
  terminalTheme: ITheme;
  terminalFontFamily: string;
  terminalFontScale: number;
  showMobileKeys?: boolean;
  mobileShortcuts?: MobileTerminalShortcutRows;
  mobileSideShortcuts?: MobileTerminalSideShortcuts;
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
  agentHistoryOpen?: boolean;
  onAgentHistoryOpenChange?: (open: boolean) => void;
  onOpenWorkspaceFile?: (request: TerminalWorkspaceFileRequest) => void;
  zenMode?: boolean;
  onExitZenMode?: () => void;
};

function TerminalLoadingFallback({
  label = "Loading terminal",
}: {
  label?: string;
}) {
  return (
    <div className="terminal-loading" role="status">
      <span className="terminal-loading-dot" />
      {label}
    </div>
  );
}

function TerminalView(props: TerminalViewProps) {
  // A pane that opens as a chat never says it loads a terminal; nor does one
  // not known yet, which may be one.
  const chat = useStoreSelector((state) => {
    if (state.panes.length === 0) return true;
    const selected =
      state.selectedPaneId &&
      state.layout?.panes.some((p) => p.pane_id === state.selectedPaneId)
        ? state.selectedPaneId
        : null;
    const paneId =
      props.paneId ?? selected ?? state.layout?.focused_pane_id ?? null;
    const pane = state.panes.find((p) => p.pane_id === paneId);
    return (
      paneHasAgentHistory(pane) &&
      paneView(state.activeConnectionId, pane.pane_id) === "chat"
    );
  });
  return (
    <Suspense fallback={chat ? null : <TerminalLoadingFallback />}>
      <LazyTerminalView {...props} />
    </Suspense>
  );
}

function NoticeDetail({ notice }: { notice: Notice }) {
  if (!notice.detail) return null;
  if (notice.detailMode === "output") {
    return (
      <div className="toast-output">
        {notice.detailTitle ? (
          <div className="toast-output-title">{notice.detailTitle}</div>
        ) : null}
        <pre>{notice.detail}</pre>
      </div>
    );
  }
  return <p>{notice.detail}</p>;
}

function ToastMark({
  kind,
  loading = false,
}: {
  kind: Notice["kind"];
  loading?: boolean;
}) {
  const Mark = loading
    ? LoaderCircle
    : kind === "success"
      ? CheckCircle2
      : kind === "error"
        ? CircleAlert
        : Info;

  return (
    <span className="toast-mark" aria-hidden="true">
      <Mark size={16} strokeWidth={2.1} />
    </span>
  );
}

export type Theme = ThemePreference;
type MobileView =
  | "workspaces"
  | "session"
  | "annotations"
  | "assistant"
  | InspectorView;
type OpenInspectorOptions = {
  entry?: FileExplorerEntry;
  path?: string;
  fragment?: string;
  /** Line to show in the file preview. */
  line?: number;
  initialDirectory?: string;
  originPaneId?: string;
  focusInspector?: boolean;
};

function normalizeSidebarWidth(value: number): number {
  return Number.isFinite(value) && value >= MIN_SIDEBAR && value <= MAX_SIDEBAR
    ? value
    : DEFAULT_SIDEBAR;
}

function loadSidebarWidth(): number {
  return normalizeSidebarWidth(
    Number(roamgateLocalStorage.getItem("sidebarWidth")),
  );
}

function loadTheme(): Theme {
  return normalizeThemePreference(roamgateLocalStorage.getItem(THEME_KEY));
}

function loadSystemTheme(): ResolvedTheme {
  return resolveSystemTheme(window.matchMedia(SYSTEM_THEME_QUERY));
}

function loadAccentColor(): AccentColor {
  return normalizeAccentColor(roamgateLocalStorage.getItem(ACCENT_COLOR_KEY));
}

function loadUiScale(): number {
  return normalizeUiScale(roamgateLocalStorage.getItem(UI_SCALE_KEY));
}

function loadTerminalFontScale(): number {
  return normalizeTerminalFontScale(
    roamgateLocalStorage.getItem(TERMINAL_FONT_SCALE_KEY),
    roamgateLocalStorage.getItem(UI_SCALE_KEY),
  );
}

function loadTerminalFontFamily(): string {
  return normalizeTerminalFontFamily(
    roamgateLocalStorage.getItem(TERMINAL_FONT_FAMILY_KEY),
  );
}

function loadBlackBackground(): boolean {
  return normalizeBlackBackground(
    roamgateLocalStorage.getItem(BLACK_BACKGROUND_KEY),
  );
}

function loadZenMode(): boolean {
  return normalizeZenMode(roamgateLocalStorage.getItem(ZEN_MODE_KEY));
}

function loadTerminalThemeSelection(): TerminalThemeSelection {
  return parseTerminalThemeSelection(
    roamgateLocalStorage.getItem(TERMINAL_THEME_SELECTION_STORAGE_KEY),
  );
}

function loadCustomTerminalThemes(): CustomTerminalTheme[] {
  return parseCustomTerminalThemes(
    roamgateLocalStorage.getItem(CUSTOM_TERMINAL_THEMES_STORAGE_KEY),
  );
}

function loadMobileTerminalShortcuts(): MobileTerminalShortcutRows {
  const current = roamgateLocalStorage.getItem(
    MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  );
  if (current !== null) return parseMobileTerminalShortcutRows(current);
  const legacy = roamgateLocalStorage.getItem(
    LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
  );
  const migrated = parseMobileTerminalShortcutRows(legacy);
  if (legacy !== null) {
    roamgateLocalStorage.setItem(
      MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalShortcutRows(migrated),
    );
  }
  return migrated;
}

function loadMobileTerminalSideShortcuts(): MobileTerminalSideShortcuts {
  return parseMobileTerminalSideShortcuts(
    roamgateLocalStorage.getItem(MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY),
  );
}

function emptyActiveDiffSelection(): ActiveDiffSelection {
  return {
    entry: null,
    file: null,
    loading: false,
    error: null,
    entries: [],
    files: {},
    fileErrors: {},
    summaryLoading: false,
  };
}

function inspectorFileEntry(path: string): FileExplorerEntry {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return {
    name,
    path,
    type: "file",
    size: 0,
    mtime_ms: 0,
    hidden: name.startsWith("."),
  };
}

function emptyActiveFilePreviewSelection(): ActiveFilePreviewSelection {
  return {
    entry: null,
    preview: null,
    loading: false,
    error: null,
  };
}

const viewportDebugEnabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debugViewport");

// Mobile browsers can over-report keyboard occlusion by including an input
// accessory or browser-control strip. Keep enough visual viewport lift to
// expose the composer, but trim the platform-specific overshoot.
const usesIosKeyboardViewportLift =
  typeof navigator !== "undefined" && isIosDevice(navigator);
// ?kbdTrim=<px> overrides the default for device-specific experiments.
const defaultKeyboardInsetTrim = usesIosKeyboardViewportLift ? 30 : 0;
const keyboardInsetTrim =
  typeof window !== "undefined"
    ? Math.max(
        0,
        Number.parseInt(
          new URLSearchParams(window.location.search).get("kbdTrim") ??
            String(defaultKeyboardInsetTrim),
          10,
        ) || 0,
      )
    : 0;

function ViewportDebugOverlay() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:0;padding-bottom:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    const update = () => {
      const vv = window.visualViewport;
      const cs = getComputedStyle(document.documentElement);
      setLines([
        `mode ${
          window.matchMedia("(display-mode: standalone)").matches
            ? "standalone"
            : "browser"
        }`,
        `inner ${window.innerHeight} outer ${window.outerHeight}`,
        `vv ${vv ? `${Math.round(vv.height)} @${Math.round(vv.offsetTop)}` : "n/a"}`,
        `appH ${cs.getPropertyValue("--app-height") || "-"}`,
        `kbd ${cs.getPropertyValue("--keyboard-inset-bottom") || "-"}`,
        `lift ${cs.getPropertyValue("--keyboard-inset-content") || "-"}`,
        `safe-bottom ${probe.offsetHeight}`,
      ]);
    };
    update();
    const timer = window.setInterval(update, 400);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.clearInterval(timer);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      probe.remove();
    };
  }, []);
  return (
    <pre className="viewport-debug-overlay" aria-hidden="true">
      {lines.join("\n")}
    </pre>
  );
}

function useVisualViewportCssVars(uiScale: number) {
  useEffect(() => {
    const root = document.documentElement;
    // CSS zoom scales every computed px length, so emit viewport geometry in
    // pre-zoom units to keep the rendered shell matching the real viewport.
    const geometryScale = uiScale / 100;
    let pollTimer: number | undefined;
    let settleTimers: number[] = [];

    const measure = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const keyboardInset = Math.max(
        0,
        window.innerHeight - height - offsetTop,
      );
      const keyboardOpen = keyboardInset > 24;
      root.classList.toggle("keyboard-open", keyboardOpen);
      root.style.setProperty(
        "--app-viewport-height",
        `${Math.round(height / geometryScale)}px`,
      );
      // Keep the app surface at the full layout height, even while the
      // keyboard is open. iOS can over-report the keyboard occlusion (the
      // floating keyboard accessory bar counts as covered area), so sizing
      // the app to the visual viewport leaves an unpainted strip above the
      // keyboard. Instead the app stays full-height and content is lifted
      // with padding-bottom in the mobile styles.
      root.style.setProperty(
        "--app-height",
        `calc(${Math.round(window.innerHeight / geometryScale)}px + env(safe-area-inset-bottom, 0px))`,
      );
      root.style.setProperty(
        "--app-viewport-offset-top",
        `${Math.round(offsetTop / geometryScale)}px`,
      );
      root.style.setProperty(
        "--keyboard-inset-bottom",
        `${Math.round(keyboardInset / geometryScale)}px`,
      );
      // Both platforms need the visual viewport lift here; without it some
      // Android browsers place the composer behind the software keyboard.
      const contentInset = Math.max(0, keyboardInset - keyboardInsetTrim);
      root.style.setProperty(
        "--keyboard-inset-content",
        `${Math.round(contentInset / geometryScale)}px`,
      );
      root.style.setProperty(
        "--keyboard-inset-composer-gap",
        `${Math.round(
          (usesIosKeyboardViewportLift
            ? Math.max(0, keyboardInset - contentInset)
            : 0) / geometryScale,
        )}px`,
      );
      return keyboardOpen;
    };

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    // Third-party iOS keyboards can change height (toolbars, candidate rows)
    // without firing visualViewport events, leaving the app sized for a
    // stale keyboard inset and exposing a blank strip above the keyboard.
    // Poll the geometry while the keyboard is open so those changes apply.
    const syncPolling = (keyboardOpen: boolean) => {
      if (keyboardOpen && pollTimer === undefined) {
        pollTimer = window.setInterval(() => {
          if (!measure()) stopPolling();
        }, 500);
      } else if (!keyboardOpen) {
        stopPolling();
      }
    };

    const update = () => {
      syncPolling(measure());
    };

    // iOS reports keyboard geometry in stages during the show/hide animation,
    // so re-measure after it settles to catch the final values.
    const updateWhenSettled = () => {
      update();
      for (const timer of settleTimers) window.clearTimeout(timer);
      settleTimers = [250, 600].map((delay) =>
        window.setTimeout(update, delay),
      );
    };

    update();
    window.visualViewport?.addEventListener("resize", updateWhenSettled);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", updateWhenSettled);
    window.addEventListener("focusin", updateWhenSettled);
    window.addEventListener("focusout", updateWhenSettled);
    return () => {
      stopPolling();
      for (const timer of settleTimers) window.clearTimeout(timer);
      window.visualViewport?.removeEventListener("resize", updateWhenSettled);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", updateWhenSettled);
      window.removeEventListener("focusin", updateWhenSettled);
      window.removeEventListener("focusout", updateWhenSettled);
      root.classList.remove("keyboard-open");
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-viewport-offset-top");
      root.style.removeProperty("--keyboard-inset-bottom");
      root.style.removeProperty("--keyboard-inset-content");
      root.style.removeProperty("--keyboard-inset-composer-gap");
    };
  }, [uiScale]);
}

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  if (target.closest(".file-preview-code .cm-editor")) return false;
  return target.isContentEditable;
}

/**
 * Typing where the navigation shortcuts (switching panes, tabs and
 * workspaces) must not fire. An agent chat's message box stands for the
 * agent's terminal, which takes them, so it does too.
 */
function blocksNavigationShortcuts(target: EventTarget | null) {
  if (
    target instanceof HTMLElement &&
    target.closest(".agent-history-composer")
  )
    return false;
  return isEditableElement(target);
}

function tabShortcutIndex(e: KeyboardEvent) {
  const number = SHORTCUT_NUMBERS.find((n) => shortcutMatches(e, `tab.${n}`));
  return number === undefined ? null : number - 1;
}

// Herdr reports pane rectangles in terminal-cell coordinates. The GUI maps
// those rectangles into CSS percentages so panes scale with the browser.
function rectPercent(value: number, start: number, size: number) {
  if (size <= 0) return 0;
  return ((value - start) / size) * 100;
}

function paneTitle(
  paneId: string,
  panes: ReturnType<typeof store.get>["panes"],
) {
  const pane = panes.find((p) => p.pane_id === paneId);
  if (pane?.agent) return pane.agent;
  const cwd = pane?.foreground_cwd ?? pane?.cwd;
  const name = cwd?.split(/[\\/]/).filter(Boolean).pop();
  return name || paneId;
}

/** How long a workspace must stay displayed to count as visited. */
const WORKSPACE_VISIT_SETTLE_MS = 1000;
const WORKSPACE_HISTORY_STORAGE_KEY = "workspaceSwitcherHistory";

function readWorkspaceHistory(): readonly string[] {
  try {
    return parseWorkspaceHistory(
      roamgateLocalStorage.getItem(WORKSPACE_HISTORY_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

function PaneJumpOverlay({
  entries,
  scope,
  selectedIndex,
  search,
  onSearchChange,
  onSelectIndex,
  onCommit,
  onClose,
}: {
  entries: PaneJumpEntry[];
  scope: PaneJumpScope;
  selectedIndex: number;
  search: string | null;
  onSearchChange: (value: string) => void;
  onSelectIndex: (index: number) => void;
  onCommit: (index: number) => void;
  onClose: () => void;
}) {
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Where the pointer rested when the switcher opened; rows only follow the
  // pointer once it has left that spot.
  const pointerOriginRef = useRef<PointerPosition | null>(null);
  const [pointerActive, setPointerActive] = useState(false);
  const searching = search !== null;
  const selectedEntryKey = entries[selectedIndex]?.key;
  const workspaces = scope === "workspaces";
  const noun = workspaces ? "Workspace" : "Pane";
  const plural = workspaces ? "workspaces" : "panes";

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, selectedEntryKey]);
  useEffect(() => {
    if (searching) searchInputRef.current?.focus();
  }, [searching]);

  if (entries.length === 0 && !searching) return null;
  const listId = "pane-jump-list";
  return (
    <div className="pane-jump-backdrop">
      <div className="pane-jump-popover">
        <div className="pane-jump-head">
          <strong>{`${searching ? "Find" : "Switch"} ${noun}`}</strong>
          <span>
            {searching
              ? `Filters every open ${plural.slice(0, -1)}. Use Up / Down and Enter`
              : "K to search; Enter or release modifier to switch"}
          </span>
        </div>
        {searching ? (
          <input
            ref={searchInputRef}
            className="pane-jump-search"
            value={search}
            spellCheck={false}
            autoComplete="off"
            {...passwordManagerIgnore}
            placeholder="Workspace, tab, directory, or agent"
            role="combobox"
            aria-label={`Search ${plural}`}
            aria-expanded={true}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={
              selectedEntryKey
                ? `${listId}-${encodeURIComponent(selectedEntryKey)}`
                : undefined
            }
            onChange={(event) => onSearchChange(event.target.value)}
            onBlur={() => onClose()}
          />
        ) : null}
        {entries.length === 0 ? (
          <p className="pane-jump-empty" role="status">
            {`No ${plural} match this search.`}
          </p>
        ) : null}
        <div
          className={`pane-jump-list ${pointerActive ? "is-pointer-active" : ""}`}
          id={listId}
          role="listbox"
          aria-label={`${searching ? "Matching" : "Recent"} ${plural}`}
        >
          {entries.map((entry, index) => (
            <button
              key={entry.key}
              id={`${listId}-${encodeURIComponent(entry.key)}`}
              ref={index === selectedIndex ? selectedItemRef : undefined}
              type="button"
              tabIndex={-1}
              className={`pane-jump-item ${
                index === selectedIndex ? "is-selected" : ""
              } ${entry.current ? "is-current" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              onPointerMove={(event) => {
                if (!pointerActive) {
                  if (!pointerOriginRef.current) {
                    pointerOriginRef.current = {
                      screenX: event.screenX,
                      screenY: event.screenY,
                    };
                    return;
                  }
                  if (!pointerLeftOrigin(pointerOriginRef.current, event))
                    return;
                  setPointerActive(true);
                }
                if (index !== selectedIndex) onSelectIndex(index);
              }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onCommit(index)}
            >
              {entry.agent ? (
                <span className="pane-jump-agent-identity">
                  <AgentIcon agent={entry.agent} compact />
                  <span
                    className={`pane-jump-status status-${entry.agentStatus ?? "unknown"}`}
                  />
                </span>
              ) : null}
              <span className="pane-jump-text">
                <span className="pane-jump-title-line">
                  <strong>{entry.title}</strong>
                  {entry.current ? (
                    <span className="pane-jump-current-badge">Current</span>
                  ) : null}
                  {entry.agentStatus ? (
                    <span
                      className={`${agentClass(entry.agentStatus)} pane-jump-agent-status`}
                    >
                      {entry.agentStatus}
                    </span>
                  ) : null}
                </span>
                <span className="pane-jump-subtitle">
                  {entry.agent ? (
                    <>
                      <span className="pane-jump-agent-name">
                        {entry.agent}
                      </span>
                      {" · "}
                    </>
                  ) : null}
                  <span className="pane-jump-tab" title={entry.tabLabel}>
                    {entry.tabLabel}
                  </span>
                  <span className="pane-jump-id" title={entry.paneId}>
                    {" · "}
                    {entry.paneLabel}
                  </span>
                  {entry.cwd ? (
                    <span className="pane-jump-cwd" title={entry.cwd}>
                      {" · "}
                      {entry.cwd}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type PaneLayoutSnapshot = NonNullable<ReturnType<typeof store.get>["layout"]>;
type PaneLayoutPaneSnapshot = PaneLayoutSnapshot["panes"][number];
type PaneLayoutSplitSnapshot = PaneLayoutSnapshot["splits"][number];
type PaneResizeDirection = "left" | "right" | "up" | "down";

function overlapLength(
  aStart: number,
  aSize: number,
  bStart: number,
  bSize: number,
) {
  return Math.max(
    0,
    Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart),
  );
}

function bestPaneNearSplit(
  panes: PaneLayoutPaneSnapshot[],
  split: PaneLayoutSplitSnapshot,
  side: "before" | "after",
  pointerPerpendicular: number,
) {
  const boundary =
    split.direction === "right"
      ? split.rect.x + split.rect.width * split.ratio
      : split.rect.y + split.rect.height * split.ratio;
  const edgeTolerance = 6;
  const containsPointer = (pane: PaneLayoutPaneSnapshot) =>
    split.direction === "right"
      ? pointerPerpendicular >= pane.rect.y &&
        pointerPerpendicular <= pane.rect.y + pane.rect.height
      : pointerPerpendicular >= pane.rect.x &&
        pointerPerpendicular <= pane.rect.x + pane.rect.width;
  const candidates = panes
    .map((pane) => {
      const edge =
        split.direction === "right"
          ? side === "before"
            ? pane.rect.x + pane.rect.width
            : pane.rect.x
          : side === "before"
            ? pane.rect.y + pane.rect.height
            : pane.rect.y;
      const perpendicularOverlap =
        split.direction === "right"
          ? overlapLength(
              pane.rect.y,
              pane.rect.height,
              split.rect.y,
              split.rect.height,
            )
          : overlapLength(
              pane.rect.x,
              pane.rect.width,
              split.rect.x,
              split.rect.width,
            );
      return {
        pane,
        edgeDistance: Math.abs(edge - boundary),
        perpendicularOverlap,
      };
    })
    .filter(
      ({ pane, edgeDistance, perpendicularOverlap }) =>
        edgeDistance <= edgeTolerance &&
        perpendicularOverlap > 0 &&
        containsPointer(pane),
    )
    .sort((a, b) => b.perpendicularOverlap - a.perpendicularOverlap);
  return candidates[0]?.pane ?? null;
}

function splitBoundaryFromPaneRects(
  panes: PaneLayoutPaneSnapshot[],
  split: PaneLayoutSplitSnapshot,
) {
  const ratioBoundary =
    split.direction === "right"
      ? split.rect.x + split.rect.width * split.ratio
      : split.rect.y + split.rect.height * split.ratio;
  const before = bestPaneNearSplit(
    panes,
    split,
    "before",
    split.direction === "right"
      ? split.rect.y + split.rect.height / 2
      : split.rect.x + split.rect.width / 2,
  );
  const after = bestPaneNearSplit(
    panes,
    split,
    "after",
    split.direction === "right"
      ? split.rect.y + split.rect.height / 2
      : split.rect.x + split.rect.width / 2,
  );
  if (!before || !after) return ratioBoundary;
  const beforeEdge =
    split.direction === "right"
      ? before.rect.x + before.rect.width
      : before.rect.y + before.rect.height;
  const afterEdge = split.direction === "right" ? after.rect.x : after.rect.y;
  return (beforeEdge + afterEdge) / 2;
}

function resizeTargetForSplit(
  layout: PaneLayoutSnapshot,
  split: PaneLayoutSplitSnapshot,
  dragSign: 1 | -1,
  pointerPerpendicular: number,
): { paneId: string; direction: PaneResizeDirection } | null {
  if (split.direction === "right") {
    const side = dragSign > 0 ? "before" : "after";
    const pane = bestPaneNearSplit(
      layout.panes,
      split,
      side,
      pointerPerpendicular,
    );
    return pane
      ? { paneId: pane.pane_id, direction: dragSign > 0 ? "right" : "left" }
      : null;
  }
  const side = dragSign > 0 ? "before" : "after";
  const pane = bestPaneNearSplit(
    layout.panes,
    split,
    side,
    pointerPerpendicular,
  );
  return pane
    ? { paneId: pane.pane_id, direction: dragSign > 0 ? "down" : "up" }
    : null;
}

// Render the active tab's Herdr pane layout; single-pane and zoomed tabs keep
// the old full terminal view.
function TerminalPaneLayout({
  visible,
  mobileInputTarget,
  onActivateTerminalSurface,
  terminalTheme,
  terminalFontFamily,
  terminalFontScale,
  mobileShortcuts,
  mobileSideShortcuts,
  composerOpen,
  onComposerOpenChange,
  agentHistoryOpen,
  onAgentHistoryOpenChange,
  onOpenWorkspaceFile,
  zenMode,
  onExitZenMode,
}: {
  visible: boolean;
  mobileInputTarget: HTMLElement | null;
  onActivateTerminalSurface: () => void;
  terminalTheme: ITheme;
  terminalFontFamily: string;
  terminalFontScale: number;
  mobileShortcuts: MobileTerminalShortcutRows;
  mobileSideShortcuts: MobileTerminalSideShortcuts;
  composerOpen: boolean;
  onComposerOpenChange: (open: boolean) => void;
  agentHistoryOpen: boolean;
  onAgentHistoryOpenChange: (open: boolean) => void;
  onOpenWorkspaceFile: (request: TerminalWorkspaceFileRequest) => void;
  zenMode: boolean;
  onExitZenMode: () => void;
}) {
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      layout: state.layout,
      panes: state.panes,
      selectedPaneId: state.selectedPaneId,
    }),
    shallowEqual,
  );
  const { mobile } = useLayoutPreferences();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const layout = s.layout;
  const visiblePanes =
    layout?.panes.filter((lp) =>
      s.panes.some((pane) => pane.pane_id === lp.pane_id),
    ) ?? [];
  const fallbackPaneId = visiblePanes[0]?.pane_id ?? null;
  const activePaneId =
    visiblePanes.find((lp) => lp.pane_id === s.selectedPaneId)?.pane_id ??
    visiblePanes.find((lp) => lp.pane_id === layout?.focused_pane_id)
      ?.pane_id ??
    fallbackPaneId;
  const mountKeyForPane = (paneId: string | null) => {
    const terminalId =
      s.panes.find((pane) => pane.pane_id === paneId)?.terminal_id ?? null;
    return terminalMountKey(
      {
        connectionId: s.activeConnectionId,
        generation: s.connectionGeneration,
      },
      paneId,
      terminalId,
    );
  };

  if (!layout || layout.zoomed || visiblePanes.length <= 1) {
    return (
      <TerminalView
        key={mountKeyForPane(activePaneId)}
        terminalTheme={terminalTheme}
        terminalFontFamily={terminalFontFamily}
        terminalFontScale={terminalFontScale}
        mobileShortcuts={mobileShortcuts}
        mobileSideShortcuts={mobileSideShortcuts}
        visible={visible}
        mobileInputTarget={mobileInputTarget}
        onActivateTerminalSurface={onActivateTerminalSurface}
        composerOpen={composerOpen}
        onComposerOpenChange={onComposerOpenChange}
        agentHistoryOpen={agentHistoryOpen}
        onAgentHistoryOpenChange={onAgentHistoryOpenChange}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        zenMode={zenMode}
        onExitZenMode={onExitZenMode}
      />
    );
  }

  if (mobile && activePaneId) {
    const activeIndex = Math.max(
      0,
      visiblePanes.findIndex((lp) => lp.pane_id === activePaneId),
    );
    const previousPane =
      visiblePanes[
        (activeIndex - 1 + visiblePanes.length) % visiblePanes.length
      ];
    const nextPane = visiblePanes[(activeIndex + 1) % visiblePanes.length];
    return (
      <div className="pane-switcher-layout" aria-label="Terminal pane switcher">
        <div className="pane-switcher">
          <button
            type="button"
            className="pane-switcher-button"
            aria-label="Previous pane"
            tabIndex={-1}
            onPointerDown={blurActiveInput}
            onClick={() => void store.focusPane(previousPane.pane_id)}
          >
            <ChevronLeft size={15} />
          </button>
          <div className="pane-switcher-label">
            <strong>
              Pane {activeIndex + 1} / {visiblePanes.length}
            </strong>
            <span>{paneTitle(activePaneId, s.panes)}</span>
          </div>
          <button
            type="button"
            className="pane-switcher-button"
            aria-label="Next pane"
            tabIndex={-1}
            onPointerDown={blurActiveInput}
            onClick={() => void store.focusPane(nextPane.pane_id)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <TerminalView
          key={mountKeyForPane(activePaneId)}
          paneId={activePaneId}
          terminalTheme={terminalTheme}
          terminalFontFamily={terminalFontFamily}
          terminalFontScale={terminalFontScale}
          mobileShortcuts={mobileShortcuts}
          mobileSideShortcuts={mobileSideShortcuts}
          visible={visible}
          mobileInputTarget={mobileInputTarget}
          onActivateTerminalSurface={onActivateTerminalSurface}
          composerOpen={composerOpen}
          onComposerOpenChange={onComposerOpenChange}
          agentHistoryOpen={agentHistoryOpen}
          onAgentHistoryOpenChange={onAgentHistoryOpenChange}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          zenMode={zenMode}
          onExitZenMode={onExitZenMode}
        />
      </div>
    );
  }

  const area = layout.area;
  const areaWidth = Math.max(1, area.width);
  const areaHeight = Math.max(1, area.height);
  const startPaneResize = (
    e: React.PointerEvent<HTMLDivElement>,
    split: PaneLayoutSplitSnapshot,
  ) => {
    if (e.button !== 0) return;
    const container = layoutRef.current;
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();

    const bounds = container.getBoundingClientRect();
    const horizontal = split.direction === "right";
    const startAxis = horizontal ? e.clientX : e.clientY;
    const pointerPerpendicular = horizontal
      ? area.y +
        ((e.clientY - bounds.top) / Math.max(1, bounds.height)) * areaHeight
      : area.x +
        ((e.clientX - bounds.left) / Math.max(1, bounds.width)) * areaWidth;
    const splitPixelSize = horizontal
      ? (split.rect.width / areaWidth) * bounds.width
      : (split.rect.height / areaHeight) * bounds.height;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    // Capture the pointer so pointerup still reaches the window (and restores
    // cursor/user-select) even when released outside the browser window.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; window listeners still apply.
    }

    const finish = (event: PointerEvent) => {
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;

      const endAxis = horizontal ? event.clientX : event.clientY;
      const deltaPx = endAxis - startAxis;
      if (Math.abs(deltaPx) < 4) return;
      const dragSign = deltaPx > 0 ? 1 : -1;
      const target = resizeTargetForSplit(
        layout,
        split,
        dragSign,
        pointerPerpendicular,
      );
      if (!target) return;
      const amount = Math.min(
        0.5,
        Math.abs(deltaPx) / Math.max(1, splitPixelSize),
      );
      void store.resizePane(target.paneId, target.direction, amount);
    };
    const cancel = () => {
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
  };

  return (
    <div ref={layoutRef} className="pane-layout" aria-label="Terminal panes">
      {visiblePanes.map((layoutPane) => {
        const rect = layoutPane.rect;
        const isActive = layoutPane.pane_id === activePaneId;
        return (
          <div
            key={mountKeyForPane(layoutPane.pane_id)}
            className={`pane-layout-cell ${isActive ? "is-active" : ""}`}
            data-pane-id={layoutPane.pane_id}
            style={{
              left: `${rectPercent(rect.x, area.x, areaWidth)}%`,
              top: `${rectPercent(rect.y, area.y, areaHeight)}%`,
              width: `${(rect.width / areaWidth) * 100}%`,
              height: `${(rect.height / areaHeight) * 100}%`,
            }}
            onPointerDownCapture={() => {
              if (!isActive) void store.focusPane(layoutPane.pane_id);
            }}
          >
            <TerminalView
              key={mountKeyForPane(layoutPane.pane_id)}
              paneId={layoutPane.pane_id}
              terminalTheme={terminalTheme}
              terminalFontFamily={terminalFontFamily}
              terminalFontScale={terminalFontScale}
              showMobileKeys={isActive}
              mobileShortcuts={mobileShortcuts}
              mobileSideShortcuts={mobileSideShortcuts}
              visible={visible}
              mobileInputTarget={mobileInputTarget}
              onActivateTerminalSurface={onActivateTerminalSurface}
              composerOpen={isActive ? composerOpen : false}
              onComposerOpenChange={isActive ? onComposerOpenChange : undefined}
              agentHistoryOpen={isActive ? agentHistoryOpen : false}
              onAgentHistoryOpenChange={onAgentHistoryOpenChange}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              zenMode={isActive ? zenMode : false}
              onExitZenMode={onExitZenMode}
            />
          </div>
        );
      })}
      {layout.splits.map((split) => {
        const horizontal = split.direction === "right";
        const boundary = splitBoundaryFromPaneRects(layout.panes, split);
        return (
          <div
            key={split.id}
            className={`pane-resize-handle ${horizontal ? "is-vertical" : "is-horizontal"}`}
            style={
              horizontal
                ? {
                    left: `${rectPercent(boundary, area.x, areaWidth)}%`,
                    top: `${rectPercent(split.rect.y, area.y, areaHeight)}%`,
                    height: `${(split.rect.height / areaHeight) * 100}%`,
                  }
                : {
                    top: `${rectPercent(boundary, area.y, areaHeight)}%`,
                    left: `${rectPercent(split.rect.x, area.x, areaWidth)}%`,
                    width: `${(split.rect.width / areaWidth) * 100}%`,
                  }
            }
            onPointerDown={(event) => startPaneResize(event, split)}
            role="separator"
            aria-orientation={horizontal ? "vertical" : "horizontal"}
          />
        );
      })}
    </div>
  );
}

export default function App() {
  useShortcutPreferences();
  const { snapshot: assistantSnapshot } = useAssistantState();
  const s = useStoreSelector(
    (state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionGeneration: state.connectionGeneration,
      lastRefresh: state.lastRefresh,
      layout: state.layout,
      notice: state.notice,
      panes: state.panes,
      pendingFocusWorkspaceId: state.pendingFocusWorkspaceId,
      recentPaneIds: state.recentPaneIds,
      selectedPaneId: state.selectedPaneId,
      status: state.status,
      tabs: state.tabs,
      updateInfo: state.updateInfo,
      updateInstalling: state.updateInstalling,
      workspaces: state.workspaces,
    }),
    shallowEqual,
  );
  const connectionClient = useConnectionClient();
  const { mobile, preferences: layoutPreferences } = useLayoutPreferences();
  useEffect(() => {
    activateTerminalComposerDraftScope(
      s.activeConnectionId,
      s.connectionGeneration,
    );
  }, [s.activeConnectionId, s.connectionGeneration]);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [mobileView, setMobileView] = useState<MobileView>("session");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMounted, setAssistantMounted] = useState(false);
  const [assistantTaskTarget, setAssistantTaskTarget] =
    useState<RangerTaskNotificationTarget | null>(null);
  const consumeAssistantTaskTarget = useCallback(
    () => setAssistantTaskTarget(null),
    [],
  );
  const [assistantFloating, setAssistantFloating] = useState(
    () => roamgateLocalStorage.getItem("assistantPanelMode") !== "fixed",
  );
  const assistantVisible =
    assistantOpen && (!mobile || mobileView === "assistant");
  const assistantDocked = assistantVisible && (mobile || !assistantFloating);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    loadSystemTheme(),
  );
  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;
  const [blackBackground, setBlackBackground] = useState(loadBlackBackground);
  const [accentColor, setAccentColor] = useState<AccentColor>(() =>
    loadAccentColor(),
  );
  const [uiScale, setUiScale] = useState<number>(() => loadUiScale());
  useVisualViewportCssVars(uiScale);
  const [terminalFontScale, setTerminalFontScale] = useState<number>(() =>
    loadTerminalFontScale(),
  );
  const [terminalFontName, setTerminalFontName] = useState<string>(() =>
    loadTerminalFontFamily(),
  );
  const terminalFontFamily = terminalFontFamilyStack(terminalFontName);
  const [mobileTerminalShortcuts, setMobileTerminalShortcuts] =
    useState<MobileTerminalShortcutRows>(loadMobileTerminalShortcuts);
  const [mobileTerminalSideShortcuts, setMobileTerminalSideShortcuts] =
    useState<MobileTerminalSideShortcuts>(loadMobileTerminalSideShortcuts);
  const [terminalThemeSelection, setTerminalThemeSelection] =
    useState<TerminalThemeSelection>(loadTerminalThemeSelection);
  const [customTerminalThemes, setCustomTerminalThemes] = useState<
    CustomTerminalTheme[]
  >(loadCustomTerminalThemes);
  const terminalTheme = useMemo(
    () =>
      resolveTerminalTheme(
        resolvedTheme,
        terminalThemeSelection,
        customTerminalThemes,
        blackBackground,
      ),
    [
      resolvedTheme,
      terminalThemeSelection,
      customTerminalThemes,
      blackBackground,
    ],
  );
  const [zenMode, setZenMode] = useState(loadZenMode);
  const [shortcutCheatSheetOpen, setShortcutCheatSheetOpen] = useState(false);
  const openShortcutCheatSheet = useCallback(
    () => setShortcutCheatSheetOpen(true),
    [],
  );
  const closeShortcutCheatSheet = useCallback(
    () => setShortcutCheatSheetOpen(false),
    [],
  );
  // The sheet is desktop-only; do not let it reappear after a mobile layout.
  useEffect(() => {
    if (mobile) setShortcutCheatSheetOpen(false);
  }, [mobile]);
  const [sidebarHidden, setSidebarHidden] = useState(loadZenMode);
  // What the sidebar was doing before Zen hid it, restored when Zen ends.
  const sidebarBeforeZenRef = useRef(false);
  const [mobileTabSheetOpen, setMobileTabSheetOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [mobileInputTarget, setMobileInputTarget] =
    useState<HTMLDivElement | null>(null);
  useSystemBack(
    mobile && mobileMoreOpen,
    () => setMobileMoreOpen(false),
    "popup",
  );
  useEffect(() => setMobileMoreOpen(false), [mobileView]);
  const terminalComposerScopeKey = JSON.stringify([
    s.activeConnectionId,
    s.connectionGeneration,
  ]);
  useEffect(() => {
    setMobileTabSheetOpen(false);
    setMobileMoreOpen(false);
  }, [mobile, terminalComposerScopeKey]);
  const [openTerminalComposerScopeKey, setOpenTerminalComposerScopeKey] =
    useState<string | null>(null);
  const [paneJumpOpen, setPaneJumpOpen] = useState(false);
  const [paneJumpIndex, setPaneJumpIndex] = useState(0);
  // null keeps the most-recently-used list; a string switches to typed search.
  const [paneJumpSearch, setPaneJumpSearch] = useState<string | null>(null);
  const paneJumpModifierRef = useRef<"ctrlKey" | "altKey" | "metaKey" | null>(
    null,
  );
  const paneJumpIndexRef = useRef(0);
  const paneJumpRoundTripRef = useRef<PaneJumpRoundTrip | null>(null);
  const paneJumpReturnFocusRef = useRef<HTMLElement | null>(null);
  const [inspectorState, setInspectorState] =
    useState<WorkspaceInspectorState | null>(null);
  const inspectorStateRef = useRef<WorkspaceInspectorState | null>(null);
  const resourceUiKey = connectionClientScopeKey(
    connectionClient,
    "resource-ui",
  );
  const {
    annotations,
    scope: annotationScope,
    scopeRef: annotationScopeRef,
    sessionRef: annotationSessionRef,
    read: readAnnotationDraft,
    select: selectAnnotationDraft,
    update: updateAnnotationDraft,
  } = useReviewAnnotationDraft(resourceUiKey);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const reviewState = useReviewState();
  // A review is pinned to its workspace: it shows while that workspace is
  // focused and keeps its place while you are elsewhere.
  // They survive a reload: the same review comes back in each workspace.
  const [reviewPins, setReviewPins] = useState<Record<string, string>>(() =>
    readStoredJson<Record<string, string>>(REVIEW_PINS_KEY, {}),
  );
  // Stepped aside for a menu, switcher or another tab; back on the next
  // workspace change or Option+R.
  const [reviewSuspended, setReviewSuspended] = useState(false);
  // Closed reviews are only hidden: Option+R brings each back as it was.
  const [reviewClosed, setReviewClosed] = useState<ReadonlySet<string>>(
    () => new Set(readStoredJson<string[]>(REVIEW_CLOSED_KEY, [])),
  );
  useEffect(() => {
    writeStoredJson(REVIEW_PINS_KEY, reviewPins);
  }, [reviewPins]);
  useEffect(() => {
    writeStoredJson(REVIEW_CLOSED_KEY, [...reviewClosed]);
  }, [reviewClosed]);
  // The reviews shown lately stay mounted, hidden, with their place,
  // drafts and folds: switching repositories and back loses nothing.
  const [reviewKept, setReviewKept] = useState<readonly string[]>([]);
  const [reviewListOpen, setReviewListOpen] = useState(false);
  const focusedWorkspaceId =
    s.workspaces.find((w) => w.focused)?.workspace_id ?? "";
  const reviewPinKey = makeReviewPinKey(
    s.activeConnectionId ?? "",
    focusedWorkspaceId,
  );
  // A discarded review lets go of its workspace, and so does one opened
  // since from another workspace: Option+R then finds this one's own.
  const pinned = reviewPins[reviewPinKey];
  const pinnedSnapshot = pinned ? reviewState.sessions.get(pinned) : undefined;
  const pinnedSessionId =
    pinned && pinnedSnapshot && pinHolds(reviewPinKey, pinnedSnapshot)
      ? pinned
      : null;
  // Pins of reviews that moved, the stored ones too, are dropped.
  useEffect(() => {
    setReviewPins((pins) => livePins(pins, reviewState.sessions));
  }, [reviewState.sessions]);
  const reviewSessionId =
    reviewSuspended || reviewClosed.has(reviewPinKey) ? null : pinnedSessionId;
  const reviewSnapshot = reviewSessionId
    ? reviewState.sessions.get(reviewSessionId)
    : undefined;
  /**
   * Shows a review, pinned to its workspace (the focused one for a review
   * without one). With `focus`, its workspace is brought forward; else it
   * shows when you get there. Null closes the focused workspace's review.
   */
  const setReviewSessionId = useCallback(
    (sessionId: string | null, focus = false) => {
      const current = store.get();
      const focused =
        current.workspaces.find((w) => w.focused)?.workspace_id ?? "";
      const here = makeReviewPinKey(current.activeConnectionId ?? "", focused);
      setReviewSuspended(false);
      if (sessionId === null) {
        setReviewClosed((closed) => new Set(closed).add(here));
        return;
      }
      const snapshot = getReviewSnapshot(sessionId);
      const workspaceId = snapshot?.session.workspaceId || focused;
      const key = makeReviewPinKey(
        snapshot?.session.connectionId ?? current.activeConnectionId ?? "",
        workspaceId,
      );
      setReviewClosed((closed) => {
        if (!closed.has(key)) return closed;
        const rest = new Set(closed);
        rest.delete(key);
        return rest;
      });
      setReviewPins((pins) => ({ ...pins, [key]: sessionId }));
      setReviewKept((kept) =>
        [sessionId, ...kept.filter((id) => id !== sessionId)].slice(
          0,
          REVIEWS_KEPT,
        ),
      );
      if (focus && workspaceId !== focused)
        void store.focusWorkspace(workspaceId);
    },
    [],
  );
  // Arriving in a workspace shows its pinned review, if any.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on change only
  useEffect(() => {
    setReviewSuspended(false);
  }, [focusedWorkspaceId]);
  useEffect(() => {
    if (annotationsOpen) setAssistantOpen(false);
  }, [annotationsOpen]);
  const [annotationsFloating, setAnnotationsFloating] = useState(
    () => roamgateLocalStorage.getItem("annotationPanelMode") !== "fixed",
  );
  const annotationsDocked = annotationsOpen && (mobile || !annotationsFloating);
  const toggleAnnotationsFloating = () => {
    const next = !annotationsFloating;
    setAnnotationsFloating(next);
    try {
      roamgateLocalStorage.setItem(
        "annotationPanelMode",
        next ? "floating" : "fixed",
      );
    } catch {
      store.notify({
        kind: "error",
        message: "Annotation layout could not be saved",
        detail: "The layout applies until this page reloads.",
      });
    }
  };
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(
    null,
  );
  const [annotationPreferredPaneId, setAnnotationPreferredPaneId] = useState<
    string | undefined
  >();
  const [deliveredPaneId, setDeliveredPaneId] = useState<string | null>(null);
  const [annotationDeliveryBusy, setAnnotationDeliveryBusy] = useState(false);
  const annotationAwaitingFocusRef = useRef<ResourceScope | null>(null);
  const inspectorFocusRequestRef = useRef<{
    state: WorkspaceInspectorState;
    source: Element | null;
  } | null>(null);
  const finishInspectorFocus = useCallback(() => {
    const request = inspectorFocusRequestRef.current;
    if (!request) return;
    if (inspectorStateRef.current !== request.state || !request.state.open) {
      inspectorFocusRequestRef.current = null;
      return;
    }
    const target = document.querySelector<HTMLElement>(
      '.workspace-inspector-tabs [role="tab"][aria-selected="true"]',
    );
    if (focusIfUnchanged(target, request.source)) {
      inspectorFocusRequestRef.current = null;
    }
  }, []);
  const inspectorReturnFocusRef = useRef<HTMLElement | null>(null);
  const pendingInspectorRequestRef = useRef<WorkspaceInspectorRequest | null>(
    null,
  );
  const inspectorStageRef = useRef<HTMLDivElement | null>(null);
  const inspectorResizeFrameRef = useRef<number | null>(null);
  const [activeDiff, setActiveDiff] = useState<ActiveDiffSelection>(
    emptyActiveDiffSelection,
  );
  const [activeFilePreview, setActiveFilePreviewState] =
    useState<ActiveFilePreviewSelection>(emptyActiveFilePreviewSelection);
  const setActiveFilePreview = useCallback(
    (selection: ActiveFilePreviewSelection) => {
      const scope = inspectorStateRef.current?.scope;
      if (scope && selection.entry) {
        writeResourceFileSelection(
          roamgateLocalStorage,
          scope,
          selection.entry.path,
        );
      }
      setActiveFilePreviewState(selection);
    },
    [],
  );
  const fileQuickOpenRequestRef = useRef(0);
  const resourceRuntimeKeyRef = useRef(resourceUiKey);
  const focusedWorkspace = s.workspaces.find((w) => w.focused);
  const focusedWorkspaceTabCount = focusedWorkspace
    ? s.tabs.filter((tab) => tab.workspace_id === focusedWorkspace.workspace_id)
        .length
    : 0;
  // Another pane in the focused workspace has an agent blocked on the user.
  const focusedWorkspaceAttention = focusedWorkspace
    ? s.panes.some(
        (pane) =>
          pane.workspace_id === focusedWorkspace.workspace_id &&
          !pane.focused &&
          agentStateKind(pane.agent_status) === "blocked",
      )
    : false;
  useEffect(() => {
    // Drop mobile-only controls when their context disappears so they cannot
    // stay active invisibly or resurface when the mobile layout returns.
    if (!mobile) setMobileTabSheetOpen(false);
    if (!mobile) setMobileMoreOpen(false);
    if (!mobile) setOpenTerminalComposerScopeKey(null);
  }, [mobile, focusedWorkspace]);
  useEffect(() => {
    setOpenTerminalComposerScopeKey(null);
  }, [terminalComposerScopeKey]);
  const activePaneId = activePaneIdForSnapshot(s);
  const activePane = activePaneId
    ? s.panes.find((pane) => pane.pane_id === activePaneId)
    : undefined;
  const activeTerminalComposerDraftKey =
    activePaneId && activePane?.terminal_id
      ? terminalComposerDraftKey(
          s.activeConnectionId,
          s.connectionGeneration,
          activePaneId,
        )
      : null;
  const terminalComposerOpen =
    mobile &&
    openTerminalComposerScopeKey === terminalComposerScopeKey &&
    activeTerminalComposerDraftKey !== null;
  const setTerminalComposerOpen = useCallback(
    (open: boolean) => {
      setOpenTerminalComposerScopeKey(open ? terminalComposerScopeKey : null);
    },
    [terminalComposerScopeKey],
  );
  const connectionSessions = useConnectionSessions();
  const paneJumpScope = usePaneJumpScope();
  // Most-recent-first workspaces across every connection, for the switcher.
  // Kept in this browser so a reload still goes back where you were.
  const [workspaceHistory, setWorkspaceHistory] =
    useState<readonly string[]>(readWorkspaceHistory);
  useEffect(() => {
    try {
      roamgateLocalStorage.setItem(
        WORKSPACE_HISTORY_STORAGE_KEY,
        JSON.stringify(workspaceHistory),
      );
    } catch {
      /* The switcher still works for this page without storage. */
    }
  }, [workspaceHistory]);
  const visitWorkspace = useCallback(
    (connectionId: string, workspaceId: string) =>
      setWorkspaceHistory((history) =>
        recordWorkspaceVisit(
          history,
          workspaceHistoryKey(connectionId, workspaceId),
        ),
      ),
    [],
  );
  const visitedWorkspaceId = activePane?.workspace_id;
  useEffect(() => {
    if (!visitedWorkspaceId) return;
    const connectionId = s.activeConnectionId;
    // Switching connections first shows the workspace that connection last
    // displayed. Count only a workspace that stays; switcher jumps record
    // their endpoints directly.
    const timer = setTimeout(
      () => visitWorkspace(connectionId, visitedWorkspaceId),
      WORKSPACE_VISIT_SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, [s.activeConnectionId, visitedWorkspaceId, visitWorkspace]);
  const paneJumpOptions = useMemo(() => {
    const snapshot = {
      layout: s.layout,
      panes: s.panes,
      recentPaneIds: s.recentPaneIds,
      tabs: s.tabs,
      workspaces: s.workspaces,
    };
    const history = {
      activeConnectionId: s.activeConnectionId,
      keys: workspaceHistory,
    };
    return paneJumpSearch === null
      ? paneJumpEntries(
          snapshot,
          activePaneId,
          connectionSessions,
          paneJumpScope,
          history,
        )
      : paneSearchEntries(
          snapshot,
          paneJumpSearch,
          activePaneId,
          connectionSessions,
          paneJumpScope,
          history,
        );
  }, [
    activePaneId,
    connectionSessions,
    paneJumpScope,
    paneJumpSearch,
    s.activeConnectionId,
    s.layout,
    s.panes,
    s.recentPaneIds,
    s.tabs,
    s.workspaces,
    workspaceHistory,
  ]);
  const activePaneHasAgent = paneHasAgentHistory(activePane);
  // Saved chat histories follow the open agent panes the connection reports.
  useEffect(() => {
    if (s.status !== "connected" || s.panes.length === 0) return;
    const connectionId = s.activeConnectionId;
    const panes = s.panes.filter(paneHasAgentHistory);
    void agentHistoryCache.then((cache) =>
      cache.pruneAgentHistoryCache(
        connectionId,
        new Set(
          panes.map((pane) =>
            cache.agentHistoryCacheKey(connectionId, pane.pane_id, pane.agent),
          ),
        ),
      ),
    );
  }, [s.activeConnectionId, s.panes, s.status]);
  const activePaneChat =
    usePaneView(s.activeConnectionId, activePane?.pane_id) === "chat";
  const historyInspectorOpen =
    inspectorState?.open === true && inspectorState.view === "history";
  const agentHistoryOpen =
    historyInspectorOpen &&
    (!inspectorState.originPaneId ||
      inspectorState.originPaneId === activePane?.pane_id);
  const inspectorOriginPane = inspectorState?.originPaneId
    ? s.panes.find((pane) => pane.pane_id === inspectorState.originPaneId)
    : undefined;
  const inspectorHistoryPaneCandidate =
    inspectorOriginPane ??
    (inspectorState?.view === "history" && inspectorState.originPaneId
      ? undefined
      : activePane);
  const inspectorWorkspace = inspectorState
    ? resolveWorkspaceForScope(inspectorState.scope, s.workspaces)
    : undefined;
  const inspectorHistoryPane =
    inspectorHistoryPaneCandidate?.workspace_id ===
    inspectorWorkspace?.workspace_id
      ? inspectorHistoryPaneCandidate
      : undefined;
  const annotationStorageKey = annotationScope
    ? annotationDraftStorageKey(annotationScope)
    : null;
  const annotationWorkspace = annotationScope
    ? resolveWorkspaceForScope(annotationScope, s.workspaces)
    : undefined;
  const annotationAgentPanes = useMemo(
    () =>
      reviewAgentPanes(
        s.panes,
        annotationWorkspace?.workspace_id ?? "",
        annotationPreferredPaneId,
      ),
    [annotationPreferredPaneId, annotationWorkspace?.workspace_id, s.panes],
  );
  const commitAnnotations = useCallback(
    (
      update:
        | ReviewAnnotation[]
        | ((current: ReviewAnnotation[]) => ReviewAnnotation[]),
    ) => {
      if (!annotationScope) return;
      updateAnnotationDraft(annotationScope, update);
    },
    [annotationScope, updateAnnotationDraft],
  );
  const setAnnotationDraftScope = useCallback(
    (scope: ResourceScope, open = false, preferredPaneId?: string) => {
      const changed = selectAnnotationDraft(scope);
      setAnnotationsOpen(open);
      if (changed) {
        setFocusedAnnotationId(null);
        setAnnotationPreferredPaneId(preferredPaneId);
        setDeliveredPaneId(null);
        setAnnotationDeliveryBusy(false);
      } else if (preferredPaneId !== undefined) {
        setAnnotationPreferredPaneId(preferredPaneId);
      }
    },
    [selectAnnotationDraft],
  );

  const commitInspectorState = useCallback(
    (next: WorkspaceInspectorState | null) => {
      inspectorStateRef.current = next;
      setInspectorState(next);
    },
    [],
  );
  const updateInspectorState = useCallback(
    (
      update: (
        current: WorkspaceInspectorState | null,
      ) => WorkspaceInspectorState | null,
    ) => {
      const next = update(inspectorStateRef.current);
      inspectorStateRef.current = next;
      setInspectorState(next);
    },
    [],
  );
  const activateTerminalSurface = useCallback(() => {
    setMobileMoreOpen(false);
    updateInspectorState((current) =>
      current && (mobile || current.expanded)
        ? { ...current, open: false }
        : current,
    );
    setAnnotationsOpen(false);
    setMobileView("session");
    if (!mobile) {
      requestAnimationFrame(() => {
        activeTerminalInput(document)?.focus({ preventScroll: true });
      });
    }
  }, [mobile, updateInspectorState]);
  // The phone's Back closes the tab sheet, then returns from Workspaces,
  // Files, Changes, Assistant or Annotations to the session.
  useSystemBack(
    mobileTabSheetOpen,
    () => setMobileTabSheetOpen(false),
    "popup",
  );
  useSystemBack(mobileView !== "session", activateTerminalSurface, "panel");
  const toggleSidebar = useCallback(() => {
    setMobileView("session");
    setSidebarHidden((value) => !value);
  }, []);
  // Entering Zen hides the sidebar; leaving Zen puts it back as it was. In
  // between, the sidebar toggles on its own without disturbing Zen.
  const applyZenMode = useCallback(
    (next: boolean) => {
      if (next === zenMode) return;
      if (next) sidebarBeforeZenRef.current = sidebarHidden;
      setSidebarHidden(next ? true : sidebarBeforeZenRef.current);
      setZenMode(next);
    },
    [sidebarHidden, zenMode],
  );
  const toggleZenMode = useCallback(
    () => applyZenMode(!zenMode),
    [applyZenMode, zenMode],
  );
  const openWorkspaces = useCallback(() => {
    setSidebarHidden(false);
    if (mobile) {
      // Shown now, so the search takes focus within the tap: a phone opens
      // its keyboard only for a focus its user's gesture made.
      flushSync(() => {
        setWorkspaceTreeShown(false);
        setMobileView("workspaces");
      });
      document
        .querySelector<HTMLInputElement>(".workspace-search input")
        ?.focus({ preventScroll: true });
      return;
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".workspace-tree-panel")?.focus();
    });
  }, [mobile]);
  const loadInspectorFilePreview = useCallback(
    (
      workspaceId: string,
      entry: FileExplorerEntry,
      fragment?: string,
      line?: number,
    ) => {
      const requestId = fileQuickOpenRequestRef.current + 1;
      fileQuickOpenRequestRef.current = requestId;
      setActiveFilePreview({
        entry,
        fragment,
        line,
        preview: null,
        loading: true,
        error: null,
      });
      void requestFilePreview(workspaceId, entry.path, {
        client: connectionClient,
        refresh: true,
      })
        .then((preview) => {
          if (
            !connectionClient.isCurrent() ||
            fileQuickOpenRequestRef.current !== requestId
          ) {
            return;
          }
          setActiveFilePreview({
            entry,
            fragment,
            line,
            preview,
            loading: false,
            error: null,
          });
        })
        .catch((error) => {
          if (
            !connectionClient.isCurrent() ||
            fileQuickOpenRequestRef.current !== requestId
          ) {
            return;
          }
          setActiveFilePreview({
            entry,
            fragment,
            line,
            preview: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [connectionClient, setActiveFilePreview],
  );
  const openInspector = useCallback(
    (
      view: InspectorView,
      workspaceId?: string,
      options: OpenInspectorOptions = {},
    ) => {
      const snapshot = store.get();
      const workspace = workspaceId
        ? snapshot.workspaces.find(
            (candidate) => candidate.workspace_id === workspaceId,
          )
        : snapshot.workspaces.find((candidate) => candidate.focused);
      if (!workspace) {
        store.notify({
          kind: "error",
          message: `Cannot open ${
            view === "files"
              ? "Files"
              : view === "changes"
                ? "Changes"
                : view === "commits"
                  ? "Commits"
                  : "History"
          }`,
          detail: "The target workspace is no longer open.",
        });
        return;
      }

      const focusInspector = options.focusInspector ?? true;
      inspectorReturnFocusRef.current =
        focusInspector && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const scope = resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      );
      if (
        !annotationScopeRef.current ||
        annotationScopeRef.current.workspaceId !== scope.workspaceId ||
        !sameResourceOwner(annotationScopeRef.current, scope)
      ) {
        setAnnotationDraftScope(scope, annotationsOpen);
      }
      const current = inspectorStateRef.current;
      const sameOwner = !!current && sameResourceOwner(current.scope, scope);
      const stageWidth = inspectorStageRef.current?.clientWidth ?? 0;
      const preferences = readInspectorPreferences(
        roamgateLocalStorage,
        scope,
        {
          rightSize: stageWidth > 0 ? stageWidth * 0.42 : undefined,
        },
      );
      const dock = sameOwner ? current.dock : preferences.dock;
      const preferredSize = sameOwner
        ? current.size
        : dock === "right"
          ? preferences.rightSize
          : preferences.bottomSize;
      const stageHeight = inspectorStageRef.current?.clientHeight ?? 0;
      const clampToDock =
        (dock === "right" && stageWidth >= 1000) ||
        (dock === "bottom" && stageHeight > 0);
      const size = clampToDock
        ? Math.min(
            preferredSize,
            inspectorMaximumSize(dock, stageWidth, stageHeight),
          )
        : preferredSize;
      const originPane = options.originPaneId
        ? snapshot.panes.find((pane) => pane.pane_id === options.originPaneId)
        : snapshot.panes.find(
            (pane) =>
              pane.workspace_id === workspace.workspace_id && pane.focused,
          );
      const returnTabId =
        originPane?.tab_id ?? workspace.active_tab_id ?? current?.returnTabId;
      const nextState: WorkspaceInspectorState = {
        scope,
        open: true,
        view,
        dock,
        size,
        expanded: sameOwner ? current.expanded : preferences.expanded,
        returnTabId,
        originPaneId: options.originPaneId,
        initialDirectory: options.initialDirectory,
      };

      if (!workspace.focused) void store.focusWorkspace(workspace.workspace_id);
      if (!sameOwner) {
        fileQuickOpenRequestRef.current += 1;
        setActiveDiff(emptyActiveDiffSelection());
        setActiveFilePreview(emptyActiveFilePreviewSelection());
      }
      inspectorFocusRequestRef.current = focusInspector
        ? { state: nextState, source: document.activeElement }
        : null;
      commitInspectorState(nextState);
      writeInspectorPreferences(roamgateLocalStorage, nextState);
      if (mobile) setMobileView(view);
      if (focusInspector) requestAnimationFrame(finishInspectorFocus);

      const selectedPath =
        options.path ??
        (view === "files" && options.initialDirectory === undefined
          ? readResourceFileSelection(roamgateLocalStorage, scope)
          : undefined);
      if (view === "files" && !selectedPath) {
        fileQuickOpenRequestRef.current += 1;
        setActiveFilePreview(emptyActiveFilePreviewSelection());
      }
      if (view !== "files" || !selectedPath) return;
      const entry = options.entry ?? inspectorFileEntry(selectedPath);
      loadInspectorFilePreview(
        workspace.workspace_id,
        entry,
        options.fragment,
        options.line,
      );
    },
    [
      commitInspectorState,
      connectionClient.connectionId,
      finishInspectorFocus,
      loadInspectorFilePreview,
      setActiveFilePreview,
      mobile,
      annotationsOpen,
      annotationScopeRef,
      setAnnotationDraftScope,
    ],
  );
  const openAnnotations = useCallback(
    (workspaceId?: string, preferredPaneId?: string) => {
      const snapshot = store.get();
      const workspace = workspaceId
        ? snapshot.workspaces.find(
            (candidate) => candidate.workspace_id === workspaceId,
          )
        : snapshot.workspaces.find((candidate) => candidate.focused);
      if (!workspace) return;
      const scope = resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      );
      setAnnotationDraftScope(scope, true, preferredPaneId);
      annotationAwaitingFocusRef.current = workspace.focused ? null : scope;
      if (!workspace.focused) void store.focusWorkspace(workspace.workspace_id);
      if (mobile) setMobileView("annotations");
    },
    [connectionClient.connectionId, mobile, setAnnotationDraftScope],
  );
  useEffect(() => startReviewClient(), []);
  useEffect(() => startFrontendFreshness(), []);
  // Cmd+K from the review: the menu goes to other workspaces, so the review
  // steps aside (it is kept; Option+R brings it back).
  useEffect(() => {
    const leave = () => {
      setReviewSuspended(true);
      setReviewListOpen(false);
    };
    window.addEventListener(COMMAND_MENU_OPENING, leave);
    return () => window.removeEventListener(COMMAND_MENU_OPENING, leave);
  }, []);
  useEffect(() => {
    if (!s.activeConnectionId) return;
    void loadReviews(s.activeConnectionId).catch(() => {});
  }, [s.activeConnectionId, s.connectionGeneration]);
  // An agent raised a review: show it here when this tab is on its
  // connection; otherwise it opens once the user switches there.
  useEffect(() => {
    const request = reviewState.openRequest;
    if (!request) return;
    void import("./reviewOpen").then(({ takeOpenRequest }) => {
      const sessionId = takeOpenRequest(request, s.activeConnectionId);
      if (sessionId) setReviewSessionId(sessionId);
    });
  }, [reviewState.openRequest, s.activeConnectionId, setReviewSessionId]);
  const toggleReview = useCallback(async () => {
    if (reviewSessionId) {
      setReviewSessionId(null);
      return;
    }
    if (pinnedSessionId) {
      setReviewSessionId(pinnedSessionId);
      return;
    }
    // Loaded on first use: opening a review is not part of the first paint.
    const { openWorkspaceReview } = await import("./reviewOpen");
    const sessionId = await openWorkspaceReview(reviewState.sessions);
    if (sessionId) setReviewSessionId(sessionId);
  }, [
    reviewSessionId,
    pinnedSessionId,
    reviewState.sessions,
    setReviewSessionId,
  ]);
  // Closing the review (or its list) by any means hands the keys back to the
  // terminal; the removed overlay held the focus.
  const reviewShown = reviewSessionId !== null || reviewListOpen;
  const reviewWasShown = useRef(false);
  // The chat box focused before the review: it gets the focus back, as it
  // was, whatever pane layout it sits in.
  const chatBeforeReview = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest(".review-overlay, .review-list-overlay")
      )
        chatBeforeReview.current = target.closest(".agent-history-composer")
          ? target
          : null;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);
  // On a phone only an agent chat's message box gets it back: a terminal
  // taking the focus would bring the keyboard up over it.
  useEffect(() => {
    if (reviewWasShown.current && !reviewShown)
      requestAnimationFrame(() => {
        const chat = chatBeforeReview.current;
        if (chat?.isConnected && chat.getClientRects().length > 0) {
          chat.focus({ preventScroll: true });
          return;
        }
        const active = document.activeElement;
        if (active && active !== document.body) return;
        const input = activeTerminalInput(document);
        const target = !mobile
          ? input
          : input?.closest(".agent-history-composer")
            ? input
            : Array.from(
                document.querySelectorAll<HTMLElement>(
                  ".agent-history-composer :is(textarea, [contenteditable='true'])",
                ),
              ).find((box) => box.getClientRects().length > 0);
        target?.focus({ preventScroll: true });
      });
    reviewWasShown.current = reviewShown;
  }, [reviewShown, mobile]);
  const toggleReviewRef = useRef(toggleReview);
  toggleReviewRef.current = toggleReview;
  const toggleAnnotations = useCallback(() => {
    if (annotationsOpen && (!mobile || mobileView === "annotations")) {
      setAnnotationsOpen(false);
      if (mobile)
        setMobileView(
          inspectorStateRef.current?.open
            ? inspectorStateRef.current.view
            : "session",
        );
      return;
    }
    openAnnotations();
  }, [annotationsOpen, mobile, mobileView, openAnnotations]);
  const toggleAssistant = useCallback(() => {
    if (assistantVisible) {
      setAssistantOpen(false);
      if (mobile) setMobileView("session");
    } else {
      setAnnotationsOpen(false);
      setAssistantOpen(true);
      setAssistantMounted(true);
      if (mobile) {
        setMobileTabSheetOpen(false);
        setMobileView("assistant");
      }
    }
  }, [assistantVisible, mobile]);
  // The voice card's Open shows Ranger's chat, at its newest answer.
  useEffect(
    () =>
      onAssistantOpenRequest(() => {
        if (!assistantVisible) toggleAssistant();
      }),
    [assistantVisible, toggleAssistant],
  );
  const closeAssistant = () => {
    const source = document.activeElement;
    setAssistantOpen(false);
    if (mobile && mobileView === "assistant") setMobileView("session");
    requestAnimationFrame(() => {
      const terminal = mobile ? null : activeTerminalInput(document);
      focusIfUnchanged(
        terminal ??
          document.querySelector<HTMLElement>(
            mobile ? ".mobile-appbar-more" : ".assistant-entry",
          ),
        source,
      );
    });
  };
  const toggleAssistantFloating = () => {
    const next = !assistantFloating;
    setAssistantFloating(next);
    try {
      roamgateLocalStorage.setItem(
        "assistantPanelMode",
        next ? "floating" : "fixed",
      );
    } catch {
      store.notify({
        kind: "error",
        message: "Ranger layout could not be saved",
      });
    }
  };
  const openAssistantSource = async (source: AssistantSource) => {
    const isCurrent = () =>
      store
        .get()
        .connections.some(
          (connection) =>
            connection.id === source.connection_id &&
            connection.generation === source.runtime_generation &&
            connection.state === "ready",
        );
    try {
      if (!isCurrent())
        throw new Error(
          "This source connection is no longer available. Ask Ranger to read it again.",
        );
      const opened = await store.focusWorkspaceSource({
        connectionId: source.connection_id,
        runtimeGeneration: source.runtime_generation,
        workspaceId: source.workspace_id,
        paneId: source.pane_id,
      });
      if (!opened || !isCurrent())
        throw new Error("This source connection changed while opening it.");
      if (mobile) {
        setAssistantOpen(false);
        setMobileView("session");
      }
    } catch (error) {
      store.notify({
        kind: "error",
        message: "Could not open Ranger source",
        detail: (error as Error).message,
      });
    }
  };
  const reanchorFileAnnotations = useCallback(
    (path: string, text: string) => {
      if (!inspectorState || !connectionClient.isCurrent()) return;
      updateAnnotationDraft(inspectorState.scope, (current) =>
        reanchorFileReviewAnnotations(current, path, text),
      );
    },
    [connectionClient, inspectorState, updateAnnotationDraft],
  );
  const reanchorDiffAnnotations = useCallback(
    (path: string, kind: GitDiffEntry["kind"], patch: string) => {
      if (!inspectorState || !connectionClient.isCurrent()) return;
      updateAnnotationDraft(inspectorState.scope, (current) =>
        reanchorDiffReviewAnnotations(current, path, kind, patch),
      );
    },
    [connectionClient, inspectorState, updateAnnotationDraft],
  );
  const addAnnotation = useCallback(
    (input: NewReviewAnnotation) => {
      if (!inspectorState || !connectionClient.isCurrent()) return;
      const annotation = createReviewAnnotation(input);
      setAnnotationDraftScope(inspectorState.scope, true);
      updateAnnotationDraft(inspectorState.scope, (current) => [
        ...current,
        annotation,
      ]);
      setFocusedAnnotationId(annotation.id);
      setAnnotationsOpen(true);
      if (mobile) setMobileView("annotations");
    },
    [
      connectionClient,
      inspectorState,
      mobile,
      setAnnotationDraftScope,
      updateAnnotationDraft,
    ],
  );
  const closeAnnotations = useCallback(() => {
    setAnnotationsOpen(false);
    if (mobile) {
      setMobileView(
        inspectorStateRef.current?.open
          ? inspectorStateRef.current.view
          : "session",
      );
      return;
    }
    activeTerminalInput(document)?.focus({ preventScroll: true });
  }, [mobile]);
  const clearAnnotations = useCallback(() => {
    commitAnnotations([]);
    setFocusedAnnotationId(null);
    closeAnnotations();
  }, [closeAnnotations, commitAnnotations]);
  const copyFeedback = useCallback(
    async (fallback = false) => {
      const message = compileReviewFeedback(annotations);
      if (!message) {
        store.notify({
          kind: "error",
          message: "Add text to a review comment before delivery",
        });
        return;
      }
      const deliverySession = annotationSessionRef.current;
      setAnnotationDeliveryBusy(true);
      try {
        await copyTextFromUserGesture(message);
        store.notify({
          kind: "success",
          message: fallback
            ? "No agent pane found; feedback copied"
            : "Review feedback copied",
          autoDismissMs: 3000,
        });
      } catch (error) {
        store.notify({
          kind: "error",
          message: "Failed to copy review feedback",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (annotationSessionRef.current === deliverySession)
          setAnnotationDeliveryBusy(false);
      }
    },
    [annotations, annotationSessionRef],
  );
  const sendFeedback = useCallback(
    async (paneId: string | null, submit = false) => {
      const target = annotationAgentPanes.find(
        (pane) => pane.pane_id === paneId,
      );
      if (!target) {
        await copyFeedback(true);
        return;
      }
      const message = compileReviewFeedback(annotations);
      if (!message) {
        store.notify({
          kind: "error",
          message: "Add text to a review comment before delivery",
        });
        return;
      }
      const deliverySession = annotationSessionRef.current;
      setAnnotationDeliveryBusy(true);
      // An agent shown as a chat: pre-filled in its message box, where it
      // shows, rather than in the terminal under it.
      const inChat = !!document.querySelector(
        `.terminal-shell[data-pane-id="${CSS.escape(target.pane_id)}"] .terminal-chat-layer`,
      );
      try {
        if (submit)
          await sendTerminalComposerText(
            connectionClient,
            target.pane_id,
            message,
            true,
          );
        else if (inChat) {
          const key = terminalComposerDraftKey(
            connectionClient.connectionId,
            connectionClient.generation,
            target.pane_id,
          );
          const draft = readTerminalComposerDraft(key).trimEnd();
          writeTerminalComposerDraft(
            key,
            draft ? `${draft}\n\n${message}` : message,
          );
        } else {
          const request = terminalPasteRequest(target.pane_id, message);
          await connectionClient.call(request.method, request.params);
        }
        if (!connectionClient.isCurrent()) return;
        const draftActive =
          deliverySession !== null &&
          annotationSessionRef.current === deliverySession;
        if (draftActive) {
          setDeliveredPaneId(target.pane_id);
          commitAnnotations((current) =>
            removeDeliveredReviewAnnotations(current, annotations),
          );
        }
        store.notify({
          kind: "success",
          message: submit
            ? "Feedback sent to the agent"
            : inChat
              ? "Feedback pre-filled in the chat's message box"
              : "Feedback pre-filled in the agent pane",
          detail: draftActive
            ? submit
              ? undefined
              : "Review the message there, then send it."
            : "Original draft retained because its workspace was left or unloaded, or its connection changed.",
          autoDismissMs: 6000,
        });
      } catch (error) {
        if (!connectionClient.isCurrent()) return;
        store.notify({
          kind: "error",
          message: submit
            ? "Failed to send review feedback"
            : "Failed to pre-fill review feedback",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (annotationSessionRef.current === deliverySession)
          setAnnotationDeliveryBusy(false);
      }
    },
    [
      annotationAgentPanes,
      annotationSessionRef,
      annotations,
      commitAnnotations,
      connectionClient,
      copyFeedback,
    ],
  );
  const goToDeliveredAgent = useCallback(() => {
    if (!deliveredPaneId || !connectionClient.isCurrent()) return;
    const pane = store
      .get()
      .panes.find((candidate) => candidate.pane_id === deliveredPaneId);
    if (!pane || pane.workspace_id !== annotationWorkspace?.workspace_id)
      return;
    activateTerminalSurface();
    void store.focusPane(deliveredPaneId);
  }, [
    activateTerminalSurface,
    annotationWorkspace?.workspace_id,
    connectionClient,
    deliveredPaneId,
  ]);
  const openFileExplorer = useCallback(
    (workspaceId?: string, focusInspector = true) =>
      openInspector("files", workspaceId, { focusInspector }),
    [openInspector],
  );
  const openFileExplorerFile = useCallback(
    (
      workspaceId: string,
      entry: FileExplorerEntry,
      originPaneId?: string,
      fragment?: string,
    ) =>
      openInspector("files", workspaceId, {
        entry,
        path: entry.path,
        originPaneId,
        fragment,
      }),
    [openInspector],
  );
  const openDiffViewer = useCallback(
    (workspaceId?: string, focusInspector = true) =>
      openInspector("changes", workspaceId, { focusInspector }),
    [openInspector],
  );
  const closeInspector = useCallback(() => {
    const current = inspectorStateRef.current;
    if (!current) return;
    const returnFocus = inspectorReturnFocusRef.current;
    inspectorReturnFocusRef.current = null;
    commitInspectorState({ ...current, open: false });
    setMobileView("session");
    const snapshot = store.get();
    const returnTab = current.returnTabId
      ? snapshot.tabs.find((tab) => tab.tab_id === current.returnTabId)
      : undefined;
    const workspace = resolveWorkspaceForScope(
      current.scope,
      snapshot.workspaces,
    );
    const tabId = returnTab?.tab_id ?? workspace?.active_tab_id;
    const restoreControlFocus = () => {
      if (!returnFocus?.isConnected) return;
      requestAnimationFrame(() => returnFocus.focus());
    };
    if (tabId) {
      void Promise.resolve(store.focusTab(tabId)).finally(restoreControlFocus);
    } else {
      restoreControlFocus();
    }
  }, [commitInspectorState]);
  const setAgentHistoryInspectorOpen = useCallback(
    (open: boolean, pane?: Pane) => {
      const current = inspectorStateRef.current;
      if (!open) {
        if (current?.open && current.view === "history") closeInspector();
        return;
      }
      const snapshot = store.get();
      const paneId = pane?.pane_id ?? activePaneIdForSnapshot(snapshot);
      const targetPane = paneId
        ? snapshot.panes.find((candidate) => candidate.pane_id === paneId)
        : undefined;
      if (
        !paneHasAgentHistory(targetPane) ||
        !snapshot.workspaces.some(
          (workspace) => workspace.workspace_id === targetPane.workspace_id,
        )
      ) {
        store.notify({
          kind: "error",
          message: "Cannot open History",
          detail: "Select an active agent pane first.",
        });
        return;
      }
      openInspector("history", targetPane.workspace_id, {
        originPaneId: targetPane.pane_id,
      });
    },
    [closeInspector, openInspector],
  );
  const toggleWorkspaceInspector = useCallback(() => {
    const current = inspectorStateRef.current;
    if (current?.open) {
      closeInspector();
      return;
    }
    const snapshot = store.get();
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.focused,
    );
    if (!workspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    const sameOwner = !!current && sameResourceOwner(current.scope, scope);
    const view = sameOwner
      ? current.view
      : readInspectorPreferences(roamgateLocalStorage, scope).view;
    const historyPaneId =
      sameOwner && current.originPaneId
        ? current.originPaneId
        : activePaneIdForSnapshot(snapshot);
    const historyPane = historyPaneId
      ? snapshot.panes.find((pane) => pane.pane_id === historyPaneId)
      : undefined;
    if (
      view === "history" &&
      (!paneHasAgentHistory(historyPane) ||
        historyPane?.workspace_id !== workspace.workspace_id)
    ) {
      openInspector("files", workspace.workspace_id);
      return;
    }
    openInspector(view, workspace.workspace_id, {
      originPaneId: view === "history" ? historyPane?.pane_id : undefined,
    });
  }, [closeInspector, connectionClient.connectionId, openInspector]);
  const setInspectorExpanded = useCallback(
    (expanded: boolean) => {
      const current = inspectorStateRef.current;
      if (!current) return;
      const next = { ...current, expanded };
      if (inspectorFocusRequestRef.current?.state === current)
        inspectorFocusRequestRef.current.state = next;
      commitInspectorState(next);
      writeInspectorPreferences(roamgateLocalStorage, next);
    },
    [commitInspectorState],
  );
  const keepInspectorForWorkspace = useCallback(
    (workspaceId: string, originPane?: Pane) => {
      const current = inspectorStateRef.current;
      if (!current?.open) {
        activateTerminalSurface();
        return;
      }
      const snapshot = store.get();
      const explicitPane = originPane
        ? snapshot.panes.find(
            (candidate) => candidate.pane_id === originPane.pane_id,
          )
        : undefined;
      const activePaneId = activePaneIdForSnapshot(snapshot);
      const workspacePanes = snapshot.panes.filter(
        (pane) => pane.workspace_id === workspaceId,
      );
      const routedPane =
        explicitPane ??
        workspacePanes.find((pane) => pane.pane_id === activePaneId) ??
        workspacePanes.find((pane) => pane.focused);
      const historyPane = paneHasAgentHistory(routedPane)
        ? routedPane
        : workspacePanes.find(paneHasAgentHistory);
      const view =
        current.view === "history" && !historyPane ? "files" : current.view;
      openInspector(view, workspaceId, {
        focusInspector: false,
        originPaneId:
          explicitPane?.pane_id ??
          (view === "history" ? historyPane?.pane_id : undefined),
      });
    },
    [activateTerminalSurface, openInspector],
  );
  const toggleFileExplorer = useCallback(() => {
    const snapshot = store.get();
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.focused,
    );
    if (!workspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    const current = inspectorStateRef.current;
    if (
      current?.open &&
      current.view === "files" &&
      sameResourceOwner(current.scope, scope)
    ) {
      closeInspector();
      return;
    }
    openFileExplorer(workspace.workspace_id, false);
  }, [closeInspector, connectionClient.connectionId, openFileExplorer]);
  const toggleDiffViewer = useCallback(() => {
    const snapshot = store.get();
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.focused,
    );
    if (!workspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    const current = inspectorStateRef.current;
    if (
      current?.open &&
      current.view === "changes" &&
      sameResourceOwner(current.scope, scope)
    ) {
      closeInspector();
      return;
    }
    openDiffViewer(workspace.workspace_id, false);
  }, [closeInspector, connectionClient.connectionId, openDiffViewer]);
  const handleDiffSelectionChange = useCallback(
    (stateKey: string, selection: ActiveDiffSelection) => {
      const current = inspectorStateRef.current;
      if (!current || resourceStateKey(current.scope) !== stateKey) return;
      setActiveDiff(selection);
    },
    [],
  );
  const handleFilePreviewChange = useCallback(
    (stateKey: string, selection: ActiveFilePreviewSelection) => {
      const current = inspectorStateRef.current;
      if (!current || resourceStateKey(current.scope) !== stateKey) return;
      setActiveFilePreview(selection);
    },
    [setActiveFilePreview],
  );
  const openDiffFileInExplorer = useCallback(
    (entry: ActiveDiffSelection["entry"]) => {
      const current = inspectorStateRef.current;
      if (!entry || !current) return;
      const workspace = resolveWorkspaceForScope(
        current.scope,
        store.get().workspaces,
      );
      if (!workspace) return;
      openFileExplorerFile(
        workspace.workspace_id,
        inspectorFileEntry(entry.path),
      );
    },
    [openFileExplorerFile],
  );
  const browseFilesForPane = useCallback(
    (pane: Pane) => {
      const workspace = store
        .get()
        .workspaces.find(
          (candidate) => candidate.workspace_id === pane.workspace_id,
        );
      if (!workspace) return;
      const root = workspace.worktree?.checkout_path ?? workspace.cwd;
      const initialDirectory = root
        ? relativePathWithinCheckout(root, pane.foreground_cwd ?? pane.cwd)
        : undefined;
      openInspector("files", workspace.workspace_id, {
        originPaneId: pane.pane_id,
        initialDirectory,
      });
    },
    [openInspector],
  );
  const reviewChangesForPane = useCallback(
    (pane: Pane) =>
      openInspector("changes", pane.workspace_id, {
        originPaneId: pane.pane_id,
      }),
    [openInspector],
  );
  const handleTerminalWorkspaceFile = useCallback(
    (request: TerminalWorkspaceFileRequest) => {
      if (
        request.connectionId !== connectionClient.connectionId ||
        request.connectionGeneration !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      openFileExplorerFile(
        request.workspaceId,
        inspectorFileEntry(request.path),
        request.paneId,
      );
    },
    [connectionClient, openFileExplorerFile],
  );
  const openNotificationTarget = useCallback(
    (target: NotificationTarget) => {
      if (isRangerTaskNotificationTarget(target)) {
        setAssistantTaskTarget({ ...target });
        setAnnotationsOpen(false);
        setAssistantOpen(true);
        setAssistantMounted(true);
        if (mobile) setMobileView("assistant");
        return;
      }
      if (!inspectorStateRef.current?.open) activateTerminalSurface();
      setSidebarHidden(false);
      void store.focusTaskNotificationTarget(target);
    },
    [activateTerminalSurface, mobile],
  );
  const handleNoticeAction = useCallback(
    (notice: Notice) => {
      if (notice.actionClipboardText !== undefined) {
        const text = notice.actionClipboardText;
        store.clearNotice();
        void copyTextFromUserGesture(text).then(
          () =>
            store.notify({
              kind: "success",
              message: "Copied to clipboard",
              autoDismissMs: 5000,
            }),
          (error) =>
            store.notify({
              kind: "error",
              message: "Terminal copy failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
        return;
      }
      const rangerTarget = {
        type: "ranger_task",
        taskId: notice.actionRangerTaskId,
        runId: notice.actionRangerRunId,
      };
      const target = isRangerTaskNotificationTarget(rangerTarget)
        ? rangerTarget
        : taskNotificationTargetFromNotice(notice);
      store.clearNotice();
      if (target) openNotificationTarget(target);
    },
    [openNotificationTarget],
  );
  const pendingNotificationRef = useRef<NotificationTarget | null>(null);
  useEffect(() => {
    const activatePending = () => {
      const target = pendingNotificationRef.current;
      const snapshot = store.get();
      if (
        !target ||
        (isRangerTaskNotificationTarget(target)
          ? bridge.status !== "connected"
          : snapshot.status !== "connected" || !snapshot.connections.length)
      )
        return;
      pendingNotificationRef.current = null;
      if (
        !isRangerTaskNotificationTarget(target) &&
        !taskNotificationTargetIsCurrent(snapshot, target)
      )
        return;
      openNotificationTarget(target);
      const notice = store.get().notice;
      if (
        notice &&
        (isRangerTaskNotificationTarget(target)
          ? notice.actionRangerTaskId === target.taskId &&
            notice.actionRangerRunId === target.runId
          : notice.actionConnectionId === target.connectionId &&
            notice.actionRuntimeGeneration === target.runtimeGeneration &&
            notice.actionPaneId === target.paneId)
      ) {
        store.clearNotice();
      }
    };
    const receive = (target: NotificationTarget) => {
      pendingNotificationRef.current = target;
      activatePending();
    };
    const handleSystemNotification = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail;
      if (isNotificationTarget(target)) receive(target);
    };
    const unsubscribe = store.subscribe(activatePending);
    const stopWorkerNotifications =
      listenForTaskNotificationActivation(receive);
    activatePending();
    window.addEventListener(
      TASK_NOTIFICATION_ACTIVATE_EVENT,
      handleSystemNotification,
    );
    return () => {
      unsubscribe();
      stopWorkerNotifications();
      window.removeEventListener(
        TASK_NOTIFICATION_ACTIVATE_EVENT,
        handleSystemNotification,
      );
    };
  }, [openNotificationTarget]);
  useEffect(() => {
    const handleInspectorRequest = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceInspectorRequest>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const workspace = store
        .get()
        .workspaces.find(
          (candidate) => candidate.workspace_id === detail.workspaceId,
        );
      if (!workspace) {
        pendingInspectorRequestRef.current = detail;
        return;
      }
      pendingInspectorRequestRef.current = null;
      openInspector(detail.view, detail.workspaceId);
    };
    window.addEventListener(
      WORKSPACE_INSPECTOR_REQUEST_EVENT,
      handleInspectorRequest,
    );
    return () =>
      window.removeEventListener(
        WORKSPACE_INSPECTOR_REQUEST_EVENT,
        handleInspectorRequest,
      );
  }, [connectionClient, openInspector]);
  useEffect(() => {
    const handleAnnotationRequest = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceAnnotationRequest>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      )
        return;
      const annotation = parseReviewAnnotation(detail.annotation);
      const workspace = store
        .get()
        .workspaces.find(
          (candidate) => candidate.workspace_id === detail.workspaceId,
        );
      if (
        !annotation ||
        annotation.source !== "terminal" ||
        !workspace ||
        !store
          .get()
          .panes.some(
            (pane) =>
              pane.pane_id === annotation.paneId &&
              pane.workspace_id === detail.workspaceId,
          )
      )
        return;
      const scope = resourceScopeForWorkspace(
        connectionClient.connectionId,
        workspace,
      );
      setAnnotationDraftScope(scope, true, annotation.paneId);
      updateAnnotationDraft(scope, (current) =>
        current.some((item) => item.id === annotation.id)
          ? current
          : [...current, annotation],
      );
      setFocusedAnnotationId(annotation.id);
      annotationAwaitingFocusRef.current = workspace.focused ? null : scope;
      if (!workspace.focused) void store.focusWorkspace(workspace.workspace_id);
      if (mobile) setMobileView("annotations");
    };
    window.addEventListener(
      WORKSPACE_ANNOTATION_REQUEST_EVENT,
      handleAnnotationRequest,
    );
    return () =>
      window.removeEventListener(
        WORKSPACE_ANNOTATION_REQUEST_EVENT,
        handleAnnotationRequest,
      );
  }, [
    connectionClient,
    mobile,
    setAnnotationDraftScope,
    updateAnnotationDraft,
  ]);
  useEffect(() => {
    const pending = pendingInspectorRequestRef.current;
    if (!pending) return;
    if (
      pending.connectionId !== connectionClient.connectionId ||
      pending.generation !== connectionClient.generation
    ) {
      pendingInspectorRequestRef.current = null;
      return;
    }
    if (
      !s.workspaces.some(
        (workspace) => workspace.workspace_id === pending.workspaceId,
      )
    ) {
      return;
    }
    pendingInspectorRequestRef.current = null;
    openInspector(pending.view, pending.workspaceId);
  }, [connectionClient, openInspector, s.workspaces]);
  useEffect(() => {
    const handleWorktreeRemoved = (event: Event) => {
      const detail = (event as CustomEvent<WorktreeRemovedTarget>).detail;
      if (
        !detail ||
        detail.connectionId !== connectionClient.connectionId ||
        detail.generation !== connectionClient.generation ||
        !connectionClient.isCurrent()
      ) {
        return;
      }
      const scope = resourceScopeForWorkspace(
        detail.connectionId,
        detail.workspace,
      );
      const resourceKey = resourceOwnerKey(scope);
      clearFileExplorerResourceCache(
        connectionClient,
        resourceKey,
        roamgateLocalStorage,
      );
      clearDiffContentResourceState(resourceStateKey(scope));
      clearDiffViewerResourceCache(
        connectionClient,
        resourceKey,
        roamgateLocalStorage,
      );
      writeResourceFileSelection(roamgateLocalStorage, scope, null);
      const current = inspectorStateRef.current;
      if (!current || !sameResourceOwner(current.scope, scope)) return;
      fileQuickOpenRequestRef.current += 1;
      inspectorReturnFocusRef.current = null;
      commitInspectorState(null);
      setActiveDiff(emptyActiveDiffSelection());
      setActiveFilePreview(emptyActiveFilePreviewSelection());
      setMobileView("session");
    };
    window.addEventListener(WORKTREE_REMOVED_EVENT, handleWorktreeRemoved);
    return () =>
      window.removeEventListener(WORKTREE_REMOVED_EVENT, handleWorktreeRemoved);
  }, [commitInspectorState, connectionClient, setActiveFilePreview]);
  const closePaneJump = useCallback((restoreFocus = false) => {
    const target = paneJumpReturnFocusRef.current;
    const source = document.activeElement;
    paneJumpReturnFocusRef.current = null;
    paneJumpModifierRef.current = null;
    setPaneJumpSearch(null);
    setPaneJumpOpen(false);
    if (restoreFocus && target) {
      // Wait for unmount, without stealing focus from a new user selection.
      requestAnimationFrame(() => {
        if (target.isConnected) focusIfUnchanged(target, source);
      });
    }
  }, []);
  const selectPaneJumpIndex = useCallback(
    (index: number) => {
      const length = paneJumpOptions.length;
      const next = length > 0 ? ((index % length) + length) % length : 0;
      paneJumpIndexRef.current = next;
      setPaneJumpIndex(next);
    },
    [paneJumpOptions.length],
  );
  const activeWorkspaceId = activePane?.workspace_id;
  /** Goes to a switcher entry's pane, remembering the round trip. */
  const jumpToPaneEntry = useCallback(
    (target: PaneJumpEntry | undefined) => {
      const targetPaneId = target ? paneJumpTargetId([target], 0) : null;
      const connectionTarget = target
        ? paneJumpConnectionTarget([target], 0)
        : null;
      // The pane being left, not the entry that stands for it: in workspace
      // scope a workspace leads with the pane it was last used through.
      const departure =
        activePaneId && activeWorkspaceId
          ? {
              connectionId: s.activeConnectionId,
              paneId: activePaneId,
              workspaceId: activeWorkspaceId,
            }
          : null;
      if (target && departure && (targetPaneId || connectionTarget)) {
        const arrival = paneJumpLocation(target, s.activeConnectionId);
        // Remembered so that pressing the shortcut again comes back here.
        paneJumpRoundTripRef.current = { from: departure, to: arrival };
        visitWorkspace(departure.connectionId, departure.workspaceId);
        visitWorkspace(arrival.connectionId, arrival.workspaceId);
      }
      if (targetPaneId) {
        if (!inspectorStateRef.current?.open) setMobileView("session");
        void store.focusPane(targetPaneId);
        return;
      }
      if (connectionTarget) {
        if (!inspectorStateRef.current?.open) setMobileView("session");
        void store.jumpToConnectionPane(
          connectionTarget.connectionId,
          connectionTarget.paneId,
        );
      }
    },
    [activePaneId, activeWorkspaceId, s.activeConnectionId, visitWorkspace],
  );
  const commitPaneJump = useCallback(
    (index = paneJumpIndexRef.current) => {
      closePaneJump(
        !paneJumpTargetId(paneJumpOptions, index) &&
          !paneJumpConnectionTarget(paneJumpOptions, index),
      );
      jumpToPaneEntry(paneJumpOptions[index]);
    },
    [closePaneJump, jumpToPaneEntry, paneJumpOptions],
  );
  // The phone's workspace list searches the way the switcher does.
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  // It opens on the recent list, the switcher's; the whole tree is a tap away.
  const [workspaceTreeShown, setWorkspaceTreeShown] = useState(false);
  const workspaceRecentEntries = useMemo(
    () =>
      mobile && !workspaceTreeShown
        ? paneJumpEntries(
            {
              layout: s.layout,
              panes: s.panes,
              recentPaneIds: s.recentPaneIds,
              tabs: s.tabs,
              workspaces: s.workspaces,
            },
            activePaneId,
            connectionSessions,
            paneJumpScope,
            {
              activeConnectionId: s.activeConnectionId,
              keys: workspaceHistory,
            },
          )
        : null,
    [
      activePaneId,
      connectionSessions,
      mobile,
      paneJumpScope,
      s.activeConnectionId,
      s.layout,
      s.panes,
      s.recentPaneIds,
      s.tabs,
      s.workspaces,
      workspaceHistory,
      workspaceTreeShown,
    ],
  );
  const workspaceSearchResults = useMemo(
    () =>
      mobile && workspaceSearch.trim()
        ? paneSearchEntries(
            {
              layout: s.layout,
              panes: s.panes,
              recentPaneIds: s.recentPaneIds,
              tabs: s.tabs,
              workspaces: s.workspaces,
            },
            workspaceSearch,
            activePaneId,
            connectionSessions,
            "workspaces",
            {
              activeConnectionId: s.activeConnectionId,
              keys: workspaceHistory,
            },
          )
        : null,
    [
      activePaneId,
      connectionSessions,
      mobile,
      s.activeConnectionId,
      s.layout,
      s.panes,
      s.recentPaneIds,
      s.tabs,
      s.workspaces,
      workspaceHistory,
      workspaceSearch,
    ],
  );
  const movePaneJumpSelection = useCallback(
    (delta: number) => {
      selectPaneJumpIndex(paneJumpIndexRef.current + delta);
    },
    [selectPaneJumpIndex],
  );
  const defaultPaneJumpIndex = useCallback(
    () =>
      paneJumpDefaultIndex(
        paneJumpOptions,
        s.activeConnectionId,
        paneJumpRoundTripRef.current,
        paneJumpScope,
      ),
    [paneJumpOptions, paneJumpScope, s.activeConnectionId],
  );
  // Typed search drops the held modifier: releasing it must keep the list open
  // instead of committing the way the recent switcher does.
  const openPaneJumpSearch = useCallback(() => {
    if (paneJumpOptions.length === 0) return;
    paneJumpReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    paneJumpModifierRef.current = null;
    paneJumpIndexRef.current = 0;
    setPaneJumpIndex(0);
    setPaneJumpSearch("");
    setPaneJumpOpen(true);
  }, [paneJumpOptions.length]);
  const changePaneJumpSearch = useCallback((value: string) => {
    paneJumpIndexRef.current = 0;
    setPaneJumpIndex(0);
    setPaneJumpSearch(value);
  }, []);

  useLayoutEffect(() => {
    if (resourceRuntimeKeyRef.current === resourceUiKey) return;
    resourceRuntimeKeyRef.current = resourceUiKey;
    fileQuickOpenRequestRef.current += 1;
    pendingInspectorRequestRef.current = null;
    inspectorReturnFocusRef.current = null;
    commitInspectorState(null);
    setActiveDiff(emptyActiveDiffSelection());
    setActiveFilePreview(emptyActiveFilePreviewSelection());
    annotationAwaitingFocusRef.current = null;
    setAnnotationPreferredPaneId(undefined);
    setAnnotationDeliveryBusy(false);
    setDeliveredPaneId(null);
    setAnnotationsOpen(false);
    setFocusedAnnotationId(null);
    paneJumpReturnFocusRef.current = null;
    setPaneJumpOpen(false);
    setPaneJumpIndex(0);
    setPaneJumpSearch(null);
    setMobileView((current) => (current === "assistant" ? current : "session"));
  }, [commitInspectorState, resourceUiKey, setActiveFilePreview]);

  useEffect(() => {
    store.init();
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const current = inspectorStateRef.current;
    setMobileView(
      annotationsOpen
        ? "annotations"
        : assistantOpen
          ? "assistant"
          : current?.open
            ? current.view
            : "session",
    );
  }, [annotationsOpen, assistantOpen, mobile]);
  useLayoutEffect(() => {
    if (!annotationScope || annotationWorkspace) return;
    selectAnnotationDraft(null);
    annotationAwaitingFocusRef.current = null;
    setAnnotationsOpen(false);
    setFocusedAnnotationId(null);
    setAnnotationPreferredPaneId(undefined);
    setDeliveredPaneId(null);
    setAnnotationDeliveryBusy(false);
    if (mobileView === "annotations") setMobileView("session");
  }, [annotationScope, annotationWorkspace, mobileView, selectAnnotationDraft]);
  useEffect(() => {
    if (!focusedWorkspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      focusedWorkspace,
    );
    const pending = annotationAwaitingFocusRef.current;
    if (
      pending &&
      (pending.workspaceId !== scope.workspaceId ||
        !sameResourceOwner(pending, scope)) &&
      s.pendingFocusWorkspaceId === pending.workspaceId
    )
      return;
    annotationAwaitingFocusRef.current = null;
    const current = annotationScopeRef.current;
    const sameOwner = current && sameResourceOwner(current, scope);
    if (sameOwner && current.workspaceId === scope.workspaceId) return;
    setAnnotationDraftScope(scope, !!sameOwner && annotationsOpen);
  }, [
    annotationsOpen,
    annotationScopeRef,
    connectionClient.connectionId,
    focusedWorkspace,
    s.pendingFocusWorkspaceId,
    resourceUiKey,
    setAnnotationDraftScope,
  ]);
  useEffect(() => {
    if (!annotationScope || !annotationWorkspace) return;
    commitAnnotations((current) =>
      current.map((annotation) => {
        if (annotation.source !== "terminal") return annotation;
        const stale = !s.panes.some(
          (pane) => pane.pane_id === annotation.paneId,
        );
        return stale === !!annotation.stale
          ? annotation
          : { ...annotation, stale };
      }),
    );
  }, [annotationScope, annotationWorkspace, commitAnnotations, s.panes]);
  useLayoutEffect(() => {
    const current = inspectorStateRef.current;
    if (!current?.open || !focusedWorkspace || s.pendingFocusWorkspaceId) {
      return;
    }
    const routedWorkspace = resolveWorkspaceForScope(
      current.scope,
      s.workspaces,
    );
    if (routedWorkspace?.workspace_id === focusedWorkspace.workspace_id) return;
    keepInspectorForWorkspace(focusedWorkspace.workspace_id);
  }, [
    focusedWorkspace,
    keepInspectorForWorkspace,
    s.pendingFocusWorkspaceId,
    s.workspaces,
  ]);
  // Follow tab switches while History is open: the view pins its session to
  // originPaneId, which tab changes never update on their own. Pane focus
  // changes within the same tab keep the current pin.
  const inspectorHistoryTabRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const current = inspectorStateRef.current;
    const workspace =
      current?.open && current.view === "history"
        ? resolveWorkspaceForScope(current.scope, s.workspaces)
        : undefined;
    const activeTabId = workspace?.active_tab_id ?? null;
    const previousTabId = inspectorHistoryTabRef.current;
    inspectorHistoryTabRef.current = activeTabId;
    if (!current?.open || current.view !== "history" || !workspace) return;
    if (s.pendingFocusWorkspaceId) return;
    const originMissing =
      !!current.originPaneId &&
      !s.panes.some((pane) => pane.pane_id === current.originPaneId);
    const tabSwitched =
      previousTabId !== null &&
      activeTabId !== null &&
      previousTabId !== activeTabId;
    if (!originMissing && !tabSwitched) return;
    const workspacePanes = s.panes.filter(
      (pane) => pane.workspace_id === workspace.workspace_id,
    );
    const activePaneId = activePaneIdForSnapshot(s);
    const routedPane =
      workspacePanes.find((pane) => pane.pane_id === activePaneId) ??
      workspacePanes.find((pane) => pane.focused);
    const historyPane = paneHasAgentHistory(routedPane)
      ? routedPane
      : workspacePanes.find(paneHasAgentHistory);
    if (!historyPane || historyPane.pane_id === current.originPaneId) return;
    commitInspectorState({ ...current, originPaneId: historyPane.pane_id });
  }, [commitInspectorState, s]);
  // Search keeps the current pane listed for context, but focusing it is a
  // no-op, so selection lands on the first entry a jump can actually reach.
  useEffect(() => {
    if (!paneJumpOpen || paneJumpSearch === null) return;
    if (!paneJumpOptions[paneJumpIndexRef.current]?.current) return;
    const target = paneJumpOptions.findIndex((entry) => !entry.current);
    if (target >= 0) selectPaneJumpIndex(target);
  }, [paneJumpOpen, paneJumpOptions, paneJumpSearch, selectPaneJumpIndex]);
  useEffect(() => {
    if (paneJumpOpen && paneJumpSearch === null && paneJumpOptions.length === 0)
      closePaneJump();
    if (paneJumpIndexRef.current >= paneJumpOptions.length) {
      selectPaneJumpIndex(paneJumpOptions.length - 1);
    }
  }, [
    closePaneJump,
    paneJumpOpen,
    paneJumpOptions.length,
    paneJumpSearch,
    selectPaneJumpIndex,
  ]);
  useLayoutEffect(() => {
    const current = inspectorStateRef.current;
    if (!current) return;
    const workspace = resolveWorkspaceForScope(current.scope, s.workspaces);
    if (!workspace) {
      if (s.status === "connected" && s.lastRefresh > 0) {
        fileQuickOpenRequestRef.current += 1;
        inspectorReturnFocusRef.current = null;
        commitInspectorState(null);
        setActiveDiff(emptyActiveDiffSelection());
        setActiveFilePreview(emptyActiveFilePreviewSelection());
        setMobileView("session");
      }
      return;
    }
    if (workspace.workspace_id === current.scope.workspaceId) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      workspace,
    );
    commitInspectorState({ ...current, scope });
    if (current.view === "files" && activeFilePreview.entry) {
      loadInspectorFilePreview(workspace.workspace_id, activeFilePreview.entry);
    }
  }, [
    activeFilePreview.entry,
    commitInspectorState,
    connectionClient,
    loadInspectorFilePreview,
    setActiveFilePreview,
    s.lastRefresh,
    s.status,
    s.workspaces,
  ]);
  useEffect(() => {
    if (!focusedWorkspace) return;
    const scope = resourceScopeForWorkspace(
      connectionClient.connectionId,
      focusedWorkspace,
    );
    const resourceKey = resourceOwnerKey(scope);
    if (
      !inspectorState?.open ||
      !sameResourceOwner(inspectorState.scope, scope)
    ) {
      void prefetchFileExplorerWorkspace(
        focusedWorkspace.workspace_id,
        connectionClient,
        resourceKey,
      );
    }
    if (
      !inspectorState?.open ||
      !sameResourceOwner(inspectorState.scope, scope)
    ) {
      void prefetchDiffViewerWorkspace(
        focusedWorkspace.workspace_id,
        connectionClient,
        resourceKey,
      );
    }
  }, [connectionClient, focusedWorkspace, inspectorState]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      // The review has its own keys (Esc included); only its own toggles
      // and the ways to another workspace reach the app's shortcuts from
      // inside it. Those put the review away (it is kept) and go on.
      if (
        (e.target as HTMLElement | null)?.closest?.(
          ".review-overlay, .review-list-overlay",
        ) &&
        !shortcutMatches(e, "review.toggle") &&
        !shortcutMatches(e, "reviews.list") &&
        !shortcutMatches(e, "sidebar.toggle")
      ) {
        if (!REVIEW_LEAVING_SHORTCUTS.some((id) => shortcutMatches(e, id)))
          return;
        setReviewSuspended(true);
        setReviewListOpen(false);
      }
      if (
        document.querySelector(
          ".modal-backdrop, .agent-tasks-backdrop, .command-popover, .context-menu",
        ) ||
        document.getElementById(CONFIG_MENU_ID)
      )
        return;
      // Open but not yet rendered: its chunk is loading, so dismiss it here.
      if (
        shortcutCheatSheetOpen &&
        (e.key === "Escape" || shortcutMatches(e, "shortcuts.show"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setShortcutCheatSheetOpen(false);
        return;
      }
      if (paneJumpOpen) {
        const paneJumpNavigationKey =
          e.key === "Tab" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Enter" ||
          e.key === "Escape";
        const paneJumpSearchShortcut = shortcutMatches(e, "panes.search");
        if (paneJumpSearch !== null) {
          if (paneJumpSearchShortcut || paneJumpNavigationKey) {
            e.preventDefault();
            e.stopPropagation();
            if (paneJumpSearchShortcut && e.repeat) return;
            if (paneJumpSearchShortcut || e.key === "Escape")
              closePaneJump(true);
            else if (e.key === "Tab")
              movePaneJumpSelection(e.shiftKey ? -1 : 1);
            else if (e.key === "ArrowDown") movePaneJumpSelection(1);
            else if (e.key === "ArrowUp") movePaneJumpSelection(-1);
            else commitPaneJump();
          } else if (shortcutMatches(e, "panes.recent")) {
            e.preventDefault();
            e.stopPropagation();
            movePaneJumpSelection(e.shiftKey ? -1 : 1);
          }
          // Every other key belongs to the search field, and no workspace
          // shortcut may fire while it has focus.
          return;
        }
        // Keep the opening modifiers held: Ctrl+K on macOS, Ctrl+Alt+K
        // on Windows/Linux, and Shift when cycling backwards.
        if (
          paneJumpSearchShortcut ||
          e.code === "KeyK" ||
          e.key.toLowerCase() === "k"
        ) {
          e.preventDefault();
          e.stopPropagation();
          openPaneJumpSearch();
          return;
        }
        if (paneJumpNavigationKey) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Tab") {
            movePaneJumpSelection(e.shiftKey ? -1 : 1);
          } else if (e.key === "ArrowDown") {
            movePaneJumpSelection(1);
          } else if (e.key === "ArrowUp") {
            movePaneJumpSelection(-1);
          } else if (e.key === "Enter") {
            commitPaneJump();
          } else if (e.key === "Escape") {
            closePaneJump();
          }
          return;
        }
        if (
          !["Control", "Shift", "Alt", "Meta"].includes(e.key) &&
          !shortcutMatches(e, "panes.recent")
        ) {
          closePaneJump();
        }
      }
      const paneJumpShortcut = shortcutMatches(e, "panes.recent");
      if (paneJumpShortcut) {
        if (blocksNavigationShortcuts(e.target)) return;
        if (paneJumpOptions.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (!paneJumpOpen && !e.repeat) {
          paneJumpModifierRef.current = e.ctrlKey
            ? "ctrlKey"
            : e.altKey
              ? "altKey"
              : e.metaKey
                ? "metaKey"
                : null;
          selectPaneJumpIndex(defaultPaneJumpIndex());
          setPaneJumpOpen(true);
        } else if (paneJumpOpen) {
          movePaneJumpSelection(e.shiftKey ? -1 : 1);
        }
        return;
      }
      if (shortcutMatches(e, "panes.search")) {
        if (blocksNavigationShortcuts(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        openPaneJumpSearch();
        return;
      }
      if (shortcutMatches(e, "shortcuts.show")) {
        if (mobile) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setShortcutCheatSheetOpen(true);
        return;
      }
      if (shortcutMatches(e, "terminal.focus")) {
        if (mobile) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) activateTerminalSurface();
        return;
      }
      if (e.key === "Escape") {
        if (
          document.getElementById(CONFIG_MENU_ID) ||
          document.querySelector(
            ".context-menu, .command-popover, .modal-backdrop, .agent-tasks-backdrop",
          )
        ) {
          return;
        }
        const current = store.get();
        const canDismissUpdate =
          current.updateInfo?.update_available && !current.updateInstalling;
        if (current.notice || canDismissUpdate) {
          e.preventDefault();
          e.stopPropagation();
          if (current.notice) store.clearNotice();
          if (canDismissUpdate) store.dismissUpdate();
          return;
        }
        return;
      }
      const tabAction = tabShortcutAction(e);
      if (tabAction) {
        e.preventDefault();
        e.stopPropagation();
        if (
          blocksNavigationShortcuts(e.target) ||
          document.querySelector(".modal-backdrop")
        ) {
          return;
        }
        if (e.repeat && (tabAction === "create" || tabAction === "close")) {
          return;
        }

        const current = store.get();
        const focusedWorkspace = current.workspaces.find(
          (workspace) => workspace.focused,
        );
        if (!focusedWorkspace) return;
        if (tabAction === "create") {
          void store.createTab(focusedWorkspace.workspace_id, {
            numberedLabel: true,
          });
          return;
        }

        const tabs = current.tabs.filter(
          (tab) => tab.workspace_id === focusedWorkspace.workspace_id,
        );
        const tabIds = new Set(tabs.map((tab) => tab.tab_id));
        const activeTabId = [
          focusedWorkspace.active_tab_id,
          current.layout?.tab_id,
          tabs.find((tab) => tab.focused)?.tab_id,
        ].find((tabId): tabId is string => !!tabId && tabIds.has(tabId));
        if (tabAction === "close") {
          const target = closeShortcutTarget(
            activeTabId,
            current.panes,
            activePaneIdForSnapshot(current),
          );
          if (target?.type === "pane") requestClosePane(target.id);
          else if (target?.type === "tab") requestCloseTab(target.id);
          return;
        }

        const targetTabId = adjacentTabId(
          tabs,
          activeTabId,
          tabAction,
          tabPinsFor(current.activeConnectionId),
        );
        if (!targetTabId || targetTabId === activeTabId) return;
        store.focusTab(targetTabId);
        return;
      }
      const pluginAction = pluginActionShortcut(e);
      if (pluginAction) {
        e.preventDefault();
        e.stopPropagation();
        // Typing into the popup's own terminal never reaches here, since
        // isEditableElement stops at the xterm textarea. An agent chat's
        // message box lets it through, as it does the review's.
        if (
          blocksNavigationShortcuts(e.target) ||
          document.querySelector(".modal-backdrop")
        ) {
          return;
        }
        if (e.repeat) return;
        const current = store.get();
        const layoutActivePaneId = activePaneIdForSnapshot(current);
        const activePane = current.panes.find(
          (pane) => pane.pane_id === layoutActivePaneId,
        );
        // Hide-or-open is resolved against Herdr, not this client's popup
        // state, which a Space switch can leave stale. See togglePluginPopup.
        void store.togglePluginPopup(
          pluginAction.pluginId,
          pluginAction.actionId,
          {
            workspace_id: activePane?.workspace_id,
            focused_pane_cwd: activePane?.foreground_cwd ?? activePane?.cwd,
          },
        );
        return;
      }
      const paneAction = paneShortcutAction(e);
      if (paneAction) {
        e.preventDefault();
        e.stopPropagation();
        if (
          blocksNavigationShortcuts(e.target) ||
          document.querySelector(".modal-backdrop")
        ) {
          return;
        }
        if (e.repeat && paneAction.type !== "focus") return;

        const current = store.get();
        const focusedWorkspace = current.workspaces.find((w) => w.focused);
        const activeTab =
          current.tabs.find(
            (tab) => tab.tab_id === focusedWorkspace?.active_tab_id,
          ) ?? current.tabs.find((tab) => tab.focused);
        // Resolve the selection only while it belongs to the visible layout,
        // then fall back to tab-local panes like the command menu does.
        const layoutActivePaneId = activePaneIdForSnapshot(current);
        const activePane =
          current.panes.find((pane) => pane.pane_id === layoutActivePaneId) ??
          current.panes.find(
            (pane) => pane.tab_id === activeTab?.tab_id && pane.focused,
          ) ??
          current.panes.find((pane) => pane.tab_id === activeTab?.tab_id);
        if (!activePane) return;
        if (paneAction.type === "split") {
          void store.splitPane(activePane.pane_id, paneAction.direction);
        } else if (paneAction.type === "zoom") {
          void store.zoomPane(activePane.pane_id);
        } else if (paneAction.type === "move") {
          void store.movePane(activePane.pane_id, paneAction.direction);
        } else {
          void store.focusPaneDirection(
            activePane.pane_id,
            paneAction.direction,
          );
        }
        return;
      }
      const tabIndex = tabShortcutIndex(e);
      if (tabIndex !== null) {
        if (blocksNavigationShortcuts(e.target)) return;
        const current = store.get();
        const focusedWorkspace = current.workspaces.find((w) => w.focused);
        // Number shortcuts address tab-strip positions, pinned tabs first.
        const tabs = orderTabsForDisplay(
          current.tabs.filter(
            (tab) => tab.workspace_id === focusedWorkspace?.workspace_id,
          ),
          tabPinsFor(current.activeConnectionId),
        );
        const targetTab = tabs[tabIndex];
        if (!targetTab) return;
        e.preventDefault();
        e.stopPropagation();
        store.focusTab(targetTab.tab_id);
        return;
      }
      if (isWorkspaceInspectorShortcut(e)) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleWorkspaceInspector();
        return;
      }
      if (shortcutMatches(e, "inspector.expand")) {
        if (mobile || isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const current = inspectorStateRef.current;
        if (!current?.open) toggleWorkspaceInspector();
        setInspectorExpanded(!current?.open || !current.expanded);
        return;
      }
      if (shortcutMatches(e, "annotations.toggle")) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleAnnotations();
        return;
      }
      if (shortcutMatches(e, "reviews.list")) {
        if (blocksNavigationShortcuts(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          // The list steps over the review; the review keeps its place.
          setReviewSuspended(true);
          setReviewListOpen((open) => !open);
        }
        return;
      }
      if (shortcutMatches(e, "review.toggle")) {
        if (blocksNavigationShortcuts(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void toggleReviewRef.current();
        return;
      }
      // Its chord types nothing, so it works from any text box too.
      if (shortcutMatches(e, "assistant.toggle")) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggleAssistant();
        return;
      }
      const fileExplorerShortcut = shortcutMatches(e, "files.toggle");
      if (fileExplorerShortcut) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFileExplorer();
        return;
      }
      const workspacesShortcut = shortcutMatches(e, "workspaces.open");
      if (workspacesShortcut) {
        if (blocksNavigationShortcuts(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        openWorkspaces();
        return;
      }
      const diffViewerShortcut = shortcutMatches(e, "diff.toggle");
      if (diffViewerShortcut) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleDiffViewer();
        return;
      }
      if (shortcutMatches(e, "zen.toggle")) {
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleZenMode();
        return;
      }
      if (
        !shortcutMatches(e, "sidebar.toggle") ||
        blocksNavigationShortcuts(e.target)
      )
        return;
      e.preventDefault();
      toggleSidebar();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const modifier = paneJumpModifierRef.current;
      if (paneJumpOpen && modifier && !e[modifier]) {
        e.preventDefault();
        e.stopPropagation();
        commitPaneJump();
      }
    };
    const onBlur = () => {
      if (paneJumpOpen) closePaneJump();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [
    activateTerminalSurface,
    closePaneJump,
    commitPaneJump,
    defaultPaneJumpIndex,
    movePaneJumpSelection,
    mobile,
    openPaneJumpSearch,
    openWorkspaces,
    paneJumpOpen,
    paneJumpOptions.length,
    paneJumpSearch,
    selectPaneJumpIndex,
    setInspectorExpanded,
    shortcutCheatSheetOpen,
    toggleAnnotations,
    toggleAssistant,
    toggleDiffViewer,
    toggleFileExplorer,
    toggleSidebar,
    toggleWorkspaceInspector,
    toggleZenMode,
  ]);
  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(resolveSystemTheme(event));
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    document.documentElement.dataset.accent = accentColor;
    if (blackBackground) document.documentElement.dataset.black = "";
    else delete document.documentElement.dataset.black;
    document.documentElement.style.zoom =
      uiScale === UI_SCALE_DEFAULT ? "" : String(uiScale / 100);
    if (uiScale === UI_SCALE_DEFAULT) {
      document.documentElement.style.removeProperty("--ui-scale");
    } else {
      document.documentElement.style.setProperty(
        "--ui-scale",
        String(uiScale / 100),
      );
    }
    // Radix positions popovers using getBoundingClientRect. Some engines
    // return pre-zoom layout px instead of visual viewport px under CSS
    // zoom, which breaks the static 1/zoom portal compensation. Measure the
    // actual ratio and compensate with it so anchoring works either way.
    const zoomProbe = document.createElement("div");
    zoomProbe.style.cssText =
      "position:fixed;top:100px;left:0;width:1px;height:1px;pointer-events:none;visibility:hidden";
    document.body.append(zoomProbe);
    const zoomRectRatio = zoomProbe.getBoundingClientRect().top / 100;
    zoomProbe.remove();
    if (zoomRectRatio > 0) {
      document.documentElement.style.setProperty(
        "--popover-portal-zoom",
        String(1 / zoomRectRatio),
      );
      document.documentElement.style.setProperty(
        "--popover-content-zoom",
        String(zoomRectRatio),
      );
    } else {
      document.documentElement.style.removeProperty("--popover-portal-zoom");
      document.documentElement.style.removeProperty("--popover-content-zoom");
    }
  }, [accentColor, blackBackground, resolvedTheme, theme, uiScale]);
  useEffect(() => {
    roamgateLocalStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      BLACK_BACKGROUND_KEY,
      serializeBlackBackground(blackBackground),
    );
  }, [blackBackground]);
  useEffect(() => {
    roamgateLocalStorage.setItem(ACCENT_COLOR_KEY, accentColor);
  }, [accentColor]);
  useEffect(() => {
    roamgateLocalStorage.setItem(UI_SCALE_KEY, String(uiScale));
  }, [uiScale]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      TERMINAL_FONT_SCALE_KEY,
      String(terminalFontScale),
    );
  }, [terminalFontScale]);
  useEffect(() => {
    roamgateLocalStorage.setItem(TERMINAL_FONT_FAMILY_KEY, terminalFontName);
  }, [terminalFontName]);
  useEffect(() => {
    roamgateLocalStorage.setItem(ZEN_MODE_KEY, serializeZenMode(zenMode));
  }, [zenMode]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalShortcutRows(mobileTerminalShortcuts),
    );
  }, [mobileTerminalShortcuts]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY,
      serializeMobileTerminalSideShortcuts(mobileTerminalSideShortcuts),
    );
  }, [mobileTerminalSideShortcuts]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      TERMINAL_THEME_SELECTION_STORAGE_KEY,
      serializeTerminalThemeSelection(terminalThemeSelection),
    );
  }, [terminalThemeSelection]);
  useEffect(() => {
    roamgateLocalStorage.setItem(
      CUSTOM_TERMINAL_THEMES_STORAGE_KEY,
      serializeCustomTerminalThemes(customTerminalThemes),
    );
  }, [customTerminalThemes]);
  useEffect(
    () =>
      subscribeLocalStorage((key) => {
        if (key === null || key === THEME_KEY) setTheme(loadTheme());
        if (key === null || key === BLACK_BACKGROUND_KEY)
          setBlackBackground(loadBlackBackground());
        if (key === null || key === ACCENT_COLOR_KEY)
          setAccentColor(loadAccentColor());
        if (key === null || key === UI_SCALE_KEY) setUiScale(loadUiScale());
        if (
          key === null ||
          key === TERMINAL_FONT_SCALE_KEY ||
          key === UI_SCALE_KEY
        )
          setTerminalFontScale(loadTerminalFontScale());
        if (key === null || key === TERMINAL_FONT_FAMILY_KEY)
          setTerminalFontName(loadTerminalFontFamily());
        if (key === null || key === ZEN_MODE_KEY) applyZenMode(loadZenMode());
        if (key === null || key === "sidebarWidth")
          setSidebarWidth(loadSidebarWidth());
        if (key === null || key === "annotationPanelMode")
          setAnnotationsFloating(
            roamgateLocalStorage.getItem("annotationPanelMode") !== "fixed",
          );
        if (key === null || key === "assistantPanelMode")
          setAssistantFloating(
            roamgateLocalStorage.getItem("assistantPanelMode") !== "fixed",
          );
        if (
          key === null ||
          key === MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY ||
          key === LEGACY_MOBILE_TERMINAL_SHORTCUTS_STORAGE_KEY
        )
          setMobileTerminalShortcuts(loadMobileTerminalShortcuts());
        if (key === null || key === MOBILE_TERMINAL_SIDE_SHORTCUTS_STORAGE_KEY)
          setMobileTerminalSideShortcuts(loadMobileTerminalSideShortcuts());
        if (key === null || key === TERMINAL_THEME_SELECTION_STORAGE_KEY)
          setTerminalThemeSelection(loadTerminalThemeSelection());
        if (key === null || key === CUSTOM_TERMINAL_THEMES_STORAGE_KEY)
          setCustomTerminalThemes(loadCustomTerminalThemes());
      }),
    [applyZenMode],
  );
  useEffect(
    () =>
      subscribeLocalStorage((key) => {
        const current = inspectorStateRef.current;
        if (
          !current ||
          (key !== null && key !== preferencesStorageKey(current.scope))
        )
          return;
        const preferences = readInspectorPreferences(
          roamgateLocalStorage,
          current.scope,
        );
        const dock = preferences.dock;
        const preferredSize =
          dock === "right" ? preferences.rightSize : preferences.bottomSize;
        const stage = inspectorStageRef.current;
        const size =
          stage &&
          ((dock === "right" && stage.clientWidth >= 1000) ||
            (dock === "bottom" && stage.clientHeight > 0))
            ? Math.min(
                preferredSize,
                inspectorMaximumSize(
                  dock,
                  stage.clientWidth,
                  stage.clientHeight,
                  annotationsDocked,
                ),
              )
            : preferredSize;
        if (
          current.dock === dock &&
          current.size === size &&
          current.expanded === preferences.expanded
        )
          return;
        // Layout is shared; opening, view, file and focus stay in this tab.
        const next = {
          ...current,
          dock,
          size,
          expanded: preferences.expanded,
        };
        if (inspectorFocusRequestRef.current?.state === current)
          inspectorFocusRequestRef.current.state = next;
        commitInspectorState(next);
      }),
    [annotationsDocked, commitInspectorState],
  );
  const notice = s.notice;
  useEffect(() => {
    if (!notice) return;
    const dismissDelay = noticeAutoDismissDelay(notice);
    if (dismissDelay === null) return;
    const noticeId = notice.id;
    const timer = window.setTimeout(() => {
      if (store.get().notice?.id === noticeId) store.clearNotice();
    }, dismissDelay);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    // Hiding/showing the sidebar snaps `.body`'s grid columns instantly (no
    // CSS transition), which grows or shrinks every terminal in the tab by
    // exactly the sidebar's width in one frame. The ResizeObserver that
    // normally drives this still fires, but its resize RPC is debounced for
    // window-drag bursts, so the newly revealed columns sit blank (the
    // terminal's own background) until that debounce elapses and the server
    // streams a redrawn frame — a black bar the width of the sidebar. Route
    // this discrete toggle through the same immediate-resize signal used for
    // mobile/desktop layout switches instead.
    window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
  }, [sidebarHidden]);
  // The review opens beside the workspace list when it is shown, not over it.
  useLayoutEffect(() => {
    const sidebar = document.querySelector(".body > .sidebar");
    // Past the resize handle that follows it.
    const left =
      sidebarHidden || mobile || !sidebar
        ? 0
        : Math.round(sidebar.getBoundingClientRect().right) + 6;
    document.documentElement.style.setProperty(
      "--review-inset-left",
      `${left}px`,
    );
  }, [mobile, sidebarHidden, sidebarWidth]);
  useEffect(() => {
    const normalizedWidth = normalizeSidebarWidth(sidebarWidth);
    if (normalizedWidth !== sidebarWidth) {
      setSidebarWidth(normalizedWidth);
      return;
    }
    roamgateLocalStorage.setItem("sidebarWidth", String(normalizedWidth));
  }, [sidebarWidth]);

  const setInspectorView = (view: InspectorView) => {
    const current = inspectorStateRef.current;
    if (!current) return;
    if (view === "history" && !paneHasAgentHistory(inspectorHistoryPane)) {
      return;
    }
    const next = {
      ...current,
      open: true,
      view,
      originPaneId:
        view === "history"
          ? inspectorHistoryPane?.pane_id
          : current.originPaneId,
    };
    commitInspectorState(next);
    writeInspectorPreferences(roamgateLocalStorage, next);
    if (mobile) setMobileView(view);
  };
  const setInspectorDock = (dock: InspectorDock) => {
    const current = inspectorStateRef.current;
    if (!current || current.dock === dock) return;
    const preferences = readInspectorPreferences(
      roamgateLocalStorage,
      current.scope,
    );
    const next = {
      ...current,
      dock,
      size: dock === "right" ? preferences.rightSize : preferences.bottomSize,
      expanded: false,
    };
    commitInspectorState(next);
    writeInspectorPreferences(roamgateLocalStorage, next);
  };
  const clearInspectorDetail = () => {
    const current = inspectorStateRef.current;
    if (current?.view !== "files") {
      setActiveDiff(emptyActiveDiffSelection());
    }
  };
  const resizeInspectorWithKeyboard = (e: React.KeyboardEvent) => {
    const current = inspectorStateRef.current;
    const stage = inspectorStageRef.current;
    if (!current || !stage || current.expanded) return;
    const increase =
      current.dock === "right" ? e.key === "ArrowLeft" : e.key === "ArrowUp";
    const decrease =
      current.dock === "right" ? e.key === "ArrowRight" : e.key === "ArrowDown";
    if (!increase && !decrease) return;
    e.preventDefault();
    const bounds = stage.getBoundingClientRect();
    const minimum =
      (current.dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM) /
      (annotationsDocked ? 2 : 1);
    const maximum = inspectorMaximumSize(
      current.dock,
      bounds.width,
      bounds.height,
      annotationsDocked,
    );
    const next = {
      ...current,
      size: Math.min(
        maximum,
        Math.max(
          minimum,
          Math.min(current.size, maximum) + (increase ? 24 : -24),
        ),
      ),
    };
    commitInspectorState(next);
    writeInspectorPreferences(roamgateLocalStorage, next);
  };
  const startInspectorResize = (e: React.PointerEvent) => {
    const current = inspectorStateRef.current;
    const stage = inspectorStageRef.current;
    if (!current || !stage || current.expanded) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const dock = current.dock;
    const bounds = stage.getBoundingClientRect();
    const maxSize = inspectorMaximumSize(
      dock,
      bounds.width,
      bounds.height,
      annotationsDocked,
    );
    const startSize = Math.min(current.size, maxSize);
    let finalSize = startSize;
    const onMove = (event: PointerEvent) => {
      finalSize = Math.min(
        maxSize,
        Math.max(
          (dock === "right" ? INSPECTOR_MIN_RIGHT : INSPECTOR_MIN_BOTTOM) /
            (annotationsDocked ? 2 : 1),
          startSize +
            (dock === "right"
              ? startX - event.clientX
              : startY - event.clientY),
        ),
      );
      if (inspectorResizeFrameRef.current !== null) return;
      inspectorResizeFrameRef.current = requestAnimationFrame(() => {
        inspectorResizeFrameRef.current = null;
        updateInspectorState((value) =>
          value ? { ...value, size: finalSize } : value,
        );
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (inspectorResizeFrameRef.current !== null) {
        cancelAnimationFrame(inspectorResizeFrameRef.current);
        inspectorResizeFrameRef.current = null;
      }
      const latest = inspectorStateRef.current;
      if (!latest) return;
      const next = { ...latest, size: finalSize };
      commitInspectorState(next);
      writeInspectorPreferences(roamgateLocalStorage, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(
        MAX_SIDEBAR,
        Math.max(MIN_SIDEBAR, startW + (ev.clientX - startX)),
      );
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const assistantEntry = (
    <button
      type="button"
      className={
        mobile
          ? `assistant-entry ${assistantVisible ? "active" : ""}`
          : `topbar-button assistant-entry ${assistantVisible ? "is-active" : ""}`
      }
      title={shortcutTitle("Ranger", "assistant.toggle")}
      aria-label={
        assistantSnapshot?.running ||
        assistantActionExecuting(assistantSnapshot)
          ? "Ranger is working"
          : "Open Ranger"
      }
      aria-pressed={assistantVisible}
      onPointerDown={mobile ? blurActiveInput : undefined}
      onClick={toggleAssistant}
    >
      <Compass size={mobile ? 16 : 15} aria-hidden="true" />
      <span className={mobile ? "mobile-nav-label" : "assistant-entry-label"}>
        Ranger
      </span>
      {assistantSnapshot?.running ||
      assistantActionExecuting(assistantSnapshot) ? (
        <span className="assistant-entry-running" aria-hidden="true" />
      ) : null}
    </button>
  );
  return (
    <div
      className={`app ${sidebarHidden && !mobile ? "sidebar-hidden" : ""} ${
        zenMode && !mobile ? "zen" : ""
      } ${zenMode && mobile ? "phone-zen" : ""} ${mobile && assistantVisible ? "assistant-view" : ""}`}
      data-mobile-more={mobile && mobileMoreOpen ? "open" : undefined}
    >
      <header className="topbar">
        <div className="topbar-start">
          <div className="brand">
            <img
              className="logo"
              src="/roamgate-mark-48.png"
              srcSet="/roamgate-mark-48.png 2x, /roamgate-mark-72.png 3x"
              width={24}
              height={24}
              alt=""
            />
            <span className="brand-title">Roamgate</span>
            <span className="brand-version">v{packageJson.version}</span>
          </div>
          <ConnectionSwitcher />
        </div>
        <div className="topbar-actions">
          {mobile ? null : (
            <div className="topbar-command-group">
              <button
                type="button"
                className={`topbar-button icon-button ${shortcutCheatSheetOpen ? "is-active" : ""}`}
                aria-label="Show shortcut cheat sheet"
                title={shortcutTitle(
                  "Show shortcut cheat sheet",
                  "shortcuts.show",
                )}
                onClick={openShortcutCheatSheet}
              >
                <Command size={15} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="topbar-command-group">
            {!mobile ? assistantEntry : null}
            <CommandCombobox
              key={`${resourceUiKey}:commands`}
              onOpenFileExplorer={openFileExplorer}
              onOpenFile={openFileExplorerFile}
              onOpenDiffViewer={openDiffViewer}
              onShowShortcuts={mobile ? undefined : openShortcutCheatSheet}
            />
            <ConfigMenu
              key={`${resourceUiKey}:config`}
              theme={theme}
              accentColor={accentColor}
              mobileTerminalShortcuts={mobileTerminalShortcuts}
              mobileTerminalSideShortcuts={mobileTerminalSideShortcuts}
              terminalThemeSelection={terminalThemeSelection}
              customTerminalThemes={customTerminalThemes}
              onThemeChange={setTheme}
              blackBackground={blackBackground}
              onBlackBackgroundChange={setBlackBackground}
              onAccentColorChange={setAccentColor}
              uiScale={uiScale}
              onUiScaleChange={setUiScale}
              terminalFontScale={terminalFontScale}
              onTerminalFontScaleChange={setTerminalFontScale}
              terminalFontName={terminalFontName}
              onTerminalFontNameChange={(name) =>
                setTerminalFontName(normalizeTerminalFontFamily(name))
              }
              zenMode={zenMode}
              onZenModeChange={applyZenMode}
              onShowShortcuts={openShortcutCheatSheet}
              onMobileTerminalShortcutsChange={setMobileTerminalShortcuts}
              onMobileTerminalSideShortcutsChange={
                setMobileTerminalSideShortcuts
              }
              onTerminalThemeSelectionChange={setTerminalThemeSelection}
              onCustomTerminalThemesChange={setCustomTerminalThemes}
            />
          </div>
        </div>
      </header>

      {zenMode && !mobile ? (
        <button
          type="button"
          className="zen-island"
          title={shortcutTitle("Exit Zen mode", "zen.toggle")}
          aria-label={shortcutTitle("Exit Zen mode", "zen.toggle")}
          onClick={() => applyZenMode(false)}
        >
          <Minimize2 size={13} />
          <span>Exit Zen</span>
        </button>
      ) : null}

      <MobileTabSheet
        open={mobile && mobileTabSheetOpen}
        onClose={() => setMobileTabSheetOpen(false)}
        onShowSession={activateTerminalSurface}
      />
      {mobile && mobileMoreOpen ? (
        <button
          type="button"
          className="mobile-more-backdrop"
          aria-label="Close more options"
          onClick={() => setMobileMoreOpen(false)}
        />
      ) : null}
      <div
        className="mobile-controls-stack"
        id="mobile-more-options"
        role="region"
        aria-label="More options"
        onClick={(event) => {
          // Choosing a view or tool from the ⋮ menu dismisses it.
          if (
            mobileMoreOpen &&
            (event.target as Element).closest?.("button:not(:disabled)")
          )
            setMobileMoreOpen(false);
        }}
      >
        {mobile && mobileMoreOpen ? (
          <div className="mobile-more-head mobile-popup-head">
            <span>More options</span>
            <CloseButton
              label="Close more options"
              onClick={() => setMobileMoreOpen(false)}
            />
          </div>
        ) : null}
        <nav className="mobile-nav" aria-label="Workspace view switcher">
          <button
            type="button"
            className={mobileView === "commits" ? "active" : ""}
            title="Commits"
            aria-label="Show commit history"
            onClick={() => openInspector("commits")}
          >
            <GitGraph size={16} />
            <span className="mobile-nav-label">Commits</span>
          </button>
          <button
            type="button"
            className={mobileView === "annotations" ? "active" : ""}
            title={shortcutTitle("Annotations", "annotations.toggle")}
            aria-label="Show review annotations"
            aria-pressed={annotationsOpen}
            onClick={toggleAnnotations}
          >
            <MessageSquareText size={16} />
            <span className="mobile-nav-label">
              Annotations
              {annotations.length > 0 ? ` ${annotations.length}` : ""}
            </span>
          </button>
          <button
            type="button"
            className={reviewSessionId !== null ? "active" : ""}
            title={shortcutTitle(
              reviewSessionId !== null
                ? "Close the review"
                : "Review this branch",
              "review.toggle",
            )}
            aria-label={
              reviewSessionId !== null
                ? "Close the review"
                : "Review this branch"
            }
            aria-pressed={reviewSessionId !== null}
            onClick={() => {
              setMobileMoreOpen(false);
              void toggleReview();
            }}
          >
            <GitPullRequestArrow size={16} />
            <span className="mobile-nav-label">Review</span>
          </button>
          <button
            type="button"
            title={shortcutTitle("New tab", "tab.create")}
            aria-label="New tab"
            onClick={() => {
              setMobileMoreOpen(false);
              const workspace = store
                .get()
                .workspaces.find((each) => each.focused);
              if (workspace)
                void store.createTab(workspace.workspace_id, {
                  numberedLabel: true,
                });
            }}
          >
            <SquarePlus size={16} />
            <span className="mobile-nav-label">New tab</span>
          </button>
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={() => {
              setMobileMoreOpen(false);
              openConfiguration();
            }}
          >
            <Settings size={16} />
            <span className="mobile-nav-label">Settings</span>
          </button>
          <button
            type="button"
            className={mobileView === "history" ? "active" : ""}
            title={
              activePaneHasAgent || historyInspectorOpen
                ? "History"
                : "Select an agent pane to view History"
            }
            aria-label="Show agent message history"
            aria-pressed={historyInspectorOpen}
            disabled={!activePaneHasAgent && !historyInspectorOpen}
            onClick={() => {
              if (historyInspectorOpen && mobileView !== "history") {
                setMobileView("history");
              } else {
                setAgentHistoryInspectorOpen(!historyInspectorOpen);
              }
            }}
          >
            <History size={16} />
            <span className="mobile-nav-label">History</span>
          </button>
          {activePaneHasAgent && activePane ? (
            <button
              type="button"
              className={activePaneChat ? "active" : ""}
              title={shortcutTitle(
                activePaneChat ? "Show the terminal" : "Show as a chat",
                "pane.chat",
              )}
              aria-label={
                activePaneChat
                  ? "Show the agent's terminal"
                  : "Show the agent as a chat"
              }
              aria-pressed={activePaneChat}
              onClick={() => {
                togglePaneView(s.activeConnectionId, activePane.pane_id);
                setMobileMoreOpen(false);
                activateTerminalSurface();
              }}
            >
              {activePaneChat ? (
                <SquareTerminal size={16} />
              ) : (
                <MessagesSquare size={16} />
              )}
              <span className="mobile-nav-label">
                {activePaneChat ? "Terminal view" : "Chat view"}
              </span>
            </button>
          ) : null}
          {zenMode ? (
            // Zen hides the top bar and its Settings, where Zen is turned on.
            <button
              type="button"
              aria-label="Exit Zen mode"
              onClick={() => {
                setMobileMoreOpen(false);
                applyZenMode(false);
              }}
            >
              <Minimize2 size={16} />
              <span className="mobile-nav-label">Exit Zen mode</span>
            </button>
          ) : null}
        </nav>
        <nav
          className="mobile-nav mobile-workspace-tools"
          aria-label="Ranger and workspaces"
        >
          {mobile ? assistantEntry : null}
          <button
            type="button"
            className={mobileView === "workspaces" ? "active" : ""}
            title={shortcutTitle("Workspaces", "workspaces.open")}
            aria-label={
              mobileView === "workspaces"
                ? "Hide workspaces"
                : "Show workspaces"
            }
            aria-pressed={mobileView === "workspaces"}
            onPointerDown={blurActiveInput}
            onClick={
              mobileView === "workspaces"
                ? activateTerminalSurface
                : openWorkspaces
            }
          >
            <PanelTop size={17} />
            <span className="mobile-nav-label">Workspaces</span>
          </button>
        </nav>
        <div className="mobile-terminal-controls">
          <nav
            className="mobile-nav mobile-terminal-tools"
            aria-label="Terminal, files, and changes"
          >
            <button
              type="button"
              className={
                mobileView === "session" && !agentHistoryOpen ? "active" : ""
              }
              title="Terminal"
              aria-label="Show terminal session"
              onClick={activateTerminalSurface}
            >
              <SquareTerminal size={16} />
              <span className="mobile-nav-label">Terminal</span>
            </button>
            <button
              type="button"
              className={mobileView === "files" ? "active" : ""}
              title={shortcutTitle("Files", "files.toggle")}
              aria-label="Show workspace files"
              onClick={() => openFileExplorer()}
            >
              <FolderTree size={16} />
              <span className="mobile-nav-label">Files</span>
            </button>
            <button
              type="button"
              className={mobileView === "changes" ? "active" : ""}
              title={shortcutTitle("Changes", "diff.toggle")}
              aria-label="Show workspace changes"
              onClick={() => openDiffViewer()}
            >
              <FileDiff size={16} />
              <span className="mobile-nav-label">Changes</span>
            </button>
          </nav>
        </div>
      </div>

      {s.updateInfo?.update_available || s.notice
        ? createPortal(
            <div className="toast-viewport" aria-live="polite">
              {s.updateInfo?.update_available ? (
                <Toast
                  className={`toast toast-info ${
                    s.updateInstalling ? "toast-loading" : ""
                  }`}
                  role="status"
                  onDismiss={() => store.dismissUpdate()}
                  notificationKey={s.updateInfo.latest_version}
                  dismissDisabled={s.updateInstalling}
                >
                  <ToastMark kind="info" loading={s.updateInstalling} />
                  <div className="toast-content">
                    <strong>
                      Roamgate {s.updateInfo.latest_version} is available
                    </strong>
                    <p>
                      Current {s.updateInfo.current_version}
                      {s.updateInfo.can_auto_update
                        ? " · ready to update and restart"
                        : s.updateInfo.reason
                          ? ` · ${s.updateInfo.reason}`
                          : ""}
                    </p>
                    <div className="toast-actions">
                      {s.updateInfo.can_auto_update ? (
                        <button
                          type="button"
                          className="toast-action primary"
                          onClick={() => store.installUpdate()}
                          disabled={s.updateInstalling}
                        >
                          {s.updateInstalling
                            ? "Updating..."
                            : "Update & restart"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="toast-action"
                        onClick={() => store.dismissUpdate()}
                        disabled={s.updateInstalling}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <CloseButton
                    variant="toast"
                    label="Dismiss update notification"
                    onClick={() => store.dismissUpdate()}
                    disabled={s.updateInstalling}
                  />
                </Toast>
              ) : null}
              {s.notice ? (
                <Toast
                  className={`toast toast-${s.notice.kind} ${
                    s.notice.loading ? "toast-loading" : ""
                  }`}
                  role={s.notice.kind === "error" ? "alert" : "status"}
                  notificationKey={s.notice.id}
                  onDismiss={() => {
                    // Swipes dismiss after their exit animation; keep any
                    // newer notice that replaced this one meanwhile.
                    if (store.get().notice?.id === s.notice?.id)
                      store.clearNotice();
                  }}
                >
                  <ToastMark kind={s.notice.kind} loading={s.notice.loading} />
                  <div className="toast-content">
                    <strong>{s.notice.message}</strong>
                    <NoticeDetail notice={s.notice} />
                    {s.notice.actionLabel &&
                    (s.notice.actionPaneId ||
                      s.notice.actionWorkspaceId ||
                      s.notice.actionClipboardText !== undefined) ? (
                      <div className="toast-actions">
                        <button
                          type="button"
                          className="toast-action primary"
                          onClick={() => handleNoticeAction(s.notice!)}
                        >
                          {s.notice.actionLabel}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <CloseButton
                    variant="toast"
                    label="Dismiss notification"
                    onClick={() => store.clearNotice()}
                  />
                </Toast>
              ) : null}
            </div>,
            document.body,
          )
        : null}

      <div
        className={`body mobile-view-${mobileView}`}
        style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
      >
        <div className="sidebar">
          <div className="sidebar-content">
            {mobile ? (
              <div className="workspace-search">
                <input
                  type="search"
                  aria-label="Search workspaces"
                  placeholder="Search workspaces"
                  autoComplete="off"
                  data-1p-ignore
                  data-bwignore
                  value={workspaceSearch}
                  onChange={(event) =>
                    setWorkspaceSearch(event.currentTarget.value)
                  }
                />
                <button
                  type="button"
                  className={`workspace-tree-toggle${workspaceTreeShown ? " is-active" : ""}`}
                  aria-pressed={workspaceTreeShown}
                  aria-label={
                    workspaceTreeShown
                      ? "Show recent workspaces"
                      : "Show all workspaces"
                  }
                  onClick={() => {
                    setWorkspaceSearch("");
                    setWorkspaceTreeShown((shown) => !shown);
                  }}
                >
                  {workspaceTreeShown ? (
                    <History size={18} aria-hidden="true" />
                  ) : (
                    <ListTree size={18} aria-hidden="true" />
                  )}
                  <span>{workspaceTreeShown ? "Recent" : "All"}</span>
                </button>
              </div>
            ) : null}
            {workspaceSearchResults || workspaceRecentEntries ? (
              <div
                className="pane-jump-list workspace-search-results"
                role="list"
                aria-label={
                  workspaceSearchResults
                    ? "Matching workspaces"
                    : "Recent workspaces"
                }
              >
                {workspaceSearchResults?.length === 0 ? (
                  <p className="pane-jump-empty" role="status">
                    No workspace matches.
                  </p>
                ) : null}
                {(workspaceSearchResults ?? workspaceRecentEntries ?? []).map(
                  (entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      role="listitem"
                      className={`pane-jump-item${entry.current ? " is-current" : ""}`}
                      onClick={() => {
                        setWorkspaceSearch("");
                        if (entry.current) activateTerminalSurface();
                        else jumpToPaneEntry(entry);
                      }}
                    >
                      {entry.agent ? (
                        <span className="pane-jump-agent-identity">
                          <AgentIcon agent={entry.agent} compact />
                          <span
                            className={`pane-jump-status status-${entry.agentStatus ?? "unknown"}`}
                          />
                        </span>
                      ) : null}
                      <span className="pane-jump-text">
                        <span className="pane-jump-title-line">
                          <strong>{entry.title}</strong>
                          {entry.current ? (
                            <span className="pane-jump-current-badge">
                              Current
                            </span>
                          ) : null}
                          {entry.agentStatus ? (
                            <span
                              className={`${agentClass(entry.agentStatus)} pane-jump-agent-status`}
                            >
                              {entry.agentStatus}
                            </span>
                          ) : null}
                        </span>
                        <span className="pane-jump-subtitle">
                          <span className="pane-jump-tab">
                            {entry.tabLabel}
                          </span>
                          {entry.cwd ? (
                            <span className="pane-jump-cwd">
                              {" · "}
                              {entry.cwd}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  ),
                )}
              </div>
            ) : (
              <WorkspaceTree
                agentsFirst={
                  (mobile
                    ? layoutPreferences.mobileSidebarOrder
                    : layoutPreferences.desktopSidebarOrder) === "agents-first"
                }
                key={`${resourceUiKey}:workspaces`}
                onSelect={(workspace) =>
                  keepInspectorForWorkspace(workspace.workspace_id)
                }
                onBrowseFiles={(workspace) =>
                  openFileExplorer(workspace.workspace_id)
                }
                onReviewChanges={(workspace) =>
                  openDiffViewer(workspace.workspace_id)
                }
                onSelectAgent={(pane) =>
                  keepInspectorForWorkspace(pane.workspace_id, pane)
                }
                onBrowseFilesForAgent={browseFilesForPane}
                onReviewChangesForAgent={reviewChangesForPane}
                onViewAgentHistory={(pane) =>
                  setAgentHistoryInspectorOpen(true, pane)
                }
              />
            )}
          </div>
        </div>
        <div
          className="resizer"
          onPointerDown={startResize}
          title="Drag to resize sidebar"
        />
        <main className="main">
          <TabBar
            key={`${resourceUiKey}:tabs`}
            mobile={mobile}
            inspectorOpen={inspectorState?.open === true}
            annotationsOpen={annotationsOpen}
            annotationCount={annotations.length}
            onToggleInspector={toggleWorkspaceInspector}
            onToggleAnnotations={toggleAnnotations}
            reviewOpen={reviewSessionId !== null}
            onToggleReview={() => void toggleReview()}
          />
          <div
            className={`workspace-surfaces ${annotationsDocked ? "has-annotations" : ""} ${assistantDocked ? "has-assistant" : ""}`}
          >
            {reviewListOpen && !reviewSnapshot && s.activeConnectionId ? (
              <Suspense fallback={null}>
                <ReviewList
                  connectionId={s.activeConnectionId}
                  sessions={[...reviewState.sessions.values()].filter(
                    (snapshot) =>
                      snapshot.session.connectionId === s.activeConnectionId,
                  )}
                  onOpen={(sessionId) => {
                    setReviewListOpen(false);
                    setReviewSessionId(sessionId, true);
                  }}
                  onClose={() => {
                    setReviewListOpen(false);
                    // The pinned review comes back from under the list.
                    setReviewSuspended(false);
                  }}
                />
              </Suspense>
            ) : null}
            {s.activeConnectionId &&
            (Object.keys(reviewPins).length || reviewKept.length) ? (
              <Suspense fallback={null}>
                <ReviewHost
                  connectionId={s.activeConnectionId}
                  pinned={[
                    ...new Set([
                      ...Object.entries(reviewPins)
                        .filter(([key]) =>
                          key.startsWith(`${s.activeConnectionId}\n`),
                        )
                        .map(([, id]) => id),
                      ...reviewKept,
                    ]),
                  ].flatMap((id) => {
                    const snapshot = reviewState.sessions.get(id);
                    return snapshot?.session.connectionId ===
                      s.activeConnectionId
                      ? [snapshot]
                      : [];
                  })}
                  shownId={reviewSessionId}
                  panes={s.panes}
                  onClose={() => setReviewSessionId(null)}
                  onShow={(id) => setReviewSessionId(id)}
                  onShowList={() => {
                    setReviewSuspended(true);
                    setReviewListOpen(true);
                  }}
                  onFocusAgentPane={(paneId) => {
                    setReviewSuspended(true);
                    void store.focusPane(paneId);
                  }}
                  onOpenFile={(workspaceId, path, line) => {
                    // The review steps aside; Option+R brings it back.
                    setReviewSuspended(true);
                    openInspector("files", workspaceId, {
                      entry: inspectorFileEntry(path),
                      path,
                      line,
                      focusInspector: true,
                    });
                  }}
                />
              </Suspense>
            ) : null}
            <div
              ref={inspectorStageRef}
              className={`workspace-stage ${
                inspectorState?.open
                  ? `has-inspector inspector-dock-${inspectorState.dock}`
                  : ""
              } ${inspectorState?.open && inspectorState.expanded ? "is-inspector-expanded" : ""}`}
            >
              <div className="workspace-terminal-surface">
                <TerminalPaneLayout
                  mobileInputTarget={mobileInputTarget}
                  onActivateTerminalSurface={activateTerminalSurface}
                  visible={!mobile || mobileView === "session"}
                  terminalTheme={terminalTheme}
                  terminalFontFamily={terminalFontFamily}
                  terminalFontScale={terminalFontScale}
                  mobileShortcuts={mobileTerminalShortcuts}
                  mobileSideShortcuts={mobileTerminalSideShortcuts}
                  composerOpen={terminalComposerOpen}
                  onComposerOpenChange={setTerminalComposerOpen}
                  agentHistoryOpen={agentHistoryOpen}
                  onAgentHistoryOpenChange={setAgentHistoryInspectorOpen}
                  onOpenWorkspaceFile={handleTerminalWorkspaceFile}
                  zenMode={zenMode && !mobile}
                  onExitZenMode={() => applyZenMode(false)}
                />
              </div>
              {inspectorState?.open && !inspectorState.expanded ? (
                <div
                  className="workspace-inspector-resizer"
                  role="separator"
                  aria-label={`Resize ${inspectorState.dock} Inspector`}
                  aria-orientation={
                    inspectorState.dock === "right" ? "vertical" : "horizontal"
                  }
                  tabIndex={0}
                  onKeyDown={resizeInspectorWithKeyboard}
                  onPointerDown={startInspectorResize}
                />
              ) : null}
              {inspectorState ? (
                <div
                  className={`workspace-inspector-slot ${
                    inspectorState.open ? "" : "is-closed"
                  }`}
                  style={
                    inspectorState.expanded
                      ? undefined
                      : inspectorState.dock === "right"
                        ? { width: inspectorState.size }
                        : { height: inspectorState.size }
                  }
                >
                  <Suspense
                    fallback={
                      <TerminalLoadingFallback label="Loading Inspector" />
                    }
                  >
                    <WorkspaceInspectorHost
                      key={`${resourceUiKey}:${resourceOwnerKey(inspectorState.scope)}`}
                      state={inspectorState}
                      onReady={finishInspectorFocus}
                      annotations={readAnnotationDraft(inspectorState.scope)}
                      onCreateAnnotation={addAnnotation}
                      onReanchorFileAnnotations={reanchorFileAnnotations}
                      onReanchorDiffAnnotations={reanchorDiffAnnotations}
                      onEditAnnotation={(id) => {
                        if (!connectionClient.isCurrent()) return;
                        setAnnotationDraftScope(inspectorState.scope, true);
                        setFocusedAnnotationId(id);
                        setAnnotationsOpen(true);
                        if (mobile) setMobileView("annotations");
                      }}
                      visible={!mobile || mobileView === inspectorState.view}
                      workspace={inspectorWorkspace}
                      historyPane={inspectorHistoryPane}
                      fileSelection={activeFilePreview}
                      onSelectFileTab={(path) => {
                        if (inspectorWorkspace)
                          loadInspectorFilePreview(
                            inspectorWorkspace.workspace_id,
                            inspectorFileEntry(path),
                          );
                      }}
                      previewRequestRef={fileQuickOpenRequestRef}
                      diffSelection={activeDiff}
                      connectionClient={connectionClient}
                      onFileSelectionChange={(selection) =>
                        handleFilePreviewChange(
                          resourceStateKey(inspectorState.scope),
                          selection,
                        )
                      }
                      onDiffSelectionChange={(selection) =>
                        handleDiffSelectionChange(
                          resourceStateKey(inspectorState.scope),
                          selection,
                        )
                      }
                      onRefreshFile={() => {
                        if (inspectorWorkspace && activeFilePreview.entry)
                          loadInspectorFilePreview(
                            inspectorWorkspace.workspace_id,
                            activeFilePreview.entry,
                            activeFilePreview.fragment,
                          );
                      }}
                      onOpenDiffFile={openDiffFileInExplorer}
                      onOpenDocument={(path, fragment) => {
                        if (inspectorWorkspace)
                          openFileExplorerFile(
                            inspectorWorkspace.workspace_id,
                            inspectorFileEntry(path),
                            undefined,
                            fragment,
                          );
                      }}
                      onViewChange={setInspectorView}
                      onDockChange={setInspectorDock}
                      onExpandedChange={setInspectorExpanded}
                      onClose={closeInspector}
                      onBack={clearInspectorDetail}
                    />
                  </Suspense>
                </div>
              ) : null}
            </div>
            <AnnotationPanel
              key={annotationStorageKey}
              open={annotationsOpen && !!annotationScope}
              annotations={annotations}
              floating={annotationsFloating && !mobile && !!annotationScope}
              onToggleFloating={mobile ? undefined : toggleAnnotationsFloating}
              agentPanes={annotationAgentPanes}
              preferredPaneId={annotationPreferredPaneId}
              busy={annotationDeliveryBusy}
              focusedAnnotationId={focusedAnnotationId}
              onClose={closeAnnotations}
              onUpdateComment={(id, comment) =>
                commitAnnotations((current) =>
                  current.map((annotation) =>
                    annotation.id === id
                      ? { ...annotation, comment }
                      : annotation,
                  ),
                )
              }
              onDelete={(id) => {
                commitAnnotations((current) =>
                  current.filter((annotation) => annotation.id !== id),
                );
                if (focusedAnnotationId === id) setFocusedAnnotationId(null);
              }}
              onMove={(id, delta) =>
                commitAnnotations((current) =>
                  moveReviewAnnotation(current, id, delta),
                )
              }
              onGoToAgent={
                deliveredPaneId &&
                annotationAgentPanes.some(
                  (pane) => pane.pane_id === deliveredPaneId,
                )
                  ? goToDeliveredAgent
                  : undefined
              }
              onClear={clearAnnotations}
              onCopy={() => void copyFeedback()}
              onSend={(paneId, submit) => void sendFeedback(paneId, submit)}
            />
            {assistantMounted ? (
              <Suspense
                fallback={
                  assistantVisible ? (
                    <aside
                      className={`assistant-panel ${assistantFloating && !mobile ? "is-floating" : ""} ${mobile ? "is-mobile" : ""}`}
                      aria-label="Ranger"
                    >
                      <div className="assistant-panel-empty">
                        Loading Ranger...
                      </div>
                    </aside>
                  ) : null
                }
              >
                <AssistantPanel
                  open={assistantVisible}
                  floating={assistantFloating && !mobile}
                  mobile={mobile}
                  requestedTask={assistantTaskTarget}
                  onRequestedTaskHandled={consumeAssistantTaskTarget}
                  onClose={closeAssistant}
                  onToggleFloating={toggleAssistantFloating}
                  onOpenSource={(source) => void openAssistantSource(source)}
                />
              </Suspense>
            ) : null}
          </div>
        </main>
      </div>
      {mobile ? (
        <MobileBottomBar
          inputRef={setMobileInputTarget}
          tabCount={focusedWorkspaceTabCount}
          attention={focusedWorkspaceAttention}
          tabsOpen={mobileTabSheetOpen}
          moreOpen={mobileMoreOpen}
          onTabsOpenChange={setMobileTabSheetOpen}
          onMoreOpenChange={setMobileMoreOpen}
          chat={activePaneChat}
          workspaces={{
            open: mobileView === "workspaces",
            onToggle:
              mobileView === "workspaces"
                ? activateTerminalSurface
                : openWorkspaces,
          }}
          onToggleChat={
            activePaneHasAgent && activePane
              ? () => {
                  togglePaneView(s.activeConnectionId, activePane.pane_id);
                  activateTerminalSurface();
                }
              : undefined
          }
        />
      ) : null}
      {/* Before the tooltip layer, which shares the modal z-index. */}
      {shortcutCheatSheetOpen && !mobile ? (
        <Suspense fallback={null}>
          <ShortcutCheatSheet onClose={closeShortcutCheatSheet} />
        </Suspense>
      ) : null}
      <GlobalTooltip />
      {viewportDebugEnabled ? <ViewportDebugOverlay /> : null}
      <PopupOverlay
        terminalTheme={terminalTheme}
        terminalFontFamily={terminalFontFamily}
        terminalFontScale={terminalFontScale}
      />
      {paneJumpOpen ? (
        <PaneJumpOverlay
          entries={paneJumpOptions}
          scope={paneJumpScope}
          selectedIndex={paneJumpIndex}
          search={paneJumpSearch}
          onSearchChange={changePaneJumpSearch}
          onSelectIndex={selectPaneJumpIndex}
          onCommit={commitPaneJump}
          onClose={closePaneJump}
        />
      ) : null}
    </div>
  );
}
