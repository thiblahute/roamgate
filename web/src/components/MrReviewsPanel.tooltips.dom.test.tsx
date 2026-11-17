import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.ROAMGATE_MR_REVIEWS_TOOLTIPS_DOM_TEST !== "1") {
  test("the reviews panel's icon buttons say what they do, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_TOOLTIPS_DOM_TEST: "1" },
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
  }, 60_000);

  test("the tooltip is drawn over the Reviews pane", () => {
    const zIndex = (file: string, selector: string) => {
      const css = readFileSync(join(import.meta.dir, file), "utf8");
      const block = css.slice(css.indexOf(`${selector} {`));
      return Number(/z-index:\s*(\d+)/.exec(block)?.[1]);
    };
    expect(zIndex("GlobalTooltip.css", ".global-tooltip")).toBeGreaterThan(
      zIndex("MrReviewsPanel.css", ".mr-reviews-root"),
    );
  });
} else {
  test("every icon-only button has a name and a title naming its action and key", async () => {
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
    let panelWidth = 2000;
    const rect = browser.HTMLElement.prototype.getBoundingClientRect;
    (browser.HTMLElement.prototype as any).getBoundingClientRect = function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("mr-reviews-panel"))
        return { width: panelWidth, height: 800, top: 0, left: 0 } as DOMRect;
      return rect.call(this);
    };
    // Merged or closed folded, as the user left it.
    localStorage.setItem("roamgate:mrReviewsLanesFolded", '["done"]');

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
    const home = (workspaceId: string, label: string) => ({
      connectionId: "local",
      connectionLabel: "Desktop",
      workspaceId,
      label,
      why: ["branch"],
    });
    (bridge as any).call = async (method: string) => {
      if (method === "bridge.mr_reviews.inbox")
        return {
          entries: [
            entry(1),
            entry(2),
            entry(3),
            mine(4, "your_move"),
            mine(5, "your_move"),
            mine(6, "waiting"),
            mine(7, "done"),
          ],
          hosts: [
            { host: "gitlab.example.org", provider: "gitlab", state: "ok" },
          ],
          curation: { state: "off" },
          refreshedAt: new Date().toISOString(),
          refreshing: false,
          hidden: [],
          orderVersion: 1,
        };
      if (method === "bridge.mr_reviews.settings.get") return {};
      if (method === "bridge.mr_reviews.links")
        return {
          links: {
            [key(2)]: [home("w-2", "webrtc-ice-restart")],
            [key(4)]: [
              home("w-4", "pitch fix"),
              home("w-4b", "pitch fix 2"),
              home("w-4c", "pitch fix 3"),
            ],
          },
        };
      return { ok: true };
    };
    const { showMrReviews, closeMrReviews } = await import("./MrReviewsRoot");
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const press = async (name: string) => {
      await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const keys = async (text: string) => {
      for (const each of text) await press(each);
    };

    /** The icon-only buttons (no text of their own but a count) and what they say. */
    const iconButtons = () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".mr-reviews-panel button",
        ),
      ].filter((button) => !/[A-Za-z]/.test(button.textContent?.trim() ?? ""));
    const named = (button: HTMLButtonElement) =>
      !!button.getAttribute("aria-label")?.trim() &&
      !!button.getAttribute("title")?.trim();
    const unnamed = () =>
      iconButtons()
        .filter((button) => !named(button))
        .map((button) => button.outerHTML.slice(0, 160));
    const titles = () =>
      new Set(iconButtons().map((button) => button.getAttribute("title")));

    const seen = new Set<string>();
    const look = () => {
      expect(unnamed()).toEqual([]);
      for (const title of titles()) if (title) seen.add(title);
    };

    // The board: every row's buttons, each row selected in turn.
    await act(async () => showMrReviews());
    await wait(80);
    expect(document.querySelector(".mr-reviews-board")).not.toBeNull();
    look();
    for (let step = 0; step < 4; step++) {
      await keys("j");
      look();
    }
    await keys("l");
    look();
    await keys("j");
    look();
    await keys("l");
    look();
    // The drag handle says what it is for too.
    const grip = document.querySelector(".mr-reviews-grip");
    expect(grip?.getAttribute("title")).toBe("Drag to reorder (J / K)");
    // The folded column's header.
    const folded = [
      ...document.querySelectorAll<HTMLButtonElement>(".mr-reviews-lane-title"),
    ].find((button) => button.textContent?.startsWith("Merged or closed"));
    expect(folded?.title).toBe("Expand Merged or closed (za)");
    await act(async () => closeMrReviews());
    await wait(20);

    // The single list.
    panelWidth = 600;
    await act(async () => showMrReviews());
    await wait(80);
    expect(document.querySelector(".mr-reviews-board")).toBeNull();
    look();
    for (let step = 0; step < 7; step++) {
      await keys("j");
      look();
    }
    await act(async () => closeMrReviews());
    await wait(20);

    for (const title of [
      "Refresh (r)",
      "Keys (?)",
      "Maximize: fill the window",
      "Settings: hosts, followed projects, checkout",
      "Go to its home: webrtc-ice-restart (w)",
      "Go to its home: pitch fix (w); 2 more in its details (2w...)",
      "Start a review with a home (gH): a workspace of its own with a Claude session told its job",
      "Pin it on top (P)",
      "Hide it from the view (dd, u undoes)",
      "Move up (K)",
      "Move down (J)",
    ])
      expect(seen).toContain(title);
    expect([...seen].some((title) => title.startsWith("Close (Esc"))).toBe(
      true,
    );
  });
}
