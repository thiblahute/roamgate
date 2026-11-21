import { expect, test } from "bun:test";

if (process.env.ROAMGATE_CHAT_THREADS_DOM_TEST !== "1") {
  test("chat thread composer in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_THREADS_DOM_TEST: "1" },
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
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Text: browser.Text,
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLInputElement: browser.HTMLInputElement,
    Range: browser.Range,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    CSS: {
      escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  /** Each write made, and the answer the test gives it. */
  const writes: { method: string; params: Record<string, unknown> }[] = [];
  let answerWrite: ((error?: Error) => void) | null = null;
  const chatReview = {
    session: {
      id: "s1",
      connectionId: "local",
      workspaceId: "w1",
      root: "/repo",
      title: "Chat with claude",
      target: { kind: "chat", chat: "chat-1" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-10-31",
      updatedAt: "2026-10-31",
    },
    threads: [
      {
        id: "8f60120002bd9a0a",
        sessionId: "s1",
        kind: "discussion",
        anchor: { chat: { entry: "e1", quote: "The review series" } },
        comments: [
          {
            id: "0516d7d030590dda",
            author: "you",
            body: "Why not 1 mr?",
            createdAt: "2026-10-31T19:16:11Z",
            updatedAt: "2026-10-31T19:16:11Z",
          },
        ],
        resolved: false,
        createdAt: "2026-10-31T19:16:11Z",
        updatedAt: "2026-10-31T19:16:11Z",
      },
    ],
  };
  /** The review as the store has it: a new snapshot replaces it. */
  let shownReview = chatReview;
  const { mock } = await import("bun:test");
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      if (method === "review.get") return shownReview;
      writes.push({ method, params });
      await new Promise<void>((resolve, reject) => {
        answerWrite = (error) => (error ? reject(error) : resolve());
      });
      return {};
    },
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({
      sessions: new Map([["s1", shownReview]]),
      openRequest: null,
    }),
  }));

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test("Send while a save is on its way sends nothing more", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ThreadEditor } = await import("./ChatThreads");
    const saved: string[] = [];
    const ids: string[] = [];
    let answer!: (ok: boolean) => void;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadEditor
          placeholder="Reply..."
          onSave={(text, id) => {
            saved.push(text);
            ids.push(id);
            return new Promise<boolean>((resolve) => {
              answer = resolve;
            });
          }}
          onClose={() => {}}
          onLeave={() => {}}
        />,
      );
    });
    // The editor is loaded with the first comment box.
    for (let i = 0; i < 50 && !host.querySelector(".cm-content"); i++)
      await act(settle);
    const view = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-content")!,
    );
    expect(view).not.toBeNull();
    await act(async () =>
      view!.dispatch({
        changes: { from: 0, insert: "but i like my overlay! " },
      }),
    );
    const send = () =>
      [...host.querySelectorAll("button")].find((button) =>
        /^Send|^Sending/.test(button.textContent ?? ""),
      )!;
    // A phone shows nothing happening while the answer is slow: pressed
    // again, and again.
    await act(async () => send().click());
    await act(async () => send().click());
    await act(async () => send().click());
    expect(saved).toEqual(["but i like my overlay! "]);
    expect(send().textContent).toBe("Sending...");
    expect(send().disabled).toBe(true);

    // It failed: the box stays with its text, and Send works again.
    await act(async () => answer(false));
    await act(settle);
    expect(send().textContent).toBe("Send");
    await act(async () => send().click());
    expect(saved.length).toBe(2);
    // The same text again: the same id, so the server writes it once.
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(ids[1]).toBe(ids[0]);
    // Changed, it is another comment.
    await act(async () => answer(false));
    await act(settle);
    await act(async () =>
      view!.dispatch({ changes: { from: 0, insert: "and " } }),
    );
    await act(async () => send().click());
    expect(ids[2]).not.toBe(ids[0]);
    await act(async () => root.unmount());
  });

  test("a reply shows in its thread at once, pending, with its id", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ChatThreadsProvider, useChatParts } = await import("./ChatThreads");
    const entry = { id: "e1", role: "assistant", text: "The review series" };
    function Message() {
      const parts = useChatParts(entry as never);
      return (
        <div>
          {parts?.notes.map((note) => (
            <div key={note.key}>{note.node}</div>
          ))}
        </div>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ChatThreadsProvider
          connectionId="local"
          workspaceId="w1"
          chat="chat-1"
          path="/repo"
          agent="claude"
          paneId="w1:p1"
        >
          <Message />
        </ChatThreadsProvider>,
      );
    });
    const button = (label: RegExp) =>
      [...host.querySelectorAll("button")].find((element) =>
        label.test(element.textContent ?? ""),
      );
    // The thread's Reply (in its bar), not the one on its message.
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>(".chat-thread-bar button")]
        .find((element) => element.textContent === "Reply")!
        .click(),
    );
    for (let i = 0; i < 50 && !host.querySelector(".cm-content"); i++)
      await act(settle);
    const view = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-content")!,
    );
    await act(async () =>
      view!.dispatch({
        changes: { from: 0, insert: "but i like my overlay!" },
      }),
    );
    await act(async () => button(/^Send$/)!.click());
    await act(async () => button(/^Sending/)?.click());
    await act(settle);
    // Sent once, with an id, and shown at once in the thread, pending.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("review.reply");
    expect(writes[0]!.params.comment_id).toBe("8f60120002bd9a0a");
    const id = writes[0]!.params.new_comment_id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const pending = host.querySelector(".chat-thread-message.is-pending");
    expect(pending?.textContent).toContain("but i like my overlay!");
    expect(pending?.textContent).toContain("Sending...");

    // It fails: still shown, marked, and Send tries again with its id.
    await act(async () => answerWrite!(new Error("timeout: review.reply")));
    await act(settle);
    expect(
      host.querySelector(".chat-thread-message.is-pending")?.textContent,
    ).toContain("Not saved");
    await act(async () => button(/^Send$/)!.click());
    await act(settle);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.params.new_comment_id).toBe(id);
    await act(async () => answerWrite!());
    await act(settle);
    await act(async () => root.unmount());
  });

  test("a comment whose message changed id is drawn on it, else listed", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ChatThreadsProvider, useChatParts } = await import("./ChatThreads");
    // The message commented on as e1, now read with another id.
    const entry = {
      id: "r1",
      kind: "message",
      role: "assistant",
      text: "The **review** series is in three parts.",
    };
    function Message() {
      const parts = useChatParts(entry as never);
      return (
        <div className="agent-history-chat" data-entry-id={entry.id}>
          {parts?.notes.map((note) => (
            <div key={note.key}>{note.node}</div>
          ))}
        </div>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const draw = (entries: unknown[]) =>
      root.render(
        <ChatThreadsProvider
          connectionId="local"
          workspaceId="w1"
          chat="chat-1"
          path="/repo"
          agent="claude"
          paneId="w1:p1"
          entries={entries as never}
        >
          <div className="agent-history-chat-frame">
            <Message />
          </div>
        </ChatThreadsProvider>,
      );
    await act(async () => draw([entry]));
    await act(settle);
    // Under its message, found by its words.
    expect(
      host.querySelector('[data-entry-id="r1"] .chat-thread')?.textContent,
    ).toContain("Why not 1 mr?");
    expect(host.querySelector(".chat-threads-away")).toBeNull();

    // Its message not among those shown: said, and listed in the panel.
    await act(async () => draw([{ ...entry, text: "Something else" }]));
    await act(settle);
    expect(host.querySelector('[data-entry-id="r1"] .chat-thread')).toBeNull();
    const away = host.querySelector<HTMLButtonElement>(".chat-threads-away");
    expect(away?.textContent).toBe("1 on messages not shown");
    expect(host.querySelector(".threads-chip")?.textContent).toContain(
      "1 open",
    );
    await act(async () => away!.click());
    await act(settle);
    const item = host.querySelector(".chat-threads-panel .threads-panel-item");
    expect(item?.textContent).toContain("its message is not in the chat shown");
    // Going to it says where it is rather than doing nothing.
    const go = [...item!.querySelectorAll("button")].find(
      (button) => button.textContent === "Go to it",
    )!;
    await act(async () => go.click());
    await act(settle);
    expect(host.querySelector(".chat-thread-error")?.textContent).toContain(
      "not in the chat shown",
    );
    await act(async () => root.unmount());
  });

  test("gn / gN go through the chat's unresolved comments; gH shows only them", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ChatThreadsProvider, useChatParts } = await import("./ChatThreads");
    localStorage.clear();
    const kept = chatReview.threads;
    const thread = (id: string, quote: string, resolved: boolean) => ({
      ...kept[0]!,
      id,
      anchor: { chat: { entry: "e1", quote } },
      comments: [{ ...kept[0]!.comments[0]!, id: `${id}c`, body: `On ${id}` }],
      resolved,
    });
    // Out of order: drawn by where their words are in the message.
    chatReview.threads = [
      thread("t3", "Third part", false),
      thread("t1", "First part", false),
      thread("t2", "Second part", true),
    ];
    const entry = {
      id: "e1",
      kind: "message",
      role: "assistant",
      text: "First part. Second part. Third part.",
    };
    function Message() {
      const parts = useChatParts(entry as never);
      return (
        <div className="agent-history-chat" data-entry-id={entry.id}>
          {parts?.notes.map((note) => (
            <div key={note.key}>{note.node}</div>
          ))}
        </div>
      );
    }
    const host = document.createElement("div");
    host.className = "agent-history-messages";
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ChatThreadsProvider
          connectionId="local"
          workspaceId="w1"
          chat="chat-1"
          path="/repo"
          agent="claude"
          paneId="w1:p1"
          entries={[entry] as never}
        >
          <div className="agent-history-chat-frame">
            <Message />
          </div>
        </ChatThreadsProvider>,
      ),
    );
    await act(settle);
    const list = host.querySelector<HTMLElement>(".agent-history-chat")!;
    const where = () =>
      host.querySelector(".chat-unresolved-nav .unresolved-nav-where")
        ?.textContent;
    const keys = (...names: string[]) =>
      act(async () => {
        for (const name of names)
          list.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
      });
    const focused = () =>
      host
        .querySelector(".chat-thread-message.is-focused")
        ?.closest("[data-thread-id]")
        ?.getAttribute("data-thread-id");

    expect(where()).toBe("2 unresolved");
    await keys("g", "n");
    await act(settle);
    expect(focused()).toBe("t1");
    expect(where()).toBe("1 of 2 unresolved");
    // Over the resolved one.
    await keys("g", "n");
    await act(settle);
    expect(focused()).toBe("t3");
    expect(where()).toBe("2 of 2 unresolved");
    // Past the last: back at the first, and said.
    await keys("g", "n");
    await act(settle);
    expect(focused()).toBe("t1");
    expect(host.querySelector(".chat-unresolved-notice")?.textContent).toBe(
      "1 of 2 unresolved, back at the first",
    );
    await keys("g", "N");
    await act(settle);
    expect(focused()).toBe("t3");

    // The resolved one is drawn folded; gH leaves it out.
    expect(host.querySelector('[data-thread-id="t2"]')).not.toBeNull();
    await keys("g", "H");
    await act(settle);
    expect(host.querySelector('[data-thread-id="t2"]')).toBeNull();
    expect(localStorage.getItem("roamgate:threads.openOnly")).toBe("1");
    await act(async () => root.unmount());
    chatReview.threads = kept;
    localStorage.clear();
  });

  test("Reply on a thread's message opens a thread on the whole message, drawn under it; R on the message too", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { ChatThreadsProvider, useChatParts } = await import("./ChatThreads");
    localStorage.clear();
    writes.length = 0;
    const kept = chatReview.threads;
    const entry = {
      id: "e1",
      kind: "message",
      role: "assistant",
      text: "The review series",
    };
    function Message() {
      const parts = useChatParts(entry as never);
      return (
        <div className="agent-history-chat" data-entry-id={entry.id}>
          {parts?.notes.map((note) => (
            <div key={note.key}>{note.node}</div>
          ))}
        </div>
      );
    }
    const host = document.createElement("div");
    host.className = "agent-history-messages";
    const composer = document.createElement("div");
    composer.className = "agent-history-composer";
    composer.append(document.createElement("textarea"));
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ChatThreadsProvider
          connectionId="local"
          workspaceId="w1"
          chat="chat-1"
          path="/repo"
          agent="claude"
          paneId="w1:p1"
          entries={[entry] as never}
        >
          <div className="agent-history-chat-frame">
            <Message />
          </div>
        </ChatThreadsProvider>,
      ),
    );
    host.append(composer);
    await act(settle);
    const body = () =>
      host.querySelector<HTMLElement>('[data-message-id="0516d7d030590dda"]')!;
    // Reply at the right of the author's row.
    const head = body().previousElementSibling!;
    expect(head.classList.contains("chat-thread-message-head")).toBe(true);
    expect(head.querySelector(".chat-thread-author")?.textContent).toBe("You");
    const reply = head.querySelector<HTMLButtonElement>(
      ".chat-thread-message-reply",
    )!;
    expect(reply?.textContent).toBe("Reply");
    await act(async () => reply.click());
    for (
      let i = 0;
      i < 50 &&
      !body().querySelector(".chat-message-notes .is-draft .cm-content");
      i++
    )
      await act(settle);
    // A box under the message, after its text; the thread's own Reply stays.
    const box = body().querySelector<HTMLElement>(
      ":scope > .chat-message-notes > .chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    expect(
      [...host.querySelectorAll(".chat-thread-bar button")].map(
        (button) => button.textContent,
      ),
    ).toContain("Reply");
    const view = EditorView.findFromDOM(
      box.querySelector<HTMLElement>(".cm-content")!,
    );
    await act(async () =>
      view!.dispatch({
        changes: { from: 0, insert: "Because one is enough." },
      }),
    );
    const send = [...box.querySelectorAll("button")].find(
      (button) => button.textContent === "Send",
    )!;
    await act(async () => send.click());
    await act(settle);
    // A thread on the message alone: no words quoted.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "review.thread.add",
      params: {
        kind: "discussion",
        text: "Because one is enough.",
        anchor: {
          message: { thread: "8f60120002bd9a0a", comment: "0516d7d030590dda" },
        },
      },
    });
    const anchor = writes[0]!.params.anchor as {
      message: Record<string, unknown>;
    };
    expect(Object.keys(anchor)).toEqual(["message"]);
    expect("quote" in anchor.message).toBe(false);
    // Saved: drawn under the message, its head saying where it is.
    const id = writes[0]!.params.new_thread_id as string;
    shownReview = {
      ...chatReview,
      threads: [
        ...kept,
        {
          ...kept[0]!,
          id,
          anchor: {
            message: {
              thread: "8f60120002bd9a0a",
              comment: "0516d7d030590dda",
            },
          },
          comments: [
            {
              ...kept[0]!.comments[0]!,
              id: `${id}c`,
              body: "Because one is enough.",
            },
          ],
        },
      ],
    } as unknown as typeof chatReview;
    await act(async () => answerWrite!());
    await act(settle);
    const nested = body().querySelector<HTMLElement>(
      `:scope > .chat-message-notes > [data-thread-id="${id}"]`,
    );
    expect(nested).not.toBeNull();
    expect(nested!.querySelector(".chat-thread-on")?.textContent).toBe(
      "On this message",
    );
    expect(body().querySelector(".is-draft")).toBeNull();
    // R on the message's stop opens the same box.
    const list = host.querySelector<HTMLElement>(".agent-history-chat")!;
    list.focus();
    const key = (name: string) =>
      act(async () => {
        list.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
        await settle();
      });
    await key("j");
    expect(
      host
        .querySelector(".chat-thread-message.is-focused [data-message-id]")
        ?.getAttribute("data-message-id"),
    ).toBe("0516d7d030590dda");
    await key("R");
    expect(
      body().querySelector(
        ":scope > .chat-message-notes > .chat-thread.is-draft",
      ),
    ).not.toBeNull();
    await act(async () => root.unmount());
    host.remove();
    shownReview = chatReview;
    localStorage.clear();
  });

  test("a comment the agent did not get says why, on it and on the chip, with a Retry", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ChatThreadsProvider, useChatParts } = await import("./ChatThreads");
    localStorage.clear();
    // Its delivery failed: Claude for this chat runs in no pane any more.
    const session = chatReview.session as Record<string, unknown>;
    session.deliveredAt = "2026-10-31T19:00:00Z";
    session.deliveryError = "agent_not_found: agent target w1:p1 not found";
    const kept = chatReview.threads;
    const entry = { id: "e1", role: "assistant", text: "The review series" };
    function Message() {
      const parts = useChatParts(entry as never);
      return (
        <div className="agent-history-chat" data-entry-id={entry.id}>
          {parts?.notes.map((note) => (
            <div key={note.key}>{note.node}</div>
          ))}
        </div>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const draw = () =>
      root.render(
        <ChatThreadsProvider
          connectionId="local"
          workspaceId="w1"
          chat="chat-1"
          path="/repo"
          agent="claude"
          paneId="w1:p1"
          entries={[entry] as never}
        >
          <div className="agent-history-chat-frame">
            <Message />
          </div>
        </ChatThreadsProvider>,
      );
    await act(async () => draw());
    await act(settle);
    const notice = host.querySelector(".chat-thread-message .is-failed");
    expect(notice?.textContent).toBe(
      "Not delivered: Claude for this chat is not running in any pane",
    );
    expect(host.querySelector(".threads-chip")?.textContent).toContain(
      "1 not delivered",
    );
    // Retry asks the bridge to send what waits, now.
    const before = writes.length;
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    await act(settle);
    expect(writes.slice(before).map((write) => write.method)).toEqual([
      "review.retry",
    ]);
    await act(async () => answerWrite!());
    await act(settle);

    // Answered in its thread (pasted by hand): it reached the agent.
    shownReview = {
      ...chatReview,
      threads: [
        {
          ...kept[0]!,
          comments: [
            ...kept[0]!.comments,
            {
              id: "a1b2c3d4e5f60718",
              author: "Claude",
              body: "One is enough.",
              createdAt: "2026-10-31T19:20:00Z",
              updatedAt: "2026-10-31T19:20:00Z",
            },
          ],
        },
      ],
    };
    await act(async () => draw());
    await act(settle);
    expect(host.querySelector(".chat-thread-message .is-failed")).toBeNull();
    expect(host.querySelector(".threads-chip")?.textContent).not.toContain(
      "not delivered",
    );
    await act(async () => root.unmount());
    shownReview = chatReview;
    delete session.deliveredAt;
    delete session.deliveryError;
    localStorage.clear();
  });
}
