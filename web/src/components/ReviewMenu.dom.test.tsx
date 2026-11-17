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
  installTestDom({ width: 412, height: 915 });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { updateLayoutPreferences } = await import("../layoutPreferences");
  const { ReviewMenu } = await import("./ReviewMenu");
  // A desktop layout unless a test says phone (412 px is a phone's width).
  updateLayoutPreferences({ mode: "desktop" });

  /** The More menu in a review head, on the app's page unless `app` is false. */
  const mount = async ({ app = true }: { app?: boolean } = {}) => {
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
    const open = async () => {
      await act(async () => button.click());
      return document.querySelector<HTMLElement>(".rv-menu");
    };
    return {
      page,
      head,
      button,
      picked,
      open,
      async unmount() {
        await act(async () => root.unmount());
        page.remove();
      },
    };
  };

  test("the menu opens over the page, out of the head, and an item acts and closes it", async () => {
    const view = await mount();
    try {
      const menu = (await view.open())!;
      expect(menu).not.toBeNull();
      // Out of the head (which clips and scrolls), on the app's page.
      expect(view.head.contains(menu)).toBe(false);
      expect(view.page.contains(menu)).toBe(true);
      expect(menu.classList.contains("is-sheet")).toBe(false);
      // The first item has the focus; j and k move it.
      expect(document.activeElement?.textContent).toContain("GitLab mode");
      await act(async () => {
        menu.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        );
      });
      expect(document.activeElement?.textContent).toContain(
        "Open the merge request",
      );
      await act(async () => {
        menu.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", bubbles: true }),
        );
      });
      expect(document.activeElement?.textContent).toContain("GitLab mode");
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

  test("Esc and a press elsewhere close it", async () => {
    const view = await mount();
    try {
      const menu = (await view.open())!;
      await act(async () => {
        menu.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(document.querySelector(".rv-menu")).toBeNull();
      await view.open();
      // The popover listens for presses elsewhere from the next task on,
      // and closes on the press's click.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
      await act(async () => {
        document.body.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
      expect(document.querySelector(".rv-menu")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("on a phone, the menu is the app menu's bottom sheet", async () => {
    await act(async () => updateLayoutPreferences({ mode: "mobile" }));
    const view = await mount();
    try {
      const menu = (await view.open())!;
      expect(menu.classList.contains("is-sheet")).toBe(true);
      expect(menu.classList.contains("mobile-sheet")).toBe(true);
      expect(menu.querySelector(".mobile-sheet-handle")).not.toBeNull();
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
    const view = await mount({ app: false });
    try {
      const menu = (await view.open())!;
      expect(view.head.contains(menu)).toBe(true);
    } finally {
      await view.unmount();
    }
  });
}
