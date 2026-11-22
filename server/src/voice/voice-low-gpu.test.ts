import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NO_MODEL } from "../../../shared/voiceSetup";
import { readVoiceConfig, type VoiceConfig } from "./voice-helper";
import {
  forGaming,
  GAMING_CPU_THREADS,
  gameModeCommand,
  gpuBytesFor,
  holdLowGpu,
  type LowGpuDeps,
  lowGpuChoices,
  parseGameMode,
  readLowGpu,
  setLowGpuModels,
  SWITCH_NOTICES,
  VoiceLowGpu,
  yieldCpu,
} from "./voice-low-gpu";
import { recommendedChoices } from "./voice-models";
import { installVoiceModels } from "./voice-setup";
import {
  GIB,
  NVIDIA_DESKTOP,
  type SetupHome,
  serveModels,
  setupHome,
} from "./voice-setup-testing";

const server = serveModels();
afterAll(() => server.stop());

let home: SetupHome;
let statePath: string;
beforeEach(() => {
  home = setupHome(server);
  statePath = join(
    home.home,
    ".local",
    "share",
    "roamgate",
    "voice",
    "low-gpu.json",
  );
});
afterEach(() => home.cleanup());

/** Every package installed, as on the desktop: roots for lowGpuChoices. */
const ALL = Object.fromEntries(
  server.packages.map((entry) => [entry.id, `/m/${entry.id}`]),
);

/** ALL but these packages. */
const without = (...ids: string[]) =>
  Object.fromEntries(Object.entries(ALL).filter(([id]) => !ids.includes(id)));

describe("low-GPU state file", () => {
  test("holders hold it on, each one lets go, off alone lets all go", () => {
    expect(readLowGpu(statePath)).toEqual({ holders: {} });
    holdLowGpu(statePath, { on: true, holder: "gaming" }, 10);
    holdLowGpu(statePath, { on: true }, 20);
    // Holding again keeps the first time.
    holdLowGpu(statePath, { on: true, holder: "gaming" }, 30);
    expect(readLowGpu(statePath).holders).toEqual({ gaming: 10, manual: 20 });
    holdLowGpu(statePath, { on: false, holder: "gaming" });
    expect(readLowGpu(statePath).holders).toEqual({ manual: 20 });
    holdLowGpu(statePath, { on: true, holder: "render", now: true }, 40);
    expect(readLowGpu(statePath)).toEqual({
      holders: { manual: 20, render: 40 },
      now: 40,
    });
    holdLowGpu(statePath, { on: false });
    expect(readLowGpu(statePath).holders).toEqual({});
    expect(() => holdLowGpu(statePath, { on: true, holder: "a b" })).toThrow(
      "a holder is letters",
    );
  });

  test("parts set by hand are checked and kept, reset goes back", () => {
    setLowGpuModels(statePath, { tts: "kokoro-82m" });
    setLowGpuModels(statePath, { text_turn: NO_MODEL });
    expect(readLowGpu(statePath).models).toEqual({
      tts: "kokoro-82m",
      text_turn: NO_MODEL,
    });
    expect(() => setLowGpuModels(statePath, { tts: "nope" })).toThrow(
      "no reading voice model named nope",
    );
    setLowGpuModels(statePath, null);
    expect(readLowGpu(statePath).models).toBeUndefined();
  });

  test("a broken file reads as off", () => {
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath, "{not json");
    expect(readLowGpu(statePath)).toEqual({ holders: {} });
    writeFileSync(
      statePath,
      JSON.stringify({ holders: { "bad name": 1, ok: "x", fine: 2 } }),
    );
    expect(readLowGpu(statePath).holders).toEqual({ fine: 2 });
  });
});

describe("GameMode", () => {
  test("gamemoded -s's answer", () => {
    expect(parseGameMode("gamemode is active\n")).toBe(true);
    expect(parseGameMode("gamemode is inactive\n")).toBe(false);
    expect(parseGameMode("")).toBeNull();
    expect(parseGameMode("sh: gamemoded: command not found")).toBeNull();
  });

  test("asked on the host from a toolbox", () => {
    expect(gameModeCommand(true)).toEqual([
      "host-spawn",
      "--no-pty",
      "gamemoded",
      "-s",
    ]);
    expect(gameModeCommand(false)).toEqual(["gamemoded", "-s"]);
  });
});

