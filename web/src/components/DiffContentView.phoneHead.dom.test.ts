import { expect, test } from "bun:test";

/**
 * The review's head on a phone or in a narrow inspector (Changes' `mobile`):
 * the review on one line, its controls on one row under it with Back
 * first; long lines wrapped until the reader says otherwise. A desktop's
 * head stays one row.
 */
if (process.env.ROAMGATE_PHONE_HEAD_DOM_TEST !== "1") {
  test("the review's phone head in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PHONE_HEAD_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 60_000);
} else {
  const { installChangesDom, mountChangesDiff, entry } = await import(
    "./changesSurface.testkit"
  );
  await installChangesDom();
  const { act } = await import("react");
  const { roamgateLocalStorage } = await import("../browserStorage");

  const a = entry("a.ts", "unstaged", "M");
  const patches = {
    "unstaged:a.ts":
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+deux\n",
  };
  const head = () => document.querySelector<HTMLElement>(".diff-content-head")!;
  const back = { label: "Changed files", onClick: () => {} };
  const wrapItem = async () => {
    const button = head().querySelector<HTMLButtonElement>(
      ".diff-view-menu .rv-menu-button",
    );
    if (!button) return null;
    await act(async () => button.click());
    const item = document.querySelector<HTMLButtonElement>(
      ".rv-menu [role=menuitemcheckbox]",
    )!;
    return item;
  };

  test("on a phone, the review is one line and its controls one row under it, Back first", async () => {
    roamgateLocalStorage.removeItem("mobileDiffWrap");
    const diff = await mountChangesDiff({
      entries: [a],
      patches,
      reviewCursor: true,
      mobile: true,
      backAction: back,
    });
    try {
      const children = [...head().children];
      // The review's line, then the row: nothing else, so never a row
      // holding only Back.
      expect(children.map((each) => each.className)).toEqual([
        "diff-content-title",
        "diff-review-row",
      ]);
      const row = head().querySelector(".diff-review-row")!;
      expect(row.firstElementChild?.getAttribute("aria-label")).toBe(
        "Changed files",
      );
      expect(row.contains(head().querySelector(".diff-view-menu"))).toBe(true);
      // The view menu holds Wrap: no Wrap button of its own in the row.
      expect(head().querySelector(".diff-wrap-toggle")).toBeNull();
    } finally {
      await diff.unmount();
    }
  });

  test("a review on a phone wraps its long lines until Wrap is turned off, which is remembered", async () => {
    roamgateLocalStorage.removeItem("mobileDiffWrap");
    const diff = await mountChangesDiff({
      entries: [a],
      patches,
      reviewCursor: true,
      mobile: true,
    });
    try {
      let item = (await wrapItem())!;
      expect(item.textContent).toContain("Wrap long lines");
      expect(item.getAttribute("aria-checked")).toBe("true");
      // Only a choice is remembered: opening the review wrote nothing.
      expect(roamgateLocalStorage.getItem("mobileDiffWrap")).toBeNull();
      await act(async () => item.click());
      expect(roamgateLocalStorage.getItem("mobileDiffWrap")).toBe("false");
      item = (await wrapItem())!;
      expect(item.getAttribute("aria-checked")).toBe("false");
      await act(async () => item.click());
      expect(roamgateLocalStorage.getItem("mobileDiffWrap")).toBe("true");
    } finally {
      await diff.unmount();
      roamgateLocalStorage.removeItem("mobileDiffWrap");
    }
  });

  test("a phone's diff that is not the review keeps its Wrap button, off until turned on", async () => {
    roamgateLocalStorage.removeItem("mobileDiffWrap");
    const diff = await mountChangesDiff({
      entries: [a],
      patches,
      mobile: true,
      backAction: back,
    });
    try {
      expect(head().querySelector(".diff-review-row")).toBeNull();
      expect(diff.wrap()).toBe(false);
    } finally {
      await diff.unmount();
    }
  });

  test("on a desktop, the review's head stays one row, as it was", async () => {
    const diff = await mountChangesDiff({
      entries: [a],
      patches,
      reviewCursor: true,
    });
    try {
      expect(head().querySelector(".diff-review-row")).toBeNull();
      expect(head().querySelector(".diff-content-back")).toBeNull();
      expect(
        head().querySelector(":scope > .diff-content-title"),
      ).not.toBeNull();
      // Its view menu: side by side, unified, Wrap.
      const button = head().querySelector<HTMLButtonElement>(
        ".diff-view-menu .rv-menu-button",
      )!;
      await act(async () => button.click());
      expect(
        [...document.querySelectorAll(".rv-menu .rv-menu-label")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["Split", "Unified", "Wrap"]);
    } finally {
      await diff.unmount();
    }
  });
}
