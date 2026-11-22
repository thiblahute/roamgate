import { expect, test } from "bun:test";

/**
 * Changes' scope picker: its search is focused as it opens, typing ranks
 * the branches fzf-style ("ar ru" finds android-rust), Enter picks the
 * first, Up / Down then j / k move; the checked-out branch is compared
 * against a branch as its Branch scope, another head (picked from Head:)
 * or a tag as a review of the two refs; Esc goes back from the head's list.
 */
if (process.env.ROAMGATE_SCOPE_PICKER_DOM_TEST !== "1") {
  test("the scope picker in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SCOPE_PICKER_DOM_TEST: "1" },
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
    PointerEvent: browser.PointerEvent,
    FocusEvent: browser.FocusEvent,
    CustomEvent: browser.CustomEvent,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    DOMRect: browser.DOMRect,
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
  const { ChangesScopePicker } = await import("./ChangesScopeBar");
  type Refs = import("../compareRefs").CompareRefs;

  const day = 86_400;
  const refs: Refs = {
    current: "refs/heads/dogfood",
    base: "refs/remotes/origin/main",
    near: ["refs/heads/up/work-view"],
    refs: [
      { name: "refs/heads/dogfood", date: 300 * day },
      { name: "refs/heads/android-rust", date: 100 * day },
      { name: "refs/heads/backup/20260914-restructure/x", date: 299 * day },
      { name: "refs/heads/up/work-view", date: 298 * day },
      { name: "refs/heads/main", date: 50 * day },
      { name: "refs/remotes/origin/main", date: 60 * day },
      { name: "refs/tags/v0.8.15", date: 40 * day },
    ],
  };

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

  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const picked: string[] = [];
    const compared: [string, string | undefined][] = [];
    await act(async () => {
      root.render(
        h(ChangesScopePicker, {
          value: "working",
          label: "Working tree: uncommitted changes",
          options: [
            { value: "working", label: "Working tree: uncommitted changes" },
            {
              value: "branch:",
              label: "branch dogfood vs its base",
              detail: "against its base, found automatically",
            },
            {
              value: "branch:refs/heads/main",
              label: "branch dogfood vs main",
            },
            {
              value: "last-step",
              label: "Last step: what the agent's last step changed",
            },
          ],
          branch: "dogfood",
          baseBranches: [],
          loadRefs: async () => refs,
          onOption: (value: string) => picked.push(value),
          onCompare: (head: string, base: string | undefined) =>
            compared.push([head, base]),
          onDone: () => {},
        }),
      );
    });
    const trigger = container.querySelector<HTMLElement>(
      '[aria-label="What Changes compares"]',
    )!;
    const open = async () => {
      await act(async () => {
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        trigger.click();
      });
      await settle();
    };
    const input = () =>
      document.querySelector<HTMLInputElement>(".changes-scope-picker input")!;
    const titles = () =>
      [
        ...document.querySelectorAll(
          ".changes-scope-picker [cmdk-item] .command-item-title",
        ),
      ].map((row) => row.textContent);
    const chosen = () =>
      document.querySelector(
        ".changes-scope-picker [cmdk-item][aria-selected='true'] .command-item-title",
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
    return {
      open,
      input,
      titles,
      chosen,
      search,
      picked,
      compared,
      isOpen: () => !!document.querySelector(".changes-scope-picker"),
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("opens on its search, the scopes then the branches ranked, refs/heads/ hidden, backups last", async () => {
    const picker = await mount();
    try {
      await picker.open();
      expect(document.activeElement).toBe(picker.input());
      const titles = picker.titles();
      expect(titles.slice(0, 4)).toEqual([
        "Working tree: uncommitted changes",
        "branch dogfood vs its base",
        "Last step: what the agent's last step changed",
        "Head: dogfood",
      ]);
      expect(titles.slice(4)).toEqual([
        "origin/main",
        "up/work-view",
        "android-rust",
        "main",
        "v0.8.15",
        "backup/20260914-restructure/x",
      ]);
      expect(titles).not.toContain("dogfood");
      expect(
        document.querySelector(".changes-scope-picker [cmdk-group-heading]")
          ?.textContent,
      ).toBe("Compare dogfood against");
    } finally {
      await picker.unmount();
    }
  });

  test("typing filters and ranks, the matched letters marked; Enter picks the first as the Branch scope's base", async () => {
    const picker = await mount();
    try {
      await picker.open();
      await picker.search("ar ru");
      expect(picker.titles()).toEqual(["android-rust"]);
      expect(
        [...document.querySelectorAll(".changes-scope-picker mark")].map(
          (mark) => mark.textContent,
        ),
      ).toEqual(["a", "ru"]);
      expect(picker.chosen()).toBe("android-rust");
      await press("Enter");
      expect(picker.picked).toEqual(["branch:refs/heads/android-rust"]);
      expect(picker.isOpen()).toBe(false);
    } finally {
      await picker.unmount();
    }
  });

  test("Down then j / k move; a tag is compared as a review of the two refs", async () => {
    const picker = await mount();
    try {
      await picker.open();
      await picker.search("main");
      expect(picker.titles().slice(0, 2)).toEqual(["main", "origin/main"]);
      await press("ArrowDown");
      expect(picker.chosen()).toBe("origin/main");
      await press("k");
      expect(picker.chosen()).toBe("main");
      await picker.search("v0.8");
      await press("Enter");
      expect(picker.compared).toEqual([["dogfood", "v0.8.15"]]);
    } finally {
      await picker.unmount();
    }
  });

  test("Head: picks the branch to review, then its base; Esc goes back from the head's list", async () => {
    const picker = await mount();
    try {
      await picker.open();
      await picker.search("head");
      expect(picker.chosen()).toBe("Head: dogfood");
      await press("Enter");
      expect(picker.isOpen()).toBe(true);
      // The head's list: the checked-out branch first.
      expect(picker.titles()[0]).toBe("dogfood");
      expect(picker.input().value).toBe("");
      await press("Escape");
      expect(picker.isOpen()).toBe(true);
      expect(picker.titles()).toContain("Head: dogfood");
      await picker.search("head");
      await press("Enter");
      await picker.search("work");
      await press("Enter");
      // Back on the bases, for up/work-view.
      expect(
        document.querySelector(".changes-scope-picker [cmdk-group-heading]")
          ?.textContent,
      ).toBe("Compare up/work-view against");
      expect(picker.titles()[0]).toBe("branch up/work-view vs its base");
      expect(picker.titles()).toContain("dogfood");
      await picker.search("origin main");
      await press("Enter");
      expect(picker.compared).toEqual([["up/work-view", "origin/main"]]);
      expect(picker.picked).toEqual([]);
    } finally {
      await picker.unmount();
    }
  });
}
