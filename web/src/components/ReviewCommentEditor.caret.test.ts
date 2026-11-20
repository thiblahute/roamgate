import { expect, test } from "bun:test";
import { reviewEditorThemeSpec } from "./ReviewCommentEditor";

/*
 * The comment editor's caret must show wherever the editor is put: the
 * box floating over a file in the Files preview is outside any review
 * overlay, so the review's --rv-* palette is unset there. A color read
 * from an unset variable drops the whole declaration (`border-left: 2px
 * solid var(--rv-text)` draws no border at all): every use of the palette
 * falls back to the app's own color.
 */

/** Every var() in the theme, with what it falls back to. */
function variables(spec: object): { name: string; fallback?: string }[] {
  const found: { name: string; fallback?: string }[] = [];
  for (const value of Object.values(spec)) {
    if (typeof value === "object" && value) {
      found.push(...variables(value));
      continue;
    }
    for (const match of String(value).matchAll(
      /var\((--[a-z0-9-]+)(?:,\s*([^)]*\)|[^)]*))?\)/g,
    ))
      found.push({
        name: match[1]!,
        ...(match[2] ? { fallback: match[2] } : {}),
      });
  }
  return found;
}

test("the review palette's colors all fall back to the app's", () => {
  const review = variables(reviewEditorThemeSpec).filter((each) =>
    each.name.startsWith("--rv-"),
  );
  expect(review.length).toBeGreaterThan(5);
  for (const each of review) expect(each.fallback).toBeTruthy();
});

test("the caret is drawn in the text's color, in insert mode and Vim's normal mode", () => {
  const spec = reviewEditorThemeSpec;
  expect(spec[".cm-cursor, .cm-dropCursor"].borderLeft).toBe(
    "2px solid var(--rv-text, var(--text))",
  );
  expect(spec[".cm-content"].caretColor).toBe("var(--rv-text, var(--text))");
  expect(spec[".cm-fat-cursor"].background).toBe(
    "var(--rv-accent, var(--accent)) !important",
  );
});

test("inside another editor with Vim keys (a comment under a source line), the editor's own bar still shows", () => {
  // Vim's keys hide every drawn caret layer under their editor
  // (.cm-vimMode .cm-cursorLayer): this editor's shows unless it is in
  // Vim's normal mode itself, with a rule more specific than Vim's.
  expect(
    reviewEditorThemeSpec[
      ".cm-scroller:not(.cm-vimMode) .cm-cursorLayer:not(.cm-vimCursorLayer)"
    ].display,
  ).toBe("block");
});
