import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_PUSH_DOM_TEST !== "1") {
  test("the reviews panel follows the pushed order, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_PUSH_DOM_TEST: "1" },
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
  test("a pushed order shows at once, keeps the selection and a drag, the agent's change has Undo, and the manual order wins in Suggested", async () => {
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
    // The inbox's own sort puts the suggestions by score: 5, 6, 7.
    const listed = [
      entry(1, "mine"),
      entry(2, "mine"),
      entry(5, "suggested"),
      entry(6, "suggested"),
      entry(7, "suggested"),
    ];
    let server: { order: string[]; orderVersion: number } = {
      order: ["k7", "k5", "k6"],
      orderVersion: 1,
    };
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox")
        return {
          entries: listed,
          hosts: [],
          curation: { state: "idle" },
          refreshedAt: new Date().toISOString(),
          refreshing: false,
          order: server.order,
          orderVersion: server.orderVersion,
        };
      return { ok: true };
    };
    const push = (value: Record<string, unknown>) =>
      act(async () => {
        for (const handler of (bridge as any).mrReviewsHandlers) handler(value);
      });
    const { MrReviewsPanel } = await import("./MrReviewsPanel");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = (ms = 20) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    await act(async () => {
      root.render(<MrReviewsPanel onClose={() => {}} />);
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
    const key = async (name: string) => {
      await act(async () => {
        (document.activeElement ?? panel).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settle(5);
    };

    // The manual order wins over the inbox's sort, in Suggested too.
    expect(rows()).toEqual(["k1", "k2", "k7", "k5", "k6"]);

    // Select one; a change pushed from another device shows at once.
    panel.focus();
    await act(async () => {
      host.querySelector<HTMLElement>('[data-mr-key="k6"]')!.click();
    });
    expect(selected()).toBe("k6");
    const polls = () =>
      calls.filter(([method]) => method === "bridge.mr_reviews.inbox").length;
    const before = polls();
    await push({
      version: 2,
      order: ["k2", "k1", "k6", "k7", "k5"],
      changed: ["order"],
      by: "user",
    });
    expect(rows()).toEqual(["k2", "k1", "k6", "k7", "k5"]);
    // The selection stays on the same request, and no poll was needed.
    expect(selected()).toBe("k6");
    expect(polls()).toBe(before);
    expect(host.querySelector(".mr-reviews-undo")).toBeNull();

    // A drag in progress survives a push.
    const item = (name: string) =>
      host.querySelector(`[data-mr-key="${name}"]`)!.closest("li")!;
    const drag = async (type: string, target: Element) => {
      await act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true });
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
    await drag("dragstart", item("k5"));
    expect(item("k5").className).toContain("is-dragging");
    await push({
      version: 3,
      order: ["k2", "k1", "k5", "k6", "k7"],
      changed: ["order"],
      by: "user",
    });
    expect(rows()).toEqual(["k2", "k1", "k5", "k6", "k7"]);
    expect(item("k5").className).toContain("is-dragging");
    await drag("dragend", item("k5"));

    // An older version is ignored, and so is a poll older than a push.
    await push({
      version: 2,
      order: ["k1", "k2", "k5", "k6", "k7"],
      changed: ["order"],
      by: "user",
    });
    expect(rows()).toEqual(["k2", "k1", "k5", "k6", "k7"]);
    server = { order: ["k7", "k5", "k6"], orderVersion: 1 };
    panel.focus();
    await key("r");
    await settle();
    expect(rows()).toEqual(["k2", "k1", "k5", "k6", "k7"]);

    // The agent's change is said, with Undo (u), which asks the server.
    await push({
      version: 4,
      order: ["k1", "k2", "k7", "k5", "k6"],
      changed: ["order"],
      by: "agent",
      summary: "Claude moved 1 request to the top",
      undo: 4,
    });
    expect(rows()).toEqual(["k1", "k2", "k7", "k5", "k6"]);
    expect(host.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "Claude moved 1 request to the top",
    );
    // (the drag selected k5)
    expect(selected()).toBe("k5");
    // Clicking k6 earlier opened its details: back to the list, then u.
    panel.focus();
    await key("Escape");
    await key("u");
    await settle();
    expect(
      calls.some(
        ([method, params]) =>
          method === "bridge.mr_reviews.order" &&
          params.op === "undo" &&
          params.version === 4,
      ),
    ).toBe(true);
    expect(host.querySelector(".mr-reviews-undo")).toBeNull();

    // An agent's pin is said without Undo, and the list is read again.
    const reads = polls();
    await push({
      version: 5,
      order: ["k1", "k2", "k7", "k5", "k6"],
      changed: ["pinned"],
      by: "agent",
      summary: "Claude pinned g/p!9",
    });
    await settle();
    expect(polls()).toBeGreaterThan(reads);
    expect(host.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "Claude pinned g/p!9",
    );
    expect(host.querySelector(".mr-reviews-undo button")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
}
