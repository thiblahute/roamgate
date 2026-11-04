import { createRoot, type Root } from "react-dom/client";
import { focusBeforeMrReviews } from "../mrReviewsOpen";
import { MrReviewsPanel } from "./MrReviewsPanel";

let root: Root | null = null;
let host: HTMLElement | null = null;
let previousFocus: Element | null = null;

function close() {
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
      : focusBeforeMrReviews();
  back?.focus({ preventScroll: true });
  previousFocus = null;
}

function render(select?: string) {
  root?.render(<MrReviewsPanel onClose={close} initialSelect={select} />);
}

/**
 * Shows the reviews panel in its own root on the body, as the activity
 * timeline is shown: loaded only when asked for; the bridge and the store
 * are module singletons.
 */
export function showMrReviews(select?: string) {
  if (root) {
    render(select);
    return;
  }
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "mr-reviews-root";
  document.body.append(host);
  root = createRoot(host);
  render(select);
}

export function toggleMrReviews() {
  if (root) close();
  else showMrReviews();
}

export function closeMrReviews() {
  if (root) close();
}
