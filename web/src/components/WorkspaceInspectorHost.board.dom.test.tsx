import { inIsolatedChild } from "../testIsolated";
import { expect, mock, test } from "bun:test";

/*
 * The board in the inspector's Work and Reviews tabs: one MrReviewsPanel
 * (a stand-in here, the panel's own suites test it) for both tabs, its
 * state kept as the tabs switch; its [ ] ask for the other tab; gt and gT
 * from inside it leave for the next view; a request (a notification's
 * item) is given once; a session opened steps aside only over the window;
 * Esc closes the inspector.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the board in the inspector's tabs, in an isolated DOM runtime",
    "ROAMGATE_INSPECTOR_BOARD_DOM_TEST",
    30_000,
  )
) {
  const { installChangesDom } = await import("./changesSurface.testkit");
  await installChangesDom();
  const React = await import("react");
  const { act, useState } = React;
  type PanelProps = {
    mode?: "mr" | "work";
    onModeChange?: (mode: "mr" | "work") => void;
    expanded?: boolean;
    onClose: (options?: { keepFocus?: boolean }) => void;
    onKeyFirst?: (event: KeyboardEvent) => boolean;
    initialWorkItem?: string;
    initialLocal?: boolean;
  };
  let panel: PanelProps | null = null;
  let mounts = 0;
  mock.module("./MrReviewsPanel", () => ({
    MrReviewsPanel: (props: PanelProps) => {
      panel = props;
      const [count, setCount] = useState(0);
      React.useEffect(() => {
        mounts++;
      }, []);
      return (
        <aside
          className="mr-reviews-panel"
          tabIndex={-1}
          data-mode={props.mode}
          data-item={props.initialWorkItem ?? ""}
          data-local={props.initialLocal ? "" : undefined}
          data-count={count}
        >
          <button type="button" onClick={() => setCount((n) => n + 1)}>
            more
          </button>
        </aside>
      );
    },
  }));
  mock.module("./FileExplorerDialog", () => ({
    FileExplorerPanel: () => null,
  }));
  mock.module("./FilePreviewTabs", () => ({ FilePreviewTabs: () => null }));
  mock.module("./PullRequestCard", () => ({ PullRequestCard: () => null }));
  mock.module("./DiffContentView", () => ({ DiffContentView: () => null }));
  mock.module("./GitCommitHistory", () => ({ GitCommitHistory: () => null }));

  const { createRoot } = await import("react-dom/client");
  const { WorkspaceInspectorHost } = await import("./WorkspaceInspectorHost");
  const { inspectorProps } = await import("./WorkspaceInspectorHost.testkit");
  const { openWork } = await import("../workOpen");
  const { BOARD_INSPECTOR_EVENT, openLocalReviews, pendingBoardOpen } =
    await import("../mrReviewsOpen");
  type Props = Parameters<typeof WorkspaceInspectorHost>[0];
  type View = Props["state"]["view"];

  async function mountInspector(options: {
    view: View;
    expanded?: boolean;
    workForYou?: number;
  }) {
    let view = options.view;
    const views: View[] = [];
    const calls: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
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
                expanded: options.expanded ?? false,
              } as Props["state"],
              workForYou: options.workForYou ?? 0,
              onViewChange: (next) => {
                views.push(next);
                view = next;
                void render();
              },
              onClose: () => calls.push("close"),
              onStepAside: () => calls.push("aside"),
            })}
          />,
        ),
      );
    await render();
    // The board loads on first use.
    for (let wait = 0; wait < 40 && !board(); wait++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    function board() {
      return host.querySelector<HTMLElement>(
        ".inspector-board-resource .mr-reviews-panel",
      );
    }
    const tab = (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
        (each) =>
          each.querySelector(".workspace-inspector-tab-label")?.textContent ===
          name,
      )!;
    return {
      host,
      views,
      calls,
      board,
      tab,
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  test("Work and Reviews are tabs holding one board, kept as they switch; [ ] and gt leave; Esc closes; a session steps aside only over the window", async () => {
    const inspector = await mountInspector({ view: "work", workForYou: 3 });
    try {
      // The six tabs; Work wears the For you count.
      expect(
        [...inspector.host.querySelectorAll("[role=tab]")].map(
          (each) => each.textContent,
        ),
      ).toEqual(["Files", "Changes", "Commits", "History", "Work3", "Reviews"]);
      expect(inspector.tab("Work").getAttribute("aria-selected")).toBe("true");
      expect(inspector.tab("Work").title).toContain("Work");
      expect(inspector.board()?.dataset.mode).toBe("work");
      // Some state in the board, then the Reviews tab: the same board.
      await act(async () =>
        inspector.board()!.querySelector("button")!.click(),
      );
      expect(inspector.board()?.dataset.count).toBe("1");
      const before = mounts;
      await act(async () => inspector.tab("Reviews").click());
      expect(inspector.views).toEqual(["reviews"]);
      expect(inspector.board()?.dataset.mode).toBe("mr");
      expect(inspector.board()?.dataset.count).toBe("1");
      expect(mounts).toBe(before);
      // The board's own mode switch ([ ]) asks for the other tab.
      await act(async () => panel!.onModeChange!("work"));
      expect(inspector.views.slice(-1)[0]).toBe("work");
      // gt from inside the board: the next view (Reviews), the key taken.
      const key = (name: string) => {
        const event = new KeyboardEvent("keydown", {
          key: name,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "target", { value: inspector.board() });
        return panel!.onKeyFirst!(event);
      };
      let taken = false;
      await act(async () => {
        key("g");
        taken = key("t");
      });
      expect(taken).toBe(true);
      expect(inspector.views.slice(-1)[0]).toBe("reviews");
      // A key that is not the inspector's stays the board's.
      expect(key("j")).toBe(false);
      // Esc with nothing else to leave: the inspector closes. A session
      // opened beside the page: the board stays.
      await act(async () => panel!.onClose());
      await act(async () => panel!.onClose({ keepFocus: true }));
      expect(inspector.calls).toEqual(["close"]);
    } finally {
      await inspector.unmount();
    }
    // Over the window, opening a session steps aside.
    const full = await mountInspector({ view: "work", expanded: true });
    try {
      expect(panel!.expanded).toBe(true);
      await act(async () => panel!.onClose({ keepFocus: true }));
      expect(full.calls).toEqual(["aside"]);
    } finally {
      await full.unmount();
    }
  });

  test("a notification's item opens the board on it once; shown again later, the board is where it was left", async () => {
    await act(async () => openWork("1234567890abcdef"));
    expect(pendingBoardOpen()?.item).toBe("1234567890abcdef");
    const inspector = await mountInspector({ view: "work" });
    try {
      expect(inspector.board()?.dataset.item).toBe("1234567890abcdef");
      await act(async () => {});
      expect(pendingBoardOpen()).toBeNull();
      // Another tab, then Work again: no item asked any more.
      await act(async () => inspector.tab("Files").click());
      expect(inspector.board()).toBeNull();
      await act(async () => inspector.tab("Work").click());
      for (let wait = 0; wait < 20 && !inspector.board(); wait++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      expect(inspector.board()?.dataset.item).toBe("");
    } finally {
      await inspector.unmount();
    }
  });

  test("the Local reviews' way (Option+Shift+R, Changes' :reviews) asks for the Reviews tab, the board opened on them once", async () => {
    const asked: unknown[] = [];
    const listen = (event: Event) => asked.push((event as CustomEvent).detail);
    window.addEventListener(BOARD_INSPECTOR_EVENT, listen);
    try {
      await act(async () => openLocalReviews());
    } finally {
      window.removeEventListener(BOARD_INSPECTOR_EVENT, listen);
    }
    expect(asked).toEqual([{ view: "reviews", toggle: false }]);
    expect(pendingBoardOpen()?.local).toBe(true);
    const inspector = await mountInspector({ view: "reviews" });
    try {
      expect(inspector.board()?.dataset.local).toBe("");
      await act(async () => {});
      expect(pendingBoardOpen()).toBeNull();
    } finally {
      await inspector.unmount();
    }
  });
}
