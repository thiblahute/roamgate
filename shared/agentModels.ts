import type { AgentChatModel } from "./agentChat";

/**
 * /model in conversation mode: what was typed, how model names compare,
 * and the picker's list from what the running agent and the session's
 * profile offer.
 */

/** `/model` alone (the picker) or `/model <name>`; null for other text. */
export function parseModelCommand(
  text: string,
): { model: string | null } | null {
  const match = /^\s*\/model(?:\s+(\S+))?\s*$/.exec(text);
  return match ? { model: match[1] ?? null } : null;
}

/**
 * What a model name may be: letters, digits and . _ : / @ [ ] -, starting
 * with a letter or digit ("sonnet", "claude-opus-5-5", "opus[1m]").
 */
export function isModelName(value: string): boolean {
  return /^[A-Za-z0-9][\w.:/@[\]-]{0,255}$/.test(value);
}

/** A model name compared: case and a context tag ("[1m]") left out. */
function modelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "");
}

/**
 * Whether two names are one model: the same once case and a context tag
 * are left out, or one the other with a release date
 * ("claude-haiku-4-5-20251001" is "claude-haiku-4-5").
 */
export function sameModel(a: string, b: string): boolean {
  const left = modelKey(a);
  const right = modelKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] =
    left.length < right.length ? [left, right] : [right, left];
  return (
    long.startsWith(`${short}-`) && /^\d{8}$/.test(long.slice(short.length + 1))
  );
}

/** The "default" row offered when the running agent lists nothing. */
export const DEFAULT_MODEL_ROW: AgentChatModel = {
  value: "default",
  label: "Default",
  description: "The profile's own model",
};

/**
 * The picker's list: what the running agent offers (its own names and
 * descriptions, in its order), then what the session's profile offers that
 * no row covers yet (a gateway's other models). Without the agent's list,
 * a "default" row, then the profile's.
 */
export function mergeModels(
  agent: readonly AgentChatModel[] | null,
  offered: readonly string[],
): AgentChatModel[] {
  const rows: AgentChatModel[] = agent?.length
    ? agent.map((row) => ({ ...row }))
    : [{ ...DEFAULT_MODEL_ROW }];
  for (const id of offered) {
    if (!id || !isModelName(id)) continue;
    const covered = rows.some(
      (row) =>
        sameModel(row.value, id) ||
        (row.resolved !== undefined && sameModel(row.resolved, id)),
    );
    if (!covered) rows.push({ value: id, label: id });
  }
  return rows;
}

/**
 * The row the session runs: the one last picked, else the one whose name
 * or model is the one it runs, spelled the same first (a "[1m]" tag
 * tells two rows of one model apart), else the same model; the first in
 * the list's order. Null when none says.
 */
export function currentModelValue(
  models: readonly AgentChatModel[],
  current: string | null,
  chosen: string | null,
): string | null {
  if (chosen) {
    const row =
      models.find((each) => each.value === chosen) ??
      models.find((each) => sameModel(each.value, chosen));
    if (row) return row.value;
  }
  if (current) {
    const spelled = current.trim().toLowerCase();
    const names = (row: AgentChatModel) =>
      row.resolved === undefined ? [row.value] : [row.value, row.resolved];
    const row =
      models.find((each) =>
        names(each).some((name) => name.toLowerCase() === spelled),
      ) ??
      models.find((each) =>
        names(each).some((name) => sameModel(name, current)),
      );
    if (row) return row.value;
  }
  return null;
}

/** What the chat says of a switch: the name asked, and the model it is. */
export function modelSwitchText(
  requested: string,
  model: string | null,
  options: { nextTurn?: boolean } = {},
): string {
  const named =
    model && !sameModel(model, requested)
      ? `${requested} (${model})`
      : requested;
  return `Model set to ${named}${options.nextTurn ? " from the next turn" : ""}`;
}

/** Past this, an agent's refusal is cut in the chat (a gateway's list). */
const MAX_REFUSAL = 400;

/** What the chat says of a switch that failed. */
export function modelRefusalText(requested: string, reason: string): string {
  const text = reason.trim() || "refused";
  return `Could not switch the model to ${requested}: ${
    text.length > MAX_REFUSAL ? `${text.slice(0, MAX_REFUSAL - 3)}...` : text
  }`;
}

/** Claude's model families, as their ids and aliases name them. */
const CLAUDE_FAMILIES = new Set(["opus", "sonnet", "haiku"]);

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A model's short, readable name for a chip: "Opus 5.5" from
 * claude-opus-5-5, its dated, gateway (anthropic/claude-opus-5-5),
 * Bedrock (us.anthropic.claude-opus-5-5-v1:0) and Vertex (@20260101)
 * spellings too; "Haiku 3.5" from claude-3-5-haiku; "Opus" from the
 * alias; a context tag kept ("Opus 5.5 1M" from opus-5-5[1m]). Another
 * backend's model as its words: "GLM 5p3", "GPT 5.6 sol".
 */
export function shortModelName(model: string): string {
  let rest = model.trim();
  const tagged = /\[([^\]]*)\]$/.exec(rest);
  const tag = tagged?.[1]?.trim().toUpperCase() ?? "";
  if (tagged) rest = rest.slice(0, tagged.index).trim();
  const withTag = (name: string) => (tag ? `${name} ${tag}` : name);
  const last = rest.slice(rest.lastIndexOf("/") + 1) || rest;
  const claude = last
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./i, "")
    .replace(/-v\d+(?::\d+)?$/i, "")
    .replace(/[-@]\d{8}$/, "")
    .toLowerCase();
  if (CLAUDE_FAMILIES.has(claude)) return withTag(capitalized(claude));
  if (claude === "opusplan") return withTag("Opus plan");
  const modern = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?$/.exec(claude);
  if (modern && CLAUDE_FAMILIES.has(modern[1]!))
    return withTag(
      `${capitalized(modern[1]!)} ${modern[2]}${modern[3] ? `.${modern[3]}` : ""}`,
    );
  const older = /^claude-(\d+)(?:[-.](\d{1,2}))?-([a-z]+)$/.exec(claude);
  if (older && CLAUDE_FAMILIES.has(older[3]!))
    return withTag(
      `${capitalized(older[3]!)} ${older[1]}${older[2] ? `.${older[2]}` : ""}`,
    );
  const [first = "", ...words] = last.split(/[-_\s]+/);
  const head = first.length <= 3 ? first.toUpperCase() : capitalized(first);
  return withTag([head, ...words].join(" ").slice(0, 40));
}
