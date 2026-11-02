import { importWithReload } from "./lazyWithReload";

/**
 * Opens the activity timeline (components/ActivityTimelineRoot.tsx), loaded
 * on first use: from the command menu and the application menu.
 */
export function openActivityTimeline() {
  void importWithReload(
    "activity-timeline",
    () => import("./components/ActivityTimelineRoot"),
  ).then((module) => module.showActivityTimeline());
}
