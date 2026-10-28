import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { Pane } from "./types";
import type { AssistantPanel } from "./components/AssistantPanel";
import type { TerminalView } from "./components/TerminalView";
import type { WorkspaceInspectorHost } from "./components/WorkspaceInspectorHost";

if (process.env.ROAMGATE_APP_HISTORY_TEST !== "1") {
  test("mobile history input routing in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_HISTORY_TEST: "1" },
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
  }, 15_000);
} else {
  test("history switches the input target and withholds input until focus settles", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/?layout=mobile" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { store } = await import("./store");
    const panes: Pane[] = ["a", "b", "c"].map((id) => ({
      pane_id: id,
      terminal_id: `terminal-${id}`,
      workspace_id: "workspace",
      tab_id: "tab",
      agent: "codex",
      agent_status: "working",
      focused: id === "a",
      revision: 1,
    }));
    const rect = { x: 0, y: 0, width: 80, height: 24 };
    let snapshot = {
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
          pane_count: 3,
          tab_count: 1,
          agent_status: "working",
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
          pane_count: 3,
          agent_status: "working",
        },
      ],
      layout: {
        workspace_id: "workspace",
        tab_id: "tab",
        focused_pane_id: "a",
        zoomed: false,
        area: rect,
        panes: panes.map((pane) => ({
          pane_id: pane.pane_id,
          focused: pane.focused,
          rect,
        })),
        splits: [],
      },
    };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const spies: Array<{ mockRestore: () => void }> = [
      spyOn(store, "get").mockImplementation(() => snapshot),
      spyOn(store, "init").mockImplementation(() => {}),
      spyOn(store, "subscribe").mockImplementation(subscribe),
    ];
    const focusRequests: Array<{ paneId: string; finish: () => void }> = [];
    spies.push(
      spyOn(store, "focusPane").mockImplementation(
        (paneId) =>
          new Promise<undefined>((resolve) => {
            focusRequests.push({ paneId, finish: () => resolve(undefined) });
          }),
      ),
    );
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
      // Agents coming on screen are marked seen.
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
    for (const name of [
      "ConnectionSwitcher",
      "GlobalTooltip",
      "AnnotationPanel",
    ])
      mock.module(`./components/${name}`, () => ({ [name]: () => null }));
    let showSession!: () => void;
    mock.module("./components/MobileTabSheet", () => ({
      MobileTabSheet: ({
        onShowSession,
        onClose,
      }: {
        onShowSession: () => void;
        onClose: () => void;
      }) => {
        showSession = () => {
          onClose();
          onShowSession();
        };
        return null;
      },
    }));
    mock.module("./components/ConfigMenu", () => ({
      ConfigMenu: () => null,
      CONFIG_MENU_ID: "config-menu",
    }));
    mock.module("./components/TabBar", () => ({
      TabBar: () => null,
      requestClosePane() {},
      requestCloseTab() {},
    }));
    mock.module("./components/WorkspaceTree", () => ({
      WorkspaceTree: ({
        onViewAgentHistory,
      }: {
        onViewAgentHistory: (pane: Pane) => void;
      }) => (
        <>
          {panes.map((pane) => (
            <button key={pane.pane_id} onClick={() => onViewAgentHistory(pane)}>
              History {pane.pane_id}
            </button>
          ))}
        </>
      ),
    }));
    let rangerProps!: React.ComponentProps<typeof AssistantPanel>;
    mock.module("./components/AssistantPanel", () => ({
      AssistantPanel: (props: typeof rangerProps) => {
        rangerProps = props;
        return null;
      },
    }));
    let terminalProps!: React.ComponentProps<typeof TerminalView>;
    let inspectorProps!: React.ComponentProps<typeof WorkspaceInspectorHost>;
    mock.module("./components/TerminalView", () => ({
      TerminalView: (props: typeof terminalProps) => {
        terminalProps = props;
        return null;
      },
    }));
    mock.module("./components/WorkspaceInspectorHost", () => ({
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
    const openHistory = async (id: string) => {
      // The phone's workspace list opens on the recent ones; the tree,
      // whose agent rows open History, is under All.
      const all = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Show all workspaces"]',
      );
      if (all) await React.act(async () => all.click());
      return React.act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === `History ${id}`)!
          .click();
      });
    };
    const focusSettled = (id: string) =>
      React.act(async () => {
        snapshot = { ...snapshot, selectedPaneId: id };
        for (const listener of listeners) listener();
        focusRequests.find((request) => request.paneId === id)?.finish();
      });
    try {
      await React.act(async () => root.render(<App />));
      expect(terminalProps.paneId).toBe("a");
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      const inputTarget = terminalProps.mobileInputTarget;
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '.mobile-workspace-tools [aria-label="Open Ranger"]',
          )!
          .click(),
      );
      expect(rangerProps.open).toBe(true);
      expect(rangerProps.mobileInputTarget === inputTarget).toBe(true);
      expect(terminalProps.mobileInputTarget).toBeNull();
      expect(terminalProps.composerOpen).toBe(false);
      await React.act(async () => rangerProps.onClose());
      expect(terminalProps.mobileInputTarget === inputTarget).toBe(true);
      const chatButton = container.querySelector<HTMLButtonElement>(
        '.mobile-appbar [aria-label="Show agent message history"]',
      )!;
      const terminalButton = container.querySelector<HTMLButtonElement>(
        '.mobile-terminal-tools [aria-label="Show terminal session"]',
      )!;
      expect(
        container.querySelector(
          '.topbar [aria-label="Show agent message history"]',
        ),
      ).toBeNull();
      expect(container.querySelector(".mobile-appbar")?.firstElementChild).toBe(
        chatButton,
      );
      expect(
        container.querySelector(".mobile-bottom-bar[data-chat]"),
      ).not.toBeNull();
      expect(chatButton.textContent).toBe("Chat");
      // On a phone, a new agent pane opens as its chat.
      expect(chatButton.getAttribute("aria-pressed")).toBe("true");
      const { paneView } = await import("./paneView");
      const { roamgateLocalStorage } = await import("./browserStorage");
      const kept = (id: string) =>
        JSON.parse(roamgateLocalStorage.getItem("paneViews") ?? "{}")[
          `local:${id}`
        ];
      expect(paneView("local", "a")).toBe("chat");
      expect(kept("a")).toBeUndefined();
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      const inspectorOpen = () => inspectorProps?.state?.open === true;
      // Chat goes to the terminal, and that choice is the pane's own.
      await React.act(async () => chatButton.click());
      expect(paneView("local", "a")).toBe("terminal");
      expect(kept("a")).toBe("terminal");
      expect(chatButton.getAttribute("aria-pressed")).toBe("false");
      // On a phone, Chat shows the pane's own chat, as conversation mode
      // does, and never the History drawer over the terminal.
      await React.act(async () => chatButton.click());
      expect(paneView("local", "a")).toBe("chat");
      expect(chatButton.getAttribute("aria-pressed")).toBe("true");
      expect(inspectorOpen()).toBe(false);
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      // One message box: the pane's, in the bottom bar.
      expect(terminalProps.mobileInputTarget === inputTarget).toBe(true);
      // Chat again goes back to the terminal.
      await React.act(async () => chatButton.click());
      expect(paneView("local", "a")).toBe("terminal");
      expect(chatButton.getAttribute("aria-pressed")).toBe("false");
      // The menu's Chat and Terminal do the same.
      await React.act(async () => {
        container
          .querySelector<HTMLButtonElement>(".mobile-appbar-tabs")!
          .click();
      });
      await React.act(async () => showSession());
      const menuChat = container.querySelector<HTMLButtonElement>(
        ".mobile-terminal-tools button:first-child",
      )!;
      expect(menuChat.textContent).toBe("Chat");
      await React.act(async () => {
        container
          .querySelector<HTMLButtonElement>(".mobile-appbar-more")!
          .click();
      });
      await React.act(async () => menuChat.click());
      expect(container.querySelector("[data-mobile-more]")).toBeNull();
      expect(paneView("local", "a")).toBe("chat");
      expect(inspectorOpen()).toBe(false);
      expect(terminalButton.classList.contains("active")).toBe(false);
      await React.act(async () => terminalButton.click());
      expect(paneView("local", "a")).toBe("terminal");
      expect(terminalProps.visible).toBe(true);
      expect(terminalButton.classList.contains("active")).toBe(true);
      expect(focusRequests).toHaveLength(0);
      await React.act(async () => terminalProps.onComposerOpenChange!(true));
      expect(terminalProps.composerOpen).toBe(true);
      // An agent's History from the workspace list shows that pane's chat.
      await openHistory("b");
      expect(paneView("local", "b")).toBe("chat");
      expect(inspectorOpen()).toBe(false);
      expect(focusRequests.map((request) => request.paneId)).toEqual(["b"]);
      // Nothing typed reaches A while B's focus is on its way.
      expect(terminalProps.mobileInputTarget).toBeNull();
      expect(terminalProps.composerOpen).toBe(false);
      // A failed focus cannot re-enable A's editor for B's chat.
      await React.act(async () => focusRequests[0]!.finish());
      expect(terminalProps.mobileInputTarget).toBeNull();
      await focusSettled("b");
      expect(terminalProps.paneId).toBe("b");
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      expect(terminalProps.composerOpen).toBe(true);
      expect(chatButton.getAttribute("aria-pressed")).toBe("true");
      // Workspaces keep the pane's input tools, and Chat comes back to them.
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Show workspaces"]')!
          .click(),
      );
      expect(terminalProps.visible).toBe(false);
      expect(terminalProps.composerOpen).toBe(true);
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      await React.act(async () => chatButton.click());
      expect(terminalProps.visible).toBe(true);
      expect(paneView("local", "b")).toBe("chat");
      expect(terminalProps.composerOpen).toBe(true);
      expect(focusRequests).toHaveLength(1);
      // Rapid history switches must keep the latest target, even if focus lags.
      await openHistory("a");
      await openHistory("c");
      await focusSettled("a");
      expect(paneView("local", "c")).toBe("chat");
      expect(terminalProps.mobileInputTarget).toBeNull();
      await focusSettled("c");
      expect(terminalProps.paneId).toBe("c");
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      // A shows its terminal again for the per-pane checks below.
      const { setPaneView } = await import("./paneView");
      setPaneView("local", "a", "terminal");
      // The pane's own request for History does the same.
      await React.act(async () =>
        terminalProps.onAgentHistoryOpenChange!(true),
      );
      expect(inspectorOpen()).toBe(false);
      expect(paneView("local", "c")).toBe("chat");
      // Ordinary shell panes do not advertise a Chat view they cannot open.
      await React.act(async () => {
        snapshot = {
          ...snapshot,
          panes: snapshot.panes.map((pane) => ({ ...pane, agent: undefined })),
        };
        for (const listener of listeners) listener();
      });
      expect(
        container.querySelector(".mobile-appbar .mobile-chat-button"),
      ).toBeNull();
      expect(
        container.querySelector(".mobile-bottom-bar[data-chat]"),
      ).toBeNull();
      expect(menuChat.disabled).toBe(true);

      const switchSession = async (id: string, agent = true) => {
        await React.act(async () => {
          container
            .querySelector<HTMLButtonElement>(".mobile-appbar-tabs")!
            .click();
        });
        await React.act(async () => {
          const tabId = `tab-${id}`;
          snapshot = {
            ...snapshot,
            selectedPaneId: id,
            panes: panes.map((pane) => ({
              ...pane,
              tab_id: `tab-${pane.pane_id}`,
              agent: pane.pane_id === id && !agent ? undefined : "codex",
              focused: pane.pane_id === id,
            })),
            tabs: panes.map((pane, index) => ({
              ...snapshot.tabs[0]!,
              tab_id: `tab-${pane.pane_id}`,
              number: index + 1,
              focused: pane.pane_id === id,
              pane_count: 1,
            })),
            workspaces: snapshot.workspaces.map((workspace) => ({
              ...workspace,
              active_tab_id: tabId,
              tab_count: 3,
            })),
            layout: {
              ...snapshot.layout,
              tab_id: tabId,
              focused_pane_id: id,
              panes: [{ pane_id: id, focused: true, rect }],
            },
          };
          for (const listener of listeners) listener();
        });
        // TabSheet completes after the store has published the new target.
        await React.act(async () => showSession());
      };
      const reload = (key: string) =>
        React.act(async () => root.render(<App key={key} />));
      const pressed = () =>
        container
          .querySelector(".mobile-appbar .mobile-chat-button")
          ?.getAttribute("aria-pressed");

      const { AGENT_RECENCY_STORAGE_KEY, agentRecencyKey, parseAgentRecency } =
        await import("./agentRecency");
      const opened = () =>
        parseAgentRecency(
          roamgateLocalStorage.getItem(AGENT_RECENCY_STORAGE_KEY),
        );
      const key = (id: string) =>
        agentRecencyKey("local", panes.find((pane) => pane.pane_id === id)!);

      // Each pane keeps its own view across switches and page reloads.
      await switchSession("a");
      expect(opened().get(key("a"))).toBeGreaterThan(0);
      const openedA = opened().get(key("a"));
      // Unrelated renders do not count as opening the active agent again.
      await React.act(async () => {
        snapshot = { ...snapshot };
        for (const listener of listeners) listener();
      });
      expect(opened().get(key("a"))).toBe(openedA);
      expect(terminalProps.visible).toBe(true);
      expect(pressed()).toBe("false");
      await reload("terminal");
      expect(pressed()).toBe("false");
      await switchSession("b");
      expect(opened().get(key("b"))).toBeGreaterThan(0);
      expect(terminalProps.paneId).toBe("b");
      expect(pressed()).toBe("true");
      expect(inspectorOpen()).toBe(false);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      const openedC = opened().get(key("c"));
      await switchSession("c", false);
      expect(opened().get(key("c"))).toBe(openedC);
      expect(terminalProps.visible).toBe(true);
      expect(pressed()).toBeUndefined();
      // A shell pane shows its terminal, whatever the phone's default.
      expect(
        container
          .querySelector(
            '.mobile-terminal-tools [aria-label="Show terminal session"]',
          )
          ?.classList.contains("active"),
      ).toBe(true);
      await reload("chat");
      await switchSession("b");
      expect(pressed()).toBe("true");
      expect(inspectorOpen()).toBe(false);
      // A switched to Terminal stays so after switching panes and reloads.
      await switchSession("a");
      expect(pressed()).toBe("false");
      await reload("terminal-again");
      expect(pressed()).toBe("false");
      expect(paneView("local", "a")).toBe("terminal");

      // The desktop keeps its setting, off by default: a pane not switched
      // yet shows its terminal there, and the phone's Chat comes back with
      // the phone layout. Each pane's own choice holds on both.
      const { updateLayoutPreferences } = await import("./layoutPreferences");
      const { setDefaultPaneView } = await import("./paneView");
      await React.act(async () => updateLayoutPreferences({ mode: "desktop" }));
      await reload("desktop");
      expect(paneView("local", "new")).toBe("terminal");
      expect(paneView("local", "a")).toBe("terminal");
      expect(paneView("local", "b")).toBe("chat");
      expect(terminalProps.agentHistoryOpen).toBe(false);
      await React.act(async () => setDefaultPaneView("chat"));
      expect(paneView("local", "new")).toBe("chat");
      expect(paneView("local", "a")).toBe("terminal");
      await React.act(async () => setDefaultPaneView("terminal"));
      expect(paneView("local", "new")).toBe("terminal");
      await React.act(async () => updateLayoutPreferences({ mode: "mobile" }));
      expect(paneView("local", "new")).toBe("chat");
      expect(paneView("local", "a")).toBe("terminal");
      expect(pressed()).toBe("false");
    } finally {
      await React.act(async () => root.unmount());
      for (const spy of spies) spy.mockRestore();
      container.remove();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
