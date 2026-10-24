import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { AgentPermissionPrompt } from "../../../shared/review";

if (process.env.ROAMGATE_PERMISSION_CARD_DOM_TEST !== "1") {
  test("permission card keys in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PERMISSION_CARD_DOM_TEST: "1" },
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
  test("a card answers its shortcuts and takes the keys when it comes", async () => {
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
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const answer = mock<(...args: unknown[]) => Promise<boolean>>(
      async () => true,
    );
    const release = mock<(...args: unknown[]) => Promise<void>>(async () => {});
    mock.module("../review", () => ({
      answerAgentPrompt: answer,
      releaseAgentPrompt: release,
    }));
    const lastAnswer = () => answer.mock.calls[answer.mock.calls.length - 1];
    const { AgentPermissionCard } = await import("./AgentPermissionCard");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () =>
      React.act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const press = (target: Element, key: string) =>
      React.act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    const base: AgentPermissionPrompt = {
      id: "p1",
      connectionId: "local",
      paneId: "w1:p1",
      agent: "Claude",
      tool: "Bash",
      summary: "rm -rf build",
      canAlways: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as AgentPermissionPrompt;

    await React.act(async () =>
      root.render(<AgentPermissionCard prompt={base} />),
    );
    await settle();
    const card = container.querySelector(".agent-permission")!;
    expect(document.activeElement).toBe(card);
    await press(card, "n");
    expect(lastAnswer()).toEqual(["local", "p1", "deny"]);
    await settle();
    await press(card, "a");
    expect(lastAnswer()).toEqual(["local", "p1", "always"]);
    await settle();
    await press(card, "t");
    expect(release).toHaveBeenCalledTimes(1);
    await press(card, "x");
    expect(answer).toHaveBeenCalledTimes(2);

    await React.act(async () =>
      root.render(
        <AgentPermissionCard
          prompt={{
            ...base,
            id: "q1",
            tool: "AskUserQuestion",
            questions: [
              {
                question: "Which color?",
                header: "Color",
                multiSelect: false,
                options: [{ label: "red" }, { label: "blue" }],
              },
              {
                question: "Which fruit?",
                header: "Fruit",
                multiSelect: false,
                options: [{ label: "apple" }, { label: "pear" }],
              },
            ],
          }}
        />,
      ),
    );
    await settle();
    const radios = () => [
      ...container.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ];
    expect(document.activeElement).toBe(radios()[0]);
    await press(radios()[0]!, "2");
    await settle();
    expect(radios().map((radio) => radio.checked)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // On to the next question.
    expect(document.activeElement).toBe(radios()[2]);
    await press(radios()[2]!, "1");
    await settle();
    expect(document.activeElement).toBe(
      container.querySelector("button[type=submit]"),
    );
    await React.act(async () =>
      container
        .querySelector<HTMLButtonElement>("button[type=submit]")!
        .click(),
    );
    expect(lastAnswer()).toEqual([
      "local",
      "q1",
      { answers: { "Which color?": "blue", "Which fruit?": "apple" } },
    ]);
    await React.act(async () => root.unmount());
  });
}
