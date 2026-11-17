import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the reviews panel's branches headed upstream, in an isolated browser runtime",
    "ROAMGATE_MR_REVIEWS_BRANCHES_DOM_TEST",
    30_000,
  )
) {
  test("branch rows, b, :unsent, their details and workspace", async () => {
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
    const branchKey = "branch:gitlab:gitlab.example.org/media/engine@pool";
    let unsent = false;
    const branchRow = () => ({
      ...entry(0, {
        key: branchKey,
        project: "media/engine",
        title: unsent ? "Rework the pool" : "Add the new pool",
        lane: "not_sent",
        next: {
          text: unsent
            ? "Open the request (3 commits)"
            : "Propose 3 commits upstream",
          from: "rule",
        },
        pipeline: null,
        sourceBranch: "pool",
        branch: {
          name: "pool",
          connectionId: "local",
          connectionLabel: "Desktop",
          workspaceId: "w-pool",
          workspaceLabel: "pool rework",
          path: "/src/engine",
          target: "origin/main",
          ahead: 3,
          behind: 2,
          dirty: 1,
          commits: [
            { sha: "a".repeat(40), subject: "Use the pool", at: "" },
            { sha: "b".repeat(40), subject: "Add the new pool", at: "" },
          ],
          group: "g1",
        },
      }),
      ...(unsent ? { unsent: true } : {}),
    });
    const inbox = () => ({
      entries: [
        entry(1, {
          project: "media/engine",
          fromBranch: "fix",
          local: { unpushed: 2, dirty: 0, workspace: "fix" },
        }),
        branchRow(),
      ],
      hosts: [{ host: "gitlab.example.org", provider: "gitlab", state: "ok" }],
      curation: { state: "off" },
      refreshedAt: new Date().toISOString(),
      refreshing: false,
      hidden: [],
      orderVersion: 1,
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
            [branchKey]: [
              {
                connectionId: "local",
                connectionLabel: "Desktop",
                workspaceId: "w-pool",
                label: "pool rework",
                why: ["branch"],
              },
            ],
          },
        };
      if (method === "bridge.mr_reviews.unsent") {
        unsent = params.unsent !== false;
        return { ok: true, changed: true, version: 9 };
      }
      return { ok: true };
    };
    const { store } = await import("../store");
    const jumps: [string, string][] = [];
    (store as any).jumpToConnectionWorkspace = async (
      connectionId: string,
      workspaceId: string,
    ) => {
      jumps.push([connectionId, workspaceId]);
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
    const row = (key: string) =>
      document.querySelector(`[data-mr-key='${key}']`)!;
    const chips = (key: string) =>
      [...row(key).querySelectorAll(".mr-reviews-chip")].map(
        (node) => node.textContent,
      );

    localStorage.setItem("roamgate:mrReviewsFilter", "mine");
    await act(async () => showMrReviews());
    await wait(80);
    expect(
      [...document.querySelectorAll(".mr-reviews-lane-title")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Waiting1", "Not proposed upstream yet1"]);
    expect(
      row(branchKey).querySelector(".mr-reviews-number")?.textContent,
    ).toBe("pool");
    expect(chips(branchKey)).toEqual(["3 commits", "2 behind", "1 changed"]);
    expect(chips(row(branchKey) ? entry(1).key : "")).toEqual([
      "from fix",
      "2 unpushed",
    ]);
    // A request's reference and title link to it on the forge, in a new
    // tab, and so does an action over its card; a branch not pushed has
    // neither.
    const link = row(entry(1).key).querySelector("a.mr-reviews-forge-link");
    expect(link?.getAttribute("href")).toBe(entry(1).url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toBe("!1 Change 1");
    expect(
      row(entry(1).key)
        .closest("li")
        ?.querySelector("a.mr-reviews-forge")
        ?.getAttribute("aria-label"),
    ).toBe("Open on GitLab (o)");
    expect(row(branchKey).querySelector("a")).toBeNull();
    expect(row(branchKey).closest("li")?.querySelector("a")).toBeNull();
    // b: it will be a request, said with Undo.
    await press("j");
    await press("j");
    expect(
      document
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key"),
    ).toBe(branchKey);
    await press("b");
    await wait(30);
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.unsent"),
    ).toEqual(["bridge.mr_reviews.unsent", { key: branchKey, unsent: true }]);
    expect(chips(branchKey)[0]).toBe("not proposed yet");
    expect(document.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "pool will be a request",
    );
    // Its details: where it is headed, its workspace and commits.
    await press("i");
    await wait(30);
    const detail = document.querySelector(".mr-reviews-detail")!;
    expect(detail.textContent).toContain(
      "media/engine main (origin/main): 3 ahead, 2 behind",
    );
    expect(
      [...detail.querySelectorAll(".mr-branch-commits li")].map(
        (node) => node.textContent,
      ),
    ).toEqual([
      "aaaaaaaaaa Use the pool",
      "bbbbbbbbbb Add the new pool",
      "and 1 more",
    ]);
    expect(detail.textContent).toContain("Back to a branch");
    expect(detail.textContent).not.toContain("Review with Claude");
    await press("Escape");
    // o says it is not on the forge; Enter goes to its workspace.
    await press("o");
    expect(document.querySelector(".mr-reviews-undo")?.textContent).toContain(
      "pool is not on the forge yet",
    );
    await press("Enter");
    expect(jumps).toEqual([["local", "w-pool"]]);
  });
}
