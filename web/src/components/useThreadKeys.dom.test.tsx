import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "thread keys in an isolated DOM runtime",
    "ROAMGATE_THREAD_KEYS_DOM_TEST",
    20_000,
  )
) {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    Event: browser.Event,
    FocusEvent: browser.FocusEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useThreadKeys } = await import("./useThreadKeys");

  /** Lays an element out at `top` (in the viewport) with a height. */
  const layout = (element: HTMLElement, top: number, height: number) => {
    element.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(element, "clientHeight", {
      configurable: true,
      get: () => height,
    });
  };

  // The markup says overflow-y: happy-dom computes no longhand from the
  // overflow shorthand the stylesheets use.
  /**
   * A list with the keys whose stops are in `scroller`: the list itself
   * (a chat), or a scroller inside a list that clips (the Files preview).
   */
  const mount = async (
    markup: string,
    extra: Partial<Parameters<typeof useThreadKeys>[2]> = {},
  ) => {
    const host = document.createElement("div");
    document.body.append(host);
    host.innerHTML = markup;
    const list = host.querySelector<HTMLElement>(".list")!;
    let cursor: string | null = "s2";
    function Keys() {
      useThreadKeys(() => list, list, {
        stops: (root) =>
          Array.from(root.querySelectorAll<HTMLElement>("[data-stop]")),
        keyOf: (stop) => stop.dataset.stop ?? "",
        cursor,
        setCursor: (key) => {
          cursor = key;
        },
        threadsById: new Map(),
        flipped: new Set(),
        openOnly: false,
        toggleFold: () => {},
        goToThread: () => {},
        openOverview: () => {},
        jumpUnresolved: () => {},
        toggleOpenOnly: () => {},
        resolve: () => {},
        remove: () => {},
        reply: () => {},
        comment: () => false,
        ...extra,
      });
      return null;
    }
    const keysHost = document.createElement("div");
    host.append(keysHost);
    const root = createRoot(keysHost);
    await act(async () => root.render(<Keys />));
    const keys = (...names: string[]) => {
      for (const name of names)
        list.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
    };
    return { host, list, root, keys };
  };

  test("zz / zt / zb place in the Files preview's scroller, not the box that clips it", async () => {
    const { host, list, root, keys } = await mount(`
      <section class="page" style="overflow-y: hidden">
        <div class="list" style="display: flex; flex-direction: column; overflow-y: hidden">
          <div class="scroller" style="overflow-y: auto">
            <p data-stop="s1">One</p>
            <pre style="overflow-y: auto"><code data-stop="s2">Two</code></pre>
            <p data-stop="s3">Three</p>
          </div>
        </div>
      </section>`);
    const page = host.querySelector<HTMLElement>(".page")!;
    const scroller = host.querySelector<HTMLElement>(".scroller")!;
    layout(list, 100, 400);
    layout(scroller, 100, 400);
    const stop = host.querySelector<HTMLElement>('[data-stop="s2"]')!;
    let scrolled = false;
    stop.scrollIntoView = () => {
      scrolled = true;
    };
    // 300px down the scroller's view, 20px high.
    layout(stop, 400, 20);
    scroller.scrollTop = 1000;

    keys("z", "z");
    // Its middle: 300 - (400 - 20) / 2 = 110 further.
    expect(scroller.scrollTop).toBe(1110);
    // The room below goes in the scroller, the box keeps its layout.
    expect(scroller.style.paddingBottom).toBe("400px");
    expect(list.style.paddingBottom).toBe("");
    expect(list.scrollTop).toBe(0);
    expect(page.scrollTop).toBe(0);
    expect(scrolled).toBe(false);

    scroller.scrollTop = 1000;
    keys("z", "t");
    expect(scroller.scrollTop).toBe(1300);
    scroller.scrollTop = 1000;
    keys("z", "b");
    expect(scroller.scrollTop).toBe(1000 + 300 - 380);
    expect(list.scrollTop).toBe(0);

    // The room goes as the keys leave.
    list.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
    expect(scroller.style.paddingBottom).toBe("");
    await act(async () => root.unmount());
    host.remove();
  });

  test("zz in a chat places in the list itself, as before", async () => {
    const { host, list, root, keys } = await mount(`
      <div class="list" style="overflow-y: auto">
        <p data-stop="s1">One</p>
        <pre style="overflow-y: auto"><code data-stop="s2">Two</code></pre>
      </div>`);
    layout(list, 0, 600);
    const stop = host.querySelector<HTMLElement>('[data-stop="s2"]')!;
    layout(stop, 500, 40);
    list.scrollTop = 200;
    keys("z", "z");
    // 500 - (600 - 40) / 2 = 220 further.
    expect(list.scrollTop).toBe(420);
    expect(list.style.paddingBottom).toBe("600px");
    await act(async () => root.unmount());
    expect(list.style.paddingBottom).toBe("");
    host.remove();
  });

  test("one key machine: Shift for gN keeps the g, and gc (no sequence here) is c", async () => {
    const steps: number[] = [];
    const commented: string[] = [];
    const { host, root, keys } = await mount(
      `<div class="list">
        <p data-stop="s1">One</p>
        <p data-stop="s2">Two</p>
        <p data-stop="s3">Three</p>
        <p data-stop="s4">Four</p>
      </div>`,
      {
        jumpUnresolved: (direction) => steps.push(direction),
        comment: (here) => {
          commented.push(here.dataset.stop ?? "");
          return true;
        },
      },
    );
    // A real keyboard: Shift goes down before N.
    keys("g", "Shift", "N");
    expect(steps).toEqual([-1]);
    keys("g", "n");
    expect(steps).toEqual([-1, 1]);
    // Not a sequence of the threads' (the review's commit picker): c.
    keys("g", "c");
    expect(commented).toEqual(["s2"]);
    await act(async () => root.unmount());
    host.remove();
  });
}
