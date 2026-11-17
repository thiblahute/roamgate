import { FolderTree, GitGraph, History, Minimize2, X } from "lucide-react";
import { useState } from "react";
import { roamgateLocalStorage } from "../browserStorage";
import type { InspectorCommand } from "../inspectorCommands";
import { ZenDock } from "./ZenIsland";

/*
 * Changes' frame in the inspector: its tree beside the diff (`f`, `:files`,
 * remembered in the browser) and Review only (`o`, `:only`, the diff
 * alone). The inspector draws them; the review's behavior tests mount the
 * same frame around Changes' diff.
 */

export const CHANGES_TREE_HIDDEN_KEY = "inspectorChangesTreeHidden";

/** A flag remembered in the browser under `key`; and its toggle. */
export function useStoredFlag(key: string): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return roamgateLocalStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setOn((was) => {
      try {
        roamgateLocalStorage.setItem(key, was ? "0" : "1");
      } catch {
        /* Kept for this page only. */
      }
      return !was;
    });
  return [on, toggle];
}

/** Changes' tree hidden, remembered in the browser; and its toggle. */
export function useChangesTreeHidden(): [boolean, () => void] {
  return useStoredFlag(CHANGES_TREE_HIDDEN_KEY);
}

/** The classes of Changes' resource: its tree hidden, Review only. */
export function changesFrameClass({
  treeHidden,
  only,
}: {
  treeHidden: boolean;
  only: boolean;
}): string {
  return `${treeHidden ? "files-tree-hidden" : ""} ${
    only ? "is-review-only" : ""
  }`.trim();
}

/**
 * `:files` (when the tree can be hidden: not on a narrow inspector) and
 * `:only`, as the inspector runs them over Changes.
 */
export function changesFrameCommands({
  toggleTree,
  only,
  toggleOnly,
}: {
  /** Null: the tree cannot be hidden here (a compact inspector). */
  toggleTree: (() => void) | null;
  only: boolean;
  toggleOnly: () => void;
}): InspectorCommand[] {
  return [
    ...(toggleTree
      ? [
          {
            name: "files",
            description: "show / hide the changed files' tree",
            run: toggleTree,
          },
        ]
      : []),
    {
      name: "only",
      aliases: ["o", "diffonly"],
      description: only
        ? "the inspector again (o, Esc)"
        : "Review only: the diff alone (Esc brings all back)",
      run: toggleOnly,
    },
  ];
}

/**
 * Review only's end of the diff's head: Show all, the way out of the
 * review (the inspector's header, with its Close, is hidden), and Zen's.
 */
export function ReviewOnlyEnd({
  onShowAll,
  onCloseReview,
}: {
  onShowAll: () => void;
  /** Absent: no review to close (Changes not the review). */
  onCloseReview?: () => void;
}) {
  return (
    <div className="diff-review-only-end">
      <button
        type="button"
        className="diff-review-only-exit"
        title="Show the inspector again (:only or Esc)"
        onClick={onShowAll}
      >
        Show all
      </button>
      {onCloseReview ? (
        <button
          type="button"
          className="diff-review-only-exit"
          aria-label="Close the review"
          title="Close the review; it is kept (:q)"
          onClick={onCloseReview}
        >
          ×
        </button>
      ) : null}
      <ZenDock iconSize={14} />
    </div>
  );
}

/**
 * The inspector's header, shrunk into the review's row when the inspector
 * fills the screen in the app's Zen: the other views, Restore and Close,
 * then Zen's way out. Drawn whenever the inspector is expanded; shown only
 * in the app's Zen, where the inspector's own header is hidden (CSS), so
 * the review's row is the screen's one row.
 */
export function InspectorZenEnd({
  onView,
  historyAvailable,
  onRestore,
  onClose,
}: {
  onView: (view: "files" | "commits" | "history") => void;
  historyAvailable: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="diff-inspector-end"
      role="group"
      aria-label="Workspace Inspector"
    >
      <button
        type="button"
        className="diff-inspector-end-button"
        title="Files"
        aria-label="Show Files"
        onClick={() => onView("files")}
      >
        <FolderTree size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="diff-inspector-end-button"
        title="Commits"
        aria-label="Show Commits"
        onClick={() => onView("commits")}
      >
        <GitGraph size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="diff-inspector-end-button"
        title={
          historyAvailable
            ? "Agent history"
            : "Select an active agent pane to view history"
        }
        aria-label="Show History"
        disabled={!historyAvailable}
        onClick={() => onView("history")}
      >
        <History size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="diff-inspector-end-button"
        title="Restore Inspector dock"
        aria-label="Restore Inspector dock"
        onClick={onRestore}
      >
        <Minimize2 size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="diff-inspector-end-button"
        title="Close Inspector"
        aria-label="Close Workspace Inspector"
        onClick={onClose}
      >
        <X size={15} aria-hidden="true" />
      </button>
      <ZenDock iconSize={14} buttonClassName="diff-inspector-end-button" />
    </div>
  );
}
