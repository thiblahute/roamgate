import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_SPEECH_SETTINGS_DOM_TEST !== "1") {
  test("speech settings in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SPEECH_SETTINGS_DOM_TEST: "1" },
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
  }, 20_000);
} else {
  test("only the speed of the engine that reads is offered", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      Event: browser.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const synthesis = new browser.EventTarget();
    Object.assign(synthesis, { getVoices: () => [], cancel() {}, speak() {} });
    Object.defineProperty(browser, "speechSynthesis", {
      value: synthesis,
      configurable: true,
    });
    Object.defineProperty(browser, "SpeechSynthesisUtterance", {
      value: class {},
      configurable: true,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input) === "/api/voice"
        ? Response.json({ available: true, speech_rate: 1.3 })
        : new Response(null, { status: 404 })) as typeof fetch;
    const { SpeechSettings } = await import("./SpeechSettings");
    const { loadSpeechEngine, setReadWith } = await import("../speechEngine");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(<SpeechSettings />);
      await loadSpeechEngine();
    });
    try {
      // The server's engine reads: its speed is the one shown, and the
      // browser's rate, which it would not use, is not offered.
      expect(container.textContent).toContain("Server reading speed: 1.3x");
      expect(container.textContent).not.toContain("Browser speaking rate");
      expect(container.querySelector('input[type="range"]')).toBeNull();
      await React.act(async () => setReadWith("browser"));
      expect(container.textContent).toContain("Browser speaking rate: 1.0x");
      expect(container.querySelector('input[type="range"]')).not.toBeNull();
      // Heard in calls here: nothing said of calls.
      expect(container.textContent).not.toContain("voice call");
      // It failed in a call here: said, with a way to try it again.
      localStorage.setItem(
        "roamgate:browserVoiceSilentInCalls",
        "it did not start in 4 s",
      );
      await React.act(async () => setReadWith("browser"));
      expect(container.textContent).toContain(
        "This browser's voice did not play in a voice call on this device, so calls read with Roamgate's voice engine.",
      );
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Try it in calls again",
      );
      expect(retry).toBeDefined();
      await React.act(async () => retry?.click());
      expect(container.textContent).not.toContain("voice call");
      expect(
        localStorage.getItem("roamgate:browserVoiceSilentInCalls"),
      ).toBeNull();
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
