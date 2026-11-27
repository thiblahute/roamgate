import { importWithReload } from "./lazyWithReload";
import type { ShortcutEvent } from "./shortcutBindings";
import { shortcutMatches } from "./shortcutPreferences";

/** The menu and command menu entry of the Usage view. */
export const USAGE_ENTRY = {
  title: "Usage",
  detail: "Accounts' usage, the account chain, the sessions that spent them",
  keywords: ["usage", "accounts", "quota", "limit", "chain", "tokens"],
};

function loadRoot() {
  return importWithReload(
    "usage-view",
    () => import("./components/UsageViewRoot"),
  );
}

/** Opens the Usage view (components/UsageViewRoot.tsx), loaded on first use. */
export function openUsageView() {
  void loadRoot().then((module) => module.showUsageView());
}

/** Opens the view, or closes it when it is already open. */
export function toggleUsageView() {
  void loadRoot().then((module) => module.toggleUsageView());
}

/** The global shortcut (Alt+U), Zen mode included. */
export function handleUsageShortcut(
  event: ShortcutEvent & {
    repeat?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  },
  toggle: () => void = toggleUsageView,
) {
  if (!shortcutMatches(event, "usage.open")) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) toggle();
  return true;
}
