import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { Pane } from "./types";
import type { TerminalView } from "./components/TerminalView";

if (process.env.ROAMGATE_APP_MODE_SWITCH_TEST !== "1") {
  test("a phone's Chat and Terminal on a Claude pane, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_MODE_SWITCH_TEST: "1" },
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
  }, 20_000);
} else {
  test("on a phone, Chat offers the switch to conversation mode, Terminal the way back", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/?layout=mobile" });
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
    spyOn(store, "get").mockImplementation(() => snapshot);
    spyOn(store, "init").mockImplementation(() => {});
    spyOn(store, "subscribe").mockImplementation(subscribe);
    const storeModule = await import("./store");
    mock.module("./store", () => ({
      ...storeModule,
      useStoreSelector: <T,>(
        selector: (state: ReturnType<typeof store.get>) => T,
      ) => selector(React.useSyncExternalStore(subscribe, () => snapshot)),
    }));
    // The bridge's conversation mode for the pane, and what was asked.
    let phase: "terminal" | "conversation" = "terminal";
    const state = () => ({
      pane_id: "a",
      owner: phase,
      phase,
      session_id: "s1",
      cwd: "/repo",
      status: "idle",
      tools_running: false,
      activity: null,
      queue: [],
      interrupted: null,
    });
    const handovers: unknown[] = [];
    const client = {
      connectionId: "local",
      generation: 1,
      isCurrent: () => true,
      call: async (method: string, params?: Record<string, unknown>) => {
        if (method === "agent_chat.subscribe" || method === "agent_chat.state")
          return state();
        if (method === "agent_chat.handover") {
          handovers.push(params);
          phase = params?.to as typeof phase;
          return { ok: true, owner: phase, session_id: "s1" };
        }
        return {};
      },
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
    // Whatever else App takes from these modules stays as it is.
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
    let terminalProps!: React.ComponentProps<typeof TerminalView>;
    mock.module("./components/TerminalView", () => ({
      TerminalView: (props: typeof terminalProps) => {
        terminalProps = props;
        return null;
      },
    }));
    const { initializeLayoutPreferences } = await import("./layoutPreferences");
    initializeLayoutPreferences();
    // Even with agents opening as a chat, never a Claude's chat over its
    // terminal mode.
    (await import("./paneView")).setDefaultPaneView("chat");
    const { conversationSwitchState } = await import("./conversationSwitch");
    const { requestAgentChatHandover } = await import("./agentChat");
    const { default: App } = await import("./App");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const dialog = () => document.querySelector('[role="dialog"]');
    const dialogButton = (label: string) =>
      [...(dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === label,
      ) as HTMLButtonElement | undefined;
    try {
      await React.act(async () => root.render(<App />));
      await settle();
      expect(terminalProps.paneId).toBe("a");
      const chatButton = container.querySelector<HTMLButtonElement>(
        '.mobile-appbar [aria-label="Show agent message history"]',
      )!;
      const terminalButton = container.querySelector<HTMLButtonElement>(
        '.mobile-terminal-tools [aria-label="Show terminal session"]',
      )!;
      // More options has no entry of its own for a Claude pane's view: its
      // Chat and Terminal are the switch.
      const viewEntries = () =>
        [
          ...container.querySelectorAll(
            '[aria-label="Workspace view switcher"] button',
          ),
        ]
          .map((button) => button.textContent ?? "")
          .filter((label) => /chat|terminal|conversation/i.test(label));
      // The buttons that lead to the terminal, wherever they are.
      const terminalWays = () =>
        [...container.querySelectorAll("button")].filter((button) =>
          /terminal/i.test(
            `${button.getAttribute("aria-label") ?? ""} ${button.textContent}`,
          ),
        );
      // Terminal mode shows the terminal, whatever the default view.
      expect(chatButton.getAttribute("aria-pressed")).toBe("false");
      expect(dialog()).toBeNull();
      expect(viewEntries()).toEqual([]);

      // Chat offers the switch, and asks nothing until confirmed.
      await React.act(async () => chatButton.click());
      expect(dialog()?.textContent).toContain("Switch to conversation mode?");
      expect(chatButton.getAttribute("aria-pressed")).toBe("false");
      expect(handovers).toEqual([]);
      // Cancelled: nothing changes.
      await React.act(async () => dialogButton("Cancel")!.click());
      expect(dialog()).toBeNull();
      expect(conversationSwitchState("local", "a")).toBe("none");
      expect(handovers).toEqual([]);
      // Confirmed: the user's switch is asked for the pane (its terminal
      // drives it once Claude is not busy).
      await React.act(async () => chatButton.click());
      await React.act(async () =>
        dialogButton("Switch to conversation mode")!.click(),
      );
      expect(dialog()).toBeNull();
      expect(conversationSwitchState("local", "a")).toBe("armed");
      // The pane's terminal asks the bridge, as the switch goes.
      await React.act(async () => {
        await requestAgentChatHandover(client as never, "a", "conversation");
      });
      await settle();
      expect(handovers).toEqual([{ pane_id: "a", to: "conversation" }]);
      // Conversation mode shows the chat: Chat is pressed, and asks nothing.
      expect(chatButton.getAttribute("aria-pressed")).toBe("true");
      // One way to the terminal: More options' Terminal.
      expect(viewEntries()).toEqual([]);
      expect(terminalWays()).toEqual([terminalButton]);
      await React.act(async () => chatButton.click());
      expect(dialog()).toBeNull();
      expect(handovers).toHaveLength(1);

      // Terminal offers Open in terminal; confirmed, it hands it back.
      await React.act(async () => terminalButton.click());
      expect(dialog()?.textContent).toContain("Open in terminal?");
      expect(handovers).toHaveLength(1);
      await React.act(async () => dialogButton("Open in terminal")!.click());
      await settle();
      expect(handovers).toEqual([
        { pane_id: "a", to: "conversation" },
        { pane_id: "a", to: "terminal" },
      ]);
      expect(chatButton.getAttribute("aria-pressed")).toBe("false");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}
