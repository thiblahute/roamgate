import { importWithReload } from "./lazyWithReload";

/**
 * Calls the voice companion (components/CompanionCallRoot.tsx), loaded on
 * first use: from the application menu, the command menu, its shortcut,
 * or a pane's voice button in companion mode, whose session is then where
 * work goes by default.
 */
export function callCompanion(target?: string | null) {
  void importWithReload(
    "companion-call",
    () => import("./components/CompanionCallRoot"),
  ).then((module) => module.showCompanionCall(target));
}

/** Opens the companion's own conversation, from its chip. */
export function openCompanionPanel() {
  void importWithReload(
    "companion-call",
    () => import("./components/CompanionCallRoot"),
  ).then((module) => module.showCompanionPanel());
}
