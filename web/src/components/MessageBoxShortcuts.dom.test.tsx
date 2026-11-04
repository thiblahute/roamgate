import { describe, expect, test } from "bun:test";
import { editsText } from "../messageBoxKeys";

const key = (init: Partial<KeyboardEvent>) =>
  ({
    key: "k",
    code: "KeyK",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

describe("keys a message box keeps", () => {
  test("typing, moving, deleting, the clipboard and undo stay the box's", () => {
    for (const mac of [true, false]) {
      const primary = mac ? { metaKey: true } : { ctrlKey: true };
      expect(editsText(key({}), mac)).toBe(true);
      expect(editsText(key({ shiftKey: true, key: "K" }), mac)).toBe(true);
      expect(editsText(key({ key: "ArrowLeft", altKey: true }), mac)).toBe(
        true,
      );
      expect(
        editsText(
          key({ key: "ArrowLeft", ctrlKey: true, shiftKey: true }),
          mac,
        ),
      ).toBe(true);
      expect(editsText(key({ key: "Backspace", ...primary }), mac)).toBe(true);
      for (const letter of ["a", "c", "v", "x", "z"])
        expect(
          editsText(
            key({
              key: letter,
              code: `Key${letter.toUpperCase()}`,
              ...primary,
            }),
            mac,
          ),
        ).toBe(true);
    }
    // A Mac's Ctrl+letter moves the caret (Emacs keys).
    expect(
      editsText(key({ key: "e", code: "KeyE", ctrlKey: true }), true),
    ).toBe(true);
  });

  test("the app's shortcuts are not the box's", () => {
    expect(editsText(key({ metaKey: true }), true)).toBe(false);
    expect(editsText(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(editsText(key({ key: "å", code: "KeyA", altKey: true }), true)).toBe(
      false,
    );
    expect(
      editsText(key({ key: "f", code: "KeyF", altKey: true }), false),
    ).toBe(false);
  });
});

if (process.env.ROAMGATE_MESSAGE_BOX_DOM_TEST !== "1") {
  test("shortcuts from a message box, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MESSAGE_BOX_DOM_TEST: "1" },
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
  test("the command menu opens from a composer, its Vim box and a review comment", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [name, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
      });
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { CommandCombobox } = await import("./CommandCombobox");
    const { getShortcutSnapshot } = await import("../shortcutPreferences");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <>
          <header className="topbar">
            <CommandCombobox onCreateWorkspace={() => {}} />
          </header>
          <div className="agent-history-composer">
            <textarea className="plain" />
            <div className="agent-history-composer-editor">
              <div className="cm-content" contentEditable />
            </div>
          </div>
          <div className="review-overlay">
            <div className="rc-editor">
              <div className="cm-content" contentEditable />
            </div>
          </div>
          <input className="search" />
        </>,
      );
    });
    const mac = getShortcutSnapshot().platform === "mac";
    const commandMenu = mac
      ? { key: "k", code: "KeyK", metaKey: true }
      : { key: "k", code: "KeyK", ctrlKey: true, altKey: true };
    const open = () => document.querySelector(".command-popover") !== null;
    const press = async (target: Element, init: KeyboardEventInit) => {
      (target as HTMLElement).focus();
      let event!: KeyboardEvent;
      await act(async () => {
        event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        target.dispatchEvent(event);
      });
      return event;
    };
    const close = async () => {
      // The same key closes it.
      await press(
        document.querySelector(".command-popover input") ?? document.body,
        commandMenu,
      );
      if (open()) throw new Error("the command menu did not close");
    };

    for (const selector of [
      ".agent-history-composer textarea",
      ".agent-history-composer-editor .cm-content",
      ".rc-editor .cm-content",
    ]) {
      const box = document.querySelector(selector)!;
      // Typing stays the box's: a plain K, or the select-all key.
      await press(box, { key: "k", code: "KeyK" });
      expect(open()).toBe(false);
      const selectAll = await press(
        box,
        mac
          ? { key: "a", code: "KeyA", metaKey: true }
          : { key: "a", code: "KeyA", ctrlKey: true },
      );
      expect(selectAll.defaultPrevented).toBe(false);
      expect(open()).toBe(false);
      // The command menu's key opens it from there.
      const event = await press(box, commandMenu);
      expect(event.defaultPrevented).toBe(true);
      expect(open()).toBe(true);
      await close();
    }

    // Other fields (a search box) keep the old rule: the key is theirs.
    await press(document.querySelector("input.search")!, commandMenu);
    expect(open()).toBe(false);
    root.unmount();
  });
}
