import type { InjectedKind } from "../../../shared/injectedMessage";
import { isRecord, stringValue } from "./session-utils";

/**
 * What Codex itself writes in a user message of its rollout, beside or
 * instead of the user's words: the environment (cwd, date, sandbox), the
 * AGENTS.md instructions, a turn's interruption, a subagent finishing, a
 * `!` command the user ran, plugin suggestions. Newer rollouts say which
 * content item is which (internal_chat_message_metadata_passthrough:
 * content_item_kinds "user.text" or "environments.environment_context",
 * provenance "user" or "harness"); older ones only by the item's leading
 * tag, as Codex itself tells them apart.
 */
export type CodexUserPart =
  | { type: "text"; text: string }
  | { type: "notice"; kind: InjectedKind; label: string; body: string };

type Tagged = { tag: string; inner: string; rest: string };

const AGENTS_MD = "# AGENTS.md instructions for ";
const IMAGE_FRAME = /^(?:<image name=[^>\n]*>|<\/image>)$/;
// Tags Codex writes around its own content in a user message.
const TAGS = [
  "environment_context",
  "user_instructions",
  "turn_aborted",
  "subagent_notification",
  "user_shell_command",
  "recommended_plugins",
];

/** The item's leading tag, what it holds and the text after it, if any. */
function leadingTag(text: string): Tagged | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(AGENTS_MD)) {
    // The instructions close with </INSTRUCTIONS>; nothing follows them.
    const close = trimmed.indexOf("</INSTRUCTIONS>");
    return {
      tag: "agents_md",
      inner: trimmed,
      rest: close < 0 ? "" : trimmed.slice(close + 15),
    };
  }
  for (const tag of TAGS) {
    if (!trimmed.startsWith(`<${tag}>`)) continue;
    const close = trimmed.indexOf(`</${tag}>`);
    if (close < 0)
      return { tag, inner: trimmed.slice(tag.length + 2), rest: "" };
    return {
      tag,
      inner: trimmed.slice(tag.length + 2, close),
      rest: trimmed.slice(close + tag.length + 3),
    };
  }
  return null;
}

function innerTag(body: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(body);
  return match ? match[1]!.trim() : "";
}

export type CodexEnvironment = {
  cwd: string;
  shell: string;
  date: string;
  timezone: string;
  roots: string[];
  subagents: string;
};

export function parseEnvironmentContext(inner: string): CodexEnvironment {
  const roots = [
    ...(innerTag(inner, "workspace_roots").matchAll(
      /<root>([\s\S]*?)<\/root>/g,
    ) ?? []),
  ].map((match) => match[1]!.trim());
  return {
    cwd: innerTag(inner, "cwd"),
    shell: innerTag(inner, "shell"),
    date: innerTag(inner, "current_date"),
    timezone: innerTag(inner, "timezone"),
    roots,
    subagents: innerTag(inner, "subagents"),
  };
}

function environmentNotice(env: CodexEnvironment) {
  const said = [
    env.cwd ? `cwd ${env.cwd}` : "",
    env.date ? `date ${env.date}` : "",
  ].filter(Boolean);
  const body = [
    env.cwd ? `- cwd: \`${env.cwd}\`` : "",
    env.roots.length
      ? `- workspace: ${env.roots.map((root) => `\`${root}\``).join(", ")}`
      : "",
    env.date ? `- date: ${env.date}` : "",
    env.timezone ? `- timezone: ${env.timezone}` : "",
    env.shell ? `- shell: ${env.shell}` : "",
    env.subagents ? `- subagents:\n${env.subagents}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    label: said.length ? `Environment: ${said.join(", ")}` : "Environment",
    body,
  };
}

/**
 * A `!` command the user ran, as Codex tells the model of it: a notice,
 * its output on expand (Codex ran it already; nothing was sent).
 */
