import { expect, mock, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_COMPOSER_NEXT_DOM_TEST !== "1") {
  test("the predicted next message in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPOSER_NEXT_DOM_TEST: "1" },
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
  test("grey text in the empty box, Tab or Right to edit it, a chip on a phone", async () => {
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
    const { readTerminalComposerDraft, terminalComposerDraftKey } =
      await import("../terminalComposer");
    const { AgentHistoryComposer } = await import("./AgentHistoryComposer");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const send = mock<(text: string) => Promise<void>>(async () => {});
    type Props = {
      draftKey: string;
      vimKeys: boolean;
      nextPrompt: { key: string; text: string } | null;
      voiceOn?: boolean;
    };
    const render = (props: Props) =>
      React.act(async () =>
        root.render(
          <AgentHistoryComposer
            key={`${props.draftKey}:${props.vimKeys}`}
            draftKey={props.draftKey}
            agent="claude"
            status="idle"
            onSend={send}
            onUploadImage={async () => ""}
            onError={() => {}}
            vimKeys={props.vimKeys}
            nextPrompt={props.nextPrompt}
            voice={{
              listen: true,
              state: props.voiceOn ? "listening" : "off",
              level: 0,
              muted: false,
              held: [],
              onSendHeld: () => {},
              onDropHeld: () => {},
              onToggle: () => {},
              onToggleMute: () => {},
            }}
          />,
        ),
      );
    const settle = () =>
      React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const textarea = () => container.querySelector("textarea")!;
    const hint = () =>
      container.querySelector(".agent-history-composer-next-key");
    const chip = () =>
      container.querySelector<HTMLButtonElement>(
        ".agent-history-composer-next button",
      );
    const press = (target: Element, key: string, init: object = {}) =>
      React.act(async () => {
        target.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    const fill = (text: string) =>
      React.act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(textarea(), text);
        textarea().dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    const guess = { key: "g-1", text: "run the tests" };
    try {
      // The plain box: the guess is its placeholder, with a Tab hint.
      const plain = terminalComposerDraftKey("local", 1, "pane-next-plain");
      await render({ draftKey: plain, vimKeys: false, nextPrompt: guess });
      expect(textarea().placeholder).toBe("run the tests");
      expect(hint()?.textContent).toBe("Tab");
      expect(chip()).toBeNull();
      // Shift+Tab is not taken.
      await press(textarea(), "Tab", { shiftKey: true });
      expect(readTerminalComposerDraft(plain)).toBe("");
      await press(textarea(), "Tab");
      // In the box to edit, never sent.
      expect(readTerminalComposerDraft(plain)).toBe("run the tests");
      expect(textarea().value).toBe("run the tests");
      expect(send).not.toHaveBeenCalled();
      expect(hint()).toBeNull();
      // Emptied again: it does not come back.
      await fill("");
      expect(textarea().placeholder).toBe("Message claude...");

      // Typing anything puts it away; Right then moves the caret only.
      const typed = terminalComposerDraftKey("local", 1, "pane-next-typed");
      await render({ draftKey: typed, vimKeys: false, nextPrompt: guess });
      await fill("w");
      await fill("");
      expect(textarea().placeholder).toBe("Message claude...");
      await press(textarea(), "ArrowRight");
      expect(readTerminalComposerDraft(typed)).toBe("");
      // A new guess after the next turn shows; Right takes it.
      await render({
        draftKey: typed,
        vimKeys: false,
        nextPrompt: { key: "g-2", text: "commit it" },
      });
      expect(textarea().placeholder).toBe("commit it");
      await press(textarea(), "ArrowRight");
      expect(readTerminalComposerDraft(typed)).toBe("commit it");

      // Never during a voice call.
      const call = terminalComposerDraftKey("local", 1, "pane-next-call");
      await render({
        draftKey: call,
        vimKeys: false,
        nextPrompt: guess,
        voiceOn: true,
      });
      expect(textarea().placeholder).toBe("Message claude...");
      expect(hint()).toBeNull();
      await press(textarea(), "Tab");
      expect(readTerminalComposerDraft(call)).toBe("");

      // The Vim box: CodeMirror's placeholder shows it, Tab takes it.
      const vimKey = terminalComposerDraftKey("local", 1, "pane-next-vim");
      await render({ draftKey: vimKey, vimKeys: true, nextPrompt: guess });
      for (
        let wait = 0;
        wait < 50 && !container.querySelector(".cm-content");
        wait += 1
      )
        await settle();
      const content = container.querySelector(".cm-content")!;
      expect(content).not.toBeNull();
      expect(container.querySelector(".cm-placeholder")?.textContent).toBe(
        "run the tests",
      );
      await press(content, "Tab");
      await settle();
      expect(readTerminalComposerDraft(vimKey)).toBe("run the tests");
      expect(content.textContent).toBe("run the tests");
      expect(send).not.toHaveBeenCalled();

      // A phone: a chip above the box, not grey text; a tap fills the box.
      await React.act(async () => {
        window.history.pushState({}, "", "/?layout=mobile");
        window.dispatchEvent(new window.Event("popstate"));
      });
      const phone = terminalComposerDraftKey("local", 1, "pane-next-phone");
      await render({ draftKey: phone, vimKeys: false, nextPrompt: guess });
      expect(chip()?.textContent).toBe("run the tests");
      expect(textarea().placeholder).toBe("Message claude...");
      expect(hint()).toBeNull();
      await React.act(async () => chip()!.click());
      expect(readTerminalComposerDraft(phone)).toBe("run the tests");
      expect(chip()).toBeNull();
      expect(send).not.toHaveBeenCalled();
      // Not during a call on a phone either.
      const phoneCall = terminalComposerDraftKey("local", 1, "pane-next-pc");
      await render({
        draftKey: phoneCall,
        vimKeys: false,
        nextPrompt: guess,
        voiceOn: true,
      });
      expect(chip()).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
