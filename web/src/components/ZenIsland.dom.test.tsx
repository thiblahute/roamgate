import { expect, test } from "bun:test";

if (process.env.ROAMGATE_ZEN_ISLAND_DOM_TEST !== "1") {
  test("Zen's way out docking in headers, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_ZEN_ISLAND_DOM_TEST: "1" },
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
  test("the way out docks in the top header's group, else hangs from the edge", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      MouseEvent: browser.MouseEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { ZenDock, ZenIsland } = await import("./ZenIsland");

    // Where each header's group is on screen; the one drawn last is over
    // the others where they meet.
    const tops = new Map<string, number>();
    Object.defineProperty(
      browser.HTMLElement.prototype,
      "getBoundingClientRect",
      {
        configurable: true,
        value(this: HTMLElement) {
          const top = tops.get(this.className) ?? 0;
          return {
            x: 0,
            y: top,
            top,
            left: 0,
            width: 100,
            height: 28,
            right: 100,
            bottom: top + 28,
            toJSON() {},
          };
        },
      },
    );
    document.elementFromPoint = (_x: number, y: number) =>
      [...document.querySelectorAll(".group")].reverse().find((group) => {
        const top = tops.get(group.className) ?? 0;
        return y >= top && y <= top + 28;
      }) ?? null;

    let exits = 0;
    const App = ({
      review = false,
      inspector = false,
    }: {
      review?: boolean;
      inspector?: boolean;
    }) => (
      <div className="app zen">
        <ZenIsland onExit={() => exits++} />
        {inspector ? (
          <header className="inspector-head">
            <div className="group inspector">
              <button type="button">Close</button>
              <ZenDock iconSize={15} />
            </div>
          </header>
        ) : null}
        {review ? (
          <div className="review-head">
            <div className="group review">
              <button type="button" className="icon-btn">
                ?
              </button>
              <ZenDock labels buttonClassName="icon-btn" />
            </div>
          </div>
        ) : null}
        <main>terminal</main>
      </div>
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    };
    await act(async () => {
      root.render(<App />);
    });
    await settle();

    // No header: the tab hangs from the top edge.
    expect(document.querySelector(".app > .zen-island")).not.toBeNull();
    expect(document.querySelector(".zen-dock-island")).toBeNull();

    // The expanded inspector's header: the pair ends its group, as its own
    // icon buttons after a divider; no tab hangs over it.
    await act(async () => {
      root.render(<App inspector />);
    });
    await settle();
    expect(document.querySelector(".zen-island")).toBeNull();
    const group = document.querySelector(".group.inspector")!;
    const docked = group.querySelector(".zen-dock-island")!;
    expect(docked.getAttribute("aria-label")).toBe("Zen mode");
    expect(
      [...docked.children].map((child) => child.className || child.tagName),
    ).toEqual(["zen-dock-divider", "zen-dock-exit", "zen-island-menu"]);
    const exit = docked.querySelector<HTMLButtonElement>(".zen-dock-exit")!;
    expect(exit.getAttribute("aria-label")).toStartWith("Exit Zen mode");
    // Icon only, as the group's buttons.
    expect(exit.textContent).toBe("");
    await act(async () => {
      exit.click();
    });
    expect(exits).toBe(1);

    // The review opens over it: the latest header at the top takes it, with
    // its buttons' class and words.
    await act(async () => {
      root.render(<App inspector review />);
    });
    await settle();
    expect(group.querySelector(".zen-dock-island")).toBeNull();
    const reviewExit = document.querySelector(
      ".group.review .zen-dock-island .zen-dock-exit",
    )!;
    expect(reviewExit.className).toBe("icon-btn zen-dock-exit");
    expect(reviewExit.textContent).toBe("Exit Zen");
    expect(document.querySelectorAll(".zen-dock-island").length).toBe(1);

    // The review closes: back in the inspector's header.
    await act(async () => {
      root.render(<App inspector />);
    });
    await settle();
    expect(
      document.querySelector(".group.inspector .zen-dock-island"),
    ).not.toBeNull();

    // A header lower than the top of the screen does not hold it.
    tops.set("group inspector", 300);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(document.querySelector(".zen-dock-island")).toBeNull();
    expect(document.querySelector(".app > .zen-island")).not.toBeNull();

    // Nor one gone: the tab hangs again.
    tops.clear();
    await act(async () => {
      root.render(<App />);
    });
    await settle();
    expect(document.querySelector(".app > .zen-island")).not.toBeNull();
    expect(document.querySelector(".zen-dock-island")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
}
