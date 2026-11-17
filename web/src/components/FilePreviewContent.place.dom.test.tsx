import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/*
 * A Files preview tab shown again is where it was left: after another view
 * of the inspector (its preview hidden, which loses a scroll), after
 * another workspace (the inspector drawn anew) and after a page reload:
 * its scroll, cursor, Back / Forward history and Source switch.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Files preview's places kept in an isolated DOM runtime",
    "ROAMGATE_PREVIEW_PLACE_DOM_TEST",
    30_000,
  )
) {
  /** Layout's resize reports, given by the test (happy-dom has none). */
  const observers = new Set<() => void>();
  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() {
      observers.add(this.callback);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.callback);
    }
  }
  const { installTestDom } = await import("../testDom");
  const { previewEntry, previewFile, settlePreview } = await import(
    "./FilePreviewContent.testkit"
  );
  installTestDom({
    extra: { ResizeObserver: FakeResizeObserver },
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
  const { flushPreviewTabPlaces, resetPreviewTabPlacesForTests } = await import(
    "../previewPlaces"
  );

  const settle = settlePreview;
  const files: Record<string, string> = {
    "a.md": `# A\n\n${"Words of A.\n\n".repeat(40)}[to B](b.md)\n`,
    "b.md": "# B\n\nWords of B.\n",
  };
  const preview = (path: string) => previewFile(path, files[path]!);
  const entry = previewEntry;

  /**
   * The inspector as the app draws it: one per checkout (`scope`, drawn
   * anew for another), its Files view hidden under another view.
   */
  async function mount() {
    let set: (next: { scope: string; path: string; hidden: boolean }) => void =
      () => {};
    function Inspector({ scope, first }: { scope: string; first: string }) {
      const [path, setPath] = useState(first);
      return (
        <FilePreviewContent
          entry={entry(path)}
          preview={preview(path)}
          loading={false}
          error={null}
          placeScope={scope}
          onCreateAnnotation={() => {}}
          onOpenFile={(file) => setPath(file)}
        />
      );
    }
    function Host() {
      const [state, setState] = useState({
        scope: "checkout-1",
        path: "a.md",
        hidden: false,
      });
      set = setState;
      return (
        <div style={{ display: state.hidden ? "none" : "block" }}>
          <Inspector key={state.scope} scope={state.scope} first={state.path} />
        </div>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    await act(settle);
    const scroller = () =>
      host.querySelector<HTMLElement>(".file-preview-markdown")!;
    const content = () =>
      host.querySelector<HTMLElement>(".file-preview-file-content")!;
    const title = () =>
      host.querySelector(".file-preview-title")?.textContent ?? "";
    /** `work`, then what it set off (effects, frames) run out. */
    const act_ = async (work: () => void) => {
      await act(async () => work());
      await act(settle);
    };
    return {
      host,
      title,
      scroller,
      /** Scrolled by the reader to `y`. */
      scrollTo: (y: number) =>
        act_(() => {
          scroller().scrollTop = y;
          scroller().dispatchEvent(new Event("scroll"));
        }),
      /** The block the cursor is on, by its source line. */
      cursorLine: () =>
        host.querySelector<HTMLElement>(".is-focused")?.dataset.line ?? null,
      press: (key: string) =>
        act_(() => {
          content().focus();
          content().dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
            }),
          );
        }),
      click: (element: HTMLElement) => act_(() => element.click()),
      button: (label: string) =>
        host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!,
      show: (next: { scope: string; path: string; hidden: boolean }) =>
        act_(() => set(next)),
      /** The layout's resize reports, as after a view shown again. */
      resized: () =>
        act_(() => {
          for (const callback of [...observers]) callback();
        }),
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  test("another workspace and back: the same file, scroll, cursor and Back / Forward", async () => {
    resetPreviewTabPlacesForTests();
    const view = await mount();
    await view.press("j");
    await view.press("j");
    await view.press("j");
    const line = view.cursorLine();
    expect(line).not.toBeNull();
    await view.click(
      view.host.querySelector<HTMLElement>('a[data-document-path="b.md"]')!,
    );
    expect(view.title()).toBe("b.md");
    await view.click(view.button("Back"));
    expect(view.title()).toBe("a.md");
    await view.scrollTo(300);
    // Another workspace: another inspector, drawn anew.
    await view.show({ scope: "checkout-2", path: "b.md", hidden: false });
    expect(view.title()).toBe("b.md");
    expect(view.cursorLine()).toBeNull();
    // Back: the tab as left.
    await view.show({ scope: "checkout-1", path: "a.md", hidden: false });
    expect(view.title()).toBe("a.md");
    expect(view.scroller().scrollTop).toBe(300);
    expect(view.cursorLine()).toBe(line);
    expect(view.button("Forward").disabled).toBe(false);
    await view.click(view.button("Forward"));
    expect(view.title()).toBe("b.md");
    await view.unmount();
  });

  test("another view and back: the scroll the hidden preview lost, and the cursor", async () => {
    resetPreviewTabPlacesForTests();
    const view = await mount();
    await view.press("j");
    await view.press("j");
    const line = view.cursorLine();
    await view.scrollTo(240);
    // Changes shown: Files hidden, its scroller at its top as a browser
    // has it, which is not kept.
    await view.show({ scope: "checkout-1", path: "a.md", hidden: true });
    await view.resized();
    await view.scrollTo(0);
    await view.show({ scope: "checkout-1", path: "a.md", hidden: false });
    expect(view.scroller().scrollTop).toBe(0);
    await view.resized();
    expect(view.scroller().scrollTop).toBe(240);
    expect(view.cursorLine()).toBe(line);
    await view.unmount();
  });

  test("a page reload: the tab's scroll and Source switch read back from localStorage", async () => {
    resetPreviewTabPlacesForTests();
    const view = await mount();
    await view.scrollTo(180);
    await view.click(
      view.host.querySelector<HTMLElement>('[aria-label="Source mode"]')!,
    );
    flushPreviewTabPlaces();
    await view.unmount();
    // A new page: nothing in memory, the tabs in localStorage.
    resetPreviewTabPlacesForTests();
    const again = await mount();
    expect(
      again.host
        .querySelector('[aria-label="Source mode"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    await again.click(
      again.host.querySelector<HTMLElement>('[aria-label="Source mode"]')!,
    );
    flushPreviewTabPlaces();
    await again.unmount();
    resetPreviewTabPlacesForTests();
    const third = await mount();
    expect(third.scroller().scrollTop).toBe(180);
    await third.unmount();
  });
}
