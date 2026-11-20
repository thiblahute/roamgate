import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * The Work board's scope and filters: the project of the workspace the
 * page shows (with its name in the head), a choice remembered for that
 * workspace, the tags as one row by count with Filters for the rest, the
 * search in the head and the first column right after the filter row.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Work board's scope and filters, in an isolated DOM runtime",
    "ROAMGATE_WORK_PANEL_DOM_TEST",
    30_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/?layout=mobile", width: 412 });
  const React = await import("react");
  const { act } = React;

  const item = (
    id: string,
    project: string,
    state: string,
    tags: string[],
  ) => ({
    id,
    project,
    title: `Item ${id}`,
    state,
    tags,
    links: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: `2026-11-20T10:00:${id.slice(0, 2)}.000Z`,
    by: "agent" as const,
  });
  const board = {
    projects: [
      {
        id: "gst2",
        name: "gst2",
        roots: [{ connectionId: "desktop", path: "/home/me/gstreamer/2.0" }],
        done: {
          kind: "branch",
          root: "/home/me/gstreamer/2.0",
          branch: "main",
        },
        tags: ["rfcs"],
      },
      {
        id: "roamgate",
        name: "roamgate",
        roots: [{ connectionId: "desktop", path: "/home/me/misc/roamgate" }],
        done: { kind: "deployed" },
      },
    ],
    items: [
      item("1100000000000000", "gst2", "you", ["caps", "pads"]),
      item("1200000000000000", "gst2", "doing", ["caps", "docs"]),
      item("1300000000000000", "gst2", "open", ["caps", "t1"]),
      item("1400000000000000", "gst2", "open", ["t2", "t3"]),
      item("1500000000000000", "gst2", "open", ["t4", "t5"]),
      item("1600000000000000", "gst2", "open", ["t6", "t7"]),
      item("1700000000000000", "gst2", "done", ["t8", "t9"]),
      item("2100000000000000", "roamgate", "you", ["reviews"]),
      item("2200000000000000", "roamgate", "open", ["voice"]),
    ],
  };
  let workspace: {
    connectionId: string;
    workspaceId: string;
    label: string;
    checkoutPath: string | null;
    repoRoot: string | null;
  } | null = {
    connectionId: "desktop",
    workspaceId: "w1",
    label: "gst2-caps",
    checkoutPath: "/home/me/gstreamer/2.0/gst2-caps",
    repoRoot: null,
  };
  const calls: [string, Record<string, unknown>][] = [];
  const workModule = await import("../work");
  mock.module("../work", () => ({
    ...workModule,
    useWorkBoard: () => ({ board, error: null, reload: async () => {} }),
    workCall: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return {};
    },
  }));
  const storeModule = await import("../store");
  mock.module("../store", () => ({
    ...storeModule,
    useStoreSelector: (selector: (state: unknown) => unknown) =>
      selector({
        activeConnectionId: workspace?.connectionId ?? "desktop",
        workspaces: workspace
          ? [
              {
                workspace_id: workspace.workspaceId,
                label: workspace.label,
                focused: true,
                worktree: workspace.checkoutPath
                  ? {
                      checkout_path: workspace.checkoutPath,
                      repo_root: workspace.repoRoot ?? workspace.checkoutPath,
                    }
                  : undefined,
              },
            ]
          : [],
      }),
  }));
  mock.module("./WorkItemThreads", () => ({
    WorkItemThreads: () => <div data-work-threads="" />,
  }));
  const { WorkPanel } = await import("./WorkPanel");
  const { createRoot } = await import("react-dom/client");

  async function mount(initialItem?: string) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let closed = 0;
    await act(async () =>
      root.render(
        <WorkPanel
          onClose={() => {
            closed++;
          }}
          initialItem={initialItem}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const panel = container.querySelector<HTMLElement>(".work-panel")!;
    const text = (selector: string) =>
      panel.querySelector(selector)?.textContent ?? null;
    const click = async (element: Element | null) => {
      if (!element) throw new Error("nothing to click");
      await act(async () => (element as HTMLElement).click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };
    const chips = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(".work-tags-strip .work-chip"),
      ].map((chip) => chip.textContent);
    const cards = () =>
      [...panel.querySelectorAll<HTMLElement>(".work-card")].map(
        (card) => card.dataset.workItem,
      );
    return {
      panel,
      text,
      click,
      chips,
      cards,
      closed: () => closed,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("the board is the workspace's project, its name in the head, the search in the head, the items right after one filter row", async () => {
    localStorage.clear();
    const board1 = await mount();
    try {
      expect(board1.text(".work-head .work-scope-name")).toBe("gst2-caps");
      expect(board1.text(".work-status")).toBe(
        "1 for you · 6 open · 2 for you in all",
      );
      // On a phone the search is an icon in the head; tapped, the head is
      // the box, closed back by its X.
      expect(
        board1.panel.querySelector(".work-head .work-search input"),
      ).toBeNull();
      await board1.click(
        board1.panel.querySelector(
          '.work-head button[aria-label="Search the items"]',
        ),
      );
      const search = board1.panel.querySelector<HTMLInputElement>(
        ".work-head .work-search input",
      )!;
      expect(search).not.toBeNull();
      expect(
        board1.panel.querySelector(".work-head .work-title"),
      ).not.toBeNull();
      expect(
        board1.panel
          .querySelector(".work-head")!
          .classList.contains("is-searching"),
      ).toBe(true);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(search, "13");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(board1.cards()).toEqual(["1300000000000000"]);
      await board1.click(
        board1.panel.querySelector(
          '.work-head button[aria-label="Close the search"]',
        ),
      );
      expect(
        board1.panel.querySelector(".work-head .work-search input"),
      ).toBeNull();
      expect(board1.cards()).toHaveLength(6);
      // One row: the project, the tags by count (at most 8), Filters.
      const select = board1.panel.querySelector<HTMLSelectElement>(
        ".work-filter-row .work-scope-select",
      )!;
      expect(select.value).toBe("gst2");
      expect([...select.options].map((option) => option.textContent)).toEqual([
        "All projects (8)",
        "gst2 (6)",
        "roamgate (2)",
      ]);
      expect(board1.chips()).toEqual([
        "caps",
        "docs",
        "pads",
        "t1",
        "t2",
        "t3",
        "t4",
        "t5",
      ]);
      expect(board1.panel.querySelectorAll(".work-filter-row").length).toBe(1);
      // The For you column is the next thing after the filter row.
      const body = board1.panel.querySelector(".work-body")!;
      const filters = body.querySelector(".work-filters")!;
      expect(
        filters.nextElementSibling?.classList.contains("work-columns"),
      ).toBe(true);
      expect(
        body
          .querySelector(".work-columns > .work-column")
          ?.getAttribute("aria-label"),
      ).toBe("For you");
      expect(board1.cards()).toEqual([
        "1100000000000000",
        "1200000000000000",
        "1600000000000000",
        "1500000000000000",
        "1400000000000000",
        "1300000000000000",
      ]);
      // A tag on the row filters; selected, it is removable and off the row.
      await board1.click(
        [
          ...board1.panel.querySelectorAll<HTMLElement>(
            ".work-tags-strip .work-chip",
          ),
        ].find((chip) => chip.textContent === "caps")!,
      );
      expect(board1.cards()).toEqual([
        "1100000000000000",
        "1200000000000000",
        "1300000000000000",
      ]);
      expect(board1.chips()[0]).toBe("caps");
      expect(
        board1.panel
          .querySelector(".work-tags-strip .work-chip")
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(board1.chips().filter((chip) => chip === "caps")).toHaveLength(1);
      expect(board1.text(".work-filters-button")).toBe("Filters1");
      // Filters: every tag with its count, searched; a pick adds to the filter.
      expect(board1.panel.querySelector("#work-filters-sheet")).toBeNull();
      await board1.click(board1.panel.querySelector(".work-filters-button"));
      const sheet = board1.panel.querySelector<HTMLElement>(
        "#work-filters-sheet",
      )!;
      expect(sheet.classList.contains("is-sheet")).toBe(true);
      const rows = () =>
        [
          ...sheet.querySelectorAll<HTMLElement>(".work-filters-list button"),
        ].map(
          (row) =>
            `${row.getAttribute("aria-checked") === "true" ? "*" : ""}${row.textContent}`,
        );
      expect(rows()).toEqual([
        "*caps3",
        "docs1",
        "pads1",
        "t11",
        "t21",
        "t31",
        "t41",
        "t51",
        "t61",
        "t71",
        "t81",
        "t91",
      ]);
      const find = sheet.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(find, "pad");
        find.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(rows()).toEqual(["pads1"]);
      await board1.click(sheet.querySelector(".work-filters-list button"));
      expect(board1.cards()).toEqual(["1100000000000000"]);
      expect(board1.text(".work-filters-button")).toBe("Filters2");
      // Clear takes every tag off; the sheet's close keeps the board.
      await board1.click(
        [
          ...sheet.querySelectorAll<HTMLElement>(".work-filters-head button"),
        ].find((button) => button.textContent?.startsWith("Clear"))!,
      );
      expect(board1.cards()).toHaveLength(6);
      await board1.click(
        sheet.querySelector(
          '.work-filters-head button[aria-label="Close the tag filters"]',
        ),
      );
      expect(board1.panel.querySelector("#work-filters-sheet")).toBeNull();
      expect(board1.closed()).toBe(0);
    } finally {
      await board1.unmount();
    }
  });

  test("another project or All chosen is remembered for the workspace; elsewhere the last choice; an item opens its own project", async () => {
    localStorage.clear();
    const first = await mount();
    try {
      const select =
        first.panel.querySelector<HTMLSelectElement>(".work-scope-select")!;
      await act(async () => {
        select.value = "all";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(first.text(".work-scope-name")).toBe("All projects");
      expect(first.text(".work-status")).toBe("2 for you · 8 open");
      // Every project: each card says its project.
      expect(
        [
          ...first.panel.querySelectorAll<HTMLElement>(
            ".work-card .work-project",
          ),
        ].map((chip) => chip.textContent),
      ).toContain("roamgate");
      expect(first.cards()).toHaveLength(8);
    } finally {
      await first.unmount();
    }
    // Again in the same workspace: still All.
    const again = await mount();
    try {
      expect(again.text(".work-scope-name")).toBe("All projects");
      expect(
        again.panel.querySelector<HTMLSelectElement>(".work-scope-select")!
          .value,
      ).toBe("all");
    } finally {
      await again.unmount();
    }
    // A roamgate workspace: its own project, the choice being gst2-caps's.
    workspace = {
      connectionId: "desktop",
      workspaceId: "w2",
      label: "work-view",
      checkoutPath: "/home/me/misc/roamgate.worktrees/work-view",
      repoRoot: "/home/me/misc/roamgate",
    };
    const other = await mount();
    try {
      expect(other.text(".work-scope-name")).toBe("work-view");
      expect(other.cards()).toEqual(["2100000000000000", "2200000000000000"]);
      expect(other.chips()).toEqual(["reviews", "voice"]);
    } finally {
      await other.unmount();
    }
    // A workspace in no project: the last choice (All).
    workspace = {
      connectionId: "desktop",
      workspaceId: "w3",
      label: "notes",
      checkoutPath: "/home/me/notes",
      repoRoot: null,
    };
    const elsewhere = await mount();
    try {
      expect(elsewhere.text(".work-scope-name")).toBe("All projects");
      const select =
        elsewhere.panel.querySelector<HTMLSelectElement>(".work-scope-select")!;
      await act(async () => {
        select.value = "gst2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(elsewhere.text(".work-scope-name")).toBe("gst2");
    } finally {
      await elsewhere.unmount();
    }
    // No workspace: the last choice (gst2).
    workspace = null;
    const none = await mount();
    try {
      expect(none.text(".work-scope-name")).toBe("gst2");
    } finally {
      await none.unmount();
    }
    // Opened on an item (a notification): its project, whatever was chosen.
    const onItem = await mount("2100000000000000");
    try {
      expect(onItem.text(".work-scope-name")).toBe("roamgate");
      expect(
        onItem.panel
          .querySelector(".work-card.is-selected")
          ?.getAttribute("data-work-item"),
      ).toBe("2100000000000000");
    } finally {
      await onItem.unmount();
    }
    expect(JSON.parse(localStorage.getItem("roamgate.work.scope")!)).toEqual({
      last: "gst2",
      byWorkspace: {
        "desktop:/home/me/gstreamer/2.0/gst2-caps": "all",
        "desktop:/home/me/notes": "gst2",
      },
    });
  });
}
