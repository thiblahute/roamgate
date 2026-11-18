import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { type CSSProperties, useLayoutEffect, useRef } from "react";
import type { CommitChoice } from "../reviewModel";
import { formatUiDateTime } from "../uiLocale";
import type { ChangesViews } from "../useChangesViews";
import "./ChangesCommitBar.css";

/*
 * The review's commit bar in Changes: the view shown (all the changes, or a
 * commit), `<` `>` beside it, `gc` (a click on its name) for the picker;
 * the offer to reload once the code changed (R, gr, :e).
 */

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One row of the commit picker, one line high: its place and sha, its
 * subject cut to the room left (whole in the tooltip), its author and a
 * short date (the full one in the tooltip) in a column that never wraps.
 */
export function PickerRow({
  choice,
  total,
  selected,
  current,
  onPick,
}: {
  choice: CommitChoice;
  total: number;
  selected: boolean;
  current: boolean;
  onPick: () => void;
}) {
  const commit = choice.commit;
  const className = `diff-commit-choice${selected ? " on" : ""}${current ? " current" : ""}`;
  if (!commit)
    return (
      <button type="button" className={className} onClick={onPick}>
        <span className="diff-commit-choice-subject">
          All changes ({plural(total, "commit")})
        </span>
        <span className="diff-commit-choice-meta note">the whole change</span>
      </button>
    );
  const id = `${choice.position ? `${choice.position}/${total} ` : ""}${choice.sha?.slice(0, 8) ?? ""}`;
  const when = commit.date ? formatUiDateTime(commit.date) : "";
  return (
    <button
      type="button"
      className={className}
      // The width the longest place and sha take, for every row alike.
      style={
        { "--choice-id": `${String(total).length * 2 + 10}ch` } as CSSProperties
      }
      title={`${id} ${commit.subject}`}
      onClick={onPick}
    >
      <span className="diff-commit-choice-id note">{id}</span>
      <span className="diff-commit-choice-subject">{commit.subject}</span>
      <span
        className="diff-commit-choice-meta note"
        title={[commit.author, commit.date].filter(Boolean).join(", ")}
      >
        {commit.author ? (
          <span className="diff-commit-choice-author">{commit.author}</span>
        ) : null}
        {when ? <span className="diff-commit-choice-date">{when}</span> : null}
      </span>
    </button>
  );
}

export function ChangesCommitBar({
  views,
  onReload,
  onDone,
}: {
  views: ChangesViews;
  /** Reload the review: its commits and the view shown. */
  onReload: () => void;
  /** The picker closed: the keys back to the diff. */
  onDone: () => void;
}) {
  const { name, commits, picker } = views;
  const listRef = useRef<HTMLUListElement | null>(null);
  const at = picker?.at;
  // The selected row stays in sight as j / k move it.
  useLayoutEffect(() => {
    if (at === undefined) return;
    const row = listRef.current?.children[at]?.querySelector("button");
    row?.scrollIntoView?.({ block: "nearest" });
  }, [at]);
  if (!name && !views.changed && !views.status && !picker) return null;
  return (
    <div className="diff-review-views">
      {name ? (
        <div className="diff-commit-bar">
          <button
            type="button"
            className="diff-commit-step"
            title="Previous commit (<)"
            aria-label="Previous commit"
            onClick={() => views.step(-1)}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="diff-commit-name"
            title={`${name.head} ${name.subject}${
              views.history && commits
                ? `\nNothing beyond the default branch: its ${plural(commits.length, "commit")}, latest first (> goes back)`
                : ""
            }\nPick a commit by its subject (gc)`}
            onClick={() => views.openPicker()}
          >
            <span className="note">{name.head}</span>
            <span className="diff-commit-subject">{name.subject}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="diff-commit-step"
            title="Next commit (>)"
            aria-label="Next commit"
            onClick={() => views.step(1)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          {views.history && commits ? (
            <span className="note diff-commit-history">
              Nothing beyond the default branch: its{" "}
              {plural(commits.length, "commit")}, latest first (&gt; goes back)
            </span>
          ) : null}
        </div>
      ) : null}
      {views.status ? (
        <span className="diff-review-views-status note" aria-live="polite">
          {views.status}
          {views.failed && !views.loading ? (
            <button
              type="button"
              className="btn ghost rv-sm"
              onClick={onReload}
            >
              Retry
            </button>
          ) : null}
        </span>
      ) : null}
      {views.changed ? (
        <div className="diff-review-changed" role="status">
          <span>The code changed since this review was loaded.</span>
          <button
            type="button"
            title="Read the review again, on the same line (R, gr, :e)"
            onClick={onReload}
          >
            <RefreshCw size={13} aria-hidden="true" /> Reload
          </button>
        </div>
      ) : null}
      {picker ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes it
        <div
          className="diff-commit-picker"
          // Over the review for a moment: Zen's way out stays docked.
          data-zen-transient=""
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              views.pick(undefined);
              onDone();
            }
          }}
          onKeyDown={() => {}}
        >
          <div className="diff-commit-picker-panel">
            <input
              // The picker takes the keys as soon as it opens.
              // biome-ignore lint/a11y/noAutofocus: opened by a key
              autoFocus
              type="search"
              name="search"
              placeholder="Commit: words of its subject, or its sha (j / k move)"
              aria-label="Search commits"
              value={picker.query}
              onChange={(event) => views.setPickerQuery(event.target.value)}
              onKeyDown={(event) => {
                // Bare j / k move until a search is typed; Ctrl+j / k always.
                const browse = !picker.query || event.ctrlKey;
                if (event.key === "Escape") {
                  event.preventDefault();
                  views.pick(undefined);
                  onDone();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  views.pick(picker.choices[picker.at]);
                  onDone();
                } else if (
                  event.key === "ArrowDown" ||
                  (event.ctrlKey && event.key === "n") ||
                  (browse && event.key === "j" && !event.altKey)
                ) {
                  event.preventDefault();
                  views.movePicker(1);
                } else if (
                  event.key === "ArrowUp" ||
                  (event.ctrlKey && event.key === "p") ||
                  (browse && event.key === "k" && !event.altKey)
                ) {
                  event.preventDefault();
                  views.movePicker(-1);
                }
                event.stopPropagation();
              }}
            />
            <ul ref={listRef}>
              {picker.choices.map((choice, index) => (
                <li key={choice.sha ?? "all"}>
                  <PickerRow
                    choice={choice}
                    total={commits?.length ?? 0}
                    selected={index === picker.at}
                    current={choice.sha === views.sha}
                    onPick={() => {
                      views.pick(choice);
                      onDone();
                    }}
                  />
                </li>
              ))}
              {picker.choices.length ? null : (
                <li className="note">No commit matches.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
