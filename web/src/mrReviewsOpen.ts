import type { MrDeclarePrefill } from "./components/MrEffortView";
import type { ShortcutEvent } from "./shortcutBindings";
import { shortcutMatches } from "./shortcutPreferences";
import type { WorkOpen } from "./workOpen";
import type { BoardInspectorView } from "./workspaceResource";

/** The Reviews entry, in the application menu and the command menu. */
export const MR_REVIEWS_ENTRY = {
  title: "Reviews",
  detail: "Merge and pull requests to review, from GitLab and GitHub",
  keywords: [
    "reviews",
    "inbox",
    "merge",
    "requests",
    "mr",
    "pull",
    "pr",
    "gitlab",
    "github",
  ],
};

/**
 * The board (the Work board and the reviews inbox) is two of the
 * workspace inspector's tabs, Work and Reviews. Opening it is asking the
 * page for the inspector on that tab (BOARD_INSPECTOR_EVENT), with what
 * to show once there (a request, an item, a chat) kept here until the
 * board takes it.
 */
export type BoardMode = "mr" | "work";
export const BOARD_INSPECTOR_EVENT = "roamgate:board-inspector";
export type BoardInspectorRequest = {
  view: BoardInspectorView;
  /** The shortcut's toggle: shown on that tab, the inspector closes. */
  toggle: boolean;
};

/**
 * What the board opens on: a request selected or opened, the reviews
 * agent's chat or an effort declared; for the Work board an item, a
 * session's items or the add form.
 */
export type BoardOpenRequest = {
  seq: number;
  select?: string;
  open?: string;
  view?: "chat" | "declare";
  declare?: MrDeclarePrefill;
} & WorkOpen;

let pending: BoardOpenRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function boardModeView(mode: BoardMode): BoardInspectorView {
  return mode === "work" ? "work" : "reviews";
}

function requestBoard(
  mode: BoardMode,
  toggle: boolean,
  what?: Omit<BoardOpenRequest, "seq">,
) {
  if (what && Object.values(what).some((value) => value !== undefined)) {
    pending = { seq: ++seq, ...what };
    emit();
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<BoardInspectorRequest>(BOARD_INSPECTOR_EVENT, {
      detail: { view: boardModeView(mode), toggle },
    }),
  );
}

/** What the board was asked to open on, not yet taken. */
export function pendingBoardOpen(): BoardOpenRequest | null {
  return pending;
}

/** Taken by the board (or dropped: no inspector to show it in). */
export function takeBoardOpen(at?: number) {
  if (!pending || (at !== undefined && pending.seq !== at)) return;
  pending = null;
  emit();
}

export function onBoardOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens the Reviews tab on the inbox, or its chat. */
export function openMrReviews(select?: string, view?: "chat") {
  requestBoard("mr", false, { select, view });
}

/** Opens a request's review, through the inbox (it asks what it needs). */
export function openMrReviewByKey(key: string) {
  requestBoard("mr", false, { select: key, open: key });
}

/** The Reviews tab, declaring an upstreaming effort (a menu's home filled in). */
export function openMrDeclare(declare: MrDeclarePrefill) {
  requestBoard("mr", false, { view: "declare", declare });
}

/** Opens the board's tab (the Work board on an item when given). */
export function openBoard(board: { mode: BoardMode } & WorkOpen) {
  const { mode, ...what } = board;
  requestBoard(mode, false, what);
}

/**
 * A tab's shortcut: opens the inspector on it; shown on it, closes the
 * inspector; on another tab, switches.
 */
export function toggleBoard(mode: BoardMode) {
  requestBoard(mode, true);
}

/** Opens the Reviews tab, or closes the inspector when it shows it. */
export function toggleMrReviews() {
  toggleBoard("mr");
}

/** The global shortcut (Option+M, Alt+M), Zen mode included. */
export function handleMrReviewsShortcut(
  event: ShortcutEvent & {
    repeat?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  },
  toggle: () => void = toggleMrReviews,
) {
  if (!shortcutMatches(event, "reviews.inbox")) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) toggle();
  return true;
}

/**
 * A file a request's link names (gx on a path), to show in the Files
 * preview of a workspace: the page takes it once it shows that
 * workspace's connection (the panel jumps there first).
 */
export type MrFileOpen = {
  connectionId: string;
  workspaceId: string;
  path: string;
  at: number;
};
let pendingFile: MrFileOpen | null = null;
const fileListeners = new Set<() => void>();

export function requestMrFileOpen(request: Omit<MrFileOpen, "at">) {
  pendingFile = { ...request, at: Date.now() };
  for (const listener of fileListeners) listener();
}

/** The file asked for on this connection, taken (asked within a minute). */
export function takeMrFileOpen(connectionId: string): MrFileOpen | null {
  const found = pendingFile;
  if (!found || found.connectionId !== connectionId) return null;
  pendingFile = null;
  return Date.now() - found.at < 60_000 ? found : null;
}

export function onMrFileOpen(listener: () => void): () => void {
  fileListeners.add(listener);
  return () => fileListeners.delete(listener);
}
