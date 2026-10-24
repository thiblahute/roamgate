import {
  EllipsisVertical,
  MessagesSquare,
  PanelTop,
  SquareStack,
  SquareTerminal,
} from "lucide-react";
import { useEffect, type Ref } from "react";
import { focusIfUnchanged } from "./dialogFocus";
import { blurActiveInput } from "../activeTerminalInput";

// App owns this rail, outside every hideable mobile surface. Only the active
// TerminalView portals its shared editor and tools into the input surface.
export function MobileBottomBar({
  inputRef,
  tabCount,
  attention,
  tabsOpen,
  moreOpen,
  onTabsOpenChange,
  onMoreOpenChange,
  chat,
  onToggleChat,
  workspaces,
}: {
  inputRef: Ref<HTMLDivElement>;
  tabCount: number;
  attention: boolean;
  tabsOpen: boolean;
  moreOpen: boolean;
  onTabsOpenChange: (open: boolean) => void;
  onMoreOpenChange: (open: boolean) => void;
  /** The focused pane is an agent's: shown as a chat, or as its terminal. */
  chat?: boolean;
  onToggleChat?: () => void;
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
    <div className="mobile-bottom-bar" aria-label="Mobile controls">
      <div className="mobile-bottom-input" ref={inputRef} />
      <nav className="mobile-appbar" aria-label="Workspace navigation">
        {onToggleChat ? (
          <button
            type="button"
            className={`mobile-appbar-chat${chat ? " is-active" : ""}`}
            aria-label={chat ? "Show the terminal" : "Show as a chat"}
            aria-pressed={chat}
            onPointerDown={blurActiveInput}
            onClick={() => {
              onMoreOpenChange(false);
              onTabsOpenChange(false);
              onToggleChat();
            }}
          >
            {chat ? (
              <SquareTerminal size={21} aria-hidden="true" />
            ) : (
              <MessagesSquare size={21} aria-hidden="true" />
            )}
          </button>
        ) : null}
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
        {/* One tab has nothing to switch to: New tab is in ⋮. */}
        {tabCount > 1 || tabsOpen ? (
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