function shellPart(inner: string): CodexUserPart {
  const command = innerTag(inner, "command");
  const result = innerTag(inner, "result");
  const output = /(?:^|\n)Output:\n([\s\S]*)$/.exec(result);
  const exit = /(?:^|\n)Exit code: (-?\d+)/.exec(result)?.[1];
  const stdout = (output ? output[1]! : result).replace(/\n+$/, "");
  const fence = "`".repeat(
    Math.max(3, ...[...stdout.matchAll(/`+/g)].map((run) => run[0].length + 1)),
  );
  return {
    type: "notice",
    kind: "context",
    label: `You ran: ${command.split("\n")[0]}${exit && exit !== "0" ? ` (exit code ${exit})` : ""}`,
    body: `${fence}\n$ ${command}\n${stdout}\n${fence}`,
  };
}

function subagentPart(
  inner: string,
  names: ReadonlyMap<string, string>,
): CodexUserPart | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const path = stringValue(parsed.agent_path);
  const name = names.get(path) || "a subagent";
  const status = parsed.status;
  if (isRecord(status)) {
    const [state, value] = Object.entries(status)[0] ?? [];
    const text = typeof value === "string" ? value : "";
    if (state === "completed")
      return {
        type: "notice",
        kind: "report",
        label: `Report from ${name}`,
        body: text,
      };
    return {
      type: "notice",
      kind: "agent",
      label: `${name[0]!.toUpperCase()}${name.slice(1)}: ${state ?? "update"}`,
      body: text,
    };
  }
  // "shutdown" and other plain states: nothing to read.
  return null;
}

/** The subagents' names an environment lists: "- <id>: James". */
function subagentNames(list: string, names: Map<string, string>) {
  for (const match of list.matchAll(/^\s*-\s*(\S+):\s*(.+?)\s*$/gm))
    names.set(match[1]!, match[2]!);
}

function itemKinds(payload: Record<string, unknown>) {
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!isRecord(meta)) return null;
  const kinds = Array.isArray(meta.content_item_kinds)
    ? meta.content_item_kinds
    : [];
  const items = Array.isArray(meta.content_item_metadata)
    ? meta.content_item_metadata
    : [];
  return (index: number): "user" | "codex" | null => {
    const kind = kinds[index];
    if (typeof kind === "string")
      return kind.startsWith("user.") ? "user" : "codex";
    const item = items[index];
    if (isRecord(item) && isRecord(item.provenance))
      return item.provenance.type === "user" ? "user" : "codex";
    return null;
  };
}

/**
 * Reads a user message of a Codex rollout as its parts, in order: the
 * user's words, and what Codex wrote there, as a notice to show collapsed,
 * a `!` command, or nothing (instructions for the model). `state` carries
 * what a session's earlier messages said (the last environment, so an
 * unchanged one is said once, and the subagents' names).
 */
export function codexUserParts(
  payload: Record<string, unknown>,
  state: CodexInjectedState,
): CodexUserPart[] {
  const content = Array.isArray(payload.content)
    ? payload.content
    : typeof payload.content === "string"
      ? [{ type: "input_text", text: payload.content }]
      : [];
  const kindOf = itemKinds(payload);
  const parts: CodexUserPart[] = [];
  const words: string[] = [];
  const flush = () => {
    const text = words.join("\n");
    words.length = 0;
    if (text.trim()) parts.push({ type: "text", text });
  };
  content.forEach((item, index) => {
    if (!isRecord(item)) return;
    const text =
      typeof item.text === "string"
        ? item.text
        : typeof item.content === "string"
          ? item.content
          : "";
    if (!text) return;
    const said = kindOf?.(index) ?? null;
    // The frame Codex puts around an image the user attached, its
    // "[Image #1]" placeholder kept.
    if (IMAGE_FRAME.test(text.trim())) return;
    if (said === "user") {
      words.push(text);
      return;
    }
    const tagged = leadingTag(text);
    if (!tagged) {
      // Marked as Codex's own, of a kind not known here: not the user's.
      if (said !== "codex") words.push(text);
      return;
    }
    flush();
    const part = taggedPart(tagged, state);
    if (part) parts.push(part);
    if (tagged.rest.trim()) words.push(tagged.rest.trim());
  });
  flush();
  return parts;
}

export type CodexInjectedState = {
  environment: string;
  names: Map<string, string>;
};

export function codexInjectedState(): CodexInjectedState {
  return { environment: "", names: new Map() };
}

function taggedPart(
  tagged: Tagged,
  state: CodexInjectedState,
): CodexUserPart | null {
  switch (tagged.tag) {
    case "environment_context": {
      const env = parseEnvironmentContext(tagged.inner);
      if (env.subagents) subagentNames(env.subagents, state.names);
      const notice = environmentNotice(env);
      // The same environment again (each new turn of a resumed session):
      // said once.
      const key = `${notice.label}\n${notice.body}`;
      if (key === state.environment) return null;
      state.environment = key;
      return { type: "notice", kind: "context", ...notice };
    }
    case "subagent_notification":
      return subagentPart(tagged.inner, state.names);
    case "user_shell_command":
      return shellPart(tagged.inner);
    default:
      // AGENTS.md and user instructions, a turn's interruption, plugin
      // suggestions: for the model only.
      return null;
  }
}
