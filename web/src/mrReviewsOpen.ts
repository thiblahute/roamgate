import { importWithReload } from "./lazyWithReload";
import type { ShortcutEvent } from "./shortcutBindings";
import { shortcutMatches } from "./shortcutPreferences";
import type { WorkOpen } from "./workOpen";

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
 * The last element focused outside the panel and the menus: Esc gives
 * the focus back there (a chat's message box, a terminal).
 */
let lastFocus: HTMLElement | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest(
          ".mr-reviews-panel, [role='menu'], [role='dialog'], .command-popover",
        )
      )
        lastFocus = target;
    },
    true,
  );

export function focusBeforeMrReviews(): HTMLElement | null {
  return lastFocus?.isConnected ? lastFocus : null;
}

function loadRoot() {
  return importWithReload(
    "mr-reviews",
    () => import("./components/MrReviewsRoot"),
  );
}

/** Opens the board view on the reviews inbox (loaded on first use), or its chat. */
export function openMrReviews(select?: string, view?: "chat") {
  void loadRoot().then((module) =>
    module.showMrReviews(select, undefined, view, undefined, { mode: "mr" }),
  );
}

/** Opens a request's review, through the panel (it asks what it needs). */
export function openMrReviewByKey(key: string) {
  void loadRoot().then((module) =>
    module.showMrReviews(key, key, undefined, undefined, { mode: "mr" }),
  );
}

/**
 * The view's modes: the reviews inbox and the Work board, one panel. Opens
 * the view on a mode (the Work board on an item when given).
 */
export function openBoard(board: { mode: "mr" | "work" } & WorkOpen) {
  void loadRoot().then((module) =>
    module.showMrReviews(undefined, undefined, undefined, undefined, board),
  );
}

/**
 * A mode's shortcut: opens the view on it; open on it, closes the view;
 * open on the other mode, switches.
 */
export function toggleBoard(mode: "mr" | "work") {
  void loadRoot().then((module) => module.toggleMrReviews(mode));
}

/** Opens the view on the inbox, or closes it when it shows the inbox. */
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
