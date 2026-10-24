import { EllipsisVertical, PanelTop, SquareStack } from "lucide-react";
import { useEffect, type ReactNode, type Ref } from "react";
import { focusIfUnchanged } from "./dialogFocus";
import { blurActiveInput } from "../activeTerminalInput";

// App owns this rail, outside every hideable mobile surface. The active
// input owner (TerminalView or Ranger) portals its editor into the input surface.
export function MobileBottomBar({
  inputRef,
  chatButton,
  tabCount,
  paneCount = 0,
  attention,
  tabsOpen,
  moreOpen,
  onTabsOpenChange,
  onMoreOpenChange,
  workspaces,
}: {
  inputRef: Ref<HTMLDivElement>;
  chatButton?: ReactNode;
  tabCount: number;
  /** Panes in the focused workspace: the tab sheet also switches those. */
  paneCount?: number;
  attention: boolean;
  tabsOpen: boolean;
  moreOpen: boolean;
  onTabsOpenChange: (open: boolean) => void;
  onMoreOpenChange: (open: boolean) => void;
  /** The workspace list, beside the tabs: switching workspaces in one tap. */
  workspaces?: { open: boolean; onToggle: () => void };
}) {
  useEffect(() => {
    if (!moreOpen) return;
    const menu = document.getElementById("mobile-more-options");
    menu?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onMoreOpenChange(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      const source = document.activeElement;
      if (source === document.body || (source && menu?.contains(source)))
        focusIfUnchanged(document.querySelector(".mobile-appbar-more"), source);
    };
  }, [moreOpen, onMoreOpenChange]);
  return (
    <div
      className="mobile-bottom-bar"
      aria-label="Mobile controls"
      data-chat={chatButton ? "" : undefined}
    >
      <div className="mobile-bottom-input" ref={inputRef} />
      <nav className="mobile-appbar" aria-label="Workspace navigation">
        {chatButton}
        {workspaces ? (
          <button
            type="button"
            className="mobile-appbar-workspaces"
            aria-label={workspaces.open ? "Hide workspaces" : "Show workspaces"}
            aria-pressed={workspaces.open}
            onPointerDown={blurActiveInput}
            onClick={() => {
              onMoreOpenChange(false);
              onTabsOpenChange(false);
              workspaces.onToggle();
            }}
          >
            <PanelTop size={21} aria-hidden="true" />
          </button>
        ) : null}
        {/* One tab of one pane has nothing to switch to: New tab is in ⋮. */}
        {tabCount > 1 || paneCount > 1 || tabsOpen ? (
          <button
            type="button"
            className="mobile-appbar-tabs"
            aria-label="Show tabs"
            aria-description={`${tabCount} open${attention ? ", an agent needs you" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={tabsOpen}
            onPointerDown={blurActiveInput}
            onClick={() => {
              onMoreOpenChange(false);
              onTabsOpenChange(!tabsOpen);
            }}
          >
            <SquareStack size={21} aria-hidden="true" />
            <span
              className="mobile-appbar-count"
              data-attention={attention || undefined}
              aria-hidden="true"
            >
              {tabCount}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="mobile-appbar-more"
          aria-label="More options"
          aria-expanded={moreOpen}
          aria-controls="mobile-more-options"
          onPointerDown={blurActiveInput}
          onClick={() => {
            onTabsOpenChange(false);
            onMoreOpenChange(!moreOpen);
          }}
        >
          <EllipsisVertical size={21} aria-hidden="true" />
        </button>
      </nav>
    </div>
  );
}
