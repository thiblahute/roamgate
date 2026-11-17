import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/*
 * The Files preview's `:` prompt: opened by `:` wherever the view has the
 * focus (a page's frame too, by its script's message), never in a text
 * field; each command does what its key or button does; Esc and Enter
 * give the focus back.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Files preview's command line in an isolated DOM runtime",
    "ROAMGATE_PREVIEW_COMMANDS_DOM_TEST",
    30_000,
  )
) {
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

  const { LEGACY_DEFAULT_CONNECTION_ID } = await import("../connectionStorage");
  const comment = (id: string) => ({
    id,
    author: "you",
    body: `On ${id}`,
    createdAt: "2026-11-10T10:00:00Z",
    updatedAt: "2026-11-10T10:00:00Z",
  });
  const thread = (id: string, line: number) => ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: { path: "plan.md", line, render: { quote: "para" } },
    comments: [comment(`${id}c`)],
    resolved: false,
    createdAt: `2026-11-10T10:00:0${line}Z`,
    updatedAt: `2026-11-10T10:00:0${line}Z`,
  });
  const review = {
    session: {
      id: "s1",
      connectionId: LEGACY_DEFAULT_CONNECTION_ID,
      workspaceId: "w1",
      root: "/repo",
      title: "plan.md",
      target: { kind: "rendered", path: "plan.md" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-11-10",
      updatedAt: "2026-11-10",
    },
    threads: [thread("t1", 3), thread("t2", 7)],
  };
  const { mock } = await import("bun:test");
  const real = await import("../review");
  mock.module("../review", () => ({
    ...real,
    reviewCall: async (_connection: string, method: string) => {
      if (method === "review.get") return review;
      if (method === "review.rendered.page")
        return { src: "about:blank", mode: "static" };
      return {};
    },
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({
      sessions: new Map<string, unknown>([["s1", review]]),
      openRequest: null,
    }),
  }));
  mock.module("../sitesWeWorkOn", () => ({
    loadSitesWeWorkOn: async () => [],
    saveSitesWeWorkOn: async () => {},
  }));
  const { store } = await import("../store");
  const told: string[] = [];
  store.notify = ((notice: { message: string }) => {
    told.push(notice.message);
  }) as typeof store.notify;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewContent, PREVIEW_COMMAND_WORDS } = await import(
    "./FilePreviewContent"
  );
  const { inspectorCompletions } = await import("../inspectorCommands");

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const markdown = "# Plan\n\nFirst para.\n\nSecond para.\n\nThird para.\n";
  const preview = (path: string, text: string) => ({
    workspace_id: "w1",
    checkout_path: "/repo",
    root: "/repo",
    path,
    size: text.length,
    mtime_ms: 0,
    text,
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

  /** The preview of `path`, with every callback counted. */
  async function mount(path = "plan.md", text = markdown) {
    const calls: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <FilePreviewContent
          entry={entry(path)}
          preview={preview(path, text)}
          loading={false}
          error={null}
          onToggleTree={() => calls.push("files")}
          onRefresh={() => calls.push("reload")}
          onClosePreview={() => calls.push("close")}
          onOpenFile={(file) => calls.push(`open ${file}`)}
          onShowInReview={(file, line) => calls.push(`review ${file} ${line}`)}
          onCreateAnnotation={() => calls.push("annotation")}
        />,
      ),
    );
    await act(settle);
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    const prompt = () =>
      host.querySelector<HTMLInputElement>('input[aria-label="Command"]');
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
    const type = (text: string) =>
      act(async () => {
        const input = prompt()!;
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          "value",
        )!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
      });
    /** `:text` Enter, from the content. */
    const command = async (text: string) => {
      content.focus();
      await press(content, ":");
      if (!prompt()) throw new Error("no command prompt");
      await type(text);
      await press(prompt()!, "Enter");
    };
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, content, calls, prompt, press, type, command, unmount };
  }

  test("`:` opens the prompt in the rendered view; Esc closes it, the focus back", async () => {
    const view = await mount();
    view.content.focus();
    await view.press(view.content, ":");
    const input = view.prompt();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    // The review pane's prompt: its line and its completions.
    const line = view.host.querySelector(".file-preview > .review-cmdline");
    expect(line?.firstChild?.textContent).toBe(":");
    const names = [...line!.querySelectorAll(".wild-item")].map(
      (item) => item.firstChild?.textContent,
    );
    expect(names).toEqual([
      "files",
      "only",
      "conversations",
      "unresolved",
      "next",
      "previous",
      "comment",
      "fold",
      "source",
      "rendered",
      "scripts",
      "point",
      "review",
      "reload",
      "copy",
      "url",
      "back",
      "forward",
      "q",
    ]);
    // Tab completes.
    await view.type("sc");
    await view.press(input!, "Tab");
    expect(view.prompt()?.value).toBe("scripts");
    await view.press(view.prompt()!, "Escape");
    expect(view.prompt()).toBeNull();
    expect(document.activeElement).toBe(view.content);
    expect(view.calls).toEqual([]);
    // Backspace on nothing leaves it too.
    await view.press(view.content, ":");
    await view.press(view.prompt()!, "Backspace");
    expect(view.prompt()).toBeNull();
    await view.unmount();
  });

  test("`:` in a text field is text, and Ctrl+: is not the prompt", async () => {
    const view = await mount();
    const field = document.createElement("textarea");
    view.content.append(field);
    field.focus();
    await view.press(field, ":");
    expect(view.prompt()).toBeNull();
    await view.press(view.content, ":", { ctrlKey: true });
    expect(view.prompt()).toBeNull();
    field.remove();
    await view.unmount();
  });

  test("`:files` from Preview hides the tree as the button does, which says so", async () => {
    const view = await mount();
    const button = view.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide the file tree"]',
    );
    expect(button?.title).toBe("Hide the file tree (:files)");
    await act(async () => button!.click());
    expect(view.calls).toEqual(["files"]);
    await view.command("files");
    expect(view.calls).toEqual(["files", "files"]);
    expect(view.prompt()).toBeNull();
    expect(document.activeElement).toBe(view.content);
    await view.unmount();
  });

  test("each command does what its key or button does", async () => {
    const view = await mount();
    const section = view.host.querySelector(".file-preview")!;
    // :only, its aliases: Review only, as o.
    await view.command("only");
    expect(section.classList.contains("is-zen")).toBe(true);
    // The prompt works in Review only too.
    await view.command("zen");
    expect(section.classList.contains("is-zen")).toBe(false);
    // :conversations, as T: every thread listed.
    await view.command("conversations");
    expect(view.host.querySelector(".file-preview-threads")).not.toBeNull();
    // :unresolved, as gH.
    const only = () =>
      view.host
        .querySelector(".unresolved-nav-only")
        ?.getAttribute("aria-pressed");
    expect(only()).toBe("false");
    await view.command("unresolved");
    expect(only()).toBe("true");
    await view.command("openonly");
    expect(only()).toBe("false");
    // :next / :previous, as gn / gN.
    const where = () =>
      view.host.querySelector(".unresolved-nav-where")?.textContent;
    await view.command("next");
    expect(where()).toBe("1 of 2 unresolved");
    await view.command("next");
    expect(where()).toBe("2 of 2 unresolved");
    await view.command("prev");
    expect(where()).toBe("1 of 2 unresolved");
    // :fold, as za: the cursor's thread folded, and back.
    const folded = () =>
      view.host
        .querySelector('[data-thread-id="t1"]')
        ?.classList.contains("is-folded");
    expect(folded()).toBe(false);
    await view.command("fold");
    expect(folded()).toBe(true);
    await view.command("fold");
    expect(folded()).toBe(false);
    // :N, a line: the cursor on its block; :comment, as c, on it.
    await view.command("5");
    expect(
      view.host.querySelector<HTMLElement>(".md-source-block.is-focused")
        ?.dataset.line,
    ).toBe("5");
    await view.command("comment");
    expect(
      document.querySelector(".annotation-composer-popover"),
    ).not.toBeNull();
    // :review, the Review button: the file at the cursor's line.
    await view.command("review");
    expect(view.calls).toContain("review /repo/plan.md 5");
    // :scripts, the Scripts button; :scripts on when on does nothing.
    const scripts = () =>
      [...view.host.querySelectorAll("button")].find((button) =>
        /^Scripts (on|off)/.test(button.textContent ?? ""),
      )?.textContent;
    expect(scripts()).toBe("Scripts off");
    await view.command("scripts");
    expect(scripts()).toBe("Scripts on");
    await view.command("scripts on");
    expect(scripts()).toBe("Scripts on");
    await view.command("scripts off");
    expect(scripts()).toBe("Scripts off");
    // :point, the Point button.
    const point = () =>
      [...view.host.querySelectorAll("button")]
        .find((button) => button.textContent === "Point")
        ?.getAttribute("aria-pressed");
    expect(point()).toBe("false");
    await view.command("point");
    expect(point()).toBe("true");
    await view.command("point");
    expect(point()).toBe("false");
    // :reload, :e, the refresh button; :url, the URL form or a page.
    await view.command("e");
    await view.command("reload");
    await view.command("url http://localhost:8080/docs/");
    expect(view.calls).toEqual(
      expect.arrayContaining([
        "reload",
        "reload",
        "open http://localhost:8080/docs/",
      ]),
    );
    await view.command("url");
    expect(
      view.host.querySelector('input[aria-label="The page to open"]'),
    ).not.toBeNull();
    // Not a command: said, nothing run.
    told.length = 0;
    await view.command("nope");
    expect(told[0]).toStartWith("Not a command here: :nope");
    // :source and :rendered, the Source switch.
    const source = () =>
      view.host
        .querySelector('[aria-label="Source mode"]')
        ?.getAttribute("aria-checked");
    await view.command("source");
    expect(source()).toBe("true");
    // In the source, the keys are the editor's: the hints name commands.
    expect(
      view.host.querySelector<HTMLElement>(".unresolved-nav-step")?.title,
    ).toBe("Previous unresolved thread (:previous)");
    await view.command("rendered");
    expect(source()).toBe("false");
    expect(
      view.host.querySelector<HTMLElement>(".unresolved-nav-step")?.title,
    ).toBe("Previous unresolved thread (gN)");
    // :q, the close button.
    await view.command("q");
    expect(view.calls).toContain("close");
    await view.unmount();
  });

  test("`:` pressed in a page's frame opens the prompt; Esc gives the frame the focus back", async () => {
    const view = await mount("page.html", "<p>Hello</p>");
    const frame = view.host.querySelector<HTMLIFrameElement>(
      "iframe.file-preview-html",
    );
    expect(frame).not.toBeNull();
    frame!.focus();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { roamgate: "rendered", type: "key", key: ":" },
          source: frame!.contentWindow,
        }),
      );
      await settle();
    });
    expect(view.prompt()).not.toBeNull();
    await view.press(view.prompt()!, "Escape");
    expect(view.prompt()).toBeNull();
    expect(document.activeElement).toBe(frame);
    await view.unmount();
  });

  test("reviews in Changes: Reviewed and :reviewed tick the file in the checkout's review, as Changes' tree shows it (D16)", async () => {
    const toggled: string[] = [];
    let marks = new Map<string, { reviewed: boolean; other: boolean }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const draw = () =>
      act(async () =>
        root.render(
          <FilePreviewContent
            entry={entry("docs/plan.md")}
            preview={preview("docs/plan.md", markdown)}
            loading={false}
            error={null}
            onCreateAnnotation={() => {}}
            reviewFiles={{
              root: "/repo",
              marks,
              changed: () => false,
              toggle: async (path) => {
                toggled.push(path);
              },
            }}
          />,
        ),
      );
    await draw();
    await act(settle);
    const button = () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((each) =>
        each.classList.contains("file-preview-reviewed"),
      );
    expect(button()?.textContent).toBe("Reviewed");
    expect(button()?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button()!.click());
    await act(settle);
    expect(toggled).toEqual(["docs/plan.md"]);
    marks = new Map([["docs/plan.md", { reviewed: true, other: true }]]);
    await draw();
    expect(button()?.textContent).toBe("\u2713 Reviewed");
    expect(button()?.getAttribute("aria-pressed")).toBe("true");
    // The same from the command line.
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    content.focus();
    await act(async () => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ":",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Command"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )!.set!.call(input, "reviewed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    expect(toggled).toEqual(["docs/plan.md", "docs/plan.md"]);
    await act(async () => root.unmount());
    host.remove();
  });

  test("a file outside the review's repository has no Reviewed", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <FilePreviewContent
          entry={entry("plan.md")}
          preview={preview("plan.md", markdown)}
          loading={false}
          error={null}
          reviewFiles={{
            root: "/other",
            marks: new Map(),
            changed: () => false,
            toggle: async () => {},
          }}
        />,
      ),
    );
    await act(settle);
    expect(host.querySelector(".file-preview-reviewed")).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });

  test("every command the preview has is in its source view's Vim keys", async () => {
    const view = await mount();
    view.content.focus();
    await view.press(view.content, ":");
    const words = [
      ...view.host.querySelectorAll(".file-preview .review-cmdline .wild-item"),
    ].map((item) => item.firstChild?.textContent ?? "");
    for (const word of words) expect(PREVIEW_COMMAND_WORDS).toContain(word);
    for (const alias of [
      "o",
      "zen",
      "threads",
      "conv",
      "openonly",
      "prev",
      "preview",
      "e",
      "edit",
      "quit",
      "close",
    ])
      expect(PREVIEW_COMMAND_WORDS).toContain(alias);
    expect(inspectorCompletions([], "")).toEqual([]);
    await view.unmount();
  });
}
