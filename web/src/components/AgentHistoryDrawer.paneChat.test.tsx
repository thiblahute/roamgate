import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_PANE_CHAT_DOM_TEST !== "1") {
  test("pane chat in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PANE_CHAT_DOM_TEST: "1" },
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
  const typedIntoPanes: string[] = [];
  const client = {
    connectionId: "conn",
    generation: 1,
    isCurrent: () => true,
    // The pane refuses what is typed into it; the transcript reads work.
    call: async (method: string) =>
      !method.startsWith("agent_")
        ? (typedIntoPanes.push(method),
          Promise.reject(new Error("pane closed")))
        : method === "agent_session.get"
          ? { status: "ok", stats: {}, session: { value: "s1" } }
          : {
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
            },
  };
  mock.module("../useConnectionClient", () => ({
    useConnectionClient: () => client,
    useConnectionReady: () => true,
    connectionClientScopeKey: () => "test",
  }));
  // A plain message box: Vim keys (CodeMirror) off.
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
  const onShowTerminal = () => {};
  const mount = () => {
    const container = document.createElement("div");
    document.body.append(container);
    return { container, root: createRoot(container) };
  };
  const button = (container: HTMLElement, label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  test("a pane's chat has one slim row and says what the agent does", async () => {
    const { container, root } = mount();
    const terminalCalls = typedIntoPanes;
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      );
    const click = (element: HTMLElement) =>
      React.act(async () => element.click());
    terminalCalls.length = 0;
    const onKeys = mock<(text: string) => void>(() => {});
    const onShowTerminal = mock(() => {});
    const render = (agent_status: string) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            // A pane of its own: its outbox is not the next test's.
            pane={{
              ...pane,
              pane_id: "pane-slim",
              terminal_id: "term-slim",
              agent_status,
            }}
            open
            embedded
            paneChat={{ onKeys, onShowTerminal }}
            onOpenChange={() => {}}
          />,
        );
      });
    try {
      await render("working");
      expect(container.textContent).toContain("Run the tests");
      expect(container.querySelector(".is-pane-chat")).not.toBeNull();
      // The History drawer's own controls stay in the History drawer.
      expect(button("Session details")).toBeNull();
      expect(button("Chat view")).toBeNull();
      expect(container.querySelector('input[type="search"]')).toBeNull();
      expect(container.querySelector(".agent-history-composer")).not.toBeNull();
      expect(container.querySelector(".agent-chat-activity")).not.toBeNull();
      await click(button("Stop")!);
      expect(onKeys.mock.calls).toEqual([["\x1b"]]);
      await click(button("Search the conversation")!);
      expect(container.querySelector('input[type="search"]')).not.toBeNull();

      await render("blocked");
      expect(button("Stop")).toBeNull();
      expect(container.querySelector(".agent-chat-activity")).toBeNull();
      expect(container.textContent).toContain("claude is waiting for you");
      const toTerminal = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".agent-chat-prompt button",
        ),
      ).find((each) => each.textContent?.trim() === "Terminal")!;
      await click(toTerminal);
      await click(button("Show the terminal")!);
      expect(onShowTerminal).toHaveBeenCalledTimes(2);

      await render("idle");
      expect(container.querySelector(".agent-chat-prompt")).toBeNull();
      expect(container.querySelector(".agent-chat-activity")).toBeNull();

      // Two blocked agents side by side: their questions show as buttons,
      // and a key typed with nothing focused answers the active pane only.
      const prompt = {
        lines: ["Run the tests?"],
        options: [
          { key: "1", label: "Yes", input: "1", cursor: true },
          { key: "2", label: "No", input: "2" },
        ],
      };
      const activeKeys = mock<(text: string) => void>(() => {});
      const otherKeys = mock<(text: string) => void>(() => {});
      await React.act(async () => {
        root.render(
          <>
            <AgentHistoryDrawer
              pane={{ ...pane, agent_status: "blocked" }}
              open
              embedded
              paneChat={{
                prompt,
                active: true,
                onKeys: activeKeys,
                onShowTerminal,
              }}
              onOpenChange={() => {}}
            />
            <AgentHistoryDrawer
              pane={{
                ...pane,
                pane_id: "pane-two",
                terminal_id: "term-two",
                agent_status: "blocked",
              }}
              open
              embedded
              paneChat={{
                prompt,
                active: false,
                onKeys: otherKeys,
                onShowTerminal,
              }}
              onOpenChange={() => {}}
            />
          </>,
        );
      });
      // A choice only: the message box steps aside.
      expect(
        container.querySelectorAll(".agent-history-composer"),
      ).toHaveLength(0);
      (document.activeElement as HTMLElement | null)?.blur();
      await React.act(async () => {
        document.body.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "2", bubbles: true }),
        );
      });
      expect(activeKeys.mock.calls).toEqual([["2"]]);
      expect(otherKeys.mock.calls).toEqual([]);
      const yes = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".agent-chat-prompt-actions button",
        ),
      ).find((each) => each.textContent?.includes("Yes"))!;
      expect(yes.getAttribute("aria-current")).toBe("true");
      await click(yes);
      expect(activeKeys.mock.calls).toEqual([["2"], ["1"]]);

      // An active pane's free-text question must focus its own box, even
      // when another pane's composer appears first in the document.
      await React.act(async () => {
        root.render(
          <>
            <AgentHistoryDrawer
              pane={{
                ...pane,
                pane_id: "pane-two",
                terminal_id: "term-two",
                agent_status: "idle",
              }}
              open
              embedded
              paneChat={{ active: false, onKeys: otherKeys, onShowTerminal }}
              onOpenChange={() => {}}
            />
            <AgentHistoryDrawer
              pane={{ ...pane, agent_status: "blocked" }}
              open
              embedded
              paneChat={{
                active: true,
                onKeys,
                onShowTerminal,
                prompt: {
                  lines: ["Your answer?"],
                  options: [
                    {
                      key: "1",
                      label: "Type something.",
                      input: "",
                      freeText: true,
                      cursor: true,
                      checked: true,
                    },
                  ],
                },
              }}
              onOpenChange={() => {}}
            />
          </>,
        );
      });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const boxes = container.querySelectorAll("textarea");
      expect(boxes).toHaveLength(2);
      expect(document.activeElement).toBe(boxes[1]);

      // A message the pane refused stays in the chat, marked, and is still
      // there after the pane went to its terminal and back.
      await render("idle");
      const box = container.querySelector("textarea")!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box, "Also check the docs");
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await React.act(async () => {
        box.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container.textContent).toContain("Not delivered");
      await React.act(async () => root.render(null));
      expect(container.textContent).not.toContain("Not delivered");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("only the active pane's question takes keys typed with nothing focused", async () => {
    const { container, root } = mount();
    const prompt = {
      lines: ["Run the tests?"],
      options: [
        { key: "1", label: "Yes", input: "1", cursor: true },
        { key: "2", label: "No", input: "2" },
      ],
    };
    const activeKeys = mock<(text: string) => void>(() => {});
    const otherKeys = mock<(text: string) => void>(() => {});
    try {
      await React.act(async () => {
        root.render(
          <>
            <AgentHistoryDrawer
              pane={{ ...pane, agent_status: "blocked" }}
              open
              embedded
              paneChat={{
                prompt,
                active: true,
                onKeys: activeKeys,
                onShowTerminal,
              }}
              onOpenChange={() => {}}
            />
            <AgentHistoryDrawer
              pane={{
                ...pane,
                pane_id: "pane-two",
                terminal_id: "term-two",
                agent_status: "blocked",
              }}
              open
              embedded
              paneChat={{
                prompt,
                active: false,
                onKeys: otherKeys,
                onShowTerminal,
              }}
              onOpenChange={() => {}}
            />
          </>,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container.querySelectorAll(".agent-chat-prompt")).toHaveLength(2);
      (document.activeElement as HTMLElement | null)?.blur();
      await React.act(async () => {
        document.body.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "2", bubbles: true }),
        );
      });
      expect(activeKeys.mock.calls).toEqual([["2"]]);
      expect(otherKeys.mock.calls).toEqual([]);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("a message the pane refused outlives the chat that showed it", async () => {
    const { container, root } = mount();
    const render = () =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{ prompt: null, onKeys: () => {}, onShowTerminal }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    try {
      await render();
      expect(container.textContent).toContain("Run the tests");
      const box = container.querySelector("textarea")!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box, "Also check the docs");
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await React.act(async () => {
        box.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container.textContent).toContain("Not delivered");
      // The pane goes to its terminal: the chat unmounts, then comes back.
      await React.act(async () => root.render(null));
      expect(container.textContent).not.toContain("Not delivered");
      await render();
      expect(container.textContent).toContain("Also check the docs");
      expect(container.textContent).toContain("Not delivered");
      expect(button(container, "Send this message again")).not.toBeNull();
      await React.act(async () =>
        button(container, "Discard this message")!.click(),
      );
      expect(container.textContent).not.toContain("Not delivered");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      await browser.happyDOM.close();
    }
  });
}
