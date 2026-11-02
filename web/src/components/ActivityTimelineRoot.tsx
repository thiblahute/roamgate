import { createRoot, type Root } from "react-dom/client";
import { ActivityTimeline } from "./ActivityTimeline";

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

/**
 * Shows the timeline in its own root on the body: out of the transformed
 * phone app context, and loaded only when asked for. It needs no context
 * from the app: the bridge and the store are module singletons.
 */
export function showActivityTimeline() {
  if (root) return;
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "activity-timeline-root";
  document.body.append(host);
  root = createRoot(host);
  root.render(<ActivityTimeline onClose={close} />);
}
