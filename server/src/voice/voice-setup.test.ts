import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NO_MODEL } from "../../../shared/voiceSetup";
import { partPath } from "./voice-download";
import { recommendedChoices } from "./voice-models";
import {
  installVoiceModels,
  removeUnusedModels,
  VoiceSetupRunner,
  voiceSetupState,
} from "./voice-setup";
import {
  CPU_LAPTOP,
  NVIDIA_DESKTOP,
  type SetupHome,
  serveModels,
  setupHome,
} from "./voice-setup-testing";

const server = serveModels();
afterAll(() => server.stop());

let home: SetupHome;
beforeEach(() => {
  home = setupHome(server);
  server.requests.length = 0;
});
afterEach(() => home.cleanup());

const readConfig = () =>
  JSON.parse(readFileSync(home.deps.configPath, "utf8")) as Record<
    string,
    unknown
  >;

const writeConfig = (config: Record<string, unknown>) => {
  mkdirSync(join(home.deps.configPath, ".."), { recursive: true });
  writeFileSync(home.deps.configPath, JSON.stringify(config));
};

const light = recommendedChoices(CPU_LAPTOP).light;
const heavy = recommendedChoices(NVIDIA_DESKTOP).heavy;

describe("voiceSetupState", () => {
  test("a fresh machine: nothing installed, the hardware's tier proposed", () => {
    const state = voiceSetupState(home.deps);
    expect(state.tier).toBe("heavy");
    expect(state.current).toEqual({});
    expect(state.helper).toEqual({ path: home.deps.helperPath, found: false });
    expect(state.unused).toEqual([]);
    const tts = state.components.find((entry) => entry.id === "tts")!;
    const qwen = tts.options.find((option) => option.id === "qwen3-tts-1.7b")!;
    expect(qwen.installed).toBe(false);
    expect(qwen.downloadBytes).toBe(qwen.sizeBytes);
    expect(qwen.sizeBytes).toBeGreaterThan(0);
  });

  test("models put in place by hand elsewhere are found where voice.json says", async () => {
    // Install to the models directory, then move voice.json's view of it.
    await installVoiceModels(light, home.deps);
    const state = voiceSetupState(home.deps);
    expect(state.current).toEqual({
      speech: "parakeet",
      reread: NO_MODEL,
      tts: "kokoro-onnx",
      stock_voices: NO_MODEL,
      speaker: "wespeaker",
      turn: "smart-turn",
      text_turn: "qwen3-0.6b",
    });
    writeConfig({ ...readConfig(), speaker_model: "/elsewhere/mine.onnx" });
    expect(voiceSetupState(home.deps).current.speaker).toBe("custom");
  });
});

