import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/**
 * Full width diffs: the files are drawn in a centred column unless the
 * setting is on (the review's view menu, :set wide). The view says which,
 * and how the diff is drawn, for its style sheet to size the column.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "full width diffs in an isolated DOM runtime",
    "ROAMGATE_WIDE_DIFFS_DOM_TEST",
    60_000,
  )
) {
  const { installChangesDom, mountChangesDiff, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const { act } = await import("react");
  const { setWideDiffs, wideDiffs } = await import("../wideDiffs");

  const a = entry("a.ts", "unstaged", "M");
  const patches = {
    "unstaged:a.ts":
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+deux\n",
  };
  const view = () => document.querySelector<HTMLElement>(".diff-content-view")!;
  const fullWidthItem = async () => {
    const button = document.querySelector<HTMLButtonElement>(
      ".diff-content-head .diff-view-menu .rv-menu-button",
    )!;
    await act(async () => button.click());
    return [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".rv-menu [role=menuitemcheckbox]",
      ),
    ].find((item) => item.textContent?.includes("Full width diffs"))!;
  };

  test("the diff is centred by default; the review's menu makes it full width and back", async () => {
    setWideDiffs(false);
    const diff = await mountChangesDiff({
      entries: [a],
      patches,
      reviewCursor: true,
    });
    try {
      expect(view().hasAttribute("data-wide-diffs")).toBe(false);
      expect(["split", "unified"]).toContain(view().dataset.diffStyle ?? "");
      let item = await fullWidthItem();
      expect(item.getAttribute("aria-checked")).toBe("false");
      await act(async () => item.click());
      expect(wideDiffs()).toBe(true);
      expect(view().hasAttribute("data-wide-diffs")).toBe(true);
      item = await fullWidthItem();
      expect(item.getAttribute("aria-checked")).toBe("true");
      await act(async () => item.click());
      expect(wideDiffs()).toBe(false);
      expect(view().hasAttribute("data-wide-diffs")).toBe(false);
    } finally {
      await diff.unmount();
      setWideDiffs(false);
    }
  }, 15_000);

  test("a choice made elsewhere (:set wide, another device) redraws the view", async () => {
    setWideDiffs(false);
    const diff = await mountChangesDiff({ entries: [a], patches });
    try {
      expect(view().hasAttribute("data-wide-diffs")).toBe(false);
      await act(async () => setWideDiffs(true));
      expect(view().hasAttribute("data-wide-diffs")).toBe(true);
      await act(async () => setWideDiffs(false));
      expect(view().hasAttribute("data-wide-diffs")).toBe(false);
    } finally {
      await diff.unmount();
      setWideDiffs(false);
    }
  });
}
