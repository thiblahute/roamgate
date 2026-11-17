import { preloadableLazy } from "../lazyWithReload";

/**
 * The comment editors' CodeMirror Vim editor, loaded with the first one
 * (or ahead, with the review's cursor: opened, it draws and takes the
 * focus at once, so the keys typed right after `c` are the comment's).
 */
export const ReviewCommentEditorLazy = preloadableLazy(
  "review-comment-editor",
  () =>
    import("./ReviewCommentEditor").then((module) => ({
      default: module.ReviewCommentEditor,
    })),
);

/** Loads the comment editor ahead. */
export function preloadReviewCommentEditor(): void {
  void ReviewCommentEditorLazy.preload().catch(() => {});
}
