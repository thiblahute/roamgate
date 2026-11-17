import { inIsolatedChild } from "../testIsolated";
import { expect, jest, test } from "bun:test";
import * as React from "react";

if (
  inIsolatedChild(
    import.meta.path,
    "the mode line and its switch in an isolated browser runtime",
    "ROAMGATE_OWNER_CHIP_DOM_TEST",
    20_000,
  )
) {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { AgentChatOwnerChip } = await import("./AgentChatOwnerChip");
  const { __resetConversationSwitchesForTests } = await import(
    "../conversationSwitch"
  );
  const { createRoot } = await import("react-dom/client");
  type Props = Parameters<typeof AgentChatOwnerChip>[0];

  const setup = (answers: unknown[] = []) => {
    __resetConversationSwitchesForTests();
    const calls: { method: string; params: unknown }[] = [];
    const client = {
      connectionId: "local",
      generation: 1,
      isCurrent: () => true,
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "agent_chat.handover" && answers.length)
          return answers.shift();
        return { ok: true, owner: "conversation", session_id: "s1" };
      },
    } as unknown as Props["client"];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const chat = (phase: Props["chat"]["phase"]): Props["chat"] =>
      ({
        pane_id: "wV:p2",
        owner: phase === "conversation" ? "conversation" : "terminal",
        phase,
        session_id: "s1",
        cwd: "/repo",
        status: phase === "conversation" ? "working" : "stopped",
        tools_running: false,
        activity: null,
        queue: [],
        interrupted: null,
      }) as unknown as Props["chat"];
    const render = (props: Partial<Props>) =>
      React.act(async () => {
        root.render(
          <AgentChatOwnerChip
            client={client}
            paneId="wV:p2"
            chat={chat("terminal")}
            refusal={null}
            handing={null}
            agentStatus="idle"
            {...props}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const text = () => container.textContent ?? "";
    const buttons = () =>
      [...container.querySelectorAll("button")].map((b) => b.textContent);
    const click = (label: string) =>
      React.act(async () => {
        const button = [...container.querySelectorAll("button")].find(
          (b) => b.textContent === label,
        );
        if (!button) throw new Error(`no ${label} button in: ${text()}`);
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const handovers = () =>
      calls.filter((call) => call.method === "agent_chat.handover");
    return { root, client, chat, render, text, buttons, click, handovers };
  };

  test("conversation mode alone shows nothing, whatever Herdr says", async () => {
    const { root, chat, render, text } = setup();
    try {
      await render({ chat: chat("conversation"), agentStatus: "working" });
      expect(document.querySelector(".agent-chat-owner")).toBeNull();
      expect(text()).toBe("");
      // On its way there, it still says so.
      await render({ chat: chat("to_conversation") });
      expect(text()).toBe("Switching to conversation mode");
      await render({ chat: chat("conversation"), handing: "terminal" });
      expect(text()).toBe("Opening in the terminal");
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("a refused Open in terminal says why as text, never offers a switch, and can be put away", async () => {
    const { root, chat, render, text, buttons } = setup();
    const refusal = "The pane holder is not connected";
    const putAway = () =>
      document.querySelector<HTMLButtonElement>(
        '.agent-chat-owner button[aria-label="Put this away"]',
      );
    try {
      await render({ chat: chat("conversation"), refusal });
      expect(text()).toStartWith("Still in conversation mode");
      // Read, not hovered: a phone has no hover.
      expect(
        document.querySelector(".agent-chat-owner-reason")?.textContent,
      ).toBe(refusal);
      expect(text()).not.toContain("Terminal mode");
      // Its only button puts it away; no switch is offered.
      expect(buttons()).toEqual([""]);
      await React.act(async () => {
        putAway()!.dispatchEvent(
          new window.MouseEvent("click", { bubbles: true }),
        );
      });
      expect(document.querySelector(".agent-chat-owner")).toBeNull();
      // The same refusal stays away; another one shows.
      await render({ chat: chat("conversation"), refusal });
      expect(document.querySelector(".agent-chat-owner")).toBeNull();
      await render({ chat: chat("conversation"), refusal: "Try again" });
      expect(text()).toContain("Try again");
      // Refused again once cleared, it shows again.
      await render({ chat: chat("conversation"), refusal: null });
      expect(text()).toBe("");
      await render({ chat: chat("conversation"), refusal });
      expect(text()).toContain(refusal);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("terminal mode, Claude idle: one label and a switch that goes now", async () => {
    const { root, render, text, buttons, click, handovers } = setup();
    try {
      await render({});
      expect(text()).toStartWith("Terminal mode");
      expect(buttons()).toEqual(["Switch to conversation mode"]);
      await click("Switch to conversation mode");
      expect(handovers()).toEqual([
        {
          method: "agent_chat.handover",
          params: { pane_id: "wV:p2", to: "conversation" },
        },
      ]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("terminal mode, Claude busy: the switch is armed, goes once the turn ends, and can be cancelled", async () => {
    const { root, render, text, buttons, click, handovers } = setup();
    const refusal =
      "Claude is working (a turn or a background task); it can switch once it is idle";
    try {
      await render({ agentStatus: "working", refusal });
      // The busy refusal is not repeated: the button says it.
      expect(text()).not.toContain(refusal);
      expect(buttons()).toEqual(["Switch to conversation mode when idle"]);
      await click("Switch to conversation mode when idle");
      expect(text()).toContain("Switching when Claude is done…");
      expect(buttons()).toEqual(["Cancel"]);
      expect(handovers()).toEqual([]);
      // The turn ends: the armed switch goes, as the user's own.
      await render({ agentStatus: "idle", refusal });
      expect(handovers()).toEqual([
        {
          method: "agent_chat.handover",
          params: { pane_id: "wV:p2", to: "conversation" },
        },
      ]);
      expect(text()).not.toContain("Switching when Claude is done");

      // Cancelled: nothing goes when the next turn ends.
      await render({ agentStatus: "working", refusal });
      await click("Switch to conversation mode when idle");
      await click("Cancel");
      expect(buttons()).toEqual(["Switch to conversation mode when idle"]);
      await render({ agentStatus: "idle", refusal: null });
      expect(handovers()).toHaveLength(1);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("an armed switch is dropped when the session moves by other means", async () => {
    const { root, chat, render, click, handovers, buttons } = setup();
    try {
      await render({ agentStatus: "working" });
      await click("Switch to conversation mode when idle");
      await render({ chat: chat("conversation"), agentStatus: "idle" });
      await render({ chat: chat("terminal"), agentStatus: "idle" });
      expect(handovers()).toEqual([]);
      expect(buttons()).toEqual(["Switch to conversation mode"]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("background work keeps the switch waiting, asking again later and later", async () => {
    const waiting = {
      ok: false,
      reason: "Claude still runs background work (1 shell)",
      waiting: "background_tasks",
    };
    const { root, client, chat, text, buttons, handovers } = setup([
      waiting,
      waiting,
    ]);
    // Promises settle; timers move only when told.
    const settle = () =>
      React.act(async () => {
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
      });
    const advance = async (ms: number) => {
      await React.act(async () => {
        jest.advanceTimersByTime(ms);
      });
      await settle();
    };
    try {
      jest.useFakeTimers();
      await React.act(async () => {
        root.render(
          <AgentChatOwnerChip
            client={client}
            paneId="wV:p2"
            chat={chat("terminal")}
            refusal={null}
            handing={null}
            agentStatus="idle"
            retryMs={1000}
            retryMaxMs={4000}
          />,
        );
      });
      await settle();
      await React.act(async () => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent === "Switch to conversation mode",
        );
        button?.dispatchEvent(
          new window.MouseEvent("click", { bubbles: true }),
        );
      });
      await settle();
      expect(handovers()).toHaveLength(1);
      expect(text()).toContain("Waiting for background tasks to finish");
      expect(buttons()).toEqual(["Cancel"]);
      // Not before the wait is over.
      await advance(999);
      expect(handovers()).toHaveLength(1);
      await advance(1);
      expect(handovers()).toHaveLength(2);
      // Refused again: the next wait is twice as long.
      await advance(1999);
      expect(handovers()).toHaveLength(2);
      await advance(1);
      expect(handovers()).toHaveLength(3);
      // The work ended: it switched, and waits no more.
      expect(text()).not.toContain("Waiting for background tasks");
      await advance(60_000);
      expect(handovers()).toHaveLength(3);
    } finally {
      jest.useRealTimers();
      await React.act(async () => root.unmount());
    }
  });

  test("a waiting switch can be cancelled: nothing more is asked", async () => {
    const waiting = {
      ok: false,
      reason: "Claude still runs background work (1 shell)",
      waiting: "background_tasks",
    };
    const { root, render, text, click, handovers } = setup([waiting]);
    try {
      await render({ retryMs: 30, retryMaxMs: 60 });
      await click("Switch to conversation mode");
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(text()).toContain("Waiting for background tasks to finish");
      await click("Cancel");
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(handovers()).toHaveLength(1);
      expect(text()).not.toContain("Waiting for background tasks");
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
