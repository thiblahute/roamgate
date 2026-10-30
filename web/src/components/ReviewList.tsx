import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ReviewActivity,
  ReviewGoneCode,
  ReviewSnapshot,
} from "../../../shared/review";
import { rememberReviewSnapshot, reviewCall } from "../review";
import { describeReviewTarget, rankReviews } from "../reviewModel";
import { store } from "../store";
import "./ReviewOverlay.css";

function fmtDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * maildesk's "Reviews in progress": the ones with news first. j/k move,
 * Enter opens, dd discards (u undoes), Esc or q closes.
 */
/** A review found unreadable lately: dd forgets it. */
function goneChip(code: ReviewGoneCode | undefined) {
  if (!code) return [];
  const text =
    code === "checkout-gone"
      ? "checkout removed"
      : code === "base-gone"
        ? "base gone"
        : "head gone";
  return [{ text, news: true }];
}

export function ReviewList({
  connectionId,
  sessions,
  onOpen,
  onClose,
}: {
  connectionId: string;
  sessions: ReviewSnapshot[];
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [activity, setActivity] = useState<ReadonlyMap<
    string,
    ReviewActivity
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const discarded = useRef<ReviewSnapshot | null>(null);
  const pendingD = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    let cancelled = false;
    void reviewCall<{ activity: ReviewActivity[] }>(
      connectionId,
      "review.activity",
    ).then(
      (result) => {
        if (!cancelled)
          setActivity(new Map(result.activity.map((a) => [a.sessionId, a])));
      },
      (failure) => {
        if (cancelled) return;
        setActivity(new Map());
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const items = useMemo(
    () =>
      rankReviews(
        sessions,
        new Set(
          [...(activity?.values() ?? [])]
            .filter((entry) => entry.newCommits)
            .map((entry) => entry.sessionId),
        ),
      ),
    [sessions, activity],
  );
  const current = Math.min(selected, Math.max(0, items.length - 1));

  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-review-item="${current}"]`)
      ?.focus({ preventScroll: false });
  }, [current, items.length]);

  async function discard(snapshot: ReviewSnapshot) {
    discarded.current = snapshot;
    try {
      await reviewCall(connectionId, "review.remove", {
        session_id: snapshot.session.id,
      });
      store.notify({
        kind: "info",
        message: "Review discarded (u undoes)",
        autoDismissMs: 4000,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function undo() {
    const snapshot = discarded.current;
    if (!snapshot) return;
    discarded.current = null;
    try {
      rememberReviewSnapshot(
        await reviewCall<ReviewSnapshot>(connectionId, "review.import", {
          snapshot,
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled below
    <div
      className="review-list-overlay"
      role="dialog"
      aria-label="Reviews in progress"
      tabIndex={-1}
      ref={rootRef}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const key = event.key;
        let handled = true;
        if (key === "j" || key === "ArrowDown")
          setSelected(Math.min(items.length - 1, current + 1));
        else if (key === "k" || key === "ArrowUp")
          setSelected(Math.max(0, current - 1));
        else if (key === "Enter") {
          const item = items[current];
          if (item) onOpen(item.snapshot.session.id);
        } else if (key === "d") {
          const now = Date.now();
          if (now - pendingD.current < 800) {
            pendingD.current = 0;
            const item = items[current];
            if (item) void discard(item.snapshot);
          } else pendingD.current = now;
        } else if (key === "u") void undo();
        else if (key === "Escape" || key === "q") onClose();
        else handled = false;
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="panel reviews-panel">
        <div className="settings-head">
          <h2>Reviews in progress</h2>
          <button
            type="button"
            className="icon-btn"
            title="Close (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {error ? <div className="bubble error">{error}</div> : null}
        {activity === null ? (
          <p className="note">Checking your reviews and their branches...</p>
        ) : items.length === 0 ? (
          <p className="note">
            No review in progress. Press Option+R in a workspace to start one.
          </p>
        ) : (
          <ul className="chat-history">
            {items.map((item, index) => {
              const { session } = item.snapshot;
              const chips: { text: string; news?: boolean }[] = [
                {
                  text: item.comments
                    ? `${item.comments} comment${item.comments === 1 ? "" : "s"}`
                    : session.summary.trim()
                      ? "overall comment only"
                      : "empty",
                },
                ...(item.newCommits
                  ? [{ text: "new commits since", news: true }]
                  : []),
                ...(item.waiting
                  ? [{ text: `${item.waiting} waiting for you`, news: true }]
                  : []),
                ...(session.agent.working
                  ? [{ text: `${session.agent.name ?? "agent"} working` }]
                  : []),
                ...(session.gitlab ? [{ text: "GitLab" }] : []),
                ...goneChip(activity?.get(session.id)?.gone),
              ];
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    data-review-item={index}
                    className={`hist-item review-item${index === current ? " on" : ""}`}
                    onFocus={() => setSelected(index)}
                    onClick={() => onOpen(session.id)}
                  >
                    <span className="hist-title">
                      {session.title || "(no title)"}
                      <span className="note">
                        {"  "}
                        {session.root.split("/").pop()} ·{" "}
                        {describeReviewTarget(session.target)}
                      </span>
                    </span>
                    <span className="hist-when">
                      {fmtDate(session.updatedAt)}
                    </span>
                    <span className="hist-last review-chips">
                      {chips.map((chip) => (
                        <span
                          key={chip.text}
                          className={`chip-s${chip.news ? " news" : ""}`}
                        >
                          {chip.text}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="note">
          j/k move · Enter opens · dd discards (u undoes) · Esc closes
        </p>
      </div>
    </div>
  );
}
