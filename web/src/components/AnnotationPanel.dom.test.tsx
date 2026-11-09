import { describe, expect, mock, test } from "bun:test";

/**
 * The workspace's threads panel (it took over Review feedback): the
 * comments held for Send, edited, ordered, deleted, gone to, and handed to
 * an agent (Send, Pre-fill, Copy), above every conversation of the
 * workspace's reviews, each going to its place.
 */
if (process.env.ROAMGATE_WORKSPACE_THREADS_DOM_TEST !== "1") {
  test("workspace threads panel in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_WORKSPACE_THREADS_DOM_TEST: "1" },
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
  const { installReviewDom } = await import("./reviewSurface.testkit");
  await installReviewDom();
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
    useReviewState: () => state,
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
    act(() => {
      root.render(
        <AnnotationPanel
          open
          floating={false}
          annotations={annotations}
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
    });
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
  });
}
