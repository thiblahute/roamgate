import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_CHAT_CATCHING_UP_DOM_TEST !== "1") {
  test("the chat's catching-up bar in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_CATCHING_UP_DOM_TEST: "1" },
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
  test("the catching-up bar clears once the history answers, whatever runs after", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      ResizeObserver: browser.ResizeObserver,
      Event: browser.Event,
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
    const message = (n: number) => ({
      id: `m${n}`,
      role: n % 2 ? "assistant" : "user",
      kind: "message",
      text: `message number ${n}`,
      sent_at: "2026-01-01T00:00:00Z",
    });
    Object.defineProperty(browser.document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const historyCalls: string[] = [];
    // Reads answer when released; the session summary never answers, as on
    // a bridge busy reading a large transcript.
    const held: (() => void)[] = [];
    const release = () => held.shift()?.();
    const client = {
      isCurrent: () => true,
      call: (method: string, params: Record<string, unknown>) => {
        if (method === "agent_session.get") return new Promise(() => {});
        if (method === "agent_history.get") {
          const pane = String(params.pane_id);
          historyCalls.push(pane);
          return new Promise((resolve) =>
            held.push(() =>
              resolve({
                status: "ok",
                agent: "claude",
                pane_id: pane,
                workspace_id: "workspace",
                tab_id: "tab",
                path: `/sessions/${pane}.jsonl`,
                updated_at: "2026-01-01T00:00:00Z",
                history_version: 2,
                mode: "snapshot",
                cursor: { epoch: pane, revision: historyCalls.length },
                window_limit: 200,
                entries: [message(1), message(2)],
              }),
            ),
          );
        }
        return Promise.reject(new Error("unavailable"));
      },
    };
    mock.module("../useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => true,
      connectionClientScopeKey: () => "test",
    }));
    const { initializeLayoutPreferences } = await import(
      "../layoutPreferences"
    );
    initializeLayoutPreferences();
    browser.localStorage.setItem("vimKeys", "false");
    const { AgentHistoryDrawer } = await import("./AgentHistoryDrawer");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const paneOf = (id: string, seq = 0): Pane => ({
      pane_id: id,
      terminal_id: `term-${id}`,
      workspace_id: "workspace",
      tab_id: "tab",
      agent: "claude",
      agent_status: "idle",
      focused: true,
      revision: 1,
      state_change_seq: seq,
    });
    const show = (pane: Pane) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal: () => {},
              readScreen: () => [],
            }}
            onOpenChange={() => {}}
          />,
        );
      });
    const settle = (ms = 20) =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const answer = async () => {
      await React.act(async () => release());
      await settle();
    };
    const bar = () => container.querySelector(".agent-chat-catching-up");
    const bubbles = () =>
      container.querySelectorAll(
        ".agent-history-chat-content > [data-bubble-id]",
      ).length;
    try {
      await show(paneOf("pane-one"));
      await settle();
      expect(historyCalls).toEqual(["pane-one"]);
      await answer();
      // The messages show though the session summary has not answered.
      expect(bubbles()).toBe(2);
      expect(bar()).toBeNull();

      // Away and back: what it showed comes back at once, and the bar says
      // it catches up until the history answers.
      await show(paneOf("pane-two"));
      await settle();
      await answer();
      await show(paneOf("pane-one"));
      await settle();
      expect(bubbles()).toBe(2);
      expect(bar()).not.toBeNull();
      await answer();
      expect(bar()).toBeNull();

      // Background refreshes (the agent's turns) keep running, held: the bar
      // stays off, and they are read one at a time.
      await settle(500);
      const before = historyCalls.length;
      for (let seq = 1; seq <= 5; seq++) {
        await show(paneOf("pane-one", seq));
        await settle(5);
      }
      expect(bar()).toBeNull();
      expect(historyCalls.length).toBe(before + 1);
      await answer();
      // What was asked meanwhile is one more read, after a pause.
      await settle(500);
      expect(historyCalls.length).toBe(before + 2);
      expect(bar()).toBeNull();
      await answer();
      await settle(500);
      expect(historyCalls.length).toBe(before + 2);
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
