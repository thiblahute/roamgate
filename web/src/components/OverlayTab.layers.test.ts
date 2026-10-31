import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

function zIndexOf(source: string, selector: string) {
  const at = source.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = source.slice(at, source.indexOf("}", at));
  const match = /z-index:\s*(\d+)/.exec(body);
  if (!match) throw new Error(`no z-index for ${selector}`);
  return Number(match[1]);
}

test("an overlay shown from the review floats above it, below dialogs", () => {
  const overlay = css("./OverlayTab.css");
  const review = zIndexOf(css("./ReviewOverlay.css"), ".review-overlay");
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
