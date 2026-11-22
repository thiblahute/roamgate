import { expect, test } from "bun:test";

/**
 * The shortcut help every view shows on `?`: the command menu's list over
 * the view's shortcuts. Its search is focused; one key lists the rows
 * holding it, words must all match; Up / Down (then j / k) move; Enter or
 * a click runs the row in the view (its keys pressed there, a `:command`,
 * a callback); a row that cannot run is listed only; Esc closes.
 */
if (process.env.ROAMGATE_SHORTCUT_HELP_DOM_TEST !== "1") {
  test("the shortcut help in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SHORTCUT_HELP_DOM_TEST: "1" },
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
  }, 20_000);
} else {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    localStorage: browser.localStorage,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  browser.HTMLElement.prototype.scrollIntoView = () => {};
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ShortcutHelp, shortcutRunOf } = await import("./ShortcutHelp");
  const { shortcutPresses } = await import("../shortcutPress");

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
    await settle();
  };

  test("a shortcut's keys are the key events typing it makes", () => {
    const keys = (shortcut: string) =>
      shortcutPresses(shortcut)?.map((each) =>
        [
          each.ctrlKey ? "C-" : "",
          each.altKey ? "A-" : "",
          each.metaKey ? "M-" : "",
          each.shiftKey ? "S-" : "",
          each.key,
          each.code ? `(${each.code})` : "",
        ].join(""),
      ) ?? null;
    expect(keys("j")).toEqual(["j(KeyJ)"]);
    expect(keys("G")).toEqual(["S-G(KeyG)"]);
    expect(keys("gg")).toEqual(["g(KeyG)", "g(KeyG)"]);
    expect(keys("g;")).toEqual(["g(KeyG)", ";"]);
    expect(keys("Esc")).toEqual(["Escape(Escape)"]);
    expect(keys("↓")).toEqual(["ArrowDown(ArrowDown)"]);
    expect(keys("Ctrl-d")).toEqual(["C-d(KeyD)"]);
    expect(keys("Shift+Tab")).toEqual(["S-Tab(Tab)"]);
    expect(keys("Alt+Down")).toEqual(["A-ArrowDown(ArrowDown)"]);
    expect(keys("Option+V")).toEqual(["A-v(KeyV)"]);
    expect(keys("⌥V")).toEqual(["A-v(KeyV)"]);
    expect(keys("Meta+Shift+K")).toEqual(["M-S-k(KeyK)"]);
    expect(keys("Alt+Slash")).toEqual(["A-/(Slash)"]);
    expect(keys(":")).toEqual([":"]);
    // Not keys one presses: a command, words, a count.
    expect(keys(":refresh")).toBeNull();
    expect(keys("c (effort)")).toBeNull();
    expect(keys("(effort)")).toBeNull();
    expect(keys("12G")).toBeNull();
  });

  test("a row runs as its keys, its run, or not at all", () => {
    const command = () => {};
    expect(shortcutRunOf(["j", "next"], undefined)).toBe("j");
    // Several keys: listed only, unless the row says which runs.
    expect(shortcutRunOf(["j k", "next / previous"], undefined)).toBeNull();
    expect(shortcutRunOf(["R gr :e", "reload", "R"], undefined)).toBe("R");
    expect(shortcutRunOf(["?", "this list", false], undefined)).toBeNull();
    // A command runs where the view has a prompt.
    expect(shortcutRunOf([":all", "all"], undefined)).toBeNull();
    expect(shortcutRunOf([":all", "all"], command)).toBe(":all");
    const callback = () => {};
    expect(shortcutRunOf(["x", "it", callback], undefined)).toBe(callback);
  });

  test("searched, moved through and run in the view; Esc closes", async () => {
    // The view: a list that takes keys, focused when ? was pressed.
    const view = document.createElement("div");
    view.tabIndex = -1;
    document.body.append(view);
    const typed: string[] = [];
    view.addEventListener("keydown", (event) =>
      typed.push(`${event.ctrlKey ? "C-" : ""}${event.key}`),
    );
    view.focus();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let closed = 0;
    const commands: string[] = [];
    const called: string[] = [];
    let open = true;
    const render = () =>
      act(async () =>
        root.render(
          open
            ? h(ShortcutHelp, {
                title: "View keys",
                groups: [
                  {
                    heading: "Moves",
                    rows: [
                      ["j ↓", "next line", "j"],
                      ["k ↑", "previous line", "k"],
                      ["gg", "first line"],
                      ["Ctrl-d", "half a page down"],
                    ],
                  },
                  {
                    heading: "Others",
                    rows: [
                      ["5j", "five lines down"],
                      [":refresh", "read it again"],
                      ["x", "mark it", () => called.push("x")],
                      ["?", "this list", false],
                    ],
                  },
                ],
                command: (text: string) => commands.push(text),
                onClose: () => {
                  closed++;
                  open = false;
                  root.render(null);
                },
              })
            : null,
        ),
      );
    const reopen = async () => {
      view.focus();
      open = true;
      await render();
      await settle();
    };
    const help = () => container.querySelector(".shortcut-help");
    const input = () => help()!.querySelector<HTMLInputElement>("input")!;
    const titles = () =>
      [...container.querySelectorAll(".command-item-title")].map(
        (row) => row.textContent,
      );
    const chosen = () =>
      container.querySelector(
        ".command-item[aria-selected='true'] .command-item-title",
      )?.textContent;
    const search = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input(), text);
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    };
    try {
      await render();
      await settle();
      // The search has the focus; the rows in their groups, each keys
      // drawn as keys; the ones that cannot run are listed, not offered.
      expect(document.activeElement).toBe(input());
      expect(help()?.querySelector("h2")?.textContent).toBe("View keys");
      expect(
        [...container.querySelectorAll("[cmdk-group-heading]")].map(
          (heading) => heading.textContent,
        ),
      ).toEqual(["Moves", "Others"]);
      expect(
        [
          ...container
            .querySelectorAll(".command-item")[0]!
            .querySelectorAll(".command-keys kbd"),
        ].map((key) => key.textContent),
      ).toEqual(["j", "↓"]);
      const disabled = [
        ...container.querySelectorAll(".command-item[aria-disabled='true']"),
      ].map((row) => row.querySelector(".command-item-title")?.textContent);
      expect(disabled).toEqual(["five lines down", "this list"]);

      // One key: the rows holding it. Words: all of them.
      await search("j");
      expect(titles()).toEqual(["next line"]);
      await search("line next");
      expect(titles()).toEqual(["next line"]);
      await search("page");
      expect(titles()).toEqual(["half a page down"]);
      await search("nothing like it");
      expect(titles()).toEqual([]);
      expect(help()?.textContent).toContain("Nothing matches.");
      await search("");
      expect(chosen()).toBe("next line");

      // Down moves; then j / k too; another key searches again.
      await press("ArrowDown");
      expect(chosen()).toBe("previous line");
      await press("j");
      expect(chosen()).toBe("first line");
      await press("k");
      expect(chosen()).toBe("previous line");
      expect(input().value).toBe("");
      // Enter runs it: the help closes, the view has the focus and its key.
      await press("Enter");
      expect(closed).toBe(1);
      expect(help()).toBeNull();
      expect(document.activeElement).toBe(view);
      expect(typed).toEqual(["k"]);

      // A sequence, and a modifier: pressed in the view, in order.
      await reopen();
      await search("first");
      await press("Enter");
      await reopen();
      await search("half");
      await act(async () =>
        (container.querySelector(".command-item") as HTMLElement).click(),
      );
      await settle();
      expect(typed).toEqual(["k", "g", "g", "C-d"]);

      // A command runs by its view's prompt; a callback is called.
      await reopen();
      await search("again");
      await press("Enter");
      expect(commands).toEqual(["refresh"]);
      await reopen();
      await search("mark");
      await press("Enter");
      expect(called).toEqual(["x"]);

      // Listed only: Enter does nothing; Esc closes the help alone.
      await reopen();
      await search("?");
      await press("Enter");
      expect(help()).not.toBeNull();
      const before = typed.length;
      await press("Escape");
      expect(help()).toBeNull();
      expect(typed.length).toBe(before);
      expect(document.activeElement).toBe(view);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      view.remove();
    }
  });
}
