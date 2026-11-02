import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_CHAT_OLDER_DOM_TEST !== "1") {
  test("loading older chat messages in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_OLDER_DOM_TEST: "1" },
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
  test("scrolling to the top of the chat reads older messages a page at a time", async () => {
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
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => message(from + index));
    const olderCalls: Record<string, unknown>[] = [];
    const client = {
      isCurrent: () => true,
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === "agent_session.get")
          return { status: "ok", stats: {}, session: { value: "s1" } };
        if (method === "agent_history.older") {
          olderCalls.push(params);
          // m100 is the window's first entry; m50 the first older page's.
          return params.before_id === "m100"
            ? { entries: range(50, 100), has_more: true }
            : { entries: range(0, 50), has_more: false };
        }
        if (method === "agent_history.get")
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
            entries: range(100, 120),
          };
        return Promise.reject(new Error("pane closed"));
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
    browser.localStorage.setItem("reviewPrefs", JSON.stringify({ vim: false }));
    const { AgentHistoryDrawer } = await import("./AgentHistoryDrawer");
    const { takeRenderCounts } = await import("../renderTrace");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
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
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const bubbles = () =>
      [
        ...container.querySelectorAll<HTMLElement>(
          ".agent-history-chat-content > [data-bubble-id]",
        ),
      ].map((bubble) => bubble.dataset.bubbleId);
    const renders = (name: string) =>
      Number(new RegExp(`${name} (\\d+)`).exec(takeRenderCounts())?.[1] ?? "0");
    try {
      await React.act(async () => {
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
      await settle();
      expect(bubbles()).toEqual(range(100, 120).map((entry) => entry.id));
      // Nothing is read before the reader scrolls up.
      expect(olderCalls).toHaveLength(0);

      const list = container.querySelector<HTMLElement>(".agent-history-chat")!;
      Object.defineProperty(list, "clientHeight", {
        configurable: true,
        get: () => 400,
      });
      const scrollToTop = () =>
        React.act(async () => {
          list.scrollTop = 0;
          list.dispatchEvent(new window.Event("scroll"));
        });
      takeRenderCounts();
      await scrollToTop();
      await settle();
      expect(olderCalls).toHaveLength(1);
      expect(olderCalls[0]).toMatchObject({
        pane_id: "pane-one",
        agent: "claude",
        before_id: "m100",
        limit: 50,
      });
      expect(bubbles()).toEqual(range(50, 120).map((entry) => entry.id));
      // The bubbles already shown are not drawn again, only the new ones.
      expect(renders("ChatBubble")).toBe(50);
      // Their places moved for the minimap.
      expect(
        container.querySelector<HTMLElement>('[data-bubble-id="m100"]')?.dataset
          .sequence,
      ).toBe("51");
      expect(container.textContent).not.toContain(
        "Beginning of the conversation",
      );

      // A second page, the last one: the chat says it starts there.
      await scrollToTop();
      await settle();
      expect(olderCalls).toHaveLength(2);
      expect(olderCalls[1]!.before_id).toBe("m50");
      expect(bubbles()).toEqual(range(0, 120).map((entry) => entry.id));
      expect(container.textContent).toContain("Beginning of the conversation");

      // Nothing more to read: scrolling up again asks nothing.
      await scrollToTop();
      await settle();
      expect(olderCalls).toHaveLength(2);
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
