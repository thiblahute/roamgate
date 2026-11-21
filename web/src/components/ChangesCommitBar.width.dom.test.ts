import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// The review's commit bar fits a phone: on one (390px, 2026-11-21) "The code
// changed since this review was loaded." pushed its Reload button past the
// right edge, the bar as wide as its words and never wrapped. Applied by a
// DOM to the bar's markup in a phone's review head.
const sheets = await Promise.all(
  ["./ChangesCommitBar.css", "./DiffContentView.css"].map((path) =>
    Bun.file(new URL(path, import.meta.url)).text(),
  ),
);

function render(mobile: boolean) {
  const window = new Window({ width: 390, height: 844 });
  const { document } = window;
  for (const css of sheets) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
  const bar = `
    <div class="diff-review-views">
      <div class="diff-commit-bar">
        <button type="button" class="diff-commit-name">
          <span class="note">1/1 1a398396</span>
          <span class="diff-commit-subject">Phase 6: landing-review fixes</span>
        </button>
      </div>
      <span class="diff-review-views-status note">
        <span>Could not read the review again.</span>
        <button type="button" class="btn ghost rv-sm">Retry</button>
      </span>
      <div class="diff-review-changed" role="status">
        <span>The code changed since this review was loaded.</span>
        <button type="button">Reload</button>
      </div>
    </div>`;
  document.body.innerHTML = `
    <div class="diff-content-view${mobile ? " is-mobile" : ""}">
      <div class="diff-content-head is-review">
        ${mobile ? `<div class="diff-review-row">${bar}</div>` : bar}
      </div>
    </div>`;
  return {
    style: (selector: string) =>
      window.getComputedStyle(document.querySelector(selector)!),
    close: () => window.happyDOM.close(),
  };
}

test("on a phone the commit bar wraps within the screen, its words too", async () => {
  const page = render(true);
  try {
    const views = page.style(".diff-review-views");
    expect(views.flexWrap).toBe("wrap");
    expect(views.maxWidth).toBe("100%");
    expect(views.flexShrink).toBe("1");
    for (const selector of [
      ".diff-review-changed",
      ".diff-review-views-status",
    ]) {
      const banner = page.style(selector);
      expect(banner.maxWidth).toBe("100%");
      expect(["0", "0px"]).toContain(banner.minWidth);
      expect(banner.whiteSpace).toBe("normal");
      expect(page.style(`${selector} > span`).whiteSpace).toBe("normal");
    }
  } finally {
    await page.close();
  }
});

test("Reload and Retry never shrink: the words give way", async () => {
  for (const mobile of [true, false]) {
    const page = render(mobile);
    try {
      for (const selector of [
        ".diff-review-changed",
        ".diff-review-views-status",
      ]) {
        expect(page.style(`${selector} > button`).flexShrink).toBe("0");
        const words = page.style(`${selector} > span`);
        expect(["0", "0px"]).toContain(words.minWidth);
        expect(words.overflow).toBe("hidden");
      }
    } finally {
      await page.close();
    }
  }
});
