import { createRoot, type Root } from "react-dom/client";
import { UsageView } from "./UsageView";

let root: Root | null = null;
let host: HTMLElement | null = null;
let previousFocus: Element | null = null;

function close() {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
    previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}

/** Shows the Usage view in its own root on the body, as Activity does. */
export function showUsageView() {
  if (root) return;
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "usage-view-root";
  document.body.append(host);
  root = createRoot(host);
  root.render(<UsageView onClose={close} />);
}

/** The shortcut's way in and out. */
export function toggleUsageView() {
  if (root) close();
  else showUsageView();
}
