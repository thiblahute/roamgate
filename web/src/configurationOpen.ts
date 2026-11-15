import type { ConfigurationTab } from "./components/ConfigurationDialog";

/** The event the configuration menu answers by opening its dialog. */
export const OPEN_CONFIGURATION = "roamgate:open-configuration";

/**
 * Opens the configuration dialog, on a tab, from anywhere: the phone's
 * menu has no top bar button to reach it. A module of its own, so what
 * opens it does not load the menu.
 */
export function openConfiguration(tab: ConfigurationTab = "Appearance") {
  window.dispatchEvent(new CustomEvent(OPEN_CONFIGURATION, { detail: tab }));
}

/** The event the application menu answers by opening. */
export const OPEN_APP_MENU = "roamgate:open-app-menu";

/**
 * Opens (or closes) the application menu from outside the top bar. From a
 * button (Zen's), the menu opens under it and the hidden top bar stays
 * hidden; focus comes back to it when the menu closes.
 */
export function openAppMenu(anchor?: HTMLElement) {
  window.dispatchEvent(
    new CustomEvent(OPEN_APP_MENU, { detail: anchor ?? null }),
  );
}
