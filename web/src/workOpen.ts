import type { WorkLink } from "../../shared/work";
import { openBoard, toggleBoard } from "./mrReviewsOpen";
import { requestOpenAt } from "./reviewOpenAt";
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
 * Opens the inspector's Work tab, on an item, a session's items or an
 * add form when given.
 */
export function openWork(open?: string | WorkOpen) {
  const what = typeof open === "string" ? { item: open } : (open ?? {});
  openBoard({ mode: "work", ...what });
}

/**
 * Opens the inspector on its Work tab; shown there, closes the inspector;
 * on another tab, switches to Work.
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

/** A Work item a link names, and the thread and comment in it to go to. */
export type WorkHashTarget = {
  item: string;
  thread?: string;
  comment?: string;
};

/**
 * The item a page's hash names (`#roamgate-work=ID`, with
 * `&thread=ID&comment=ID` to open it at a comment), or null.
 */
export function workTargetInHash(
  hash = window.location.hash,
): WorkHashTarget | null {
  if (!hash.startsWith(WORK_HASH)) return null;
  const [head = "", ...rest] = hash.slice(WORK_HASH.length).split("&");
  const item = decodeURIComponent(head).trim();
  if (!/^[0-9a-f]{8,16}$/.test(item)) return null;
  const params = new URLSearchParams(rest.join("&"));
  const id = (name: string) => {
    const value = params.get(name)?.trim();
    return value && /^[0-9a-f]{8,32}$/.test(value) ? value : undefined;
  };
  const thread = id("thread");
  const comment = thread ? id("comment") : undefined;
  return {
    item,
    ...(thread ? { thread } : {}),
    ...(comment ? { comment } : {}),
  };
}

/** The item a page's hash names, or null. */
export function workItemInHash(hash = window.location.hash): string | null {
  return workTargetInHash(hash)?.item ?? null;
}

/** Opens the board on an item, at a thread and a comment of it when given. */
export function openWorkAt(target: WorkHashTarget) {
  if (target.thread)
    requestOpenAt({
      thread: target.thread,
      ...(target.comment ? { comment: target.comment } : {}),
    });
  openWork(target.item);
}

/**
 * A notification's link (`/#roamgate-work=ID`) opens the board on the item
 * (at the comment it names), on load and when the hash changes while the
 * page shows; the hash is then taken off the address.
 */
export function watchWorkHash(
  open: (target: WorkHashTarget) => void = openWorkAt,
) {
  const check = () => {
    const target = workTargetInHash();
    if (!target) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    open(target);
  };
  check();
  window.addEventListener("hashchange", check);
  return () => window.removeEventListener("hashchange", check);
}
