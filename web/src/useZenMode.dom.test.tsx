import { inIsolatedChild } from "./testIsolated";
import { describe, expect, test } from "bun:test";

/**
 * The review's chrome-free mode as the review pane and the Files preview
 * use it (`useZenMode`, `ZenButton`, `useZenEscape`): characterization
 * tests of today's behavior (plan: review into the inspector, phase A).
 */
if (
  inIsolatedChild(
    import.meta.path,
    "zen mode in an isolated DOM runtime",
    "ROAMGATE_ZEN_MODE_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom } = await import(
    "./components/reviewSurface.testkit"
  );
  await installReviewDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useZenMode, useZenEscape, ZenButton, zenKeyTarget } = await import(
    "./useZenMode"
  );

  /** A host using the mode as the review does: a button, Esc to leave. */
  function Host() {
    const [zen, toggle] = useZenMode();
    useZenEscape(zen, toggle);
    return (
      <div>
        <output>{zen ? "zen" : "chrome"}</output>
        <ZenButton zen={zen} onToggle={toggle} className="zen" />
        <input aria-label="box" />
        <textarea aria-label="area" />
      </div>
    );
  }

  async function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    const button = host.querySelector("button")!;
    return {
      host,
      button,
      mode: () => host.querySelector("output")?.textContent,
      click: () => act(async () => button.click()),
      esc: (target: EventTarget = window) =>
        act(async () => {
          target.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        }),
      unmount: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("zen mode", () => {
    test("the mode starts off; the button toggles it and says so with aria-pressed and its class", async () => {
      const view = await mount();
      expect(view.mode()).toBe("chrome");
      expect(view.button.getAttribute("aria-pressed")).toBe("false");
      expect(view.button.getAttribute("aria-label")).toBe("Diff only");
      expect(view.button.title).toBe(
        "Diff only: hide all the chrome, just the diff (o, :only; o or Esc brings it back)",
      );
      expect(view.button.className).toBe("zen");
      await view.click();
      expect(view.mode()).toBe("zen");
      expect(view.button.getAttribute("aria-pressed")).toBe("true");
      expect(view.button.className).toBe("zen on");
      await view.click();
      expect(view.mode()).toBe("chrome");
      await view.unmount();
    });

    test("while on, Esc anywhere leaves the mode, but not Esc typed in a box; off, Esc does nothing", async () => {
      const view = await mount();
      await view.esc();
      expect(view.mode()).toBe("chrome");
      await view.click();
      await view.esc(view.host.querySelector("input")!);
      expect(view.mode()).toBe("zen");
      await view.esc(view.host.querySelector("textarea")!);
      expect(view.mode()).toBe("zen");
      await view.esc(view.button);
      expect(view.mode()).toBe("chrome");
      // Off again, a second Esc does not turn it back on.
      await view.esc();
      expect(view.mode()).toBe("chrome");
      await view.unmount();
    });

    test("o or Esc may mean the mode outside a box: inputs, text areas, selects and editable text are boxes", () => {
      expect(zenKeyTarget(null)).toBe(true);
      expect(zenKeyTarget(window)).toBe(true);
      expect(zenKeyTarget(document.createElement("div"))).toBe(true);
      expect(zenKeyTarget(document.createElement("button"))).toBe(true);
      for (const tag of ["input", "textarea", "select"])
        expect(zenKeyTarget(document.createElement(tag))).toBe(false);
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      document.body.append(editable);
      expect(zenKeyTarget(editable)).toBe(false);
      editable.remove();
    });
  });
}
