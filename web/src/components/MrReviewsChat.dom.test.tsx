import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_CHAT_DOM_TEST !== "1") {
  test("the reviews agent's chat, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_CHAT_DOM_TEST: "1" },
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
  test("the chat view: its keys in the panel, a question, the agent's work", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLTextAreaElement: browser.HTMLTextAreaElement,
      Element: browser.Element,
      Node: browser.Node,
      DOMParser: browser.DOMParser,
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
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    (browser.HTMLElement.prototype as any).scrollIntoView = () => {};
    // A plain message box (no Vim editor to load).
    browser.localStorage.setItem("roamgate:vimKeys", "false");
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { bridge } = await import("../api");
    const item = {
      provider: "gitlab",
      host: "gitlab.example.org",
      project: "group/app",
      number: 7,
      key: "gitlab:gitlab.example.org/group/app#7",
      url: "https://gitlab.example.org/group/app/-/merge_requests/7",
      title: "validate: add an action",
      author: "bob",
      draft: false,
      state: "open",
      updatedAt: new Date().toISOString(),
      headSha: "aaaaaaa1",
      sourceBranch: "topic",
      targetBranch: "main",
      pipeline: null,
      notes: 0,
      reasons: [],
    };
    let snapshot: any = {
      instance_id: "i1",
      revision: 1,
      model: "sonnet",
      running: false,
      error: null,
      messages: [],
      queue: [],
    };
    const calls: [string, Record<string, unknown>][] = [];
    (bridge as any).call = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      calls.push([method, params]);
      if (method === "bridge.mr_reviews.inbox")
        return {
          entries: [],
          hosts: [],
          curation: { state: "idle" },
          refreshedAt: new Date().toISOString(),
          refreshing: false,
        };
      if (method === "bridge.mr_reviews.agent.get") return snapshot;
      if (method === "bridge.mr_reviews.agent.send") {
        snapshot = {
          ...snapshot,
          revision: 2,
          session_id: "s1",
          messages: [
            {
              id: "u1",
              role: "user",
              text: params.text,
              sent_at: new Date().toISOString(),
              tools: [],
              sources: [],
              request_id: params.request_id,
            },
            {
              id: "a1",
              role: "assistant",
              text: "group/app!7 touches validate/.",
              sent_at: new Date().toISOString(),
              tools: [
                {
                  id: "t1",
                  name: "search_requests",
                  status: "completed",
                  arguments: '{"path":"validate"}',
                  output: "{}",
                },
              ],
              sources: [],
              request_id: params.request_id,
              opens: [item],
            },
          ],
        };
        return { queued: false, snapshot };
      }
      if (method === "bridge.mr_reviews.open")
        return {
          needClone: {
            host: "gitlab.example.org",
            project: "group/app",
            connections: [{ id: "local", label: "This Mac" }],
          },
        };
      return { ok: true };
    };
    const { MrReviewsPanel } = await import("./MrReviewsPanel");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let closed = 0;
    await act(async () => {
      root.render(<MrReviewsPanel onClose={() => closed++} />);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const panel = host.querySelector<HTMLElement>(".mr-reviews-panel")!;
    const press = async (name: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        (document.activeElement ?? panel).dispatchEvent(
          new KeyboardEvent("keydown", {
            key: name,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      // Effects ran as act ended: what they started, then its render.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
    };
    panel.focus();
    // "a" in the inbox: the chat, its message box focused.
    await press("a");
    expect(host.querySelector(".mr-reviews-chat")).not.toBeNull();
    expect(host.textContent).toContain("Ask the reviews agent");
    const box = host.querySelector<HTMLTextAreaElement>(
      ".mr-reviews-chat textarea",
    )!;
    expect(box).not.toBeNull();
    expect(document.activeElement).toBe(box);
    // Letters typed there are the box's, not the inbox's keys.
    await press("j");
    await press("x");
    expect(
      calls.some(([method]) => method === "bridge.mr_reviews.feedback"),
    ).toBe(false);
    // Escape in the box gives the keys to the panel; again, the inbox.
    await press("Escape");
    expect(document.activeElement).toBe(panel);
    expect(host.querySelector(".mr-reviews-chat")).not.toBeNull();
    await press("i");
    expect(document.activeElement).toBe(box);
    // A question, sent from the box.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        browser.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(box, "find MRs touching validate");
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await press("Enter");
    const sent = calls.find(
      ([method]) => method === "bridge.mr_reviews.agent.send",
    );
    expect(sent?.[1].text).toBe("find MRs touching validate");
    expect(host.textContent).toContain("group/app!7 touches validate/.");
    expect(host.textContent).toContain("Work performed (1)");
    expect(host.textContent).toContain("Forge search");
    expect(host.textContent).toContain("Review group/app!7");
    // The review it showed opens through the panel's own flow, which asks.
    expect(
      calls.find(([method]) => method === "bridge.mr_reviews.open")?.[1],
    ).toEqual({ key: item.key });
    expect(host.textContent).toContain("Where is your clone?");
    panel.focus();
    await press("Escape");
    expect(host.textContent).not.toContain("Where is your clone?");
    expect(host.querySelector(".mr-reviews-chat")).not.toBeNull();
    await press("Escape");
    expect(host.querySelector(".mr-reviews-chat")).toBeNull();
    expect(closed).toBe(0);
    await press("Escape");
    expect(closed).toBe(1);
    act(() => root.unmount());
    host.remove();
  });
}
