import { expect, jest, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_MODE_SWITCH_DOM_TEST !== "1") {
  test("the user's mode switch in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MODE_SWITCH_DOM_TEST: "1" },
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
  const {
    __resetConversationSwitchesForTests,
    requestConversationSwitch,
    useConversationSwitch,
  } = await import("./conversationSwitch");
  const { TerminalModeStrip } = await import("./components/TerminalModeStrip");
  const { createRoot } = await import("react-dom/client");
  type Phase = "terminal" | "to_conversation" | "conversation";

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
    } as never;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    // A pane's terminal: it drives the switch, and shows its strip.
    function Pane({
      phase,
      status,
      view,
    }: {
      phase: Phase;
      status: string;
      /** What the browser shows, which must not matter. */
      view: string;
    }) {
      const switching = useConversationSwitch({
        client,
        paneId: "w1:p1",
        phase,
        handing: false,
        agentStatus: status,
        retryMs: 1000,
      });
      return (
        <div data-view={view}>
          {switching.state !== "none" ? (
            <TerminalModeStrip
              state={switching.state}
              refusal={null}
              queued={0}
              onSwitch={switching.request}
              onCancel={switching.cancel}
              onDismiss={() => {}}
            />
          ) : null}
        </div>
      );
    }
    const render = (props: { phase: Phase; status: string; view: string }) =>
      React.act(async () => {
        root.render(
          <>
            <Pane {...props} />
            {/* Another view of the same pane (the History inspector). */}
            <Pane {...props} />
          </>,
        );
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
    const handovers = () =>
      calls.filter((call) => call.method === "agent_chat.handover");
    return { root, container, render, handovers, client, calls };
  };

  test("showing a pane, in any view, never switches its mode", async () => {
    const { root, render, handovers } = setup();
    try {
      for (const view of ["chat", "terminal", "chat", "hidden", "chat"])
        for (const status of ["idle", "done", "working", "idle"])
          await render({ phase: "terminal", status, view });
      expect(handovers()).toEqual([]);
      for (const view of ["terminal", "chat", "terminal"])
        await render({ phase: "conversation", status: "idle", view });
      expect(handovers()).toEqual([]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("the user's switch goes once, however many views drive it", async () => {
    const { root, render, handovers } = setup();
    try {
      await render({ phase: "terminal", status: "idle", view: "terminal" });
      await React.act(async () => {
        requestConversationSwitch("local", "w1:p1");
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      await render({ phase: "terminal", status: "idle", view: "terminal" });
      expect(handovers()).toEqual([
        {
          method: "agent_chat.handover",
          params: { pane_id: "w1:p1", to: "conversation" },
        },
      ]);
      // Taken over: asked once, nothing more.
      await render({ phase: "conversation", status: "idle", view: "chat" });
      expect(handovers()).toHaveLength(1);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("Claude busy: the strip says it waits, and the switch goes when the turn ends", async () => {
    const { root, container, render, handovers } = setup();
    try {
      await render({ phase: "terminal", status: "working", view: "terminal" });
      await React.act(async () => {
        requestConversationSwitch("local", "w1:p1");
      });
      expect(container.textContent).toContain(
        "Switching to conversation mode when Claude is done",
      );
      expect(handovers()).toEqual([]);
      await render({ phase: "terminal", status: "idle", view: "terminal" });
      expect(handovers()).toHaveLength(1);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("background work: the strip says the switch waits for it", async () => {
    const waiting = {
      ok: false,
      reason: "Claude still runs background work (1 shell)",
      waiting: "background_tasks",
    };
    const { root, container, render, handovers, calls } = setup([waiting]);
    try {
      await render({ phase: "terminal", status: "idle", view: "terminal" });
      await React.act(async () => {
        requestConversationSwitch("local", "w1:p1");
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
      });
      await render({ phase: "terminal", status: "idle", view: "terminal" });
      expect(handovers()).toHaveLength(1);
      expect(container.textContent).toContain(
        "Waiting for background tasks to finish",
      );
      // Cancelled: nothing more is asked.
      await React.act(async () => {
        [...container.querySelectorAll("button")]
          .find((each) => each.textContent === "Cancel")!
          .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });
      expect(handovers()).toHaveLength(1);
      expect(container.textContent).not.toContain("Waiting");
      // The bridge stops waiting for an exit asked before, if any.
      expect(
        calls.filter((call) => call.method !== "agent_chat.handover"),
      ).toEqual([
        { method: "agent_chat.handover.cancel", params: { pane_id: "w1:p1" } },
      ]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("the strip's own words", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const strip = (props: {
      state: "none" | "armed" | "waiting" | "asking";
      refusal: string | null;
      queued: number;
    }) =>
      React.act(async () =>
        root.render(
          <TerminalModeStrip
            {...props}
            onSwitch={() => {}}
            onCancel={() => {}}
            onDismiss={() => {}}
          />,
        ),
      );
    try {
      await strip({ state: "none", refusal: null, queued: 2 });
      expect(container.textContent).toContain(
        "2 messages wait for conversation mode",
      );
      expect(container.textContent).toContain("Switch to conversation mode");
      await strip({
        state: "none",
        refusal: "Claude's prompt box is not on screen",
        queued: 0,
      });
      expect(container.textContent).toContain(
        "Still in terminal mode: Claude's prompt box is not on screen",
      );
      expect(container.textContent).toContain("Try again");
      await strip({ state: "asking", refusal: null, queued: 0 });
      expect(container.textContent).toContain(
        "Switching to conversation mode…",
      );
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  const otherWriter = (status: "idle" | "working" | "blocked" | "unknown") => ({
    pane_id: "w2:p12",
    workspace_id: "w2",
    tab_id: "w2:t2",
    workspace_label: "roamgate",
    tab_label: "Tab 2",
    agent_name: "Claude",
    status,
  });
  const buttons = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].map(
      (each) => each.textContent || each.getAttribute("aria-label"),
    );
  const click = (container: HTMLElement, label: string) =>
    React.act(async () => {
      [...container.querySelectorAll("button")]
        .find((each) => each.textContent === label)!
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

  test("another Claude on the session: the strip says where and why, and offers to quit an idle one", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const clicked: string[] = [];
    const strip = (writer: ReturnType<typeof otherWriter>) =>
      React.act(async () =>
        root.render(
          <TerminalModeStrip
            state="none"
            refusal="This session is also open in roamgate / Tab 2 (pane w2:p12)"
            writer={writer}
            writerPlace="roamgate / Tab 2"
            queued={0}
            onSwitch={() => clicked.push("switch")}
            onCancel={() => {}}
            onDismiss={() => clicked.push("dismiss")}
            onGoToWriter={() => clicked.push("go")}
            onQuitWriter={() => clicked.push("quit")}
          />,
        ),
      );
    try {
      await strip(otherWriter("idle"));
      expect(container.textContent).toContain(
        "Still in terminal mode. This session is also open in roamgate / Tab 2, where Claude is idle. Only one Claude can write a session, so conversation mode waits until that one is closed.",
      );
      expect(container.querySelector("strong")?.textContent).toBe(
        "roamgate / Tab 2",
      );
      // The pane is named, never only by its id.
      expect(container.textContent).not.toContain("w2:p12");
      expect(buttons(container)).toEqual([
        "Go to it",
        "Quit it and switch",
        "Put this away",
      ]);
      await click(container, "Go to it");
      await click(container, "Quit it and switch");
      expect(clicked).toEqual(["go", "quit"]);

      // Busy: it says so, and offers no quit.
      for (const [status, words] of [
        ["working", "where Claude is working"],
        ["blocked", "where Claude waits for an answer"],
        ["unknown", "open in roamgate / Tab 2. Only one Claude"],
      ] as const) {
        await strip(otherWriter(status));
        expect(container.textContent).toContain(words);
        expect(buttons(container)).toEqual([
          "Go to it",
          "Try again",
          "Put this away",
        ]);
      }

      // A quit that did not happen says why.
      await strip({
        ...otherWriter("idle"),
        quit_refusal:
          "Something is typed in Claude's prompt box; send or clear it first",
      } as ReturnType<typeof otherWriter>);
      expect(container.textContent).toContain(
        "It did not quit: Something is typed in Claude's prompt box; send or clear it first.",
      );
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("Quit it and switch asks the switch once with the pane to quit", async () => {
    const refused = {
      ok: false as const,
      reason: "This session is also open in roamgate / Tab 2 (pane w2:p12)",
      writer: otherWriter("idle"),
    };
    // Background work here, once the other one has quit.
    const { root, container, client, handovers } = setup([
      { ok: false, reason: "1 shell", waiting: "background_tasks" },
    ]);
    function Quitting() {
      const switching = useConversationSwitch({
        client,
        paneId: "w1:p1",
        phase: "terminal",
        handing: false,
        agentStatus: "idle",
        retryMs: 1000,
      });
      return (
        <TerminalModeStrip
          state={switching.state}
          refusal={refused.reason}
          writer={refused.writer}
          writerPlace="roamgate / Tab 2"
          queued={0}
          onSwitch={switching.request}
          onCancel={switching.cancel}
          onDismiss={() => {}}
          onQuitWriter={() => switching.quitAndSwitch("w2:p12")}
        />
      );
    }
    // The wait before asking again runs on fake timers.
    jest.useFakeTimers();
    try {
      await React.act(async () => {
        root.render(<Quitting />);
      });
      await click(container, "Quit it and switch");
      expect(handovers()).toEqual([
        {
          method: "agent_chat.handover",
          params: {
            pane_id: "w1:p1",
            to: "conversation",
            quit_writer: "w2:p12",
          },
        },
      ]);
      // Asked again later by itself: never with the quit.
      await React.act(async () => {
        jest.advanceTimersByTime(1000);
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
      });
      expect(handovers()).toHaveLength(2);
      expect(handovers()[1]!.params).toEqual({
        pane_id: "w1:p1",
        to: "conversation",
      });
    } finally {
      await React.act(async () => root.unmount());
      jest.useRealTimers();
    }
  });
}
