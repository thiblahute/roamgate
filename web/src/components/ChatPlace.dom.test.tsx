import { expect, mock, test } from "bun:test";
import * as React from "react";
import type { Pane } from "../types";

if (process.env.ROAMGATE_CHAT_PLACE_DOM_TEST !== "1") {
  test("the chat's place in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_CHAT_PLACE_DOM_TEST: "1" },
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
  }, 60_000);
} else {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });

  // What the chat's list is observed by: fired by hand when it is hidden
  // and shown again.
  const observed = new Map<object, Set<Element>>();
  class FakeResizeObserver {
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observed.set(this, new Set());
    }
    observe(target: Element) {
      observed.get(this)?.add(target);
    }
    unobserve(target: Element) {
      observed.get(this)?.delete(target);
    }
    disconnect() {
      observed.delete(this);
    }
  }
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    MutationObserver: browser.MutationObserver,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Text: browser.Text,
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
    Range: browser.Range,
    ResizeObserver: FakeResizeObserver,
    Event: browser.Event,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLInputElement: browser.HTMLInputElement,
    KeyboardEvent: browser.KeyboardEvent,
    CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  // A layout for the chat's list: 400 px high at the top of the screen,
  // each line of text in it 20 px, blocks stacked. Hidden (display: none,
  // the phone's workspaces sheet), it has no size and loses its scroll.
  const LIST = ".agent-history-chat";
  const LIST_HEIGHT = 400;
  let hidden = false;
  const heightOf = (element: Element): number => {
    if (element.classList.contains("agent-history-chat-latest-dock")) return 0;
    if (!element.children.length) return element.textContent?.trim() ? 20 : 0;
    let height = 0;
    for (const child of element.children) height += heightOf(child);
    return height;
  };
  const offsetIn = (element: Element, list: Element): number => {
    if (element === list) return 0;
    const parent = element.parentElement!;
    let top = offsetIn(parent, list);
    for (const sibling of parent.children) {
      if (sibling === element) break;
      top += heightOf(sibling);
    }
    return top;
  };
  const rect = (top: number, height: number, width: number) =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      width,
      height,
      bottom: top + height,
      right: width,
      toJSON: () => ({}),
    }) as DOMRect;
  const original = browser.Element.prototype.getBoundingClientRect;
  browser.Element.prototype.getBoundingClientRect = function (this: Element) {
    const list = this.closest(LIST);
    if (!list) return original.call(this);
    if (hidden) return rect(0, 0, 0);
    if (this === list) return rect(0, LIST_HEIGHT, 300);
    return rect(
      offsetIn(this, list) - (list as HTMLElement).scrollTop,
      heightOf(this),
      300,
    );
  } as never;
  const scrollTops = new WeakMap<Element, number>();
  const isList = (element: Element) => element.matches(LIST);
  Object.defineProperties(browser.HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isList(this) && !hidden ? heightOf(this) : 0;
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isList(this) && !hidden ? LIST_HEIGHT : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        if (!isList(this)) {
          scrollTops.set(this, value);
          return;
        }
        if (hidden) return;
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        scrollTops.set(this, Math.max(0, Math.min(max, value)));
      },
    },
  });

  const at = (n: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const texts = new Map<number, string>();
  const message = (n: number) => ({
    id: `m${n}`,
    role: n % 2 ? "assistant" : "user",
    kind: "message",
    text: texts.get(n) ?? `message number ${n}`,
    sent_at: at(n),
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, index) => message(from + index));
  // Each pane's transcript as the bridge serves it: a test adds to them.
  const transcripts = new Map<
    string,
    { path: string; first: number; last: number; revision: number }
  >([
    [
      "pane-one",
      { path: "/sessions/s1.jsonl", first: 100, last: 140, revision: 1 },
    ],
    [
      "pane-two",
      { path: "/sessions/s2.jsonl", first: 100, last: 140, revision: 1 },
    ],
  ]);
  const olderCalls: Record<string, unknown>[] = [];
  const client = {
    isCurrent: () => true,
    call: async (method: string, params: Record<string, unknown>) => {
      const transcript = transcripts.get(String(params.pane_id));
      if (method === "agent_session.get")
        return {
          status: "ok",
          stats: {},
          session: {
            value: transcript?.path.replace(/^.*\/|\.jsonl$/g, "") ?? "",
          },
        };
      if (method === "agent_history.older") {
        olderCalls.push(params);
        return params.before_id === "m100"
          ? { entries: range(50, 100), has_more: true }
          : { entries: range(0, 50), has_more: false };
      }
      if (method === "agent_history.get" && transcript)
        return {
          status: "ok",
          agent: "claude",
          pane_id: params.pane_id,
          workspace_id: "workspace",
          tab_id: "tab",
          path: transcript.path,
          updated_at: at(transcript.last),
          history_version: 2,
          mode: "snapshot",
          cursor: {
            epoch: transcript.path,
            revision: transcript.revision,
          },
          window_limit: 200,
          entries: range(transcript.first, transcript.last),
        };
      return Promise.reject(new Error("pane closed"));
    },
  };
  mock.module("../useConnectionClient", () => ({
    useConnectionClient: () => client,
    useConnectionReady: () => true,
    connectionClientScopeKey: () => "test",
  }));
  const { initializeLayoutPreferences } = await import("../layoutPreferences");
  initializeLayoutPreferences();
  browser.localStorage.setItem("reviewPrefs", JSON.stringify({ vim: false }));
  const { store } = await import("../store");
  const connectionId = store.get().activeConnectionId;
  const { chatPlaceKey } = await import("../chatPlace");
  const { rememberReviewSnapshot } = await import("../review");
  const { AgentHistoryDrawer } = await import("./AgentHistoryDrawer");
  const { createRoot } = await import("react-dom/client");
  const { EditorView } = await import("@codemirror/view");

  const paneOf = (id: string): Pane => ({
    pane_id: id,
    terminal_id: `term-${id}`,
    workspace_id: "workspace",
    tab_id: "tab",
    agent: "claude",
    agent_status: "idle",
    focused: true,
    revision: 1,
  });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const settle = () =>
    React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  /** The pane's chat, as the pane shows it in place of its terminal. */
  const show = async (id: string | null) => {
    await React.act(async () => {
      root.render(
        id ? (
          <AgentHistoryDrawer
            key={id}
            pane={paneOf(id)}
            open
            embedded
            paneChat={{
              prompt: null,
              onKeys: () => {},
              onShowTerminal: () => {},
              readScreen: () => [],
            }}
            onOpenChange={() => {}}
          />
        ) : null,
      );
    });
    await settle();
    await settle();
    if (id) await resized();
  };
  const list = () => container.querySelector<HTMLElement>(LIST)!;
  const bubble = (id: string) =>
    list().querySelector<HTMLElement>(
      `:scope > .agent-history-chat-content > [data-bubble-id="${id}"]`,
    )!;
  // What the browser does as the list's content grows or it is shown.
  const resized = () =>
    React.act(async () => {
      for (const [observer, targets] of observed)
        if (targets.has(list())) (observer as FakeResizeObserver).callback();
    });
  const topOf = (element: Element) => element.getBoundingClientRect().top;
  /** The reader scrolls so the element's top is `offset` from the view's. */
  const scrollTo = async (element: Element, offset: number) => {
    if (!element.closest(LIST))
      throw new Error(`not in the list: ${element.outerHTML.slice(0, 200)}`);
    await React.act(async () => {
      list().scrollTop = offsetIn(element, list()) - offset;
      list().dispatchEvent(new window.Event("wheel"));
      list().dispatchEvent(new window.Event("scroll"));
    });
    await settle();
  };
  const atEnd = () =>
    list().scrollTop === list().scrollHeight - list().clientHeight;
  const pill = () =>
    container.querySelector<HTMLButtonElement>(".agent-history-chat-latest");
  const add = (pane: string, count: number) => {
    const transcript = transcripts.get(pane)!;
    transcript.last += count;
    transcript.revision += 1;
  };

  test("a reload comes back where the reader was", async () => {
    // What a tab kept before it reloaded.
    sessionStorage.setItem(
      "roamgate:chatPlaces:v1",
      JSON.stringify([
        [
          chatPlaceKey(connectionId, "pane-one", "/sessions/s1.jsonl"),
          { anchor: { id: "m115", offset: -7, at: at(115) } },
        ],
      ]),
    );
    await show("pane-one");
    expect(bubble("m139")).not.toBeNull();
    expect(topOf(bubble("m115"))).toBe(-7);
    await show(null);
  });

  test("switching to another pane and back keeps each chat's place, new messages under it", async () => {
    await show("pane-one");
    // Opened again at the place kept by the reload test: the reader goes
    // on reading higher up.
    await scrollTo(bubble("m120"), -12);
    expect(topOf(bubble("m120"))).toBe(-12);
    expect(atEnd()).toBe(false);

    // Another pane: its own chat, read at its own place.
    await show("pane-two");
    expect(atEnd()).toBe(true);
    await scrollTo(bubble("m110"), 30);

    // The agent of the first pane answers meanwhile.
    add("pane-one", 6);
    await show("pane-one");
    expect(bubble("m145")).not.toBeNull();
    expect(topOf(bubble("m120"))).toBe(-12);
    // What came while away is said, and the pill goes to it.
    expect(pill()?.textContent).toBe("6 new messages");

    await show("pane-two");
    expect(topOf(bubble("m110"))).toBe(30);
    expect(pill()).toBeNull();

    // Back again: the place holds, and the pill goes to the end.
    await show("pane-one");
    expect(topOf(bubble("m120"))).toBe(-12);
    await React.act(async () => pill()!.click());
    expect(atEnd()).toBe(true);
    expect(pill()).toBeNull();
    await show(null);
  });

  test("at the end, coming back follows the new end", async () => {
    await show("pane-one");
    expect(atEnd()).toBe(true);
    add("pane-one", 3);
    await show("pane-two");
    await show("pane-one");
    expect(bubble("m148")).not.toBeNull();
    expect(atEnd()).toBe(true);
    expect(pill()).toBeNull();
    await show(null);
  });

  test("a place among older messages reads back far enough to come back", async () => {
    await show("pane-one");
    // Scrolled to the top: a page of older messages.
    await React.act(async () => {
      list().scrollTop = 0;
      list().dispatchEvent(new window.Event("scroll"));
    });
    await settle();
    expect(olderCalls).toHaveLength(1);
    await scrollTo(bubble("m60"), -30);
    expect(topOf(bubble("m60"))).toBe(-30);

    await show("pane-two");
    add("pane-one", 2);
    await show("pane-one");
    // Read again from the window, then the page before it.
    expect(olderCalls).toHaveLength(2);
    expect(olderCalls[1]!.before_id).toBe("m100");
    expect(topOf(bubble("m60"))).toBe(-30);
    expect(
      [...list().querySelectorAll("[data-bubble-id]")]
        .map((element) => element.getAttribute("data-bubble-id"))
        .slice(-3),
    ).toEqual(["m148", "m149", "m150"]);
    await show(null);
  });

  test("hidden and shown again (the phone's workspaces sheet), the place comes back", async () => {
    await show("pane-one");
    await scrollTo(bubble("m130"), -5);
    hidden = true;
    // Hidden, it loses its scroll.
    scrollTops.set(list(), 0);
    await resized();
    // New messages while hidden.
    add("pane-one", 1);
    await settle();
    hidden = false;
    // Shown again, the list starts from its top.
    expect(list().scrollTop).toBe(0);
    await resized();
    expect(topOf(bubble("m130"))).toBe(-5);
    await show(null);
  });

  test("an open thread comes back open, with its reply and where it was", async () => {
    texts.set(131, "First part of the answer.\n\nSecond part of the answer.");
    const thread = {
      id: "t1",
      sessionId: "rs1",
      kind: "discussion",
      anchor: {
        chat: { entry: "m131", quote: "First part of the answer." },
      },
      comments: [
        {
          id: "c1",
          author: "you",
          body: "Why the first part?",
          createdAt: at(142),
          updatedAt: at(142),
        },
      ],
      resolved: false,
      createdAt: at(142),
      updatedAt: at(142),
    };
    const review = (threads: unknown[]) =>
      rememberReviewSnapshot({
        session: {
          id: "rs1",
          connectionId,
          workspaceId: "workspace",
          root: "/repo",
          title: "Chat with claude",
          target: { kind: "chat", chat: "s1" },
          gitlab: false,
          summary: "",
          agent: {},
          createdAt: at(142),
          updatedAt: at(142),
        },
        threads,
      } as never);
    review([thread]);
    await show("pane-one");
    const threadElement = () =>
      container.querySelector<HTMLElement>('.chat-thread[data-thread-id="t1"]');
    expect(threadElement()?.textContent).toContain("Why the first part?");
    const reply = [...threadElement()!.querySelectorAll("button")].find(
      (button) => button.textContent === "Reply",
    )!;
    await React.act(async () => reply.click());
    for (
      let i = 0;
      i < 50 && !threadElement()?.querySelector(".cm-content");
      i++
    )
      await settle();
    const view = EditorView.findFromDOM(
      threadElement()!.querySelector<HTMLElement>(".cm-content")!,
    )!;
    await React.act(async () =>
      view.dispatch({ changes: { from: 0, insert: "Because it" } }),
    );
    // Reading on under the thread, its second part at the top.
    const second = () =>
      [...bubble("m131").querySelectorAll<HTMLElement>('[data-part="1"]')].find(
        (part) => !part.closest(".chat-thread"),
      )!;
    await scrollTo(second(), -4);
    expect(topOf(second())).toBe(-4);

    // Away, the agent answers in the thread (above the place), and on.
    await show("pane-two");
    review([
      {
        ...thread,
        comments: [
          ...thread.comments,
          {
            id: "c2",
            author: "claude",
            body: "It sets up the rest.\n\nAnd says why.",
            createdAt: at(150),
            updatedAt: at(150),
          },
        ],
      },
    ]);
    add("pane-one", 2);
    await show("pane-one");
    for (
      let i = 0;
      i < 50 && !threadElement()?.querySelector(".cm-content");
      i++
    )
      await settle();
    // The box's editor, loaded after the chat, grew it above the place.
    await resized();
    expect(threadElement()?.textContent).toContain("It sets up the rest.");
    const kept = EditorView.findFromDOM(
      threadElement()!.querySelector<HTMLElement>(".cm-content")!,
    )!;
    expect(kept.state.doc.toString()).toBe("Because it");
    // Not focused: the reader's place is not moved to it.
    expect(kept.hasFocus).toBe(false);
    expect(topOf(second())).toBe(-4);
    await show(null);
  });

  test("a pane whose session changed starts at its end", async () => {
    await show("pane-one");
    await scrollTo(bubble("m120"), 0);
    await show("pane-two");
    const transcript = transcripts.get("pane-one")!;
    transcript.path = "/sessions/s3.jsonl";
    transcript.revision += 1;
    await show("pane-one");
    await settle();
    expect(atEnd()).toBe(true);
    await show(null);
    root.unmount();
    root = createRoot(container);
    await browser.happyDOM.close();
  });
}
