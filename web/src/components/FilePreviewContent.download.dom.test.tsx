import { expect, test } from "bun:test";

/*
 * Download in the Files preview: a binary file it cannot show offers its
 * download under the message, with its name and size, and the toolbar's
 * Download takes any file, both whole through the Files tree's download
 * endpoint, never the preview.
 */
if (process.env.ROAMGATE_PREVIEW_DOWNLOAD_DOM_TEST !== "1") {
  test("the Files preview's Download in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PREVIEW_DOWNLOAD_DOM_TEST: "1" },
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

  const { describe, mock } = await import("bun:test");
  const client = {
    connectionId: "local",
    generation: 1,
    serverRuntimeGeneration: null,
    isCurrent: () => true,
    call: async () => ({}),
  };
  const realClient = await import("../useConnectionClient");
  mock.module("../useConnectionClient", () => ({
    ...realClient,
    useConnectionClient: () => client,
  }));
  mock.module("../sitesWeWorkOn", () => ({
    loadSitesWeWorkOn: async () => [],
    saveSitesWeWorkOn: async () => {},
  }));
  const downloads: { url: string; filename: string }[] = [];
  const realDownload = await import("../downloadFile");
  mock.module("../downloadFile", () => ({
    ...realDownload,
    downloadFileFromUrl: async (args: { url: string; filename: string }) => {
      downloads.push(args);
      return "anchored" as const;
    },
  }));
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewContent } = await import("./FilePreviewContent");
  type FilePreview = import("../types").FilePreview;

  const apk: FilePreview = {
    workspace_id: "w1",
    checkout_path: "/repo",
    root: "/repo",
    path: "app/build/outputs/apk/debug/app-debug.apk",
    size: 20 * 1024 * 1024,
    mtime_ms: 1000,
    text: null,
    binary: true,
    truncated: true,
  };
  const notes: FilePreview = {
    ...apk,
    path: "notes.md",
    size: 12,
    text: "# Notes\n",
    binary: false,
    truncated: false,
  };
  const entryOf = (path: string, size: number) => ({
    name: path.split("/").pop()!,
    path,
    type: "file" as const,
    size,
    mtime_ms: 0,
    hidden: false,
  });

  async function mount(preview: FilePreview) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <FilePreviewContent
          entry={entryOf(preview.path, preview.size)}
          preview={preview}
          loading={false}
          error={null}
        />,
      ),
    );
    for (let i = 0; i < 5; i++) await act(async () => {});
    return {
      container,
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  /** The whole file's URL: the download endpoint, not an inline preview. */
  function expectWholeFile(download: { url: string; filename: string }) {
    const url = new URL(download.url, "http://localhost");
    expect(url.pathname).toEndWith("/file/download");
    expect(url.searchParams.get("workspace_id")).toBe("w1");
    expect(url.searchParams.get("path")).toBe(apk.path);
    expect(url.searchParams.has("inline")).toBe(false);
    expect(download.filename).toBe("app-debug.apk");
  }

  describe("download from the preview", () => {
    test("a binary file offers its download under the message, with its name and size", async () => {
      downloads.length = 0;
      const view = await mount(apk);
      const state = view.container.querySelector(".file-preview-state");
      expect(state?.textContent).toContain("Binary file cannot be previewed.");
      const button = state?.querySelector<HTMLButtonElement>(
        ".file-preview-download",
      );
      expect(button?.textContent).toContain("Download app-debug.apk");
      expect(button?.textContent).toContain("20.0 MB");
      // Its truncated preview is beside the point: it is not shown at all.
      expect(view.container.textContent).not.toContain("Preview truncated");
      await act(async () => button!.click());
      expect(downloads).toHaveLength(1);
      expectWholeFile(downloads[0]!);
      await view.unmount();
    });

    test("the toolbar's Download takes any file whole", async () => {
      downloads.length = 0;
      const view = await mount(apk);
      const action = view.container.querySelector<HTMLButtonElement>(
        '.file-preview-head-actions button[aria-label="Download file"]',
      );
      expect(action?.title).toBe("Download app-debug.apk (20.0 MB)");
      await act(async () => action!.click());
      expect(downloads).toHaveLength(1);
      expectWholeFile(downloads[0]!);
      await view.unmount();

      const text = await mount(notes);
      expect(text.container.querySelector(".file-preview-download")).toBeNull();
      const textAction = text.container.querySelector<HTMLButtonElement>(
        '.file-preview-head-actions button[aria-label="Download file"]',
      );
      await act(async () => textAction!.click());
      expect(downloads).toHaveLength(2);
      expect(downloads[1]!.filename).toBe("notes.md");
      await text.unmount();
    });
  });
}
