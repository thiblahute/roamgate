import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_TERMINAL_MODE_DOM_TEST !== "1") {
  test("a terminal-mode Claude's History in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_TERMINAL_MODE_DOM_TEST: "1" },
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
  let phase: "terminal" | "conversation" = "terminal";
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const client = {
    connectionId: "conn",
    generation: 1,
    isCurrent: () => true,
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "agent_chat.subscribe" || method === "agent_chat.state")
        return {
          pane_id: "pane-one",
          owner: phase,
          phase,
          session_id: "s1",
          cwd: "/repo",
          status: "idle",
          tools_running: false,
          activity: null,
          queue: [],
          interrupted: null,
        };
      if (method === "agent_chat.handover") {
        phase = params?.to as typeof phase;
        return { ok: true, owner: phase, session_id: "s1" };
      }
      if (!method.startsWith("agent_"))
        return Promise.reject(new Error("pane closed"));
      if (method === "agent_session.get")
        return { status: "ok", stats: {}, session: { value: "s1" } };
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

  test("the History of a terminal-mode Claude types into nothing, and offers the switch", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    try {
      await React.act(async () =>
        root.render(
          <AgentHistoryDrawer pane={pane} open onOpenChange={() => {}} />,
        ),
      );
      await settle();
      expect(container.textContent).toContain("Run the tests");
      // Read only: no message box, a word on why.
      expect(container.querySelector("textarea")).toBeNull();
      expect(
        container.querySelector(".agent-history-readonly")?.textContent,
      ).toContain("Claude is in terminal mode");
      expect(
        container.querySelector(".agent-chat-owner")?.textContent,
      ).toContain("Terminal mode");
      // Nothing asked by showing it.
      expect(calls.some((call) => call.method === "agent_chat.handover")).toBe(
        false,
      );
      // The user's switch, from its header.
      const button = [...container.querySelectorAll("button")].find(
        (each) => each.textContent === "Switch to conversation mode",
      )!;
      await React.act(async () => {
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await settle();
      expect(
        calls.filter((call) => call.method === "agent_chat.handover"),
      ).toEqual([
        {
          method: "agent_chat.handover",
          params: { pane_id: "pane-one", to: "conversation" },
        },
      ]);
      // Conversation mode: the box is back, and talks to it; the header
      // has no mode line left to show.
      expect(container.querySelector(".agent-history-readonly")).toBeNull();
      expect(container.querySelector("textarea")).not.toBeNull();
      expect(container.querySelector(".agent-chat-owner")).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}
