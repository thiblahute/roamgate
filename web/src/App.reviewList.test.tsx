import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { ReviewSnapshot } from "../../shared/review";
import type { Pane } from "./types";

/**
 * The reviews list over the workspace's review: opening it steps the
 * review aside, closing it brings the review back.
 */
if (process.env.ROAMGATE_APP_REVIEW_LIST_TEST !== "1") {
  test("the reviews list and the pinned review, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_REVIEW_LIST_TEST: "1" },
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
  test("closing the reviews list returns to the review pinned to the workspace", async () => {
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
        focused: true,
        cwd: "/repo/src",
        revision: 1,
      } as Pane,
    ];
    const rect = { x: 0, y: 0, width: 80, height: 24 };
    const snapshot = {
      ...store.get(),
      activeConnectionId: "local",
      connectionGeneration: 1,
      selectedPaneId: "a",
      panes,
      workspaces: [
        {
          workspace_id: "workspace",
          number: 1,
          label: "Workspace",
          focused: true,
          pane_count: 1,
          tab_count: 1,
          agent_status: "idle",
          active_tab_id: "tab",
        },
      ],
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
    spyOn(store, "get").mockImplementation(() => snapshot as never);
    spyOn(store, "init").mockImplementation(() => {});
    spyOn(store, "subscribe").mockImplementation(subscribe);
    const storeModule = await import("./store");
    mock.module("./store", () => ({
      ...storeModule,
      useStoreSelector: <T,>(
        selector: (state: ReturnType<typeof store.get>) => T,
      ) =>
        selector(
          React.useSyncExternalStore(subscribe, () => snapshot as never),
        ),
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
    const assistantModule = await import("./assistant");
    mock.module("./assistant", () => ({
      ...assistantModule,
      useAssistantState: () => ({ snapshot: null }),
      assistantActionExecuting: () => false,
      onAssistantShow: () => () => {},
    }));
    // The workspace's review, known to the bridge.
    const review = {
      session: {
        id: "r1",
        connectionId: "local",
        workspaceId: "workspace",
        root: "/repo",
        title: "The branch",
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: { paneId: "a" },
        createdAt: "2026-11-04",
        updatedAt: "2026-11-04",
      },
      threads: [],
    } as unknown as ReviewSnapshot;
    const reviewState = {
      sessions: new Map([["r1", review]]),
      openRequest: null,
    };
    const reviewModule = await import("./review");
    mock.module("./review", () => ({
      ...reviewModule,
      useReviewState: () => reviewState,
      getReviewSnapshot: (id: string) => reviewState.sessions.get(id),
      reviewCall: async (_connection: string, method: string) =>
        method === "review.activity" ? { activity: [] } : {},
    }));
    // The review pane itself: which review it shows.
    mock.module("./components/ReviewHost", () => ({
      ReviewHost: ({ shownId }: { shownId: string | null }) => (
        <div data-review-shown={shownId ?? ""} />
      ),
    }));
    for (const name of [
      "ConnectionSwitcher",
      "GlobalTooltip",
      "AnnotationPanel",
      "AssistantPanel",
      "WorkspaceInspectorHost",
      "WorkspaceTree",
      "ConfigMenu",
      "TabBar",
    ]) {
      const real = await import(`./components/${name}`);
      mock.module(`./components/${name}`, () => ({
        ...real,
        [name]: () => null,
      }));
    }
    mock.module("./components/TerminalView", () => ({
      TerminalView: () => null,
    }));
    const { initializeLayoutPreferences } = await import("./layoutPreferences");
    initializeLayoutPreferences();
    const { default: App } = await import("./App");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    /** The review shown, "" for none. */
    const shown = () =>
      container
        .querySelector("[data-review-shown]")
        ?.getAttribute("data-review-shown") ?? "";
    const list = () =>
      document.querySelector(
        '[role="dialog"][aria-label="Reviews in progress"]',
      );
    const chord = (shift = false) =>
      React.act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: shift ? "R" : "r",
            code: "KeyR",
            ctrlKey: true,
            altKey: true,
            shiftKey: shift,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    try {
      await React.act(async () => root.render(<App />));
      await settle();
      // The review shortcut shows the workspace's review.
      await chord();
      await settle();
      expect(shown()).toBe("r1");
      // The list steps over it: the review goes aside, kept.
      await chord(true);
      await settle();
      expect(list()).not.toBeNull();
      expect(shown()).toBe("");
      // Esc closes the list: the pinned review is back.
      await React.act(async () => {
        list()!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settle();
      expect(list()).toBeNull();
      expect(shown()).toBe("r1");
      // Its close button too.
      await chord(true);
      await settle();
      expect(shown()).toBe("");
      await React.act(async () =>
        list()!
          .querySelector<HTMLButtonElement>('button[title="Close (Esc)"]')!
          .click(),
      );
      await settle();
      expect(list()).toBeNull();
      expect(shown()).toBe("r1");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}
