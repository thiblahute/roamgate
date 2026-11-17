import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_OWN_DOM_TEST !== "1") {
  test("the reviews panel's own requests, pins, keys and place, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_OWN_DOM_TEST: "1" },
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
  test("own requests, workspaces, pins, zz, the command line, fullscreen and height", async () => {
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
    const scrolled: { key: string | null; block: unknown }[] = [];
    (browser.HTMLElement.prototype as any).scrollIntoView = function (
      this: HTMLElement,
      options?: { block?: string },
    ) {
      if (options?.block !== "nearest")
        scrolled.push({
          key:
            this.querySelector("[data-mr-key]")?.getAttribute("data-mr-key") ??
            null,
          block: options?.block,
        });
    };
    // The page's workspace surfaces, where Ranger sits: the panel matches them.
    const surfaces = document.createElement("div");
    surfaces.className = "workspace-surfaces";
    surfaces.getBoundingClientRect = () =>
      ({
        top: 44,
        left: 260,
        right: 1270,
        bottom: 770,
        width: 1010,
        height: 726,
      }) as DOMRect;
    document.body.append(surfaces);

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
    const entry = (number: number, section: string, extra = {}) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number,
      key: `gitlab:gitlab.example.org/group/app#${number}`,
      url: `https://gitlab.example.org/group/app/-/merge_requests/${number}`,
      title: `Change ${number}`,
      author: section === "authored" ? "me" : "alice",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: `topic-${number}`,
      targetBranch: "main",
      pipeline: "success",
      notes: 3,
      reasons:
        section === "mine"
          ? ["review_requested"]
          : section === "authored"
            ? ["authored"]
            : [],
      section,
      unread: { newCommits: false, newNotes: 0, changed: false },
      isNew: false,
      ...extra,
    });
    let pinned = false;
    const inbox = () => ({
      entries: [
        ...(pinned
          ? [entry(1, "pinned", { reasons: ["review_requested"] })]
          : []),
        ...(pinned ? [] : [entry(1, "mine")]),
        entry(5, "authored", {
          pipeline: "failed",
          own: { ...own, approvedBy: ["bob"], unresolved: 2, conflicts: true },
          unread: {
            newCommits: false,
            newNotes: 1,
            changed: true,
            pipeline: "failed",
            newApprovals: ["bob"],
          },
        }),
        entry(6, "authored", { state: "merged", own }),
      ],
      hosts: [{ host: "gitlab.example.org", provider: "gitlab", state: "ok" }],
      curation: { state: "off" },
      refreshedAt: new Date().toISOString(),
      refreshing: false,
      hidden: [],
    });
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox") return inbox();
      if (method === "bridge.mr_reviews.links")
        return {
          links: {
            "gitlab:gitlab.example.org/group/app#5": [
              {
                connectionId: "mac",
                connectionLabel: "Mac",
                workspaceId: "w-pitch",
                label: "pitch fix",
                why: ["branch"],
              },
              {
                connectionId: "local",
                connectionLabel: "Desktop",
                workspaceId: "w-other",
                label: "app !5",
                why: ["name"],
              },
            ],
          },
        };
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
          needClone: {
            host: "gitlab.example.org",
            project: "group/app",
            connections: [],
          },
        };
      if (method === "bridge.mr_reviews.pin") {
        pinned = true;
        return { ok: true, key: "gitlab:gitlab.example.org/group/app#1" };
      }
      if (method === "bridge.mr_reviews.unpin") {
        pinned = false;
        return { ok: true };
      }
      return { ok: true };
    };
    const { handleMrReviewsShortcut } = await import("../mrReviewsOpen");
    window.addEventListener(
      "keydown",
      (event) => handleMrReviewsShortcut(event),
      { capture: true },
    );
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
    const keys = async (text: string) => {
      for (const each of text) await press(each);
    };
    const toggle = async () => {
      await press("m", { altKey: true, code: "KeyM" });
      await wait(350);
    };
    const panel = () =>
      document.querySelector<HTMLElement>(".mr-reviews-panel");
    const selected = () =>
      document
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    const titles = () =>
      [...document.querySelectorAll(".mr-reviews-section-title")].map(
        (node) => node.firstChild?.textContent,
      );

    // The toggle shortcut brings it up, as tall as the surfaces Ranger fills.
    await toggle();
    expect(panel()).not.toBeNull();
    expect(panel()!.className).toContain("is-floating");
    expect(panel()!.style.top).toBe("44px");
    expect(panel()!.style.bottom).toBe("30px");
    expect(panel()!.style.right).toBe("10px");

    // Own requests: Mine, with where each stands; what changed is marked.
    expect(titles()).toEqual(["To review", "Mine", "Suggested"]);
    const mine = document.querySelector("section[aria-label='Mine']")!;
    const row5 = mine.querySelector(
      "[data-mr-key='gitlab:gitlab.example.org/group/app#5']",
    )!;
    const chips = [...row5.querySelectorAll(".mr-reviews-chip")].map((chip) => [
      chip.textContent,
      chip.classList.contains("is-changed"),
    ]);
    expect(chips).toEqual([
      ["pipeline failed", true],
      ["approved by bob", true],
      ["2 unresolved", false],
      ["conflicts", false],
    ]);
    expect(row5.querySelector(".mr-reviews-unread")?.textContent).toBe(
      "pipeline failed, approved by bob, 1 new comment",
    );
    expect(mine.textContent).toContain("merged");

    // Filter: f cycles all, to review, mine; :all goes back.
    await press("f");
    expect(titles()).toEqual(["To review", "Suggested"]);
    await press("f");
    expect(titles()).toEqual(["Mine"]);
    expect(localStorage.getItem("roamgate:mrReviewsFilter")).toBe("mine");
    await press(":");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Command");
    await act(async () => {
      const input = document.activeElement as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "all");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Enter");
    expect(titles()).toEqual(["To review", "Mine", "Suggested"]);
    expect(document.querySelector("[aria-label='Command']")).toBeNull();

    // Its workspaces: the row's button, w and 2w, on their connections.
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.links")?.[1],
    ).toEqual({
      keys: [
        "gitlab:gitlab.example.org/group/app#1",
        "gitlab:gitlab.example.org/group/app#5",
        "gitlab:gitlab.example.org/group/app#6",
      ],
    });
    await keys("jj");
    expect(selected()).toEndWith("#5");
    // zz, zt, zb place the selected request.
    await keys("zz");
    await keys("zt");
    await keys("zb");
    expect(scrolled.map((each) => each.block)).toEqual([
      "center",
      "start",
      "end",
    ]);
    expect(scrolled.every((each) => each.key?.endsWith("#5"))).toBe(true);
    await keys("2w");
    expect(jumps).toEqual([["local", "w-other"]]);
    expect(panel()).toBeNull();
    expect(
      calls.some(
        ([method, params]) =>
          method === "bridge.mr_reviews.seen" &&
          params.key === "gitlab:gitlab.example.org/group/app#5",
      ),
    ).toBe(true);
    await toggle();
    const button = document.querySelector<HTMLButtonElement>(
      "button[aria-label='Go to its workspace pitch fix']",
    )!;
    await act(async () => button.click());
    expect(jumps[jumps.length - 1]).toEqual(["mac", "w-pitch"]);
    // Enter with a home: its review in the first one, not in the
    // project's review workspace.
    await toggle();
    await keys("jj");
    expect(selected()).toEndWith("#5");
    await press("Enter");
    await wait(30);
    expect(jumps.slice(1)).toEqual([
      ["mac", "w-pitch"],
      ["mac", "w-pitch"],
    ]);
    expect(
      calls.filter(([method]) => method === "bridge.mr_reviews.open"),
    ).toEqual([
      [
        "bridge.mr_reviews.open",
        {
          key: "gitlab:gitlab.example.org/group/app#5",
          home: { connection_id: "mac", workspace_id: "w-pitch" },
        },
      ],
    ]);
    expect(panel()).toBeNull();
    // One with none says so, and goes nowhere.
    await toggle();
    await keys("j");
    expect(selected()).toEndWith("#1");
    await press("w");
    expect(document.body.textContent).toContain(
      "None of your workspaces is on !1's branch or named after it",
    );
    expect(jumps).toHaveLength(3);
    // Enter without a workspace: its review, as before.
    await press("Enter");
    await wait(30);
    expect(
      calls.filter(([method]) => method === "bridge.mr_reviews.open").slice(1),
    ).toEqual([
      [
        "bridge.mr_reviews.open",
        { key: "gitlab:gitlab.example.org/group/app#1" },
      ],
    ]);
    expect(jumps).toHaveLength(3);
    expect(document.body.textContent).toContain("Where is your clone?");
    await press("Escape");
    expect(document.body.textContent).not.toContain("Where is your clone?");

    // P pins the selected request on top, P again unpins it; :pin, :unpin.
    await press("P");
    await wait(20);
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.pin")?.[1],
    ).toEqual({
      text: "https://gitlab.example.org/group/app/-/merge_requests/1",
    });
    expect(titles()).toEqual(["Pinned", "To review", "Mine", "Suggested"]);
    expect(selected()).toEndWith("#1");
    expect(document.body.textContent).toContain("Pinned !1");
    await press("P");
    await wait(20);
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.unpin")?.[1],
    ).toEqual({ key: "gitlab:gitlab.example.org/group/app#1" });
    expect(titles()).toEqual(["To review", "Mine", "Suggested"]);
    const command = async (text: string) => {
      await press(":");
      await act(async () => {
        const input = document.activeElement as HTMLInputElement;
        Object.getOwnPropertyDescriptor(
          browser.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await press("Enter");
      await wait(20);
    };
    await command("pin");
    expect(titles()[0]).toBe("Pinned");
    await command("unpin");
    expect(titles()[0]).toBe("To review");
    expect(
      calls.filter(([method]) => method === "bridge.mr_reviews.pin"),
    ).toHaveLength(2);

    // Full screen: Esc hides it (search closed first), and it comes back
    // full screen.
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Maximize Reviews']",
        )!
        .click(),
    );
    expect(panel()!.className).toContain("is-maximized");
    expect(panel()!.style.left).toBe("260px");
    panel()!.focus();
    await press("/");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Search the reviews",
    );
    await press("Escape");
    expect(panel()).not.toBeNull();
    expect(panel()!.className).toContain("is-maximized");
    await press("Escape");
    expect(panel()).toBeNull();
    await toggle();
    expect(panel()!.className).toContain("is-maximized");
    // Restored by its button only, and remembered so.
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Restore Reviews']",
        )!
        .click(),
    );
    await press("Escape");
    expect(panel()).toBeNull();
    await toggle();
    expect(panel()!.className).toContain("is-floating");
    await press("m", { altKey: true, code: "KeyM" });
    expect(panel()).toBeNull();
  });
}
