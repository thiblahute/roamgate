import { expect, test } from "bun:test";

/*
 * Back and Forward in the Files preview, as a browser's: the files a link
 * here opened and the pages a page's frame went to, per tab, each shown
 * again where it was scrolled; by the bar's buttons, Alt+arrows (Cmd+[ /
 * Cmd+] on a Mac), the frame's keys and `:back` / `:forward`.
 */
if (process.env.ROAMGATE_PREVIEW_HISTORY_DOM_TEST !== "1") {
  test("the Files preview's history in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PREVIEW_HISTORY_DOM_TEST: "1" },
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
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    HTMLDivElement: browser.HTMLDivElement,
    HTMLIFrameElement: browser.HTMLIFrameElement,
    Element: browser.Element,
    Node: browser.Node,
    Text: browser.Text,
    DOMParser: browser.DOMParser,
    NodeFilter: browser.NodeFilter,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLInputElement: browser.HTMLInputElement,
    Range: browser.Range,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    getSelection: browser.getSelection.bind(browser),
    matchMedia: browser.matchMedia.bind(browser),
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    MessageEvent: browser.MessageEvent,
    MouseEvent: browser.MouseEvent,
    FocusEvent: browser.FocusEvent,
    HTMLFormElement: browser.HTMLFormElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    PointerEvent: browser.PointerEvent,
    CSS: {
      escape: (value: string) => value.replace(/["\\]/g, "\\$&"),
    },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  const { mock } = await import("bun:test");
  const real = await import("../review");
  mock.module("../review", () => ({
    ...real,
    reviewCall: async (_connection: string, method: string) => {
      if (method === "review.rendered.page")
        return {
          src: "http://localhost/rendered/tok/page.html",
          mode: "static",
        };
      return {};
    },
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({ sessions: new Map(), openRequest: null }),
  }));
  mock.module("../sitesWeWorkOn", () => ({
    loadSitesWeWorkOn: async () => [],
    saveSitesWeWorkOn: async () => {},
  }));
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewContent } = await import("./FilePreviewContent");

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const files: Record<string, string> = {
    "a.md": `# A\n\n${"Words of A.\n\n".repeat(40)}[to B](b.md)\n`,
    "b.md": "# B\n\nWords of B. [to C](c.md)\n",
    "c.md": "# C\n\nWords of C.\n",
    "page.html": "<p>Page</p>",
  };
  const preview = (path: string) => ({
    workspace_id: "w1",
    checkout_path: "/repo",
    root: "/repo",
    path,
    size: files[path]!.length,
    mtime_ms: 0,
    text: files[path]!,
    binary: false,
    truncated: false,
  });
  const entry = (path: string) => ({
    name: path,
    path,
    type: "file" as const,
    size: 1,
    mtime_ms: 0,
    hidden: false,
  });

  /** The inspector's tab, as the app keeps it: opened files replace it. */
  async function mount(first = "a.md") {
    const opened: string[] = [];
    let show: (path: string) => void = () => {};
    function Host() {
      const [path, setPath] = useState(first);
      show = setPath;
      return (
        <FilePreviewContent
          entry={entry(path)}
          preview={preview(path)}
          loading={false}
          error={null}
          onOpenFile={(file) => {
            opened.push(file);
            setPath(file);
          }}
        />
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    await act(settle);
    const button = (label: string) =>
      host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const title = () =>
      host.querySelector(".file-preview-title")?.textContent ?? "";
    const scroller = () =>
      host.querySelector<HTMLElement>(".file-preview-markdown")!;
    const content = () =>
      host.querySelector<HTMLElement>(".file-preview-file-content")!;
    const press = (target: EventTarget, key: string, init = {}) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
        await settle();
      });
    const click = (element: HTMLElement) =>
      act(async () => {
        element.click();
        await settle();
      });
    const command = async (text: string) => {
      content().focus();
      await press(content(), ":");
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="Command"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          "value",
        )!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
      });
      await press(input, "Enter");
    };
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return {
      host,
      opened,
      show: (path: string) => act(async () => show(path)),
      button,
      title,
      scroller,
      content,
      press,
      click,
      command,
      unmount,
    };
  }

  test("Back and Forward buttons go through the files links opened, scrolled where they were", async () => {
    const view = await mount();
    expect(view.button("Back").disabled).toBe(true);
    expect(view.button("Forward").disabled).toBe(true);
    expect(view.button("Back").title).toBe("Back (Alt+Left, :back)");
    expect(view.button("Forward").title).toBe("Forward (Alt+Right, :forward)");
    view.scroller().scrollTop = 300;
    await view.click(
      view.host.querySelector<HTMLElement>('a[data-document-path="b.md"]')!,
    );
    expect(view.title()).toBe("b.md");
    expect(view.button("Back").disabled).toBe(false);
    expect(view.button("Forward").disabled).toBe(true);
    await view.click(view.button("Back"));
    expect(view.title()).toBe("a.md");
    expect(view.scroller().scrollTop).toBe(300);
    expect(view.button("Forward").disabled).toBe(false);
    await view.click(view.button("Forward"));
    expect(view.title()).toBe("b.md");
    // A new link from B drops what was ahead.
    await view.click(view.button("Back"));
    await view.click(view.button("Forward"));
    await view.click(
      view.host.querySelector<HTMLElement>('a[data-document-path="c.md"]')!,
    );
    expect(view.title()).toBe("c.md");
    expect(view.button("Forward").disabled).toBe(true);
    expect(view.opened).toEqual([
      "b.md",
      "a.md",
      "b.md",
      "a.md",
      "b.md",
      "c.md",
    ]);
    await view.unmount();
  });

  test("Alt+Left / Alt+Right, Cmd+[ / Cmd+] and :back / :forward step too, never in a field", async () => {
    const view = await mount();
    await view.click(
      view.host.querySelector<HTMLElement>('a[data-document-path="b.md"]')!,
    );
    view.content().focus();
    await view.press(view.content(), "ArrowLeft", { altKey: true });
    expect(view.title()).toBe("a.md");
    await view.press(view.content(), "ArrowRight", { altKey: true });
    expect(view.title()).toBe("b.md");
    await view.press(view.content(), "[", { metaKey: true });
    expect(view.title()).toBe("a.md");
    await view.press(view.content(), "]", { metaKey: true });
    expect(view.title()).toBe("b.md");
    await view.command("back");
    expect(view.title()).toBe("a.md");
    await view.command("forward");
    expect(view.title()).toBe("b.md");
    // In a field, Alt+Left moves in its text.
    const field = document.createElement("input");
    view.content().append(field);
    await view.press(field, "ArrowLeft", { altKey: true });
    expect(view.title()).toBe("b.md");
    field.remove();
    await view.unmount();
  });

  test("each tab keeps its own history", async () => {
    const view = await mount();
    await view.click(
      view.host.querySelector<HTMLElement>('a[data-document-path="b.md"]')!,
    );
    // Another tab picked from the strip: a history of its own.
    await view.show("c.md");
    await act(settle);
    expect(view.title()).toBe("c.md");
    expect(view.button("Back").disabled).toBe(true);
    // Back on b.md's tab: its history again.
    await view.show("b.md");
    await act(settle);
    expect(view.button("Back").disabled).toBe(false);
    await view.click(view.button("Back"));
    expect(view.title()).toBe("a.md");
    await view.unmount();
  });

  test("a page's frame: its pages are places, its keys step, Back shows the page scrolled where it was", async () => {
    const view = await mount("page.html");
    const frame = view.host.querySelector<HTMLIFrameElement>(
      "iframe.file-preview-html",
    )!;
    expect(frame).not.toBeNull();
    const went: string[] = [];
    const told: unknown[] = [];
    // The page's window, as the sandbox gives it: navigated and told only.
    const win = {
      location: { replace: (url: string) => went.push(url) },
      postMessage: (message: unknown) => told.push(message),
    };
    Object.defineProperty(frame, "contentWindow", {
      value: win,
      configurable: true,
    });
    const say = (data: Record<string, unknown>) =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { roamgate: "rendered", ...data },
            source: win as unknown as Window,
          }),
        );
        await settle();
      });
    const scrolls = () =>
      told.filter(
        (message) => (message as { type?: string }).type === "scrollTo",
      );
    await say({ type: "ready", url: "page.html", title: "" });
    expect(view.button("Back").disabled).toBe(true);
    await say({ type: "scroll", y: 420 });
    // A link followed in the page.
    await say({ type: "ready", url: "docs/a.html", title: "" });
    expect(view.button("Back").disabled).toBe(false);
    // Alt+Left in the page: Back, the frame sent to the page before.
    await say({ type: "history", step: -1 });
    expect(went).toEqual(["http://localhost/rendered/tok/page.html"]);
    await say({ type: "ready", url: "page.html", title: "" });
    expect(scrolls()).toEqual([
      { roamgate: "rendered", type: "scrollTo", y: 420 },
    ]);
    expect(view.button("Forward").disabled).toBe(false);
    // Forward by its button; a script's pushState is a place too.
    await view.click(view.button("Forward"));
    expect(went[1]).toBe("http://localhost/rendered/tok/docs/a.html");
    await say({ type: "ready", url: "docs/a.html", title: "" });
    await say({ type: "location", url: "docs/a.html?tab=2" });
    await view.command("back");
    expect(went[2]).toBe("http://localhost/rendered/tok/docs/a.html");
    await view.unmount();
  });
}
