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
    MutationObserver: browser.MutationObserver,
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
  // The session's transcript as the bridge serves it; a test adds to it.
  const transcript: Record<string, unknown>[] = [
    {
      id: "m1",
      role: "user",
      kind: "message",
      text: "Run the tests",
      sent_at: "2026-01-01T00:00:00Z",
    },
  ];
  let revision = 1;
  const sent: { text: string; uuid?: string }[] = [];
  const switched: string[] = [];
  // The model agent_profile.get says the session runs; a test changes it.
  let profileModel: string | null = null;
  let imageCalls = 0;
  const imageLanes: (string | undefined)[] = [];
  URL.createObjectURL = () => "blob:sent-image";
  const client = {
    connectionId: "conn",
    generation: 1,
    isCurrent: () => true,
    // The pane refuses what is typed into it; the transcript reads work,
    // and conversation mode takes what is sent.
    call: async (
      method: string,
      params?: Record<string, unknown>,
      _timeoutMs?: number | null,
      options?: { lane?: string },
    ) => {
      if (method === "agent_history.image") {
        imageCalls += 1;
        imageLanes.push(options?.lane);
        // The first try is lost (a phone's socket away), the next loads.
        return imageCalls === 1
          ? Promise.reject(new Error("bridge hello is unavailable"))
          : { media_type: "image/png", data: "iVBORw0KGgo=" };
      }
      if (method === "agent_chat.send") {
        sent.push(params as { text: string; uuid?: string });
        return { status: "sent", id: params?.uuid };
      }
      if (method === "agent_chat.models")
        return {
          models: [
            { value: "default", label: "Default (recommended)" },
            { value: "haiku", label: "Haiku", resolved: "claude-haiku-5-5" },
          ],
          current: null,
          chosen: null,
          source: "agent",
        };
      if (method === "agent_profile.get")
        return {
          session_id: "s1",
          owner: "conversation",
          profile: "Claude",
          label: "Claude",
          default: "Claude",
          profiles: [
            { name: "Claude", agent: "claude", label: "Claude", default: true },
          ],
          ...(profileModel ? { model: profileModel } : {}),
        };
      if (method === "agent_chat.model") {
        switched.push(String(params?.model));
        return { ok: true, model: "claude-haiku-5-5" };
      }
      if (!method.startsWith("agent_")) typedIntoPanes.push(method);
      return !method.startsWith("agent_")
        ? Promise.reject(new Error("pane closed"))
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
              cursor: { epoch: "e", revision },
              window_limit: 200,
              entries: [...transcript],
            };
    },
  };
  mock.module("../useConnectionClient", () => ({
    useConnectionClient: () => client,
    useConnectionReady: () => true,
    connectionClientScopeKey: () => "test",
  }));
  // A plain message box: Vim keys (CodeMirror) off.
  browser.localStorage.setItem("vimKeys", "false");
  const { initializeLayoutPreferences, updateLayoutPreferences } = await import(
    "../layoutPreferences"
  );
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

  test("a minimap jump scrolls the chat's own list, not the pane or page around it", async () => {
    const { container, root } = mount();
    const added = [
      {
        id: "m-jump-2",
        role: "assistant",
        kind: "message",
        text: "The tests pass",
        sent_at: "2026-01-01T00:00:01Z",
      },
      {
        id: "m-jump-3",
        role: "user",
        kind: "message",
        text: "Then ship it",
        sent_at: "2026-01-01T00:00:02Z",
      },
    ];
    transcript.push(...added);
    revision += 1;
    // What scrollIntoView would move: every scroller around the chat.
    const intoView = mock(() => {});
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = intoView;
    container.style.overflowY = "auto";
    try {
      await React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={{ ...pane, pane_id: "pane-jump", terminal_id: "term-jump" }}
            open
            embedded
            paneChat={{
              onKeys: () => {},
              onShowTerminal,
              readScreen: () => [],
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container.textContent).toContain("Then ship it");
      const list = container.querySelector<HTMLElement>(".agent-history-chat")!;
      const last = list.querySelector<HTMLElement>('[data-sequence="3"]')!;
      const box = (top: number) => () =>
        ({ top, bottom: top + 40, height: 40 }) as DOMRect;
      list.getBoundingClientRect = box(100);
      last.getBoundingClientRect = box(700);
      list.scrollTop = 50;
      container.scrollTop = 30;
      const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
      await React.act(async () => {
        slider.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "End",
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(list.scrollTop).toBe(650);
      expect(container.scrollTop).toBe(30);
      expect(intoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
      transcript.splice(transcript.length - added.length, added.length);
      revision += 1;
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

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
            paneChat={{ onKeys, onShowTerminal, readScreen: () => [] }}
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
      // Stopping the agent sits beside Send while it works.
      await click(button("Stop the agent")!);
      expect(onKeys.mock.calls).toEqual([["\x1b"]]);
      await click(button("Search the conversation")!);
      expect(container.querySelector('input[type="search"]')).not.toBeNull();

      await render("blocked");
      expect(button("Stop the agent")).toBeNull();
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
                readScreen: () => [],
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
                readScreen: () => [],
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
              paneChat={{
                active: false,
                onKeys: otherKeys,
                onShowTerminal,
                readScreen: () => [],
              }}
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
                readScreen: () => [],
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
                readScreen: () => [],
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
                readScreen: () => [],
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

  test("an agent that cannot rewind or run ! lines offers neither", async () => {
    const { container, root } = mount();
    const render = (capabilities?: Record<string, unknown>) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal,
              readScreen: () => [],
              conversation: {
                state: {
                  pane_id: "pane-one",
                  owner: "conversation",
                  phase: "conversation",
                  session_id: "s1",
                  cwd: "/repo",
                  status: "idle",
                  tools_running: false,
                  activity: null,
                  queue: [],
                  interrupted: null,
                  ...(capabilities ? { capabilities } : {}),
                },
                live: { items: [], endedAt: null },
                refusal: null,
                handing: null,
                departing: [],
                unavailable: false,
              } as never,
              modeBound: true,
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const rewind = () =>
      container.querySelectorAll(
        'button[aria-label="Rewind to before this message"]',
      ).length;
    const typed = async (text: string) => {
      const box = container.querySelector("textarea")!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box, text);
        box.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    const shellBox = () =>
      !!container.querySelector(".agent-history-composer.is-shell");
    try {
      // No capabilities (an older bridge): Claude's, rewind and ! lines on.
      await render();
      expect(rewind()).toBeGreaterThan(0);
      await typed("!ls");
      expect(shellBox()).toBe(true);
      await typed("");
      await render({
        steer: true,
        questions: true,
        alwaysAllow: true,
        rewind: null,
        promptSuggestions: false,
        shellLines: null,
        backgroundTasks: false,
        images: "path",
        slashCommands: null,
        models: false,
      });
      expect(rewind()).toBe(0);
      await typed("!ls");
      expect(shellBox()).toBe(false);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("a Claude chat in conversation mode goes back by Open in terminal, a phone's by its bottom bar", async () => {
    const { container, root } = mount();
    let opened = 0;
    const conversation = (phase: "conversation" | "to_conversation") => ({
      state: {
        pane_id: "pane-one",
        owner: "conversation" as const,
        phase,
        session_id: "s1",
        cwd: "/repo",
        status: "idle" as const,
        tools_running: false,
        activity: null,
        queue: [],
        interrupted: null,
      },
      live: { items: [], endedAt: null },
      refusal: null,
      handing: null,
      departing: [],
      unavailable: false,
    });
    const render = (
      phase: "conversation" | "to_conversation",
      modeBound = true,
    ) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={pane}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal: () => {
                opened += 1;
              },
              readScreen: () => [],
              ...(modeBound
                ? { conversation: conversation(phase) as never, modeBound }
                : {}),
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const phone = (on: boolean) =>
      React.act(async () => {
        updateLayoutPreferences({ mode: on ? "mobile" : "auto" });
      });
    try {
      // Still taking over: nothing to open in the terminal yet.
      await render("to_conversation");
      expect(button(container, "Open in terminal")?.disabled).toBe(true);
      expect(button(container, "Show the terminal")).toBeNull();
      expect(container.querySelector(".agent-chat-owner")?.textContent).toBe(
        "Switching to conversation mode",
      );
      await render("conversation");
      // In conversation mode the header has no mode line.
      expect(container.querySelector(".agent-chat-owner")).toBeNull();
      const open = button(container, "Open in terminal")!;
      expect(open.disabled).toBe(false);
      await React.act(async () => open.click());
      expect(opened).toBe(1);
      // An agent without conversation mode shows its terminal from there.
      await render("conversation", false);
      expect(button(container, "Show the terminal")).not.toBeNull();

      // A phone's way to the terminal is its bottom bar's More options:
      // none in the header, for either.
      await phone(true);
      await render("conversation");
      expect(container.querySelector(".agent-chat-title")).not.toBeNull();
      expect(button(container, "Open in terminal")).toBeNull();
      expect(button(container, "Show the terminal")).toBeNull();
      await render("conversation", false);
      expect(button(container, "Show the terminal")).toBeNull();
      expect(button(container, "Open in terminal")).toBeNull();
    } finally {
      await phone(false);
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("/model in conversation mode opens the chat's own picker; `/model <name>` goes to the bridge", async () => {
    const { container, root } = mount();
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
    const render = (extra: Record<string, unknown> = {}) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={{ ...pane, pane_id: "pane-one" }}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal,
              readScreen: () => [],
              conversation: {
                state: { ...state, ...extra },
                live: { items: [], endedAt: null },
                refusal: null,
                handing: null,
                departing: [],
              } as never,
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const send = async (text: string) => {
      const box = container.querySelector("textarea")!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box, text);
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
    };
    const sheet = () =>
      document.querySelector('[role="dialog"][aria-label="Model"]');
    sent.length = 0;
    try {
      await render();
      await send("/model");
      expect(sent).toEqual([]);
      expect(sheet()).not.toBeNull();
      const haiku = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".agent-model-list button",
        ),
      ].find((row) => row.textContent?.includes("Haiku"))!;
      await React.act(async () => {
        haiku.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(switched).toEqual(["haiku"]);
      expect(sheet()).toBeNull();
      // With a name: the bridge switches it (and says so in the chat).
      await send("/model sonnet");
      expect(sent.map((each) => each.text)).toEqual(["/model sonnet"]);
      expect(sheet()).toBeNull();
      await render({
        model_notice: {
          at: "2026-11-06T10:00:00.000Z",
          ok: false,
          requested: "sonet",
          model: null,
          text: "Could not switch the model to sonet: Model 'sonet' not found",
        },
      });
      expect(
        container.querySelector('.agent-history-chat-lost[role="alert"]')
          ?.textContent,
      ).toContain("Could not switch the model to sonet");
    } finally {
      sent.length = 0;
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("the chat header says the model the session runs, and a switch at once", async () => {
    const { container, root } = mount();
    const state = {
      pane_id: "pane-model",
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
    const render = (extra: Record<string, unknown> = {}) =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={{ ...pane, pane_id: "pane-model", terminal_id: "term-model" }}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal,
              readScreen: () => [],
              conversation: {
                state: { ...state, ...extra },
                live: { items: [], endedAt: null },
                refusal: null,
                handing: null,
                departing: [],
              } as never,
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const chip = () =>
      container.querySelector<HTMLElement>(
        ".agent-history-drawer-head .agent-chat-model",
      );
    try {
      profileModel = null;
      await render();
      // Not known: nothing is guessed.
      expect(chip()).toBeNull();
      profileModel = "claude-opus-5-5";
      await render({ status: "working" });
      expect(chip()?.textContent).toBe("Opus 5.5");
      expect(chip()?.getAttribute("aria-label")).toBe("Model: Opus 5.5");
      expect(chip()?.title).toContain("Model: claude-opus-5-5");
      // Beside the status pill.
      expect(
        chip()?.previousElementSibling?.classList.contains(
          "agent-history-status",
        ),
      ).toBe(true);
      // A /model switch shows at once, the status unchanged.
      profileModel = "claude-haiku-5-5";
      await render({
        status: "working",
        model_notice: {
          at: "2026-11-16T10:00:00.000Z",
          ok: true,
          requested: "haiku",
          model: "claude-haiku-5-5",
          text: "Model set to haiku (claude-haiku-5-5)",
        },
      });
      expect(chip()?.textContent).toBe("Haiku 5.5");
      expect(chip()?.title).toContain("Model: claude-haiku-5-5");
    } finally {
      profileModel = null;
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("a conversation-mode message is drawn once its replay lands, also after a remount", async () => {
    const { container, root } = mount();
    const conversation = {
      state: {
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
      },
      live: { items: [], endedAt: null },
      refusal: null,
      handing: null,
      departing: [],
    };
    const render = () =>
      React.act(async () => {
        root.render(
          <AgentHistoryDrawer
            pane={{ ...pane, pane_id: "pane-one" }}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal,
              readScreen: () => [],
              conversation: conversation as never,
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const question = "Has upstream started reviewing?";
    const drawn = () => container.textContent!.split(question).length - 1;
    try {
      await render();
      const box = container.querySelector("textarea")!;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box, question);
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
      expect(sent.map((each) => each.text)).toEqual([question]);
      const uuid = sent[0]!.uuid;
      expect(uuid).toBeTruthy();
      // On its way until the transcript has it.
      expect(container.querySelectorAll("[data-outbox-id]")).toHaveLength(1);
      expect(drawn()).toBe(1);
      // Claude took it as a turn and answered.
      transcript.push(
        {
          id: "u2",
          uuid,
          role: "user",
          kind: "message",
          text: question,
          sent_at: "2026-01-01T00:01:00Z",
        },
        {
          id: "a2",
          role: "assistant",
          kind: "message",
          text: "Not yet.",
          sent_at: "2026-01-01T00:01:05Z",
        },
      );
      revision += 1;
      // The chat goes away (the pane shows its terminal) and comes back:
      // it reads the transcript again.
      await React.act(async () => root.render(null));
      await render();
      expect(container.textContent).toContain("Not yet.");
      expect(drawn()).toBe(1);
      expect(container.querySelectorAll("[data-outbox-id]")).toHaveLength(0);
      expect(container.querySelector(".agent-history-chat-queued")).toBeNull();
      await React.act(async () => root.render(null));
      await render();
      expect(drawn()).toBe(1);
      expect(container.querySelectorAll("[data-outbox-id]")).toHaveLength(0);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });

  test("an image sent in a message shows once it loads, even after a failed try", async () => {
    const { container, root } = mount();
    transcript.push({
      id: "u3",
      uuid: "image-message",
      role: "user",
      kind: "message",
      text: "this is a regression",
      images: 1,
      sent_at: "2026-01-01T00:02:00Z",
    });
    revision += 1;
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
              onShowTerminal,
              readScreen: () => [],
            }}
            onOpenChange={() => {}}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(container.textContent).toContain("this is a regression");
      expect(imageCalls).toBe(1);
      // Images fill in behind what the user waits on.
      expect(imageLanes).toEqual(["background"]);
      // One lost request is no reason to say it is missing.
      expect(container.textContent).not.toContain("could not be loaded");
      expect(
        container.querySelector(".agent-history-chat-image.is-loading"),
      ).not.toBeNull();
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      });
      expect(imageCalls).toBe(2);
      expect(
        container
          .querySelector(".agent-history-chat-image img")
          ?.getAttribute("src"),
      ).toBe("blob:sent-image");
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
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal,
              readScreen: () => [],
            }}
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
