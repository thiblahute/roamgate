import { createRoot, type Root } from "react-dom/client";
import { ArchiveSearch } from "./ArchiveSearch";

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
 * Shows the archive search in its own root on the body, like the activity
 * timeline: it needs nothing from the app but the bridge.
 */
export function showArchiveSearch(query = "") {
  if (root) return;
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "archive-search-root";
  document.body.append(host);
  root = createRoot(host);
  root.render(<ArchiveSearch onClose={close} initialQuery={query} />);
}
