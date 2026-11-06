import { describe, expect, test } from "bun:test";
import {
  currentModelValue,
  isModelName,
  mergeModels,
  modelRefusalText,
  modelSwitchText,
  parseModelCommand,
  sameModel,
  shortModelName,
} from "./agentModels";

describe("/model typed", () => {
  test("alone opens the picker, with a name switches", () => {
    expect(parseModelCommand("/model")).toEqual({ model: null });
    expect(parseModelCommand("  /model  ")).toEqual({ model: null });
    expect(parseModelCommand("/model sonnet")).toEqual({ model: "sonnet" });
    expect(parseModelCommand(" /model  opus[1m] ")).toEqual({
      model: "opus[1m]",
    });
  });

  test("anything else is not the command", () => {
    expect(parseModelCommand("/models")).toBeNull();
    expect(parseModelCommand("/model opus plan")).toBeNull();
    expect(parseModelCommand("use /model sonnet")).toBeNull();
    expect(parseModelCommand("/compact")).toBeNull();
  });

  test("a model name is what Claude Code takes, nothing a flag or a shell would read", () => {
    for (const name of [
      "sonnet",
      "default",
      "claude-opus-5-5",
      "opus[1m]",
      "gpt-6-luna",
      "zai-org/GLM-5.1@fast",
      "us.anthropic.claude-sonnet:0",
    ])
      expect(isModelName(name)).toBe(true);
    for (const name of [
      "",
      "--model",
      "-x",
      "so net",
      "a;b",
      "a$(b)",
      "x".repeat(257),
    ])
      expect(isModelName(name)).toBe(false);
  });
});

describe("model names", () => {
  test("one model whatever the case, a context tag or a release date", () => {
    expect(sameModel("claude-opus-5-5", "Claude-Opus-5-5")).toBe(true);
    expect(sameModel("claude-fable-5-1[1m]", "claude-fable-5-1")).toBe(true);
    expect(sameModel("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(
      true,
    );
    expect(sameModel("claude-haiku-4-5", "claude-haiku-4-5-20251001")).toBe(
      true,
    );
  });

  test("another version is another model", () => {
    expect(sameModel("claude-opus-5", "claude-opus-5-5")).toBe(false);
    expect(sameModel("opus", "claude-opus-5-5")).toBe(false);
    expect(sameModel("", "")).toBe(false);
  });
});

describe("the picker's list", () => {
  const agent = [
    {
      value: "default",
      label: "Default (recommended)",
      resolved: "gpt-6-luna[1m]",
    },
    { value: "opus", label: "gpt-6-luna", resolved: "gpt-6-luna" },
    {
      value: "claude-fable-5-1[1m]",
      label: "Fable",
      resolved: "claude-fable-5-1",
    },
  ];

  test("the agent's rows first, then the profile's models no row covers", () => {
    expect(
      mergeModels(agent, [
        "gpt-6-luna",
        "gpt-6-sol",
        "claude-fable-5-1",
        "a b",
      ]),
    ).toEqual([...agent, { value: "gpt-6-sol", label: "gpt-6-sol" }]);
  });

  test("without the agent's rows: a default, then the profile's", () => {
    expect(mergeModels(null, ["opus", "sonnet"])).toEqual([
      {
        value: "default",
        label: "Default",
        description: "The profile's own model",
      },
      { value: "opus", label: "opus" },
      { value: "sonnet", label: "sonnet" },
    ]);
    expect(mergeModels([], [])).toHaveLength(1);
  });

  test("the row it runs: the one picked, else its model's first row", () => {
    expect(currentModelValue(agent, "gpt-6-luna", "opus")).toBe("opus");
    // Spelled the same first: the [1m] row is the default here.
    expect(currentModelValue(agent, "gpt-6-luna", null)).toBe("opus");
    expect(currentModelValue(agent, "gpt-6-luna[1m]", null)).toBe("default");
    expect(currentModelValue(agent, "GPT-6-Luna", null)).toBe("opus");
    expect(currentModelValue(agent, "claude-fable-5-1", null)).toBe(
      "claude-fable-5-1[1m]",
    );
    expect(currentModelValue(agent, "kimi", "glm")).toBeNull();
    expect(currentModelValue(agent, null, null)).toBeNull();
  });
});

describe("what the chat says", () => {
  test("the name asked, with the model it is when another", () => {
    expect(modelSwitchText("sonnet", "claude-sonnet-5-5")).toBe(
      "Model set to sonnet (claude-sonnet-5-5)",
    );
    expect(modelSwitchText("gpt-6-sol", "gpt-6-sol")).toBe(
      "Model set to gpt-6-sol",
    );
    expect(modelSwitchText("haiku", null, { nextTurn: true })).toBe(
      "Model set to haiku from the next turn",
    );
  });

  test("a refusal, a long one cut", () => {
    expect(modelRefusalText("x", "Model 'x' not found")).toBe(
      "Could not switch the model to x: Model 'x' not found",
    );
    const long = modelRefusalText(
      "x",
      `Unknown model. Supported: ${"m, ".repeat(400)}`,
    );
    expect(long.length).toBeLessThan(450);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("a model's short name", () => {
  test("Claude's models by family and version, however spelled", () => {
    expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModelName("claude-opus-4-20250514")).toBe("Opus 4");
    expect(shortModelName("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
    expect(shortModelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 1M");
    expect(shortModelName("anthropic/claude-sonnet-4-5")).toBe("Sonnet 4.5");
    expect(shortModelName("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "Sonnet 4.5",
    );
    expect(shortModelName("claude-opus-4-1@20250805")).toBe("Opus 4.1");
  });

  test("aliases, and other backends' models as their words", () => {
    expect(shortModelName("opus")).toBe("Opus");
    expect(shortModelName("sonnet[1m]")).toBe("Sonnet 1M");
    expect(shortModelName("default")).toBe("Default");
    expect(shortModelName("glm-5p3")).toBe("GLM 5p3");
    expect(shortModelName("kimi-k3p1-pro")).toBe("Kimi k3p1 pro");
    expect(shortModelName("gpt-5.6-sol")).toBe("GPT 5.6 sol");
    expect(shortModelName("unsloth/Qwen3.6-35B")).toBe("Qwen3.6 35B");
  });
});
