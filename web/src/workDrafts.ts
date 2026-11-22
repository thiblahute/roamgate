import { useMemo } from "react";
import { draftSessionIds, useDraftsVersion } from "./reviewDrafts";
import type { DraftPlace } from "./components/ThreadEditor";

/*
 * Where the Work board's boxes keep their unsent words (reviewDrafts, as
 * every comment box does): an item's boxes under `work:ITEM` (its new
 * comment, a reply to a thread, a thread on a part of a comment, the
 * card's answer), the new item form's under `work-add`, by project, the
 * workspace it is added from and the session it is added for.
 */

const ITEM_PREFIX = "work:";
export const WORK_ADD_DRAFTS = "work-add";

/** The session an item's boxes keep their words under. */
export function workItemDrafts(item: string): string {
  return `${ITEM_PREFIX}${item}`;
}

/** An item's box: its new comment, the card's answer, a reply, a part. */
export function workItemDraft(item: string, key: string): DraftPlace {
  return { session: workItemDrafts(item), key };
}

/** The new item form's draft, for a project, a workspace and an owner. */
export function workAddDraft(
  project: string,
  workspace?: { connectionId: string; workspaceId?: string } | null,
  owner?: string | null,
): DraftPlace {
  return {
    session: WORK_ADD_DRAFTS,
    key: [
      project,
      workspace
        ? `${workspace.connectionId}/${workspace.workspaceId ?? ""}`
        : "",
      owner ?? "",
    ].join("\0"),
  };
}

/** The items with a box's words unsent, drawn again as they change. */
export function useWorkDraftItems(): ReadonlySet<string> {
  const version = useDraftsVersion();
  // Read again as the drafts change (version).
  return useMemo(
    () =>
      new Set(
        draftSessionIds(ITEM_PREFIX).map((id) => id.slice(ITEM_PREFIX.length)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
}
