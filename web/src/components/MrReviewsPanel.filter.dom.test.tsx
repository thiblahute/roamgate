import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_FILTER_DOM_TEST !== "1") {
  test("the reviews panel's filter tokens and saved views, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_FILTER_DOM_TEST: "1" },
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
  test("tokens, completion, saved views, f / F and :save / :view / :delview", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({
      url: "http://localhost/",
      width: 1280,
      height: 800,
    });
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
    localStorage.setItem("roamgate:mrReviewsFilter", "mine");

    const React = await import("react");
    const { act } = React;
    const { bridge } = await import("../api");
    const own = {
      approvedBy: [] as string[],
      approved: false,
      changesRequested: [] as string[],
      unresolved: 0,
      conflicts: false,
      needsRebase: false,
    };
    const key = (n: number) => `gitlab:gitlab.example.org/group/app#${n}`;
    const entry = (number: number, extra: Record<string, unknown> = {}) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number,
      key: key(number),
      url: `https://gitlab.example.org/group/app/-/merge_requests/${number}`,
      title: `Change ${number}`,
      author: "me",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: `topic-${number}`,
      targetBranch: "main",
      pipeline: "success",
      notes: 0,
      reasons: ["authored"],
      section: "authored",
      unread: { newCommits: false, newNotes: 0, changed: false },
      isNew: false,
      own,
      lane: "waiting",
      laneWhy: "in review",
      next: { text: "Waiting for review", from: "rule" },
      ...extra,
    });
    let views: { name: string; query: string }[] = [];
    const inbox = () => ({
      entries: [
        entry(1, {
          project: "media/engine",
          labels: ["audio"],
          lane: "your_move",
        }),
        entry(2, { project: "media/plugins" }),
        entry(3, {
          project: "other/tool",
          author: "bob",
          reasons: ["review_requested"],
          section: "mine",
          lane: undefined,
          next: undefined,
        }),
      ],
      hosts: [{ host: "gitlab.example.org", provider: "gitlab", state: "ok" }],
      curation: { state: "off" },
      refreshedAt: new Date().toISOString(),
      refreshing: false,
      hidden: [],
      orderVersion: 1,
      ...(views.length ? { views } : {}),
    });
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox") return inbox();
      if (method === "bridge.mr_reviews.links") return { links: {} };
      if (method === "bridge.mr_reviews.view") {
        if (params.action === "save")
          views = [
            ...views.filter((view) => view.name !== params.name),
            { name: String(params.name), query: String(params.query) },
          ];
        else views = views.filter((view) => view.name !== params.name);
        return { ok: true, changed: true, name: params.name, version: 5 };
      }
      return { ok: true };
    };
    const { showMrReviews } = await import("./MrReviewsRoot");
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const press = async (name: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const type = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const rows = () =>
      [...document.querySelectorAll("[data-mr-key]")].map((node) =>
        Number(node.getAttribute("data-mr-key")!.split("#")[1]),
      );
    const chips = () =>
      [...document.querySelectorAll(".mr-reviews-filter button")].map(
        (node) => node.firstChild?.textContent,
      );
    const command = async (text: string) => {
      await press(":");
      await type(document.activeElement as HTMLInputElement, text);
      await press("Enter");
      await wait(40);
    };

    localStorage.setItem("roamgate:mrReviewsFilter", "all");
    await act(async () => showMrReviews());
    await wait(80);
    expect(rows()).toEqual([3, 1, 2]);
    // Keys complete, then values from the requests shown.
    await press("/");
    const search = document.activeElement as HTMLInputElement;
    expect(search.getAttribute("aria-label")).toBe("Search the reviews");
    await act(async () => search.dispatchEvent(new Event("focus")));
    await type(search, "pro");
    const options = () =>
      [...document.querySelectorAll(".mr-reviews-completions li")].map(
        (node) => node.textContent,
      );
    expect(options()).toEqual(["project:"]);
    await press("Tab");
    expect(search.value).toBe("project:");
    await type(search, "project:media/");
    expect(options()).toEqual([
      "project:media/*",
      "project:media/engine",
      "project:media/plugins",
    ]);
    await press("ArrowDown");
    await press("ArrowDown");
    expect(
      document.querySelector(".mr-reviews-completions li[aria-selected='true']")
        ?.textContent,
    ).toBe("project:media/engine");
    await press("Enter");
    expect(search.value).toBe("project:media/engine ");
    expect(rows()).toEqual([1]);
    await type(search, "-label:audio is:mine");
    expect(rows()).toEqual([2]);
    await type(search, "is:mine");
    expect(rows()).toEqual([1, 2]);

    // :save keeps the search as a view, shown at once as a chip.
    await press("Escape");
    await type(search, "label:audio");
    (document.querySelector(".mr-reviews-panel") as HTMLElement).focus();
    await command("save Audio work");
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.view"),
    ).toEqual([
      "bridge.mr_reviews.view",
      { action: "save", name: "Audio work", query: "label:audio" },
    ]);
    expect(chips()).toEqual(["All", "To review", "Mine", "Audio work"]);
    expect(
      document.querySelector(".mr-reviews-filter [aria-pressed='true']")
        ?.firstChild?.textContent,
    ).toBe("Audio work");
    expect(rows()).toEqual([1]);
    expect(localStorage.getItem("roamgate:mrReviewsFilter")).toBe(
      "view:Audio work",
    );
    expect(document.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "Saved the view Audio work",
    );
    // f cycles through it, F back.
    await press("f");
    expect(localStorage.getItem("roamgate:mrReviewsFilter")).toBe("all");
    await press("F");
    expect(localStorage.getItem("roamgate:mrReviewsFilter")).toBe(
      "view:Audio work",
    );
    await command("mine");
    await command("view audio WORK");
    expect(localStorage.getItem("roamgate:mrReviewsFilter")).toBe(
      "view:Audio work",
    );
    await command("delview Audio work");
    expect(chips()).toEqual(["All", "To review", "Mine"]);
    expect(rows()).toEqual([3, 1, 2]);
  });
}
