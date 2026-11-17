import { createRoot, type Root } from "react-dom/client";
import { focusBeforeMrReviews } from "../mrReviewsOpen";
import type { MrDeclarePrefill } from "./MrEffortView";
import { MrReviewsPanel } from "./MrReviewsPanel";

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
      : focusBeforeMrReviews();
  if (!options.keepFocus) back?.focus({ preventScroll: true });
  previousFocus = null;
}

let renders = 0;
function render(
  select?: string,
  open?: string,
  view?: "chat" | "declare",
  declare?: MrDeclarePrefill,
) {
  // A new key remounts it, so a request to open, or the chat, is taken
  // once.
  root?.render(
    <MrReviewsPanel
      key={open || view ? `open-${++renders}` : "panel"}
      onClose={close}
      initialSelect={open ?? select}
      initialOpen={open}
      {...(view ? { initialView: view } : {})}
      {...(declare ? { initialDeclare: declare } : {})}
    />,
  );
}

/**
 * Shows the reviews panel in its own root on the body, as the activity
 * timeline is shown: loaded only when asked for; the bridge and the store
 * are module singletons.
 */
export function showMrReviews(
  select?: string,
  open?: string,
  view?: "chat" | "declare",
  /** Declaring: the home and source to fill in. */
  declare?: MrDeclarePrefill,
) {
  if (root) {
    render(select, open, view, declare);
    return;
  }
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "mr-reviews-root";
  document.body.append(host);
  root = createRoot(host);
  render(select, open, view, declare);
}

export function toggleMrReviews() {
  if (root) close();
  else showMrReviews();
}

export function closeMrReviews() {
  if (root) close();
}
