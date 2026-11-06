import { expect, test } from "bun:test";

if (process.env.ROAMGATE_COMPANION_PANEL_DOM_TEST !== "1") {
  test("the companion's conversation in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_COMPANION_PANEL_DOM_TEST: "1" },
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
  /** A browser for React to render in, as the page's globals. */
  async function installBrowser() {
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
      KeyboardEvent: browser.KeyboardEvent,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    return browser;
  }

  test("a call's conversation mutes, and follows the newest unless scrolled up", async () => {
    const browser = await installBrowser();
    // No layout here: each row is 50 px in a list 100 px tall.
    const tops = new WeakMap<object, number>();
    const list = browser.HTMLOListElement.prototype;
    Object.defineProperties(list, {
      scrollHeight: {
        configurable: true,
        get(this: HTMLOListElement) {
          return this.children.length * 50;
        },
      },
      clientHeight: { configurable: true, get: () => 100 },
      scrollTop: {
        configurable: true,
        get(this: HTMLOListElement) {
          return tops.get(this) ?? 0;
        },
        set(this: HTMLOListElement, top: number) {
          tops.set(this, top);
        },
      },
    });
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const companion = await import("../companionCall");
    const { setVoiceFronting } = await import("../voiceFrontFlag");
    const { CompanionPanel } = await import("./CompanionPanel");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    setVoiceFronting(true);
    // The call's host, as CompanionCall.tsx reports its voice chat.
    let mutes = 0;
    let sent = 0;
    companion.setCompanionControls({
      toggleMute: () => {
        mutes += 1;
        companion.setCompanionVoice({
          heard: "",
          muted: !companion.companionCallState().muted,
          since: null,
        });
      },
      tap: () => {},
      sendNow: () => {
        sent += 1;
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      companion.startCompanionCall();
      for (const text of ["Un.", "Deux.", "Trois.", "Quatre."])
        companion.logCompanion({ kind: "heard", text });
      root.render(<CompanionPanel onClose={() => {}} />);
    });
    const panel = document.querySelector(".companion-panel")!;
    const log = panel.querySelector<HTMLOListElement>(".companion-panel-log")!;
    const mute = () =>
      panel.querySelector<HTMLButtonElement>(".companion-panel-mute")!;
    const latest = () => panel.querySelector(".companion-panel-latest");

    // Mute, next to Hang up: the microphone off, said so, and back.
    expect(panel.querySelector(".companion-panel-hang-up")).not.toBeNull();
    expect(mute().textContent).toBe("Mute");
    expect(mute().getAttribute("aria-pressed")).toBe("false");
    await act(async () => mute().click());
    expect(mutes).toBe(1);
    expect(mute().textContent).toBe("Muted");
    expect(mute().getAttribute("aria-pressed")).toBe("true");
    expect(mute().classList.contains("is-muted")).toBe(true);
    expect(panel.querySelector(".modal-head p")?.textContent).toContain(
      "In a call, muted",
    );
    await act(async () => mute().click());
    expect(mute().textContent).toBe("Mute");
    expect(mute().getAttribute("aria-pressed")).toBe("false");

    // Opened at the newest; what comes is followed.
    expect(log.scrollTop).toBe(100);
    expect(latest()).toBeNull();
    await act(async () => {
      companion.logCompanion({ kind: "said", text: "Cinq." });
      await settle();
    });
    expect(log.scrollTop).toBe(150);

    // Scrolled up to read: it stays, and offers the way back.
    await act(async () => {
      log.scrollTop = 0;
      log.dispatchEvent(new Event("scroll"));
    });
    expect(latest()?.textContent).toBe(" Jump to latest");
    await act(async () => {
      companion.logCompanion({ kind: "said", text: "Six." });
      await settle();
    });
    expect(log.scrollTop).toBe(0);

    // Back to the newest, and following again.
    await act(async () => (latest() as HTMLButtonElement).click());
    expect(log.scrollTop).toBe(200);
    expect(latest()).toBeNull();
    await act(async () => {
      companion.logCompanion({ kind: "said", text: "Sept." });
      await settle();
    });
    expect(log.scrollTop).toBe(250);

    // What the user says is written as it is heard, a caption under the
    // last line, followed like the rest; once said, it is their line.
    const hearing = () => panel.querySelector(".companion-panel-hearing");
    expect(hearing()).toBeNull();
    const hear = async (heard: string, muted = false) =>
      act(async () => {
        companion.setCompanionVoice({ heard, muted, since: null });
        await settle();
      });
    await hear("Quel temps");
    expect(hearing()?.textContent).toBe("Quel temps");
    expect(log.lastElementChild).toBe(hearing());
    expect(log.scrollTop).toBe(300);
    const caption = hearing();
    await hear("Quel temps fait-il");
    expect(hearing()).toBe(caption);
    expect(hearing()?.textContent).toBe("Quel temps fait-il");
    // Sent now, by its button or Mod+Enter, without waiting for the pause.
    await act(async () =>
      hearing()
        ?.querySelector<HTMLButtonElement>(".companion-panel-send-now")
        ?.click(),
    );
    expect(sent).toBe(1);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }),
      );
    });
    expect(sent).toBe(2);
    // Muted, or the companion speaking: nothing of it is shown.
    await hear("Quel temps fait-il", true);
    expect(hearing()).toBeNull();
    await hear("Quel temps fait-il");
    await act(async () => companion.setCompanionPresence("speaking"));
    expect(hearing()).toBeNull();
    await act(async () => companion.setCompanionPresence("listening"));
    expect(hearing()).not.toBeNull();
    // Its own words heard back are not the user's.
    await act(async () => companion.setCompanionLine("Il fait beau."));
    await hear("il fait beau");
    expect(hearing()).toBeNull();
    await act(async () => companion.setCompanionLine(null));
    // The utterance ends: the caption becomes the user's line.
    await act(async () => {
      companion.logCompanion({ kind: "heard", text: "Quel temps fait-il ?" });
      companion.setCompanionVoice({ heard: "", muted: false, since: null });
      await settle();
    });
    expect(hearing()).toBeNull();
    // Nothing being said: Mod+Enter does nothing.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }),
      );
    });
    expect(sent).toBe(2);
    const lines = panel.querySelectorAll(".companion-panel-line p");
    expect(lines[lines.length - 1]?.textContent).toBe("Quel temps fait-il ?");
    expect(log.scrollTop).toBe(300);

    // Hung up: no Mute left.
    await act(async () => companion.endCompanionCall());
    expect(panel.querySelector(".companion-panel-mute")).toBeNull();
    await act(async () => root.unmount());
  });

  test("asked without a call: its box takes the focus, a held call its buttons", async () => {
    await installBrowser();
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const companion = await import("../companionCall");
    const { setVoiceFronting } = await import("../voiceFrontFlag");
    const { CompanionPanel } = await import("./CompanionPanel");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    companion.__resetCompanionCallForTests();
    setVoiceFronting(true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<CompanionPanel onClose={() => {}} ask={1} />);
    });
    const panel = document.querySelector<HTMLElement>(".companion-panel")!;
    const input = panel.querySelector<HTMLInputElement>(
      ".companion-panel-composer input",
    )!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("placeholder")).toBe("Ask Companion anything");
    // No call: nothing to mute or hang up, a call to start if wanted.
    expect(panel.querySelector(".companion-panel-hang-up")).toBeNull();
    expect(panel.querySelector(".companion-panel-mute")).toBeNull();

    // Something typed: thinking until the front decides.
    const thinking = () => panel.querySelector(".companion-panel-thinking");
    let back = () => {};
    await act(async () => {
      back = companion.companionTypedTurn();
    });
    expect(thinking()?.textContent).toBe("Companion is thinking...");
    expect(panel.querySelector(".modal-head p")?.textContent).toBe("thinking");
    await act(async () => back());
    expect(thinking()).toBeNull();
    expect(panel.querySelector(".modal-head p")?.textContent).toBe("idle");

    // A call its tools hold: what it would do, and its buttons.
    const posted: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posted.push([String(url), JSON.parse(String(init?.body))]);
      return Response.json({ declined: "t1" });
    }) as unknown as typeof fetch;
    try {
      await act(async () => {
        companion.logCompanion({
          kind: "web",
          job: "t1",
          tool: true,
          question: "Tell Marie I'm on my way",
          status: "done",
          steps: [],
          spoken: 'I would send Marie "On my way". Shall I?',
          held: true,
        });
      });
      const entry = () => panel.querySelector(".companion-panel-web")!;
      const status = () =>
        entry().querySelector(".companion-panel-status")?.textContent;
      const buttons = () => [
        ...entry().querySelectorAll<HTMLButtonElement>(
          ".companion-panel-held button",
        ),
      ];
      expect(entry().classList.contains("is-held")).toBe(true);
      expect(status()).toBe("Waiting for your OK");
      expect(buttons().map((button) => button.textContent)).toEqual([
        " Yes, do it",
        " No",
      ]);
      await act(async () => {
        buttons()[1]!.click();
        await settle();
      });
      expect(posted).toEqual([
        ["/api/voice/tools/answer", { job: "t1", answer: "no" }],
      ]);
      expect(buttons()).toEqual([]);
      expect(status()).toBe("Declined");
      expect(entry().classList.contains("is-held")).toBe(false);
      const said = [...panel.querySelectorAll(".companion-panel-line p")].map(
        (line) => line.textContent,
      );
      expect(said.slice(-2)).toEqual([
        "No, don't.",
        "OK, I won't send anything.",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Asked again while open: the box takes the focus back.
    panel.focus();
    expect(document.activeElement).toBe(panel);
    await act(async () => {
      root.render(<CompanionPanel onClose={() => {}} ask={2} />);
    });
    expect(document.activeElement).toBe(input);
    await act(async () => root.unmount());
  });
}
