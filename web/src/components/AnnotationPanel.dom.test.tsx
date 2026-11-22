import { inIsolatedChild } from "../testIsolated";
import { describe, expect, mock, test } from "bun:test";
import { mockReviewStore } from "../reviewState.testkit";

/**
 * The workspace's threads panel (it took over Review feedback): the
 * comments held for Send, edited, ordered, deleted, gone to, and handed to
 * an agent (Send, Pre-fill, Copy), above every conversation of the
 * workspace's reviews, each going to its place.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "workspace threads panel in an isolated DOM runtime",
    "ROAMGATE_WORKSPACE_THREADS_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom } = await import("./reviewSurface.testkit");
  const browser = await installReviewDom();
  // The comment editors' Vim editor loads lazily, which uses it.
  Object.defineProperty(globalThis, "sessionStorage", {
    value: browser.sessionStorage,
    configurable: true,
    writable: true,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  type Snapshot = import("../../../shared/review").ReviewSnapshot;
  type Thread = import("../../../shared/review").ReviewThread;
  type Annotation = import("../annotations").ReviewAnnotation;

  const thread = (
    id: string,
    body: string,
    anchor: Thread["anchor"],
    extra: Partial<Thread> = {},
  ): Thread =>
    ({
      id,
      sessionId: "chat",
      kind: "discussion",
      anchor,
      comments: [
        {
          id: `${id}c`,
          author: "you",
          body,
          createdAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:00Z",
        },
      ],
      resolved: false,
      createdAt: "2026-11-10T10:00:00Z",
      updatedAt: "2026-11-10T10:00:00Z",
      ...extra,
    }) as Thread;
  const chatReview = {
    session: {
      id: "chat",
      connectionId: "local",
      workspaceId: "w1",
      root: "/repo",
      title: "Chat with claude",
      target: { kind: "chat", chat: "session-7" },
      agent: { name: "claude", paneId: "p2" },
    },
    threads: [
      // Sent: a conversation of the workspace.
      thread("handed", "Why does it fail?", {
        terminal: { pane: "p2", title: "claude", quote: "error: nope" },
      }),
      // Held: listed with the comments to send, not twice.
      thread(
        "held",
        "Fix this",
        { terminal: { pane: "p2", title: "claude", quote: "panic" } },
        { held: 1 },
      ),
    ],
  } as unknown as Snapshot;
  const otherWorkspace = {
    ...chatReview,
    session: { ...chatReview.session, id: "w2", workspaceId: "w2" },
    threads: [thread("elsewhere", "Not here", { path: "a.ts", line: 1 })],
  } as unknown as Snapshot;
  const state = {
    sessions: new Map([
      ["chat", chatReview],
      ["w2", otherWorkspace],
    ]),
    openRequest: null,
  };
  mock.module("../review", () => ({
    ...mockReviewStore(() => state),
    reviewCall: async () => ({}),
    rememberReviewSnapshot: () => {},
  }));
  const { AnnotationPanel } = await import("./AnnotationPanel");
  const { WorkspaceConversations } = await import("./FileThreads");

  const held: Annotation[] = [
    {
      id: "held",
      source: "terminal",
      anchor: "quote",
      paneId: "p2",
      title: "claude",
      quote: "panic",
      comment: "Fix this",
      createdAt: 1,
    },
    {
      id: "file",
      source: "file",
      anchor: "line",
      path: "docs/plan.md",
      line: 3,
      quote: "the line",
      comment: "Clearer?",
      createdAt: 2,
    },
  ];
  const agentPane = {
    pane_id: "p2",
    terminal_id: "t2",
    workspace_id: "w1",
    tab_id: "tab",
    agent: "claude",
    title: "claude",
    focused: true,
  } as never;

  function mount(
    annotations: readonly Annotation[],
    agentPanes: readonly never[] = [agentPane],
  ) {
    const events: unknown[][] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const draw = (list: readonly Annotation[]) =>
      root.render(
        <AnnotationPanel
          open
          floating={false}
          annotations={list}
          agentPanes={agentPanes}
          preferredPaneId="p2"
          busy={false}
          focusedAnnotationId={null}
          onClose={() => events.push(["close"])}
          onUpdateComment={(id, text) => events.push(["edit", id, text])}
          onDelete={(id) => events.push(["delete", id])}
          onMove={(id, delta) => events.push(["move", id, delta])}
          onClear={() => events.push(["clear"])}
          onCopy={() => events.push(["copy"])}
          onSend={(pane, submit) => events.push(["send", pane, !!submit])}
          onGo={(id) => events.push(["go", id])}
          onGoToAgent={() => events.push(["agent"])}
          conversations={
            <WorkspaceConversations
              connectionId="local"
              workspaceId="w1"
              onGo={(found, snapshot) =>
                events.push(["conversation", found.id, snapshot.session.id])
              }
              onClose={() => events.push(["close"])}
            />
          }
        />,
      );
    act(() => draw(annotations));
    const panel = host.querySelector<HTMLElement>(".annotation-panel")!;
    const button = (label: string) =>
      [...panel.querySelectorAll<HTMLButtonElement>("button")].find(
        (each) =>
          each.getAttribute("aria-label") === label ||
          each.textContent?.trim().startsWith(label),
      );
    return {
      panel,
      events,
      button,
      redraw: (list: readonly Annotation[]) => act(() => draw(list)),
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  const click = (element: HTMLElement | undefined) => {
    expect(element).toBeDefined();
    act(() => {
      element!.click();
    });
  };

  describe("workspace threads panel", () => {
    test("one panel: the comments to send across the workspace, where each was written, above its conversations", () => {
      const view = mount(held);
      expect(view.panel.getAttribute("aria-label")).toBe("Workspace threads");
      expect(view.panel.textContent).not.toContain("Review feedback");
      expect(view.panel.textContent).toContain("2 to send");
      const cards = [
        ...view.panel.querySelectorAll<HTMLElement>(".annotation-card"),
      ];
      expect(cards.map((card) => card.dataset.reviewAnnotationId)).toEqual([
        "held",
        "file",
      ]);
      expect(cards[0]!.textContent).toContain("Terminal · claude");
      expect(cards[1]!.textContent).toContain("File · docs/plan.md");
      // The conversations are shown, not behind a toggle: the sent one,
      // never the held one twice, nor another workspace's.
      const listed = [
        ...view.panel.querySelectorAll<HTMLElement>("[data-panel-thread]"),
      ].map((item) => item.dataset.panelThread);
      expect(listed).toEqual(["handed"]);
      expect(view.panel.textContent).toContain("Terminal: claude");
      view.unmount();
    });

    test("a held comment is edited, moved, deleted and gone to from its card", () => {
      // The plain box (Vim keys off); the Vim editor is tested below.
      localStorage.setItem("roamgate:vimKeys", "false");
      const view = mount(held);
      const textarea = view.panel.querySelector<HTMLTextAreaElement>(
        '[data-review-annotation-id="held"] textarea',
      )!;
      expect(textarea.value).toBe("Fix this");
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(textarea),
          "value",
        )!.set!;
        setter.call(textarea, "Fix this now");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // The first cannot go up, the last cannot go down.
      expect(view.button("Move comment 1 up")?.disabled).toBe(true);
      expect(view.button("Move comment 2 down")?.disabled).toBe(true);
      click(view.button("Move comment 1 down"));
      click(view.button("Go to comment 2"));
      click(view.button("Delete comment 1"));
      expect(view.events).toEqual([
        ["edit", "held", "Fix this now"],
        ["move", "held", 1],
        ["go", "file"],
        ["delete", "held"],
      ]);
      view.unmount();
    });

    test("Send, Pre-fill and Copy hand the held comments to the agent's pane; Clear asks first; Go to agent", () => {
      const view = mount(held);
      expect(view.panel.textContent).toContain("Agent pane: ");
      click(view.button("Pre-fill agent"));
      click(view.button("Send"));
      click(view.button("Copy"));
      click(view.button("Go to agent"));
      click(view.button("Clear held"));
      expect(view.events).toEqual([
        ["send", "p2", false],
        ["send", "p2", true],
        ["copy"],
        ["agent"],
      ]);
      const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((each) => each.textContent?.trim() === "Delete them");
      click(confirm);
      expect(view.events[view.events.length - 1]).toEqual(["clear"]);
      view.unmount();
    });

    test("without an agent pane, Send copies; with nothing held, nothing is sent and the conversations stay", () => {
      const none = mount(held, []);
      expect(none.panel.textContent).toContain(
        "No agent pane; Send uses the clipboard.",
      );
      click(none.button("Copy feedback"));
      expect(none.events).toEqual([["send", null, false]]);
      none.unmount();
      const empty = mount([]);
      expect(empty.panel.textContent).toContain("Nothing waiting to send");
      expect(empty.button("Pre-fill agent")?.disabled).toBe(true);
      expect(empty.button("Copy")?.disabled).toBe(true);
      expect(
        empty.panel.querySelector('[data-panel-thread="handed"]'),
      ).not.toBeNull();
      empty.unmount();
    });

    test("a conversation goes to its review at its place; Esc in the list closes the panel", () => {
      const view = mount(held);
      const item = view.panel.querySelector<HTMLElement>(
        '[data-panel-thread="handed"]',
      )!;
      click(
        [...item.querySelectorAll<HTMLButtonElement>("button")].find(
          (each) => each.textContent?.trim() === "Go to it",
        ),
      );
      expect(view.events).toEqual([["conversation", "handed", "chat"]]);
      const list = view.panel.querySelector<HTMLElement>(".threads-panel")!;
      act(() => {
        list.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(view.events[view.events.length - 1]).toEqual(["close"]);
      view.unmount();
    });

    /** The panel with the held comments in the Vim editor, once drawn. */
    async function mountVim(annotations: readonly Annotation[] = held) {
      localStorage.setItem("roamgate:vimKeys", "true");
      const view = mount(annotations);
      await act(async () => {
        for (let tick = 0; tick < 8; tick++)
          await new Promise((done) => setTimeout(done, 10));
      });
      const { EditorView } = await import("@codemirror/view");
      const { getCM } = await import("@replit/codemirror-vim");
      const editor = (id: string) =>
        EditorView.findFromDOM(
          view.panel.querySelector<HTMLElement>(
            `[data-review-annotation-id="${id}"] .cm-editor`,
          )!,
        )!;
      return {
        ...view,
        editor,
        insertMode: (id: string) => !!getCM(editor(id))?.state.vim?.insertMode,
        key: (id: string, key: string, init: KeyboardEventInit = {}) =>
          act(() => {
            editor(id).contentDOM.dispatchEvent(
              new KeyboardEvent("keydown", {
                key,
                bubbles: true,
                cancelable: true,
                ...init,
              }),
            );
          }),
      };
    }

    test("with Vim keys a held comment is edited in the comment editors' Vim editor, moved, deleted and gone to from its card", async () => {
      const view = await mountVim();
      expect(
        view.panel.querySelector('[data-review-annotation-id="held"] textarea'),
      ).toBeNull();
      const editor = view.editor("held");
      expect(editor.state.doc.toString()).toBe("Fix this");
      expect(editor.contentDOM.getAttribute("aria-label")).toBe("Comment 1");
      act(() => {
        editor.focus();
      });
      // Insert mode on focus, as the other comment editors.
      expect(view.insertMode("held")).toBe(true);
      act(() => {
        editor.dispatch({
          changes: { from: editor.state.doc.length, insert: " now" },
          userEvent: "input.type",
        });
      });
      expect(view.button("Move comment 1 up")?.disabled).toBe(true);
      expect(view.button("Move comment 2 down")?.disabled).toBe(true);
      click(view.button("Move comment 1 down"));
      click(view.button("Go to comment 2"));
      click(view.button("Delete comment 1"));
      expect(view.events).toEqual([
        ["edit", "held", "Fix this now"],
        ["move", "held", 1],
        ["go", "file"],
        ["delete", "held"],
      ]);
      view.unmount();
    });

    test("with Vim keys Esc leaves insert mode, then the editor, words kept; Pre-fill and Copy keys still work from it", async () => {
      const view = await mountVim();
      const editor = view.editor("file");
      act(() => {
        editor.focus();
      });
      expect(view.insertMode("file")).toBe(true);
      await view.key("file", "Escape");
      expect(view.insertMode("file")).toBe(false);
      expect(document.activeElement).toBe(editor.contentDOM);
      await view.key("file", "Escape");
      expect(document.activeElement).not.toBe(editor.contentDOM);
      expect(editor.state.doc.toString()).toBe("Clearer?");
      act(() => {
        editor.focus();
      });
      await view.key("file", "Enter", { ctrlKey: true });
      await view.key("file", "C", { ctrlKey: true, shiftKey: true });
      expect(view.events).toEqual([["send", "p2", false], ["copy"]]);
      view.unmount();
    });

    test("with Vim keys a held comment changed elsewhere is drawn again, and no more than 10000 characters are taken", async () => {
      const view = await mountVim();
      // Its own typing is not drawn again.
      const editor = view.editor("held");
      act(() => {
        editor.dispatch({
          changes: { from: 8, insert: "!" },
          userEvent: "input.type",
        });
      });
      view.redraw(
        held.map((annotation) =>
          annotation.id === "held"
            ? { ...annotation, comment: "Fix this!" }
            : annotation,
        ),
      );
      expect(view.editor("held")).toBe(editor);
      // The same panel, its held comment edited in its chat.
      view.redraw(
        held.map((annotation) =>
          annotation.id === "held"
            ? { ...annotation, comment: "Fixed from the chat" }
            : annotation,
        ),
      );
      await act(async () => {
        for (let tick = 0; tick < 4; tick++)
          await new Promise((done) => setTimeout(done, 10));
      });
      expect(view.editor("held").state.doc.toString()).toBe(
        "Fixed from the chat",
      );
      view.unmount();
      const long = await mountVim([
        { ...held[0]!, comment: "x".repeat(9_998) },
      ]);
      const full = long.editor("held");
      act(() => {
        full.dispatch({
          changes: { from: full.state.doc.length, insert: "abcdef" },
          userEvent: "input.type",
        });
      });
      expect(full.state.doc.length).toBe(9_998);
      act(() => {
        full.dispatch({
          changes: { from: full.state.doc.length, insert: "ab" },
          userEvent: "input.type",
        });
      });
      expect(full.state.doc.length).toBe(10_000);
      long.unmount();
    });
  });
}