describe("yielding the CPU to a game", () => {
  test("only for the gaming holder or GameMode", () => {
    expect(forGaming("gaming")).toBe(true);
    expect(forGaming("GameMode")).toBe(true);
    expect(forGaming("render, GameMode")).toBe(true);
    expect(forGaming("render")).toBe(false);
    expect(forGaming("manual, gaming-ish")).toBe(false);
  });

  test("a few ONNX threads, as many as voice.json says, 0 for no limit", () => {
    expect(yieldCpu({}, "gaming")).toEqual({ threads: GAMING_CPU_THREADS });
    expect(yieldCpu({ gaming_cpu_threads: 2 }, "GameMode")).toEqual({
      threads: 2,
    });
    expect(yieldCpu({ gaming_cpu_threads: 0 }, "gaming")).toEqual({
      threads: 0,
    });
    expect(yieldCpu({}, "render")).toBeUndefined();
  });
});

describe("the low-GPU set", () => {
  test("is the light tier among what is here: Parakeet, Kokoro on the CPU", () => {
    const choices = lowGpuChoices(ALL, {}, 64 * GIB);
    expect(choices).toEqual({
      ...recommendedChoices(NVIDIA_DESKTOP).light,
      tts: "kokoro-onnx",
    });
    expect(choices.reread).toBe(NO_MODEL);
    expect(choices.text_turn).toBe("qwen3-0.6b");
    expect(gpuBytesFor(choices)).toBe(0);
    // The full set, for comparison: Whisper and Qwen3-TTS on the GPU.
    expect(gpuBytesFor(recommendedChoices(NVIDIA_DESKTOP).heavy)).toBe(
      7.1 * GIB,
    );
  });

  test("takes the lightest one here when the light tier's is not", () => {
    const noOnnx = without("kokoro-onnx");
    // The other Kokoro on the CPU, then Kokoro on the GPU.
    expect(lowGpuChoices(noOnnx, {}, 64 * GIB).tts).toBe("kokoro-onnx-int8");
    const noCpuKokoro = without("kokoro-onnx", "kokoro-onnx-int8");
    expect(lowGpuChoices(noCpuKokoro, {}, 64 * GIB).tts).toBe("kokoro-82m");
    const noTextTurn = without("qwen3-0.6b-onnx");
    expect(lowGpuChoices(noTextTurn, {}, 64 * GIB).text_turn).toBe(NO_MODEL);
    // With less memory, the light tier has no text turn model.
    expect(lowGpuChoices(ALL, {}, 8 * GIB).text_turn).toBe(NO_MODEL);
  });

  test("parts set by hand win, when they are here", () => {
    expect(lowGpuChoices(ALL, {}, 64 * GIB, { tts: "kokoro-82m" }).tts).toBe(
      "kokoro-82m",
    );
    const noAnyTts = without("kokoro-82m");
    expect(
      lowGpuChoices(noAnyTts, {}, 64 * GIB, { tts: "kokoro-82m" }).tts,
    ).toBe("kokoro-onnx");
  });

  test("keeps voice.json's own model when nothing lighter is here", () => {
    expect(lowGpuChoices({}, { tts: "custom" }, 64 * GIB).tts).toBe("custom");
  });
});

/** The desktop's models installed: light first, then heavy over it. */
async function desktop(): Promise<void> {
  mkdirSync(join(home.deps.helperPath, ".."), { recursive: true });
  writeFileSync(home.deps.helperPath, "");
  await installVoiceModels(recommendedChoices(NVIDIA_DESKTOP).light, home.deps);
  await installVoiceModels(recommendedChoices(NVIDIA_DESKTOP).heavy, home.deps);
  const config = JSON.parse(readFileSync(home.deps.configPath, "utf8"));
  // voice.json's own settings, which the profile keeps.
  config.front_model = "opus";
  config.helper_idle_exit_minutes = 10;
  writeFileSync(home.deps.configPath, JSON.stringify(config));
}

