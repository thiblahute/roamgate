import type { WorkLink } from "../../shared/work";
import { focusBeforeMrReviews, openBoard, toggleBoard } from "./mrReviewsOpen";
import type { ShortcutEvent } from "./shortcutBindings";
import { shortcutMatches } from "./shortcutPreferences";
import type { WorkWorkspace } from "./workScope";

/** The Work entry, in the application menu and the command menu. */
export const WORK_ENTRY = {
  title: "Work",
  detail: "Work items by state: for you, doing, verify, open, done",
  keywords: ["work", "board", "todo", "tasks", "items", "kanban", "for you"],
};

/** The page's hash that opens the board on an item (a notification's link). */
const WORK_HASH = "#roamgate-work=";

/**
 * The last element focused outside the view and the menus: Esc gives the
 * focus back there (a chat's message box, a terminal). The Work board is
 * a mode of the board view: its focus memory is the view's.
 */
export function focusBeforeWork(): HTMLElement | null {
  return focusBeforeMrReviews();
}

/**
 * An item added from a session's chat, as the board's add form starts
 * it: the words quoted, the session that owns and sorts it, the message
 * it came from, and the session's workspace (whose project it lands in).
 */
export type WorkAddDraft = {
  text: string;
  owner: string;
  /** The session's name, for the form's head. */
  ownerName?: string;
  workspace: WorkWorkspace | null;
  links?: WorkLink[];
};

/**
 * What the Work board opens on: an item (a notification's link), the
 * items a session owns (`owner`, a chat's count), or its add form
 * started for a session (`add`).
 */
export type WorkOpen = { item?: string; owner?: string; add?: WorkAddDraft };

/**
 * Opens the board view on the Work board (loaded on first use), on an
 * item, a session's items or an add form when given.
 */
export function openWork(open?: string | WorkOpen) {
  const what = typeof open === "string" ? { item: open } : (open ?? {});
  openBoard({ mode: "work", ...what });
}

/**
 * Opens the view on the Work board; open on it, closes the view; open on
 * the reviews inbox, switches to the Work board.
 */
export function toggleWork() {
  toggleBoard("work");
}

/** The global shortcut (Alt+W), Zen mode included. */
export function handleWorkShortcut(
  event: ShortcutEvent & {
    repeat?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  },
  toggle: () => void = toggleWork,
) {
  if (!shortcutMatches(event, "work.board")) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) toggle();
  return true;
}

/** The item a page's hash names, or null. */
export function workItemInHash(hash = window.location.hash): string | null {
  if (!hash.startsWith(WORK_HASH)) return null;
  const item = decodeURIComponent(hash.slice(WORK_HASH.length)).trim();
  return /^[0-9a-f]{8,16}$/.test(item) ? item : null;
}

/**
 * A notification's link (`/#roamgate-work=ID`) opens the board on the item,
 * on load and when the hash changes while the page shows; the hash is
 * then taken off the address.
 */
export function watchWorkHash(open: (item: string) => void = openWork) {
  const check = () => {
    const item = workItemInHash();
    if (!item) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    open(item);
  };
  check();
  window.addEventListener("hashchange", check);
  return () => window.removeEventListener("hashchange", check);
}
