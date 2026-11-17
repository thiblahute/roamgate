import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "chat threads on a phone in an isolated DOM runtime",
    "ROAMGATE_CHAT_THREADS_TOUCH_DOM_TEST",
    20_000,
  )
) {
  const { Window } = await import("happy-dom");
  // A phone held upright.
  const browser = new Window({
    url: "http://localhost/",
    width: 393,
    height: 852,
  });
  let coarse = true;
  browser.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)" && coarse,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof browser.matchMedia;
  // What Chrome reports as the keyboard opens: the visual viewport resizes.
  const visualViewport = new browser.EventTarget();
  Object.defineProperty(browser, "visualViewport", {
    value: visualViewport,
    configurable: true,
  });
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

  const { mock } = await import("bun:test");
  const review = {
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
      createdAt: "2026-11-12",
      updatedAt: "2026-11-12",
    },
    threads: [],
  };
  mock.module("../review", () => ({
    reviewCall: async (_connection: string, method: string) =>
      method === "review.get" ? review : {},
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({
      sessions: new Map([["s1", review]]),
      openRequest: null,
    }),
  }));

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** A chat with one message, in the provider: its host and root. */
  async function chat() {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ChatThreadsProvider } = await import("./ChatThreads");
    const entry = { id: "e1", role: "assistant", text: "Words to quote" };
    const host = document.createElement("div");
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
          <div className="agent-history-chat" data-entry-id="e1">
            <div className="chat-review">
              <p className="rc-part" data-part="0">
                Words to quote
              </p>
            </div>
            <div className="chat-thread is-draft">
              <div className="chat-thread-editor">
                <div className="cm-content" tabIndex={-1} />
              </div>
            </div>
          </div>
        </ChatThreadsProvider>,
      ),
    );
    await act(settle);
    return { act, host, root };
  }

  /** Words selected whose last line ends `bottom` px down the screen. */
  async function select(host: HTMLElement, bottom: number) {
    const words = host.querySelector("[data-part]")!.firstChild!;
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 5);
    range.getBoundingClientRect = () =>
      ({ left: 16, top: bottom - 20, bottom, right: 80 }) as DOMRect;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    // The offer waits for the selection to settle.
    await new Promise((resolve) => setTimeout(resolve, 260));
  }

  const offer = () =>
    document.querySelector<HTMLElement>(".chat-thread-select");

  test("on a phone, Comment on a selection goes below Android's selection handles", async () => {
    coarse = true;
    const { act, host, root } = await chat();
    await act(async () => select(host, 400));
    // Clear of the handles that hang under the selection's ends.
    expect(offer()?.style.top).toBe("432px");
    expect(offer()?.style.left).toBe("16px");
    // Near the bottom: a 44px button still fits on the screen.
    await act(async () => select(host, 840));
    expect(offer()?.style.top).toBe(`${852 - 52}px`);
    await act(async () => root.unmount());
    host.remove();
  });

  test("with a mouse, Comment stays right under the selection", async () => {
    coarse = false;
    const { act, host, root } = await chat();
    await act(async () => select(host, 400));
    expect(offer()?.style.top).toBe("408px");
    await act(async () => select(host, 840));
    expect(offer()?.style.top).toBe(`${852 - 44}px`);
    await act(async () => root.unmount());
    host.remove();
  });
}
