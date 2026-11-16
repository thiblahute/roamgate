import { useState } from "react";
import { roamgateLocalStorage } from "../browserStorage";
import type { InspectorCommand } from "../inspectorCommands";

/*
 * Changes' frame in the inspector: its tree beside the diff (`f`, `:files`,
 * remembered in the browser) and Review only (`o`, `:only`, the diff
 * alone). The inspector draws them; the review's behavior tests mount the
 * same frame around Changes' diff.
 */

export const CHANGES_TREE_HIDDEN_KEY = "inspectorChangesTreeHidden";

/** Changes' tree hidden, remembered in the browser; and its toggle. */
export function useChangesTreeHidden(): [boolean, () => void] {
  const [hidden, setHidden] = useState(() => {
    try {
      return roamgateLocalStorage.getItem(CHANGES_TREE_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setHidden((was) => {
      try {
        roamgateLocalStorage.setItem(CHANGES_TREE_HIDDEN_KEY, was ? "0" : "1");
      } catch {
        /* Kept for this page only. */
      }
      return !was;
    });
  return [hidden, toggle];
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
