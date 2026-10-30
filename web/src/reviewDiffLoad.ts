import { BoundedCache } from "./boundedCache";

/** A request for one view's diff, made with ReviewDiffs.begin. */
export type ReviewDiffRequest<D> = {
  /** The view's diff already loaded, unless the request asked it fresh. */
  readonly cached: D | undefined;
  /**
   * Whether the answer still counts: no reload came since, and for the shown
   * view no other view was asked for since.
   */
  current(): boolean;
  /** Keeps the answer while it counts; says whether it did. */
  done(diff: D): boolean;
};

/**
 * The diffs of a review's views, by commit (`""` for all changes). The shown
 * view's latest request wins: an answer for a view the user already left,
 * or one asked before a reload, neither shows nor fills the cache.
 */
export class ReviewDiffs<D> {
  private readonly cache: BoundedCache<string, D>;
  /** Bumped by each request for the shown view, and by a reload. */
  private latest = 0;
  /** Bumped by a reload. */
  private generation = 0;

  constructor(max = 16) {
    this.cache = new BoundedCache({ max });
  }

  /** The view's diff as loaded, if it still is. */
  get(sha: string): D | undefined {
    return this.cache.get(sha);
  }

  /** Forgets every diff: answers to requests made before are dropped. */
  clear() {
    this.generation++;
    this.latest++;
    this.cache.clear();
  }

  /**
   * Starts loading a view's diff. `shown` is the view put on screen (the
   * latest such request wins); otherwise one only looked at, such as by a
   * search through the other views, which only a reload makes stale.
   */
  begin(
    sha: string,
    { fresh = false, shown = true } = {},
  ): ReviewDiffRequest<D> {
    const token = shown ? ++this.latest : this.latest;
    const generation = this.generation;
    const current = () =>
      generation === this.generation && (!shown || token === this.latest);
    return {
      cached: fresh ? undefined : this.cache.get(sha),
      current,
      done: (diff) => {
        if (!current()) return false;
        this.cache.set(sha, diff);
        return true;
      },
    };
  }
}
