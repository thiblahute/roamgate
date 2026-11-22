import { createRoot, type Root } from "react-dom/client";
import { focusBeforeMrReviews } from "../mrReviewsOpen";
import type { WorkOpen } from "../workOpen";
import type { MrDeclarePrefill } from "./MrEffortView";
import {
  type BoardMode,
  MrReviewsPanel,
  storedBoardMode,
} from "./MrReviewsPanel";

let root: Root | null = null;
let host: HTMLElement | null = null;
let previousFocus: Element | null = null;
/** The mode the open view shows, as it tells it. */
let shownMode: BoardMode | null = null;

function close(options: { keepFocus?: boolean } = {}) {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  shownMode = null;
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

/**
 * What the view is opened on: its mode, and for the Work board the item
 * to show, the session whose items to show, or the add form to start.
 */
export type BoardOpen = { mode?: BoardMode } & WorkOpen;

let renders = 0;
let modeRequests = 0;
function render(
  select?: string,
  open?: string,
  view?: "chat" | "declare",
  declare?: MrDeclarePrefill,
  board?: BoardOpen,
) {
  // A new key remounts it, so a request to open, or the chat, or a Work
  // item, is taken once; a mode asked for is taken as it comes.
  const mode = board?.mode;
  if (mode) modeRequests++;
  root?.render(
    <MrReviewsPanel
      key={
        open || view || board?.item || board?.owner || board?.add
          ? `open-${++renders}`
          : "panel"
      }
      onClose={close}
      initialSelect={open ?? select}
      initialOpen={open}
      {...(view ? { initialView: view } : {})}
      {...(declare ? { initialDeclare: declare } : {})}
      {...(mode ? { mode, modeAt: modeRequests } : {})}
      {...(board?.item ? { initialWorkItem: board.item } : {})}
      {...(board?.owner || board?.add
        ? {
            initialWork: {
              ...(board.owner ? { owner: board.owner } : {}),
              ...(board.add ? { add: board.add } : {}),
            },
          }
        : {})}
      onMode={(shown) => {
        shownMode = shown;
      }}
    />,
  );
}

/**
 * Shows the board view in its own root on the body, as the activity
 * timeline is shown: loaded only when asked for; the bridge and the store
 * are module singletons. `board` says the mode (the last one otherwise)
 * and, for the Work board, the item to open on.
 */
export function showMrReviews(
  select?: string,
  open?: string,
  view?: "chat" | "declare",
  /** Declaring: the home and source to fill in. */
  declare?: MrDeclarePrefill,
  board?: BoardOpen,
) {
  if (root) {
    render(select, open, view, declare, board);
    return;
  }
  previousFocus = document.activeElement;
  host = document.createElement("div");
  host.className = "mr-reviews-root";
  document.body.append(host);
  root = createRoot(host);
  render(select, open, view, declare, board);
}

/**
 * The shortcut's toggle: closed, the view opens on the mode (the last one
 * without); open on that mode, it closes; open on the other, it switches.
 */
export function toggleMrReviews(mode?: BoardMode) {
  if (!root) {
    showMrReviews(undefined, undefined, undefined, undefined, { mode });
    return;
  }
  if (!mode || (shownMode ?? storedBoardMode()) === mode) close();
  else render(undefined, undefined, undefined, undefined, { mode });
}

export function closeMrReviews() {
  if (root) close();
}

/** The mode the open view shows; null when it is closed. */
export function shownBoardMode(): BoardMode | null {
  return root ? shownMode : null;
}
