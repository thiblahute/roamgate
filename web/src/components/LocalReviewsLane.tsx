import { Trash2 } from "lucide-react";
import {
  type LocalReviewBranch,
  localReviewChips,
  localReviewKey,
  type LocalReviewSession,
} from "../localReviews";
import { describeReviewTarget, type ReviewListItem } from "../reviewModel";
import { shortcutLabel } from "../shortcutPreferences";
import { BoardCard } from "./BoardCard";
import { ago } from "./WorkBoard";

/** A ranked local review: rankReviews' item, of a summary or a snapshot. */
export type LocalReviewItem = Omit<ReviewListItem, "snapshot"> & {
  snapshot: { session: LocalReviewSession };
};

/**
 * The board's Local reviews: Roamgate's reviews of the workspace's
 * checkouts (every workspace's from a coordinator's, or widened), the ones
 * with news first. Enter shows one in Changes, dd discards it (u undoes).
 */
export function LocalReviewsLane({
  items,
  branches,
  selected,
  scope,
  workspaceLabels,
  onScope,
  onSelect,
  onOpen,
  onDiscard,
}: {
  items: readonly LocalReviewItem[];
  branches: ReadonlyMap<string, LocalReviewBranch>;
  /** The board's selected row key. */
  selected: string | null;
  /**
   * The workspace shown (its name), or null for every workspace; `fixed`:
   * opened from a coordinator's workspace, which shows them all.
   */
  scope: { label: string | null; fixed: boolean; canNarrow: boolean };
  /** Every workspace's name, by id: said on each row of every workspace. */
  workspaceLabels: ReadonlyMap<string, string>;
  /** Widen to every workspace (true), or back to the workspace's. */
  onScope: (all: boolean) => void;
  onSelect: (key: string) => void;
  onOpen: (sessionId: string) => void;
  onDiscard: (sessionId: string) => void;
}) {
  const all = scope.label === null;
  return (
    <section
      className="mr-reviews-section mr-local-reviews"
      aria-label="Local reviews"
    >
      <h3 className="mr-reviews-section-title">
        Local reviews
        <span>{items.length}</span>
      </h3>
      {scope.fixed ? null : all ? (
        scope.canNarrow ? (
          <button
            type="button"
            className="ghost mr-local-reviews-scope"
            title="Only this workspace's reviews"
            onClick={() => onScope(false)}
          >
            Every workspace
          </button>
        ) : null
      ) : (
        <button
          type="button"
          className="ghost mr-local-reviews-scope is-on"
          aria-label={`Remove the filter: only the reviews of ${scope.label}`}
          title={`Only the reviews of ${scope.label}: remove to see every workspace's`}
          onClick={() => onScope(true)}
        >
          Only {scope.label} ×
        </button>
      )}
      {items.length ? (
        <ul className="assistant-task-list">
          {items.map((item) => {
            const { session } = item.snapshot;
            const key = localReviewKey(session.id);
            const isSelected = key === selected;
            const chips = localReviewChips(item, branches.get(session.id));
            const where =
              all && session.workspaceId
                ? workspaceLabels.get(session.workspaceId)
                : undefined;
            return (
              <BoardCard
                key={key}
                selected={isSelected}
                unread={item.rank === 0}
                data={{ "data-mr-key": key, "data-local-review": session.id }}
                onSelect={() => onSelect(key)}
                onOpen={() => onOpen(session.id)}
                actions={
                  isSelected ? (
                    <button
                      type="button"
                      className="assistant-icon-button mr-reviews-action-more"
                      aria-label="Discard (dd)"
                      title="Discard the review (dd, u undoes)"
                      onClick={() => onDiscard(session.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : null
                }
              >
                <div className="mr-reviews-dense-head">
                  <strong>
                    <span className="mr-reviews-title">
                      {session.title || "(no title)"}
                    </span>
                  </strong>
                  <span
                    className="mr-reviews-dense-chips"
                    aria-label="Where it stands"
                  >
                    {chips.map((chip) => (
                      <span
                        key={chip.text}
                        className={`mr-reviews-chip${chip.tone === "news" ? " is-changed" : chip.tone ? ` is-${chip.tone}` : ""}`}
                      >
                        {chip.text}
                      </span>
                    ))}
                  </span>
                </div>
                <small className="mr-reviews-dense-meta">
                  {session.root.split("/").pop()} ·{" "}
                  {describeReviewTarget(session.target)}
                  {where ? ` · ${where}` : ""} · {ago(session.updatedAt)}
                </small>
              </BoardCard>
            );
          })}
        </ul>
      ) : (
        <p className="assistant-hint">
          No review in progress{all ? "" : " here"}.{" "}
          {shortcutLabel("review.toggle")} in a workspace starts one.
        </p>
      )}
    </section>
  );
}
