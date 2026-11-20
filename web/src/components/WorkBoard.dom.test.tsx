import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * The board view's Work mode: the inbox's panel, head and columns with
 * the work items as content. The mode switch in the head and by [ ]; the
 * columns are the view's lanes (side by side on a wide pane), the cards
 * its card frame; j/k/h/l, Enter opens the item's detail (its
 * description, state, tags, thread) in the view, Esc goes back; a adds
 * an item with a description and images; the scope and filters: the
 * project of the workspace the page shows, remembered choices, the tags.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the board view's Work mode, in an isolated DOM runtime",
    "ROAMGATE_WORK_BOARD_DOM_TEST",
    40_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/", width: 1280 });
  // A wide pane: the columns stand side by side.
  (HTMLElement.prototype as any).getBoundingClientRect = function () {
    return {
      width: this.classList?.contains("mr-reviews-panel") ? 1280 : 100,
      height: 800,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON() {},
    };
  };
  const React = await import("react");
  const { act } = React;

  const item = (
    id: string,
    project: string,
    state: string,
    tags: string[],
    extra: Record<string, unknown> = {},
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
    ...extra,
  });
  const board: {
    projects: Record<string, unknown>[];
    items: ReturnType<typeof item>[];
  } = {
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
        coordinator: { session: "desktop/w32:p1" },
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
      item("1200000000000000", "gst2", "doing", ["caps", "docs"], {
        owner: { session: "desktop/w32:p1", task: "abc12345" },
        links: [{ kind: "commit", sha: "abcdef1234", subject: "Fix caps" }],
      }),
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
      if (method !== "add") return {};
      const made = item("3300000000000000", "gst2", "open", []);
      board.items = [...board.items, made];
      return { item: made };
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
  const threadsModule = await import("./WorkItemThreads");
  mock.module("./WorkItemThreads", () => ({
    ...threadsModule,
    useWorkItemThreads: () => ({
      snapshot: undefined,
      threads: [
        {
          id: "d000000000000001",
          sessionId: "r000000000000001",
          kind: "discussion",
          anchor: { work: { item: "1200000000000000", description: true } },
          comments: [
            {
              id: "c000000000000001",
              author: "you",
              body: "The long description, with a picture.",
              createdAt: "2026-11-20T10:00:01.000Z",
              updatedAt: "2026-11-20T10:00:01.000Z",
            },
          ],
          resolved: false,
          createdAt: "2026-11-20T10:00:01.000Z",
          updatedAt: "2026-11-20T10:00:01.000Z",
        },
      ],
      open: 1,
      waiting: null,
      write: async () => true,
      addImage: async () => "",
      send: async () => true,
      pendingById: new Map(),
      undelivered: new Set(),
      error: "",
    }),
    WorkItemThreads: (props: { description?: { id: string } | null }) => (
      <div data-work-threads={props.description?.id ?? ""} />
    ),
  }));
  mock.module("./ReviewCommentEditorLazy", () => ({
    ReviewCommentEditorLazy: (props: {
      label?: string;
      onChange: (text: string) => void;
    }) => (
      <textarea
        aria-label={props.label}
        onChange={(event) => props.onChange(event.target.value)}
      />
    ),
  }));
  const { bridge } = await import("../api");
  const original = bridge.call.bind(bridge);
  bridge.call = (async (method: string, ...rest: unknown[]) =>
    method.startsWith("bridge.mr_reviews.")
      ? { entries: [], order: [], hosts: [], views: [] }
      : original(method, ...(rest as []))) as typeof bridge.call;
  bridge.onMrReviews = (() => () => {}) as typeof bridge.onMrReviews;
  const { MrReviewsPanel } = await import("./MrReviewsPanel");
  const { createRoot } = await import("react-dom/client");

  async function mount(
    props: { initialWorkItem?: string; mode?: "work" | "mr" } = {},
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let closed = 0;
    await act(async () =>
      root.render(
        <MrReviewsPanel
          mode={props.mode ?? "work"}
          onClose={() => {
            closed++;
          }}
          {...(props.initialWorkItem
            ? { initialWorkItem: props.initialWorkItem }
            : {})}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const panel = container.querySelector<HTMLElement>(".mr-reviews-panel")!;
    const text = (selector: string) =>
      panel.querySelector(selector)?.textContent ?? null;
    const click = async (element: Element | null) => {
      if (!element) throw new Error("nothing to click");
      await act(async () => (element as HTMLElement).click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };
    const key = async (key: string, extra: KeyboardEventInit = {}) => {
      await act(async () => {
        (document.activeElement ?? panel).dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...extra,
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };
    const type = async (
      input: HTMLInputElement | HTMLTextAreaElement,
      value: string,
    ) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const chips = () =>
      [
        ...panel.querySelectorAll<HTMLElement>(".work-tags-strip .work-chip"),
      ].map((chip) => chip.textContent);
    const cards = () =>
      [...panel.querySelectorAll<HTMLElement>("[data-work-item]")].map(
        (card) => card.dataset.workItem,
      );
    const selected = () =>
      panel.querySelector<HTMLElement>("[data-work-item][aria-current='true']")
        ?.dataset.workItem ?? null;
    return {
      panel,
      text,
      click,
      key,
      type,
      chips,
      cards,
      selected,
      closed: () => closed,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("the inbox's panel and columns hold the work items; [ ] and the head switch modes; keys walk, open the detail, add", async () => {
    localStorage.clear();
    calls.length = 0;
    const view = await mount();
    try {
      // The view's own shell: floating, in Work mode, the modes in its head.
      expect(view.panel.getAttribute("aria-label")).toBe("Work");
      expect(view.panel.classList.contains("is-floating")).toBe(true);
      expect(view.panel.classList.contains("is-work")).toBe(true);
      expect(view.panel.classList.contains("is-board")).toBe(true);
      const modes = () =>
        [
          ...view.panel.querySelectorAll<HTMLButtonElement>(
            ".assistant-panel-head .mr-reviews-modes button",
          ),
        ].map(
          (button) =>
            `${button.getAttribute("aria-pressed") === "true" ? "*" : ""}${button.textContent}`,
        );
      // The Work tab wears the For you count of every project.
      expect(modes()).toEqual(["*Work2", "Reviews"]);
      expect(view.text(".assistant-panel-meta .work-scope-name")).toBe(
        "gst2-caps",
      );
      expect(view.text(".assistant-panel-meta .work-status")).toBe(
        "1 for you · 6 open · 2 for you in all",
      );
      expect(
        view.panel.querySelector('button[aria-label="Close Work (Esc)"]'),
      ).not.toBeNull();
      expect(
        view.panel.querySelector('button[aria-label="Maximize Work"]'),
      ).not.toBeNull();
      // The search and the filter row, then the columns: the inbox's
      // board, its lanes, its cards.
      const body = view.panel.querySelector(".mr-reviews-body.is-work")!;
      expect(body.querySelector(".mr-reviews-search")).not.toBeNull();
      expect(
        body.querySelector(".work-filter-row")?.nextElementSibling?.className,
      ).toBe("mr-reviews-board");
      const lanes = () =>
        [
          ...body.querySelectorAll<HTMLElement>(
            ".mr-reviews-board > .mr-reviews-lane",
          ),
        ].map(
          (lane) =>
            `${lane.dataset.workColumn}${lane.classList.contains("is-folded") ? "-" : ""}:${lane.querySelectorAll("[data-work-item]").length}`,
        );
      expect(lanes()).toEqual([
        "you:1",
        "doing:1",
        "verify:0",
        "open:4",
        "done-:0",
      ]);
      expect(
        body.querySelector(".mr-reviews-lane .mr-reviews-lane-title")
          ?.textContent,
      ).toBe("For you1");
      expect(
        body.querySelector(
          ".mr-reviews-lane > .assistant-task-list > .mr-reviews-item > .mr-reviews-row[data-work-item]",
        ),
      ).not.toBeNull();
      // A card: its title, tags, owner and links as the inbox's chips.
      const doing = body.querySelector("[data-work-item='1200000000000000']")!;
      expect(
        doing.querySelector(".mr-reviews-dense-head strong")?.textContent,
      ).toBe("Item 1200000000000000");
      expect(
        [...doing.querySelectorAll(".mr-reviews-chip")].map(
          (chip) => chip.textContent,
        ),
      ).toEqual([
        "caps",
        "docs",
        "desktop/w32:p1 · abc12345",
        "abcdef1234 Fix caps",
      ]);

      // j selects the first card; l the column beside; k stays in it.
      await view.key("j");
      expect(view.selected()).toBe("1100000000000000");
      await view.key("l");
      expect(view.selected()).toBe("1200000000000000");
      await view.key("l");
      expect(view.selected()).toBe("1600000000000000");
      await view.key("j");
      expect(view.selected()).toBe("1500000000000000");
      await view.key("k");
      expect(view.selected()).toBe("1600000000000000");
      await view.key("h");
      expect(view.selected()).toBe("1200000000000000");
      // za folds its column; the keys skip it; za again unfolds it.
      await view.key("z");
      await view.key("a");
      expect(lanes()[1]).toBe("doing-:0");
      await view.key("z");
      await view.key("a");
      expect(lanes()[1]).toBe("doing:1");
      // Enter opens the item's detail in the view, as a request's.
      await view.key("Enter");
      const detail = () =>
        view.panel.querySelector<HTMLElement>(".work-detail[data-work-detail]");
      expect(detail()).not.toBeNull();
      expect(detail()!.dataset.workDetail).toBe("1200000000000000");
      expect(view.panel.querySelector(".mr-reviews-board")).toBeNull();
      expect(view.text(".assistant-section-heading button")).toBe(" All items");
      expect(view.text(".work-detail .assistant-task-heading h3")).toBe(
        "Item 1200000000000000",
      );
      expect(view.text(".work-detail .assistant-task-state")).toBe("Doing");
      // Its description is the first comment of its description thread;
      // the thread list leaves it out.
      expect(view.text(".work-detail .work-description")).toContain(
        "The long description",
      );
      expect(
        view.panel.querySelector<HTMLElement>("[data-work-threads]")?.dataset
          .workThreads,
      ).toBe("d000000000000001");
      expect(
        view.panel.querySelector<HTMLSelectElement>(
          ".work-detail select[aria-label='State (s)']",
        )?.value,
      ).toBe("doing");
      expect(view.text(".work-detail .work-owner")).toBe(
        "desktop/w32:p1 · abc12345",
      );
      // dd in the detail: done.
      await view.key("d");
      await view.key("d");
      expect(calls[calls.length - 1]).toEqual(["done", { item: "1200000000000000" }]);
      // Esc goes back to the board, the card still selected.
      await view.key("Escape");
      expect(detail()).toBeNull();
      expect(view.selected()).toBe("1200000000000000");
      // Esc clears the selection, then closes the view.
      await view.key("Escape");
      expect(view.selected()).toBeNull();
      expect(view.closed()).toBe(0);
      await view.key("Escape");
      expect(view.closed()).toBe(1);

      // ] switches to the inbox, [ back; the head's buttons too.
      await view.key("]");
      expect(view.panel.classList.contains("is-mr")).toBe(true);
      expect(view.panel.getAttribute("aria-label")).toBe("Reviews");
      expect(modes()).toEqual(["Work2", "*Reviews"]);
      expect(view.panel.querySelector(".mr-reviews-body.is-work")).toBeNull();
      expect(
        view.panel.querySelector(
          ".assistant-panel-meta .assistant-primary-nav",
        ),
      ).not.toBeNull();
      await view.key("[");
      expect(view.panel.classList.contains("is-work")).toBe(true);
      await view.click(
        view.panel.querySelector(".mr-reviews-modes button:last-child"),
      );
      expect(view.panel.classList.contains("is-mr")).toBe(true);
      await view.click(
        view.panel.querySelector(".mr-reviews-modes button:first-child"),
      );
      expect(view.panel.classList.contains("is-work")).toBe(true);
      expect(localStorage.getItem("roamgate:mrReviewsMode")).toBe("work");

      // a opens the form in the view: a title, a description, state and
      // tags; Add sends them (the description as the item's text).
      await view.key("a");
      const form = () =>
        view.panel.querySelector<HTMLFormElement>("form.work-add");
      expect(form()).not.toBeNull();
      expect(form()!.getAttribute("aria-label")).toBe("Add an item to gst2");
      await view.type(
        form()!.querySelector<HTMLInputElement>("input[aria-label='Title']")!,
        "Copy a picture",
      );
      await view.type(
        form()!.querySelector<HTMLTextAreaElement>(
          "textarea[aria-label='Description']",
        )!,
        "Paste one here.",
      );
      await view.type(
        form()!.querySelector<HTMLInputElement>("input[aria-label='Tags']")!,
        "board, images",
      );
      await act(async () => {
        form()!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(calls[calls.length - 1]).toEqual([
        "add",
        {
          title: "Copy a picture",
          state: "open",
          tags: ["board", "images"],
          text: "Paste one here.",
          project: "gst2",
        },
      ]);
      expect(form()).toBeNull();
      // The new item is the selected one.
      expect(view.selected()).toBe("3300000000000000");
    } finally {
      await view.unmount();
    }
  });

  test("the scope and the filters: the workspace's project, the tags row, every tag; a choice is remembered; an item opens its project and its detail", async () => {
    localStorage.clear();
    // The board as given, without the item the first test added.
    board.items = board.items.filter((each) => each.id !== "3300000000000000");
    const first = await mount();
    try {
      const select = first.panel.querySelector<HTMLSelectElement>(
        ".work-filter-row .work-scope-select",
      )!;
      expect(select.value).toBe("gst2");
      expect([...select.options].map((option) => option.textContent)).toEqual([
        "All projects (8)",
        "gst2 (6)",
        "roamgate (2)",
      ]);
      expect(first.chips()).toEqual([
        "caps",
        "docs",
        "pads",
        "t1",
        "t2",
        "t3",
        "t4",
        "t5",
      ]);
      // A tag on the row filters; selected, it is removable and off the row.
      await first.click(
        [
          ...first.panel.querySelectorAll<HTMLElement>(
            ".work-tags-strip .work-chip",
          ),
        ].find((chip) => chip.textContent === "caps")!,
      );
      expect(first.cards()).toEqual([
        "1100000000000000",
        "1200000000000000",
        "1300000000000000",
      ]);
      expect(first.text(".work-filters-button")).toBe("Filters1");
      // Filters: every tag with its count, searched.
      await first.click(first.panel.querySelector(".work-filters-button"));
      const sheet = first.panel.querySelector<HTMLElement>(
        "#work-filters-sheet",
      )!;
      expect(sheet.classList.contains("is-sheet")).toBe(false);
      const rows = () =>
        [
          ...sheet.querySelectorAll<HTMLElement>(".work-filters-list button"),
        ].map(
          (row) =>
            `${row.getAttribute("aria-checked") === "true" ? "*" : ""}${row.textContent}`,
        );
      expect(rows().slice(0, 3)).toEqual(["*caps3", "docs1", "pads1"]);
      await first.type(sheet.querySelector<HTMLInputElement>("input")!, "pad");
      expect(rows()).toEqual(["pads1"]);
      await first.click(sheet.querySelector(".work-filters-list button"));
      expect(first.cards()).toEqual(["1100000000000000"]);
      await first.key("Escape");
      expect(first.panel.querySelector("#work-filters-sheet")).toBeNull();
      // The search box: words, then Enter selects the first found.
      await first.click(
        [
          ...first.panel.querySelectorAll<HTMLElement>(
            ".work-tags-strip .work-chip",
          ),
        ].find((chip) => chip.textContent?.startsWith("caps"))!,
      );
      await first.click(
        [
          ...first.panel.querySelectorAll<HTMLElement>(
            ".work-tags-strip .work-chip",
          ),
        ].find((chip) => chip.textContent?.startsWith("pads"))!,
      );
      const search =
        first.panel.querySelector<HTMLInputElement>(".mr-reviews-search")!;
      await first.type(search, "13");
      expect(first.cards()).toEqual(["1300000000000000"]);
      search.focus();
      await first.key("Enter");
      expect(first.selected()).toBe("1300000000000000");
      await first.type(search, "");
      // All projects: each card says its project.
      await act(async () => {
        select.value = "all";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(first.text(".work-scope-name")).toBe("All projects");
      expect(first.text(".work-status")).toBe("2 for you · 8 open");
      expect(
        [
          ...first.panel.querySelectorAll<HTMLElement>(
            "[data-work-item] .mr-reviews-chip.is-tree",
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
    } finally {
      await again.unmount();
    }
    // A roamgate workspace: its own project.
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
    } finally {
      await other.unmount();
    }
    // Opened on an item (a notification): its project, its detail shown.
    workspace = null;
    const onItem = await mount({ initialWorkItem: "1700000000000000" });
    try {
      expect(onItem.text(".work-scope-name")).toBe("gst2");
      expect(
        onItem.panel.querySelector<HTMLElement>(".work-detail")?.dataset
          .workDetail,
      ).toBe("1700000000000000");
      expect(onItem.text(".work-detail .assistant-task-state")).toBe("Done");
      // Back: its column (Done, folded by default) was unfolded for it.
      await onItem.key("Escape");
      expect(onItem.selected()).toBe("1700000000000000");
      expect(
        onItem.panel
          .querySelector("[data-work-column='done']")
          ?.classList.contains("is-folded"),
      ).toBe(false);
    } finally {
      await onItem.unmount();
    }
    expect(JSON.parse(localStorage.getItem("roamgate.work.scope")!)).toEqual({
      last: "all",
      byWorkspace: {
        "desktop:/home/me/gstreamer/2.0/gst2-caps": "all",
      },
    });
  });
}
