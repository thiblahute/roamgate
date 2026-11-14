/**
 * One adapter per agent: where its sessions live, how a file maps to a
 * session, what its records say. A session file is the source of truth; the
 * adapters only teach the index to read it.
 */
import { join, posix } from "node:path";
import {
  clip,
  clipResult,
  type Doc,
  extract as extractClaude,
  stableStringify,
  type UnknownTypes,
} from "./extract";

export type FileMeta = {
  project: string;
  session: string;
  subagent: boolean;
};

/** What parsing learns about a file besides its documents. */
export type ParseState = {
  thinking: boolean;
  unknown: UnknownTypes;
  cwd?: string;
  cost?: number;
  /** Set when the project is only known from the content. */
  project?: string;
  session?: string;
};

export type ExtraFile = {
  /** Archive relpath; starts with `@` so it never meets a session file. */
  relpath: string;
  /** Path under the host's home. */
  homePath: string;
  kind: "history";
};

export type AgentAdapter = {
  id: string;
  label: string;
  /** jsonl files that only grow, else files replaced as a whole. */
  mode: "append" | "replace";
  /** False: archived raw, never indexed (an adapter stub). */
  indexable: boolean;
  /** Whether `resume` can put the session back for the agent. */
  supportsResume: boolean;
  /** Snapshot a live sqlite file before copying it. */
  snapshot?: "sqlite";
  /** The sessions root under a home directory, honouring the agent's env. */
  rootFor(home: string, env: Record<string, string | undefined>): string;
  /** rsync filter arguments that select the session files under the root. */
  rsyncFilters: readonly string[];
  accepts(relpath: string): boolean;
  classify(relpath: string): FileMeta;
  timestampOf(record: unknown): string | null;
  parse(record: unknown, state: ParseState): Doc[];
  extraFiles?: readonly ExtraFile[];
  /** The relpath a restored session takes on the target machine. */
  restoreRelpath(args: {
    relpath: string;
    session: string;
    sourceHome: string | null;
    targetHome: string;
  }): string;
  /** What to run to continue the session; null when it cannot be resumed. */
  resumeCommand(session: string, cwd: string | null): string | null;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Claude names a project directory after the working directory. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const HOME_PREFIX = /^-(Users|var-home|home)-[^-]+/;

/**
 * A Claude project directory name moved to another machine: the home
 * directory part is swapped for the target's, the rest stays.
 */
export function mapClaudeProject(project: string, targetHome: string): string {
  const mapped = HOME_PREFIX.test(project)
    ? project.replace(HOME_PREFIX, claudeProjectDirName(targetHome))
    : project;
  return mapped;
}

/** The same for a working directory path. */
export function mapCwd(cwd: string, targetHome: string): string {
  const match = /^\/(Users|var\/home|home)\/[^/]+/.exec(cwd);
  return match ? targetHome + cwd.slice(match[0].length) : cwd;
}

const claude: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  mode: "append",
  indexable: true,
  supportsResume: true,
  rootFor: (home) => join(home, ".claude", "projects"),
  rsyncFilters: ["--include=*/", "--include=*.jsonl", "--exclude=*"],
  accepts: (relpath) => relpath.endsWith(".jsonl"),
  classify(relpath) {
    const parts = relpath.split("/");
    const project = parts[0] ?? "";
    if (parts.length === 2)
      return {
        project,
        session: (parts[1] ?? "").replace(/\.jsonl$/, ""),
        subagent: false,
      };
    return { project, session: parts[1] ?? "", subagent: true };
  },
  timestampOf: (record) =>
    isObject(record) ? (stringOf(record.timestamp) ?? null) : null,
  parse(record, state) {
    if (isObject(record)) {
      if (state.cwd === undefined && typeof record.cwd === "string")
        state.cwd = record.cwd;
      if (
        record.type === "cost-state" &&
        typeof record.totalCostUSD === "number"
      )
        state.cost = record.totalCostUSD;
    }
    return extractClaude(record, state.thinking, state.unknown);
  },
  extraFiles: [
    {
      relpath: "@history.jsonl",
      homePath: ".claude/history.jsonl",
      kind: "history",
    },
  ],
  restoreRelpath: ({ relpath, targetHome }) => {
    const parts = relpath.split("/");
    parts[0] = mapClaudeProject(parts[0] ?? "", targetHome);
    return parts.join("/");
  },
  resumeCommand: (session) => `claude --resume ${session}`,
};

function contentBlocks(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function codexMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .map((block) => stringOf(block.text))
    .filter((text): text is string => Boolean(text))
    .join(" ");
}

