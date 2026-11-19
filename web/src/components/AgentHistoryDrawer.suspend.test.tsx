import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { AgentChatSnapshot } from "../agentChat";
import type { Pane } from "../types";

if (process.env.ROAMGATE_SUSPEND_DOM_TEST !== "1") {
  test("Ctrl+Z on a conversation, in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SUSPEND_DOM_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    matchMedia: () => ({ matches: false }),
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    KeyboardEvent: browser.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  // Ctrl+Z undoes in a box on Linux: the platform this test runs as.
  Object.defineProperty(browser.navigator, "platform", {
    value: "Linux x86_64",
    configurable: true,
  });
  const state = {
    pane_id: "pane-one",
    owner: "conversation" as const,
    phase: "conversation" as const,
    session_id: "s1",
    cwd: "/repo",
    status: "idle" as const,
    tools_running: false,
    activity: null,
    queue: [],
    interrupted: null,
  };
  const client = {
    connectionId: "conn",
    generation: 1,
    isCurrent: () => true,
    call: async (method: string) => {
      if (method === "agent_chat.subscribe" || method === "agent_chat.state")
        return state;
      if (!method.startsWith("agent_"))
        return Promise.reject(new Error("pane closed"));
      if (method === "agent_session.get")
        return {
          status: "ok",
          stats: {},
          session: { value: "s1", title: "Fix the build" },
        };
      return {
        status: "ok",
        agent: "claude",
        pane_id: "pane-one",
        workspace_id: "workspace",
        tab_id: "tab",
        path: "/sessions/s1.jsonl",
        updated_at: "2026-01-01T00:00:00Z",
        history_version: 2,
        mode: "snapshot",
        cursor: { epoch: "e", revision: 1 },
        window_limit: 200,
        entries: [
          {
            id: "m1",
            role: "user",
            kind: "message",
            text: "Run the tests",
            sent_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
  };
  mock.module("../useConnectionClient", () => ({
    useConnectionClient: () => client,
    useConnectionReady: () => true,
    connectionClientScopeKey: () => "test",
  }));
  browser.localStorage.setItem("vimKeys", "false");
  const { initializeLayoutPreferences } = await import("../layoutPreferences");
  initializeLayoutPreferences();
  const { AgentHistoryDrawer } = await import("./AgentHistoryDrawer");
  const { createRoot } = await import("react-dom/client");
  const pane: Pane = {
    pane_id: "pane-one",
    terminal_id: "term-one",
    workspace_id: "workspace",
    tab_id: "tab",
    agent: "claude",
    agent_status: "idle",
    focused: true,
    revision: 1,
  };
  const conversation: AgentChatSnapshot = {
    state,
    live: { items: [] } as unknown as AgentChatSnapshot["live"],
    refusal: null,
    handing: null,
    departing: [],
    unavailable: false,
  };

  test("Ctrl+Z stops the conversation to the shell, never undoing a draft", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const suspended: (string | null)[] = [];
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    const ctrlZ = (target: EventTarget) => {
      const event = new window.KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      await React.act(async () =>
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{
              onKeys: () => {},
              onShowTerminal: () => {},
              onSuspend: (title) => suspended.push(title),
              readScreen: () => [],
              conversation,
              modeBound: true,
              active: true,
            }}
            onOpenChange={() => {}}
          />,
        ),
      );
      await settle();
      expect(container.textContent).toContain("Run the tests");
      // Nothing focused: Ctrl+Z suspends, with the conversation's title.
      expect(ctrlZ(document.body)).toBe(true);
      expect(suspended.length).toBe(1);
      // In the box with a draft: Ctrl+Z is undo, left to the box.
      const box = container.querySelector("textarea")!;
      await React.act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setValue.call(box, "half a thought");
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await settle();
      expect(ctrlZ(box)).toBe(false);
      expect(suspended.length).toBe(1);
      // The box empty: Ctrl+Z suspends again.
      await React.act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setValue.call(box, "");
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await settle();
      expect(ctrlZ(box)).toBe(true);
      expect(suspended.length).toBe(2);
      // Ctrl+Shift+Z is redo, never a suspend.
      box.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Z",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
      expect(suspended.length).toBe(2);
      // The chat's menu says it, for phones (no Ctrl+Z there).
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Suspend"]',
      )!;
      expect(button.title).toBe(
        "Suspend to the shell (Ctrl+Z): fg brings it back",
      );
      await React.act(async () => {
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(suspended.length).toBe(3);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("outside conversation mode Ctrl+Z is left alone", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const suspended: (string | null)[] = [];
    try {
      await React.act(async () =>
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{
              onKeys: () => {},
              onShowTerminal: () => {},
              onSuspend: (title) => suspended.push(title),
              readScreen: () => [],
              conversation: {
                ...conversation,
                state: { ...state, phase: "terminal", owner: "terminal" },
              } as unknown as AgentChatSnapshot,
              modeBound: true,
              active: true,
            }}
            onOpenChange={() => {}}
          />,
        ),
      );
      const event = new window.KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(suspended).toEqual([]);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}
