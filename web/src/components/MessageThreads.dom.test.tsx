import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * Messages with threads on their parts, as every view draws them
 * (MessageThreads): Reply on a thread's message opens a thread on the
 * whole message, quoting nothing, drawn under the message after the
 * threads on its parts with a head saying so; R on the message's stop or
 * its first part does the same.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "threads on the whole of a message, in an isolated DOM runtime",
    "ROAMGATE_MESSAGE_THREADS_DOM_TEST",
    40_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/", width: 1280 });
  (HTMLElement.prototype as any).scrollIntoView = () => {};
  const React = await import("react");
  const { act, useRef, useState } = React;
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
  const {
    MessageThread,
    messageStopKey,
    messageStops,
    onWholeMessage,
    replyOnMessage,
    splitMessageThreads,
  } = await import("./MessageThreads");
  type Scope = Parameters<typeof MessageThread>[0]["scope"];
  type Part = Scope["partDraft"];

  const at = "2026-11-21T10:00:01.000Z";
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
  const onPart = thread(
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
  const onWhole = thread(
    "b000000000000002",
    {
      work: { item },
      message: { thread: parent.id, comment: "c000000000000002" },
    },
    [comment("c000000000000004", "you", "All of it.")],
  );
  const sends: Record<string, unknown>[] = [];
  let setDraft: (part: Part) => void = () => {};
  let drafts: Part[] = [];
  /** A thread drawn as a view draws it, with what its threads share. */
  function List() {
    const [partDraft, setPartDraftState] = useState<Part>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const setPartDraft = (part: Part) => {
      drafts.push(part);
      setPartDraftState(part);
    };
    setDraft = setPartDraft;
    // Both on the second message: on a part of it, on the whole of it.
    const byMessage = new Map([["c000000000000002", [onPart, onWhole]]]);
    const scope: Scope = {
      byMessage,
      cursor,
      setCursor,
      flipped: new Set(),
      toggleFold: () => {},
      replying: null,
      setReplying: () => {},
      partDraft,
      setPartDraft,
      partAnchor: (part) => ({ work: { item }, message: part }),
      partPlaceholder: "Comment on this part...",
      pendingById: new Map(),
      write: async () => true,
      send: async (next) => {
        sends.push(next);
        return true;
      },
      box: () => ({}),
      onLeave: () => {},
    };
    return (
      <div className="chat-review" data-list="" ref={listRef}>
        <MessageThread thread={parent} scope={scope} />
      </div>
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<List />));
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const list = () => host.querySelector<HTMLElement>("[data-list]")!;
  const card = (id: string) =>
    host.querySelector<HTMLElement>(`.chat-thread[data-thread-id="${id}"]`);
  const bodyOf = (id: string) =>
    host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const stopOf = (key: string) =>
    host.querySelector<HTMLElement>(`[data-chat-stop="${key}"]`)!;
  const follows = (first: Element, second: Element) =>
    !!(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    );
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

  test("a thread on the whole of a message is drawn under it, after the threads on its parts, its head saying so; every message offers Reply", () => {
    expect(onWholeMessage(onWhole)).toBe(true);
    expect(onWholeMessage(onPart)).toBe(false);
    expect(onWholeMessage(parent)).toBe(false);
    expect(splitMessageThreads([onPart, onWhole])).toEqual({
      onParts: [onPart],
      onMessage: [onWhole],
    });
    const whole = card(onWhole.id)!;
    expect(whole).not.toBeNull();
    expect(whole.parentElement?.classList.contains("chat-message-notes")).toBe(
      true,
    );
    expect(
      whole.closest("[data-message-id]")?.getAttribute("data-message-id"),
    ).toBe("c000000000000002");
    expect(whole.querySelector(".chat-thread-on")?.textContent).toBe(
      "On this message",
    );
    // After the message's parts and the thread on one of them.
    const part = card(onPart.id)!;
    expect(part.parentElement?.classList.contains("rc-part-notes")).toBe(true);
    expect(part.querySelector(".chat-thread-on")).toBeNull();
    expect(follows(part, whole)).toBe(true);
    const parts = bodyOf("c000000000000002")!.querySelectorAll(
      ":scope > .rc-text > .rc-part",
    );
    expect(parts.length).toBe(2);
    expect(follows(parts[1]!, whole)).toBe(true);
    // Reply in every message's author row, the nested threads' too.
    for (const id of [
      "c000000000000001",
      "c000000000000002",
      "c000000000000003",
      "c000000000000004",
    ]) {
      const head = bodyOf(id)!.previousElementSibling!;
      expect(head.classList.contains("chat-thread-message-head")).toBe(true);
      expect(head.querySelector(".chat-thread-author")).not.toBeNull();
      expect(
        head.querySelector(".chat-thread-message-reply")?.textContent,
      ).toBe("Reply");
    }
    // The author's name reads alone, as before.
    expect(
      bodyOf("c000000000000001")!.previousElementSibling!.querySelector(
        ".chat-thread-author",
      )?.textContent,
    ).toBe("You");
    // The keys' stops: the parts of the long message, then the threads on
    // it, the one on the whole message last (its message in one part).
    expect(messageStops(list()).map((stop) => messageStopKey(stop))).toEqual([
      "m:c000000000000001",
      "m:c000000000000002",
      "q:c000000000000002:0",
      "q:c000000000000002:1",
      "m:c000000000000003",
      "m:c000000000000004",
    ]);
  });

  test("Reply on a message opens a box under it; sent, a thread on the whole message, quoting nothing", async () => {
    const message = bodyOf("c000000000000001")!.closest<HTMLElement>(
      ".chat-thread-message",
    )!;
    const reply = message.querySelector<HTMLButtonElement>(
      ":scope > .chat-thread-message-head > .chat-thread-message-reply",
    )!;
    drafts = [];
    await act(async () => reply.click());
    expect(drafts).toEqual([
      { thread: parent.id, comment: "c000000000000001" },
    ]);
    const box = bodyOf("c000000000000001")!.querySelector<HTMLElement>(
      ":scope > .chat-message-notes > .chat-thread.is-draft",
    )!;
    expect(box).not.toBeNull();
    expect(box.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Reply...",
    );
    // Not under a part: after the message's text.
    expect(bodyOf("c000000000000001")!.querySelector(".rc-part-notes")).toBe(
      null,
    );
    const before = sends.length;
    await writeAndSend(box, "Will do.");
    expect(sends.length).toBe(before + 1);
    const sent = sends[sends.length - 1] as {
      anchor: { message: Record<string, unknown> };
    };
    expect(sent).toMatchObject({
      kind: "discussion",
      anchor: {
        work: { item },
        message: { thread: parent.id, comment: "c000000000000001" },
      },
      text: "Will do.",
    });
    expect("quote" in sent.anchor.message).toBe(false);
    expect(bodyOf("c000000000000001")!.querySelector(".is-draft")).toBeNull();
  });

  test("R on a message's stop or its first part answers the whole message; on a later part it goes on to the thread", () => {
    drafts = [];
    const draft = (part: Part) => setDraft(part);
    expect(
      replyOnMessage(list(), stopOf("m:c000000000000002"), parent, draft),
    ).toBe(true);
    expect(drafts).toEqual([
      { thread: parent.id, comment: "c000000000000002" },
    ]);
    const parts = bodyOf("c000000000000002")!.querySelectorAll<HTMLElement>(
      ":scope > .rc-text > .rc-part",
    );
    expect(replyOnMessage(list(), parts[1], parent, draft)).toBe(false);
    expect(replyOnMessage(list(), parts[0], parent, draft)).toBe(true);
    expect(drafts[1]).toEqual({
      thread: parent.id,
      comment: "c000000000000002",
    });
    // A nested thread's message: a thread on it, in that thread.
    expect(
      replyOnMessage(list(), stopOf("m:c000000000000004"), onWhole, draft),
    ).toBe(true);
    expect(drafts[2]).toEqual({
      thread: onWhole.id,
      comment: "c000000000000004",
    });
    // Nowhere, or with no thread to put it in: the key goes on.
    expect(replyOnMessage(list(), undefined, parent, draft)).toBe(false);
    expect(
      replyOnMessage(list(), stopOf("m:c000000000000001"), undefined, draft),
    ).toBe(false);
    // Unless the list says which thread a message is in (a description).
    expect(
      replyOnMessage(
        list(),
        stopOf("m:c000000000000001"),
        undefined,
        draft,
        () => parent.id,
      ),
    ).toBe(true);
    expect(drafts.length).toBe(4);
  });
}
