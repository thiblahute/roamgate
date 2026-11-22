import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "the reviews panel, in an isolated browser runtime",
    "ROAMGATE_MR_REVIEWS_DOM_TEST",
    30_000,
  )
) {
  test("sections, keys, detail and feedback", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
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
    const entry = (number: number, section: string, extra = {}) => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number,
      key: `gitlab:gitlab.example.org/group/app#${number}`,
      url: `https://gitlab.example.org/group/app/-/merge_requests/${number}`,
      title: `Change ${number}`,
      author: "alice",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: "topic",
      targetBranch: "main",
      pipeline: "failed",
      notes: 3,
      reasons: section === "mine" ? ["review_requested"] : [],
      section,
      unread: null,
      isNew: true,
      ...extra,
    });
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox")
        return {
          entries: [
            entry(1, "mine", { drafts: 2 }),
            entry(2, "mine", {
              isNew: false,
              unread: { newCommits: true, newNotes: 0, changed: true },
            }),
            entry(3, "suggested", { reason: "touches ges-timeline.c" }),
          ],
          hosts: [
            { host: "gitlab.example.org", provider: "gitlab", state: "ok" },
            {
              host: "github.com",
              provider: "github",
              state: "not_signed_in",
              message: "Not signed in to github.com",
            },
          ],
          curation: { state: "idle" },
          refreshedAt: new Date().toISOString(),
          refreshing: false,
        };
      return { ok: true };
    };
    const { MrReviewsPanel } = await import("./MrReviewsPanel");
    const host = document.createElement("div");
    document.body.append(host);
    let closed = 0;
    const root = createRoot(host);
    await act(async () => {
      root.render(<MrReviewsPanel onClose={() => closed++} />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const panel = host.querySelector<HTMLElement>(".mr-reviews-panel")!;
    const titles = [...host.querySelectorAll(".mr-reviews-section-title")].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(["To review2", "Mine0", "Suggested1"]);
    expect(host.textContent).toContain("2 drafts on GitLab");
    expect(host.textContent).toContain("new commits");
    expect(host.textContent).toContain("touches ges-timeline.c");
    expect(host.textContent).toContain("Not signed in to github.com");
    const key = async (name: string) =>
      act(async () => {
        panel.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    const selected = () =>
      host
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    await key("j");
    expect(selected()).toEndWith("#1");
    await key("j");
    await key("j");
    expect(selected()).toEndWith("#3");
    await key("x");
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.feedback")?.[1],
    ).toEqual({
      key: "gitlab:gitlab.example.org/group/app#3",
      verdict: "not_interested",
    });
    await key("k");
    await key("i");
    expect(host.textContent).toContain("All reviews");
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.seen")?.[1],
    ).toEqual({ key: "gitlab:gitlab.example.org/group/app#2" });
    await key("Escape");
    expect(host.textContent).not.toContain("All reviews");
    await key("Escape");
    expect(closed).toBe(1);
    act(() => root.unmount());
    host.remove();

    // As the user opens it: Option+M with a chat's message box focused,
    // under a chat that takes Escape and letters on the window first.
    const { handleMrReviewsShortcut } = await import("../mrReviewsOpen");
    const composer = document.createElement("div");
    composer.className = "agent-history-composer";
    composer.setAttribute("contenteditable", "true");
    composer.tabIndex = 0;
    document.body.append(composer);
    let chatTook = 0;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" || event.key.length === 1) {
          chatTook++;
          event.preventDefault();
        }
      },
      { capture: true },
    );
    // The app's handler: registered on the window, as App.tsx does; the
    // inspector's Reviews tab it asks for is the panel alone here.
    const { showMrReviews } = await import("./boardPanel.testkit");
    window.addEventListener(
      "keydown",
      (event) => handleMrReviewsShortcut(event, () => showMrReviews()),
      { capture: true },
    );
    composer.focus();
    expect(document.activeElement).toBe(composer);
    const press = async (name: string, init: KeyboardEventInit = {}) =>
      act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    await press("m", { altKey: true, code: "KeyM" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const live = document.querySelector<HTMLElement>(".mr-reviews-panel");
    expect(live).not.toBeNull();
    expect(live!.contains(document.activeElement)).toBe(true);
    const liveSelected = () =>
      document
        .querySelector(".mr-reviews-row.is-selected")
        ?.getAttribute("data-mr-key");
    await press("j");
    expect(liveSelected()).toEndWith("#1");
    await press("j");
    expect(liveSelected()).toEndWith("#2");
    await press("k");
    expect(liveSelected()).toEndWith("#1");
    await press("i");
    expect(document.body.textContent).toContain("All reviews");
    await press("Escape");
    expect(document.body.textContent).not.toContain("All reviews");
    await press("Escape");
    expect(document.querySelector(".mr-reviews-panel")).toBeNull();
    // Nothing reached the message box (the inspector's close gives it the
    // focus back, in the page).
    expect(composer.textContent).toBe("");
    // The chat had marked those keys first: the panel took them anyway.
    expect(chatTook).toBeGreaterThan(0);
  });
}
