import { createContext, useContext } from "react";
import type { Pane, PaneLayout } from "./types";

/**
 * Which tab a pane layout shows: the workspace's displayed tab, or its overlay
 * tab floating above it. Terminals read their layout, panes, and selection
 * through the scope they render in, so the overlay reuses the same views.
 */
export type PaneScope = "main" | "overlay";

export const PaneScopeContext = createContext<PaneScope>("main");

export function usePaneScope(): PaneScope {
  return useContext(PaneScopeContext);
}

type ScopedSource = {
  layout: PaneLayout | null;
  panes: Pane[];
  selectedPaneId: string | null;
  overlayLayout: PaneLayout | null;
  overlayPanes: Pane[];
  overlaySelectedPaneId: string | null;
  overlayOpen: boolean;
};

export type ScopedPaneState = {
  layout: PaneLayout | null;
  panes: Pane[];
  selectedPaneId: string | null;
  /** Whether this scope's active pane counts as shown (chat ownership). */
  shown: boolean;
  /** Whether this scope takes the keyboard: the overlay while it is shown. */
  ownsKeyboard: boolean;
};

export function scopedPaneState(
  source: ScopedSource,
  scope: PaneScope,
): ScopedPaneState {
  return scope === "overlay"
    ? {
        layout: source.overlayLayout,
        panes: source.overlayPanes,
        selectedPaneId: source.overlaySelectedPaneId,
        shown: source.overlayOpen,
        ownsKeyboard: source.overlayOpen,
      }
    : {
        layout: source.layout,
        panes: source.panes,
        selectedPaneId: source.selectedPaneId,
        // The displayed tab stays shown under the overlay, so an agent chat
        // there keeps its session instead of handing it over on every toggle.
        shown: true,
        ownsKeyboard: !source.overlayOpen,
      };
}
