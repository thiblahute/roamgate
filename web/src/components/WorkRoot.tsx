import { createRoot, type Root } from "react-dom/client";
import { focusBeforeWork } from "../workOpen";
import { WorkPanel } from "./WorkPanel";

let root: Root | null = null;
let host: HTMLElement | null = null;
let previousFocus: Element | null = null;

function close(options: { keepFocus?: boolean } = {}) {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  const back =
    previousFocus instanceof HTMLElement &&
    previousFocus.isConnected &&
    previousFocus !== document.body &&
    !previousFocus.closest("[role='menu'], .command-popover")
      ? previousFocus
      : focusBeforeWork();
  if (!options.keepFocus) back?.focus({ preventScroll: true });
  previousFocus = null;
}

let renders = 0;
function render(item?: string) {
  // A new key remounts it, so a request to open an item is taken once.
  root?.render(
    <WorkPanel
      key={item ? `open-${++renders}` : "panel"}
      onClose={close}
      initialItem={item}
    />,
  );
}

/**
 * Shows the Work board in its own root on the body, as the reviews panel
 * is shown: loaded only when asked for.
 */
export function showWork(item?: string) {
  if (root) {
    render(item);
    return;
  }
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "work-root";
  document.body.append(host);
  root = createRoot(host);
  render(item);
}

export function toggleWork() {
  if (root) close();
  else showWork();
}

export function closeWork() {
  if (root) close();
}
