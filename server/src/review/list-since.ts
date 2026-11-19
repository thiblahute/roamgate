import type { ReviewSnapshot } from "../../../shared/review";
/**
 * A review list for a page that holds some of it already: each snapshot
 * comes with a stamp of its content, and one whose stamp the page sent
 * back (`known`, id to stamp) is only named, not sent again. All of a
 * desktop's reviews are megabytes, read again on every reconnect.
 */
export function listReviewsSince(
  snapshots: ReviewSnapshot[],
  known: unknown,
): {
  sessions: ReviewSnapshot[];
  stamps: Record<string, string>;
  unchanged?: string[];
} {
  const held =
    known && typeof known === "object" && !Array.isArray(known)
      ? (known as Record<string, unknown>)
      : null;
  const sessions: ReviewSnapshot[] = [];
  const unchanged: string[] = [];
  const stamps: Record<string, string> = {};
  for (const snapshot of snapshots) {
    const id = snapshot.session.id;
    const stamp = Bun.hash(JSON.stringify(snapshot)).toString(36);
    stamps[id] = stamp;
    if (held?.[id] === stamp) unchanged.push(id);
    else sessions.push(snapshot);
  }
  return held ? { sessions, stamps, unchanged } : { sessions, stamps };
}
