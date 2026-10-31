import { SHORTCUT_NUMBERS, type ShortcutId } from "./shortcutBindings";

/**
 * Shortcuts that take you to another workspace, tab or pane: from the
 * review they put it away (it is kept) and go on.
 */
export const REVIEW_LEAVING_SHORTCUTS: readonly ShortcutId[] = [
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

/**
 * What a key pressed inside the review does: the review has its own keys
 * (Esc included), so it stays the review's ("review"), unless it is one of
 * the app's shortcuts that work over the review ("app": its own toggles, the
 * sidebar, and the overlay tab, which floats above the review and leaves it
 * in place), or one that goes to another workspace ("leave": the review is
 * put away, then the app's shortcut runs).
 */
export function reviewKeyRoute(
  matches: (id: ShortcutId) => boolean,
  overlayOpen: boolean,
): "review" | "app" | "leave" {
  if (
    matches("review.toggle") ||
    matches("reviews.list") ||
    matches("sidebar.toggle") ||
    matches("overlay.toggle") ||
    // Only while the overlay shows; otherwise the key stays the review's.
    (overlayOpen && matches("overlay.fullscreen"))
  )
    return "app";
  return REVIEW_LEAVING_SHORTCUTS.some(matches) ? "leave" : "review";
}
