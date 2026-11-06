import type { AgentChatModel } from "../../../../shared/agentChat";
import { isRecord } from "../../agent/session-utils";
import type { ModelDriver } from "./types";

/**
 * Claude Code's models over its control protocol: `list_models` answers
 * the rows its own /model picker shows (aliases, the default, a gateway's
 * custom slots), `set_model` switches the running session for its next
 * turns and answers the model id it runs then. A switch writes nothing to
 * the transcript: a process started after it, before the session answered
 * with that model, resumes on the model it last answered with.
 */

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One row of `list_models` (Claude Code's ModelInfo); null when unusable. */
export function claudeModelRow(value: unknown): AgentChatModel | null {
  if (!isRecord(value)) return null;
  const id = text(value.value);
  if (!id) return null;
  const description = text(value.description);
  const resolved = text(value.resolvedModel);
  return {
    value: id,
    label: text(value.displayName) ?? id,
    ...(description ? { description } : {}),
    ...(resolved ? { resolved } : {}),
    ...(value.disabled === true ? { disabled: true } : {}),
  };
}

export const claudeModels: ModelDriver = {
  async list(context) {
    const answer = await context.control("list_models", {});
    if (!answer || answer.error || !Array.isArray(answer.response?.models))
      return null;
    return (answer.response.models as unknown[]).flatMap((row) => {
      const parsed = claudeModelRow(row);
      return parsed ? [parsed] : [];
    });
  },

  async set(context, model) {
    const answer = await context.control("set_model", { model });
    if (!answer) return { ok: false, reason: "Claude did not answer in time" };
    if (answer.error) return { ok: false, reason: answer.error };
    return { ok: true, model: text(answer.response?.model) ?? null };
  },
};