type FakeHelper = LowGpuDeps["helper"] & {
  calls: string[];
  running: "low-gpu" | "full" | null;
  busy: boolean;
};

function fakeHelper(): FakeHelper {
  const helper: FakeHelper = {
    calls: [],
    running: "full",
    busy: false,
    runningProfile: () => helper.running,
    reloadModels: () => {
      helper.calls.push("reload");
      if (helper.running === null) return "not-running";
      if (helper.busy) return "after-call";
      helper.running = null;
      return "now";
    },
    reloadModelsAndWait: async () => {
      helper.calls.push("reload-and-wait");
      if (helper.running === null) return "not-running";
      if (helper.busy) return "after-call";
      helper.running = null;
      return "now";
    },
    restartModels: () => {
      helper.calls.push("restart");
      return true;
    },
    currentCallId: () => (helper.busy ? 7 : undefined),
    speakInCall: async (call, text) => {
      helper.calls.push(`say ${call}: ${text}`);
      return {} as Awaited<ReturnType<LowGpuDeps["helper"]["speakInCall"]>>;
    },
  };
  return helper;
}

function profile(helper: FakeHelper, gameMode: boolean | null = null) {
  return new VoiceLowGpu({
    path: statePath,
    readConfig: () => readVoiceConfig(home.deps.configPath),
    modelsDir: home.deps.modelsDir,
    helper,
    gameMode: async () => gameMode,
    ramBytes: 64 * GIB,
    packages: server.packages,
    retryMs: 15_000,
  });
}

const quiet = () => {
  const original = console.error;
  console.error = () => {};
  return () => (console.error = original);
};

