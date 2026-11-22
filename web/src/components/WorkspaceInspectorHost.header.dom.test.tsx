import { inIsolatedChild } from "../testIsolated";
import { expect, mock, test } from "bun:test";

/*
 * The inspector's one header row: the checkout, the six view tabs, the
 * shown view's own controls in the header's slot (inspectorHeaderSlot.tsx)
 * and Expand, More, Close. Every view fills the slot through the same
 * InspectorHeaderControls (stand-ins here, the views' own suites test
 * their controls); none keeps a row of its own under the header; a view's
 * controls leave with it; on a phone the row is still one row.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the inspector's one header row, in an isolated DOM runtime",
    "ROAMGATE_INSPECTOR_HEADER_DOM_TEST",
    30_000,
  )
) {
  const { installChangesDom } = await import("./changesSurface.testkit");
  await installChangesDom();
  const React = await import("react");
  const { act } = React;
  const { InspectorHeaderControls } = await import("./inspectorHeaderSlot");
  type View = "files" | "changes" | "commits" | "history" | "work" | "reviews";
  const pressed: string[] = [];
  /** A view's stand-in: its controls through the slot, its content. */
  const standIn = (name: View | "request", className: string) => (
    <>
      <InspectorHeaderControls
        className={className}
        label={`${name} controls`}
        fallback={(controls) => (
          <div className="own-row" data-own-row={name}>
            {controls}
          </div>
        )}
      >
        <span className="stand-in-status">{name} status</span>
        <button type="button" onClick={() => pressed.push(name)}>
          {`act ${name}`}
        </button>
      </InspectorHeaderControls>
      <div className="stand-in-content" data-content={name} />
    </>
  );
  mock.module("./MrReviewsPanel", () => ({
    MrReviewsPanel: (props: { mode?: "mr" | "work" }) => (
      <aside className="mr-reviews-panel" tabIndex={-1}>
        {standIn(
          props.mode === "work" ? "work" : "reviews",
          "assistant-panel-head",
        )}
      </aside>
    ),
  }));
  const preview = await import("./FilePreviewContent");
  mock.module("./FilePreviewContent", () => ({
    ...preview,
    FilePreviewContent: () => standIn("files", "file-preview-head-slot"),
  }));
  mock.module("./FileExplorerDialog", () => ({
    FileExplorerPanel: () => null,
  }));
  mock.module("./FilePreviewTabs", () => ({ FilePreviewTabs: () => null }));
  mock.module("./PullRequestCard", () => ({
    PullRequestCard: () => (
      <button type="button" onClick={() => pressed.push("request")}>
        request chip
      </button>
    ),
  }));
  mock.module("./DiffContentView", () => ({
    DiffContentView: () => standIn("changes", "diff-head-slot"),
  }));
  mock.module("./GitCommitHistory", () => ({
    GitCommitHistory: () => <div className="stand-in-content" />,
  }));
  mock.module("./AgentHistoryDrawer", () => ({
    AgentHistoryDrawer: () => standIn("history", "agent-history-drawer-head"),
  }));

  const { createRoot } = await import("react-dom/client");
  const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
  const { inspectorProps } = await import("./WorkspaceInspectorHost.testkit");
  const { updateLayoutPreferences } = await import("../layoutPreferences");
  type Props = Parameters<typeof WorkspaceInspectorHost>[0];

  async function mountInspector(first: View, width = 1400) {
    let view: View = first;
    const host = document.createElement("div");
    document.body.append(host);
    // The inspector's width (its layout reads it): compact under 640.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).classList?.contains("workspace-inspector")
          ? width
          : 0;
      },
    });
    const root = createRoot(host);
    const render = (): Promise<void> =>
      act(async () =>
        root.render(
          <WorkspaceInspectorHost
            {...inspectorProps({
              state: {
                scope: {
                  kind: "workspace",
                  connectionId: "local",
                  workspaceId: "w1",
                },
                open: true,
                view,
                dock: "right",
                size: 480,
                expanded: true,
              } as Props["state"],
              historyPane: {
                pane_id: "w1:p1",
                workspace_id: "w1",
                agent: "claude",
                agent_status: "idle",
              } as Props["historyPane"],
              diffSelection: {
                entry: null,
                file: null,
                loading: false,
                error: null,
                entries: [],
                files: {},
                fileErrors: {},
              } as unknown as Props["diffSelection"],
              onViewChange: (next) => {
                view = next as View;
                void render();
              },
            })}
          />,
        ),
      );
    await render();
    const settle = async () => {
      // The lazy views load on first use.
      for (let wait = 0; wait < 40; wait++) {
        if (host.querySelector(`[data-view-head="${view}"]`)) break;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    };
    await settle();
    const tab = (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
        (each) =>
          each.querySelector(".workspace-inspector-tab-label")?.textContent ===
          name,
      )!;
    return {
      host,
      tab,
      settle,
      head: () => host.querySelector<HTMLElement>(".workspace-inspector-head")!,
      slot: () =>
        host.querySelector<HTMLElement>(".workspace-inspector-view-controls")!,
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  const LABELS: Record<View, string> = {
    files: "Files",
    changes: "Changes",
    commits: "Commits",
    history: "History",
    work: "Work",
    reviews: "Reviews",
  };

  test("each view's controls are in the header's one row, in its slot between the tabs and the inspector's actions; none has a row of its own; they leave with their view", async () => {
    const inspector = await mountInspector("files");
    try {
      for (const view of Object.keys(LABELS) as View[]) {
        await act(async () => inspector.tab(LABELS[view]).click());
        await inspector.settle();
        const head = inspector.head();
        // One header row: the checkout, the tabs, the slot, the actions.
        expect(
          inspector.host.querySelectorAll(".workspace-inspector-head"),
        ).toHaveLength(1);
        expect([...head.children].map((each) => each.className)).toEqual([
          "workspace-inspector-identity",
          "workspace-inspector-tabs",
          "workspace-inspector-view-controls",
          "workspace-inspector-actions",
        ]);
        // The shown view's controls, and only its, are in the slot.
        const heads = [
          ...inspector
            .slot()
            .querySelectorAll<HTMLElement>(".inspector-view-head"),
        ];
        const expected = view === "commits" ? "request" : view;
        expect(heads.map((each) => each.dataset.viewHead)).toEqual([view]);
        expect(heads[0]?.getAttribute("role")).toBe("group");
        expect(heads[0]?.textContent).toContain(
          view === "commits" ? "request chip" : `${view} status`,
        );
        // No view keeps its own row in the inspector's body.
        expect(inspector.host.querySelector("[data-own-row]")).toBeNull();
        expect(
          inspector.host.querySelector(
            ".workspace-inspector-body .inspector-view-head",
          ),
        ).toBeNull();
        // The controls work from the header.
        pressed.length = 0;
        const button = heads[0]!.querySelector<HTMLButtonElement>("button")!;
        await act(async () => button.click());
        expect(pressed).toEqual([expected]);
      }
    } finally {
      await inspector.unmount();
    }
  });

  test("outside the inspector a part keeps its own row; inline keeps it in the inspector too", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(standIn("work", "x")));
      expect(host.querySelector("[data-own-row='work']")?.textContent).toBe(
        "work statusact work",
      );
      expect(host.querySelector(".inspector-view-head")).toBeNull();
      const { InspectorHeaderSlotContext } = await import(
        "./inspectorHeaderSlot"
      );
      const { InspectorViewContext } = await import("../useInspectorCommands");
      const target = document.createElement("div");
      await act(async () =>
        root.render(
          <InspectorViewContext.Provider value="changes">
            <InspectorHeaderSlotContext.Provider
              value={{ target, view: "changes" }}
            >
              <InspectorHeaderControls
                className="diff-head-slot"
                label="Changes controls"
                inline
                fallback={(controls) => (
                  <div data-own-row="inline">{controls}</div>
                )}
              >
                <button type="button">covering</button>
              </InspectorHeaderControls>
              <InspectorHeaderControls
                className="diff-head-slot"
                label="Changes controls"
                fallback={(controls) => (
                  <div data-own-row="slot">{controls}</div>
                )}
              >
                <button type="button">in the header</button>
              </InspectorHeaderControls>
            </InspectorHeaderSlotContext.Provider>
          </InspectorViewContext.Provider>,
        ),
      );
      expect(host.querySelector("[data-own-row='inline']")?.textContent).toBe(
        "covering",
      );
      expect(host.querySelector("[data-own-row='slot']")).toBeNull();
      expect(target.textContent).toBe("in the header");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test("on a phone the header is still one row: the tabs as icons, the view's controls and the inspector's More and Close, no Expand", async () => {
    await act(async () => updateLayoutPreferences({ mode: "mobile" }));
    const inspector = await mountInspector("work", 390);
    try {
      expect(document.documentElement.dataset.layout).toBe("mobile");
      const aside = inspector.host.querySelector(".workspace-inspector")!;
      expect(aside.classList.contains("is-compact")).toBe(true);
      expect(
        inspector.host.querySelectorAll(".workspace-inspector-head"),
      ).toHaveLength(1);
      const head = inspector.head();
      expect(head.querySelectorAll("[role=tab]")).toHaveLength(6);
      // Every tab has its icon and its name (shown or in its tooltip).
      for (const each of head.querySelectorAll<HTMLElement>("[role=tab]")) {
        expect(each.querySelector("svg")).not.toBeNull();
        expect(each.title).toBeTruthy();
      }
      expect(
        inspector.slot().querySelector("[data-view-head='work'] button")
          ?.textContent,
      ).toBe("act work");
      // More holds Dock (no Expand on a phone); Close stays in the row.
      expect(head.querySelector(".workspace-inspector-more")).not.toBeNull();
      expect(
        head.querySelector('[aria-label="Close Workspace Inspector"]'),
      ).not.toBeNull();
      // Another view: its controls take the row's slot.
      await act(async () => inspector.tab("Changes").click());
      await inspector.settle();
      expect(
        [
          ...inspector
            .slot()
            .querySelectorAll<HTMLElement>(".inspector-view-head"),
        ].map((each) => each.dataset.viewHead),
      ).toEqual(["changes"]);
    } finally {
      await inspector.unmount();
      await act(async () => updateLayoutPreferences({ mode: "auto" }));
    }
  });
}
