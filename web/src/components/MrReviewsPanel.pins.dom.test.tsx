import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the reviews panel's pinned and hidden requests, in an isolated browser runtime",
    "ROAMGATE_MR_REVIEWS_PINS_DOM_TEST",
    30_000,
  )
) {
  test("add by URL, remove, undo, restore, order and search with pinned", async () => {
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
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
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
    const keyOf = (number: number) =>
      `gitlab:gitlab.example.org/group/app#${number}`;
    const entry = (
      number: number,
      section: string,
      extra: Record<string, unknown> = {},
    ) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number,
      key: keyOf(number),
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
    // A small bridge: the listed requests, the user's pins and hidden ones.
    const listed = [
      entry(1, "mine"),
      entry(2, "mine"),
      entry(3, "suggested", { reason: "touches the timeline" }),
    ];
    let pins: ReturnType<typeof entry>[] = [];
    let hiddenKeys: string[] = [];
    let order: string[] = [];
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      switch (method) {
        case "bridge.mr_reviews.inbox":
          return {
            entries: [
              ...pins,
              ...listed.filter((each) => !hiddenKeys.includes(each.key)),
            ],
            hidden: listed.filter((each) => hiddenKeys.includes(each.key)),
            hosts: [],
            curation: { state: "idle" },
            refreshedAt: new Date().toISOString(),
            refreshing: false,
            ...(order.length ? { order } : {}),
          };
        case "bridge.mr_reviews.pin": {
          const text = String(params.text);
          const match =
            /^https:\/\/gitlab\.example\.org\/group\/app\/-\/merge_requests\/(\d+)$/.exec(
              text,
            );
          if (!match)
            throw new Error(
              "That host is not one of your forge hosts (see the settings).",
            );
          const number = Number(match[1]);
          const key = keyOf(number);
          if (!pins.some((each) => each.key === key))
            pins = [
              number === 404
                ? entry(number, "pinned", {
                    title: "group/app!404",
                    unavailable: "Not found, or you have no access to it",
                  })
                : entry(number, "pinned"),
              ...pins,
            ];
          hiddenKeys = hiddenKeys.filter((each) => each !== key);
          return { ok: true, key };
        }
        case "bridge.mr_reviews.hide": {
          const key = String(params.key);
          if (pins.some((each) => each.key === key)) {
            pins = pins.filter((each) => each.key !== key);
            return { ok: true, action: "unpinned" };
          }
          hiddenKeys = [...hiddenKeys, key];
          return { ok: true, action: "hidden" };
        }
        case "bridge.mr_reviews.unhide":
          hiddenKeys = hiddenKeys.filter((each) => each !== params.key);
          return { ok: true };
        case "bridge.mr_reviews.order":
          order = fakeOrderRpc(
            [
              ...pins,
              ...listed.filter((each) => !hiddenKeys.includes(each.key)),
            ],
            order,
            params,
          );
          return { ok: true };
        default:
          return { ok: true };
      }
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
    await act(async () => {
      root.render(<MrReviewsPanel onClose={() => {}} onOpenEntry={() => {}} />);
    });
    await settle();
    const panel = host.querySelector<HTMLElement>(".mr-reviews-panel")!;
    const rows = () =>
      [...host.querySelectorAll(".mr-reviews-row")].map((row) =>
        row.getAttribute("data-mr-key"),
      );
    const selected = () =>
      host
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    const titles = () =>
      [...host.querySelectorAll(".mr-reviews-section-title")].map((node) =>
        node.textContent?.replace(/\d+( of \d+)?$/, ""),
      );
    const key = async (name: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        (document.activeElement ?? panel).dispatchEvent(
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
    const type = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const click = async (element: Element | null) => {
      await act(async () => (element as HTMLElement).click());
      await settle();
    };
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find(
        (each) =>
          each.getAttribute("aria-label") === label ||
          each.textContent?.trim() === label,
      ) ?? null;
    const addBox = () =>
      host.querySelector<HTMLInputElement>(
        '[aria-label="Add a merge or pull request"]',
      );
    const URL7 = "https://gitlab.example.org/group/app/-/merge_requests/7";
    const URL8 = "https://gitlab.example.org/group/app/-/merge_requests/8";
    const URL9 = "https://gitlab.example.org/group/app/-/merge_requests/9";
    const URL404 = "https://gitlab.example.org/group/app/-/merge_requests/404";
    const pinCalls = () =>
      calls.filter(([method]) => method === "bridge.mr_reviews.pin");

    const commandBox = () =>
      host.querySelector<HTMLInputElement>('[aria-label="Command"]')!;
    const searchBox = () =>
      host.querySelector<HTMLInputElement>(
        '[aria-label="Search the reviews"]',
      )!;
    const addOffer = () => host.querySelector(".mr-reviews-add-offer");

    // Nothing pinned: no Pinned section, and no Add row: p opens a prompt.
    panel.focus();
    expect(titles()).toEqual(["To review", "Mine", "Suggested"]);
    expect(addBox()).toBeNull();
    expect(host.querySelector(".mr-reviews-add")).toBeNull();
    expect(button("Add")).toBeNull();
    expect(host.textContent).not.toContain("paste its URL");

    // p opens the prompt where the : line opens; Enter adds: a Pinned
    // section on top, the new row selected, the prompt gone.
    await key("p");
    expect(document.activeElement).toBe(addBox());
    expect(addBox()?.closest(".mr-reviews-command")).not.toBeNull();
    await type(addBox()!, URL7);
    await key("Enter");
    await settle();
    expect(pinCalls().map(([, params]) => params.text)).toEqual([URL7]);
    expect(titles()).toEqual(["Pinned", "To review", "Mine", "Suggested"]);
    expect(rows()).toEqual([keyOf(7), keyOf(1), keyOf(2), keyOf(3)]);
    expect(selected()).toBe(keyOf(7));
    expect(addBox()).toBeNull();
    expect(document.activeElement).toBe(panel);

    // :add URL adds too; an unknown host says why and pins nothing.
    await key(":");
    await type(
      commandBox(),
      "add https://elsewhere.org/g/p/-/merge_requests/3",
    );
    await key("Enter");
    await settle();
    expect(host.textContent).toContain("not one of your forge hosts");
    expect(rows()).toHaveLength(4);
    // :add alone opens the prompt; typing there clears the error, Esc
    // closes it, pins nothing and gives the keys back.
    await key(":");
    await type(commandBox(), "add");
    await key("Enter");
    expect(document.activeElement).toBe(addBox());
    await type(addBox()!, URL8);
    expect(host.textContent).not.toContain("not one of your forge hosts");
    const beforeEscape = pinCalls().length;
    await key("Escape");
    expect(addBox()).toBeNull();
    expect(document.activeElement).toBe(panel);
    expect(pinCalls()).toHaveLength(beforeEscape);

    // :pin URL adds it as well; one the forge does not give is a row saying
    // so, with a remove button.
    await key(":");
    await type(commandBox(), `pin ${URL404}`);
    await key("Enter");
    await settle();
    expect(pinCalls()[pinCalls().length - 1]?.[1].text).toBe(URL404);
    expect(rows()[0]).toBe(keyOf(404));
    expect(host.textContent).toContain(
      "Not found, or you have no access to it",
    );
    await click(host.querySelector('[aria-label="Unpin (dd)"]'));
    expect(rows()).toEqual([keyOf(7), keyOf(1), keyOf(2), keyOf(3)]);
    await act(async () => {
      panel.focus();
    });

    // dd removes the selected For you request: undo toast, "1 hidden" chip.
    await key("j");
    expect(selected()).toBe(keyOf(1));
    await key("d");
    await key("d");
    expect(rows()).toEqual([keyOf(7), keyOf(2), keyOf(3)]);
    expect(selected()).toBe(keyOf(2));
    expect(host.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "Removed !1",
    );
    expect(button("1 hidden")).not.toBeNull();
    // u takes it back.
    await key("u");
    expect(rows()).toEqual([keyOf(7), keyOf(1), keyOf(2), keyOf(3)]);
    expect(host.querySelector(".mr-reviews-undo")).toBeNull();
    expect(selected()).toBe(keyOf(1));

    // The hidden list restores by hand; H opens it.
    await key("d");
    await key("d");
    await key("H");
    expect(
      host.querySelector('[aria-label="Hidden requests"]')?.textContent,
    ).toContain("Change 1");
    await click(button("Restore"));
    expect(rows()).toContain(keyOf(1));
    expect(button("1 hidden")).toBeNull();

    // A suggestion's x keeps its own meaning (feedback), dd hides it.
    await key("G");
    expect(selected()).toBe(keyOf(3));
    await key("x");
    expect(calls[calls.length - 2]?.[0]).toBe("bridge.mr_reviews.feedback");
    await key("d");
    await key("d");
    expect(rows()).not.toContain(keyOf(3));
    await key("u");
    expect(rows()).toContain(keyOf(3));
    // x on any other request, and Delete, remove it too.
    await key("g");
    await key("g");
    await key("j");
    expect(selected()).toBe(keyOf(1));
    await key("x");
    expect(rows()).not.toContain(keyOf(1));
    await key("u");
    expect(rows()).toContain(keyOf(1));
    await key("Delete");
    expect(rows()).not.toContain(keyOf(1));
    await key("u");
    expect(rows()).toContain(keyOf(1));

    // Removing a pinned one unpins it; undo pins it again.
    await key("g");
    await key("g");
    expect(selected()).toBe(keyOf(7));
    await key("d");
    await key("d");
    expect(titles()).toEqual(["To review", "Mine", "Suggested"]);
    expect(host.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "Unpinned !7",
    );
    await key("u");
    expect(titles()).toEqual(["Pinned", "To review", "Mine", "Suggested"]);
    expect(pinCalls()[pinCalls().length - 1]?.[1].text).toBe(
      "https://gitlab.example.org/group/app/-/merge_requests/7",
    );

    // Pinned ones follow the order and the search.
    await click(
      host.querySelector('.mr-reviews-row[data-mr-key="' + keyOf(7) + '"]'),
    );
    await settle();
    await type(
      host.querySelector<HTMLInputElement>(
        '[aria-label="Search the reviews"]',
      )!,
      "Change 7",
    );
    expect(rows()).toEqual([keyOf(7)]);
    await type(
      host.querySelector<HTMLInputElement>(
        '[aria-label="Search the reviews"]',
      )!,
      "",
    );
    // A second pin, then J moves it within Pinned and saves the whole order.
    // A request's URL in the search is one to add, not words to search
    // for: no offer for one the list has, else "Add this request", and
    // Enter adds it.
    await act(async () => {
      searchBox().focus();
    });
    await type(searchBox(), URL7);
    expect(addOffer()).toBeNull();
    await type(searchBox(), URL9);
    expect(addOffer()?.textContent).toContain("Add this request");
    await key("Enter");
    await settle();
    expect(pinCalls()[pinCalls().length - 1]?.[1].text).toBe(URL9);
    expect(searchBox().value).toBe("");
    expect(addOffer()).toBeNull();
    expect(rows()[0]).toBe(keyOf(9));
    await act(async () => {
      panel.focus();
    });
    await key("J");
    await settle();
    expect(order).toEqual([keyOf(7), keyOf(9), keyOf(1), keyOf(2), keyOf(3)]);
    expect(rows().slice(0, 2)).toEqual([keyOf(7), keyOf(9)]);

    // A URL pasted in the panel, or dropped on it, is added; one pasted in
    // another box is not.
    const paste = async (text: string, target: Element) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      (event as any).clipboardData = { getData: () => text };
      await act(async () => {
        target.dispatchEvent(event);
      });
      await settle();
    };
    const before = pinCalls().length;
    await paste("not a request", panel);
    expect(pinCalls()).toHaveLength(before);
    await paste(
      "https://gitlab.example.org/group/app/-/merge_requests/12",
      host.querySelector<HTMLInputElement>(
        '[aria-label="Search the reviews"]',
      )!,
    );
    expect(pinCalls()).toHaveLength(before);
    await paste(
      "https://gitlab.example.org/group/app/-/merge_requests/12",
      panel,
    );
    expect(pinCalls()).toHaveLength(before + 1);
    expect(rows()[0]).toBe(keyOf(12));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    (drop as any).dataTransfer = {
      types: ["text/uri-list"],
      getData: (type: string) =>
        type === "text/uri-list"
          ? "# a comment\nhttps://gitlab.example.org/group/app/-/merge_requests/13"
          : "",
    };
    await act(async () => {
      host.querySelector(".mr-reviews-body")!.dispatchEvent(drop);
    });
    await settle();
    expect(rows()[0]).toBe(keyOf(13));

    act(() => root.unmount());
    host.remove();
  });
}
