import { createRoot, type Root } from "react-dom/client";
import { MrReviewsPanel } from "./MrReviewsPanel";

/**
 * The board panel mounted alone, as the inspector's Reviews tab holds it:
 * shown on the reviews inbox, closed (its Esc, or the test's) by unmounting.
 */
let root: Root | null = null;
let host: HTMLElement | null = null;

export function closeMrReviews() {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

export function showMrReviews(
  props: Partial<Parameters<typeof MrReviewsPanel>[0]> = {},
) {
  if (!root) {
    host = document.createElement("div");
    host.className = "inspector-board-resource";
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(
    <MrReviewsPanel
      mode="mr"
      onClose={() => queueMicrotask(closeMrReviews)}
      {...props}
    />,
  );
}
