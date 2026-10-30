import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { AgentTask, WorkflowView } from "../agentTasks";
import type { Pane } from "../types";

if (process.env.ROAMGATE_TASKS_SHEET_DOM_TEST !== "1") {
  test("tasks sheet keys in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_TASKS_SHEET_DOM_TEST: "1" },
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
  test("the keys move through tasks, a workflow's phases and agents", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      KeyboardEvent: browser.KeyboardEvent,
      CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    browser.HTMLElement.prototype.scrollIntoView = () => {};
    let workflow: WorkflowView = {
      phases: [
        {
          title: "Investigate",
          agents: [{ agentId: "a1", label: "read", state: "done" }],
        },
        {
          title: "Build",
          agents: [
            { agentId: "a2", label: "server", state: "done" },
            {
              agentId: "a3",
              label: "web",
              state: "running",
              startedAt: Date.now() - 5000,
            },
          ],
        },
      ],
    };
    const calls: Record<string, unknown>[] = [];
    const client = {
      connectionId: "c1",
      call: async (_method: string, params: Record<string, unknown>) => {
        calls.push(params);
        const agentId = params.agent_id;
        if (
          agentId &&
          !workflow.phases.some((phase) =>
            phase.agents.some((agent) => agent.agentId === agentId),
          )
        )
          throw new Error("Unknown workflow agent");
        return { task: {}, workflow, entries: [] };
      },
    };
    mock.module("../useConnectionClient", () => ({
      useConnectionClient: () => client,
    }));
    const { AgentTasksSheet } = await import("./AgentTasksSheet");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () =>
      React.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    const press = (key: string, shiftKey = false) =>
      React.act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    const cursor = () =>
      document.querySelector(".is-cursor")?.getAttribute("data-nav-key");
    const pane = { pane_id: "p1", agent: "claude" } as unknown as Pane;
    let tasks: AgentTask[] = [
      { id: "t1", kind: "command", title: "build", status: "completed" },
      { id: "t2", kind: "workflow", title: "ship", status: "running" },
      { id: "t3", kind: "agent", title: "audit", status: "failed" },
    ];
    let closed = 0;
    let session = "s1";
    let requested = null as string | null;
    let show: (shown: boolean) => void = () => {};
    function Host() {
      const [shown, setShown] = React.useState(true);
      show = setShown;
      return shown ? (
        <AgentTasksSheet
          pane={pane}
          tasks={tasks}
          session={session}
          initialTaskId={requested}
          onClose={() => {
            closed++;
            setShown(false);
          }}
        />
      ) : null;
    }
    const title = () =>
      document.querySelector(".agent-tasks-head strong")?.textContent;
    const following = () =>
      document
        .querySelector(".agent-workflow-follow")
        ?.getAttribute("aria-pressed");
    const reopen = async () => {
      await React.act(async () => show(true));
      await settle();
    };
    const close = async () => {
      await press("q");
      expect(document.querySelector(".agent-tasks-sheet")).toBeNull();
    };
    await React.act(async () => root.render(<Host />));
    await settle();
    // The running task first; then the keys move the cursor and the focus.
    expect(cursor()).toBe("t2");
    await press("j");
    expect(cursor()).toBe("t3");
    expect(document.activeElement?.getAttribute("data-nav-key")).toBe("t3");
    await press("g");
    expect(cursor()).toBe("t1");
    await press("e");
    expect(cursor()).toBe("t3");
    await press("n");
    expect(cursor()).toBe("t2");
    await press("?");
    expect(document.querySelector(".agent-tasks-help")).not.toBeNull();
    await press("Escape");
    expect(document.querySelector(".agent-tasks-help")).toBeNull();
    expect(closed).toBe(0);

    // The workflow follows its running agent; done phases are folded.
    await press("Enter");
    await settle();
    expect(title()).toBe("ship");
    expect(cursor()).toBe("agent:a3");
    expect(
      [...document.querySelectorAll("[data-nav-key]")].map((row) =>
        row.getAttribute("data-nav-key"),
      ),
    ).toEqual(["phase:Investigate", "phase:Build", "agent:a2", "agent:a3"]);
    expect(
      document
        .querySelector(".agent-workflow-follow")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    // Moving stops following.
    await press("k");
    expect(cursor()).toBe("agent:a2");
    expect(
      document
        .querySelector(".agent-workflow-follow")
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    await press("g");
    expect(cursor()).toBe("phase:Investigate");
    await press("l");
    expect(document.querySelector('[data-nav-key="agent:a1"]')).not.toBeNull();
    await press("h");
    expect(document.querySelector('[data-nav-key="agent:a1"]')).toBeNull();

    // An agent's conversation, and back to it in the overview.
    await press("G");
    await press("Enter");
    await settle();
    expect(calls[calls.length - 1]?.agent_id).toBe("a3");
    expect(document.querySelector(".agent-task-back")).not.toBeNull();
    await press("Backspace");
    await settle();
    expect(document.querySelector(".agent-task-back")).toBeNull();
    expect(cursor()).toBe("agent:a3");
    // Back to the list, on the workflow, then closed.
    await press("Escape");
    await settle();
    expect(title()).toBe("Background tasks");
    expect(cursor()).toBe("t2");
    await press("Escape");
    expect(closed).toBe(1);

    // Opened again: where it was left, the list on the workflow.
    await reopen();
    expect(title()).toBe("Background tasks");
    expect(cursor()).toBe("t2");
    // The workflow, with following off where the reader left it.
    await press("Enter");
    await settle();
    await press("k");
    expect(cursor()).toBe("agent:a2");
    expect(following()).toBe("false");
    await close();
    await reopen();
    expect(title()).toBe("ship");
    expect(cursor()).toBe("agent:a2");
    expect(following()).toBe("false");
    // The phase folded by hand stays folded.
    expect(document.querySelector('[data-nav-key="agent:a1"]')).toBeNull();
    expect(
      document.querySelector('[data-nav-key="phase:Investigate"]'),
    ).not.toBeNull();

    // An agent's conversation comes back as such.
    await press("Enter");
    await settle();
    expect(document.querySelector(".agent-task-back")).not.toBeNull();
    await close();
    await reopen();
    expect(document.querySelector(".agent-task-back")).not.toBeNull();
    expect(calls[calls.length - 1]?.agent_id).toBe("a2");
    await press("Backspace");
    await settle();
    expect(cursor()).toBe("agent:a2");

    // Following, left on, stays on and catches up with the running agent.
    await press("f");
    await settle();
    expect(following()).toBe("true");
    expect(cursor()).toBe("agent:a3");
    await close();
    await reopen();
    expect(following()).toBe("true");
    expect(cursor()).toBe("agent:a3");

    // A task asked for opens, and going back gives the place beneath it.
    await close();
    requested = "t3";
    await reopen();
    expect(title()).toBe("audit");
    await press("Escape");
    await settle();
    expect(title()).toBe("ship");
    await press("Escape");
    await settle();
    expect(title()).toBe("Background tasks");
    expect(cursor()).toBe("t2");
    requested = null;

    // Another session in the pane starts afresh.
    await press("Enter");
    await settle();
    await close();
    session = "s2";
    await reopen();
    expect(title()).toBe("Background tasks");
    expect(cursor()).toBe("t2");
    // Its own list cursor is kept too.
    await press("j");
    await close();
    await reopen();
    expect(cursor()).toBe("t3");
    await close();

    // An agent the workflow no longer has gives its overview; a task the
    // session no longer has, the list.
    session = "s1";
    await reopen();
    expect(title()).toBe("ship");
    await press("k");
    await press("Enter");
    await settle();
    expect(document.querySelector(".agent-task-back")).not.toBeNull();
    await close();
    workflow = {
      phases: workflow.phases.map((phase) => ({
        ...phase,
        agents: phase.agents.filter((agent) => agent.agentId !== "a2"),
      })),
    };
    await reopen();
    expect(title()).toBe("ship");
    expect(document.querySelector(".agent-task-back")).toBeNull();
    expect(document.querySelector(".agent-tasks-empty")).toBeNull();
    await close();
    tasks = tasks.filter((task) => task.id !== "t2");
    await reopen();
    expect(title()).toBe("Background tasks");
    await React.act(async () => root.unmount());
  }, 10_000);
}
