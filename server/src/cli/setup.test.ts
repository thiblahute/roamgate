import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CPU_LAPTOP,
  NVIDIA_DESKTOP,
  type SetupHome,
  serveModels,
  setupHome,
} from "../voice/voice-setup-testing";
import { EXIT_OK, UsageError } from "./command";
import { runCli } from "./index";
import { createSetupCommand, type SetupCommandDeps } from "./setup";
import { createTestCli, type TestCli } from "./test-context";

const server = serveModels();
afterAll(() => server.stop());

let home: SetupHome;
let cli: TestCli;
beforeEach(() => {
  home = setupHome(server, CPU_LAPTOP);
  cli = createTestCli();
});
afterEach(() => {
  home.cleanup();
  cli.cleanup();
});

const command = (deps: SetupCommandDeps = {}) =>
  createSetupCommand({
    hardware: () => CPU_LAPTOP,
    ask: null,
    setup: home.deps,
    ...deps,
  });

const config = () =>
  JSON.parse(readFileSync(home.deps.configPath, "utf8")) as Record<
    string,
    unknown
  >;

describe("roamgate setup voice", () => {
  test("is listed among the commands", async () => {
    expect(await runCli(["help"], cli.context)).toBe(EXIT_OK);
    expect(cli.output.join("\n")).toContain("setup");
  });

  test("list shows the hardware, each part's models and the tier", async () => {
    expect(await command().run(["voice", "list"], cli.context)).toBe(EXIT_OK);
    const out = cli.output.join("\n");
    expect(out).toContain("CPU: Intel Core i5, 8 threads");
    expect(out).toContain("GPU: none found");
    expect(out).toContain("Proposed tier: light");
    expect(out).toContain("Speech recognition (--speech)");
    expect(out).toContain("kokoro-onnx");
    expect(out).toContain("not found: build it");
  });

  test("list --json is the assistant's state", async () => {
    await command().run(["voice", "list", "--json"], cli.context);
    const state = JSON.parse(cli.output.join("\n"));
    expect(state.tier).toBe("light");
    expect(state.recommended.heavy.tts).toBe("qwen3-tts-0.6b");
  });

  test("--yes downloads the tier's models and writes voice.json", async () => {
    expect(
      await command().run(
        ["voice", "--yes", "--text-turn", "none"],
        cli.context,
      ),
    ).toBe(EXIT_OK);
    const models = home.deps.modelsDir;
    expect(config()).toMatchObject({
      parakeet_model: join(models, "parakeet-tdt-0.6b-v3"),
      tts_models: [
        {
          model: "pocket-tts",
          path: join(models, "pocket-tts-fr", "languages", "french"),
          languages: "fr",
          voice: "estelle",
        },
        {
          model: "pocket-tts",
          path: join(models, "pocket-tts-en", "languages", "english"),
          languages: "en",
          voice: "alba",
        },
      ],
    });
    expect("kokoro_model" in config()).toBe(false);
    expect("text_turn_model" in config()).toBe(false);
    expect(cli.output.join("\n")).toContain("Wrote");
  });

  test("questions: Enter keeps a choice, a number picks another", async () => {
    const answers = ["", "", "3", "", "", "", "y"];
    const asked: string[] = [];
    await command({
      hardware: () => NVIDIA_DESKTOP,
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? "";
      },
    }).run(["voice", "--tier", "light"], cli.context);
    expect(asked.at(-1)).toContain("Download and write voice.json?");
    // Speech, second reading, then the third reading voice: Kokoro-82M.
    expect(config().tts_models).toEqual([
      { model: "kokoro", path: join(home.deps.modelsDir, "Kokoro-82M") },
    ]);
  });

  test("answering no changes nothing", async () => {
    const asked: string[] = [];
    await command({
      ask: async (question) => {
        asked.push(question);
        return question.startsWith("Download") ? "n" : "";
      },
    }).run(["voice", "--tier", "light"], cli.context);
    expect(asked.at(-1)).toContain("Download");
    expect(existsSync(home.deps.configPath)).toBe(false);
  });

  test("bad arguments are usage errors", async () => {
    await expect(
      command().run(["voice", "--tier", "huge"], cli.context),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      command().run(["voice", "--tts", "nope", "--yes"], cli.context),
    ).rejects.toThrow("no reading voice model named nope");
    await expect(command().run(["voice"], cli.context)).rejects.toThrow(
      "--yes is needed without a terminal",
    );
    await expect(command().run(["herdr"], cli.context)).rejects.toThrow(
      "unknown setup",
    );
  });

  test("remove-unused frees what voice.json no longer uses", async () => {
    await command().run(["voice", "--yes"], cli.context);
    await command().run(["voice", "--yes", "--turn", "none"], cli.context);
    cli.output.length = 0;
    expect(
      await command().run(["voice", "remove-unused", "--yes"], cli.context),
    ).toBe(EXIT_OK);
    expect(cli.output.join("\n")).toContain("Smart Turn");
    expect(
      existsSync(join(home.deps.modelsDir, "smart-turn-v3.2-cpu.onnx")),
    ).toBe(false);
  });
});
