import { describe, expect, test } from "bun:test";
import type { ControlAnswer } from "./types";
import { claudeModelRow, claudeModels } from "./claude-models";

/** A context answering each request as `answers` says, recording it. */
function context(answers: Record<string, ControlAnswer>) {
  const asked: [string, Record<string, unknown>][] = [];
  return {
    asked,
    control: async (kind: string, params: Record<string, unknown>) => {
      asked.push([kind, params]);
      return answers[kind] ?? null;
    },
  };
}

describe("Claude Code's models", () => {
  test("a list_models row: its name, label, model and whether it may be picked", () => {
    expect(
      claudeModelRow({
        value: "opus",
        resolvedModel: "gpt-6-luna",
        displayName: "gpt-6-luna",
        description: "Custom Opus model",
        supportsEffort: true,
      }),
    ).toEqual({
      value: "opus",
      label: "gpt-6-luna",
      description: "Custom Opus model",
      resolved: "gpt-6-luna",
    });
    expect(
      claudeModelRow({ value: "x", disabled: true, description: " " }),
    ).toEqual({ value: "x", label: "x", disabled: true });
    expect(claudeModelRow({ displayName: "no value" })).toBeNull();
    expect(claudeModelRow("opus")).toBeNull();
  });

  test("the list, or none when the CLI refuses or says nothing", async () => {
    const listing = context({
      list_models: {
        response: { models: [{ value: "haiku" }, null, { value: "" }] },
      },
    });
    expect(await claudeModels.list(listing)).toEqual([
      { value: "haiku", label: "haiku" },
    ]);
    expect(listing.asked).toEqual([["list_models", {}]]);
    expect(
      await claudeModels.list(context({ list_models: { error: "unknown" } })),
    ).toBeNull();
    expect(await claudeModels.list(context({}))).toBeNull();
  });

  test("a switch: the model it runs then, or the CLI's refusal", async () => {
    const switching = context({
      set_model: { response: { model: "claude-sonnet-5-5" } },
    });
    expect(await claudeModels.set(switching, "sonnet")).toEqual({
      ok: true,
      model: "claude-sonnet-5-5",
    });
    expect(switching.asked).toEqual([["set_model", { model: "sonnet" }]]);
    expect(
      await claudeModels.set(
        context({ set_model: { error: "Model 'x' not found" } }),
        "x",
      ),
    ).toEqual({ ok: false, reason: "Model 'x' not found" });
    expect(await claudeModels.set(context({}), "x")).toEqual({
      ok: false,
      reason: "Claude did not answer in time",
    });
    expect(
      await claudeModels.set(context({ set_model: { response: {} } }), "x"),
    ).toEqual({ ok: true, model: null });
  });
});
