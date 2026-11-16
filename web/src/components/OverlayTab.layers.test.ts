import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

/** The z-index of the first rule for `selector` that sets one. */
function zIndexOf(source: string, selector: string) {
  let at = source.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  while (at >= 0) {
    const body = source.slice(at, source.indexOf("}", at));
    const match = /z-index:\s*(\d+)/.exec(body);
    if (match) return Number(match[1]);
    at = source.indexOf(`${selector} {`, at + 1);
  }
  throw new Error(`no z-index for ${selector}`);
}

test("an overlay shown from the reviews list floats above it, below dialogs", () => {
  const overlay = css("./OverlayTab.css");
  const review = zIndexOf(css("./ReviewList.css"), ".review-list-overlay");
  const dialogs = zIndexOf(
    css("./ConfigurationDialog.css"),
    ".popover-content.configuration-help-content",
  );
  const floating = zIndexOf(overlay, ".overlay-tab.is-floating");
  const above = zIndexOf(overlay, ".overlay-tab.is-floating.is-above-review");
  expect(floating).toBeLessThan(review);
  expect(above).toBeGreaterThan(review);
  expect(above).toBeLessThan(dialogs);
  expect(above).toBeLessThan(
    zIndexOf(css("../styles/layout/toast.css"), ".toast-viewport"),
  );
});
