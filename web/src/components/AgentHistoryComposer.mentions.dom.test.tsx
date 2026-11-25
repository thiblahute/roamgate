import { inIsolatedChild } from "../testIsolated";
import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type {
  AssistantMention,
  AssistantMentionTarget,
  AssistantWorkspace,
} from "../../../shared/assistant";

if (
  inIsolatedChild(
    import.meta.path,
    "the Vim message box's picker, queue and paste in an isolated DOM runtime",
    "ROAMGATE_COMPOSER_MENTIONS_DOM_TEST",
    20_000,
  )
) {
  const setup = async () => {
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
    const { AgentHistoryComposer } = await import("./AgentHistoryComposer");
    const { EditorView } = await import("@codemirror/view");
    const { getCM, Vim } = await import("@replit/codemirror-vim");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const settle = () =>
      React.act(async () => {
        for (let tick = 0; tick < 5; tick++)
          await new Promise((done) => setTimeout(done, 0));
      });
    const view = () => {
      const editor = container.querySelector<HTMLElement>(".cm-editor");
      return editor ? EditorView.findFromDOM(editor) : null;
    };
    const cm = () => getCM(view()!)!;
    const insertMode = () => !!cm().state.vim?.insertMode;
    /** Types `text` at the caret, as the keyboard would. */
    const type = (text: string) =>
      React.act(async () => {
        const target = view()!;
        const { from, to } = target.state.selection.main;
        target.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          userEvent: "input.type",
        });
      });
    const key = (name: string, init: KeyboardEventInit = {}) =>
      React.act(async () => {
        view()!.contentDOM.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...(init as object),
          }) as unknown as Event,
        );
      });
    /** The Vim box is lazy: shown once loaded, however long it takes. */
    const shown = async () => {
      while (!view()) await settle();
    };
    return {
      AgentHistoryComposer,
      Vim,
      browser,
      container,
      root,
      settle,
      shown,
      view,
      cm,
      insertMode,
      type,
      key,
    };
  };

  test("the Vim box offers @mentions: a pick is a chip without sending, Esc puts the picker away in insert mode, Enter sends it bound, Alt+Enter queues, Up takes a queued message back", async () => {
    const assistant = await import("../assistant");
    const t = await setup();
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
    const catalog = spyOn(assistant, "getAssistantMentions").mockResolvedValue({
      targets: [agent],
      errors: [],
    });
    let bound = { text: "", mentions: [] as AssistantMention[] };
    const sent: { text: string; mentions: AssistantMention[] }[] = [];
    const onSend = mock(async (text: string) => {
      sent.push({ text, mentions: bound.mentions });
      bound = { text: "", mentions: [] };
    });
    const onQueue = mock(async (text: string) => {
      void text;
    });
    const recall = mock(() => {});
    const opened = mock((target: AssistantMentionTarget) => {
      void target;
    });
    let busy = false;
    const render = () =>
      React.act(async () =>
        t.root.render(
          <t.AgentHistoryComposer
            draftKey="ranger:vim"
            agent="Ranger"
            status="idle"
            vimKeys
            onSend={onSend}
            onQueue={busy ? onQueue : undefined}
            onRecallQueued={recall}
            onError={() => {}}
            mentions={{
              workspaces: [workspace],
              currentWorkspace: workspace,
              read: (text) => (bound.text === text ? bound.mentions : []),
              write: (text, mentions) => {
                bound = { text, mentions };
              },
              onOpen: opened,
            }}
          />,
        ),
      );
    const expanded = () =>
      t.view()!.contentDOM.getAttribute("aria-expanded") === "true";
    const options = () =>
      Array.from(
        t.container.querySelectorAll('[role="listbox"] [role="option"]'),
        (option) => option.querySelector("strong")?.textContent,
      );
    try {
      await render();
      await t.shown();
      expect(t.view()).not.toBeNull();
      await React.act(async () => {
        t.view()!.contentDOM.dispatchEvent(new Event("focus"));
      });
      expect(t.insertMode()).toBe(true);
      expect(t.view()!.contentDOM.getAttribute("role")).toBe("combobox");
      // An email address is no mention.
      await t.type("user@example.com");
      expect(expanded()).toBe(false);
      expect(catalog).not.toHaveBeenCalled();
      await React.act(async () =>
        t.view()!.dispatch({
          changes: { from: 0, to: t.view()!.state.doc.length },
        }),
      );
      // @ opens the picker as it is typed.
      await t.type("Explain @Pro");
      await t.settle();
      expect(expanded()).toBe(true);
      expect(options()).toEqual(["Codex / Project", "Project"]);
      // Enter picks, without sending; the box stays in insert mode.
      await t.key("Enter");
      expect(t.view()!.state.doc.toString()).toBe("Explain @Codex / Project ");
      expect(onSend).not.toHaveBeenCalled();
      expect(expanded()).toBe(false);
      expect(t.insertMode()).toBe(true);
      expect(bound.mentions).toHaveLength(1);
      expect(bound.mentions[0]).toMatchObject({
        kind: "agent",
        start: 8,
        end: 24,
      });
      const chip = t.container.querySelector<HTMLButtonElement>(
        ".assistant-mention-chip button",
      )!;
      expect(chip.textContent).toContain("Codex / Project");
      await React.act(async () => chip.click());
      expect(opened).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "agent", pane_id: "pane-one" }),
      );
      // Typing before the reference moves it along.
      await React.act(async () =>
        t.view()!.dispatch({
          changes: { from: 0, insert: "Please " },
          userEvent: "input.type",
        }),
      );
      expect(bound.mentions[0]).toMatchObject({ start: 15, end: 31 });
      // Esc puts an open picker away and leaves the box in insert mode;
      // the next Esc is Vim's.
      await React.act(async () =>
        t.view()!.dispatch({
          selection: { anchor: t.view()!.state.doc.length },
        }),
      );
      await t.type("and @");
      await t.settle();
      expect(expanded()).toBe(true);
      await t.key("Escape");
      expect(expanded()).toBe(false);
      expect(t.insertMode()).toBe(true);
      t.Vim.handleKey(t.cm(), "<Esc>", "user");
      expect(t.insertMode()).toBe(false);
      // Moving in normal mode opens nothing.
      t.Vim.handleKey(t.cm(), "h", "user");
      t.Vim.handleKey(t.cm(), "l", "user");
      await t.settle();
      expect(expanded()).toBe(false);
      // Enter sends the message with its reference.
      await React.act(async () => {
        t.Vim.handleKey(t.cm(), "A", "user");
        const end = t.view()!.state.doc.length;
        t.view()!.dispatch({
          changes: { from: end - 2, to: end },
          userEvent: "delete.backward",
        });
      });
      await t.key("Enter");
      await t.settle();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(sent[0]!.text).toBe("Please Explain @Codex / Project and");
      expect(sent[0]!.mentions).toHaveLength(1);
      expect(sent[0]!.mentions[0]).toMatchObject({ start: 15, end: 31 });
      expect(t.view()!.state.doc.toString()).toBe("");
      expect(t.insertMode()).toBe(true);
      // While the agent answers, Alt+Enter queues and Enter steers.
      busy = true;
      await render();
      await t.type("then the tests");
      await t.key("Enter", { altKey: true });
      await t.settle();
      expect(onQueue).toHaveBeenCalledWith("then the tests");
      await t.type("look at the logs");
      await t.key("Enter");
      await t.settle();
      expect(onSend).toHaveBeenCalledTimes(2);
      expect(sent[1]!.text).toBe("look at the logs");
      // Up in the empty box takes the queued message back.
      await t.key("ArrowUp");
      expect(recall).toHaveBeenCalledTimes(1);
    } finally {
      catalog.mockRestore();
      await React.act(async () => t.root.unmount());
      await t.browser.happyDOM.close();
    }
  });

  test("the Vim box completes /commands and takes a pasted image", async () => {
    const t = await setup();
    const uploaded: string[] = [];
    const onSend = mock(async (text: string) => {
      void text;
    });
    try {
      await React.act(async () =>
        t.root.render(
          <t.AgentHistoryComposer
            draftKey="agent:vim-commands"
            agent="claude"
            status="idle"
            vimKeys
            commands={[
              { name: "review", description: "Review the changes" },
              { name: "resume", description: "Resume a session" },
            ]}
            onSend={onSend}
            onUploadImage={async (file) => {
              uploaded.push(file.name);
              return `/tmp/uploads/${file.name}`;
            }}
            onError={() => {}}
          />,
        ),
      );
      await t.shown();
      await React.act(async () => {
        t.view()!.contentDOM.dispatchEvent(new Event("focus"));
        t.view()!.contentDOM.dispatchEvent(
          new Event("focusin", { bubbles: true }),
        );
      });
      await t.type("/rev");
      const commands = t.container.querySelector('[aria-label="Commands"]');
      expect(commands?.textContent).toContain("/review");
      expect(commands?.textContent).not.toContain("/resume");
      await t.key("Tab");
      await t.settle();
      expect(t.view()!.state.doc.toString()).toBe("/review ");
      // A pasted image goes up, and is in the box as an attachment.
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      const image = new File(["png"], "shot.png", { type: "image/png" });
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [image], items: [], getData: () => "" },
      });
      await React.act(async () => {
        t.view()!.contentDOM.dispatchEvent(paste);
      });
      await t.settle();
      expect(uploaded).toEqual(["shot.png"]);
      expect(t.view()!.state.doc.toString()).toContain("[Image #1]");
      expect(
        t.container.querySelector('[aria-label="Remove image 1"]'),
      ).not.toBeNull();
      await t.key("Enter");
      await t.settle();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend.mock.calls[0]![0]).toContain("/tmp/uploads/shot.png");
    } finally {
      await React.act(async () => t.root.unmount());
      await t.browser.happyDOM.close();
    }
  });
}
