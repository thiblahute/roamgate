import { expect, test } from "bun:test";

if (process.env.ROAMGATE_MR_REVIEWS_CHAT_VIM_DOM_TEST !== "1") {
  test("the reviews agent's Vim message box, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_MR_REVIEWS_CHAT_VIM_DOM_TEST: "1" },
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
  test("the reviews agent's box is the chats' Vim box: insert mode first, :w and Enter send, a question asked while it answers waits", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Text: browser.Text,
      DOMParser: browser.DOMParser,
      NodeFilter: browser.NodeFilter,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      MutationObserver: browser.MutationObserver,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      getSelection: () => browser.getSelection(),
      getComputedStyle: browser.getComputedStyle.bind(browser),
      matchMedia: () => ({ matches: false }),
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
    (
      browser.HTMLElement.prototype as unknown as {
        scrollIntoView: () => void;
      }
    ).scrollIntoView = () => {};
    // Vim keys: the review's `:vim`, on unless turned off.
    browser.localStorage.removeItem("roamgate:reviewPrefs");
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { EditorView } = await import("@codemirror/view");
    const { getCM, Vim } = await import("@replit/codemirror-vim");
    const { bridge } = await import("../api");
    const message = (id: string, role: string, text: string) => ({
      id,
      role,
      text,
      sent_at: new Date().toISOString(),
      tools: [],
      sources: [],
    });
    let snapshot: Record<string, unknown> = {
      instance_id: "i1",
      revision: 1,
      model: "opus",
      running: false,
      error: null,
      messages: [],
      queue: [],
    };
    const sends: Record<string, unknown>[] = [];
    (
      bridge as unknown as {
        call: (
          method: string,
          params: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).call = async (method, params) => {
      if (method === "bridge.mr_reviews.agent.get") return snapshot;
      if (method === "bridge.mr_reviews.agent.send") {
        sends.push(params);
        snapshot = {
          ...snapshot,
          revision: (snapshot.revision as number) + 1,
          running: true,
          messages: [
            ...(snapshot.messages as unknown[]),
            message(`u${sends.length}`, "user", String(params.text)),
          ],
        };
        return { queued: !!params.when_busy, snapshot };
      }
      return {};
    };
    const { MrReviewsChat } = await import("./MrReviewsChat");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = () =>
      act(async () => {
        for (let tick = 0; tick < 6; tick++)
          await new Promise((done) => setTimeout(done, 5));
      });
    const view = () =>
      EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".mr-reviews-chat .cm-editor")!,
      )!;
    const type = (text: string) =>
      act(async () => {
        const { from, to } = view().state.selection.main;
        view().dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          userEvent: "input.type",
        });
      });
    try {
      await act(async () => {
        root.render(
          <div className="mr-reviews-chat">
            <MrReviewsChat
              mobile={false}
              onOpen={() => {}}
              onError={(error) => {
                throw new Error(error);
              }}
            />
          </div>,
        );
      });
      await settle();
      // The chats' Vim box, no textarea; no @ picker here, and no Queue:
      // the reviews agent cannot be steered.
      expect(host.querySelector(".mr-reviews-chat textarea")).toBeNull();
      expect(view().contentDOM.getAttribute("aria-label")).toBe(
        "Message Reviews agent",
      );
      expect(
        host.querySelector('[aria-label="Mention workspace or agent"]'),
      ).toBeNull();
      await act(async () => {
        view().contentDOM.dispatchEvent(new Event("focus"));
      });
      const cm = getCM(view())!;
      expect(cm.state.vim?.insertMode).toBe(true);
      // Typed, then :w from normal mode sends.
      await type("anything new on GES?");
      Vim.handleKey(cm, "<Esc>", "user");
      expect(cm.state.vim?.insertMode).toBe(false);
      await act(async () => {
        Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], "w");
      });
      await settle();
      expect(sends).toHaveLength(1);
      expect(sends[0]!.text).toBe("anything new on GES?");
      expect(sends[0]!.when_busy).toBeUndefined();
      expect(view().state.doc.toString()).toBe("");
      expect(cm.state.vim?.insertMode).toBe(true);
      expect(host.querySelector('[aria-label="Queue"]')).toBeNull();
      // While it answers, Enter sends a question that waits for it.
      await type("and the RTP stack?");
      await act(async () => {
        view().contentDOM.dispatchEvent(
          new browser.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }) as unknown as Event,
        );
      });
      await settle();
      expect(sends).toHaveLength(2);
      expect(sends[1]).toMatchObject({
        text: "and the RTP stack?",
        when_busy: "queue",
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
      await browser.happyDOM.close();
    }
  });
}
