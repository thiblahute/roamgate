import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelPackage } from "./voice-models";
import { testModelUrl, voiceTestOverrides } from "./voice-test-env";

const SOURCE = { execPath: "/usr/bin/bun", argv: ["bun", "src/index.ts"] };
const BINARY = { execPath: "/opt/roamgate/roamgate", argv: ["roamgate"] };

test("nothing without the variables", () => {
  expect(voiceTestOverrides({}, BINARY)).toEqual({});
});

test("the standalone binary refuses them", () => {
  expect(() =>
    voiceTestOverrides({ ROAMGATE_TEST_VOICE_MODELS_URL: "http://x" }, BINARY),
  ).toThrow(/only honoured when the server runs from source/);
});

test("model downloads go to the mirror, the catalog otherwise unchanged", () => {
  expect(
    testModelUrl(
      "https://huggingface.co/a/b/resolve/c/model.onnx",
      "http://127.0.0.1:9/m/",
    ),
  ).toBe("http://127.0.0.1:9/m/huggingface.co/a/b/resolve/c/model.onnx");
  const packages: ModelPackage[] = [
    {
      id: "p",
      name: "P",
      dir: "p",
      files: [
        {
          path: "f.bin",
          url: "https://github.com/o/r/releases/download/v1/f.bin",
          size: 3,
          sha256: "0".repeat(64),
        },
      ],
    },
  ];
  const overrides = voiceTestOverrides(
    { ROAMGATE_TEST_VOICE_MODELS_URL: "http://127.0.0.1:9" },
    SOURCE,
    packages,
  );
  expect(overrides.hardware).toBeUndefined();
  expect(overrides.packages).toEqual([
    {
      ...packages[0]!,
      files: [
        {
          ...packages[0]!.files[0]!,
          url: "http://127.0.0.1:9/github.com/o/r/releases/download/v1/f.bin",
        },
      ],
    },
  ]);
});

test("the hardware comes from the file, read on each request", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-test-env-"));
  try {
    const path = join(directory, "hardware.json");
    const hardware = {
      platform: "linux",
      arch: "x64",
      cpu: { model: "Parity CPU", cores: 8 },
      ramBytes: 16 * 2 ** 30,
      gpus: [],
      acceleration: "cpu",
      gpuBytes: 0,
    };
    writeFileSync(path, JSON.stringify(hardware));
    const overrides = voiceTestOverrides(
      { ROAMGATE_TEST_VOICE_HARDWARE: path },
      SOURCE,
    );
    expect(overrides.hardware?.()).toEqual(hardware as never);
    writeFileSync(path, JSON.stringify({ ...hardware, ramBytes: 1 }));
    expect(overrides.hardware?.().ramBytes).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
