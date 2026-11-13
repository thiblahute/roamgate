import { forgeRefLabel } from "../../shared/forge";
import type { MrInboxEntry } from "../../shared/mrReviews";

export { moveMrKey, orderMrEntries } from "../../shared/mrReviewsOrder";

/** The words a request is found by: title, project, author, number, branches. */
export function mrSearchText(entry: MrInboxEntry): string {
  return [
    entry.title,
    entry.project,
    entry.host,
    entry.author,
    forgeRefLabel(entry),
    forgeRefLabel(entry, true),
    entry.sourceBranch,
    entry.targetBranch,
    entry.state,
    entry.draft ? "draft" : "",
    entry.reason ?? "",
    ...entry.reasons.map((reason) => reason.replace(/_/g, " ")),
  ]
    .join("\n")
    .toLowerCase();
}

/** Every word of the search is in the request's words (as the Threads list). */
export function mrMatches(entry: MrInboxEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = mrSearchText(entry);
  return words.every((word) => text.includes(word));
}

/** What a paste or a drop holds that may name a request: one URL or reference. */
export function mrPastedRequest(text: string): string | null {
  const line = text.trim();
  if (!line || line.length > 600 || /\s/.test(line)) return null;
  return /^https?:\/\/\S+\/(?:-\/merge_requests|pull)\/\d+/.test(line) ||
    /^[\w.-]*(?:\/[\w.-]+)*[!#]\d+$/.test(line)
    ? line
    : null;
}

/** The panel's keys, for its help (?). */
export const MR_REVIEWS_KEYS: [string, string][] = [
  ["j k / Down Up", "next / previous request (a count repeats: 3j)"],
  ["gg G / Home End", "first / last"],
  ["Enter", "review it"],
  ["i", "its details"],
  ["c", "its Claude session"],
  ["o", "open it on GitLab or GitHub"],
  ["J K / Alt+Down Alt+Up", "move it down / up in your order (3J)"],
  ["/", "search: title, project, author, number, branch"],
  ["p", "add a request: paste its URL (also paste or drop one in the panel)"],
  ["dd / Delete", "remove it from the view (a pinned one is unpinned)"],
  ["u", "undo the last removal"],
  ["H", "the hidden requests, to restore"],
  ["x", "not interested (a suggestion), else remove it as dd"],
  ["+", "more like this (a suggestion)"],
  ["r", "refresh"],
  ["a", "ask the reviews agent"],
  ["?", "this list"],
  ["Esc", "close the list, clear the search, then the panel"],
];
