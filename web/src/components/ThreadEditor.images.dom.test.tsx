import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/**
 * The comment box of threads (chat messages, the Files preview, efforts,
 * notes): images pasted, dropped or picked go in as Markdown once stored,
 * and nothing is sent while one is on its way.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "a thread's comment box takes images, in an isolated DOM runtime",
    "ROAMGATE_THREAD_EDITOR_IMAGES_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom } = await import("./reviewSurface.testkit");
  const browser = await installReviewDom();
  Object.defineProperty(globalThis, "sessionStorage", {
    value: browser.sessionStorage,
    configurable: true,
  });
  // The editor's chunk, loaded ahead as the review does.
  await import("./ReviewCommentEditor");
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { EditorView } = await import("@codemirror/view");
  const { ThreadEditor } = await import("./ThreadEditor");

  const settle = async () => {
    for (let i = 0; i < 5; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  };

  const png = (name: string) =>
    new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

  async function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const stored: string[] = [];
    let land: (() => void) | null = null;
    const saved: string[] = [];
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(ThreadEditor, {
          placeholder: "Reply...",
          onClose: () => {},
          onLeave: () => {},
          onSave: async (text: string) => {
            saved.push(text);
          },
          onAddImage: (file: File) => {
            stored.push(file.name);
            return new Promise<string>((resolve) => {
              land = () => resolve(`![${file.name}](</r/images/${file.name}>)`);
            });
          },
        }),
      ),
    );
    await settle();
    const content = () => host.querySelector<HTMLElement>(".cm-content")!;
    const text = () => EditorView.findFromDOM(content())!.state.doc.toString();
    return {
      host,
      stored,
      saved,
      text,
      land: async () => {
        land?.();
        await settle();
      },
      paste: async (file: File) => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: { files: [file], getData: () => "", types: ["Files"] },
        });
        await act(async () => {
          content().dispatchEvent(event);
        });
        await settle();
      },
      pick: async (file: File) => {
        const input =
          host.querySelector<HTMLInputElement>("input[type='file']")!;
        expect(input.accept).toBe("image/*");
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [file],
        });
        await act(async () => {
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await settle();
      },
      send: async () => {
        const button = [...host.querySelectorAll("button")].find(
          (each) => each.textContent === "Send",
        )!;
        await act(async () => button.click());
        await settle();
      },
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  test("a pasted image goes in as Markdown once stored; Send waits for it", async () => {
    const box = await mount();
    await box.paste(png("shot.png"));
    expect(box.stored).toEqual(["shot.png"]);
    expect(box.text()).toMatch(/^!\[Adding image \d+\.\.\.\]\(\)$/);
    await box.send();
    // Sent now, the placeholder would go and the image be lost.
    expect(box.saved).toEqual([]);
    expect(box.host.textContent).toContain("An image is still uploading");
    await box.land();
    expect(box.text()).toBe("![shot.png](</r/images/shot.png>)");
    await box.send();
    expect(box.saved).toEqual(["![shot.png](</r/images/shot.png>)"]);
    await box.unmount();
  });

  test("Add images picks one from a file chooser (a phone's camera or gallery)", async () => {
    const box = await mount();
    const button = box.host.querySelector<HTMLButtonElement>(
      "button[aria-label='Add images']",
    );
    expect(button).not.toBeNull();
    await box.pick(png("photo.png"));
    await box.land();
    expect(box.stored).toEqual(["photo.png"]);
    expect(box.text()).toBe("![photo.png](</r/images/photo.png>)");
    await box.unmount();
  });
}
