import { importWithReload } from "./lazyWithReload";

/**
 * Opens the activity timeline (components/ActivityTimelineRoot.tsx), loaded
 * on first use: from the command menu and the application menu.
 */
export function openActivityTimeline(view: "timeline" | "hours" = "timeline") {
  void importWithReload(
    "activity-timeline",
    () => import("./components/ActivityTimelineRoot"),
  ).then((module) => module.showActivityTimeline(view));
}

/** The timeline on its Hours view (the time-report provider's). */
export function openHours() {
  openActivityTimeline("hours");
}
