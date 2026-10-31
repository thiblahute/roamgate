import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_VOICE_SETTINGS_DOM_TEST !== "1") {
  test("voice settings in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_VOICE_SETTINGS_DOM_TEST: "1" },
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
  test("a voice used while the browser reads with its own reads with it again", async () => {
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
      MouseEvent: browser.MouseEvent,
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
    // Kokoro already reads every reply on the server.
    const library = {
      voices: [],
      kokoro: true,
      surprise: false,
      assignments: { all: "kokoro", languages: {} },
      can_clone: false,
    };
    const assigned: unknown[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/voice")
        return Response.json({ available: true, speech_rate: 1 });
      if (url === "/api/voice/voices") return Response.json(library);
      if (url === "/api/voice/voices/assign") {
        assigned.push(JSON.parse(String(init?.body)));
        return Response.json(library);
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const { VoiceSettings } = await import("./VoiceSettings");
    const { loadSpeechEngine, readWithNow, setReadWith, speechEngine } =
      await import("../speechEngine");
    setReadWith("browser");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(<VoiceSettings />);
      await loadSpeechEngine();
    });
    const use = () =>
      container.querySelector<HTMLButtonElement>(".voice-settings-use");
    try {
      await React.act(async () => {
        for (let i = 0; i < 20 && !use(); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(speechEngine()).toBe("browser");
      // The browser's own voice reads: Kokoro does not show as reading,
      // and can be used.
      expect(container.textContent).toContain(
        "This browser reads replies with its own voice",
      );
      expect(use()?.textContent).toBe("Use");
      expect(use()?.disabled).toBe(false);
      await React.act(async () => {
        use()?.click();
        for (let i = 0; i < 20 && readWithNow() !== "server"; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(assigned).toEqual([{ voice: "kokoro", language: null }]);
      // Using it reads with the server's engine, from the next sentence.
      expect(readWithNow()).toBe("server");
      expect(speechEngine()).toBe("server");
      expect(use()?.textContent).toBe("Reading");
      expect(container.textContent).not.toContain(
        "This browser reads replies with its own voice",
      );
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
