import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type BoardMode,
  type BoardOpenRequest,
  onBoardOpen,
  pendingBoardOpen,
  takeBoardOpen,
} from "../mrReviewsOpen";
import type { BoardInspectorView } from "../workspaceResource";
import type { BoardCloseOptions } from "./WorkBoard";
import { MrReviewsPanel } from "./MrReviewsPanel";

/**
 * The board in the workspace inspector's Work and Reviews tabs: one panel
 * for both (switching tabs keeps it), opened on what was asked for (a
 * request, an item, a chat), taken once: shown again later, the board
 * comes back where it was left (workViewMemory.ts), not on the request.
 */
export function InspectorBoard({
  view,
  expanded,
  onView,
  onExpand,
  onClose,
  onStepAside,
  onKeyFirst,
}: {
  view: BoardInspectorView;
  /** The inspector fills the window (or a phone's screen). */
  expanded: boolean;
  onView: (view: BoardInspectorView) => void;
  onExpand: () => void;
  /** Esc with nothing else to leave, `:q`: the inspector closes. */
  onClose: () => void;
  /** A session, a workspace or a review shown: the board steps aside. */
  onStepAside: () => void;
  onKeyFirst: (event: KeyboardEvent) => boolean;
}) {
  const asked = useSyncExternalStore(
    onBoardOpen,
    pendingBoardOpen,
    pendingBoardOpen,
  );
  const [held, setHeld] = useState<BoardOpenRequest | null>(asked);
  useEffect(() => {
    if (!asked) return;
    setHeld(asked);
    takeBoardOpen(asked.seq);
  }, [asked]);
  const shown = asked ?? held;
  // What the board opened (a review, a session) may answer once the
  // inspector shows something else: the board, gone, does nothing then.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mode: BoardMode = view === "work" ? "work" : "mr";
  return (
    <MrReviewsPanel
      // A request remounts it, so it is taken once, as it was asked.
      key={shown ? `open-${shown.seq}` : "panel"}
      mode={mode}
      onModeChange={(next) => onView(next === "work" ? "work" : "reviews")}
      expanded={expanded}
      onExpand={onExpand}
      onKeyFirst={onKeyFirst}
      onClose={(options?: BoardCloseOptions) => {
        if (!mounted.current) return;
        if (options?.keepFocus) onStepAside();
        else onClose();
      }}
      {...(shown?.open || shown?.select
        ? { initialSelect: shown.open ?? shown.select }
        : {})}
      {...(shown?.open ? { initialOpen: shown.open } : {})}
      {...(shown?.view ? { initialView: shown.view } : {})}
      {...(shown?.declare ? { initialDeclare: shown.declare } : {})}
      {...(shown?.item ? { initialWorkItem: shown.item } : {})}
      {...(shown?.local ? { initialLocal: true } : {})}
      {...(shown?.effort ? { initialEffort: shown.effort } : {})}
      {...(shown?.owner || shown?.add
        ? {
            initialWork: {
              ...(shown.owner ? { owner: shown.owner } : {}),
              ...(shown.add ? { add: shown.add } : {}),
            },
          }
        : {})}
    />
  );
}
