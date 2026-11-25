import { inIsolatedChild } from "../testIsolated";
import { expect, jest, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the reviews panel's kept search, homes and board, in an isolated browser runtime",
    "ROAMGATE_MR_REVIEWS_HOME_DOM_TEST",
    60_000,
  )
) {
  test("kept search, homes on click and Enter, Start a review with a home, the board's columns", async () => {
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
    // The panel's width, as a layout would give it: narrow until the board.
    let panelWidth = 420;
    const rect = browser.HTMLElement.prototype.getBoundingClientRect;
    (browser.HTMLElement.prototype as any).getBoundingClientRect = function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("mr-reviews-panel"))
        return { width: panelWidth, height: 800, top: 0, left: 0 } as DOMRect;
      return rect.call(this);
    };

    const React = await import("react");
    const { act } = React;
    const { bridge } = await import("../api");
    const { store } = await import("../store");
    const jumps: [string, string][] = [];
    (store as any).jumpToConnectionWorkspace = async (
      connectionId: string,
      workspaceId: string,
    ) => {
      jumps.push([connectionId, workspaceId]);
    };
    const own = {
      approvedBy: [] as string[],
      approved: false,
      changesRequested: [] as string[],
      unresolved: 0,
      conflicts: false,
      needsRebase: false,
    };
    const key = (n: number) => `gitlab:gitlab.example.org/gstreamer/app#${n}`;
    const entry = (number: number, extra: Record<string, unknown> = {}) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "gstreamer/app",
      number,
      key: key(number),
      url: `https://gitlab.example.org/gstreamer/app/-/merge_requests/${number}`,
      title: `Change ${number}`,
      author: "alice",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: `topic-${number}`,
      targetBranch: "main",
      pipeline: "success",
      notes: 0,
      reasons: ["review_requested"],
      section: "mine",
      unread: { newCommits: false, newNotes: 0, changed: false },
      isNew: false,
      ...extra,
    });
    const mine = (number: number, lane: string) =>
      entry(number, {
        author: "me",
        reasons: ["authored"],
        section: "authored",
        own,
        lane,
        next: { text: `Next for ${number}`, from: "rule" },
      });
    let panel: { search: string; filter: string; at: string } | undefined;
    const inbox = () => ({
      entries: [
        entry(1),
        entry(2),
        mine(3, "your_move"),
        mine(4, "your_move"),
        mine(5, "waiting"),
        mine(6, "waiting"),
        mine(7, "waiting"),
        mine(8, "done"),
      ],
      hosts: [{ host: "gitlab.example.org", provider: "gitlab", state: "ok" }],
      curation: { state: "off" },
      refreshedAt: new Date().toISOString(),
      refreshing: false,
      hidden: [],
      views: [{ name: "gst", query: "project:gstreamer/*" }],
      orderVersion: 1,
      ...(panel ? { panel } : {}),
    });
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox") return inbox();
      if (method === "bridge.mr_reviews.settings.get")
        return { homePrompt: "Be the home of {url}" };
      if (method === "bridge.mr_reviews.links")
        return {
          links: {
            [key(2)]: [
              {
                connectionId: "local",
                connectionLabel: "Desktop",
                workspaceId: "w-2",
                label: "app !2",
                why: ["name"],
              },
            ],
            // Only the shared review workspace: no home.
            [key(1)]: [
              {
                connectionId: "local",
                connectionLabel: "Desktop",
                workspaceId: "w-reviews",
                label: "Reviews \u00b7 app",
                why: ["review"],
              },
            ],
          },
        };
      if (method === "bridge.mr_reviews.panel") {
        panel = {
          search: (params.search as string) ?? panel?.search ?? "",
          filter: (params.filter as string) ?? panel?.filter ?? "all",
          at: new Date(Date.now()).toISOString(),
        };
        return { panel };
      }
      if (method === "bridge.mr_reviews.open" && params.home) {
        const home = params.home as {
          connection_id: string;
          workspace_id: string;
        };
        return {
          connectionId: home.connection_id,
          workspaceId: home.workspace_id,
          sessionId: "rs-home",
          snapshot: { session: { id: "rs-home" }, threads: [] },
        };
      }
      if (method === "bridge.mr_reviews.open")
        return {
          connectionId: "local",
          workspaceId: "w-reviews",
          sessionId: "rs-shared",
          snapshot: { session: { id: "rs-shared" }, threads: [] },
          worktree: "/x",
          checkout: { state: "deferred" },
        };
      if (method === "bridge.mr_reviews.home")
        return {
          connectionId: "local",
          workspaceId: "w-home-1",
          sessionId: "rs-made",
          snapshot: { session: { id: "rs-made" }, threads: [] },
          created: true,
          branch: "topic-1",
          agent: { state: "starting", paneId: "p9" },
        };
      return { ok: true };
    };
    const { showMrReviews, closeMrReviews } = await import(
      "./boardPanel.testkit"
    );
    // Timers move only when told; the calls' promises settle in between.
    const wait = async (ms: number) => {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
      for (let i = 0; i < 5; i++) await act(async () => {});
    };
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
      });
      await wait(20);
    };
    const keys = async (text: string) => {
      for (const each of text) await press(each);
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
    const search = () =>
      document.querySelector<HTMLInputElement>(".mr-reviews-search")!;
    const selected = () =>
      document
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    const pressed = () =>
      [
        ...document.querySelectorAll(".mr-reviews-filter [aria-pressed=true]"),
      ].map((node) => node.firstChild?.textContent);
    const open = async () => {
      await act(async () => showMrReviews());
      await wait(80);
    };
    const close = async () => {
      await act(async () => closeMrReviews());
      await wait(20);
    };
    const callsOf = (method: string) =>
      calls.filter(([each]) => each === `bridge.mr_reviews.${method}`);

    jest.useFakeTimers();
    try {
      // 1. The search is kept: written a moment after the typing stops, read
      // back on the next run; the saved view it is shows selected.
      await open();
      expect(search().value).toBe("");
      expect(pressed()).toEqual(["All"]);
      await act(async () => search().focus());
      await type(search(), "project:gstreamer/*");
      expect(callsOf("panel")).toHaveLength(0);
      await wait(700);
      expect(callsOf("panel").map(([, params]) => params)).toEqual([
        { search: "project:gstreamer/*" },
      ]);
      expect(localStorage.getItem("roamgate:mrReviewsSearch")).toBe(
        "project:gstreamer/*",
      );
      expect(pressed()).toEqual(["gst"]);
      await close();
      await open();
      expect(search().value).toBe("project:gstreamer/*");
      expect(pressed()).toEqual(["gst"]);
      // The filter is kept and sent at once.
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".mr-reviews-filter button")!
          .click(),
      );
      await wait(30);
      expect(callsOf("panel").slice(-1)[0]?.[1]).toEqual({ filter: "all" });
      // Another device wrote later: taken on the next read.
      await close();
      panel = {
        search: "label:audio",
        filter: "review",
        at: new Date(Date.now() + 60_000).toISOString(),
      };
      await open();
      expect(search().value).toBe("label:audio");
      expect(pressed()[0]).toBe("To review");
      // Esc empties it, for every device too.
      await act(async () => search().focus());
      await press("Escape");
      await wait(700);
      expect(search().value).toBe("");
      expect(callsOf("panel").slice(-1)[0]?.[1]).toEqual({ search: "" });
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".mr-reviews-filter button")!
          .click(),
      );
      await wait(30);

      // 2. A click on a request with a home: its review there, not in the
      // shared review workspace; one whose only workspace is the shared one
      // opens as before.
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(`[data-mr-key='${key(2)}']`)!
          .click(),
      );
      await wait(50);
      expect(callsOf("open").map(([, params]) => params)).toEqual([
        { key: key(2), home: { connection_id: "local", workspace_id: "w-2" } },
      ]);
      expect(jumps).toEqual([["local", "w-2"]]);
      expect(document.querySelector(".mr-reviews-panel")).toBeNull();
      await open();
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(`[data-mr-key='${key(1)}']`)!
          .click(),
      );
      await wait(50);
      expect(callsOf("open").slice(-1)[0]?.[1]).toEqual({ key: key(1) });
      expect(jumps.slice(-1)[0]).toEqual(["local", "w-reviews"]);

      // 3. Start a review with a home: gH, the row's button, the details' one
      // with the prompt in its tooltip.
      await open();
      await keys("j");
      expect(selected()).toBe(key(1));
      expect(
        document.querySelector(
          "button[aria-label='Start a review with a home (gH)']",
        ),
      ).not.toBeNull();
      await keys("gH");
      await wait(50);
      expect(callsOf("home").map(([, params]) => params)).toEqual([
        { key: key(1) },
      ]);
      expect(jumps.slice(-1)[0]).toEqual(["local", "w-home-1"]);
      expect(document.querySelector(".mr-reviews-panel")).toBeNull();
      await open();
      await keys("j");
      await keys("i");
      const start = [...document.querySelectorAll("button")].find(
        (each) => each.textContent?.trim() === "Start a review with a home",
      )!;
      expect(start.title).toContain(
        "Be the home of https://gitlab.example.org/gstreamer/app/-/merge_requests/1",
      );
      await press("Escape");
      // A request with a home has no row button for it.
      await keys("j");
      expect(selected()).toBe(key(2));
      expect(
        document.querySelector(
          "button[aria-label='Start a review with a home (gH)']",
        ),
      ).toBeNull();
      await press(":");
      const command = document.querySelector<HTMLInputElement>(
        "input[aria-label='Command']",
      )!;
      await type(command, "home");
      await press("Enter");
      await wait(50);
      expect(callsOf("home").slice(-1)[0]?.[1]).toEqual({ key: key(2) });

      // 4. A wide pane: the board, one column per section and lane.
      await open();
      expect(document.querySelector(".mr-reviews-board")).toBeNull();
      await close();
      panelWidth = 2000;
      await open();
      const panelNode = document.querySelector(".mr-reviews-panel")!;
      expect(panelNode.className).toContain("is-board");
      const board = document.querySelector(".mr-reviews-board")!;
      expect(board).not.toBeNull();
      expect(
        [...board.querySelectorAll(".mr-reviews-lane-title")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["Needs you2", "Waiting3", "Merged or closed1"]);
      // j / k stay in the column; h / l and Tab go across, at the same height.
      await keys("j");
      expect(selected()).toBe(key(1));
      await keys("jjj");
      expect(selected()).toBe(key(2));
      await keys("l");
      expect(selected()).toBe(key(4));
      await keys("k");
      expect(selected()).toBe(key(3));
      await press("Tab");
      expect(selected()).toBe(key(5));
      await keys("jj");
      expect(selected()).toBe(key(7));
      await keys("l");
      expect(selected()).toBe(key(8));
      await keys("l");
      expect(selected()).toBe(key(8));
      await press("Tab", { shiftKey: true });
      expect(selected()).toBe(key(5));
      await keys("hh");
      expect(selected()).toBe(key(1));
      // Narrow again: the stacked list.
      panelWidth = 600;
      await act(async () => window.dispatchEvent(new Event("resize")));
      await wait(20);
      expect(document.querySelector(".mr-reviews-board")).toBeNull();
      await keys("j");
      expect(selected()).toBe(key(2));
      await keys("j");
      expect(selected()).toBe(key(3));
      await close();
    } finally {
      jest.useRealTimers();
    }
  });
}
