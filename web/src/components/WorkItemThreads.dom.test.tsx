import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * An item's threads in its detail: a thread on a comment of another thread
 * is drawn under that comment, under the words it quotes; Reply to this
 * under a comment opens a box for a thread on it; words selected in a
 * comment offer Comment, a thread on it quoting them.
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
  const React = await import("react");
  const { act } = React;
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
  const { WorkItemThreads } = await import("./WorkItemThreads");
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
  const sends: Record<string, unknown>[] = [];
  const api: Api = {
    snapshot: undefined,
    threads: [parent, nested],
    open: 2,
    waiting: null,
    write: async () => true,
    addImage: async () => "",
    send: async (next) => {
      sends.push(next);
      return true;
    },
    pendingById: new Map(),
    undelivered: new Set(),
    error: "",
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <WorkItemThreads
        item={item}
        api={api}
        description={null}
        compose={null}
        onComposeDone={() => {}}
        onLeave={() => {}}
      />,
    ),
  );
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const card = (id: string) =>
    host.querySelector<HTMLElement>(`.chat-thread[data-thread-id="${id}"]`);
  const bodyOf = (id: string) =>
    host.querySelector<HTMLElement>(
      `.chat-thread-body[data-message-id="${id}"]`,
    );
  const messageOf = (id: string) =>
    host.querySelector<HTMLElement>(`[data-chat-stop="m:${id}"]`)!;
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

  test("a thread on a comment is drawn under that comment, under the words it quotes, with its own buttons", () => {
    const shown = card(nested.id)!;
    expect(shown).not.toBeNull();
    // In the parent's second message, not beside the parent.
    expect(host.querySelectorAll(".work-threads > .chat-thread").length).toBe(
      1,
    );
    expect(
      shown.closest(".chat-thread-body")?.getAttribute("data-message-id"),
    ).toBe("c000000000000002");
    expect(shown.parentElement?.classList.contains("rc-part-notes")).toBe(true);
    // Right under the part it quotes: the second paragraph, marked.
    const quoted = shown.parentElement?.previousElementSibling;
    expect(quoted?.classList.contains("has-notes")).toBe(true);
    expect(quoted?.textContent).toContain("The words go with it.");
    expect(quoted?.textContent).not.toContain("Done: the box opens.");
    expect(shown.textContent).toContain("Which words?");
    expect(
      [...shown.querySelectorAll(".chat-thread-bar button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Reply", "Resolve", "Fold", "Delete"]);
  });

  test("Reply to this under a comment opens a box for a thread on it, sent on that comment", async () => {
    const message = messageOf("c000000000000002");
    const reply = message.querySelector<HTMLButtonElement>(
      ":scope > .work-thread-message-bar > button",
    )!;
    expect(reply.textContent).toBe("Reply to this");
    await act(async () => reply.click());
    const box = bodyOf("c000000000000002")!.querySelector<HTMLElement>(
      ".chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    // Under the whole comment: after its last part (and the thread there).
    const siblings = [...box.parentElement!.parentElement!.children];
    const partBefore = siblings
      .slice(0, siblings.indexOf(box.parentElement!))
      .reverse()
      .find((each) => each.classList.contains("rc-part"));
    expect(partBefore?.textContent).toContain("The words go with it.");
    expect(partBefore?.textContent).not.toContain("Done: the box opens.");
    expect(box.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Reply to this comment...",
    );
    // Its button goes while the box is open.
    expect(message.querySelector(":scope > .work-thread-message-bar")).toBe(
      null,
    );
    const before = sends.length;
    await writeAndSend(box, "Thanks!");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]).toMatchObject({
      kind: "discussion",
      anchor: {
        work: { item },
        message: { thread: parent.id, comment: "c000000000000002" },
      },
      text: "Thanks!",
    });
    expect(
      (sends[sends.length - 1]!.anchor as any).message.quote,
    ).toBeUndefined();
    expect(bodyOf("c000000000000002")!.querySelector(".is-draft")).toBe(null);
  });

  test("words selected in a comment offer Comment: a thread on it quoting them", async () => {
    const body = bodyOf("c000000000000001")!;
    const words = (function first(node: Node): Text | null {
      if (node.nodeType === 3 && node.textContent?.trim()) return node as Text;
      for (const child of node.childNodes) {
        const found = first(child);
        if (found) return found;
      }
      return null;
    })(body)!;
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
    expect(box.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Comment on these words...",
    );
    const before = sends.length;
    await writeAndSend(box, "Which box?");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]).toMatchObject({
      kind: "discussion",
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
  });

  test("words selected in a nested thread's message are that thread's", async () => {
    const { selectedWords } = await import("./WorkItemThreads");
    const body = bodyOf("c000000000000003")!;
    const words = (function first(node: Node): Text | null {
      if (node.nodeType === 3 && node.textContent?.trim()) return node as Text;
      for (const child of node.childNodes) {
        const found = first(child);
        if (found) return found;
      }
      return null;
    })(body)!;
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 5);
    range.getBoundingClientRect = () =>
      ({ left: 40, top: 100, bottom: 120, right: 120 }) as DOMRect;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selectedWords(host)).toMatchObject({
      thread: nested.id,
      comment: "c000000000000003",
      quote: "Which",
    });
    // Not for words outside the threads.
    expect(selectedWords(document.createElement("div"))).toBe(null);
    selection.removeAllRanges();
  });
}
