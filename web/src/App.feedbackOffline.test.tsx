import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { Pane } from "./types";
import type { WorkspaceInspectorHost } from "./components/WorkspaceInspectorHost";

/**
 * A comment written in the inspector that Roamgate cannot save as a review
 * thread (no checkout to place it in, or the write refused) is kept in this
 * browser, to be moved on the next load (App's addFeedback). Pinned before
 * Changes becomes the review (plan: review into the inspector, phase A).
 */
if (process.env.ROAMGATE_APP_FEEDBACK_OFFLINE_TEST !== "1") {
  test("offline comment fallback in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_FEEDBACK_OFFLINE_TEST: "1" },
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
  }, 30_000);
} else {
  test("a comment Roamgate cannot write is kept in this browser and said so; with no checkout, kept silently", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      KeyboardEvent: browser.KeyboardEvent,
      CustomEvent: browser.CustomEvent,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { store } = await import("./store");
    const panes: Pane[] = [
      {
        pane_id: "a",
        terminal_id: "terminal-a",
        workspace_id: "workspace",
        tab_id: "tab",
        agent: "claude",
        agent_status: "idle",
        focused: true,
        revision: 1,
      },
    ];
    const rect = { x: 0, y: 0, width: 80, height: 24 };
    const workspace = (cwd?: string) => ({
      workspace_id: "workspace",
      number: 1,
      label: "Workspace",
      focused: true,
      pane_count: 1,
      tab_count: 1,
      agent_status: "idle",
      active_tab_id: "tab",
      ...(cwd ? { cwd } : {}),
    });
    let snapshot = {
      ...store.get(),
      activeConnectionId: "local",
      connectionGeneration: 1,
      selectedPaneId: "a",
      panes,
      workspaces: [workspace("/repo")],
      tabs: [
        {
          tab_id: "tab",
          workspace_id: "workspace",
          number: 1,
          label: "Tab",
          focused: true,
          pane_count: 1,
          agent_status: "idle",
        },
      ],
      layout: {
        workspace_id: "workspace",
        tab_id: "tab",
        focused_pane_id: "a",
        zoomed: false,
        area: rect,
        panes: [{ pane_id: "a", focused: true, rect }],
        splits: [],
      },
    };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    spyOn(store, "get").mockImplementation(() => snapshot);
    spyOn(store, "init").mockImplementation(() => {});
    spyOn(store, "subscribe").mockImplementation(subscribe);
    const notices: { kind: string; message: string; detail?: string }[] = [];
    spyOn(store, "notify").mockImplementation((notice) => {
      notices.push(notice as (typeof notices)[number]);
    });
    const storeModule = await import("./store");
    mock.module("./store", () => ({
      ...storeModule,
      useStoreSelector: <T,>(
        selector: (state: ReturnType<typeof store.get>) => T,
      ) => selector(React.useSyncExternalStore(subscribe, () => snapshot)),
    }));
    const client = {
      connectionId: "local",
      generation: 1,
      isCurrent: () => true,
      call: async () => ({}),
    };
    mock.module("./useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => true,
      connectionClientScopeKey: () => `local:${client.generation}`,
    }));
    // The review store refuses every write: Roamgate cannot save it yet.
    const reviewWrites: string[] = [];
    const reviewModule = await import("./review");
    mock.module("./review", () => ({
      ...reviewModule,
      reviewCall: async (_connection: string, method: string) => {
        reviewWrites.push(method);
        throw new Error("bridge unreachable");
      },
    }));
    const assistantModule = await import("./assistant");
    mock.module("./assistant", () => ({
      ...assistantModule,
      useAssistantState: () => ({ snapshot: null }),
      assistantActionExecuting: () => false,
      onAssistantShow: () => () => {},
    }));
    for (const name of [
      "ConnectionSwitcher",
      "GlobalTooltip",
      "AnnotationPanel",
      "AssistantPanel",
      "WorkspaceTree",
      "ConfigMenu",
      "TabBar",
      "TerminalView",
    ]) {
      const real = await import(`./components/${name}`);
      mock.module(`./components/${name}`, () => ({
        ...real,
        [name]: () => null,
      }));
    }
    let openChanges!: () => void;
    const commands = await import("./components/CommandCombobox");
    mock.module("./components/CommandCombobox", () => ({
      ...commands,
      CommandCombobox: ({
        onOpenDiffViewer,
      }: {
        onOpenDiffViewer: () => void;
      }) => {
        openChanges = onOpenDiffViewer;
        return null;
      },
    }));
    let inspectorProps!: React.ComponentProps<typeof WorkspaceInspectorHost>;
    const inspector = await import("./components/WorkspaceInspectorHost");
    mock.module("./components/WorkspaceInspectorHost", () => ({
      ...inspector,
      WorkspaceInspectorHost: (props: typeof inspectorProps) => {
        inspectorProps = props;
        return null;
      },
    }));
    const { initializeLayoutPreferences } = await import("./layoutPreferences");
    initializeLayoutPreferences();
    const { default: App } = await import("./App");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = async () => {
      for (let round = 0; round < 6; round += 1)
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };
    const note = (comment: string) =>
      ({
        source: "diff",
        path: "one.ts",
        kind: "unstaged",
        side: "new",
        line: 2,
        quote: "C",
        hunk: "@@ -1,2 +1,2 @@",
        comment,
      }) as const;
    const kept = () =>
      inspectorProps.annotations.map((each) => [each.source, each.comment]);
    try {
      await React.act(async () => root.render(<App />));
      await React.act(async () => openChanges());
      await settle();
      expect(inspectorProps.state.open).toBe(true);
      expect(inspectorProps.state.view).toBe("changes");
      expect(kept()).toEqual([]);

      // The write refused: kept here, and the user told.
      await React.act(async () =>
        inspectorProps.onCreateAnnotation(note("Why C?")),
      );
      await settle();
      // Its write only: refused, the note stays, saved on the next load
      // (not tried a second time at once).
      expect(reviewWrites).toEqual(["review.open"]);
      expect(kept()).toEqual([["diff", "Why C?"]]);
      expect(notices).toEqual([
        expect.objectContaining({
          kind: "error",
          message: "Comment kept in this browser",
          detail:
            "Roamgate could not save it yet (bridge unreachable). It is saved on the next load.",
        }),
      ]);

      // No checkout to place it in: kept here without a word or a write.
      await React.act(async () => {
        snapshot = {
          ...snapshot,
          workspaces: [workspace()],
          panes: panes.map((pane) => ({ ...pane, cwd: undefined })),
        };
        for (const listener of listeners) listener();
      });
      await settle();
      const writes = reviewWrites.length;
      await React.act(async () =>
        inspectorProps.onCreateAnnotation(note("And here?")),
      );
      await settle();
      expect(reviewWrites.length).toBe(writes);
      expect(kept()).toEqual([
        ["diff", "Why C?"],
        ["diff", "And here?"],
      ]);
      expect(notices).toHaveLength(1);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
    }
  });
}
