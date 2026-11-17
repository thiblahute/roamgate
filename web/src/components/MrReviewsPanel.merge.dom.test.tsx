import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_MERGE_DOM_TEST !== "1") {
  test("the reviews panel's scheduled merges and merge bots, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_MERGE_DOM_TEST: "1" },
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
  test("Merging lane, merge chips, the detail's Merge line, the merge filters, the merge settings", async () => {
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
    const soon = new Date(Date.now() + 26 * 60 * 60_000).toISOString();
    const inbox = () => ({
      entries: [
        entry(1, {
          lane: "your_move",
          laneWhy: "marge-bot could not merge",
          next: { text: "marge-bot could not merge: CI failed!", from: "rule" },
          merge: {
            bot: {
              name: "marge-bot",
              via: "assignee",
              queued: false,
              failed: { reason: "CI failed!", at: "2026-11-16T10:00:00Z" },
            },
          },
        }),
        entry(2, {
          lane: "waiting",
          laneWhy: "merge after 2 days",
          next: {
            text: "Waiting on time: 2 days from the label",
            from: "rule",
          },
          labels: ["Merge after: 2 days"],
          merge: {
            after: {
              label: "Merge after: 2 days",
              delayMs: 2 * 86_400_000,
              delay: "2 days",
              from: "label",
              since: "2026-11-15T14:00:00Z",
              at: soon,
              ready: false,
            },
          },
        }),
        entry(3, {
          lane: "merging",
          laneWhy: "queued to merge by marge-bot",
          next: {
            text: "marge-bot merges it: nothing to do unless it fails",
            from: "rule",
          },
          merge: {
            bot: { name: "marge-bot", via: "assignee", queued: true },
          },
        }),
        entry(4),
      ],
      hosts: [{ host: "gitlab.example.org", provider: "gitlab", state: "ok" }],
      curation: { state: "off" },
      refreshedAt: new Date().toISOString(),
      refreshing: false,
      hidden: [],
      orderVersion: 1,
    });
    const saved: unknown[] = [];
    let merge: Record<string, unknown> = { scopes: {} };
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (method === "bridge.mr_reviews.inbox") return inbox();
      if (method === "bridge.mr_reviews.links") return { links: {} };
      if (method === "bridge.mr_reviews.settings.get")
        return {
          hosts: [],
          discoveredHosts: [{ host: "gitlab.example.org", provider: "gitlab" }],
          followed: [],
          checkout: "immediately",
          retentionDays: 3,
          curation: false,
          inference: true,
          inferenceHours: 12,
          suggestDays: 30,
          hints: "",
          treeGroups: {},
          clones: {},
          order: [],
          pinned: [],
          hidden: [],
          overrides: {},
          staleDays: 90,
          views: [],
          upstreamGroups: [],
          upstreamSkip: [],
          unsent: [],
          efforts: [],
          merge,
        };
      if (method === "bridge.mr_reviews.settings.update") {
        const settings = params.settings as Record<string, unknown>;
        saved.push(settings.merge);
        merge = settings.merge as Record<string, unknown>;
        return { ...settings, merge };
      }
      return { ok: true, version: 8 };
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
    const lanes = () =>
      [...document.querySelectorAll(".mr-reviews-lane-title")].map(
        (node) => node.textContent,
      );
    const item = (n: number) =>
      document.querySelector(`[data-mr-key='${key(n)}']`)!.closest("li")!;
    const chips = (n: number) =>
      [...item(n).querySelectorAll(".mr-reviews-chip")].map((node) => ({
        text: node.textContent,
        tone: node.className.replace(/.*is-/, ""),
        title: node.getAttribute("title") ?? "",
      }));

    await act(async () => showMrReviews());
    await wait(80);
    // Merging is a lane of its own, after Waiting.
    expect(lanes()).toEqual(["Your move1", "Waiting2", "Merging1"]);
    expect(
      document
        .querySelector(".mr-reviews-lane.is-merging")!
        .querySelector("[data-mr-key]")!
        .getAttribute("data-mr-key"),
    ).toBe(key(3));
    // A failed attempt: Your move with the bot's reason.
    expect(item(1).querySelector(".mr-reviews-next-text")?.textContent).toBe(
      "marge-bot could not merge: CI failed!",
    );
    expect(chips(1)[0]).toMatchObject({
      text: "marge-bot could not merge",
      tone: "bad",
    });
    expect(chips(1)[0]!.title).toContain("CI failed!");
    // A scheduled merge: when it becomes mergeable.
    const scheduled = chips(2).find((chip) =>
      chip.text?.startsWith("merge after"),
    )!;
    expect(scheduled.text).toMatch(
      /^merge after 2 days · mergeable (tomorrow|[A-Z][a-z]{2}) \d\d:\d\d$/,
    );
    expect(scheduled.title).toContain("from when the label was added");
    expect(chips(3)[0]).toMatchObject({
      text: "queued to merge by marge-bot",
      tone: "good",
    });

    // The detail's Merge line.
    await press("j");
    await press("j");
    await press("i");
    await wait(30);
    expect(document.querySelector(".mr-reviews-merge")?.textContent).toContain(
      '"Merge after: 2 days": mergeable',
    );
    expect(document.querySelector(".mr-reviews-merge")?.textContent).toContain(
      "2 days from when the label was added",
    );
    await press("Escape");
    await wait(30);
    // !4 waits for review; !3, in Merging, comes after it.
    await press("j");
    await press("j");
    await press("i");
    await wait(30);
    const detail = document.querySelector(".mr-reviews-detail")!;
    expect(detail.textContent).toContain("Merge");
    expect(detail.textContent).toContain(
      "queued to merge by marge-bot, recognized by marge-bot: it is assigned",
    );
    await press("Escape");
    await wait(30);

    // The merge filters.
    const search = document.querySelector<HTMLInputElement>(
      "input[aria-label='Search the reviews']",
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      browser.HTMLInputElement.prototype,
      "value",
    )!.set!;
    const find = async (text: string) => {
      await act(async () => {
        setter.call(search, text);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await wait(30);
      return [...document.querySelectorAll("[data-mr-key]")].map((node) =>
        node.getAttribute("data-mr-key"),
      );
    };
    expect(await find("bot:failed")).toEqual([key(1)]);
    expect(await find("state:merging")).toEqual([key(3)]);
    expect(await find("waiting:time")).toEqual([key(2)]);
    expect(await find("merge-after:yes")).toEqual([key(2)]);
    await find("");

    // The settings: a scope, a list set there, then turned off.
    const { createRoot } = await import("react-dom/client");
    const { MrMergeSettingsSection } = await import("./MrMergeSettings");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    const changes: unknown[] = [];
    let current: any = { scopes: {} };
    const draw = () =>
      act(async () =>
        root.render(
          React.createElement(MrMergeSettingsSection, {
            merge: current,
            busy: false,
            onSave: (next: unknown) => {
              changes.push(next);
              current = next;
              void draw();
            },
          }),
        ),
      );
    await draw();
    const boxes = () =>
      [
        ...host.querySelectorAll("textarea"),
      ] as unknown as HTMLTextAreaElement[];
    // Every host: the defaults shown as placeholders, nothing set.
    expect(boxes()).toHaveLength(4);
    expect(boxes()[1]!.getAttribute("placeholder")).toContain("marge-bot");
    expect(host.textContent).toContain("Merge bots (inherited)");
    // A project scope; its bots set, saved as that scope's list.
    const scopeInput = host.querySelector<HTMLInputElement>(
      "input[aria-label='Host, group or project']",
    )!;
    await act(async () => {
      setter.call(scopeInput, "gitlab.example.org/media/engine");
      scopeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const addScope = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add a scope"),
    )!;
    await act(async () => addScope.click());
    expect(
      host.querySelector("[role='tab'][aria-selected='true']")?.textContent,
    ).toBe("gitlab.example.org/media/engine");
    const textSetter = Object.getOwnPropertyDescriptor(
      browser.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      const bots = boxes()[1]!;
      textSetter.call(bots, "robot\n\n@merger ");
      bots.dispatchEvent(new Event("input", { bubbles: true }));
      bots.dispatchEvent(new Event("blur", { bubbles: false }));
      bots.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    await wait(20);
    expect(changes[changes.length - 1]).toEqual({
      scopes: {
        "gitlab.example.org/media/engine": { bots: ["robot", "@merger"] },
      },
    });
    expect(host.textContent).toContain("Merge bots (set here)");
    // Off here: an empty list.
    const off = [...host.querySelectorAll("button")].filter(
      (button) => button.textContent === "Off here",
    )[0]!;
    await act(async () => off.click());
    await wait(20);
    expect(
      (changes[changes.length - 1] as any).scopes[
        "gitlab.example.org/media/engine"
      ].afterLabels,
    ).toEqual([]);
    await act(async () => root.unmount());
  });
}
