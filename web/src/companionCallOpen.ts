import { companionCallState } from "./companionCall";
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

/**
 * Opens the companion's own conversation, from its chip: outside a call,
 * ready to type to it.
 */
export function openCompanionPanel() {
  const ask = !companionCallState().open;
  void importWithReload(
    "companion-call",
    () => import("./components/CompanionCallRoot"),
  ).then((module) => module.showCompanionPanel({ ask }));
}

/**
 * Opens the companion's conversation with its message box focused, to ask
 * it something in writing without a call (no microphone, nothing read
 * aloud): from its shortcut, the command menu or the application menu.
 * Already open, its box takes the focus again.
 */
export function askCompanion() {
  void importWithReload(
    "companion-call",
    () => import("./components/CompanionCallRoot"),
  ).then((module) => module.showCompanionPanel({ ask: true }));
}
