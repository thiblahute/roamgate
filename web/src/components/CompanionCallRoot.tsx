import { createRoot, type Root } from "react-dom/client";
import { startCompanionCall } from "../companionCall";
import { showCompanionCallOnPhone } from "../companionPhoneCall";
import { isMobileLayout } from "../layoutPreferences";
import { CompanionCall } from "./CompanionCall";
import { CompanionPanel } from "./CompanionPanel";

let root: Root | null = null;
let panel: { root: Root; host: HTMLElement; focus: Element | null } | null =
  null;

function mount() {
  if (root) return;
  const host = document.createElement("div");
  host.className = "companion-call-root";
  document.body.append(host);
  root = createRoot(host);
  root.render(<CompanionCall />);
  showCompanionCallOnPhone({
    phone: isMobileLayout,
    shown: () => panel !== null,
    show: showCompanionPanel,
    hide: closePanel,
  });
}

/**
 * Starts a call with the companion, its card in its own root on the body
 * (as the activity timeline): out of any pane, loaded on first use.
 */
export function showCompanionCall(target?: string | null) {
  mount();
  startCompanionCall(target);
}

function closePanel() {
  if (!panel) return;
  const { root: shown, host, focus } = panel;
  panel = null;
  shown.unmount();
  host.remove();
  if (focus instanceof HTMLElement && focus.isConnected)
    focus.focus({ preventScroll: true });
}

/** The companion's own conversation, over the app. */
export function showCompanionPanel() {
  mount();
  if (panel) return;
  const host = document.createElement("div");
  host.className = "companion-panel-root";
  document.body.append(host);
  const shown = createRoot(host);
  panel = { root: shown, host, focus: document.activeElement };
  shown.render(<CompanionPanel onClose={closePanel} />);
}
