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
