import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_COMPOSER_VOICE_DOM_TEST !== "1") {
  test("the message box's Dictate and call buttons in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPOSER_VOICE_DOM_TEST: "1" },
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
  test("the microphone on the box dictates, the call button beside it calls, neither during a call", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Text: browser.Text,
      Event: browser.Event,
      KeyboardEvent: browser.KeyboardEvent,
      MutationObserver: browser.MutationObserver,
      getSelection: () => browser.getSelection(),
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
      matchMedia: () => ({ matches: false }),
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    // The voice socket is not there: Dictate's start and finish are stubs.
    const finish = mock(async () => ({ text: "hello there", cleaned: true }));
    const startDictation = mock(
      async (_target: unknown, onHeard: (text: string) => void) => {
        onHeard("hello there um");
        return { finish, cancel: () => {} };
      },
    );
    const real = await import("../dictation");
    mock.module("../dictation", () => ({ ...real, startDictation }));
    const { readTerminalComposerDraft, terminalComposerDraftKey } =
      await import("../terminalComposer");
    const { AgentHistoryComposer } = await import("./AgentHistoryComposer");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onToggle = mock(() => {});
    const draftKey = terminalComposerDraftKey("local", 1, "pane-voice");
    const render = (state: "off" | "listening", listen = true) =>
      React.act(async () =>
        root.render(
          <AgentHistoryComposer
            draftKey={draftKey}
            agent="claude"
            status="idle"
            onSend={async () => {}}
            onUploadImage={async () => ""}
            onError={() => {}}
            vimKeys={false}
            voice={{
              listen,
              state,
              level: 0,
              muted: false,
              held: [],
              onSendHeld: () => {},
              onDropHeld: () => {},
              onToggle,
              onToggleMute: () => {},
            }}
          />,
        ),
      );
    const click = (button: HTMLButtonElement) =>
      React.act(async () => {
        button.click();
      });
    const dictate = () =>
      container.querySelector<HTMLButtonElement>(
        ".agent-history-composer-inline .agent-history-composer-dictate",
      );
    const call = () =>
      container.querySelector<HTMLButtonElement>(
        ".agent-history-composer-inline .agent-history-composer-call",
      );
    try {
      await render("off");
      // On the box: Dictate, a microphone; beside it: the call.
      expect(dictate()?.title).toBe("Dictate");
      expect(dictate()?.querySelector(".lucide-mic")).not.toBeNull();
      expect(call()?.getAttribute("aria-label")).toBe(
        "Start a voice call with the agent",
      );
      expect(call()?.querySelector(".lucide-phone-call")).not.toBeNull();
      // On the box, just before the microphone, not ahead of the box: the
      // box keeps its width, and the call is where the voice controls are.
      expect(
        container.querySelector(
          ".agent-history-composer-row > .agent-history-composer-voice",
        ),
      ).toBeNull();
      expect(call()?.nextElementSibling).toBe(dictate());
      const field = container.querySelector<HTMLElement>(
        ".agent-history-composer-field",
      )!;
      expect(field.classList.contains("has-call")).toBe(true);
      // The text keeps clear of both buttons.
      expect(field.style.getPropertyValue("--composer-inline-buttons")).toBe(
        "2",
      );
      // Nothing else listens: no second dictate or call button.
      expect(
        container.querySelectorAll(".agent-history-composer-dictate").length,
      ).toBe(1);
      expect(
        container.querySelectorAll(".agent-history-composer-voice").length,
      ).toBe(2);

      // The microphone dictates: the words as heard, then the cleaned text
      // in the box, never a call.
      await click(dictate()!);
      expect(startDictation).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(".agent-history-composer-dictation")
          ?.textContent,
      ).toContain("hello there um");
      expect(dictate()?.getAttribute("aria-pressed")).toBe("true");
      await click(dictate()!);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(readTerminalComposerDraft(draftKey)).toBe("hello there");
      expect(onToggle).not.toHaveBeenCalled();

      // The call button starts the call.
      await click(call()!);
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(startDictation).toHaveBeenCalledTimes(1);

      // During a call: neither; the call is controlled from over the chat.
      await render("listening");
      expect(dictate()).toBeNull();
      expect(call()).toBeNull();

      // Without a voice engine: no Dictate, and the call says why not.
      await render("off", false);
      expect(dictate()).toBeNull();
      expect(call()?.classList.contains("is-unavailable")).toBe(true);
      expect(call()?.title).toBe(
        "Voice calls cannot listen: the server has no voice engine",
      );
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}
