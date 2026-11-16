import type { MrInboxEntry } from "../../shared/mrReviews";
import { mrFilterMatches } from "../../shared/mrReviewsFilter";

export { mrSearchText } from "../../shared/mrReviewsFilter";

export { moveMrKey, orderMrEntries } from "../../shared/mrReviewsOrder";

/** Every token holds and every word is in the request's words. */
export function mrMatches(entry: MrInboxEntry, query: string): boolean {
  return mrFilterMatches(entry, query);
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

export { MR_REVIEWS_KEYS } from "./mrReviewsKeys";
