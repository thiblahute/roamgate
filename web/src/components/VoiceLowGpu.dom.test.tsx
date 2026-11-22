import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import * as React from "react";
import type { LowGpuStatus } from "../../../shared/voiceLowGpu";

function status(extra: Partial<LowGpuStatus> = {}): LowGpuStatus {
  return {
    active: false,
    reason: null,
    holders: [],
    gameMode: null,
    running: "full",
    pending: false,
    choices: { speech: "parakeet", tts: "kokoro-onnx" },
    models: [
      {
        component: "speech",
        title: "Speech recognition",
        name: "Parakeet TDT 0.6B v3",
        runsOn: "cpu",
      },
      {
        component: "reread",
        title: "Second reading",
        name: "none",
        runsOn: "none",
      },
      {
        component: "tts",
        title: "Reading voice",
        name: "Kokoro v1.0 (ONNX)",
        runsOn: "cpu",
      },
    ],
    gpuBytes: 0,
    overrides: {},
    path: "/home/u/.local/share/roamgate/voice/low-gpu.json",
    ...extra,
  };
}

if (
  inIsolatedChild(
    import.meta.path,
    "low-GPU voice in an isolated browser runtime",
    "ROAMGATE_VOICE_LOW_GPU_DOM_TEST",
    20_000,
  )
) {
  test("turns the light models on, says who else holds them, switches a call now", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      MouseEvent: browser.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    let state = status({ holders: [], gameMode: true });
    const posted: unknown[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input) !== "/api/voice/low-gpu")
        return new Response(null, { status: 404 });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        state =
          body.now === true && body.on === undefined
            ? { ...state, pending: false, running: "low-gpu" }
            : {
                ...state,
                active: true,
                reason: "manual",
                holders: ["manual", "gaming"],
                pending: true,
              };
      }
      return Response.json(state);
    }) as typeof fetch;
    const { VoiceLowGpu } = await import("./VoiceLowGpu");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const wait = async (check: () => boolean) =>
      React.act(async () => {
        for (let i = 0; i < 300 && !check(); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      });
    const checkbox = () =>
      container.querySelector<HTMLInputElement>("input[type=checkbox]");
    const button = (text: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent?.includes(text),
      );
    try {
      await React.act(async () => root.render(<VoiceLowGpu />));
      await wait(() => Boolean(checkbox()));
      expect(container.textContent).toContain("Gaming: light voice models");
      expect(checkbox()?.checked).toBe(false);
      expect(container.textContent).toContain("On for: GameMode");
      expect(container.textContent).toContain(
        "Parakeet TDT 0.6B v3 (CPU), Kokoro v1.0 (ONNX) (CPU): about 0 B of GPU memory",
      );
      await React.act(async () => checkbox()?.click());
      await wait(() => Boolean(button("Switch now")));
      expect(posted).toEqual([{ on: true, now: false }]);
      expect(checkbox()?.checked).toBe(true);
      expect(container.textContent).toContain(
        "The call going on keeps the full models until it ends.",
      );
      await React.act(async () => button("Switch now")?.click());
      await wait(() => !button("Switch now"));
      expect(posted[posted.length - 1]).toEqual({ now: true });
      expect(container.textContent).toContain(
        "The voice runs with the light models now.",
      );
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
