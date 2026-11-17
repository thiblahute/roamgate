import { useId } from "react";
import "./ShortcutList.css";

/*
 * The filterable shortcut list (`?`, `:help`): the review's, and the
 * inspector's for its views. Rows are [keys, what they do]; the keys are
 * written apart by spaces ("j k", "Esc Esc").
 */

export type ShortcutRow = readonly [keys: string, label: string];

/**
 * Whether a row matches what is typed in the filter: one key that is a key
 * of the list lists the rows holding it; else every word typed must be in
 * the row's keys or label, accents ignored.
 */
export function matchesShortcutFilter(
  rows: readonly ShortcutRow[],
  keys: string,
  label: string,
  filter: string,
): boolean {
  const plain = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const normal = (value: string) => plain(value).toLowerCase();
  const query = normal(filter).trim();
  if (!query) return true;
  // One key: the rows holding it, when it is a key of the list.
  const key = plain(filter).trim();
  const holds = (row: string) =>
    row.split(" ").some((each) => plain(each) === key);
  if (key.length === 1 && rows.some(([row]) => holds(row))) return holds(keys);
  const haystack = normal(`${keys} ${label}`);
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

export function ShortcutList({
  title,
  rows,
  filter,
  onFilter,
  onClose,
  filterId,
  placeholder = "Search shortcuts",
  className = "",
}: {
  title: string;
  rows: readonly ShortcutRow[];
  filter: string;
  onFilter: (filter: string) => void;
  /** Esc in the filter, the close button, a click beside the panel. */
  onClose: () => void;
  /** The filter's id. */
  filterId?: string;
  placeholder?: string;
  className?: string;
}) {
  const ownId = useId();
  const shown = rows.filter(([keys, label]) =>
    matchesShortcutFilter(rows, keys, label, filter),
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it
    <div
      className={`review-keys ${className}`.trim()}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="review-keys-panel">
        <div className="settings-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-btn"
            title="Close (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <input
          id={filterId ?? ownId}
          className="review-keys-filter"
          type="search"
          aria-label="Search shortcuts"
          // biome-ignore lint/a11y/noAutofocus: filtering is the point
          autoFocus
          placeholder={placeholder}
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <dl className="keys">
          {shown.map(([keys, label]) => (
            <div key={keys} className="keys-row">
              <dt>
                {keys.split(" ").map((key, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a row may hold a key twice (Esc Esc)
                  <kbd key={index}>{key}</kbd>
                ))}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        {shown.length ? null : <p className="note">Nothing matches.</p>}
      </div>
    </div>
  );
}
