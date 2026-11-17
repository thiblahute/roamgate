import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "threads panel in an isolated DOM runtime",
    "ROAMGATE_THREADS_PANEL_DOM_TEST",
    20_000,
  )
) {
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
    HTMLInputElement: browser.HTMLInputElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    CSS: { escape: (value: string) => value },
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

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SHOW_RESOLVED_KEY, ThreadsPanel } = await import("./ThreadsPanel");
  type Thread = { id: string; resolved: boolean };

  /** Every scrollIntoView made, by the thread it was on. */
  const scrolled: string[] = [];
  browser.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(
      this.closest("[data-panel-thread]")?.getAttribute("data-panel-thread") ??
        "?",
    );
  };

  /** 15 threads, the last three resolved, as a review gives them. */
  const fifteen = (): Thread[] =>
    Array.from({ length: 15 }, (_, i) => ({
      id: `t${i + 1}`,
      resolved: i >= 12,
    }));

  /**
   * The panel as a review draws it: new thread objects on every render,
   * resolving one through the parent.
   */
  async function mount(initial: Thread[]) {
    let state = initial;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
      root.render(
        <ThreadsPanel
          threads={[...state]
            .sort((a, b) => Number(a.resolved) - Number(b.resolved))
            .map((thread) => ({
              id: thread.id,
              resolved: thread.resolved,
              where: `file.ts:${thread.id}`,
              comments: [{ id: `${thread.id}c`, author: "you", body: "hi" }],
              canReply: true,
            }))}
          onClose={() => {}}
          onGo={() => {}}
          onResolve={(id) => {
            state = state.map((thread) =>
              thread.id === id
                ? { ...thread, resolved: !thread.resolved }
                : thread,
            );
            render();
          }}
          onReply={() => {}}
          renderBody={(_, body) => body}
        />,
      );
    await act(async () => render());
    const list = host.querySelector<HTMLElement>(".threads-panel-list")!;
    const ids = () =>
      [...host.querySelectorAll("[data-panel-thread]")].map((node) =>
        node.getAttribute("data-panel-thread"),
      );
    const selected = () =>
      host
        .querySelector(".threads-panel-item.is-selected")
        ?.getAttribute("data-panel-thread");
    const key = (keyName: string) =>
      act(async () => {
        host
          .querySelector(".threads-panel")!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: keyName, bubbles: true }),
          );
      });
    const resolveButton = (id: string) =>
      [
        ...host.querySelectorAll<HTMLButtonElement>(
          `[data-panel-thread="${id}"] .threads-panel-actions button`,
        ),
      ].find((button) => /Resolve|Reopen/.test(button.textContent ?? ""))!;
    return {
      host,
      list,
      ids,
      selected,
      key,
      resolveButton,
      rerender: () => act(async () => render()),
      unmount: () => act(async () => root.unmount()),
    };
  }

  test("resolving one mid-list keeps the scroll and selects the next open one", async () => {
    localStorage.clear();
    const panel = await mount(fifteen());
    // Resolved ones are hidden by default, with their count.
    expect(panel.ids()).toEqual(
      Array.from({ length: 12 }, (_, i) => `t${i + 1}`),
    );
    for (let i = 0; i < 6; i++) await panel.key("j");
    expect(panel.selected()).toBe("t7");
    panel.list.scrollTop = 120;
    scrolled.length = 0;

    await act(async () => panel.resolveButton("t7").click());

    expect(panel.list.scrollTop).toBe(120);
    expect(scrolled).toEqual([]);
    expect(panel.ids()).not.toContain("t7");
    expect(panel.selected()).toBe("t8");

    // The user scrolls up; new renders (answers coming in) leave it there.
    panel.list.scrollTop = 0;
    await panel.rerender();
    await panel.rerender();
    expect(panel.list.scrollTop).toBe(0);
    expect(scrolled).toEqual([]);

    // r on the keyboard resolves the selected one the same way.
    await panel.key("r");
    expect(panel.selected()).toBe("t9");
    expect(scrolled).toEqual([]);

    // A move by key still brings the selection into view.
    await panel.key("j");
    expect(scrolled).toEqual(["t10"]);
    await panel.unmount();
  });

  test("open ones come first; resolved ones are after them, folded", async () => {
    localStorage.clear();
    localStorage.setItem(`roamgate:${SHOW_RESOLVED_KEY}`, "1");
    const mixed = [
      { id: "a", resolved: true },
      { id: "b", resolved: false },
      { id: "c", resolved: true },
      { id: "d", resolved: false },
    ];
    const panel = await mount(mixed);
    expect(panel.ids()).toEqual(["b", "d", "a", "c"]);
    const group = panel.host.querySelector(".threads-panel-group");
    expect(group?.textContent).toBe("2 resolved, hide");
    expect(group?.nextElementSibling?.getAttribute("data-panel-thread")).toBe(
      "a",
    );
    expect(panel.host.querySelectorAll(".threads-panel-message")).toHaveLength(
      0,
    );

    // Resolving one shown with the resolved ones: it joins them, the
    // selection stays on the open ones and nothing scrolls.
    scrolled.length = 0;
    panel.list.scrollTop = 40;
    await act(async () => panel.resolveButton("b").click());
    expect(panel.ids()).toEqual(["d", "a", "b", "c"]);
    expect(panel.selected()).toBe("d");
    expect(panel.list.scrollTop).toBe(40);
    expect(scrolled).toEqual([]);
    await panel.unmount();
  });

  test("resolved ones are hidden by default, counted, and shown on demand", async () => {
    localStorage.clear();
    const panel = await mount(fifteen());
    expect(panel.ids()).toHaveLength(12);
    expect(
      panel.host.querySelector(".threads-panel-head .threads-panel-count")
        ?.textContent,
    ).toBe("12 open · 3 resolved, show");
    const show = panel.host.querySelector<HTMLButtonElement>(
      ".threads-panel-list .threads-panel-resolved-toggle",
    );
    expect(show?.textContent).toBe("3 resolved, show");

    await act(async () => show!.click());
    expect(panel.ids()).toHaveLength(15);
    expect(localStorage.getItem(`roamgate:${SHOW_RESOLVED_KEY}`)).toBe("1");

    // H hides them again, and the choice is kept for the next panel.
    await panel.key("H");
    expect(panel.ids()).toHaveLength(12);
    expect(localStorage.getItem(`roamgate:${SHOW_RESOLVED_KEY}`)).toBe("0");
    await panel.unmount();

    localStorage.setItem(`roamgate:${SHOW_RESOLVED_KEY}`, "1");
    const again = await mount(fifteen());
    expect(again.ids()).toHaveLength(15);
    await again.unmount();
  });
}
