import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import * as React from "react";
import type { VoiceSetupState } from "../../../shared/voiceSetup";

const GIB = 1024 ** 3;

/** The state a CPU-only laptop's server answers, nothing set up. */
function laptop(): VoiceSetupState {
  const option = (
    id: string,
    name: string,
    packages: string[],
    runsOn: "gpu" | "cpu" | "any",
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    packages,
    description: `${name}.`,
    sizeBytes: GIB,
    downloadBytes: GIB,
    speed: "fast",
    runsOn,
    installed: false,
    ...extra,
  });
  return {
    hardware: {
      platform: "linux",
      arch: "x64",
      osName: "Fedora Linux 43",
      cpu: { model: "Intel Core i5", cores: 8 },
      ramBytes: 16 * GIB,
      gpus: [],
      acceleration: "cpu",
      gpuBytes: 0,
    },
    tier: "light",
    recommended: {
      heavy: {
        speech: "parakeet",
        tts: "qwen3-tts-1.7b",
        stock_voices: "none",
      },
      light: { speech: "parakeet", tts: "kokoro-onnx", stock_voices: "none" },
    },
    current: {},
    components: [
      {
        id: "speech",
        title: "Speech recognition",
        description: "Speech to text.",
        optional: false,
        options: [option("parakeet", "Parakeet", ["parakeet"], "cpu")],
      },
      {
        id: "tts",
        title: "Reading voice",
        description: "Reads replies.",
        optional: false,
        options: [
          option(
            "qwen3-tts-1.7b",
            "Qwen3-TTS 1.7B",
            ["qwen-base", "kokoro-82m"],
            "gpu",
          ),
          option("kokoro-onnx", "Kokoro ONNX", ["kokoro-onnx"], "cpu"),
        ],
      },
      {
        id: "stock_voices",
        title: "Stock voices",
        description: "Named voices.",
        optional: true,
        requires: { component: "tts", options: ["qwen3-tts-1.7b"] },
        options: [
          option("customvoice-1.7b", "CustomVoice 1.7B", ["qwen-cv"], "gpu", {
            requires: { component: "tts", options: ["qwen3-tts-1.7b"] },
          }),
        ],
      },
    ],
    modelsDir: "/home/u/.local/share/roamgate/voice/models",
    configPath: "/home/u/.config/roamgate/voice.json",
    helper: {
      path: "/home/u/.local/share/roamgate/voice/roamgate-voice",
      found: false,
    },
    freeBytes: 100 * GIB,
    packages: Object.fromEntries(
      ["parakeet", "qwen-base", "kokoro-82m", "kokoro-onnx", "qwen-cv"].map(
        (id) => [id, { sizeBytes: GIB, downloadBytes: GIB }],
      ),
    ),
    unused: [],
    job: null,
  };
}

if (
  inIsolatedChild(
    import.meta.path,
    "voice setup in an isolated browser runtime",
    "ROAMGATE_VOICE_SETUP_DOM_TEST",
    20_000,
  )
) {
  test("shows the hardware, downloads the chosen models and follows the download", async () => {
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
    let state = laptop();
    const posted: unknown[] = [];
    let polls = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "/api/voice/setup" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        state = {
          ...state,
          job: {
            state: "downloading",
            files: [{ name: "Kokoro", size: 2 * GIB, done: GIB }],
            totalBytes: 2 * GIB,
            doneBytes: GIB,
            bytesPerSecond: 0,
            startedAt: 0,
            current: "Kokoro ONNX",
          },
        };
        return Response.json(state, { status: 202 });
      }
      if (url === "/api/voice/setup") {
        polls += 1;
        if (state.job && polls > 2)
          state = {
            ...state,
            current: { speech: "parakeet", tts: "kokoro-onnx" },
            job: {
              ...state.job,
              state: "done",
              doneBytes: 2 * GIB,
              reload: "now",
            },
          };
        return Response.json(state);
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const { VoiceSetup } = await import("./VoiceSetup");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const wait = async (check: () => boolean) =>
      React.act(async () => {
        for (let i = 0; i < 300 && !check(); i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      });
    const button = (text: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent?.includes(text),
      );
    try {
      await React.act(async () => root.render(<VoiceSetup />));
      await wait(() => Boolean(button("Set up voice")));
      expect(container.textContent).toContain("Voice chat has no models yet");
      await React.act(async () => button("Set up voice")?.click());
      expect(container.textContent).toContain("Intel Core i5, 8 threads");
      expect(container.textContent).toContain("Models run onthe CPU");
      // Light is proposed: Kokoro's ONNX model, no stock voices to choose.
      const selects = () => [...container.querySelectorAll("select")];
      expect(selects().map((select) => select.value)).toEqual([
        "parakeet",
        "kokoro-onnx",
      ]);
      expect(container.textContent).toContain("To download: 2.0 GB");
      expect(container.textContent).toContain("voice helper is not at");
      // Heavy brings the stock voices' choice.
      await React.act(async () => button("Heavy")?.click());
      expect(selects().map((select) => select.value)).toEqual([
        "parakeet",
        "qwen3-tts-1.7b",
        "none",
      ]);
      await React.act(async () => button("Light")?.click());
      await React.act(async () => button("Download and use")?.click());
      expect(posted).toEqual([
        {
          choices: {
            speech: "parakeet",
            tts: "kokoro-onnx",
            stock_voices: "none",
          },
        },
      ]);
      expect(container.querySelector("progress")?.getAttribute("value")).toBe(
        "50",
      );
      await wait(() => container.textContent?.includes("Done:") ?? false);
      expect(container.textContent).toContain(
        "The next voice request loads them.",
      );
    } finally {
      await React.act(async () => root.unmount());
      await browser.happyDOM.close();
    }
  });
}
