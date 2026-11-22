/*
 * The refs Changes' scope picker searches to pick both sides of a
 * comparison (the server's `git.refs`).
 */

/** A ref the Changes scope picker offers to compare: its full name. */
export type CompareRef = {
  name: string;
  /** Its commit's (or tag's) date, in seconds. */
  date?: number;
};

/** What the scope picker searches to pick both sides of a comparison. */
export type CompareRefs = {
  /** The checked-out branch's full ref; none when detached. */
  current?: string;
  /** Its upstream, when it has one. */
  upstream?: string;
  /** Automatic's base (resolveDefaultBase). */
  base?: string;
  /**
   * The local branches nearest HEAD in its history, the newest first: the
   * layers of a stack below it, then those above it.
   */
  near: string[];
  /** Local and remote-tracking branches, and the newest tags. */
  refs: CompareRef[];
};
