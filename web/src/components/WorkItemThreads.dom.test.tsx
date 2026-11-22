import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * An item's threads in its detail, on the chat threads' model: the
 * description and every comment are messages in parts, the + beside a
 * part opens a thread on it quoting it, drawn under the part; j / k go
 * through the parts and the threads' messages and c on a part comments
 * on it; words selected in a comment offer Comment, quoting them.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "threads on an item's comments, in an isolated DOM runtime",
    "ROAMGATE_WORK_ITEM_THREADS_DOM_TEST",
    40_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/", width: 1280 });
  (HTMLElement.prototype as any).scrollIntoView = () => {};
  const React = await import("react");
  const { act, useRef } = React;
  mock.module("./ReviewCommentEditorLazy", () => ({
    ReviewCommentEditorLazy: (props: {
      placeholder?: string;
      onChange: (text: string) => void;
    }) => (
      <textarea
        aria-label={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    ),
  }));
  const { createRoot } = await import("react-dom/client");
  const { selectedWords } = await import("./MessageThreads");
  const {
    useWorkItemKeys,
    useWorkItemView,
    WorkDescription,
    WorkItemThreads,
    workWordsLocate,
  } = await import("./WorkItemThreads");
  type Api = Parameters<typeof WorkItemThreads>[0]["api"];

  const at = "2026-11-20T10:00:01.000Z";
  const comment = (id: string, author: string, body: string) => ({
    id,
    author,
    body,
    createdAt: at,
    updatedAt: at,
  });
  const thread = (
    id: string,
    anchor: Record<string, unknown>,
    comments: ReturnType<typeof comment>[],
  ) => ({
    id,
    sessionId: "r000000000000001",
    kind: "discussion" as const,
    anchor,
    comments,
    resolved: false,
    createdAt: at,
    updatedAt: at,
  });
  const item = "1200000000000000";
  const description = thread(
    "d000000000000001",
    { work: { item, description: true } },
    [comment("c000000000000000", "you", "The description of the item.")],
  );
  const parent = thread("a000000000000001", { work: { item } }, [
    comment("c000000000000001", "you", "Please look at the box."),
    comment(
      "c000000000000002",
      "Claude",
      "Done: the box opens.\n\nThe words go with it.",
    ),
  ]);
  const nested = thread(
    "b000000000000001",
    {
      work: { item },
      message: {
        thread: parent.id,
        comment: "c000000000000002",
        quote: "The words go with it.",
      },
    },
    [comment("c000000000000003", "you", "Which words?")],
  );
  const onDescription = thread(
    "b000000000000002",
    {
      work: { item },
      message: {
        thread: description.id,
        comment: "c000000000000000",
        quote: "The description of the item.",
      },
    },
    [comment("c000000000000004", "Claude", "Noted.")],
  );
  const sends: Record<string, unknown>[] = [];
  const fallbacks: string[] = [];
  const data = {
    snapshot: undefined,
    threads: [description, parent, nested, onDescription],
    open: 4,
    waiting: null,
    write: async () => true,
    addImage: async () => "",
    send: async (next: Record<string, unknown>) => {
      sends.push(next);
      return true;
    },
    pendingById: new Map(),
    undelivered: new Set<string>(),
    error: "",
  };
  /** The detail as the board draws it: the description, then the threads. */
  function Detail() {
    const view = useWorkItemView();
    const api = { ...data, ...view } as Api;
    const listRef = useRef<HTMLDivElement>(null);
    const leave = () => listRef.current?.focus();
    useWorkItemKeys({
      api,
      description,
      getList: () => listRef.current,
      fallback: (key) => {
        fallbacks.push(key);
        return key === "c" || key === "r" || key === "s";
      },
    });
    return (
      <div data-work-keys="" tabIndex={-1} ref={listRef}>
        <WorkDescription
          api={api}
          item={item}
          thread={description}
          onLeave={leave}
        />
        <WorkItemThreads
          item={item}
          api={api}
          description={description}
          compose={null}
          onComposeDone={() => {}}
          onLeave={leave}
        />
      </div>
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Detail />));
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const list = () => host.querySelector<HTMLElement>("[data-work-keys]")!;
  const card = (id: string) =>
    host.querySelector<HTMLElement>(`.chat-thread[data-thread-id="${id}"]`);
  const bodyOf = (id: string) =>
    host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const press = async (key: string) => {
    await act(async () => {
      list().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      await wait(10);
    });
  };
  const focusedKey = () => {
    const stop = host.querySelector<HTMLElement>(
      "[data-chat-stop].is-focused, .rc-part.is-focused",
    );
    if (!stop) return null;
    if (stop.dataset.chatStop) return stop.dataset.chatStop;
    const message =
      stop.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    return `q:${message}:${stop.dataset.part}`;
  };
  /** Writes in the box being written, then sends it. */
  const writeAndSend = async (box: HTMLElement, text: string) => {
    const field = box.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...box.querySelectorAll("button")].find(
      (button) => button.textContent === "Send",
    )!;
    await act(async () => {
      send.click();
      await wait(20);
    });
  };
  const firstText = (node: Node): Text | null => {
    if (node.nodeType === 3 && node.textContent?.trim()) return node as Text;
    for (const child of node.childNodes) {
      const found = firstText(child);
      if (found) return found;
    }
    return null;
  };

  test("the description and the comments are messages in parts with a + each, their threads drawn under the part quoted", () => {
    // In the chat's gutter, a + on every part.
    expect(
      host.querySelectorAll(
        ".work-description.chat-review, .work-description .chat-review",
      ).length,
    ).toBeGreaterThan(0);
    expect(host.querySelector(".work-threads.chat-review")).not.toBeNull();
    for (const id of [
      "c000000000000000",
      "c000000000000001",
      "c000000000000002",
    ])
      expect(
        bodyOf(id)!.querySelectorAll(
          ":scope > .rc-text > .rc-part > .rc-part-add",
        ).length,
      ).toBe(id === "c000000000000002" ? 2 : 1);
    // The thread on the description's words: under them, in the description.
    const noted = card(onDescription.id)!;
    expect(noted.closest(".work-description")).not.toBeNull();
    expect(noted.parentElement?.classList.contains("rc-part-notes")).toBe(true);
    expect(noted.textContent).toContain("Noted.");
    // The thread on the second paragraph of Claude's comment: under it.
    const shown = card(nested.id)!;
    expect(
      shown.closest("[data-message-id]")?.getAttribute("data-message-id"),
    ).toBe("c000000000000002");
    const quoted = shown.parentElement?.previousElementSibling;
    expect(quoted?.classList.contains("has-notes")).toBe(true);
    expect(quoted?.textContent).toContain("The words go with it.");
    expect(quoted?.textContent).not.toContain("Done: the box opens.");
    // Neither stands on its own among the threads.
    expect(host.querySelectorAll(".work-threads > .chat-thread").length).toBe(
      1,
    );
    expect(
      [...shown.querySelectorAll(".chat-thread-bar button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Reply", "Resolve", "Fold", "Delete"]);
  });

  test("+ beside a part opens a box under it, a thread on that part quoting it", async () => {
    const part =
      bodyOf("c000000000000002")!.querySelectorAll<HTMLElement>(".rc-part")[1]!;
    await act(async () =>
      part.querySelector<HTMLButtonElement>(".rc-part-add")!.click(),
    );
    const box = bodyOf("c000000000000002")!.querySelector<HTMLElement>(
      ".chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    // Under the part: after it (and the thread already there).
    const siblings = [...box.parentElement!.parentElement!.children];
    const partBefore = siblings
      .slice(0, siblings.indexOf(box.parentElement!))
      .reverse()
      .find((each) => each.classList.contains("rc-part"));
    expect(partBefore).toBe(part);
    const before = sends.length;
    await writeAndSend(box, "Thanks!");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]).toMatchObject({
      kind: "discussion",
      anchor: {
        work: { item },
        message: {
          thread: parent.id,
          comment: "c000000000000002",
          quote: "The words go with it.",
        },
      },
      text: "Thanks!",
    });
    expect(bodyOf("c000000000000002")!.querySelector(".is-draft")).toBe(null);
  });

  test("+ on the description opens a thread on it, in the description's thread", async () => {
    await act(async () =>
      bodyOf("c000000000000000")!
        .querySelector<HTMLButtonElement>(".rc-part > .rc-part-add")!
        .click(),
    );
    const box = host.querySelector<HTMLElement>(
      ".work-description .chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    const before = sends.length;
    await writeAndSend(box, "Is it?");
    expect(sends[sends.length - 1]).toMatchObject({
      anchor: {
        work: { item },
        message: {
          thread: description.id,
          comment: "c000000000000000",
          quote: "The description of the item.",
        },
      },
      text: "Is it?",
    });
    expect(sends.length).toBe(before + 1);
  });

  test("j / k go through the description's part, the messages and the parts of a long one; c on a part comments on it", async () => {
    list().focus();
    await press("j");
    expect(focusedKey()).toBe("q:c000000000000000:0");
    await press("j");
    // A thread on the description's words is a stop of its own first.
    expect(focusedKey()).toBe("m:c000000000000004");
    await press("j");
    expect(focusedKey()).toBe("m:c000000000000001");
    await press("j");
    expect(focusedKey()).toBe("m:c000000000000002");
    await press("j");
    expect(focusedKey()).toBe("q:c000000000000002:0");
    await press("j");
    expect(focusedKey()).toBe("q:c000000000000002:1");
    await press("k");
    expect(focusedKey()).toBe("q:c000000000000002:0");
    await press("c");
    const box = bodyOf("c000000000000002")!.querySelector<HTMLElement>(
      ".chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    expect(box.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Comment on this part...",
    );
    const before = sends.length;
    await writeAndSend(box, "On the first part.");
    expect(sends[sends.length - 1]).toMatchObject({
      anchor: {
        message: {
          thread: parent.id,
          comment: "c000000000000002",
          quote: "Done: the box opens.",
        },
      },
    });
    expect(sends.length).toBe(before + 1);
    // c on a message answers its thread; with no stop, the detail's own c.
    await press("k");
    await press("k");
    expect(focusedKey()).toBe("m:c000000000000001");
    await press("c");
    expect(
      card(parent.id)!
        .querySelector(":scope > .chat-thread-editor textarea")
        ?.getAttribute("aria-label"),
    ).toBe("Reply...");
    await act(async () =>
      [...card(parent.id)!.querySelectorAll("button")]
        .find((button) => button.textContent === "Cancel")!
        .click(),
    );
    await press("s");
    expect(fallbacks).toEqual(["s"]);
    // A click on the one part of a comment puts the cursor on the comment
    // (its stop); on a part of a long one, on that part.
    await act(async () =>
      bodyOf("c000000000000001")!
        .querySelector<HTMLElement>(".rc-part")!
        .click(),
    );
    expect(focusedKey()).toBe("m:c000000000000001");
    await act(async () =>
      bodyOf("c000000000000002")!
        .querySelectorAll<HTMLElement>(":scope > .rc-text > .rc-part")[1]!
        .click(),
    );
    expect(focusedKey()).toBe("q:c000000000000002:1");
  });

  test("words selected in a comment offer Comment: a thread on it quoting them", async () => {
    const body = bodyOf("c000000000000001")!;
    const words = firstText(body)!;
    expect(words.textContent).toBe("Please look at the box.");
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 11);
    range.getBoundingClientRect = () =>
      ({ left: 40, top: 100, bottom: 120, right: 120 }) as DOMRect;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      // The offer waits for the selection to settle.
      await wait(260);
    });
    const offer = document.querySelector<HTMLButtonElement>(
      ".chat-thread-select",
    )!;
    expect(offer?.textContent).toBe("Comment");
    expect(offer.style.left).toBe("40px");
    // Over the board's floating panel.
    expect(offer.classList.contains("work-thread-select")).toBe(true);
    await act(async () => offer.click());
    expect(document.querySelector(".chat-thread-select")).toBe(null);
    const box = body.querySelector<HTMLElement>(".chat-thread.is-draft")!;
    expect(box).not.toBeNull();
    const before = sends.length;
    await writeAndSend(box, "Which box?");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]).toMatchObject({
      anchor: {
        work: { item },
        message: {
          thread: parent.id,
          comment: "c000000000000001",
          quote: "Please look",
        },
      },
      text: "Which box?",
    });
    // Words of the description are the description thread's.
    const described = firstText(bodyOf("c000000000000000")!)!;
    const over = document.createRange();
    over.setStart(described, 0);
    over.setEnd(described, 3);
    selection.removeAllRanges();
    selection.addRange(over);
    expect(
      selectedWords(workWordsLocate(list(), description.id)),
    ).toMatchObject({
      thread: description.id,
      comment: "c000000000000000",
      quote: "The",
    });
    expect(
      selectedWords(workWordsLocate(document.createElement("div"), null)),
    ).toBe(null);
    selection.removeAllRanges();
  });

  test("Reply on a comment (the description too) opens a box under it: a thread on the whole comment, quoting nothing", async () => {
    const message = bodyOf("c000000000000002")!.closest<HTMLElement>(
      ".chat-thread-message",
    )!;
    const head = message.querySelector(":scope > .chat-thread-message-head")!;
    expect(head.querySelector(".chat-thread-author")?.textContent).toBe(
      "Claude",
    );
    const reply = head.querySelector<HTMLButtonElement>(
      ".chat-thread-message-reply",
    )!;
    expect(reply.textContent).toBe("Reply");
    await act(async () => reply.click());
    const box = bodyOf("c000000000000002")!.querySelector<HTMLElement>(
      ":scope > .chat-message-notes > .chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    expect(box.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Reply...",
    );
    // After the message's parts and the thread on one of them.
    const onPart = bodyOf("c000000000000002")!.querySelector(
      ".rc-part-notes .chat-thread",
    )!;
    expect(
      onPart.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const before = sends.length;
    await writeAndSend(box, "All good.");
    expect(sends.length).toBe(before + 1);
    const sent = sends[sends.length - 1] as {
      anchor: { message: Record<string, unknown> };
    };
    expect(sent).toMatchObject({
      kind: "discussion",
      anchor: {
        work: { item },
        message: { thread: parent.id, comment: "c000000000000002" },
      },
      text: "All good.",
    });
    expect("quote" in sent.anchor.message).toBe(false);
    expect(bodyOf("c000000000000002")!.querySelector(".is-draft")).toBeNull();
    // The description: Reply in a row under it (it has no author's row),
    // a thread on the whole description in the description's thread.
    const descriptionReply = host.querySelector<HTMLButtonElement>(
      ".work-description .chat-thread-message-actions .chat-thread-message-reply",
    )!;
    expect(descriptionReply).not.toBeNull();
    await act(async () => descriptionReply.click());
    const described = host.querySelector<HTMLElement>(
      ".work-description .chat-message-notes > .chat-thread.is-draft",
    )!;
    expect(described).not.toBeNull();
    await writeAndSend(described, "Is it?");
    const onDescribed = sends[sends.length - 1] as {
      anchor: { message: Record<string, unknown> };
    };
    expect(onDescribed).toMatchObject({
      anchor: {
        work: { item },
        message: { thread: description.id, comment: "c000000000000000" },
      },
      text: "Is it?",
    });
    expect("quote" in onDescribed.anchor.message).toBe(false);
    expect(sends.length).toBe(before + 2);
  });

  test("a thread on the whole of a comment is drawn under it after the threads on its parts, saying so; R on a comment answers the whole of it", async () => {
    const onWhole = thread(
      "b000000000000003",
      {
        work: { item },
        message: { thread: parent.id, comment: "c000000000000002" },
      },
      [comment("c000000000000005", "Claude", "All of it, yes.")],
    );
    data.threads = [...data.threads, onWhole];
    await act(async () => root.render(<Detail />));
    const shown = card(onWhole.id)!;
    expect(shown).not.toBeNull();
    expect(shown.parentElement?.classList.contains("chat-message-notes")).toBe(
      true,
    );
    expect(
      shown.closest("[data-message-id]")?.getAttribute("data-message-id"),
    ).toBe("c000000000000002");
    expect(shown.querySelector(".chat-thread-on")?.textContent).toBe(
      "On this message",
    );
    expect(card(nested.id)!.querySelector(".chat-thread-on")).toBeNull();
    expect(
      card(nested.id)!.compareDocumentPosition(shown) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Not among the item's own threads: in the comment it answers.
    expect(host.querySelectorAll(".work-threads > .chat-thread").length).toBe(
      1,
    );
    // R on the first comment (its stop): a thread on the whole of it.
    list().focus();
    await press("g");
    await press("g");
    expect(focusedKey()).toBe("q:c000000000000000:0");
    await press("j");
    await press("j");
    expect(focusedKey()).toBe("m:c000000000000001");
    await press("R");
    const box = bodyOf("c000000000000001")!.querySelector<HTMLElement>(
      ":scope > .chat-message-notes > .chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    expect(box.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Reply...",
    );
    const before = sends.length;
    await writeAndSend(box, "Looking.");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]).toMatchObject({
      anchor: {
        work: { item },
        message: { thread: parent.id, comment: "c000000000000001" },
      },
      text: "Looking.",
    });
    expect(
      "quote" in
        (sends[sends.length - 1] as { anchor: { message: object } }).anchor
          .message,
    ).toBe(false);
    // R on the description's part: in the description's thread.
    await press("g");
    await press("g");
    expect(focusedKey()).toBe("q:c000000000000000:0");
    await press("R");
    const described = host.querySelector<HTMLElement>(
      ".work-description .chat-message-notes > .chat-thread.is-draft",
    )!;
    expect(described).not.toBeNull();
    await writeAndSend(described, "Still?");
    expect(sends[sends.length - 1]).toMatchObject({
      anchor: {
        work: { item },
        message: { thread: description.id, comment: "c000000000000000" },
      },
      text: "Still?",
    });
    // R on a later part of a long comment answers its thread, as before.
    list().focus();
    await press("G");
    await press("k");
    // The thread on the whole comment, its message: before it, the parts.
    for (let i = 0; i < 8 && focusedKey() !== "q:c000000000000002:1"; i++)
      await press("k");
    expect(focusedKey()).toBe("q:c000000000000002:1");
    await press("R");
    expect(
      card(parent.id)!
        .querySelector(":scope > .chat-thread-editor textarea")
        ?.getAttribute("aria-label"),
    ).toBe("Reply...");
    expect(
      bodyOf("c000000000000002")!.querySelector(
        ":scope > .chat-message-notes > .chat-thread.is-draft",
      ),
    ).toBeNull();
  });

  test("a design doc as the description reads as a document: wrapped lines joined, headings, each part with the comments and questions on it under it", async () => {
    const doc = thread(
      "d000000000000009",
      { work: { item, description: true } },
      [
        comment(
          "c000000000000090",
          "Claude",
          [
            "# Data history",
            "",
            "Keep the stores and write a copy",
            "of what changes into git.",
            "",
            "## Decisions",
            "",
            "- [ ] **D1** Approach. Recommendation: B.",
            "- [ ] **D2** Scope: every area.",
          ].join("\n"),
        ),
      ],
    );
    const onD2 = thread(
      "b000000000000009",
      {
        work: { item },
        message: {
          thread: doc.id,
          comment: "c000000000000090",
          quote: "D2 Scope: every area.",
        },
      },
      [comment("c000000000000091", "you", "Only Work and reviews")],
    );
    // The agent's question on a paragraph (review_add on_comment, quote):
    // the same anchor, drawn under the words it quotes.
    const asked = thread(
      "b000000000000010",
      {
        work: { item },
        message: {
          thread: doc.id,
          comment: "c000000000000090",
          quote: "Keep the stores and write a copy of what changes into git.",
        },
      },
      [
        comment(
          "c000000000000092",
          "Claude",
          "Copy every store, or the board only?",
        ),
      ],
    );
    function DocDetail() {
      const view = useWorkItemView();
      const api = {
        ...data,
        threads: [doc, onD2, asked],
        ...view,
      } as Api;
      return (
        <WorkDescription
          api={api}
          item={item}
          thread={doc}
          onLeave={() => {}}
        />
      );
    }
    const docHost = document.createElement("div");
    document.body.appendChild(docHost);
    const docRoot = createRoot(docHost);
    await act(async () => docRoot.render(<DocDetail />));
    const box = docHost.querySelector<HTMLElement>(".work-description")!;
    expect(box.classList.contains("is-document")).toBe(true);
    expect(box.querySelector("h1")?.textContent).toBe("Data history");
    expect(box.querySelector("h2")?.textContent).toBe("Decisions");
    // The source's wrapping is no line break.
    const paragraph = [...box.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("Keep the stores"),
    )!;
    expect(paragraph.querySelector("br")).toBeNull();
    const stores = paragraph.closest<HTMLElement>(".rc-part")!;
    expect(stores.classList.contains("has-notes")).toBe(true);
    expect(stores.nextElementSibling?.textContent).toContain(
      "Copy every store, or the board only?",
    );
    // Each decision is a part of its own, a + beside it; the comment on D2
    // is drawn under its line.
    const parts = [...box.querySelectorAll<HTMLElement>(".rc-part")];
    const d1 = parts.find((part) => part.textContent?.includes("D1 Approach"))!;
    const d2 = parts.find((part) => part.textContent?.includes("D2 Scope"))!;
    expect(d1).not.toBe(d2);
    expect(d2.querySelector(".rc-part-add")).not.toBeNull();
    expect(d2.classList.contains("has-notes")).toBe(true);
    expect(d2.nextElementSibling?.textContent).toContain(
      "Only Work and reviews",
    );
    await act(async () => docRoot.unmount());
    docHost.remove();
  });

  test("a long design doc reads with the movement keys: j / k part by part, counts, { } heading to heading, zz / zt / zb and the page keys in the board's scroller around it", async () => {
    const doc = thread(
      "d000000000000010",
      { work: { item, description: true } },
      [
        comment(
          "c000000000000100",
          "Claude",
          [
            "# Data history",
            "",
            "Keep the stores.",
            "",
            "Write a copy into git.",
            "",
            "## Decisions",
            "",
            "- [ ] **D1** Approach.",
            "- [ ] **D2** Scope.",
            "",
            "## Later",
            "",
            "More words.",
            "",
            "The end.",
          ].join("\n"),
        ),
      ],
    );
    function LongDetail() {
      const view = useWorkItemView();
      const api = { ...data, threads: [doc], ...view } as Api;
      const listRef = useRef<HTMLDivElement>(null);
      useWorkItemKeys({
        api,
        description: doc,
        getList: () => listRef.current,
        fallback: () => false,
      });
      return (
        <div className="board-body" style={{ overflowY: "auto" }}>
          <div data-work-keys="" tabIndex={-1} ref={listRef}>
            <WorkDescription
              api={api}
              item={item}
              thread={doc}
              onLeave={() => {}}
            />
          </div>
        </div>
      );
    }
    const longHost = document.createElement("div");
    document.body.appendChild(longHost);
    const longRoot = createRoot(longHost);
    await act(async () => longRoot.render(<LongDetail />));
    const scroller = longHost.querySelector<HTMLElement>(".board-body")!;
    const keysList = longHost.querySelector<HTMLElement>("[data-work-keys]")!;
    // The board's body: 200 pixels high; each stop 100 down the page.
    let top = 0;
    Object.defineProperty(scroller, "clientHeight", { value: 200 });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(600, value));
      },
    });
    const stops = () => [
      ...keysList.querySelectorAll<HTMLElement>(
        "[data-part], [data-chat-stop]",
      ),
    ];
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const at = stops().indexOf(this);
      const y = this === scroller ? 0 : at >= 0 ? at * 100 - top : 0;
      return {
        top: y,
        bottom: y + 100,
        height: this === scroller ? 200 : 100,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y,
        toJSON() {},
      } as DOMRect;
    };
    const send = async (key: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        keysList.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
        await wait(10);
      });
    };
    const cursor = () => {
      const stop = keysList.querySelector<HTMLElement>(".rc-part.is-focused");
      return stop ? (stop.textContent ?? "").trim() : null;
    };
    try {
      expect(stops().length).toBe(9);
      keysList.focus();
      // j / k part by part, a count repeating them.
      await send("j");
      expect(cursor()).toBe("Data history");
      await send("j");
      expect(cursor()).toBe("Keep the stores.");
      await send("3");
      await send("j");
      expect(cursor()).toBe("D1 Approach.");
      await send("k");
      expect(cursor()).toBe("Decisions");
      // } and { heading to heading.
      await send("}");
      expect(cursor()).toBe("Later");
      await send("{");
      expect(cursor()).toBe("Decisions");
      await send("{");
      expect(cursor()).toBe("Data history");
      await send("2");
      await send("}");
      expect(cursor()).toBe("Later");
      // gg, G.
      await send("g");
      await send("g");
      expect(cursor()).toBe("Data history");
      await send("G");
      expect(cursor()).toBe("The end.");
      await send("g");
      await send("g");
      // The page keys scroll the board's body around the detail, the
      // cursor moving with the page: Ctrl+D half a page, Ctrl+F a page.
      await send("d", { ctrlKey: true });
      expect(top).toBe(100);
      expect(cursor()).toBe("Keep the stores.");
      await send("f", { ctrlKey: true });
      expect(top).toBe(300);
      expect(cursor()).toBe("Decisions");
      await send("b", { ctrlKey: true });
      expect(top).toBe(100);
      expect(cursor()).toBe("Keep the stores.");
      await send("u", { ctrlKey: true });
      expect(top).toBe(0);
      expect(cursor()).toBe("Data history");
      // At the top, Ctrl+U still moves the cursor up, half a page.
      await send("j");
      await send("j");
      expect(cursor()).toBe("Write a copy into git.");
      await send("u", { ctrlKey: true });
      expect(top).toBe(0);
      expect(cursor()).toBe("Keep the stores.");
      await send("k");
      // zt, zz, zb place the cursor's part in that scroller.
      await send("4");
      await send("j");
      expect(cursor()).toBe("D1 Approach.");
      top = 0;
      await send("z");
      await send("t");
      expect(top).toBe(400);
      await send("z");
      await send("z");
      expect(top).toBe(350);
      await send("z");
      await send("b");
      expect(top).toBe(300);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
      await act(async () => longRoot.unmount());
      longHost.remove();
    }
  });
}
