import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/**
 * The review head's menus (More, the view menu, the agent's chip): opened
 * over the page next to their button and inside the window, whatever the
 * head they sit in does (a container, a sliding view, a scrolled row); on a
 * phone, the app menu's bottom sheet.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the review's menus in an isolated DOM runtime",
    "ROAMGATE_REVIEW_MENU_DOM_TEST",
    20_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  const { browser } = installTestDom({ width: 412, height: 915 });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { updateLayoutPreferences } = await import("../layoutPreferences");
  const { ReviewMenu } = await import("./ReviewMenu");
  // A desktop layout unless a test says phone (412 px is a phone's width).
  updateLayoutPreferences({ mode: "desktop" });

  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;

  /**
   * The More menu at a phone's head: its button 30 px wide at `buttonLeft`,
   * the menu 240 x 90; a fixed box placed `shift` px left of where its
   * style says, as a sliding view (the phone's drill-in) does.
   */
  const mount = async ({
    app = true,
    buttonLeft,
    shift = 0,
  }: {
    app?: boolean;
    buttonLeft: number;
    shift?: number;
  }) => {
    const page = document.createElement("div");
    if (app) page.className = "app";
    const head = document.createElement("div");
    head.className = "diff-content-head";
    page.append(head);
    document.body.append(page);
    const root = createRoot(head);
    const picked: string[] = [];
    await act(async () =>
      root.render(
        createElement(ReviewMenu, {
          className: "diff-forge-more",
          title: "More",
          label: "...",
          items: [
            { label: "GitLab mode", checked: true, onSelect: () => {} },
            {
              label: "Open the merge request on GitLab",
              onSelect: () => picked.push("open"),
            },
            { label: "Copy the review as Markdown", onSelect: () => {} },
          ],
        }),
      ),
    );
    const button = head.querySelector<HTMLButtonElement>(".rv-menu-button")!;
    button.getBoundingClientRect = () => rect(buttonLeft, 100, 30, 26);
    const proto = browser.HTMLDivElement.prototype as unknown as HTMLElement;
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains("rv-menu"))
        return original.call(this) as DOMRect;
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return rect(left - shift, top, 240, 90);
    };
    const open = async () => {
      await act(async () => button.click());
      return document.querySelector<HTMLElement>(".rv-menu");
    };
    return {
      page,
      head,
      picked,
      open,
      async unmount() {
        proto.getBoundingClientRect = original;
        await act(async () => root.unmount());
        page.remove();
      },
    };
  };

  test("the menu opens over the page, out of the head, under its button and on the screen", async () => {
    const view = await mount({ buttonLeft: 10 });
    try {
      const menu = (await view.open())!;
      expect(menu).not.toBeNull();
      // Out of the head (which clips and scrolls), on the app's page.
      expect(view.head.contains(menu)).toBe(false);
      expect(menu.parentElement).toBe(view.page);
      const box = menu.getBoundingClientRect();
      expect(box.left).toBe(8);
      expect(box.right).toBeLessThanOrEqual(412 - 8);
      expect(box.top).toBe(130);
      expect(menu.classList.contains("is-sheet")).toBe(false);
      // An item still acts and closes the menu.
      const item = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
        (each) => each.textContent?.includes("Open the merge request"),
      )!;
      await act(async () => item.click());
      expect(view.picked).toEqual(["open"]);
      expect(document.querySelector(".rv-menu")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a head that moves fixed boxes (a sliding view) does not move the menu off the screen", async () => {
    // The phone's drill-in slides its track 412 px left: a box placed by
    // its style alone would open at -320.
    const view = await mount({ buttonLeft: 330, shift: 412 });
    try {
      const menu = (await view.open())!;
      const box = menu.getBoundingClientRect();
      expect(box.right).toBe(360);
      expect(box.left).toBe(120);
    } finally {
      await view.unmount();
    }
  });

  test("Esc and a press elsewhere close it", async () => {
    const view = await mount({ buttonLeft: 300 });
    try {
      const menu = (await view.open())!;
      await act(async () => {
        menu.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(document.querySelector(".rv-menu")).toBeNull();
      await view.open();
      await act(async () => {
        document.body.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
      });
      expect(document.querySelector(".rv-menu")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("on a phone, the menu is the app menu's bottom sheet", async () => {
    await act(async () => updateLayoutPreferences({ mode: "mobile" }));
    const view = await mount({ buttonLeft: 330, shift: 412 });
    try {
      const menu = (await view.open())!;
      expect(menu.classList.contains("is-sheet")).toBe(true);
      expect(menu.classList.contains("mobile-sheet")).toBe(true);
      expect(menu.querySelector(".mobile-sheet-handle")).not.toBeNull();
      // Its place is the sheet's (CSS), never a computed one.
      expect(menu.style.left).toBe("");
      expect(
        [...menu.querySelectorAll("[role^=menuitem]")].map(
          (each) => each.querySelector(".rv-menu-label")?.textContent,
        ),
      ).toEqual([
        "GitLab mode",
        "Open the merge request on GitLab",
        "Copy the review as Markdown",
      ]);
    } finally {
      await view.unmount();
      await act(async () => updateLayoutPreferences({ mode: "desktop" }));
    }
  });

  test("with no app page around it (a bare mount), the menu stays in the head", async () => {
    const view = await mount({ app: false, buttonLeft: 300 });
    try {
      const menu = (await view.open())!;
      expect(view.head.contains(menu)).toBe(true);
    } finally {
      await view.unmount();
    }
  });
}
