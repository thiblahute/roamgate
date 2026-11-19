import type { ReviewSnapshot } from "../../../shared/review";
/**
 * A review list for a page that holds some of it already: each snapshot
 * comes with a stamp of its content, and one whose stamp the page sent
 * back (`known`, id to stamp) is only named, not sent again. All of a
 * desktop's reviews are megabytes, read again on every reconnect.
 *
 * With `limit`, at most that many reviews are sent, the most recently
 * updated first, and `remaining` counts the others still to send: a page
 * with nothing yet reads the list in small pages, sending back what it got.
 */
export const REVIEW_LIST_PAGE_MAX = 200;

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
  const page =
    typeof limit === "number" && Number.isInteger(limit) && limit > 0
      ? Math.min(limit, REVIEW_LIST_PAGE_MAX)
      : null;
  const held =
    known && typeof known === "object" && !Array.isArray(known)
      ? (known as Record<string, unknown>)
      : null;
  const sessions: ReviewSnapshot[] = [];
  const unchanged: string[] = [];
  const stamps: Record<string, string> = {};
  let remaining = 0;
  for (const snapshot of snapshots) {
    const id = snapshot.session.id;
    const stamp = Bun.hash(JSON.stringify(snapshot)).toString(36);
    if (held?.[id] === stamp) unchanged.push(id);
    else if (page !== null && sessions.length >= page) {
      remaining += 1;
      continue;
    } else sessions.push(snapshot);
    stamps[id] = stamp;
  }
  if (page !== null) return { sessions, stamps, unchanged, remaining };
  return held ? { sessions, stamps, unchanged } : { sessions, stamps };
}
