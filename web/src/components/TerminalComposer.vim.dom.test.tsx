import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import * as React from "react";

if (
  inIsolatedChild(
    import.meta.path,
    "the terminal's Message box with Vim keys in an isolated DOM runtime",
    "ROAMGATE_TERMINAL_COMPOSER_VIM_DOM_TEST",
    30_000,
  )
) {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost" });
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
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: () => browser.getSelection(),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({ matches: false }),
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const drafts = await import("../terminalComposer");
  const { TerminalComposer } = await import("./TerminalComposer");
  const { WORKSPACE_PATH_DRAG_TYPE } = await import("../workspacePathDrag");
  const { EditorView } = await import("@codemirror/view");
  const { getCM } = await import("@replit/codemirror-vim");
  const { createRoot } = await import("react-dom/client");
  type Mode = import("../terminalInputMode").TerminalInputMode;

  let serial = 0;
  const settle = () =>
    React.act(async () => {
      for (let tick = 0; tick < 5; tick++)
        await new Promise((done) => setTimeout(done, 0));
    });

  /** The box with Vim keys on (the default), its draft `text`. */
  async function mount({
    text = "",
    vimKeys,
    submitWarning,
  }: {
    text?: string;
    vimKeys?: boolean;
    submitWarning?: string;
  } = {}) {
    const connection = `vim-dom-${++serial}`;
    drafts.activateTerminalComposerDraftScope(connection, 1);
    const key = drafts.terminalComposerDraftKey(connection, 1, "pane-a");
    drafts.writeTerminalComposerDraft(key, text);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const sent: [string, boolean][] = [];
    const uploaded: string[] = [];
    const errors: string[] = [];
    const modes: Mode[] = [];
    let directFocused = 0;
    let mode: Mode = "composer";
    const render = () =>
      root.render(
        <TerminalComposer
          draftKey={key}
          mode={mode}
          onModeChange={(next) => {
            modes.push(next);
            mode = next;
            render();
          }}
          onFocusDirect={() => {
            directFocused += 1;
          }}
          directDisabled={false}
          agent="claude"
          shortcutRows={[]}
          onRunShortcut={() => {}}
          onClose={() => {}}
          submitWarning={submitWarning}
          onSubmit={async (value, submit) => {
            sent.push([value, submit]);
          }}
          onUploadImage={async (file) => {
            uploaded.push(`image:${file.name}`);
            return `/uploads/${file.name}`;
          }}
          onUploadFile={async (file) => {
            uploaded.push(`file:${file.name}`);
            return `/uploads/${file.name}`;
          }}
          onError={(message) => errors.push(message)}
          vimKeys={vimKeys}
        />,
      );
    await React.act(async () => render());
    await settle();
    const view = () => {
      const editor = container.querySelector<HTMLElement>(".cm-editor");
      return editor ? EditorView.findFromDOM(editor) : null;
    };
    const button = (label: string) =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    return {
      draftKey: key,
      container,
      root,
      sent,
      uploaded,
      errors,
      modes,
      directFocused: () => directFocused,
      view,
      draft: () => drafts.readTerminalComposerDraft(key),
      insertMode: () => !!getCM(view()!)?.state.vim?.insertMode,
      button,
      click: (label: string) =>
        React.act(async () => {
          button(label).click();
        }),
      focus: () =>
        React.act(async () => {
          view()!.focus();
        }),
      type: (value: string) =>
        React.act(async () => {
          const target = view()!;
          const { from, to } = target.state.selection.main;
          target.dispatch({
            changes: { from, to, insert: value },
            selection: { anchor: from + value.length },
            userEvent: "input.type",
          });
        }),
      key: (name: string, init: KeyboardEventInit = {}) =>
        React.act(async () => {
          view()!.contentDOM.dispatchEvent(
            new browser.KeyboardEvent("keydown", {
              key: name,
              bubbles: true,
              cancelable: true,
              ...(init as object),
            }) as unknown as Event,
          );
        }),
      unmount: async () => {
        await React.act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("with Vim on the box is the Vim editor: Insert and Send take its draft, the send shortcut sends once, Esc leaves insert mode by its button", async () => {
    const box = await mount();
    expect(box.container.querySelector("textarea")).toBeNull();
    const content = box.view()!.contentDOM;
    expect(content.getAttribute("aria-label")).toBe("Terminal input draft");
    expect(content.getAttribute("role")).toBe("combobox");
    await box.focus();
    expect(box.insertMode()).toBe(true);
    await box.type("ls -la");
    expect(box.draft()).toBe("ls -la");
    await box.click("Insert draft into the terminal");
    await settle();
    expect(box.sent).toEqual([["ls -la", false]]);
    expect(box.draft()).toBe("");

    await box.type("make test");
    await box.key("Enter", { ctrlKey: true });
    await settle();
    expect(box.sent).toEqual([
      ["ls -la", false],
      ["make test", true],
    ]);

    await box.type("echo hi");
    await box.click("Send draft to the terminal");
    await settle();
    expect(box.sent[box.sent.length - 1]).toEqual(["echo hi", true]);

    // The phone keyboard's missing Esc: normal mode, and Enter adds no line.
    await box.type("draft");
    await box.click("Esc: Vim normal mode");
    expect(box.insertMode()).toBe(false);
    expect(box.draft()).toBe("draft");
    await box.unmount();
  });

  test("with Vim on a warned Send asks first, and Esc in the box cancels the question before Vim sees it", async () => {
    const box = await mount({
      text: "rm -rf build",
      submitWarning: "The agent is busy",
    });
    await box.focus();
    await box.click("Send draft to the terminal");
    expect(
      box.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("The agent is busy");
    await box.key("Escape");
    expect(box.container.querySelector('[role="alert"]')).toBeNull();
    // Vim kept insert mode: the Escape was the question's.
    expect(box.insertMode()).toBe(true);
    expect(box.sent).toEqual([]);
    await box.unmount();
  });

  test("with Vim on Direct hands the keys to the terminal and leaves the draft", async () => {
    const box = await mount({ text: "half typed" });
    await box.focus();
    await box.click("Type directly into the terminal");
    // Focus chose Message, as the plain box's does; Direct then.
    expect(box.modes).toEqual(["composer", "direct"]);
    expect(box.directFocused()).toBe(1);
    expect(document.activeElement).not.toBe(box.view()!.contentDOM);
    expect(box.draft()).toBe("half typed");
    // No Esc button for Vim while the terminal takes the keys.
    expect(box.button("Esc: Vim normal mode")).toBeNull();
    await box.unmount();
  });

  test("with Vim on the command picker asks before replacing a draft, and completes a typed command inline", async () => {
    const box = await mount({ text: "keep this" });
    await box.click("Commands");
    const replace = () =>
      [...box.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (each) => each.textContent === "Replace draft",
      );
    const option =
      box.container.querySelector<HTMLButtonElement>('[role="option"]')!;
    const name = option.querySelector("strong")!.textContent!;
    await React.act(async () => option.click());
    expect(
      box.container.querySelector('[aria-label="Confirm draft replacement"]'),
    ).not.toBeNull();
    expect(box.draft()).toBe("keep this");
    await React.act(async () => replace()!.click());
    await settle();
    expect(box.draft()).toBe(`${name} `);
    expect(box.view()!.state.doc.toString()).toBe(`${name} `);
    expect(box.sent).toEqual([]);

    // Typed: the list follows, Tab completes the selected one.
    await React.act(async () => {
      box.view()!.dispatch({
        changes: { from: 0, to: box.view()!.state.doc.length, insert: "" },
      });
    });
    await box.focus();
    await box.type("/");
    const content = box.view()!.contentDOM;
    expect(content.getAttribute("aria-expanded")).toBe("true");
    expect(content.getAttribute("aria-activedescendant")).not.toBeNull();
    await box.key("Tab");
    await settle();
    expect(box.draft()).toMatch(/^\/\S+ $/);
    expect(content.getAttribute("aria-expanded")).toBe("false");
    expect(box.sent).toEqual([]);
    await box.unmount();
  });

  test("with Vim on pasted files of any kind upload, and dropped files and paths land at the caret", async () => {
    const box = await mount();
    await box.focus();
    const content = box.view()!.contentDOM;
    const transfer = (data: Record<string, unknown>) => data;
    await React.act(async () => {
      const event = new browser.Event("paste", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event;
      Object.defineProperty(event, "clipboardData", {
        value: transfer({
          files: [
            new File(["x"], "notes.txt", { type: "text/plain" }),
            new File(["x"], "shot.png", { type: "image/png" }),
          ],
          items: [],
          getData: () => "",
          types: ["Files"],
        }),
      });
      content.dispatchEvent(event);
    });
    await settle();
    expect(box.uploaded).toEqual(["file:notes.txt", "image:shot.png"]);
    expect(box.draft()).toContain("/uploads/notes.txt");
    expect(box.draft()).toContain("/uploads/shot.png");

    const drop = (data: Record<string, unknown>) =>
      React.act(async () => {
        const over = new browser.Event("dragover", {
          bubbles: true,
          cancelable: true,
        }) as unknown as Event;
        Object.defineProperty(over, "dataTransfer", { value: data });
        content.dispatchEvent(over);
        expect(over.defaultPrevented).toBe(true);
        const event = new browser.Event("drop", {
          bubbles: true,
          cancelable: true,
        }) as unknown as Event;
        Object.defineProperty(event, "dataTransfer", { value: data });
        content.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      });
    await drop({
      types: [WORKSPACE_PATH_DRAG_TYPE, "text/plain"],
      getData: (type: string) =>
        type === WORKSPACE_PATH_DRAG_TYPE ? "/repo/src/main.ts" : "",
      files: [],
      items: [],
    });
    await settle();
    expect(box.draft()).toContain("/repo/src/main.ts");
    const report = new File(["x"], "report.pdf", { type: "application/pdf" });
    await drop({
      types: ["Files"],
      getData: () => "",
      files: [report],
      items: [{ kind: "file", getAsFile: () => report }],
    });
    await settle();
    expect(box.uploaded[box.uploaded.length - 1]).toBe("file:report.pdf");
    expect(box.draft()).toContain("/uploads/report.pdf");
    expect(box.errors).toEqual([]);
    await box.unmount();
  });

  test("with Vim off the box stays the plain textarea, without an Esc button", async () => {
    const box = await mount({ text: "plain", vimKeys: false });
    expect(box.container.querySelector(".cm-editor")).toBeNull();
    const textarea = box.container.querySelector("textarea")!;
    expect(textarea.value).toBe("plain");
    expect(textarea.getAttribute("aria-label")).toBe("Terminal input draft");
    expect(box.button("Esc: Vim normal mode")).toBeNull();
    await box.click("Insert draft into the terminal");
    await settle();
    expect(box.sent).toEqual([["plain", false]]);
    await box.unmount();
  });

  test("without a choice of its own the box follows the one Vim keys setting, at once", async () => {
    const { setVimKeys } = await import("../vimKeys");
    setVimKeys(false);
    const box = await mount({ text: "both" });
    try {
      expect(box.container.querySelector("textarea")?.value).toBe("both");
      await React.act(async () => setVimKeys(true));
      await settle();
      expect(box.container.querySelector("textarea")).toBeNull();
      expect(box.view()?.state.doc.toString()).toBe("both");
    } finally {
      setVimKeys(true);
      await box.unmount();
    }
  });
}
