import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_DOM_TEST !== "1") {
  test("the reviews panel, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_DOM_TEST: "1" },
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
    expect(titles).toEqual(["For you2", "Suggested1"]);
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
    await key("Enter");
    expect(host.textContent).toContain("All reviews");
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.seen")?.[1],
    ).toEqual({ key: "gitlab:gitlab.example.org/group/app#2" });
    await key("Escape");
    expect(host.textContent).not.toContain("All reviews");
    await key("Escape");
    expect(closed).toBe(1);
    act(() => root.unmount());
  });
}