const CODEX_IGNORED = new Set([
  "event_msg",
  "turn_context",
  "compacted",
  "world_state",
  "token_usage_record",
]);
const CODEX_ITEM_IGNORED = new Set([
  "web_search_call",
  "local_shell_call",
  "ghost_snapshot",
  "tool_search_call",
  "tool_search_output",
]);

const codex: AgentAdapter = {
  id: "codex",
  label: "Codex",
  mode: "append",
  indexable: true,
  supportsResume: false,
  rootFor: (home, env) =>
    join(env.CODEX_HOME?.trim() || join(home, ".codex"), "sessions"),
  rsyncFilters: ["--include=*/", "--include=rollout-*.jsonl", "--exclude=*"],
  accepts: (relpath) =>
    posix.basename(relpath).startsWith("rollout-") &&
    relpath.endsWith(".jsonl"),
  classify(relpath) {
    const name = posix.basename(relpath, ".jsonl");
    const found = name.match(new RegExp(UUID.source, "gi"));
    return {
      project: "",
      session: found ? (found[found.length - 1] as string).toLowerCase() : name,
      subagent: false,
    };
  },
  timestampOf: (record) =>
    isObject(record) ? (stringOf(record.timestamp) ?? null) : null,
  parse(record, state) {
    if (!isObject(record)) return [];
    const type = stringOf(record.type) ?? "";
    const payload = isObject(record.payload) ? record.payload : {};
    if (type === "session_meta") {
      const cwd = stringOf(payload.cwd);
      if (cwd && state.cwd === undefined) {
        state.cwd = cwd;
        state.project = claudeProjectDirName(cwd);
      }
      const id = stringOf(payload.id);
      if (id && UUID.test(id)) state.session = id.toLowerCase();
      return [];
    }
    if (CODEX_IGNORED.has(type)) return [];
    if (type !== "response_item") {
      state.unknown.set(type, (state.unknown.get(type) ?? 0) + 1);
      return [];
    }
    const itemType = stringOf(payload.type) ?? "";
    switch (itemType) {
      case "message": {
        const role =
          payload.role === "assistant"
            ? "assistant"
            : payload.role === "user"
              ? "user"
              : null;
        const text = codexMessageText(payload.content);
        if (!role || !text.trim()) return [];
        return [{ role, kind: "text", tool: null, text: clip(text, 20_000) }];
      }
      case "function_call":
      case "custom_tool_call": {
        const raw = payload.arguments ?? payload.input;
        return [
          {
            role: "assistant",
            kind: "tool_use",
            tool: stringOf(payload.name) ?? null,
            text: clip(
              typeof raw === "string" ? raw : stableStringify(raw ?? ""),
              2_000,
            ),
          },
        ];
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const out = payload.output;
        const text = typeof out === "string" ? out : stableStringify(out ?? "");
        return text.trim()
          ? [
              {
                role: "tool",
                kind: "tool_result",
                tool: null,
                text: clipResult(text.trim()),
              },
            ]
          : [];
      }
      case "reasoning": {
        if (!state.thinking) return [];
        const summary = contentBlocks(payload.summary)
          .map((block) => stringOf(block.text))
          .filter(Boolean)
          .join(" ");
        return summary
          ? [
              {
                role: "assistant",
                kind: "thinking",
                tool: null,
                text: clip(summary, 20_000),
              },
            ]
          : [];
      }
      default:
        if (!CODEX_ITEM_IGNORED.has(itemType))
          state.unknown.set(
            `response_item/${itemType}`,
            (state.unknown.get(`response_item/${itemType}`) ?? 0) + 1,
          );
        return [];
    }
  },
  restoreRelpath: ({ relpath }) => relpath,
  resumeCommand: () => null,
};

const PI_IGNORED = new Set([
  "model_change",
  "thinking_level_change",
  "label",
  "compaction",
  "branch_summary",
  "session_info",
]);

