import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "what a call reads, in an isolated browser runtime",
    "ROAMGATE_COMPANION_READING_DOM_TEST",
    30_000,
  )
) {
  const setUp = async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    // The CSS Custom Highlight API, as the page uses it.
    class Highlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const highlights = new Map<string, Highlight>();
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
      KeyboardEvent: browser.KeyboardEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
      innerHeight: 800,
      Highlight,
      CSS: {
        highlights,
        escape: (text: string) => text.replace(/["\\]/g, "\\$&"),
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const companion = await import("../companionCall");
    const { companionFrontVoice } = await import("../companionSay");
    const { createFrontVoice } = await import("../voiceFront");
    const { CompanionChip, CompanionStrip } = await import("./CompanionChip");
    const { CompanionPanel } = await import("./CompanionPanel");
    // A voice whose sentence ends on `next()`.
    const played: string[] = [];
    let next = () => {};
    const voice = companionFrontVoice(
      createFrontVoice({
        fetchAudio: async (text) => text,
        playAudio: (audio, signal) => {
          played.push(audio);
          return new Promise<void>((resolve) => {
            next = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
    );
    companion.__resetCompanionCallForTests();
    // What it says, its state published in act as a page's would be.
    const say = (...args: Parameters<typeof voice.say>) => {
      let done: Promise<void> = Promise.resolve();
      React.act(() => {
        done = voice.say(...args);
      });
      return done;
    };
    const flush = async () => {
      await React.act(async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
    };
    const shown = (selector: string) =>
      document.querySelector(selector)?.textContent ?? null;
    const highlighted = () =>
      highlights.get("roamgate-reading")?.ranges[0]?.toString() ?? null;
    return {
      React,
      createRoot,
      companion,
      say,
      played,
      next: () => next(),
      flush,
      shown,
      highlighted,
      CompanionChip,
      CompanionStrip,
      CompanionPanel,
    };
  };

  test("a call shows what it reads, a sentence at a time, in the page's flow", async () => {
    const t = await setUp();
    const { React, companion, say, flush, shown } = t;
    const host = document.createElement("div");
    document.body.append(host);
    const root = t.createRoot(host);
    const App = () => (
      <div className="app">
        <header className="topbar">
          <t.CompanionChip />
        </header>
        <t.CompanionStrip />
        <main>chat</main>
      </div>
    );
    await React.act(async () => {
      root.render(<App />);
      companion.startCompanionCall("local/w1:p1");
    });
    // Nothing said yet: the strip's line only.
    expect(document.querySelector(".companion-reading")).toBeNull();

    const long =
      "The second sentence is a long one, read slowly on the phone, and it is shown whole with nothing of it cut, however long it goes on.";
    const stop = new AbortController();
    const said = say(`First, a short one. ${long} Third.`, stop.signal);
    await flush();
    // The sentence playing is shown in full, the next one dimmed after it.
    expect(t.played).toEqual(["First, a short one."]);
    expect(shown(".companion-reading-now")).toBe("First, a short one.");
    expect(document.querySelector(".companion-reading-before")).toBeNull();
    expect(shown(".companion-reading-after")).toBe(long);
    expect(shown(".companion-strip-line span")).toBe("Speaking, 1 of 3");

    // The reading moves on: the view follows each sentence as it plays.
    t.next();
    await flush();
    expect(t.played[1]).toBe(long);
    expect(shown(".companion-reading-now")).toBe(long);
    expect(shown(".companion-reading-before")).toBe("First, a short one.");
    expect(shown(".companion-reading-after")).toBe("Third.");
    expect(shown(".companion-strip-line span")).toBe("Speaking, 2 of 3");

    // It sits in the strip, in the page's flow under the top bar: the
    // content comes after it and nothing is laid over it.
    const strip = document.querySelector(".app > .companion-strip")!;
    expect(strip.classList.contains("has-reading")).toBe(true);
    expect(strip.previousElementSibling?.className).toBe("topbar");
    expect(strip.nextElementSibling?.tagName).toBe("MAIN");
    expect(strip.querySelector(".companion-reading")).not.toBeNull();
    const css = await Bun.file(
      new URL("./CompanionReading.css", import.meta.url),
    ).text();
    expect(css).not.toMatch(/position:\s*(absolute|fixed|sticky)/);
    expect(css).toMatch(/\.companion-reading \{[^}]*flex: 1 0 100%/);

    // A tap opens the whole text, the sentence said marked; another closes it.
    const view = document.querySelector<HTMLElement>(".companion-reading")!;
    await React.act(async () => view.click());
    expect(view.getAttribute("aria-expanded")).toBe("true");
    expect(shown(".companion-reading-whole")).toBe(
      `First, a short one. ${long} Third. `,
    );
    expect(shown(".companion-reading-whole .is-now")).toBe(`${long} `);
    expect(
      document.querySelectorAll(".companion-reading-whole .is-said").length,
    ).toBe(1);
    t.next();
    await flush();
    expect(shown(".companion-reading-whole .is-now")).toBe("Third. ");
    await React.act(async () => view.click());
    expect(view.getAttribute("aria-expanded")).toBe("false");
    expect(shown(".companion-reading-now")).toBe("Third.");

    // Said to its end: it stays, quieter, until something else is said.
    t.next();
    await flush();
    await said;
    expect(view.classList.contains("is-done")).toBe(true);
    expect(shown(".companion-reading-now")).toBe("Third.");
    expect(shown(".companion-strip-line span")).toBe("Said.");
    const after = say("Ok.", stop.signal);
    await flush();
    expect(shown(".companion-reading-now")).toBe("Ok.");
    expect(view.classList.contains("is-done")).toBe(false);
    expect(document.querySelector(".companion-reading-after")).toBeNull();

    // The call ends: nothing of it is left.
    await React.act(async () => companion.endCompanionCall());
    await React.act(async () => {
      stop.abort();
      await after;
    });
    expect(document.querySelector(".companion-strip")).toBeNull();
    root.unmount();
  });

  test("its conversation view marks the line said, at its sentence", async () => {
    const t = await setUp();
    const { React, companion, say, flush } = t;
    const host = document.createElement("div");
    document.body.append(host);
    const root = t.createRoot(host);
    await React.act(async () => {
      companion.startCompanionCall("local/w1:p1");
      root.render(<t.CompanionPanel onClose={() => {}} />);
    });
    const stop = new AbortController();
    void say("Earlier words.", stop.signal);
    await flush();
    t.next();
    await flush();
    const said = say("Je regarde. La CI a échoué.", stop.signal);
    await flush();
    t.next();
    await flush();
    const lines = document.querySelectorAll(".companion-panel-line.is-said");
    expect(lines.length).toBe(2);
    expect(lines[0]!.classList.contains("is-saying")).toBe(false);
    expect(lines[1]!.classList.contains("is-saying")).toBe(true);
    expect(lines[1]!.getAttribute("aria-current")).toBe("true");
    expect(lines[1]!.querySelector(".companion-panel-now")?.textContent).toBe(
      "La CI a échoué. ",
    );
    t.next();
    await flush();
    await said;
    expect(document.querySelector(".companion-panel-line.is-saying")).toBe(
      null,
    );
    expect(lines[1]!.querySelector("p")?.textContent).toBe(
      "Je regarde. La CI a échoué.",
    );
    await React.act(async () => companion.endCompanionCall());
    root.unmount();
  });

  test("an agent's answer read word for word is highlighted in its chat", async () => {
    const t = await setUp();
    const { React, companion, say, flush, highlighted } = t;
    await React.act(async () => companion.startCompanionCall("local/w1:p1"));
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-entry-id="older"><div class="agent-history-chat-bubble"><p>Two tests are flaky in another chat.</p></div></div>
       <div data-entry-id="e1"><div class="agent-history-chat-bubble"><p>The build passed on main.</p><ul><li>Two tests are flaky.</li></ul></div></div>`,
    );
    const stop = new AbortController();
    // Read whole (relay mode, or "read me the whole answer"): its entries known.
    const read = say(
      "Claude : The build passed on main. Two tests are flaky.",
      stop.signal,
      { answer: { agent: "Claude", ids: ["e1"] } },
    );
    await flush();
    // Its name, said first, is in no bubble.
    expect(highlighted()).toBeNull();
    t.next();
    await flush();
    expect(highlighted()).toBe("The build passed on main.");
    t.next();
    await flush();
    const e1 = document.querySelector('[data-entry-id="e1"]')!;
    const range = (
      globalThis.CSS as unknown as {
        highlights: Map<string, { ranges: Range[] }>;
      }
    ).highlights.get("roamgate-reading")!.ranges[0]!;
    expect(range.toString()).toBe("Two tests are flaky.");
    expect(e1.contains(range.startContainer)).toBe(true);
    t.next();
    await flush();
    await read;
    expect(highlighted()).toBeNull();

    // A session's answer to a job: no entries known, found in the chat on
    // screen, the message its first sentence was found in kept after.
    const job = say(
      "Roamgate: The build passed on main. Two tests are flaky.",
      stop.signal,
      { answer: { agent: "Roamgate", ids: [] } },
    );
    await flush();
    t.next();
    await flush();
    expect(highlighted()).toBe("The build passed on main.");
    t.next();
    await flush();
    const anywhere = (
      globalThis.CSS as unknown as {
        highlights: Map<string, { ranges: Range[] }>;
      }
    ).highlights.get("roamgate-reading")!.ranges[0]!;
    expect(anywhere.toString()).toBe("Two tests are flaky.");
    expect(e1.contains(anywhere.startContainer)).toBe(true);
    t.next();
    await flush();
    await job;

    // What the companion says itself is in no chat: nothing highlighted.
    const own = say("The build passed on main.", stop.signal);
    await flush();
    expect(highlighted()).toBeNull();
    t.next();
    await flush();
    await own;
    await React.act(async () => companion.endCompanionCall());
  });
}
