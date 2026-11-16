/**
 * Every review surface the behavior tests run against: the classic review
 * pane, and the review in Changes (plan: review into the inspector), which
 * runs the tests of what it does so far. A test needing what a surface does
 * not do yet is not registered for it (it is neither run nor skipped there).
 */
import { test } from "bun:test";
import { mountChangesReview } from "./reviewSurface.changes.testkit";
import { mountClassicReview } from "./reviewSurface.classic.testkit";
import type { ReviewSurface, SurfaceOptions } from "./reviewSurface.testkit";

/** What a test needs of a surface, beyond the diff it draws. */
export type SurfaceFeature =
  /** Everything the classic pane does (the files not yet sorted). */
  | "review"
  /** The Vim cursor, its motions, the screen, Visual lines (phase 3). */
  | "cursor"
  /** `/ * # n N` in the diff and its file paths (phase 3). */
  | "search"
  /** Side by side: sides, S and its commands (phase 3). */
  | "sides"
  /** A click and Shift+click on a line (phase 3). */
  | "mouse"
  /** The review's commits: the commit bar, views (phase 6). */
  | "commits"
  /** The comment editor (phase 4). */
  | "editor"
  /** The window's width picks side by side (classic; D4 for Changes). */
  | "window-width"
  /** Context expansion: gap buttons, zo zO zR, x X (phase 5). */
  | "expand"
  /** Reviewed chunks and files: r, v, folds, the counts (phase 5). */
  | "reviewed"
  /** A file's header folds it; large files start folded (phase 5). */
  | "file-folds"
  /** Open on a file's header, to the Files preview (phase 8). */
  | "open-files"
  /**
   * The review's threads: their cards, folds, writes on their way, the
   * delivery to the agent, the status line, t, gH, n / N (phase 4).
   */
  | "threads"
  /** The comments panel (T), its chip and the unresolved arrows (phase 4). */
  | "threads-panel"
  /** Threads of the checkout's other reviews (a rendered file's, phase 4). */
  | "threads-shared"
  /** A merge request's review: its forge, drafts and discussions (phase 7). */
  | "forge";

export type SurfaceEntry = {
  name: string;
  mount: (options: SurfaceOptions) => Promise<ReviewSurface>;
  has: (feature: SurfaceFeature) => boolean;
};

const CHANGES_FEATURES = new Set<SurfaceFeature>([
  "cursor",
  "search",
  "sides",
  "mouse",
  "editor",
  "expand",
  "reviewed",
  "threads",
  "threads-panel",
  "threads-shared",
]);

export const ALL_REVIEW_SURFACES: SurfaceEntry[] = [
  { name: "classic", mount: mountClassicReview, has: () => true },
  {
    name: "changes",
    mount: mountChangesReview,
    has: (feature) => CHANGES_FEATURES.has(feature),
  },
];

/** The surfaces with every one of `features`. */
export function reviewSurfacesWith(
  ...features: SurfaceFeature[]
): SurfaceEntry[] {
  return ALL_REVIEW_SURFACES.filter((surface) =>
    features.every((feature) => surface.has(feature)),
  );
}

/** The surfaces with the whole review: the classic pane, today. */
export const REVIEW_SURFACES = reviewSurfacesWith("review");

/**
 * `test`, registered only where `surface` has `features`: a test of what
 * the surface does not do yet is not one of its tests.
 */
export function testWith(
  surface: SurfaceEntry,
  ...features: SurfaceFeature[]
): typeof test {
  return (
    features.every((feature) => surface.has(feature)) ? test : () => {}
  ) as typeof test;
}