const pi: AgentAdapter = {
  id: "pi",
  label: "Pi",
  mode: "append",
  indexable: true,
  supportsResume: true,
  rootFor: (home, env) =>
    join(
      env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent"),
      "sessions",
    ),
  rsyncFilters: ["--include=*/", "--include=*.jsonl", "--exclude=*"],
  accepts: (relpath) => relpath.endsWith(".jsonl") && relpath.includes("/"),
  classify(relpath) {
    const parts = relpath.split("/");
    const name = posix.basename(relpath, ".jsonl");
    const found = UUID.exec(name);
    return {
      project: parts[0] ?? "",
      session: found ? found[0].toLowerCase() : name,
      subagent: false,
    };
  },
  timestampOf: (record) =>
    isObject(record) ? (stringOf(record.timestamp) ?? null) : null,
  parse(record, state) {
    if (!isObject(record)) return [];
    const type = stringOf(record.type) ?? "";
    if (type === "session") {
      const cwd = stringOf(record.cwd);
      if (cwd && state.cwd === undefined) state.cwd = cwd;
      return [];
    }
    if (PI_IGNORED.has(type)) return [];
    if (type === "custom_message") {
      const content = stringOf(record.content);
      return content?.trim()
        ? [
            {
              role: "system",
              kind: "text",
              tool: null,
              text: clip(content, 20_000),
            },
          ]
        : [];
    }
    if (type !== "message") {
      state.unknown.set(type, (state.unknown.get(type) ?? 0) + 1);
      return [];
    }
    const message = isObject(record.message) ? record.message : {};
    const role = stringOf(message.role);
    const out: Doc[] = [];
    if (role === "toolResult") {
      const text = codexMessageText(message.content);
      if (text.trim())
        out.push({
          role: "tool",
          kind: "tool_result",
          tool: stringOf(message.toolName) ?? null,
          text: clipResult(text.trim()),
        });
      return out;
    }
    if (role !== "user" && role !== "assistant") return out;
    for (const block of contentBlocks(message.content)) {
      const blockType = stringOf(block.type);
      if (blockType === "text") {
        const text = stringOf(block.text);
        if (text?.trim())
          out.push({
            role,
            kind: "text",
            tool: null,
            text: clip(text, 20_000),
          });
      } else if (blockType === "toolCall") {
        out.push({
          role,
          kind: "tool_use",
          tool: stringOf(block.name) ?? null,
          text: clip(stableStringify(block.arguments ?? {}), 2_000),
        });
      } else if (blockType === "thinking" && state.thinking) {
        const text = stringOf(block.thinking);
        if (text)
          out.push({
            role,
            kind: "thinking",
            tool: null,
            text: clip(text, 20_000),
          });
      }
    }
    return out;
  },
  restoreRelpath: ({ relpath }) => relpath,
  resumeCommand: (session) => `pi --session ${session}`,
};

/** An agent whose sessions are archived raw only (an adapter stub). */
function rawAgent(
  id: string,
  label: string,
  rootFor: AgentAdapter["rootFor"],
  filters: readonly string[],
  accepts: (relpath: string) => boolean,
  options: { mode: "append" | "replace"; snapshot?: "sqlite" },
): AgentAdapter {
  return {
    id,
    label,
    mode: options.mode,
    indexable: false,
    supportsResume: false,
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    rootFor,
    rsyncFilters: filters,
    accepts,
    classify: (relpath) => ({
      project: posix.dirname(relpath) === "." ? "" : posix.dirname(relpath),
      session: posix.basename(relpath).replace(/\.[^.]+$/, ""),
      subagent: false,
    }),
    timestampOf: () => null,
    parse: () => [],
    restoreRelpath: ({ relpath }) => relpath,
    resumeCommand: () => null,
  };
}

const grok = rawAgent(
  "grok",
  "Grok",
  (home, env) => join(env.GROK_HOME?.trim() || join(home, ".grok"), "sessions"),
  [
    "--include=*/",
    "--include=*.jsonl",
    "--include=summary.json",
    "--exclude=*",
  ],
  (relpath) => relpath.endsWith(".jsonl") || relpath.endsWith("summary.json"),
  { mode: "replace" },
);

const muse = rawAgent(
  "muse",
  "Muse",
  (home, env) => {
    const data = env.XDG_DATA_HOME?.trim();
    return join(
      data?.startsWith("/") ? data : join(home, ".local", "share"),
      "muse",
      "sessions",
    );
  },
  ["--include=*/", "--include=*.jsonl", "--exclude=*"],
  (relpath) => relpath.endsWith(".jsonl"),
  { mode: "replace" },
);

const antigravity = rawAgent(
  "antigravity",
  "Antigravity",
  (home, env) =>
    env.ANTIGRAVITY_CONVERSATIONS_DIR?.trim() ||
    join(
      env.ANTIGRAVITY_HOME?.trim() ||
        env.GEMINI_HOME?.trim() ||
        join(home, ".gemini", "antigravity-cli"),
      "conversations",
    ),
  ["--include=*.db", "--exclude=*"],
  (relpath) => relpath.endsWith(".db"),
  { mode: "replace", snapshot: "sqlite" },
);

export const ADAPTERS: Record<string, AgentAdapter> = {
  claude,
  codex,
  pi,
  grok,
  muse,
  antigravity,
};

export function adapterFor(agent: string): AgentAdapter | undefined {
  return ADAPTERS[agent];
}
