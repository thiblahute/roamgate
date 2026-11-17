import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "a companion call in Zen mode, in an isolated browser runtime",
    "ROAMGATE_COMPANION_ZEN_DOM_TEST",
    30_000,
  )
) {
  test("a call in Zen mode shows its control and its line", async () => {
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
      getComputedStyle: browser.getComputedStyle.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const companion = await import("../companionCall");
    const { CompanionChip, CompanionStrip, useCompanionCallOpen } =
      await import("./CompanionChip");

    // The app as App.tsx lays it out: Zen hides the top bar (and its chip),
    // so the strip carries the call's chip and Zen's way out during a call;
    // outside a call the way out hangs on its own.
    const island = (
      <button type="button" className="zen-island">
        Exit Zen
      </button>
    );
    const App = ({ zen }: { zen: boolean }) => {
      const callOpen = useCompanionCallOpen();
      return (
        <div className={`app${zen ? " zen" : ""}`}>
          <header className="topbar">
            <CompanionChip />
          </header>
          <CompanionStrip control={zen}>{zen ? island : null}</CompanionStrip>
          {zen && !callOpen ? island : null}
          <main>terminal</main>
        </div>
      );
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<App zen />);
    });

    // No call: no strip, no chip; the way out is the floating tab.
    expect(document.querySelector(".companion-strip")).toBeNull();
    expect(document.querySelector(".companion-chip")).toBeNull();
    expect(document.querySelector(".app > .zen-island")).not.toBeNull();

    // A call starts: the strip takes its row under the hidden top bar, with
    // what is said, the call's chip and its buttons, and the way out.
    await act(async () => {
      companion.startCompanionCall("local/w1:p1");
      companion.setCompanionLine("Je regarde la session roamgate.");
    });
    const strip = document.querySelector(".app > .companion-strip");
    expect(strip).not.toBeNull();
    expect(strip!.classList.contains("has-control")).toBe(true);
    expect(strip!.previousElementSibling?.className).toBe("topbar");
    expect(strip!.nextElementSibling?.tagName).toBe("MAIN");
    expect(strip!.querySelector(".companion-strip-line")?.textContent).toBe(
      "CompanionJe regarde la session roamgate.",
    );
    const chip = strip!.querySelector(".companion-chip.is-call");
    expect(chip?.getAttribute("aria-label")).toBe("Call with Companion");
    expect(chip?.querySelector('[aria-label="Hang up"]')).not.toBeNull();
    expect(
      chip?.querySelector('[aria-label="Mute the microphone"]'),
    ).not.toBeNull();
    expect(strip!.querySelector(".zen-island")).not.toBeNull();
    // One way out only: the floating one is gone while the strip holds it.
    expect(document.querySelectorAll(".zen-island").length).toBe(1);

    // Out of Zen the top bar shows: the chip lives there, not twice.
    await act(async () => {
      root.render(<App zen={false} />);
    });
    const plain = document.querySelector(".app > .companion-strip");
    expect(plain?.classList.contains("has-control")).toBe(false);
    expect(plain?.querySelector(".companion-chip")).toBeNull();
    expect(document.querySelectorAll(".companion-chip.is-call").length).toBe(1);
    expect(document.querySelector(".topbar .companion-chip.is-call")).not.toBe(
      null,
    );

    // The review covers the app beside the workspace list: its strip is
    // the only one (the app's would show beside it, over the list), and
    // the app's comes back once the review is hidden or closed.
    const Review = ({ hidden }: { hidden: boolean }) => (
      <div className="review-overlay" hidden={hidden}>
        <CompanionStrip control covering={!hidden} />
      </div>
    );
    await act(async () => {
      root.render(
        <>
          <App zen={false} />
          <Review hidden={false} />
        </>,
      );
    });
    expect(document.querySelectorAll(".companion-strip").length).toBe(1);
    expect(
      document.querySelector(".review-overlay > .companion-strip"),
    ).not.toBe(null);
    await act(async () => {
      root.render(
        <>
          <App zen={false} />
          <Review hidden />
        </>,
      );
    });
    expect(document.querySelectorAll(".companion-strip").length).toBe(2);
    expect(document.querySelector(".app > .companion-strip")).not.toBeNull();
    await act(async () => {
      root.render(<App zen={false} />);
    });
    expect(document.querySelectorAll(".companion-strip").length).toBe(1);
    expect(document.querySelector(".app > .companion-strip")).not.toBeNull();

    // Hanging up from the strip's chip in Zen ends it all.
    await act(async () => {
      root.render(<App zen />);
    });
    await act(async () => {
      (
        document.querySelector(
          '.companion-strip [aria-label="Hang up"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(document.querySelector(".companion-strip")).toBeNull();
    expect(document.querySelector(".app > .zen-island")).not.toBeNull();
    root.unmount();
  });
}
