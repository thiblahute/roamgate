import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "reaching Activity, in an isolated browser runtime",
    "ROAMGATE_ACTIVITY_ACCESS_DOM_TEST",
    30_000,
  )
) {
  test("one Activity entry, its shortcut, and both in Zen mode", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
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
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { ConfigMenu } = await import("./ConfigMenu");
    const { ZenIsland } = await import("./ZenIsland");
    const { handleActivityShortcut } = await import("../activityTimelineOpen");
    const { shortcutLabel } = await import("../shortcutPreferences");

    // The app's global key handler, as App.tsx installs it: on the window,
    // whatever is on screen.
    let toggles = 0;
    const onKey = (event: KeyboardEvent) => {
      handleActivityShortcut(event, () => toggles++);
    };
    window.addEventListener("keydown", onKey, { capture: true });

    let exits = 0;
    const configuration = {} as React.ComponentProps<typeof ConfigMenu>;
    const App = ({ zen }: { zen: boolean }) => (
      <div className={`app${zen ? " zen" : ""}`}>
        <header className="topbar">
          <ConfigMenu
            {...configuration}
            zenMode={zen}
            onZenModeChange={() => {}}
            onShowShortcuts={() => {}}
          />
        </header>
        {zen ? <ZenIsland onExit={() => exits++} /> : null}
        <main tabIndex={-1}>terminal</main>
      </div>
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<App zen={false} />);
    });

    const menu = () => document.getElementById("roamgate-config-menu");
    const labels = () =>
      [...(menu()?.querySelectorAll(".config-menu-item strong") ?? [])].map(
        (label) => label.textContent,
      );

    // The application menu has one entry for the timeline, which shows its
    // shortcut; its Hours are a tab of it, not a second entry.
    await act(async () => {
      (document.querySelector(".menu-button") as HTMLButtonElement).click();
    });
    expect(menu()).not.toBeNull();
    expect(labels().filter((label) => label === "Activity")).toHaveLength(1);
    expect(labels()).not.toContain("Hours");
    expect(labels()).not.toContain("Activity timeline");
    const activity = [...menu()!.querySelectorAll(".config-menu-item")].find(
      (item) => item.querySelector("strong")?.textContent === "Activity",
    );
    expect(shortcutLabel("activity.open")).toBe("Alt+A");
    expect(activity?.textContent).toContain(shortcutLabel("activity.open"));
    await act(async () => {
      (document.querySelector(".menu-button") as HTMLButtonElement).click();
    });
    expect(menu()).toBeNull();

    // Alt+A opens it, from anywhere; a held key does not flicker it.
    const press = async (init: KeyboardEventInit) => {
      await act(async () => {
        document.querySelector("main")!.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    };
    await press({ key: "a", code: "KeyA", altKey: true });
    expect(toggles).toBe(1);
    await press({ key: "a", code: "KeyA", altKey: true, repeat: true });
    expect(toggles).toBe(1);
    await press({ key: "a", code: "KeyA", ctrlKey: true, altKey: true });
    expect(toggles).toBe(1);

    // In Zen the top bar is hidden: the shortcut still works ...
    await act(async () => {
      root.render(<App zen />);
    });
    await press({ key: "a", code: "KeyA", altKey: true });
    expect(toggles).toBe(2);

    // ... and Zen's tab opens the same menu in place, beside its way out.
    const island = document.querySelector(".app.zen > .zen-island");
    expect(island).not.toBeNull();
    const [exit, menuButton] = [
      ...island!.querySelectorAll("button"),
    ] as HTMLButtonElement[];
    expect(exit.textContent).toBe("Exit Zen");
    expect(menuButton.getAttribute("aria-label")).toBe("Menu");
    await act(async () => {
      menuButton.click();
    });
    expect(menu()).not.toBeNull();
    expect(labels().filter((label) => label === "Activity")).toHaveLength(1);
    // A press on the tab's button does not count as a click outside: the
    // button closes the menu it opened.
    await act(async () => {
      menuButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      menuButton.click();
    });
    expect(menu()).toBeNull();
    await act(async () => {
      exit.click();
    });
    expect(exits).toBe(1);

    window.removeEventListener("keydown", onKey, { capture: true });
    root.unmount();
  });
}
