import { importWithReload } from "./lazyWithReload";
import type { ShortcutEvent } from "./shortcutBindings";
import { shortcutMatches } from "./shortcutPreferences";

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

function loadRoot() {
  return importWithReload(
    "mr-reviews",
    () => import("./components/MrReviewsRoot"),
  );
}

/** Opens the reviews panel (loaded on first use). */
export function openMrReviews(select?: string) {
  void loadRoot().then((module) => module.showMrReviews(select));
}

/** Opens the panel, or closes it when it is open. */
export function toggleMrReviews() {
  void loadRoot().then((module) => module.toggleMrReviews());
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
