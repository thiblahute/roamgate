import type { ReviewSnapshot, ReviewSummary } from "../../../shared/review";
/**
 * A review list for a page that holds some of it already: each review
 * comes with a stamp of its content, and one whose stamp the page sent
 * back (`known`, id to stamp) is only named, not sent again. All of a
 * desktop's reviews are megabytes, read again on every reconnect.
 *
 * With `limit`, at most that many reviews are sent, the most recently
 * updated first, and `remaining` counts the others still to send: a page
 * with nothing yet reads the list in small pages, sending back what it got.
 */
export const REVIEW_LIST_PAGE_MAX = 200;
/** Summaries are small: a page takes more of them at once. */
export const REVIEW_SUMMARY_PAGE_MAX = 1000;

function listSince<T extends { session: { id: string } }>(
  items: T[],
  known: unknown,
  limit: unknown,
  max: number,
  /**
   * Named again on each page, with their stamps: the whole snapshots' form.
   * The summaries' names them only on the last page, without the stamps
   * the page sent: paged, a large list would send every id again per page.
   */
  echo = true,
): {
  items: T[];
  stamps: Record<string, string>;
  unchanged?: string[];
  remaining?: number;
} {
  const page =
    typeof limit === "number" && Number.isInteger(limit) && limit > 0
      ? Math.min(limit, max)
      : null;
  const held =
    known && typeof known === "object" && !Array.isArray(known)
      ? (known as Record<string, unknown>)
      : null;
  const sent: T[] = [];
  const unchanged: string[] = [];
  const stamps: Record<string, string> = {};
  let remaining = 0;
  for (const item of items) {
    const id = item.session.id;
    const stamp = Bun.hash(JSON.stringify(item)).toString(36);
    if (held?.[id] === stamp) {
      unchanged.push(id);
      if (!echo) continue;
    } else if (page !== null && sent.length >= page) {
      remaining += 1;
      continue;
    } else sent.push(item);
    stamps[id] = stamp;
  }
  if (page !== null)
    return {
      items: sent,
      stamps,
      unchanged: echo || !remaining ? unchanged : [],
      remaining,
    };
  return held ? { items: sent, stamps, unchanged } : { items: sent, stamps };
}

/** The whole snapshots: what a page from before summaries asks for. */
export function listReviewsSince(
  snapshots: ReviewSnapshot[],
  known: unknown,
  limit?: unknown,
): {
  sessions: ReviewSnapshot[];
  stamps: Record<string, string>;
  unchanged?: string[];
  remaining?: number;
} {
  const { items, ...rest } = listSince(
    snapshots,
    known,
    limit,
    REVIEW_LIST_PAGE_MAX,
  );
  return { sessions: items, ...rest };
}

/** The summaries (review.list with `summaries`). */
export function listSummariesSince(
  summaries: ReviewSummary[],
  known: unknown,
  limit?: unknown,
): {
  summaries: ReviewSummary[];
  stamps: Record<string, string>;
  unchanged?: string[];
  remaining?: number;
} {
  const { items, ...rest } = listSince(
    summaries,
    known,
    limit,
    REVIEW_SUMMARY_PAGE_MAX,
    false,
  );
  return { summaries: items, ...rest };
}
