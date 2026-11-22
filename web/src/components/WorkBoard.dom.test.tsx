import { expect, jest, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * The board view's Work mode: the inbox's panel, head and columns with
 * the work items as content. The mode switch in the head and by [ ]; the
 * columns are the view's lanes (side by side on a wide pane), the cards
 * its card frame; j/k/h/l, Enter opens the item's detail (its
 * description, state, tags, thread) in the view, Esc goes back; a adds
 * an item from free text and images; the scope and the search (#tag): the
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
      item("1300000000000000", "gst2", "open", ["caps", "t1"], {
        needsTriage: true,
      }),
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
    /** Its panes: the coordinator's makes it the coordinator's workspace. */
    panes?: { pane_id: string; cwd?: string }[];
  } | null = {
    connectionId: "desktop",
    workspaceId: "w1",
    label: "gst2-caps",
    checkoutPath: "/home/me/gstreamer/2.0/gst2-caps",
    repoRoot: null,
    // The gst2 coordinator's workspace: its board is the whole project.
    panes: [{ pane_id: "w32:p1" }],
  };
  const calls: [string, Record<string, unknown>][] = [];
  /** The board's readers: a push (an agent's change) draws them again. */
  const boardReaders = new Set<() => void>();
  const pushBoard = async () => {
    await act(async () => {
      for (const reader of boardReaders) reader();
    });
  };
  /** The next add's item is not on the board's read yet (a push brings it). */
  let addUnread = false;
  /** While set, the next add fails with these words. */
  let addFails: string | null = null;
  const workModule = await import("../work");
  mock.module("../work", () => ({
    ...workModule,
    useWorkBoard: () => {
      const [, setRead] = React.useState(0);
      React.useEffect(() => {
        const reader = () => setRead((count) => count + 1);
        boardReaders.add(reader);
        return () => {
          boardReaders.delete(reader);
        };
      }, []);
      return { board, error: null, reload: async () => {} };
    },
    workCall: async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "link_target") {
        // The server finds the checkout: the link's root, else the
        // project's; a commit in none says so plainly.
        const link = params.link as {
          kind: string;
          root?: string;
          sha?: string;
          path?: string;
        };
        if (link.kind === "file")
          return {
            target: {
              connectionId: link.path === "far.md" ? "mac" : "desktop",
              root: link.root ?? "/src/gst2",
              path: link.path,
            },
          };
        if (link.sha === "62d3530630000000")
          throw new Error(
            "This commit is not in any of the project's repositories",
          );
        return {
          target: {
            connectionId: "desktop",
            root: link.root ?? "/src/gst2",
          },
        };
      }
      if (method === "owner_target")
        return {
          target: {
            connectionId: "desktop",
            runtimeGeneration: 1,
            workspaceId: "w9",
            paneId: "w9:p1",
          },
        };
      if (method !== "add") return {};
      if (addFails) {
        const why = addFails;
        addFails = null;
        throw new Error(why);
      }
      // Free text: the coordinator owns it, to sort.
      const made = item("3300000000000000", "gst2", "open", [], {
        title: String(params.text ?? "").split("\n")[0],
        owner: { session: "desktop/w32:p1" },
        needsTriage: true,
      });
      if (!addUnread) board.items = [...board.items, made];
      return { item: made };
    },
  }));
  const storeModule = await import("../store");
  /** The page's workspaces: the focused one, and more a test adds. */
  let moreWorkspaces: {
    workspace_id: string;
    label: string;
    worktree: { checkout_path: string; repo_root: string };
  }[] = [];
  const pageWorkspaces = () => [
    ...(workspace
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
      : []),
    ...moreWorkspaces,
  ];
  const realStore = storeModule.store;
  mock.module("../store", () => ({
    ...storeModule,
    store: new Proxy(realStore, {
      get: (target, key) =>
        key === "get"
          ? () => ({ ...target.get(), workspaces: pageWorkspaces() })
          : Reflect.get(target, key),
    }),
    useStoreSelector: (selector: (state: unknown) => unknown) =>
      selector({
        activeConnectionId: workspace?.connectionId ?? "desktop",
        workspaces: pageWorkspaces(),
        panes: (workspace?.panes ?? []).map((pane) => ({
          ...pane,
          workspace_id: workspace?.workspaceId,
        })),
      }),
  }));
  const threadsModule = await import("./WorkItemThreads");
  /** The answers tapped on a card: the item and the comment's words. */
  const posted: [string, string][] = [];
  /** While set, a post waits for it: an answer being sent. */
  let postGate: Promise<void> | null = null;
  mock.module("./WorkItemThreads", () => ({
    ...threadsModule,
    postWorkItemComment: async (item: string, text: string) => {
      posted.push([item, text]);
      if (postGate) await postGate;
    },
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
      cursor: null,
      setCursor: () => {},
      partDraft: null,
      setPartDraft: () => {},
      flipped: new Set(),
      toggleFold: () => {},
      replying: null,
      setReplying: () => {},
    }),
    WorkItemThreads: (props: { description?: { id: string } | null }) => (
      <div data-work-threads={props.description?.id ?? ""} />
    ),
    WorkDescription: (props: { thread: { comments: { body: string }[] } }) => (
      <div className="work-description">{props.thread.comments[0]?.body}</div>
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
  /** More of the inbox: its efforts, its requests. */
  let inboxMore: Record<string, unknown> = {};
  const reviewedCommits: [string, unknown][] = [];
  const reviewedBranches: [string, unknown][] = [];
  const reviewOpenModule = await import("../reviewOpen");
  mock.module("../reviewOpen", () => ({
    ...reviewOpenModule,
    openCommitReview: async (sha: string, options: unknown) => {
      reviewedCommits.push([sha, options]);
      return null;
    },
    openBranchReview: async (branch: string, options: unknown) => {
      reviewedBranches.push([branch, options]);
      return null;
    },
  }));
  const { bridge } = await import("../api");
  const original = bridge.call.bind(bridge);
  bridge.call = (async (method: string, ...rest: unknown[]) => {
    // An effort's view reads nothing here: it says so.
    if (method.startsWith("bridge.mr_reviews.effort."))
      throw new Error("no effort here");
    return method.startsWith("bridge.mr_reviews.")
      ? { entries: [], order: [], hosts: [], views: [], ...inboxMore }
      : original(method, ...(rest as []));
  }) as typeof bridge.call;
  bridge.onMrReviews = (() => () => {}) as typeof bridge.onMrReviews;
  const { MrReviewsPanel } = await import("./MrReviewsPanel");
  const { createRoot } = await import("react-dom/client");

  async function mount(
    props: {
      initialWorkItem?: string;
      mode?: "work" | "mr";
      initialWork?: import("../workOpen").WorkOpen;
    } = {},
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let closed = 0;
    const closes: unknown[] = [];
    await act(async () =>
      root.render(
        <MrReviewsPanel
          mode={props.mode ?? "work"}
          onClose={(options) => {
            closed++;
            closes.push(options);
          }}
          {...(props.initialWorkItem
            ? { initialWorkItem: props.initialWorkItem }
            : {})}
          {...(props.initialWork ? { initialWork: props.initialWork } : {})}
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
      cards,
      selected,
      closed: () => closed,
      closes,
      pushBoard,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("the inbox's panel and columns hold the work items; [ ] and the head switch modes; keys walk, open the detail, add", async () => {
    localStorage.clear();
    sessionStorage.clear();
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
      ).toEqual(["caps", "docs", "desktop/w32:p1 · abc12345", "commit"]);

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
      expect(view.text(".assistant-section-heading button")).toBe(" Back");
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
      expect(calls[calls.length - 1]).toEqual([
        "done",
        { item: "1200000000000000" },
      ]);
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

      // An item added as free text and not sorted yet says so on its card.
      const sorting = (id: string) =>
        view.panel
          .querySelector(`[data-work-item="${id}"]`)
          ?.querySelector(".work-triage")?.textContent ?? null;
      expect(sorting("1300000000000000")).toBe("being sorted");
      expect(sorting("1400000000000000")).toBeNull();

      // a opens the form in the view: one text box, the user's own
      // words, nothing else to fill; Add sends the text alone (the
      // coordinator sorts it into a title, tags and a state).
      await view.key("a");
      const form = () =>
        view.panel.querySelector<HTMLFormElement>("form.work-add");
      expect(form()).not.toBeNull();
      expect(form()!.getAttribute("aria-label")).toBe("Add an item to gst2");
      expect(form()!.querySelectorAll("textarea").length).toBe(1);
      // No title, state or tags fields (the image picker's file input aside).
      expect(
        form()!.querySelectorAll("input:not([type=file]), select").length,
      ).toBe(0);
      const box = form()!.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='What needs doing']",
      )!;
      expect(box).not.toBeNull();
      // Nothing said: not sent.
      await act(async () => {
        form()!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      expect(calls.some(([method]) => method === "add")).toBe(false);
      expect(form()!.textContent).toContain("Say what needs doing");
      await view.type(box, "Copy a picture\nPaste one here.");
      // An add that fails says why in the form, and it stays there
      // (the form, its words, the reason) until dismissed.
      addFails = "the bridge is gone";
      await act(async () => {
        form()!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      const failedAlert = () =>
        form()?.querySelector<HTMLElement>(".assistant-error[role=alert]");
      expect(form()).not.toBeNull();
      expect(failedAlert()?.textContent).toContain(
        "Not added: the bridge is gone",
      );
      await view.click(failedAlert()!.querySelector("button"));
      expect(failedAlert()).toBeFalsy();
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
          text: "Copy a picture\nPaste one here.",
          project: "gst2",
          // Where it was added (the server tags it, unless a coordinator's).
          workspace: { connectionId: "desktop", workspaceId: "w1" },
        },
      ]);
      expect(form()).toBeNull();
      // The new item's detail opens, and says who sorts it.
      const sort = () => view.panel.querySelector<HTMLElement>(".work-sort");
      expect(
        view.panel
          .querySelector("[data-work-detail]")
          ?.getAttribute("data-work-detail"),
      ).toBe("3300000000000000");
      expect(sort()?.dataset.workSort).toBe("sorting");
      expect(view.text(".work-sort-text")).toBe(
        "Sorting: desktop/w32:p1 is giving it a title, tags and a state",
      );
      expect(view.text(".work-detail h3")).toBe("Copy a picture");
      // The coordinator sorts it: the detail follows the push.
      board.items = board.items.map((each) =>
        each.id === "3300000000000000"
          ? {
              ...each,
              title: "Paste images into the add form",
              tags: ["images"],
              state: "doing",
              needsTriage: undefined,
            }
          : each,
      );
      await pushBoard();
      expect(sort()?.dataset.workSort).toBe("sorted");
      expect(view.text(".work-sort-text")).toBe(
        "Sorted by desktop/w32:p1: its title, tags and state are set",
      );
      expect(view.text(".work-detail h3")).toBe(
        "Paste images into the add form",
      );
      expect(
        view.panel.querySelector<HTMLSelectElement>(
          ".work-detail select[aria-label='State (s)']",
        )?.value,
      ).toBe("doing");
      // Add another: the form again.
      await view.click(
        [...view.panel.querySelectorAll(".work-sort button")].find(
          (each) => each.textContent === " Add another",
        ) ?? null,
      );
      expect(form()).not.toBeNull();
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      await view.click(
        [...form()!.querySelectorAll("button")].find(
          (each) => each.textContent === "Cancel",
        ) ?? null,
      );
      expect(form()).toBeNull();
      // The new item is the selected one, its detail left.
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      expect(view.selected()).toBe("3300000000000000");
    } finally {
      board.items = board.items.filter(
        (each) => each.id !== "3300000000000000",
      );
      await view.unmount();
    }
  });

  test("? shows the Work keys in the shortcut help: searched by keys and words, Enter or a click runs one on the board, Esc closes only the help", async () => {
    localStorage.clear();
    calls.length = 0;
    const view = await mount();
    try {
      const help = () => view.panel.querySelector(".shortcut-help");
      const titles = () =>
        [...help()!.querySelectorAll(".command-item-title")].map(
          (row) => row.textContent,
        );
      const search = async (text: string) => {
        await view.type(help()!.querySelector("input")!, text);
        await view.key("Shift", {});
      };
      view.panel.focus();
      await view.key("?");
      expect(help()?.querySelector("h2")?.textContent).toBe("Work keys");
      expect(document.activeElement).toBe(help()!.querySelector("input"));
      // One key lists the rows holding it; words must all match.
      await search("j");
      expect(titles()).toEqual(["next item (a count repeats: 3j)"]);
      await search("column right");
      expect(titles()).toEqual([
        "on a wide pane (columns): the column on the right",
      ]);
      // "?" itself is listed, not run.
      await search("?");
      expect(
        help()!.querySelector(".command-item")?.getAttribute("aria-disabled"),
      ).toBe("true");
      // Enter runs the row picked: j selects the first card.
      await search("next item");
      await view.key("Enter");
      expect(help()).toBeNull();
      expect(view.selected()).toBe("1100000000000000");
      // A click (a tap) runs it too: the column on the right.
      await view.key("?");
      await search("column right");
      await view.click(help()!.querySelector(".command-item"));
      await view.key("Shift", {});
      expect(help()).toBeNull();
      expect(view.selected()).toBe("1200000000000000");
      // Down then j / k move in the list; Esc closes the help, not the view.
      await view.key("?");
      await search("item");
      const chosen = () =>
        help()!
          .querySelector(".command-item[aria-selected='true']")
          ?.querySelector(".command-item-title")?.textContent;
      expect(chosen()).toBe("next item (a count repeats: 3j)");
      await view.key("ArrowDown");
      expect(chosen()).toBe("previous item");
      await view.key("k");
      expect(chosen()).toBe("next item (a count repeats: 3j)");
      await view.key("Escape");
      expect(help()).toBeNull();
      expect(view.closed()).toBe(0);
      expect(view.selected()).toBe("1200000000000000");
    } finally {
      await view.unmount();
    }
  });

  test("a card dragged to another column changes its state: a mouse at once, a finger after a hold (a swipe scrolls), Esc lets go", async () => {
    localStorage.clear();
    sessionStorage.clear();
    calls.length = 0;
    const { WORK_DRAG_HOLD_MS, WORK_DRAG_MOVE_PX } = await import(
      "./WorkBoard"
    );
    const view = await mount();
    try {
      const lane = (state: string) =>
        view.panel.querySelector<HTMLElement>(`[data-work-column="${state}"]`)!;
      const card = (id: string) =>
        view.panel
          .querySelector<HTMLElement>(`[data-work-item="${id}"]`)!
          .closest<HTMLElement>("li")!;
      // What stands under the pointer: a lane, chosen by the test.
      let under: Element | null = null;
      (document as any).elementFromPoint = () => under;
      const pointer = async (
        type: string,
        init: Record<string, unknown>,
        target: EventTarget = window,
      ) => {
        await act(async () => {
          target.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              isPrimary: true,
              button: 0,
              pointerType: "mouse",
              clientX: 10,
              clientY: 10,
              ...init,
            }),
          );
        });
      };
      const ghost = () =>
        view.panel.querySelector<HTMLElement>(".work-drag-ghost");

      // A mouse: a few pixels are a click, farther is a drag.
      await pointer("pointerdown", {}, card("1300000000000000"));
      await pointer("pointermove", { clientX: 10 + WORK_DRAG_MOVE_PX - 2 });
      expect(ghost()).toBeNull();
      under = lane("doing");
      await pointer("pointermove", { clientX: 140 });
      expect(ghost()?.textContent).toContain("Item 1300000000000000");
      expect(ghost()?.textContent).toContain("Doing");
      expect(card("1300000000000000").classList.contains("is-dragging")).toBe(
        true,
      );
      expect(lane("doing").classList.contains("is-drop-target")).toBe(true);
      expect(lane("open").classList.contains("is-drop-target")).toBe(false);
      await pointer("pointerup", { clientX: 140 });
      expect(calls[calls.length - 1]).toEqual([
        "update",
        { item: "1300000000000000", state: "doing" },
      ]);
      expect(ghost()).toBeNull();
      expect(lane("doing").classList.contains("is-drop-target")).toBe(false);
      // The drop is no click: the detail stays closed.
      expect(view.panel.querySelector("[data-work-detail]")).toBeNull();

      // Let go over its own column, or outside any: nothing changes.
      calls.length = 0;
      under = lane("open");
      await pointer("pointerdown", {}, card("1400000000000000"));
      await pointer("pointermove", { clientX: 200 });
      expect(ghost()).not.toBeNull();
      await pointer("pointerup", { clientX: 200 });
      expect(calls).toEqual([]);
      under = null;
      await pointer("pointerdown", {}, card("1400000000000000"));
      await pointer("pointermove", { clientX: 200 });
      await pointer("pointerup", { clientX: 200 });
      expect(calls).toEqual([]);

      // Esc lets go of a card being dragged.
      under = lane("verify");
      await pointer("pointerdown", {}, card("1400000000000000"));
      await pointer("pointermove", { clientX: 300 });
      expect(ghost()).not.toBeNull();
      await view.key("Escape");
      expect(ghost()).toBeNull();
      await pointer("pointerup", { clientX: 300 });
      expect(calls).toEqual([]);

      // A finger: a swipe before the hold is a scroll, not a drag.
      await pointer(
        "pointerdown",
        { pointerType: "touch", pointerId: 2 },
        card("1500000000000000"),
      );
      await pointer("pointermove", {
        pointerType: "touch",
        pointerId: 2,
        clientY: 60,
      });
      await act(async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, WORK_DRAG_HOLD_MS + 60),
        );
      });
      expect(ghost()).toBeNull();
      await pointer("pointerup", { pointerType: "touch", pointerId: 2 });
      expect(calls).toEqual([]);
      // Held still: the card lifts, and goes where the finger lets it go.
      under = lane("you");
      await pointer(
        "pointerdown",
        { pointerType: "touch", pointerId: 3 },
        card("1500000000000000"),
      );
      await act(async () => {
        await new Promise((resolve) =>
          setTimeout(resolve, WORK_DRAG_HOLD_MS + 60),
        );
      });
      expect(ghost()?.textContent).toContain("Item 1500000000000000");
      await pointer("pointermove", {
        pointerType: "touch",
        pointerId: 3,
        clientX: 40,
      });
      await pointer("pointerup", {
        pointerType: "touch",
        pointerId: 3,
        clientX: 40,
      });
      expect(calls[calls.length - 1]).toEqual([
        "update",
        { item: "1500000000000000", state: "you" },
      ]);
      expect(ghost()).toBeNull();

      // The keys still move the selection and open the detail.
      await view.click(view.panel.querySelector("[data-work-item]"));
      expect(view.panel.querySelector("[data-work-detail]")).not.toBeNull();
      // The detail's Done when row says how the item becomes done by itself.
      await view.key("Escape");
      await view.click(
        view.panel.querySelector('[data-work-item="1200000000000000"]'),
      );
      expect(view.text(".work-done-when")).toContain(
        "its commit reaches main in /home/me/gstreamer/2.0",
      );
    } finally {
      await view.unmount();
    }
  });

  test("the scope and the search: the workspace's project, #tag from a card's chip or completed as typed; a choice is remembered; an item opens its project and its detail", async () => {
    localStorage.clear();
    sessionStorage.clear();
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
      // No tag row, no Filters: tags are chips on the cards, searched for.
      expect(first.panel.querySelector(".work-tags-strip")).toBeNull();
      expect(first.panel.querySelector(".work-filters-button")).toBeNull();
      const search =
        first.panel.querySelector<HTMLInputElement>(".mr-reviews-search")!;
      // A card's tag chip puts #tag in the search, which keeps its items.
      await first.click(
        first.panel.querySelector<HTMLElement>(
          '[data-work-item="1100000000000000"] .work-tag',
        ),
      );
      expect(search.value).toBe("#caps ");
      expect(first.cards()).toEqual([
        "1100000000000000",
        "1200000000000000",
        "1300000000000000",
      ]);
      // Typing # offers the scope's tags as typed; Tab takes the first.
      await act(async () => {
        search.focus();
      });
      await first.type(search, "#caps #pa");
      const offered = () =>
        [
          ...first.panel.querySelectorAll<HTMLElement>(
            "#work-completions [role='option']",
          ),
        ].map((each) => each.textContent);
      expect(offered()).toEqual(["#pads"]);
      await first.key("Tab");
      expect(search.value).toBe("#caps #pads ");
      expect(first.cards()).toEqual(["1100000000000000"]);
      expect(offered()).toEqual([]);
      // tag: names a tag too; the other words are searched for.
      await first.type(search, "tag:caps 13");
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
      // Not its coordinator's: the items added from it, a chip to widen.
      expect(other.cards()).toEqual([]);
      await other.click(
        other.panel.querySelector(".work-filter-row .work-workspace-filter"),
      );
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
      wide: ["desktop:/home/me/misc/roamgate.worktrees/work-view"],
    });
  });

  test("a worktree's board keeps its workspace's items (a chip widens it, remembered there); a parent shows its subprojects'; an item added there says where", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const saved = { ...board, items: board.items };
    board.projects = [
      ...board.projects.map((each) =>
        each.id === "gst2" ? { ...each, parent: "gstreamer" } : each,
      ),
      {
        id: "gstreamer",
        name: "gstreamer",
        roots: [{ connectionId: "desktop", path: "/home/me/gstreamer" }],
        done: { kind: "deployed" },
      },
      // By name, as the server keeps them.
    ].sort((a, b) =>
      String(a.name).localeCompare(String(b.name)),
    ) as typeof board.projects;
    board.items = [
      ...board.items.filter((each) => each.id !== "3300000000000000"),
      item("1800000000000000", "gst2", "open", ["caps", "ws:gst2-video"]),
      item("4100000000000000", "gstreamer", "open", ["ocio"]),
    ];
    const before = workspace;
    // No checkout: its panes' directories say where it is.
    workspace = {
      connectionId: "desktop",
      workspaceId: "w36",
      label: "gst2-video",
      checkoutPath: null,
      repoRoot: null,
      panes: [{ pane_id: "w36:p1", cwd: "/home/me/gstreamer/2.0/gst2-video" }],
    };
    const view = await mount();
    try {
      const select = view.panel.querySelector<HTMLSelectElement>(
        ".work-filter-row .work-scope-select",
      )!;
      expect(select.value).toBe("gst2");
      // The tree: a subproject under its parent, counted in it.
      expect([...select.options].map((option) => option.textContent)).toEqual([
        "All projects (10)",
        "gstreamer (8)",
        "\u00a0\u00a0gst2 (7)",
        "roamgate (2)",
      ]);
      const chip = () =>
        view.panel.querySelector<HTMLElement>(".work-workspace-filter");
      expect(chip()?.textContent).toBe("gst2-video");
      expect(view.cards()).toEqual(["1800000000000000"]);
      // Its tag reads as the workspace's name.
      expect(
        view.text('[data-work-item="1800000000000000"] .work-tag.is-workspace'),
      ).toBe("gst2-video");
      // One tap: the whole project.
      await view.click(chip());
      expect(view.cards()).toHaveLength(7);
      expect(chip()?.classList.contains("is-off")).toBe(true);
      // The parent: its own items and its subproject's, each card naming
      // its subproject; still this workspace's until widened.
      await act(async () => {
        select.value = "gstreamer";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(view.cards()).toHaveLength(8);
      expect(
        view.text(
          '[data-work-item="1800000000000000"] .mr-reviews-chip.is-tree',
        ),
      ).toBe("gst2");
      expect(
        view.panel.querySelector(
          '[data-work-item="4100000000000000"] .mr-reviews-chip.is-tree',
        ),
      ).toBeNull();
      await view.click(chip());
      expect(view.cards()).toEqual(["1800000000000000"]);
      // Added from here: the form says which workspace.
      await view.key("a");
      const form = view.panel.querySelector<HTMLFormElement>("form.work-add")!;
      await view.type(
        form.querySelector<HTMLTextAreaElement>("textarea")!,
        "From the video worktree",
      );
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const adds = calls.filter(([method]) => method === "add");
      const added = adds[adds.length - 1];
      expect(added?.[1]).toMatchObject({
        project: "gstreamer",
        workspace: { connectionId: "desktop", workspaceId: "w36" },
      });
    } finally {
      await view.unmount();
      workspace = before;
      board.projects = saved.projects;
      board.items = saved.items;
    }
  });

  test("a For you or Verify card says what the user has to do; an answer's tap is the user's comment; the detail says it first", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const saved = board.items;
    board.items = [
      item("1900000000000000", "gst2", "you", ["car"], {
        ask: "Choose: media to the car with the phone mic, or no music on car links",
        answers: [
          "Media, phone mic",
          "No music",
          "Something else (I will write it)",
        ],
      }),
      item("1910000000000000", "gst2", "verify", ["dictation"], {
        ask: "Dictate once after 10 idle minutes; text should appear",
      }),
      item("1920000000000000", "gst2", "doing", [], { ask: "Stale" }),
    ];
    const view = await mount();
    try {
      const card = (id: string) =>
        view.panel.querySelector(`[data-work-item='${id}']`)!;
      const you = card("1900000000000000");
      // Under the title, before the tags.
      const head = you.querySelector(".mr-reviews-dense-head")!;
      expect(head.children[1]?.classList.contains("work-ask")).toBe(true);
      expect(you.querySelector(".work-ask-text")?.textContent).toBe(
        "For you: Choose: media to the car with the phone mic, or no music on car links",
      );
      // The answers, and Something else: the user's own words (an
      // agent's "I will write it" answer is that box, not a tap).
      const answers = [...you.querySelectorAll(".work-ask-answer")];
      expect(answers.map((each) => each.textContent)).toEqual([
        "Media, phone mic",
        "No music",
        "Something else",
      ]);
      expect(
        card("1910000000000000").querySelector(
          ".work-ask.is-verify .work-ask-text",
        )?.textContent,
      ).toBe(
        "To verify: Dictate once after 10 idle minutes; text should appear",
      );
      // An ask with no answers: Reply.
      expect(
        [...card("1910000000000000").querySelectorAll(".work-ask-answer")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["Reply"]);
      expect(card("1920000000000000").querySelector(".work-ask")).toBeNull();

      // A tap posts the answer, and does not open the card; a second tap
      // while it is sent, or after, sends nothing (it arrived twice once).
      let release = () => {};
      postGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await act(async () => {
        (answers[1] as HTMLElement).click();
        (answers[1] as HTMLElement).click();
        (answers[0] as HTMLElement).click();
      });
      expect(posted).toEqual([["1900000000000000", "No music"]]);
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      expect(you.querySelector(".work-ask-status")?.textContent).toBe(
        "Sending: No music",
      );
      expect(
        answers
          .slice(0, 2)
          .every((each) => (each as HTMLButtonElement).disabled),
      ).toBe(true);
      postGate = null;
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(you.querySelector(".work-ask-status")?.textContent).toBe(
        "Sent: No music",
      );
      expect(
        answers
          .slice(0, 2)
          .every((each) => (each as HTMLButtonElement).disabled),
      ).toBe(true);
      await view.click(answers[1]!);
      expect(posted.length).toBe(1);

      // Something else: a box right on the card, which stays closed;
      // Send posts the user's words as their comment.
      await view.click(answers[2]!);
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      const reply = you.querySelector(".work-ask-reply")!;
      expect(reply).not.toBeNull();
      await view.type(
        reply.querySelector("textarea")!,
        "Media, but the car's own mic",
      );
      await view.click(
        [...reply.querySelectorAll("button")].find(
          (each) => each.textContent === "Send",
        ) ?? null,
      );
      expect(posted).toEqual([
        ["1900000000000000", "No music"],
        ["1900000000000000", "Media, but the car's own mic"],
      ]);
      expect(you.querySelector(".work-ask-reply")).toBeNull();
      expect(you.querySelector(".work-ask-status")?.textContent).toBe(
        "Sent: Media, but the car's own mic",
      );

      await view.click(you);
      const detail = view.panel.querySelector(".work-detail")!;
      expect(detail.querySelector(".work-ask.is-detail")).toBeTruthy();
      expect(
        detail
          .querySelector(".assistant-task-heading")
          ?.nextElementSibling?.classList.contains("work-ask"),
      ).toBe(true);
      // The detail knows it was answered: no second answer from there.
      const again = detail.querySelectorAll<HTMLButtonElement>(
        ".work-ask-answer:not(.is-reply)",
      );
      expect([...again].every((each) => each.disabled)).toBe(true);
      await view.click(again[0]!);
      expect(posted.length).toBe(2);
    } finally {
      board.items = saved;
      posted.length = 0;
      postGate = null;
      await view.unmount();
    }
  });

  test("an item added waits in its detail until sorted: drawn before the board has it, says so plainly after two minutes, Esc leaves, a split says where it went", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const saved = board.items;
    const { WORK_SORT_PATIENCE_MS } = await import("./WorkBoard");
    const view = await mount();
    const form = () =>
      view.panel.querySelector<HTMLFormElement>("form.work-add");
    const sort = () =>
      view.panel.querySelector<HTMLElement>(".work-sort")?.dataset.workSort ??
      null;
    try {
      await view.key("a");
      await view.type(
        form()!.querySelector<HTMLTextAreaElement>("textarea")!,
        "Fix the toolbar on the phone",
      );
      // The add is answered before the board's read has the item.
      addUnread = true;
      jest.useFakeTimers();
      try {
        await act(async () => {
          form()!.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        });
        await act(async () => {});
        expect(form()).toBeNull();
        expect(
          view.panel
            .querySelector("[data-work-detail]")
            ?.getAttribute("data-work-detail"),
        ).toBe("3300000000000000");
        expect(view.text(".work-detail h3")).toBe(
          "Fix the toolbar on the phone",
        );
        expect(sort()).toBe("sorting");
        await act(async () => {
          jest.advanceTimersByTime(WORK_SORT_PATIENCE_MS - 1000);
        });
        expect(sort()).toBe("sorting");
        await act(async () => {
          jest.advanceTimersByTime(1000);
        });
        expect(sort()).toBe("unsorted");
        expect(view.text(".work-sort-text")).toBe(
          "No one has sorted it yet; it stays marked on the board",
        );
      } finally {
        jest.useRealTimers();
        addUnread = false;
      }
      // The board's read brings it; Esc leaves, the card selected.
      board.items = [
        ...board.items,
        item("3300000000000000", "gst2", "open", [], {
          title: "Fix the toolbar on the phone",
          owner: { session: "desktop/w32:p1" },
          needsTriage: true,
        }),
      ];
      await view.pushBoard();
      expect(sort()).toBe("unsorted");
      await view.key("Escape");
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      expect(view.selected()).toBe("3300000000000000");
      expect(
        view.panel
          .querySelector('[data-work-item="3300000000000000"]')
          ?.querySelector(".work-triage")?.textContent,
      ).toBe("being sorted");
      // Opened again from its card: an ordinary detail.
      await view.click(
        view.panel.querySelector('[data-work-item="3300000000000000"]'),
      );
      expect(view.panel.querySelector(".work-detail")).not.toBeNull();
      expect(sort()).toBeNull();
      await view.key("Escape");

      // Another, split by the coordinator: it leaves the board, the
      // detail says so.
      await view.key("a");
      await view.type(
        form()!.querySelector<HTMLTextAreaElement>("textarea")!,
        "Two things",
      );
      board.items = board.items.filter(
        (each) => each.id !== "3300000000000000",
      );
      await act(async () => {
        form()!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(sort()).toBe("sorting");
      board.items = board.items.filter(
        (each) => each.id !== "3300000000000000",
      );
      await view.pushBoard();
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      expect(view.text(".work-notice span")).toBe(
        '"Two things" left the board while being sorted: split into other items, or removed',
      );
    } finally {
      board.items = saved;
      await view.unmount();
    }
  });

  test("a card's links are one line of small chips, a kind and a count each; the detail lists them with labels one reads, each its action", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const mr =
      "https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/merge_requests/2345";
    inboxMore = {
      efforts: [
        {
          id: "emwqgkha97zmf",
          name: "gst-plugins-rs webrtc fixes",
          group: "g",
          source: "s",
          target: "t",
          total: 0,
          counts: {},
        },
      ],
    };
    // The item of the user's screenshot (2026-11-21), and a request.
    const links = [
      { kind: "review", id: "d22a2f86aaaaaaaa", thread: "cf35a5acbbbbbbbb" },
      { kind: "effort", id: "emwqgkha97zmf" },
      { kind: "branch", name: "webrtc-signaller-tls-verify" },
      { kind: "branch", name: "webrtcsrc-no-decodebin3-panic" },
      {
        kind: "commit",
        sha: "f9b1e86950000000",
        subject: "webrtc: Verify the signalling server's certificate",
        root: "/src/gst-plugins-rs",
      },
      { kind: "commit", sha: "62d3530630000000", subject: "webrtcsrc: Post" },
      { kind: "pr", url: mr },
    ];
    board.items = [
      ...board.items,
      item("1800000000000000", "gst2", "you", ["upstreaming"], { links }),
    ];
    const opened: string[] = [];
    const open = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    const view = await mount();
    try {
      const card = view.panel.querySelector(
        "[data-work-item='1800000000000000']",
      )!;
      const chips = [...card.querySelectorAll(".work-link-chip")];
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "effort",
        "PR !2345",
        "thread",
        "2 branches",
        "2 commits",
      ]);
      // Each with its kind's icon; none a button of its own: a tap opens
      // the card.
      expect(chips.every((chip) => chip.querySelector("svg"))).toBe(true);
      expect(card.querySelector(".work-link-chips button")).toBeNull();
      // No raw ids on the card.
      for (const id of ["d22a2f86", "cf35a5ac", "emwqgkha97zmf", "f9b1e869"])
        expect(card.textContent).not.toContain(id);

      // The detail: a row per link, its label read first.
      await view.click(card);
      const rows = () => [
        ...view.panel.querySelectorAll<HTMLElement>(
          ".work-detail .work-link-row",
        ),
      ];
      expect(
        rows().map((row) => row.querySelector(".work-link-label")?.textContent),
      ).toEqual([
        "The review thread",
        "gst-plugins-rs webrtc fixes",
        "webrtc-signaller-tls-verify",
        "webrtcsrc-no-decodebin3-panic",
        "webrtc: Verify the signalling server's certificate",
        "webrtcsrc: Post",
        "Request !2345",
      ]);
      expect(rows()[4]!.querySelector("small")?.textContent).toBe(
        "Commit f9b1e86950 in gst-plugins-rs",
      );
      // The request opens online; the commit's review is asked for in
      // its repository; the effort shows the inbox mode's effort view.
      await view.click(rows()[6]!.querySelector("button.work-link-open"));
      expect(opened).toEqual([mr]);
      await view.click(rows()[4]!.querySelector("button.work-link-open"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(reviewedCommits).toEqual([
        ["f9b1e86950000000", { path: "/src/gst-plugins-rs" }],
      ]);
      const targets = calls.filter(([method]) => method === "link_target");
      expect(targets[targets.length - 1]?.[1]).toEqual({
        item: "1800000000000000",
        link: links[4],
      });
      // A branch is reviewed too, in the checkout the server found it in
      // (it has no root of its own).
      await view.click(rows()[2]!.querySelector("button.work-link-open"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(reviewedBranches).toEqual([
        ["webrtc-signaller-tls-verify", { path: "/src/gst2" }],
      ]);
      // A commit in none of the project's repositories: said plainly,
      // never git's own error.
      await view.click(rows()[5]!.querySelector("button.work-link-open"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(reviewedCommits.length).toBe(1);
      expect(view.text(".assistant-error span")).toBe(
        "This commit is not in any of the project's repositories",
      );
      await view.click(rows()[1]!.querySelector("button.work-link-open"));
      expect(view.panel.classList.contains("is-mr")).toBe(true);
      expect(view.panel.querySelector(".work-detail")).toBeNull();
      expect(view.panel.querySelector(".mr-effort-view")).not.toBeNull();
    } finally {
      window.open = open;
      inboxMore = {};
      board.items = board.items.filter(
        (each) => each.id !== "1800000000000000",
      );
      await view.unmount();
    }
  });

  test("a file link: a chip with the file's name; its row opens the file in Files, in the workspace that holds it, rendered or at its line", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const { onFileLinkOpen } = await import("../fileLinkOpen");
    const asked: unknown[] = [];
    const stop = onFileLinkOpen((request) => asked.push(request));
    // Shown from the gst2 coordinator's workspace (focused).
    const savedWorkspace = workspace;
    workspace = {
      connectionId: "desktop",
      workspaceId: "w1",
      label: "gst2-caps",
      checkoutPath: "/home/me/gstreamer/2.0/gst2-caps",
      repoRoot: null,
      panes: [{ pane_id: "w32:p1" }],
    };
    moreWorkspaces = [
      {
        workspace_id: "w7",
        label: "meta",
        worktree: {
          checkout_path: "/home/me/meta",
          repo_root: "/home/me/meta",
        },
      },
    ];
    const links = [
      {
        kind: "file",
        path: "plans/agent-prompts.md",
        root: "/home/me/meta",
      },
      { kind: "file", path: "docs/a.md", line: 12 },
      { kind: "file", path: "far.md", root: "/elsewhere" },
    ];
    board.items = [
      ...board.items,
      item("1900000000000000", "gst2", "doing", [], { links: [links[0]!] }),
      item("1910000000000000", "gst2", "doing", [], { links }),
    ];
    const view = await mount();
    try {
      const card = view.panel.querySelector(
        "[data-work-item='1900000000000000']",
      )!;
      const chip = card.querySelector(".work-link-chip.is-file")!;
      expect(chip.textContent).toBe("agent-prompts.md");
      expect(chip.querySelector("svg")).not.toBeNull();
      expect(chip.getAttribute("title")).toBe(
        "/home/me/meta/plans/agent-prompts.md",
      );
      const several = view.panel.querySelector(
        "[data-work-item='1910000000000000']",
      )!;
      expect(
        several.querySelector(".work-link-chip.is-file")?.textContent,
      ).toBe("3 files");

      await view.click(several);
      const rows = () => [
        ...view.panel.querySelectorAll<HTMLElement>(
          ".work-detail .work-link-row",
        ),
      ];
      expect(
        rows().map((row) => row.querySelector(".work-link-label")?.textContent),
      ).toEqual(["agent-prompts.md", "a.md", "far.md"]);
      expect(rows()[0]!.querySelector("small")?.textContent).toBe(
        "File /home/me/meta/plans/agent-prompts.md",
      );
      expect(rows()[1]!.querySelector("small")?.textContent).toBe(
        "File docs/a.md, line 12",
      );
      const settle = () =>
        act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      // In the workspace whose checkout holds it, rendered (no line).
      await view.click(rows()[0]!.querySelector("button.work-link-open"));
      await settle();
      expect(asked).toEqual([
        {
          connectionId: "desktop",
          workspaceId: "w7",
          link: { root: "/home/me/meta", path: "plans/agent-prompts.md" },
          newTab: false,
        },
      ]);
      // At its line, in the root the server found; no workspace holds it:
      // the focused one (Files read any path).
      await view.click(rows()[1]!.querySelector("button.work-link-open"));
      await settle();
      expect(asked[1]).toEqual({
        connectionId: "desktop",
        workspaceId: "w1",
        link: { root: "/src/gst2", path: "docs/a.md", line: 12 },
        newTab: false,
      });
      // On another connection: said, nothing opened.
      await view.click(rows()[2]!.querySelector("button.work-link-open"));
      await settle();
      expect(asked.length).toBe(2);
      expect(view.text(".assistant-error span")).toBe(
        "It is in /elsewhere on mac: switch to that connection to open it",
      );
    } finally {
      stop();
      workspace = savedWorkspace;
      moreWorkspaces = [];
      board.items = board.items.filter(
        (each) =>
          each.id !== "1900000000000000" && each.id !== "1910000000000000",
      );
      await view.unmount();
    }
  });

  test("from a session's chat: the add form starts quoted, for that session, in its workspace's project; its count opens the board on its items", async () => {
    localStorage.clear();
    sessionStorage.clear();
    calls.length = 0;
    const chat = {
      kind: "chat" as const,
      session: "desktop/w36:p2",
      chat: "c0ffee",
      entry: "msg-7",
    };
    // The page shows a gst2 workspace; the session runs in Roamgate's.
    const view = await mount({
      initialWork: {
        add: {
          text: "> the header scrolls away\n\n",
          owner: "desktop/w36:p2",
          ownerName: "Fix the header",
          workspace: {
            connectionId: "desktop",
            workspaceId: "w36",
            label: "roamgate-header",
            checkoutPath: "/home/me/misc/roamgate/../roamgate/header",
            repoRoot: "/home/me/misc/roamgate",
          },
          links: [chat],
        },
      },
    });
    try {
      const form = view.panel.querySelector<HTMLFormElement>("form.work-add");
      expect(form).not.toBeNull();
      expect(form!.getAttribute("aria-label")).toBe("Add an item to roamgate");
      expect(form!.querySelector("h3")?.textContent).toBe(
        "New item for Fix the header",
      );
      // The quote is what it says already: Add sends it, the session as
      // its owner (which sorts it) and the message linked.
      await act(async () => {
        form!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(calls[calls.length - 1]).toEqual([
        "add",
        {
          text: "> the header scrolls away",
          project: "roamgate",
          owner: { session: "desktop/w36:p2" },
          links: [chat],
          workspace: { connectionId: "desktop", paneId: "w36:p2" },
        },
      ]);
      expect(view.panel.querySelector("form.work-add")).toBeNull();
    } finally {
      await view.unmount();
    }

    // The header's count: the session's items, in every project.
    board.items = [
      ...board.items,
      item("2300000000000000", "roamgate", "open", ["chat"], {
        owner: { session: "desktop/w36:p2" },
        links: [chat],
      }),
      item("1900000000000000", "gst2", "doing", ["caps"], {
        owner: { session: "desktop/w36:p2", task: "a1b2c3d4" },
      }),
    ];
    calls.length = 0;
    const items = await mount({ initialWork: { owner: "desktop/w36:p2" } });
    try {
      expect(
        items.panel.querySelector<HTMLInputElement>("input[type=search]")
          ?.value ??
          items.panel.querySelector<HTMLInputElement>(
            ".mr-reviews-search input",
          )?.value,
      ).toBe("owner:desktop/w36:p2 ");
      expect(items.cards().sort()).toEqual([
        "1900000000000000",
        "2300000000000000",
      ]);
      // Its chat link: the message it came from, opening its chat.
      await items.click(
        items.panel.querySelector("[data-work-item='2300000000000000']"),
      );
      const row = items.panel.querySelector<HTMLElement>(
        ".work-detail .work-link-row",
      )!;
      expect(row.querySelector(".work-link-label")?.textContent).toBe(
        "The message it came from",
      );
      await items.click(row.querySelector("button.work-link-open"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(calls).toEqual([
        ["session_target", { session: "desktop/w36:p2" }],
      ]);
      expect(items.panel.textContent).toContain(
        "desktop/w36:p2 is not running in any pane right now",
      );
    } finally {
      board.items = board.items.filter(
        (each) =>
          each.id !== "2300000000000000" && each.id !== "1900000000000000",
      );
      await items.unmount();
    }
  });
  test("opening the owner's session from a board filling the window steps aside; beside the page it stays", async () => {
    const { TASK_NOTIFICATION_ACTIVATE_EVENT } = await import(
      "../taskNotifications"
    );
    const { roamgateLocalStorage } = await import("../browserStorage");
    const activated: unknown[] = [];
    const onActivate = (event: Event) =>
      activated.push((event as CustomEvent).detail);
    window.addEventListener(TASK_NOTIFICATION_ACTIVATE_EVENT, onActivate);
    const ownerItem = item("2400000000000000", "roamgate", "doing", [], {
      owner: { session: "desktop/w9:p1" },
    });
    board.items = [...board.items, ownerItem];
    const openSession = (view: Awaited<ReturnType<typeof mount>>) =>
      [
        ...view.panel.querySelectorAll<HTMLButtonElement>(
          ".work-detail button",
        ),
      ].find((button) => button.textContent === "Open the session") ?? null;
    try {
      // Filling the window: the pane would stay under it.
      roamgateLocalStorage.setItem("mrReviewsMaximized", "1");
      const full = await mount({ initialWorkItem: "2400000000000000" });
      try {
        await full.click(openSession(full));
        expect(activated).toEqual([
          {
            connectionId: "desktop",
            runtimeGeneration: 1,
            workspaceId: "w9",
            paneId: "w9:p1",
          },
        ]);
        expect(full.closes).toEqual([{ keepFocus: true }]);
      } finally {
        await full.unmount();
      }
      // A floating view beside the page: the pane shows, the view stays.
      roamgateLocalStorage.setItem("mrReviewsMaximized", "0");
      const floating = await mount({ initialWorkItem: "2400000000000000" });
      try {
        await floating.click(openSession(floating));
        expect(activated).toHaveLength(2);
        expect(floating.closed()).toBe(0);
      } finally {
        await floating.unmount();
      }
    } finally {
      window.removeEventListener(TASK_NOTIFICATION_ACTIVATE_EVENT, onActivate);
      roamgateLocalStorage.removeItem("mrReviewsMaximized");
      board.items = board.items.filter((each) => each.id !== ownerItem.id);
    }
  });
  test("a column is resized by its handle, kept for the scope, reset by a double-click; zf or its button shows it alone, h l the next one, Esc every column", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const view = await mount();
    const lanes = () =>
      [
        ...view.panel.querySelectorAll<HTMLElement>(
          ".mr-reviews-board > [data-work-column]",
        ),
      ].map(
        (lane) =>
          `${lane.dataset.workColumn}${lane.classList.contains("is-focused-column") ? "*" : ""}`,
      );
    const lane = (state: string) =>
      view.panel.querySelector<HTMLElement>(`[data-work-column="${state}"]`)!;
    /** The widths kept, of the one scope shown. */
    const stored = () =>
      Object.values(
        JSON.parse(
          localStorage.getItem("roamgate:mrReviewsWorkColumnWidths") ?? "{}",
        ),
      );
    const selectedIn = (state: string) =>
      !!lane(state).querySelector("[data-work-item][aria-current='true']");
    const all = ["you", "doing", "verify", "open", "done"];
    try {
      expect(lanes()).toEqual(all);
      // The handle on Open's right: dragged, Open keeps the width; kept
      // on release.
      const handle = lane("open").querySelector<HTMLElement>(
        ".work-column-resizer",
      )!;
      expect(handle.getAttribute("role")).toBe("separator");
      await act(async () => {
        handle.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId: 1,
            clientX: 300,
          }),
        );
      });
      expect(lane("open").classList.contains("has-width")).toBe(true);
      expect(lane("open").style.getPropertyValue("--work-column-width")).toBe(
        "300px",
      );
      await act(async () => {
        handle.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
        );
      });
      expect(stored()).toEqual([{ open: 300 }]);
      // The keys step it, within its bounds.
      await act(async () => {
        handle.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      expect(stored()).toEqual([{ open: 316 }]);
      await act(async () => {
        handle.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        );
      });
      expect(stored()).toEqual([{ open: 220 }]);
      // A double-click gives it back its share.
      await act(async () => {
        handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      expect(lane("open").classList.contains("has-width")).toBe(false);
      expect(stored()).toEqual([]);

      // Its head's button: Open alone, full width, no handle, the
      // selection in it.
      await view.click(
        lane("open").querySelector('button[aria-label="Focus on Open"]'),
      );
      expect(lanes()).toEqual(["open*"]);
      expect(view.panel.querySelector(".work-column-resizer")).toBeNull();
      expect(selectedIn("open")).toBe(true);
      // h l focus the next column in its turn; a folded one shows unfolded.
      await view.key("l");
      expect(lanes()).toEqual(["done*"]);
      expect(lane("done").classList.contains("is-folded")).toBe(false);
      expect(selectedIn("done")).toBe(true);
      await view.key("h");
      await view.key("h");
      expect(lanes()).toEqual(["verify*"]);
      await view.key("h");
      expect(lanes()).toEqual(["doing*"]);
      expect(selectedIn("doing")).toBe(true);
      // Esc: every column again.
      await view.key("Escape");
      expect(lanes()).toEqual(all);
      // zf focuses the selected item's column; its button, back.
      await view.key("z");
      await view.key("f");
      expect(lanes()).toEqual(["doing*"]);
      await view.click(
        lane("doing").querySelector('button[aria-label="Show every column"]'),
      );
      expect(lanes()).toEqual(all);
    } finally {
      await view.unmount();
    }
  });
  test("hidden and shown again, the board is where it was left: the search, the selection, the focused column, an item's detail, the form, the offsets; each workspace its own", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const lanes = (view: Awaited<ReturnType<typeof mount>>) =>
      [
        ...view.panel.querySelectorAll<HTMLElement>(
          ".mr-reviews-board > [data-work-column]",
        ),
      ].map((lane) => lane.dataset.workColumn);
    const search = (view: Awaited<ReturnType<typeof mount>>) =>
      view.panel.querySelector<HTMLInputElement>("input.mr-reviews-search");
    const savedWorkspace = workspace;
    try {
      // The search, the selection and a focused column.
      const first = await mount();
      await first.type(search(first)!, "#caps");
      await act(async () => first.panel.focus());
      await first.key("j");
      const chosen = first.selected();
      expect(chosen).not.toBeNull();
      await first.key("z");
      await first.key("f");
      const focusedLanes = lanes(first);
      expect(focusedLanes).toHaveLength(1);
      // A column's list scrolled down.
      const list = first.panel.querySelector<HTMLElement>(
        "[data-work-column] > .assistant-task-list",
      )!;
      await act(async () => {
        list.scrollTop = 120;
        list.dispatchEvent(new Event("scroll"));
      });
      await first.unmount();
      const second = await mount();
      expect(search(second)?.value).toBe("#caps");
      expect(second.selected()).toBe(chosen);
      expect(lanes(second)).toEqual(focusedLanes);
      expect(
        second.panel.querySelector<HTMLElement>(
          "[data-work-column] > .assistant-task-list",
        )!.scrollTop,
      ).toBe(120);
      // An item's detail.
      await second.key("Escape");
      await second.key("Enter");
      const opened = second.panel.querySelector<HTMLElement>(
        ".work-detail[data-work-detail]",
      )?.dataset.workDetail;
      expect(opened).toBe(chosen!);
      await second.unmount();
      const third = await mount();
      expect(
        third.panel.querySelector<HTMLElement>(".work-detail[data-work-detail]")
          ?.dataset.workDetail,
      ).toBe(chosen!);
      await third.key("Escape");
      // The new item form.
      await third.key("a");
      expect(third.panel.querySelector(".work-add")).not.toBeNull();
      await third.unmount();
      const fourth = await mount();
      expect(fourth.panel.querySelector(".work-add")).not.toBeNull();
      await fourth.unmount();
      // Another workspace: its own place, none yet.
      workspace = {
        connectionId: "desktop",
        workspaceId: "w2",
        label: "elsewhere",
        checkoutPath: "/home/me/elsewhere",
        repoRoot: null,
      };
      const other = await mount();
      expect(other.panel.querySelector(".work-add")).toBeNull();
      expect(search(other)?.value).toBe("");
      await other.unmount();
      // Opened on an item, it shows that item, not the place.
      workspace = savedWorkspace;
      const asked = await mount({ initialWorkItem: "1100000000000000" });
      expect(
        asked.panel.querySelector<HTMLElement>(".work-detail[data-work-detail]")
          ?.dataset.workDetail,
      ).toBe("1100000000000000");
      await asked.unmount();
    } finally {
      workspace = savedWorkspace;
      sessionStorage.clear();
    }
  });
}
