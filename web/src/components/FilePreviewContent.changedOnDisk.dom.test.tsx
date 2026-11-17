import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/*
 * "Changed on disk" in the Files preview: the file's stat is checked while
 * it is seen (every few seconds, at once when an agent step completes),
 * the preview tells when it was written since it was read, and R or the
 * notice's Reload read it again in place, the reader's place kept. Its own
 * reload tells nothing.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Files preview's changed-on-disk notice in an isolated DOM runtime",
    "ROAMGATE_CHANGED_ON_DISK_DOM_TEST",
    30_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom();

  const { describe, jest, mock } = await import("bun:test");
  /** The file on disk, as the bridge would stat and read it. */
  const disk = { text: "# Notes\n\nFirst words.\n", mtime: 1000 };
  const stats: { params: unknown; options: unknown }[] = [];
  const client = {
    connectionId: "local",
    generation: 1,
    serverRuntimeGeneration: null,
    isCurrent: () => true,
    call: async (
      method: string,
      params: unknown,
      _timeout?: number | null,
      options?: unknown,
    ) => {
      if (method !== "file.stat") return {};
      stats.push({ params, options });
      return { type: "file", size: disk.text.length, mtime_ms: disk.mtime };
    },
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
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewContent } = await import("./FilePreviewContent");
  const { publishLastStepCompletion } = await import(
    "../lastStepCompletionStore"
  );
  const { CHANGED_ON_DISK_POLL_MS } = await import("../useChangedOnDisk");

  const read = () => ({
    workspace_id: "w1",
    checkout_path: "/repo",
    root: "/repo",
    path: "notes.md",
    size: disk.text.length,
    mtime_ms: disk.mtime,
    text: disk.text,
    binary: false,
    truncated: false,
  });
  const entry = {
    name: "notes.md",
    path: "notes.md",
    type: "file" as const,
    size: 1,
    mtime_ms: 0,
    hidden: false,
  };

  /** Let the fake timers and the calls' promises run. */
  async function advance(ms: number) {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
  }

  /** The preview as the inspector shows it: a refresh reads the file again. */
  async function mount() {
    let reloads = 0;
    let finishRead: () => void = () => {};
    function Host() {
      const [state, setState] = useState({
        preview: read() as ReturnType<typeof read> | null,
        loading: false,
      });
      finishRead = () => setState({ preview: read(), loading: false });
      return (
        <FilePreviewContent
          entry={entry}
          preview={state.preview}
          loading={state.loading}
          error={null}
          onRefresh={() => {
            reloads += 1;
            setState({ preview: null, loading: true });
          }}
        />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Host />));
    await advance(0);
    return {
      container,
      notice: () =>
        container.querySelector(".file-preview-changed")?.textContent ?? null,
      reloads: () => reloads,
      text: () =>
        container.querySelector(".file-preview-markdown")?.textContent ?? "",
      finishRead: () => act(async () => finishRead()),
      unmount: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  describe("changed on disk", () => {
    test("the notice shows once the file is written, not before, its stat in the background lane", async () => {
      jest.useFakeTimers();
      try {
        disk.mtime = 1000;
        const view = await mount();
        await advance(CHANGED_ON_DISK_POLL_MS * 2);
        expect(stats.length).toBeGreaterThan(0);
        expect(stats[stats.length - 1]).toEqual({
          params: { workspace_id: "w1", path: "notes.md" },
          options: { lane: "background" },
        });
        expect(view.notice()).toBeNull();
        disk.text = "# Notes\n\nFirst words, and more.\n";
        disk.mtime = 2000;
        expect(view.notice()).toBeNull();
        await advance(CHANGED_ON_DISK_POLL_MS);
        expect(view.notice()).toContain("Changed on disk");
        expect(view.notice()).toContain("R or :refresh to reload");
        // Told once: no more checks until it is read again.
        const asked = stats.length;
        await advance(CHANGED_ON_DISK_POLL_MS * 3);
        expect(stats.length).toBe(asked);
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    test("an agent step completing checks at once", async () => {
      jest.useFakeTimers();
      try {
        disk.mtime = 1000;
        const view = await mount();
        disk.mtime = 3000;
        await act(async () => publishLastStepCompletion("local", "w1"));
        await advance(0);
        expect(view.notice()).toContain("Changed on disk");
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    test("R reloads in place, the text shown until the new one, and the notice goes", async () => {
      jest.useFakeTimers();
      try {
        disk.text = "# Notes\n\nOld words.\n";
        disk.mtime = 1000;
        const view = await mount();
        const scroller = view.container.querySelector<HTMLElement>(
          ".file-preview-markdown",
        )!;
        scroller.scrollTop = 120;
        disk.text = "# Notes\n\nNew words.\n";
        disk.mtime = 4000;
        await advance(CHANGED_ON_DISK_POLL_MS);
        expect(view.notice()).toContain("Changed on disk");
        const content = view.container.querySelector<HTMLElement>(
          ".file-preview-file-content",
        )!;
        await act(async () => {
          content.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "R",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect(view.reloads()).toBe(1);
        // While it is read again: the file still shown where it was read.
        expect(view.text()).toContain("Old words.");
        expect(view.container.textContent).not.toContain("Loading preview");
        await view.finishRead();
        await advance(0);
        expect(view.text()).toContain("New words.");
        expect(view.container.querySelector(".file-preview-markdown")).toBe(
          scroller,
        );
        expect(scroller.scrollTop).toBe(120);
        expect(view.notice()).toBeNull();
        await advance(CHANGED_ON_DISK_POLL_MS * 2);
        expect(view.notice()).toBeNull();
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    test("`:refresh` reloads and the notice goes", async () => {
      jest.useFakeTimers();
      try {
        disk.mtime = 1000;
        const view = await mount();
        disk.mtime = 6000;
        await advance(CHANGED_ON_DISK_POLL_MS);
        expect(view.notice()).toContain("Changed on disk");
        const content = view.container.querySelector<HTMLElement>(
          ".file-preview-file-content",
        )!;
        const press = (target: Element, key: string) =>
          act(async () => {
            target.dispatchEvent(
              new KeyboardEvent("keydown", {
                key,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        await press(content, ":");
        const input = view.container.querySelector<HTMLInputElement>(
          ".review-cmdline input",
        )!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(input),
            "value",
          )!.set!.call(input, "refresh");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await press(input, "Enter");
        expect(view.reloads()).toBe(1);
        await view.finishRead();
        await advance(0);
        expect(view.notice()).toBeNull();
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });

    test("the preview's own reload tells nothing, and the notice's button reloads", async () => {
      jest.useFakeTimers();
      try {
        disk.mtime = 1000;
        const view = await mount();
        const refresh = view.container.querySelector<HTMLButtonElement>(
          "button[aria-label='Refresh preview']",
        )!;
        expect(refresh.title).toContain("R");
        await act(async () => refresh.click());
        await view.finishRead();
        await advance(CHANGED_ON_DISK_POLL_MS * 2);
        expect(view.notice()).toBeNull();
        disk.mtime = 5000;
        await advance(CHANGED_ON_DISK_POLL_MS);
        const button = [
          ...view.container.querySelectorAll<HTMLButtonElement>(
            ".file-preview-changed button",
          ),
        ].find((each) => each.textContent === "Reload")!;
        await act(async () => button.click());
        expect(view.reloads()).toBe(2);
        await view.finishRead();
        await advance(0);
        expect(view.notice()).toBeNull();
        await view.unmount();
      } finally {
        jest.useRealTimers();
      }
    });
  });
}
