import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "Zen's way out docking in headers, in an isolated browser runtime",
    "ROAMGATE_ZEN_ISLAND_DOM_TEST",
    30_000,
  )
) {
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
    // Something drawn over every header (a picker, another view).
    let cover: Element | null = null;
    document.elementFromPoint = (_x: number, y: number) =>
      cover ??
      [...document.querySelectorAll(".group")].reverse().find((group) => {
        const top = tops.get(group.className) ?? 0;
        return y >= top && y <= top + 28;
      }) ??
      null;

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

    // A picker open over it for a moment: still docked there, not hung
    // over the header behind the picker.
    const picker = document.createElement("div");
    picker.setAttribute("data-zen-transient", "");
    picker.innerHTML = "<ul><li>a commit</li></ul>";
    document.body.append(picker);
    cover = picker.querySelector("li");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(
      document.querySelector(".group.inspector .zen-dock-island"),
    ).not.toBeNull();
    expect(document.querySelector(".zen-island")).toBeNull();

    // Another view over it: the header is not the top one any more.
    const overlay = document.createElement("section");
    document.body.append(overlay);
    cover = overlay;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(document.querySelector(".zen-dock-island")).toBeNull();
    expect(document.querySelector(".app > .zen-island")).not.toBeNull();
    cover = null;
    picker.remove();
    overlay.remove();
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
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

  test("the menu from Zen's button opens under it, the top bar left hidden", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({
      url: "http://localhost/",
      width: 1024,
      height: 768,
    });
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
      KeyboardEvent: browser.KeyboardEvent,
      CustomEvent: browser.CustomEvent,
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
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { ConfigMenu } = await import("./ConfigMenu");
    const { ZenDock, ZenIsland } = await import("./ZenIsland");

    // Zen's menu buttons sit at the top right; the menu is 380 wide.
    const box = (left: number, top: number, width: number, height: number) => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON() {},
    });
    Object.defineProperty(
      browser.HTMLElement.prototype,
      "getBoundingClientRect",
      {
        configurable: true,
        value(this: HTMLElement) {
          if (this.classList.contains("zen-island-menu"))
            return box(900, 0, 28, 26);
          if (this.classList.contains("config-dropdown"))
            return box(0, 0, 380, 500);
          return box(0, 0, 1024, 32);
        },
      },
    );
    document.elementFromPoint = () => null;

    const configuration = {} as React.ComponentProps<typeof ConfigMenu>;
    const App = ({
      zen,
      docked = false,
    }: {
      zen: boolean;
      docked?: boolean;
    }) => (
      <div className={`app${zen ? " zen" : ""}`}>
        <header className="topbar">
          <ConfigMenu
            {...configuration}
            zenMode={zen}
            onZenModeChange={() => {}}
            onShowShortcuts={() => {}}
          />
        </header>
        {zen ? <ZenIsland onExit={() => {}} /> : null}
        {docked ? (
          <header className="inspector-head">
            <div className="group inspector">
              <button type="button">Close</button>
              <ZenDock />
            </div>
          </header>
        ) : null}
        <main tabIndex={-1}>terminal</main>
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
    const menu = () => document.getElementById("roamgate-config-menu");
    const topbar = () => document.querySelector(".topbar")!;
    const escape = async () => {
      await act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settle();
    };

    for (const docked of [false, true]) {
      await act(async () => {
        root.render(<App zen docked={docked} />);
      });
      await settle();
      const button = document.querySelector<HTMLButtonElement>(
        docked
          ? ".group.inspector .zen-dock-island .zen-island-menu"
          : ".app > .zen-island .zen-island-menu",
      )!;
      expect(button).not.toBeNull();
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      button.focus();
      await act(async () => {
        button.click();
      });
      await settle();
      // The same menu, out of the top bar, which nothing focuses: it stays
      // hidden (the top bar shows on focus within it).
      const opened = menu()!;
      expect(opened).not.toBeNull();
      expect(opened.classList.contains("is-anchored")).toBe(true);
      expect(topbar().contains(opened)).toBe(false);
      expect(opened.parentElement).toBe(document.querySelector(".app"));
      expect(topbar().contains(document.activeElement)).toBe(false);
      expect(document.activeElement).toBe(button);
      expect(opened.textContent).toContain("Configuration");
      expect(opened.textContent).toContain("Zen mode");
      // Under the button, its right edge on the button's.
      expect(opened.style.left).toBe(`${928 - 380}px`);
      expect(opened.style.top).toBe(`${26 + 6}px`);
      // A click in it is not a click outside.
      await act(async () => {
        opened
          .querySelector(".config-summary")!
          .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(menu()).not.toBeNull();
      // Escape closes it, and the focus is back on the button.
      (opened.querySelector("button") as HTMLButtonElement).focus();
      await escape();
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(button);
    }

    // The CSS keeps the top bar hidden while that menu is open, with no
    // raised top bar to show it.
    const css = await Bun.file(
      new URL("../styles/layout/topbar.css", import.meta.url),
    ).text();
    expect(css).toMatch(
      /\.app\.zen:has\(\.config-dropdown\.is-anchored\) \.topbar\s*\{[^}]*transform: translateY\(-100%\);/,
    );
    expect(css).not.toContain("z-index: 5600");

    // Outside Zen the top bar's button opens it in the top bar, as ever.
    await act(async () => {
      root.render(<App zen={false} />);
    });
    await settle();
    const menuButton =
      document.querySelector<HTMLButtonElement>(".menu-button")!;
    await act(async () => {
      menuButton.click();
    });
    expect(menu()).not.toBeNull();
    expect(menu()!.classList.contains("is-anchored")).toBe(false);
    expect(topbar().contains(menu())).toBe(true);
    await escape();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(menuButton);

    await act(async () => {
      root.unmount();
    });
  });
}
