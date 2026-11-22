import type { ReviewSession } from "../../../shared/review";

/**
 * The reviews by id, and by checkout (connection and root, which a review
 * keeps for good) in the same order: linkedOf and localReviewsOf look
 * through a review's checkout alone, so that review.list, which snapshots
 * every review, does not scan every review for each one.
 */
export class ReviewSessions extends Map<string, ReviewSession> {
  readonly #checkouts = new Map<string, Map<string, ReviewSession>>();

  static #key(session: ReviewSession): string {
    return `${session.connectionId}\0${session.root}`;
  }

  override set(id: string, session: ReviewSession): this {
    const before = this.get(id);
    if (before) this.#checkouts.get(ReviewSessions.#key(before))?.delete(id);
    super.set(id, session);
    const key = ReviewSessions.#key(session);
    let checkout = this.#checkouts.get(key);
    if (!checkout) this.#checkouts.set(key, (checkout = new Map()));
    checkout.set(id, session);
    return this;
  }

  override delete(id: string): boolean {
    const before = this.get(id);
    if (!before) return false;
    const key = ReviewSessions.#key(before);
    const checkout = this.#checkouts.get(key);
    checkout?.delete(id);
    if (!checkout?.size) this.#checkouts.delete(key);
    return super.delete(id);
  }

  override clear(): void {
    this.#checkouts.clear();
    super.clear();
  }

  /** The reviews of a review's checkout, itself included. */
  ofCheckout(target: ReviewSession): ReviewSession[] {
    return [
      ...(this.#checkouts.get(ReviewSessions.#key(target))?.values() ?? []),
    ];
  }
}
