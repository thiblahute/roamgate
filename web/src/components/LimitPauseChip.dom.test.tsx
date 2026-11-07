import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_LIMIT_PAUSE_DOM_TEST !== "1") {
  test("a usage limit pause in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_LIMIT_PAUSE_DOM_TEST: "1" },
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
    KeyboardEvent: browser.KeyboardEvent,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { LimitPauseChip, LimitPauseNotice } = await import("./LimitPauseChip");
  const { AgentRow } = await import("./WorkspaceAgentRows");
  const { pauseTime, setLimitPausesForTest } = await import("../limitPauses");
  const { createRoot } = await import("react-dom/client");

  const resetsAt = Date.now() + 30 * 60_000;
  const pause = {
    connection_id: "local",
    pane_id: "w1:p1",
    session_id: "362be254-14eb-4390-a96c-25032526572a",
    owner: "conversation" as const,
    kind: "five_hour",
    resets_at: resetsAt,
    resume_at: resetsAt + 60_000,
    stopped_at: Date.now() - 60_000,
    state: "scheduled" as const,
    message: "You've hit your 5-hour limit · resets 1:40am (America/Santiago)",
  };
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    connectionId: "local",
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true };
    },
  } as unknown as Parameters<typeof LimitPauseChip>[0]["client"];

  const push = (pauses: (typeof pause)[] | Record<string, unknown>[]) =>
    React.act(async () => {
      setLimitPausesForTest("local", pauses as (typeof pause)[]);
    });
  const render = async (node: React.ReactNode) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(node);
    });
    return { container, root };
  };
  const clickText = (scope: ParentNode, label: string) =>
    React.act(async () => {
      const target = [
        ...scope.querySelectorAll<HTMLElement>("button, [role=menuitem]"),
      ].find((each) => each.textContent?.includes(label));
      if (!target) throw new Error(`no ${label} in: ${scope.textContent}`);
      target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  test("nothing shows for a session that is not paused", async () => {
    const { container, root } = await render(
      <>
        <LimitPauseChip client={client} paneId="w1:p9" />
        <LimitPauseNotice client={client} paneId="w1:p9" />
      </>,
    );
    expect(container.textContent).toBe("");
    await React.act(async () => root.unmount());
  });

  test("the pane's chip says when it resumes, and its menu acts", async () => {
    await push([pause]);
    const { container, root } = await render(
      <LimitPauseChip client={client} paneId="w1:p1" />,
    );
    const resumes = pauseTime(pause.resume_at);
    const chip = container.querySelector("button")!;
    expect(chip.textContent).toBe(`Paused · ${resumes}`);
    expect(chip.title).toContain(
      `Paused by the usage limit, resumes at ${resumes}`,
    );
    expect(chip.title).toContain("The 5-hour limit resets at");
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");

    await clickText(container, "Paused");
    expect(document.body.textContent).toContain("Resume now");
    expect(document.body.textContent).toContain("Don't resume");
    await clickText(document.body, "Resume now");
    expect(calls[calls.length - 1]).toEqual({
      method: "limit_resume.resume_now",
      params: { pane_id: "w1:p1" },
    });
    await React.act(async () => root.unmount());
  });

  test("the chat's notice says it with its two buttons", async () => {
    await push([pause]);
    const { container, root } = await render(
      <LimitPauseNotice client={client} paneId="w1:p1" />,
    );
    expect(container.textContent).toContain(
      `Paused by the usage limit, resumes at ${pauseTime(pause.resume_at)}`,
    );
    const labels = () =>
      [...container.querySelectorAll("button")].map((each) => each.textContent);
    expect(labels()).toEqual(["Resume now", "Don't resume"]);
    await clickText(container, "Don't resume");
    expect(calls[calls.length - 1]).toEqual({
      method: "limit_resume.skip",
      params: { pane_id: "w1:p1", skip: true },
    });

    // The server's push says it is held: it can be undone.
    await React.act(async () => {
      setLimitPausesForTest("local", [
        { ...pause, state: "skipped", resume_at: null },
      ]);
    });
    expect(container.textContent).toContain("it will not be resumed");
    expect(labels()).toEqual(["Resume now", "Resume at the reset"]);
    await clickText(container, "Resume at the reset");
    expect(calls[calls.length - 1]).toEqual({
      method: "limit_resume.skip",
      params: { pane_id: "w1:p1", skip: false },
    });

    // Resumed: the notice goes.
    await React.act(async () => {
      setLimitPausesForTest("local", []);
    });
    expect(container.textContent).toBe("");
    await React.act(async () => root.unmount());
  });

  test("a pause whose reset passed unseen offers Resume now", async () => {
    const passed = Date.now() - 60 * 60_000;
    await push([
      { ...pause, state: "missed", resets_at: passed, resume_at: null },
    ]);
    const { container, root } = await render(
      <LimitPauseNotice client={client} paneId="w1:p1" />,
    );
    expect(container.textContent).toContain(
      `Paused by the usage limit, which reset at ${pauseTime(passed)}`,
    );
    await React.act(async () => root.unmount());
  });

  test("the agents list shows the pause on the agent's row", async () => {
    await push([pause]);
    const pane = {
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      terminal_id: "term-1",
      focused: false,
      agent: "claude",
      agent_status: "idle",
      cwd: "/tmp/roamgate",
    } as unknown as Parameters<typeof AgentRow>[0]["pane"];
    const { container, root } = await render(
      <AgentRow
        pane={pane}
        selected={false}
        showPaneId={false}
        variant="standalone"
        connectionId="local"
      />,
    );
    const badge = container.querySelector(".limit-pause-badge")!;
    expect(badge.textContent).toBe(`Paused · ${pauseTime(pause.resume_at)}`);
    expect(
      container.querySelector(".agent-row")!.getAttribute("aria-label"),
    ).toContain("Paused by the usage limit, resumes at");
    await React.act(async () => root.unmount());
  });
}
