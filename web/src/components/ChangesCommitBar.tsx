import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { ChangesViews } from "../useChangesViews";
import "./ChangesCommitBar.css";

/*
 * The review's commit bar in Changes (plan: review into the inspector,
 * phase 6), as the review pane's: the view shown (all the changes, or a
 * commit), `<` `>` beside it, `gc` (a click on its name) for the picker;
 * the offer to reload once the code changed (R, gr, :e).
 */

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

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
            title="Pick a commit by its subject (gc)"
            onClick={() => views.openPicker()}
          >
            <span className="note">{name.head}</span>
            <span>{name.subject}</span>
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
            <span className="note">
              Nothing beyond the default branch: its{" "}
              {plural(commits.length, "commit")}, latest first (&gt; goes back)
            </span>
          ) : null}
        </div>
      ) : null}
      {views.status ? (
        <span className="diff-review-views-status note">{views.status}</span>
      ) : null}
      {views.changed ? (
        <div className="diff-review-changed" role="status">
          <span>The code changed since it was loaded.</span>
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
            <ul>
              {picker.choices.map((choice, index) => (
                <li key={choice.sha ?? "all"}>
                  <button
                    type="button"
                    className={`${index === picker.at ? "on" : ""}${choice.sha === views.sha ? " current" : ""}`}
                    onClick={() => {
                      views.pick(choice);
                      onDone();
                    }}
                  >
                    <span>
                      {choice.commit ? (
                        <>
                          <span className="note">
                            {choice.position
                              ? `${choice.position}/${commits?.length ?? 0} `
                              : ""}
                            {choice.sha?.slice(0, 8)}
                          </span>{" "}
                          {choice.commit.subject}
                        </>
                      ) : (
                        `All changes (${plural(commits?.length ?? 0, "commit")})`
                      )}
                    </span>
                    <span className="note">
                      {choice.commit
                        ? [choice.commit.author, choice.commit.date]
                            .filter(Boolean)
                            .join(", ")
                        : "the whole change"}
                    </span>
                  </button>
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
