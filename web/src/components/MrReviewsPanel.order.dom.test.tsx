import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_ORDER_DOM_TEST !== "1") {
  test("the reviews panel's search, keys and order, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_ORDER_DOM_TEST: "1" },
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
  test("search, list keys, reorder by keys, drag and buttons, kept by the bridge", async () => {
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
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      ResizeObserver: browser.ResizeObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
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
    (browser.HTMLElement.prototype as any).scrollIntoView = () => {};
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { bridge } = await import("../api");
    const entry = (
      number: number,
      section: string,
      extra: Record<string, unknown> = {},
    ) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number,
      key: `k${number}`,
      url: `https://gitlab.example.org/group/app/-/merge_requests/${number}`,
      title: `Change ${number}`,
      author: "alice",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: `topic-${number}`,
      targetBranch: "main",
      pipeline: null,
      notes: 0,
      reasons: section === "mine" ? ["review_requested"] : [],
      section,
      unread: null,
      isNew: false,
      ...extra,
    });
    let listed = [
      entry(1, "mine", { title: "Fix the timeline" }),
      entry(2, "mine", { author: "bob" }),
      entry(3, "mine", { sourceBranch: "wip/audio-mixer" }),
      entry(4, "mine"),
      entry(5, "suggested", { project: "other/lib" }),
    ];
    /** What settings.json keeps, as the bridge does. */
    let order: string[] = [];
    const saves: string[][] = [];
    const calls: string[] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push(method);
      if (method === "bridge.mr_reviews.inbox")
        return {
          entries: listed,
          hosts: [],
          curation: { state: "idle" },
          refreshedAt: new Date().toISOString(),
          refreshing: false,
          ...(order.length ? { order } : {}),
        };
      if (method === "bridge.mr_reviews.order") {
        order = fakeOrderRpc(listed, order, params);
        saves.push(order);
        return { ok: true, version: saves.length };
      }
      return { ok: true };
    };
    const opened: string[] = [];
    const windowOpened: string[] = [];
    (window as any).open = (url: string) => {
      windowOpened.push(url);
      return null;
    };
    const { fakeOrderRpc } = await import("./mrReviewsFakeOrder");
    const { MrReviewsPanel } = await import("./MrReviewsPanel");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = (ms = 20) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const render = async () => {
      await act(async () => {
        root.render(
          <MrReviewsPanel
            onClose={() => {}}
            onOpenEntry={(each) => opened.push(each.key)}
          />,
        );
      });
      await settle();
    };
    await render();
    const panel = host.querySelector<HTMLElement>(".mr-reviews-panel")!;
    const rows = () =>
      [...host.querySelectorAll(".mr-reviews-row")].map((row) =>
        row.getAttribute("data-mr-key"),
      );
    const selected = () =>
      host
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    const key = async (
      name: string,
      init: KeyboardEventInit = {},
      target: Element = document.activeElement ?? panel,
    ) => {
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
      await settle(5);
    };
    const keys = async (sequence: string[]) => {
      for (const name of sequence) await key(name);
    };
    panel.focus();
    expect(rows()).toEqual(["k1", "k2", "k3", "k4", "k5"]);

    // Counts, gg and G, as elsewhere.
    await keys(["3", "j"]);
    expect(selected()).toBe("k3");
    await keys(["G"]);
    expect(selected()).toBe("k5");
    await keys(["g", "g"]);
    expect(selected()).toBe("k1");
    await keys(["2", "G"]);
    expect(selected()).toBe("k2");
    await keys(["k"]);
    expect(selected()).toBe("k1");
    await keys(["End"]);
    expect(selected()).toBe("k5");
    await keys(["Home"]);
    expect(selected()).toBe("k1");

    // Enter reviews it, o opens it on the forge.
    await key("Enter");
    expect(opened).toEqual(["k1"]);
    await key("o");
    expect(windowOpened).toEqual([
      "https://gitlab.example.org/group/app/-/merge_requests/1",
    ]);

    // ? lists the keys; Esc puts it away first.
    await key("?");
    expect(host.querySelector(".shortcut-help")?.textContent).toContain(
      "move it down in your order",
    );
    await key("Escape");
    expect(host.querySelector(".shortcut-help")).toBeNull();

    // / searches: title, author, branch, number, project.
    const search = host.querySelector<HTMLInputElement>(".mr-reviews-search")!;
    await key("/");
    expect(document.activeElement).toBe(search);
    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(search, text);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle(5);
    };
    await type("timeline");
    expect(rows()).toEqual(["k1"]);
    await type("bob");
    expect(rows()).toEqual(["k2"]);
    await type("audio-mixer");
    expect(rows()).toEqual(["k3"]);
    await type("!4");
    expect(rows()).toEqual(["k4"]);
    await type("other/lib");
    expect(rows()).toEqual(["k5"]);
    await type("nothing like it");
    expect(rows()).toEqual([]);
    expect(host.textContent).toContain("Nothing matches.");
    // The keys typed are the box's, not the list's.
    await type("change");
    await key("j", {}, search);
    expect(document.activeElement).toBe(search);
    // Down moves in what is found; Enter reviews it.
    await key("ArrowDown", {}, search);
    expect(selected()).toBe("k2");
    await key("ArrowDown", {}, search);
    expect(selected()).toBe("k3");
    await key("ArrowUp", {}, search);
    await key("Enter", {}, search);
    expect(opened[opened.length - 1]).toBe("k2");
    expect(document.activeElement).toBe(panel);
    // Esc in the box clears the search and goes back to the list.
    await key("/");
    await type("bob");
    expect(rows()).toEqual(["k2"]);
    await key("Escape", {}, search);
    expect(search.value).toBe("");
    expect(rows()).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(document.activeElement).toBe(panel);
    // On the list, Esc clears a search left in place before closing.
    await key("/");
    await type("bob");
    panel.focus();
    await key("Escape");
    expect(rows()).toEqual(["k1", "k2", "k3", "k4", "k5"]);

    // J / K move the selected one in the user's order, with a count;
    // Alt+Up / Alt+Down too. Saved through the settings, all listed.
    await keys(["g", "g"]);
    await key("J");
    expect(rows()).toEqual(["k2", "k1", "k3", "k4", "k5"]);
    expect(selected()).toBe("k1");
    await settle();
    expect(saves[saves.length - 1]).toEqual(["k2", "k1", "k3", "k4", "k5"]);
    await keys(["2", "J"]);
    expect(rows()).toEqual(["k2", "k3", "k4", "k1", "k5"]);
    // Within its section: a suggestion stays below.
    await key("J");
    expect(rows()).toEqual(["k2", "k3", "k4", "k1", "k5"]);
    await key("ArrowUp", { altKey: true });
    expect(rows()).toEqual(["k2", "k3", "k1", "k4", "k5"]);
    await key("K");
    await settle();
    expect(rows()).toEqual(["k2", "k1", "k3", "k4", "k5"]);
    expect(order).toEqual(["k2", "k1", "k3", "k4", "k5"]);

    // Drag and drop: k4 dropped before k2.
    const item = (name: string) =>
      host.querySelector(`[data-mr-key="${name}"]`)!.closest("li")!;
    const drag = async (type: string, target: Element, clientY = 0) => {
      await act(async () => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientY,
        });
        Object.defineProperty(event, "dataTransfer", {
          value: {
            effectAllowed: "",
            dropEffect: "",
            setData() {},
            getData: () => "",
          },
        });
        target.dispatchEvent(event);
      });
    };
    expect(item("k4").getAttribute("draggable")).toBe("true");
    await drag("dragstart", item("k4"));
    await drag("dragover", item("k2"), -100);
    expect(item("k2").className).toContain("is-drop-before");
    await drag("drop", item("k2"), -100);
    await drag("dragend", item("k4"));
    await settle();
    expect(rows()).toEqual(["k4", "k2", "k1", "k3", "k5"]);
    expect(order).toEqual(["k4", "k2", "k1", "k3", "k5"]);
    // Not across sections.
    await drag("dragstart", item("k5"));
    await drag("dragover", item("k1"), 1000);
    expect(item("k1").className).not.toContain("is-drop");
    await drag("dragend", item("k5"));

    // Kept by the bridge: a new panel reads it. A new request comes first,
    // a gone one drops out of the next order saved.
    act(() => root.unmount());
    listed = [entry(6, "mine"), ...listed.filter((each) => each.key !== "k3")];
    const root2 = createRoot(host);
    await act(async () => {
      root2.render(<MrReviewsPanel onClose={() => {}} />);
    });
    await settle();
    expect(rows()).toEqual(["k6", "k4", "k2", "k1", "k5"]);
    const panel2 = host.querySelector<HTMLElement>(".mr-reviews-panel")!;
    panel2.focus();
    await keys(["G", "k", "K"]);
    await settle();
    expect(order).toEqual(["k6", "k4", "k1", "k2", "k5"]);

    // A phone: no drag, the selected one has up and down buttons.
    act(() => root2.unmount());
    const { updateLayoutPreferences } = await import("../layoutPreferences");
    updateLayoutPreferences({ mode: "mobile" });
    const root3 = createRoot(host);
    await act(async () => {
      root3.render(<MrReviewsPanel onClose={() => {}} />);
    });
    await settle();
    expect(item("k6").getAttribute("draggable")).toBeNull();
    expect(host.querySelector(".mr-reviews-search")).not.toBeNull();
    await act(async () => {
      host.querySelector<HTMLElement>('[data-mr-key="k4"]')!.focus();
    });
    const moveDown = host.querySelector<HTMLButtonElement>(
      '[aria-label="Move down (J)"]',
    )!;
    expect(host.querySelector('[aria-label="Move up (K)"]')).not.toBeNull();
    await act(async () => moveDown.click());
    await settle();
    expect(rows()).toEqual(["k6", "k1", "k4", "k2", "k5"]);
    expect(order).toEqual(["k6", "k1", "k4", "k2", "k5"]);
    // No Add row on a phone either: the head's + opens the add prompt.
    const addBox = () =>
      host.querySelector('[aria-label="Add a merge or pull request"]');
    expect(addBox()).toBeNull();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Add a request"]')!
        .click(),
    );
    await settle();
    expect(addBox()).not.toBeNull();
    expect(document.activeElement).toBe(addBox());
    act(() => root3.unmount());
    host.remove();
    expect(
      calls.filter((method) => method.endsWith("mr_reviews.order")),
    ).not.toHaveLength(0);
  });
}
