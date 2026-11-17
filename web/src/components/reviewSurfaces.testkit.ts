/**
 * The review surface the behavior tests run against: the review in Changes.
 * Each test says what it needs of the surface; one needing what it does
 * not do is not registered (neither run nor skipped).
 */
import { test } from "bun:test";
import { mountChangesReview } from "./reviewSurface.changes.testkit";
import type { ReviewSurface, SurfaceOptions } from "./reviewSurface.testkit";

/** What a test needs of a surface, beyond the diff it draws. */
export type SurfaceFeature =
  /** The whole review: every file is now sorted by feature. */
  | "review"
  /** The review's `:` commands and its shortcut list (`?`, `:help`). */
  | "commands"
  /**
   * The review's place across reloads (per review, the last 50), its
   * remembered preferences, put away and shown again, its loads retried
   * on a reconnect or Retry.
   */
  | "place"
  /**
   * Touch screens, narrow windows and the phone: unified there, the
   * layout's tree and way out, Review only's touch targets, the editor's
   * Esc button, the phone's Back.
   */
  | "phone"
  /** The Vim cursor, its motions, the screen, Visual lines. */
  | "cursor"
  /** `/ * # n N` in the diff and its file paths. */
  | "search"
  /** Side by side: sides, S and its commands. */
  | "sides"
  /** A click and Shift+click on a line. */
  | "mouse"
  /** The review's commits: the commit bar, views. */
  | "commits"
  /** The comment editor. */
  | "editor"
  /** The window's width picks side by side. */
  | "window-width"
  /** The code checked every 5 s while shown; a change offers a reload. */
  | "reload-offer"
  /** Context expansion: gap buttons, zo zO zR, x X. */
  | "expand"
  /** Reviewed chunks and files: r, v, folds, the counts. */
  | "reviewed"
  /** A file's header folds it; large files start folded. */
  | "file-folds"
  /** Open on a file's header, to the Files preview. */
  | "open-files"
  /**
   * The review's threads: their cards, folds, writes on their way, the
   * delivery to the agent, the status line, t, gH, n / N.
   */
  | "threads"
  /** The comments panel (T), its chip and the unresolved arrows. */
  | "threads-panel"
  /** Threads of the checkout's other reviews (a rendered file's). */
  | "threads-shared"
  /** A merge request's review: its forge, drafts and discussions. */
  | "forge"
  /** The workspace's repositories: the chooser, p, ( and ). */
  | "series"
  /** The agent's menu: ask about a line, go to its pane. */
  | "agent-menu"
  /** A thread on a commit rewritten out of the review: gn shows it. */
  | "gone-commits"
  /** The checkout's git actions on the review (:stage, gs, :discard). */
  | "git-actions";

export type SurfaceEntry = {
  name: string;
  mount: (options: SurfaceOptions) => Promise<ReviewSurface>;
  has: (feature: SurfaceFeature) => boolean;
};

const CHANGES_FEATURES = new Set<SurfaceFeature>([
  "review",
  "commands",
  "file-folds",
  "open-files",
  "place",
  "phone",
  "window-width",
  "reload-offer",
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
  "commits",
  "forge",
  "git-actions",
  "agent-menu",
  "series",
  "gone-commits",
  ...((process.env.ROAMGATE_CHANGES_TRY ?? "")
    .split(",")
    .filter(Boolean) as SurfaceFeature[]),
]);

export const ALL_REVIEW_SURFACES: SurfaceEntry[] = [
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

/** The surfaces with the whole review: Changes. */
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
