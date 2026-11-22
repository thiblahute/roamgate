import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readLowGpu } from "../voice/voice-low-gpu";
import { EXIT_OK, UsageError } from "./command";
import { createTestCli, type TestCli } from "./test-context";
import { createVoiceCommand } from "./voice";

let cli: TestCli;
beforeEach(() => {
  cli = createTestCli();
});
afterEach(() => cli.cleanup());

const run = (...args: string[]) => createVoiceCommand().run(args, cli.context);
const state = () =>
  readLowGpu(
    join(cli.home, ".local", "share", "roamgate", "voice", "low-gpu.json"),
  );

describe("roamgate voice", () => {
  test("profile low-gpu on and off, by holder", async () => {
    expect(await run("profile", "low-gpu", "on", "--by", "render")).toBe(
      EXIT_OK,
    );
    expect(await run("profile", "low-gpu", "on")).toBe(EXIT_OK);
    expect(Object.keys(state().holders).sort()).toEqual(["manual", "render"]);
    expect(cli.output.at(-2)).toBe("Low-GPU voice: on, for render, manual");
    expect(cli.output.at(-1)).toBe("A call going on switches when it ends.");
    await run("profile", "low-gpu", "off", "--by", "render");
    expect(Object.keys(state().holders)).toEqual(["manual"]);
    await run("profile", "low-gpu", "off");
    expect(state().holders).toEqual({});
    expect(cli.output.at(-2)).toBe(
      "Low-GPU voice: off (unless GameMode runs as a call starts)",
    );
  });

  test("gaming is the profile held by gaming, --now asking a call to switch", async () => {
    await run("gaming", "on", "--now");
    expect(Object.keys(state().holders)).toEqual(["gaming"]);
    expect(state().now).toBeNumber();
    expect(cli.output.at(-1)).toBe(
      "A call going on switches now, after a short notice.",
    );
    await run("gaming", "off");
    expect(state().holders).toEqual({});
  });

  test("status says who holds it, even without voice.json", async () => {
    await run("gaming", "on");
    await run("profile", "low-gpu", "status");
    expect(cli.output).toContain("Low-GPU voice: on, for gaming");
    expect(cli.output.join("\n")).toContain(
      "Its models cannot be chosen: No voice configuration",
    );
    cli.output.length = 0;
    await run("gaming", "status", "--json");
    expect(JSON.parse(cli.output.join("\n"))).toMatchObject({
      active: true,
      holders: ["gaming"],
    });
  });

  test("models sets parts by hand, --reset goes back", async () => {
    await run(
      "profile",
      "low-gpu",
      "models",
      "tts=kokoro-82m",
      "text-turn=none",
    );
    expect(state().models).toEqual({ tts: "kokoro-82m", text_turn: "none" });
    await run("profile", "low-gpu", "models", "--reset");
    expect(state().models).toBeUndefined();
    await expect(
      run("profile", "low-gpu", "models", "tts=nope"),
    ).rejects.toThrow("no reading voice model named nope");
    await expect(
      run("profile", "low-gpu", "models", "voice=x"),
    ).rejects.toThrow(UsageError);
  });

  test("refuses what it does not know", async () => {
    await expect(run("profile", "quiet", "on")).rejects.toThrow(
      "unknown voice profile: quiet",
    );
    await expect(
      run("profile", "low-gpu", "on", "--by", "a b"),
    ).rejects.toThrow(UsageError);
    await expect(run("profile", "low-gpu", "maybe")).rejects.toThrow(
      "unknown action: maybe",
    );
    await expect(run("other")).rejects.toThrow("unknown voice command");
  });
});
