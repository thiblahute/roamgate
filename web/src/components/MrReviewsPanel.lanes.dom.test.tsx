import { inIsolatedChild } from "../testIsolated";
import { expect, jest, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the reviews panel's lanes and overrides, in an isolated browser runtime",
    "ROAMGATE_MR_REVIEWS_LANES_DOM_TEST",
    30_000,
  )
) {
  test("lanes, nesting, folding, J/K in a lane, e, :note, E and Undo", async () => {
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
    let order: string[] = [];
    const inbox = () => ({
      entries: [
        entry(1, {
          pipeline: "failed",
          lane: "your_move",
          laneWhy: "pipeline failed",
          next: { text: "Fix the failed pipeline", from: "rule" },
        }),
        entry(2, {
          lane: "your_move",
          next: { text: "rebase it", from: "override", by: "agent" },
          override: {
            next: "rebase it",
            labels: ["api"],
            at: "2026-11-16T10:00:00Z",
            by: "agent",
            marker: "m",
          },
          overrideOutdated: true,
        }),
        entry(3),
        entry(4, {
          lane: "blocked",
          dependsOn: [key(3)],
          parent: key(3),
          next: { text: "Waits for !3", from: "rule" },
        }),
        entry(5, {
          lane: "blocked",
          dependsOn: [key(4)],
          parent: key(4),
          next: { text: "Waits for !4", from: "rule" },
        }),
        entry(6, {
          state: "merged",
          lane: "done",
          next: { text: "Merged", from: "rule" },
        }),
      ],
      hosts: [{ host: "gitlab.example.org", provider: "gitlab", state: "ok" }],
      curation: { state: "off" },
      refreshedAt: new Date().toISOString(),
      refreshing: false,
      hidden: [],
      order,
      orderVersion: 1,
    });
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox") return inbox();
      if (method === "bridge.mr_reviews.links") return { links: {} };
      if (method === "bridge.mr_reviews.override")
        return { ok: true, changed: true, override: null, version: 7 };
      if (method === "bridge.mr_reviews.order" && params.op === "before") {
        order = [key(2), key(1)];
        return { ok: true, version: 2 };
      }
      return { ok: true, version: 8 };
    };
    const lastOverride = () => {
      const found = calls.filter(([m]) => m === "bridge.mr_reviews.override");
      return found[found.length - 1];
    };
    const { showMrReviews } = await import("./boardPanel.testkit");
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
    const selected = () =>
      document
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    const lanes = () =>
      [...document.querySelectorAll(".mr-reviews-lane-title")].map(
        (node) => node.textContent,
      );
    const rows = () =>
      [...document.querySelectorAll(".mr-reviews-lane [data-mr-key]")].map(
        (node) => Number(node.getAttribute("data-mr-key")!.split("#")[1]),
      );

    jest.useFakeTimers();
    try {
      await act(async () => showMrReviews());
      await wait(80);
      // Lanes with counts; the blocked ones drawn under their parent.
      expect(lanes()).toEqual([
        "Needs you2",
        "Waiting1",
        "Blocked2",
        "Merged or closed1",
      ]);
      expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);
      const item = (n: number) =>
        document.querySelector(`[data-mr-key='${key(n)}']`)!.closest("li")!;
      expect(item(4).className).toContain("is-child");
      expect(item(5).getAttribute("style")).toContain("--mr-depth: 2");
      expect(item(5).className).toContain("is-last-child");
      expect(item(3).textContent).toContain("blocks 1");
      expect(item(4).textContent).toContain("after !3");
      // The next step, and who set it; outdated when the request moved on.
      expect(item(1).querySelector(".mr-reviews-next-text")?.textContent).toBe(
        "Fix the failed pipeline",
      );
      const next2 = item(2).querySelector(".mr-reviews-next-text")!;
      expect(next2.className).toContain("is-outdated");
      expect(item(2).querySelector(".mr-reviews-setby")?.textContent).toBe(
        "changed since",
      );
      expect(item(2).textContent).toContain("api");

      // za folds the requests under a parent, then a lane (kept here).
      await keys("jjj");
      expect(selected()).toBe(key(3));
      await keys("za");
      expect(rows()).toEqual([1, 2, 3, 6]);
      await keys("za");
      expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);
      await keys("gg");
      await keys("za");
      expect(rows()).toEqual([3, 4, 5, 6]);
      expect(localStorage.getItem("roamgate:mrReviewsLanesFolded")).toBe(
        '["your_move"]',
      );
      expect(selected()).toBe(key(3));
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(".mr-reviews-lane-title")!
          .click(),
      );
      expect(rows()).toEqual([1, 2, 3, 4, 5, 6]);

      // J / K move within the lane only.
      await keys("gg");
      await keys("j");
      expect(selected()).toBe(key(2));
      await press("K");
      await wait(30);
      expect(
        calls.find(([method]) => method === "bridge.mr_reviews.order")?.[1],
      ).toMatchObject({ op: "before", keys: [key(2)], target: key(1) });
      await keys("jj");
      expect(selected()).toBe(key(3));
      const before = calls.length;
      await press("K");
      await press("J");
      expect(
        calls
          .slice(before)
          .some(([method]) => method === "bridge.mr_reviews.order"),
      ).toBe(false);

      // :note sets the next step; the toast offers Undo.
      await press(":");
      await type(document.activeElement as HTMLInputElement, "note ping bob");
      await press("Enter");
      await wait(30);
      expect(calls[calls.length - 2]).toEqual([
        "bridge.mr_reviews.override",
        { key: key(3), set: { next: "ping bob" } },
      ]);
      expect(document.querySelector(".mr-reviews-undo")?.textContent).toContain(
        "Next step set on !3",
      );
      await press("u");
      await wait(30);
      expect(
        calls.some(
          ([method, params]) =>
            method === "bridge.mr_reviews.order" &&
            params.op === "undo" &&
            params.version === 7,
        ),
      ).toBe(true);

      // e: the form in its details; whose move and labels saved.
      await press("e");
      await wait(30);
      const form =
        document.querySelector<HTMLFormElement>(".mr-override-form")!;
      expect(form).not.toBeNull();
      const [nextBox, depends, labels] = [
        ...form.querySelectorAll<HTMLInputElement>("input[type='text']"),
      ];
      expect(document.activeElement).toBe(nextBox);
      await type(nextBox!, "ask alice");
      await type(depends!, "group/app!1");
      await type(labels!, "infra, api");
      await act(async () => {
        const select = form.querySelector("select")!;
        select.value = "reviewer";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await wait(20);
      expect(lastOverride()).toEqual([
        "bridge.mr_reviews.override",
        {
          key: key(3),
          set: {
            whose: "reviewer",
            next: "ask alice",
            dependsOn: ["group/app!1"],
            labels: ["infra", "api"],
          },
        },
      ]);
      expect(document.querySelector(".mr-override-form")).toBeNull();
      // The details show what is set; E clears it.
      await press("Escape");
      // !2 went before !1 (K above).
      await keys("kk");
      expect(selected()).toBe(key(2));
      await press("E");
      await wait(30);
      expect(lastOverride()).toEqual([
        "bridge.mr_reviews.override",
        { key: key(2), clear: "all" },
      ]);
      await press("i");
      await wait(30);
      const detail = document.querySelector(".mr-reviews-detail")!;
      expect(detail.textContent).toContain("Lane");
      expect(detail.textContent).toContain("set by Claude, changed since");
      expect(detail.textContent).toContain("Set by hand");
    } finally {
      jest.useRealTimers();
    }
  });
}