describe("installVoiceModels", () => {
  test("downloads the chosen models and writes voice.json, keeping the rest", async () => {
    writeConfig({
      helper: "/opt/roamgate-voice",
      speech_rate: 1.3,
      front_model: "opus",
    });
    const progress: string[] = [];
    const { job } = await installVoiceModels(light, home.deps, {
      onProgress: (update) => progress.push(update.state),
    });
    expect(job.state).toBe("done");
    expect(job.doneBytes).toBe(job.totalBytes);
    expect(progress[0]).toBe("downloading");
    expect(progress.at(-1)).toBe("done");
    const models = home.deps.modelsDir;
    expect(readConfig()).toEqual({
      helper: "/opt/roamgate-voice",
      speech_rate: 1.3,
      front_model: "opus",
      parakeet_model: join(models, "parakeet-tdt-0.6b-v3"),
      kokoro_model: join(models, "kokoro-v1.0.onnx"),
      kokoro_voices: join(models, "voices-v1.0.bin"),
      speaker_model: join(models, "wespeaker_en_voxceleb_resnet34.onnx"),
      turn_model: join(models, "smart-turn-v3.2-cpu.onnx"),
      text_turn_model: join(models, "qwen3-0.6b"),
    });
    expect(
      existsSync(join(models, "qwen3-0.6b", "onnx", "model_int8.onnx")),
    ).toBe(true);
  });

  test("the installed helper is named when voice.json has none", async () => {
    mkdirSync(join(home.deps.helperPath, ".."), { recursive: true });
    writeFileSync(home.deps.helperPath, "");
    await installVoiceModels(light, home.deps);
    expect(readConfig().helper).toBe(home.deps.helperPath);
  });

  test("running it again downloads nothing and changes nothing", async () => {
    await installVoiceModels(light, home.deps);
    const before = readFileSync(home.deps.configPath, "utf8");
    server.requests.length = 0;
    const { job } = await installVoiceModels(light, home.deps);
    expect(job.totalBytes).toBe(0);
    expect(server.requests).toEqual([]);
    expect(readFileSync(home.deps.configPath, "utf8")).toBe(before);
  });

  test("switching tier: the light models become unused, then removed", async () => {
    await installVoiceModels(light, home.deps);
    await installVoiceModels(heavy, home.deps);
    const state = voiceSetupState(home.deps);
    expect(state.current.tts).toBe("qwen3-tts-1.7b");
    expect(readConfig().tts_models).toEqual([
      { model: "kokoro", path: join(home.deps.modelsDir, "Kokoro-82M") },
    ]);
    // Kokoro's ONNX keys stay beside tts_models: still referenced, kept.
    expect(state.unused.map((model) => model.id)).toEqual([]);
    writeConfig({
      ...readConfig(),
      kokoro_model: undefined,
      kokoro_voices: undefined,
    });
    const unused = voiceSetupState(home.deps).unused.map((model) => model.id);
    expect(unused).toEqual(["kokoro-onnx", "kokoro-onnx-voices"]);
    const { freedBytes } = removeUnusedModels("all", home.deps);
    expect(freedBytes).toBeGreaterThan(0);
    expect(existsSync(join(home.deps.modelsDir, "kokoro-v1.0.onnx"))).toBe(
      false,
    );
    expect(existsSync(join(home.deps.modelsDir, "parakeet-tdt-0.6b-v3"))).toBe(
      true,
    );
    expect(voiceSetupState(home.deps).unused).toEqual([]);
  });

  test("unfinished downloads are listed and removed", async () => {
    mkdirSync(join(home.deps.modelsDir, "Kokoro-82M"), { recursive: true });
    const part = partPath(
      join(home.deps.modelsDir, "Kokoro-82M", "kokoro-v1_0.pth"),
    );
    writeFileSync(part, "half");
    expect(voiceSetupState(home.deps).unused).toEqual([
      { id: "partial", name: "Unfinished download", path: part, sizeBytes: 4 },
    ]);
    removeUnusedModels(["partial"], home.deps);
    expect(existsSync(part)).toBe(false);
  });

  test("nothing outside the models directory is ever removed", async () => {
    await installVoiceModels(light, home.deps);
    const outside = join(home.home, "mine");
    mkdirSync(outside);
    writeConfig({ ...readConfig(), turn_model: undefined });
    // The turn model in the models directory is unused now.
    expect(voiceSetupState(home.deps).unused.map((model) => model.id)).toEqual([
      "smart-turn-v3.2",
    ]);
    removeUnusedModels("all", home.deps);
    expect(existsSync(outside)).toBe(true);
  });

  test("too little room stops it before downloading", async () => {
    await expect(
      installVoiceModels(light, { ...home.deps, freeBytes: () => 10 }),
    ).rejects.toThrow("MB free");
    expect(server.requests).toEqual([]);
    expect(existsSync(home.deps.configPath)).toBe(false);
  });

  test("a failed download leaves voice.json alone", async () => {
    writeConfig({ helper: "/opt/roamgate-voice" });
    const broken = {
      ...home.deps,
      packages: home.deps.packages!.map((entry) =>
        entry.id === "smart-turn-v3.2"
          ? {
              ...entry,
              files: entry.files.map((file) => ({
                ...file,
                sha256: "0".repeat(64),
              })),
            }
          : entry,
      ),
    };
    await expect(installVoiceModels(light, broken)).rejects.toThrow("checksum");
    expect(readConfig()).toEqual({ helper: "/opt/roamgate-voice" });
  });
});

describe("VoiceSetupRunner", () => {
  test("runs one download, reports it, reloads the helper", async () => {
    let reloads = 0;
    const runner = new VoiceSetupRunner(home.deps, () => {
      reloads += 1;
      return "now";
    });
    const started = runner.start(light);
    expect(started.state).toBe("downloading");
    expect(() => runner.start(light)).toThrow("already downloading");
    while (runner.running) await Bun.sleep(5);
    expect(runner.job?.state).toBe("done");
    expect(runner.job?.reload).toBe("now");
    expect(reloads).toBe(1);
    expect(runner.state().current.tts).toBe("kokoro-onnx");
  });

  test("an unknown model fails at once", () => {
    const runner = new VoiceSetupRunner(home.deps);
    expect(() => runner.start({ tts: "nope" })).toThrow(
      "no reading voice model named nope",
    );
    expect(runner.running).toBe(false);
  });

  test("cancelled, the job says so and voice.json is untouched", async () => {
    const runner = new VoiceSetupRunner(home.deps);
    runner.start(heavy);
    expect(runner.cancel()).toBe(true);
    while (runner.running) await Bun.sleep(5);
    expect(runner.job?.state).toBe("cancelled");
    expect(existsSync(home.deps.configPath)).toBe(false);
  });
});