describe("the low-GPU profile", () => {
  test("puts its set over voice.json while on, voice.json untouched", async () => {
    await desktop();
    const before = readFileSync(home.deps.configPath, "utf8");
    const helper = fakeHelper();
    const low = profile(helper);
    const full = low.config() as VoiceConfig;
    // Qwen3-TTS reads, Kokoro-82M beside it, on the GPU.
    expect(full.clone_model).toContain("Qwen3-TTS-1.7B-Base");
    expect(full.tts_models?.length).toBeGreaterThan(0);
    expect(full.low_gpu).toBeUndefined();

    holdLowGpu(statePath, { on: true, holder: "gaming" });
    const light = low.config() as VoiceConfig;
    expect(light.low_gpu).toBe("gaming");
    expect(light.yield_cpu).toEqual({ threads: GAMING_CPU_THREADS });
    expect(light.tts_models).toBeUndefined();
    expect(light.clone_model).toBeUndefined();
    expect(light.whisper_model).toBeUndefined();
    expect(light.kokoro_model).toBe(
      join(home.deps.modelsDir, "kokoro-v1.0.onnx"),
    );
    expect(light.parakeet_model).toBe(full.parakeet_model);
    expect(light.speaker_model).toBe(full.speaker_model);
    expect(light.text_turn_model).toBe(full.text_turn_model);
    // Its other settings stay.
    expect(light.front_model).toBe("opus");
    expect(light.helper_idle_exit_minutes).toBe(10);
    expect(light.helper).toBe(home.deps.helperPath);
    expect(readFileSync(home.deps.configPath, "utf8")).toBe(before);

    // Another holder than a game: the GPU is freed, the CPU not yielded.
    holdLowGpu(statePath, { on: false, holder: "gaming" });
    holdLowGpu(statePath, { on: true, holder: "render" });
    const render = low.config() as VoiceConfig;
    expect(render.low_gpu).toBe("render");
    expect(render.yield_cpu).toBeUndefined();
    holdLowGpu(statePath, { on: false, holder: "render" });
    holdLowGpu(statePath, { on: true, holder: "gaming" });

    const status = low.status();
    expect(status).toMatchObject({
      active: true,
      reason: "gaming",
      holders: ["gaming"],
      running: "full",
      gpuBytes: 0,
    });
    expect(
      status.models.find((model) => model.component === "tts"),
    ).toMatchObject({ name: "Kokoro v1.0 (ONNX)", runsOn: "cpu" });
  });

  test("a free helper with the other set stops at once", async () => {
    await desktop();
    const helper = fakeHelper();
    const low = profile(helper);
    expect(await low.apply()).toBe("in-effect");
    holdLowGpu(statePath, { on: true, holder: "gaming" });
    expect(await low.apply()).toBe("now");
    expect(helper.calls).toEqual(["reload"]);
    expect(await low.apply()).toBe("not-running");
  });

  test("a call keeps its set until it ends, then the helper stops", async () => {
    await desktop();
    jest.useFakeTimers();
    const restore = quiet();
    try {
      const helper = fakeHelper();
      helper.busy = true;
      const low = profile(helper);
      expect(await low.hold({ on: true, holder: "gaming" })).toBe("after-call");
      expect(low.status().pending).toBe(true);
      jest.advanceTimersByTime(15_000);
      expect(helper.calls).toEqual(["reload", "reload"]);
      expect(helper.running).toBe("full");
      // The call ends: the next try stops the helper, and the tries end.
      helper.busy = false;
      jest.advanceTimersByTime(15_000);
      expect(helper.running).toBeNull();
      expect(low.status().pending).toBe(false);
      jest.advanceTimersByTime(60_000);
      expect(helper.calls).toEqual(["reload", "reload", "reload"]);
    } finally {
      restore();
      jest.useRealTimers();
    }
  });

  test("let go before the call ends, nothing switches", async () => {
    await desktop();
    jest.useFakeTimers();
    const restore = quiet();
    try {
      const helper = fakeHelper();
      helper.busy = true;
      const low = profile(helper);
      await low.hold({ on: true, holder: "gaming" });
      await low.hold({ on: false, holder: "gaming" });
      expect(low.status().pending).toBe(false);
      helper.busy = false;
      jest.advanceTimersByTime(60_000);
      expect(helper.running).toBe("full");
    } finally {
      restore();
      jest.useRealTimers();
    }
  });

  test("now switches a call at once, after a notice on it", async () => {
    await desktop();
    const restore = quiet();
    try {
      const helper = fakeHelper();
      helper.busy = true;
      const low = profile(helper);
      expect(await low.hold({ on: true, holder: "gaming", now: true })).toBe(
        "now",
      );
      expect(helper.calls).toEqual([
        "reload",
        `say 7: ${SWITCH_NOTICES["low-gpu"]}`,
        "restart",
      ]);
    } finally {
      restore();
    }
  });

  test("GameMode at a call's start turns it on, and a free helper is restarted for the call", async () => {
    await desktop();
    const restore = quiet();
    try {
      const helper = fakeHelper();
      const low = profile(helper, true);
      expect(low.active()).toBe(false);
      await low.beforeCall();
      expect(low.reason()).toBe("GameMode");
      expect(helper.calls).toEqual(["reload-and-wait"]);
      expect((low.config() as VoiceConfig).low_gpu).toBe("GameMode");
      expect((low.config() as VoiceConfig).yield_cpu).toEqual({
        threads: GAMING_CPU_THREADS,
      });
      // A helper with the right set is left alone.
      helper.running = "low-gpu";
      await low.beforeCall();
      expect(helper.calls).toEqual(["reload-and-wait"]);
    } finally {
      restore();
    }
  });

  test("GameMode gone at the next call, the full set comes back", async () => {
    await desktop();
    const helper = fakeHelper();
    helper.running = "low-gpu";
    const restore = quiet();
    try {
      await profile(helper, false).beforeCall();
    } finally {
      restore();
    }
    expect(helper.calls).toEqual(["reload-and-wait"]);
  });

  test("a voice.json in error is left as it is", () => {
    holdLowGpu(statePath, { on: true });
    const low = profile(fakeHelper());
    expect(low.config()).toEqual({
      error: `No voice configuration (${home.deps.configPath})`,
    });
  });
});
