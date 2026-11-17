import { inIsolatedChild } from "../testIsolated";
import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type {
  AssistantMention,
  AssistantMentionTarget,
  AssistantMessage,
  AssistantSnapshot,
  AssistantWorkspace,
} from "../../../shared/assistant";

if (
  inIsolatedChild(
    import.meta.path,
    "Ranger chat UI in an isolated browser runtime",
    "ROAMGATE_RANGER_CHAT_DOM_TEST",
    20_000,
  )
) {
  test("Ranger's pane renders the shared chat, its threads, and its own controls", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    // A plain message box (no Vim editor to load).
    browser.localStorage.setItem("roamgate:vimKeys", "false");
    const { RangerChat } = await import("./RangerChat");
    const { rememberReviewSnapshot } = await import("../review");
    const { createRoot } = await import("react-dom/client");
    const message = (
      id: string,
      role: AssistantMessage["role"],
      text: string,
    ): AssistantMessage => ({
      id,
      role,
      text,
      sent_at: "2026-10-31T10:00:00Z",
      tools: [],
      sources: [],
    });
    let snapshot: AssistantSnapshot = {
      instance_id: "bridge",
      revision: 1,
      session_id: "session-one",
      config: {
        provider: "claude-code",
        model: "sonnet",
        credential_source: "assistant",
        allowed_workspaces: [],
      },
      providers: [],
      models: [],
      messages: [
        message("ask-1", "user", "What is the rebase doing?"),
        message(
          "reply-1",
          "assistant",
          "The rebase is **paused** on a conflict.\n\nIt waits for you.",
        ),
      ],
      queue: [],
      running: false,
      error: null,
      auth: null,
    };
    // A thread on a part of Ranger's reply, answered by Ranger.
    rememberReviewSnapshot({
      session: {
        id: "review-1",
        connectionId: "local",
        workspaceId: "ranger",
        root: "/",
        title: "Chat with Ranger",
        target: { kind: "chat", chat: "ranger:session-one" },
        gitlab: false,
        summary: "",
        agent: { name: "Ranger", paneId: "ranger:session-one" },
        createdAt: "2026-10-31T10:00:00Z",
        updatedAt: "2026-10-31T10:00:00Z",
      },
      threads: [
        {
          id: "thread-1",
          sessionId: "review-1",
          kind: "discussion",
          anchor: {
            chat: { entry: "reply-1", quote: "It waits for you." },
          },
          comments: [
            {
              id: "comment-1",
              author: "you",
              body: "Which conflict?",
              createdAt: "2026-10-31T10:01:00Z",
              updatedAt: "2026-10-31T10:01:00Z",
            },
            {
              id: "comment-2",
              author: "Ranger",
              body: "The one in **server/src/index.ts**.",
              createdAt: "2026-10-31T10:02:00Z",
              updatedAt: "2026-10-31T10:02:00Z",
            },
          ],
          resolved: false,
          createdAt: "2026-10-31T10:01:00Z",
          updatedAt: "2026-10-31T10:02:00Z",
        },
      ],
    });
    const onSend = mock(async () => {});
    const onStop = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let searchOpen = false;
    let mobile = false;
    let composerTarget: HTMLElement | null = null;
    const render = async () => {
      await React.act(async () =>
        root.render(
          <RangerChat
            snapshot={snapshot}
            connectionId="local"
            mobile={mobile}
            composerTarget={composerTarget}
            searchOpen={searchOpen}
            onSearchOpenChange={(open) => {
              searchOpen = open;
            }}
            workspaces={[]}
            disabled={null}
            extras={(entry) =>
              entry.id === "reply-1"
                ? {
                    after: <div className="test-action-card">Create a tab</div>,
                  }
                : {}
            }
            empty={<p>Nothing yet</p>}
            onSend={onSend}
            onStop={onStop}
            onRemoveQueued={async () => true}
            onError={() => {}}
          >
            <button type="button" aria-label="Ranger permissions">
              Ask for approval
            </button>
          </RangerChat>,
        ),
      );
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
    };
    try {
      await render();
      // The shared chat: its bubbles, Markdown, copy and speak buttons.
      const bubbles = container.querySelectorAll(
        ".agent-history-chat .agent-history-chat-message",
      );
      expect(bubbles).toHaveLength(2);
      expect(bubbles[0]!.classList.contains("is-user")).toBe(true);
      expect(bubbles[1]!.classList.contains("is-assistant")).toBe(true);
      expect(bubbles[1]!.querySelector("strong")?.textContent).toBe("paused");
      expect(
        bubbles[1]!.querySelector('[aria-label="Copy assistant message"]'),
      ).not.toBeNull();
      expect(
        bubbles[1]!.querySelector('[aria-label="Speak assistant message"]'),
      ).not.toBeNull();
      // What voice reads streamed is found in the saved reply.
      expect(bubbles[1]!.getAttribute("data-block-key")).toBe("reply-1:0");
      // Ranger's own card, in its place right after the reply.
      const card = container.querySelector(".test-action-card")!;
      expect(card.closest(".agent-history-chat-custom")).not.toBeNull();
      expect(
        card.closest(".agent-history-chat-custom")!.previousElementSibling,
      ).toBe(bubbles[1]!);
      // The thread on a part of the reply, with Ranger's answer in it.
      expect(container.querySelector(".chat-threads-scope")).not.toBeNull();
      const thread = container.querySelector(
        '.chat-thread[data-thread-id="thread-1"]',
      )!;
      expect(thread).not.toBeNull();
      expect(bubbles[1]!.contains(thread)).toBe(true);
      const authors = Array.from(
        thread.querySelectorAll(".chat-thread-author"),
        (author) => author.textContent,
      );
      expect(authors).toEqual(["You", "Ranger"]);
      expect(thread.textContent).toContain("server/src/index.ts");
      // The minimap over its two messages.
      expect(container.querySelector(".conversation-minimap")).not.toBeNull();
      // The shared message box, with Ranger's controls under it.
      const box = container.querySelector<HTMLTextAreaElement>(
        '.agent-history-composer textarea[aria-label="Message Ranger"]',
      )!;
      expect(box).not.toBeNull();
      expect(box.placeholder).toBe(
        "Ask about your workspaces, or @mention one",
      );
      const footer = box.closest(".assistant-panel-footer")!;
      expect(
        footer.querySelector('[aria-label="Ranger permissions"]'),
      ).not.toBeNull();
      // No image button: Ranger takes no images.
      expect(container.querySelector('[aria-label="Add images"]')).toBeNull();
      expect(container.querySelector('[aria-label="Stop"]')).toBeNull();
      // Its keys move into the conversation, as in an agent's chat.
      expect(box.closest(".agent-history-messages")).not.toBeNull();

      // Enter sends, but not while an input method composes, on a key
      // repeat, or with Shift (a new line).
      const fill = async (text: string) => {
        await React.act(async () => {
          Object.getOwnPropertyDescriptor(
            browser.HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(box, text);
          box.setSelectionRange(text.length, text.length);
          box.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      const enter = async (
        options: {
          isComposing?: boolean;
          keyCode?: number;
          repeat?: boolean;
          shiftKey?: boolean;
          altKey?: boolean;
        } = {},
      ) => {
        await React.act(async () => {
          box.dispatchEvent(
            new browser.KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
              ...options,
            }) as unknown as Event,
          );
        });
      };
      const composition = async (type: string) => {
        await React.act(async () => {
          box.dispatchEvent(
            new browser.CompositionEvent(type, {
              bubbles: true,
            }) as unknown as Event,
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      await fill("Explain the changes");
      await enter({ isComposing: true });
      await enter({ keyCode: 229 });
      await enter({ repeat: true });
      await enter({ shiftKey: true });
      await composition("compositionstart");
      await enter();
      expect(onSend).not.toHaveBeenCalled();
      await composition("compositionend");
      await enter();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend.mock.calls[0]).toEqual([
        "Explain the changes",
        [],
        undefined,
      ] as never);

      // While it answers: Stop beside Send, and the word that it works.
      snapshot = {
        ...snapshot,
        running: true,
        messages: [
          ...snapshot.messages,
          message("ask-2", "user", "And now?"),
          message("reply-2", "assistant", ""),
        ],
      };
      await render();
      expect(container.textContent).toContain("Working...");
      const stop = container.querySelector<HTMLButtonElement>(
        '[aria-label="Stop"]',
      )!;
      expect(stop.title).toContain("confirmed actions continue");
      await React.act(async () => stop.click());
      expect(onStop).toHaveBeenCalledTimes(1);

      // Search keeps the messages that hold the words.
      searchOpen = true;
      await render();
      const search = container.querySelector<HTMLInputElement>(
        '[aria-label="Search Ranger messages"]',
      )!;
      expect(search).not.toBeNull();
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(search, "rebase");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(
        container.querySelectorAll(".agent-history-chat-message"),
      ).toHaveLength(2);
      expect(container.querySelector(".test-action-card")).toBeNull();

      // On a phone, the box alone goes in the bottom bar, as an agent
      // chat's does, so the bar's layout keeps it clear of the navigation;
      // Ranger's own controls stay in its pane.
      searchOpen = false;
      mobile = true;
      composerTarget = document.createElement("div");
      composerTarget.className = "mobile-bottom-input";
      document.body.append(composerTarget);
      await render();
      expect(
        Array.from(composerTarget.children, (child) => child.className),
      ).toEqual(["agent-history-composer"]);
      expect(
        composerTarget.querySelector('textarea[aria-label="Message Ranger"]'),
      ).not.toBeNull();
      expect(
        composerTarget.querySelector('[aria-label="Ranger permissions"]'),
      ).toBeNull();
      expect(
        container.querySelector(
          '.ranger-chat-footer.is-docked [aria-label="Ranger permissions"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(".ranger-chat-footer .agent-history-composer"),
      ).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("Ranger's box offers @mentions, picks one without sending, names it in the message, and says when the list fails", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    browser.localStorage.setItem("roamgate:vimKeys", "false");
    const assistant = await import("../assistant");
    const { RangerChat } = await import("./RangerChat");
    const { createRoot } = await import("react-dom/client");
    const workspace: AssistantWorkspace = {
      connection_id: "local",
      workspace_id: "project",
      runtime_generation: 1,
      connection_label: "Mac",
      label: "Project",
    };
    const agent: AssistantMentionTarget = {
      ...workspace,
      kind: "agent",
      workspace_label: workspace.label,
      label: "Codex / Project",
      agent: "codex",
      pane_id: "pane-one",
      terminal_id: "terminal-one",
      agent_identity: "a".repeat(64),
    };
    let resolveCatalog!: (value: {
      targets: AssistantMentionTarget[];
      errors: string[];
    }) => void;
    const catalog = spyOn(
      assistant,
      "getAssistantMentions",
    ).mockReturnValueOnce(
      new Promise((done) => {
        resolveCatalog = done;
      }),
    );
    const snapshot: AssistantSnapshot = {
      instance_id: "bridge",
      revision: 1,
      session_id: "session-one",
      config: {
        provider: "claude-code",
        model: "sonnet",
        credential_source: "assistant",
        allowed_workspaces: [workspace],
      },
      providers: [],
      models: [],
      messages: [],
      queue: [],
      running: false,
      error: null,
      auth: null,
    };
    let workspaces = [workspace];
    const onSend = mock(
      async (...sent: [string, AssistantMention[], ("steer" | "queue")?]) => {
        void sent;
      },
    );
    const errors: string[] = [];
    const openMention = mock((target: AssistantMentionTarget) => {
      void target;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async () => {
      await React.act(async () =>
        root.render(
          <RangerChat
            snapshot={snapshot}
            connectionId="local"
            mobile={false}
            workspaces={workspaces}
            disabled={null}
            extras={() => ({})}
            empty={<p>Nothing yet</p>}
            onSend={onSend}
            onStop={() => {}}
            onRemoveQueued={async () => true}
            onError={(message) => errors.push(message)}
            currentWorkspace={workspace}
            onOpenMention={openMention}
          />,
        ),
      );
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
    };
    const box = () =>
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Ranger"]',
      )!;
    const fill = async (text: string) => {
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box(), text);
        box().setSelectionRange(text.length, text.length);
        box().dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const key = async (
      name: string,
      options: {
        isComposing?: boolean;
        keyCode?: number;
        repeat?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
      } = {},
    ) => {
      await React.act(async () => {
        box().dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...options,
          }) as unknown as Event,
        );
      });
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
    };
    const options = () =>
      Array.from(
        container.querySelectorAll('[role="listbox"] [role="option"]'),
        (option) => option.querySelector("strong")?.textContent,
      );
    const expanded = () => box().getAttribute("aria-expanded") === "true";
    try {
      await render();
      box().focus();
      // An email address is no mention.
      await fill("user@example.com");
      expect(expanded()).toBe(false);
      expect(catalog).not.toHaveBeenCalled();
      // @ opens the picker: the workspaces at hand while the list loads,
      // then their agents.
      await fill("Explain @Pro");
      expect(expanded()).toBe(true);
      expect(catalog).toHaveBeenCalledTimes(1);
      expect(options()).toEqual(["Project"]);
      await React.act(async () =>
        resolveCatalog({ targets: [agent], errors: [] }),
      );
      expect(options()).toEqual(["Codex / Project", "Project"]);
      // While an input method composes, Enter neither picks nor sends.
      await key("Enter", { isComposing: true });
      expect(box().value).toBe("Explain @Pro");
      // Enter picks without sending; the focus stays in the box, and the
      // pick is a chip attached to it.
      await key("Enter");
      expect(box().value).toBe("Explain @Codex / Project ");
      expect(onSend).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(box());
      expect(expanded()).toBe(false);
      const chip = container.querySelector<HTMLButtonElement>(
        ".assistant-mention-chip button",
      )!;
      expect(chip.textContent).toContain("Codex / Project");
      await React.act(async () => {
        chip.dispatchEvent(new Event("click", { bubbles: true }));
      });
      expect(openMention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "agent", pane_id: "pane-one" }),
      );
      // Then Enter sends it as a reference bound to the message.
      await key("Enter");
      expect(onSend).toHaveBeenCalledTimes(1);
      const [text, mentions, whenBusy] = onSend.mock.calls[0]!;
      expect(text).toBe("Explain @Codex / Project ");
      expect(whenBusy).toBeUndefined();
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatchObject({
        kind: "agent",
        pane_id: "pane-one",
        start: 8,
        end: 24,
      });
      expect(container.querySelector(".assistant-mention-chip")).toBeNull();
      // Typed text alone binds nothing.
      await fill("Explain @Project ");
      await key("Escape");
      await key("Enter");
      expect(onSend.mock.calls[1]![1]).toEqual([]);
      // Esc puts the picker away.
      await fill("@Pro");
      expect(expanded()).toBe(true);
      await key("Escape");
      expect(expanded()).toBe(false);

      // A list that cannot be read says why, in the picker and as an
      // error; what is at hand stays offered.
      catalog.mockRejectedValueOnce(
        new Error("Method unavailable; update the bridge."),
      );
      workspaces = [{ ...workspace, workspace_id: "other", label: "Other" }];
      await render();
      await fill("@Oth");
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
      expect(errors).toContain("Method unavailable; update the bridge.");
      expect(container.textContent).toContain("update the bridge");
      expect(options()).toEqual(["Other"]);
      await key("Escape");
      catalog.mockResolvedValueOnce({
        targets: [],
        errors: ["Mac is not reachable"],
      });
      workspaces = [workspace];
      await render();
      await fill("@Pro");
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
      expect(errors).toContain("Mac is not reachable");
      await key("Escape");
      // An older bridge's line per unreadable pane folds into one line, in
      // the picker and as the error: never list items.
      errors.length = 0;
      catalog.mockResolvedValueOnce({
        targets: [],
        errors: [
          "Agent unavailable in sequence / w1F:p2",
          "Agent unavailable in gstreamer-ocio / w27:p1",
          "Agent unavailable in clauth / wJ:p3",
        ],
      });
      await fill("@Pro");
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
      expect(errors).toEqual(["3 agents could not be read"]);
      expect(
        container.querySelectorAll(".assistant-mention-notice"),
      ).toHaveLength(1);
      expect(options().join("|")).not.toContain("Agent unavailable");
    } finally {
      catalog.mockRestore();
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("while Ranger answers, Send steers its turn, and Queue or Alt+Enter keeps a message for after it", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    browser.localStorage.setItem("roamgate:vimKeys", "false");
    const assistant = await import("../assistant");
    const { RangerChat } = await import("./RangerChat");
    const { createRoot } = await import("react-dom/client");
    const workspace: AssistantWorkspace = {
      connection_id: "local",
      workspace_id: "project",
      runtime_generation: 1,
      connection_label: "Mac",
      label: "Project",
    };
    const catalog = spyOn(assistant, "getAssistantMentions").mockResolvedValue({
      targets: [],
      errors: [],
    });
    let snapshot: AssistantSnapshot = {
      instance_id: "bridge",
      revision: 1,
      session_id: "session-one",
      config: {
        provider: "claude-code",
        model: "sonnet",
        credential_source: "assistant",
        allowed_workspaces: [workspace],
      },
      providers: [],
      models: [],
      messages: [],
      queue: [],
      running: false,
      error: null,
      auth: null,
    };
    const workspaces = [workspace];
    let steerable = true;
    const onSend = mock(
      async (...sent: [string, AssistantMention[], ("steer" | "queue")?]) => {
        void sent;
      },
    );
    const errors: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async () => {
      await React.act(async () =>
        root.render(
          <RangerChat
            snapshot={snapshot}
            connectionId="local"
            mobile={false}
            workspaces={workspaces}
            disabled={null}
            extras={() => ({})}
            empty={<p>Nothing yet</p>}
            onSend={onSend}
            onStop={() => {}}
            onRemoveQueued={async () => true}
            onError={(message) => errors.push(message)}
            canSteer={steerable}
            onOpenMention={() => {}}
          />,
        ),
      );
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
    };
    const box = () =>
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Ranger"]',
      )!;
    const fill = async (text: string) => {
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(box(), text);
        box().setSelectionRange(text.length, text.length);
        box().dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const key = async (
      name: string,
      options: {
        isComposing?: boolean;
        keyCode?: number;
        repeat?: boolean;
        shiftKey?: boolean;
        altKey?: boolean;
      } = {},
    ) => {
      await React.act(async () => {
        box().dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...options,
          }) as unknown as Event,
        );
      });
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
    };
    try {
      await render();
      // Idle: Send alone.
      expect(container.querySelector('[aria-label="Queue"]')).toBeNull();
      snapshot = { ...snapshot, running: true };
      await render();
      expect(
        container.querySelector('[aria-label="Steer"]')?.textContent,
      ).toContain("Steer");
      const queue = container.querySelector<HTMLButtonElement>(
        '[aria-label="Queue"]',
      )!;
      expect(queue.title).toMatch(
        /^Queue: send after Ranger finishes \((Alt|Option)\+Enter\)$/,
      );
      await fill("Then the tests");
      await key("Enter", { altKey: true });
      expect(onSend).toHaveBeenLastCalledWith("Then the tests", [], "queue");
      await fill("Look at the logs too");
      await key("Enter");
      expect(onSend).toHaveBeenLastCalledWith(
        "Look at the logs too",
        [],
        "steer",
      );
      await fill("And the docs");
      await React.act(async () => {
        queue.dispatchEvent(new Event("click", { bubbles: true }));
      });
      await React.act(
        async () => new Promise((resolve) => setTimeout(resolve, 0)),
      );
      expect(onSend).toHaveBeenLastCalledWith("And the docs", [], "queue");
      // An agent that cannot be steered has Send alone.
      steerable = false;
      await render();
      expect(container.querySelector('[aria-label="Queue"]')).toBeNull();
      // Idle again: no Queue, and Alt+Enter sends as Enter does.
      steerable = true;
      snapshot = { ...snapshot, running: false };
      await render();
      expect(container.querySelector('[aria-label="Queue"]')).toBeNull();
      await fill("Thanks");
      await key("Enter", { altKey: true });
      expect(onSend).toHaveBeenCalledTimes(4);
      expect(onSend).toHaveBeenLastCalledWith("Thanks", [], undefined);
    } finally {
      catalog.mockRestore();
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("a minimap jump scrolls Ranger's own list, not the panel or page around it", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    browser.localStorage.setItem("roamgate:vimKeys", "false");
    const { RangerChat } = await import("./RangerChat");
    const { createRoot } = await import("react-dom/client");
    const said = (
      id: string,
      role: AssistantMessage["role"],
      text: string,
    ): AssistantMessage => ({
      id,
      role,
      text,
      sent_at: "2026-11-11T10:00:00Z",
      tools: [],
      sources: [],
    });
    const snapshot: AssistantSnapshot = {
      instance_id: "bridge",
      revision: 1,
      session_id: "session-jump",
      config: {
        provider: "claude-code",
        model: "sonnet",
        credential_source: "assistant",
        allowed_workspaces: [],
      },
      providers: [],
      models: [],
      messages: [
        said("one", "user", "What changed?"),
        said("two", "assistant", "The parser."),
        said("three", "user", "Then test it"),
      ],
      queue: [],
      running: false,
      error: null,
      auth: null,
    };
    // What scrollIntoView would move: every scroller around the chat.
    const intoView = mock(() => {});
    const intoViewBefore = browser.Element.prototype.scrollIntoView;
    browser.Element.prototype.scrollIntoView = intoView;
    const panel = document.createElement("div");
    panel.style.overflowY = "auto";
    document.body.append(panel);
    const root = createRoot(panel);
    try {
      await React.act(async () =>
        root.render(
          <RangerChat
            snapshot={snapshot}
            connectionId="local"
            mobile={false}
            workspaces={[]}
            disabled={null}
            extras={() => ({})}
            empty={<p>Nothing yet</p>}
            onSend={async () => {}}
            onStop={() => {}}
            onRemoveQueued={async () => true}
            onError={() => {}}
          />,
        ),
      );
      const list = panel.querySelector<HTMLElement>(".agent-history-chat")!;
      const last = list.querySelector<HTMLElement>('[data-sequence="3"]')!;
      const box = (top: number) => () =>
        ({ top, bottom: top + 40, height: 40 }) as DOMRect;
      list.getBoundingClientRect = box(100);
      last.getBoundingClientRect = box(700);
      list.scrollTop = 50;
      panel.scrollTop = 30;
      const slider = panel.querySelector<HTMLElement>('[role="slider"]')!;
      await React.act(async () => {
        slider.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "End",
            bubbles: true,
            cancelable: true,
          }) as unknown as Event,
        );
      });
      // At once, 12px under the list's top, as upstream's Ranger jumped.
      expect(list.scrollTop).toBe(638);
      expect(panel.scrollTop).toBe(30);
      expect(intoView).not.toHaveBeenCalled();
    } finally {
      browser.Element.prototype.scrollIntoView = intoViewBefore;
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
