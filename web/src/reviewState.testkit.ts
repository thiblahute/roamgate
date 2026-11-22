import {
  type ReviewSnapshot,
  type ReviewSummary,
  summarizeReview,
} from "../../shared/review";

/*
 * The review store as tests mock it: the reviews a test holds, whole, give
 * the summaries the store would list and the snapshots its views read.
 */

const summaryCache = new WeakMap<object, Map<string, ReviewSummary>>();

function summariesOf(
  sessions: ReadonlyMap<string, ReviewSnapshot>,
): Map<string, ReviewSummary> {
  let summaries = summaryCache.get(sessions);
  if (!summaries) {
    summaries = new Map(
      [...sessions].map(([id, snapshot]) => [
        id,
        summarizeReview({ ...snapshot, threads: snapshot.threads ?? [] }),
      ]),
    );
    summaryCache.set(sessions, summaries);
  }
  return summaries;
}

type HeldState = {
  sessions?: ReadonlyMap<string, unknown>;
  openRequest?: unknown;
  prompts?: unknown;
};

/** The store's state for the reviews a test holds (`sessions`). */
export function reviewStateOf(value: HeldState) {
  const sessions = (value.sessions ?? new Map()) as ReadonlyMap<
    string,
    ReviewSnapshot
  >;
  return {
    openRequest: null,
    prompts: new Map(),
    ...value,
    summaries: summariesOf(sessions),
    snapshots: sessions,
  };
}

/**
 * The review module's store functions over what `read` gives (called in
 * the hooks, so it may be a hook itself): spread in a mock of ../review.
 */
export function mockReviewStore(read: () => HeldState) {
  return {
    useReviewState: () => reviewStateOf(read()),
    useReviewSnapshots: () => reviewStateOf(read()).snapshots,
    getReviewSnapshot: (id: string) => reviewStateOf(read()).snapshots.get(id),
    getReviewSummary: (id: string) => reviewStateOf(read()).summaries.get(id),
  };
}
