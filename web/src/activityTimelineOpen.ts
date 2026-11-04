import { importWithReload } from "./lazyWithReload";
import type { ShortcutEvent } from "./shortcutBindings";
import { shortcutMatches } from "./shortcutPreferences";

export type ActivityView = "timeline" | "hours";

/**
 * The one menu entry for the activity timeline, in the application menu and
 * the command menu: its Workspaces, Subjects and Hours tabs are views of it,
 * not entries of their own. Searching for the hours finds it too.
 */
export const ACTIVITY_ENTRY = {
  title: "Activity",
  detail: "Timeline per day: workspaces, subjects, hours to report",
  keywords: [
    "activity",
    "timeline",
    "time",
    "attention",
    "subjects",
    "report",
    "hours",
    "timesheet",
    "olmo",
    "submit",
  ],
};

const HOURS_WORDS = ["hours", "timesheet", "olmo", "submit"];

/** The view a command-menu search means: asking for the hours opens Hours. */
export function activityViewForSearch(search: string): ActivityView {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.some(
    (word) =>
      word.length > 1 &&
      HOURS_WORDS.some((hours) => hours.startsWith(word) || word === hours),
  )
    ? "hours"
    : "timeline";
}

function loadRoot() {
  return importWithReload(
    "activity-timeline",
    () => import("./components/ActivityTimelineRoot"),
  );
}

/**
 * Opens the activity timeline (components/ActivityTimelineRoot.tsx), loaded
 * on first use: from the command menu, the application menu and its shortcut.
 */
export function openActivityTimeline(view: ActivityView = "timeline") {
  void loadRoot().then((module) => module.showActivityTimeline(view));
}

/** Opens the timeline, or closes it when it is already open. */
export function toggleActivityTimeline() {
  void loadRoot().then((module) => module.toggleActivityTimeline());
}

/**
 * The global shortcut (Option+A, Alt+A). It needs nothing on screen, so it
 * works in Zen mode, where the top bar and its menus are hidden.
 */
export function handleActivityShortcut(
  event: ShortcutEvent & {
    repeat?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  },
  toggle: () => void = toggleActivityTimeline,
) {
  if (!shortcutMatches(event, "activity.open")) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) toggle();
  return true;
}
