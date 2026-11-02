import { useEffect, useState } from "react";
import type { AgentCommand } from "../../server/src/agent/session-commands";
import type { Pane } from "./types";
import {
  useConnectionClient,
  connectionClientScopeKey,
} from "./useConnectionClient";
import { isPartialRead, PARTIAL_RETRY_MS } from "./partialRead";

export type { AgentCommand };

/**
 * Claude Code's own commands. Its transcript records a session's skills and
 * custom commands, not these.
 */
export const CLAUDE_BUILTIN_COMMANDS: AgentCommand[] = [
  { name: "add-dir", description: "Add a working directory" },
  { name: "agents", description: "Manage subagents" },
  { name: "clear", description: "Start a new conversation" },
  {
    name: "compact",
    description: "Summarize the conversation to free context",
  },
  { name: "config", description: "Open the settings" },
  { name: "context", description: "Show what fills the context" },
  { name: "cost", description: "Show this session's cost and duration" },
  { name: "doctor", description: "Check the installation" },
  { name: "exit", description: "Quit Claude Code" },
  { name: "export", description: "Export the conversation" },
  { name: "fast", description: "Toggle fast mode" },
  { name: "help", description: "Show help" },
  { name: "hooks", description: "Manage hooks" },
  { name: "init", description: "Write a CLAUDE.md for this project" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "memory", description: "Edit memory files" },
  { name: "model", description: "Choose the model" },
  { name: "permissions", description: "Manage permission rules" },
  { name: "plugin", description: "Manage plugins" },
  { name: "resume", description: "Resume another conversation" },
  { name: "rewind", description: "Go back to an earlier point" },
  { name: "status", description: "Show the version, model and account" },
  { name: "statusline", description: "Set up the status line" },
  {
    name: "tasks",
    description: "Roamgate: background tasks, subagents and workflows",
  },
  { name: "todos", description: "Show the todo list" },
  { name: "usage", description: "Show plan usage" },
  { name: "vim", description: "Toggle Vim editing" },
];

const REFRESH_MS = 60_000;

/** The /commands a Claude pane offers: its own, then the session's. */
export function useAgentCommands(pane: Pane, enabled: boolean): AgentCommand[] {
  const client = useConnectionClient();
  const scope = connectionClientScopeKey(
    client,
    pane.pane_id,
    pane.terminal_id,
    pane.workspace_id,
    pane.tab_id,
  );
  const [session, setSession] = useState<{
    scope: string;
    values: AgentCommand[];
  } | null>(null);
  const claude = enabled && pane.agent === "claude";
  useEffect(() => {
    if (!claude) {
      setSession(null);
      return;
    }
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      let partial = false;
      try {
        const result = (await client.call("agent_commands.get", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
        })) as { commands?: AgentCommand[]; partial?: boolean };
        partial = isPartialRead(result);
        // Read from part of the session: what showed already stays.
        if (live && client.isCurrent())
          setSession((current) =>
            partial && current?.scope === scope
              ? current
              : { scope, values: result.commands ?? [] },
          );
      } catch {
        // Not readable now: the built-in commands still show.
      }
      if (live)
        timer = window.setTimeout(
          load,
          partial ? PARTIAL_RETRY_MS : REFRESH_MS,
        );
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    client,
    scope,
    claude,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  if (!claude) return [];
  const builtin = new Set(CLAUDE_BUILTIN_COMMANDS.map((each) => each.name));
  return [
    ...CLAUDE_BUILTIN_COMMANDS,
    ...(session?.scope === scope ? session.values : []).filter(
      (each) => !builtin.has(each.name),
    ),
  ];
}

/**
 * The commands for a draft that is a command being typed (`/` and a word,
 * nothing else): names starting with it first, then names containing it.
 */
export function matchCommands(
  draft: string,
  commands: AgentCommand[],
  limit = 8,
): AgentCommand[] {
  const typed = /^\/([\w:.-]*)$/.exec(draft);
  if (!typed || !commands.length) return [];
  const query = typed[1]!.toLowerCase();
  const starts = commands.filter((each) =>
    each.name.toLowerCase().startsWith(query),
  );
  const contains = query
    ? commands.filter(
        (each) =>
          !each.name.toLowerCase().startsWith(query) &&
          each.name.toLowerCase().includes(query),
      )
    : [];
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Claude Code's own commands that work in conversation mode (a headless
 * Claude Code): sent as text, or, for /rewind, the chat's own picker.
 */
const CONVERSATION_BUILTINS = new Set([
  "clear",
  "compact",
  "context",
  "cost",
  "rewind",
]);

/** The commands offered in conversation mode: no TUI-only ones. */
export function conversationCommands(
  commands: readonly AgentCommand[],
): AgentCommand[] {
  const builtin = new Set(CLAUDE_BUILTIN_COMMANDS.map((each) => each.name));
  return commands.filter(
    (each) => !builtin.has(each.name) || CONVERSATION_BUILTINS.has(each.name),
  );
}

/**
 * Why a message cannot go to conversation mode, or null: a command only
 * Claude Code's terminal has. (A `!` line runs, as bash mode: shellLine.)
 */
export function conversationRefusal(text: string): string | null {
  const trimmed = text.trim();
  const command = /^\/([\w:.-]+)/.exec(trimmed)?.[1];
  if (
    command &&
    !CONVERSATION_BUILTINS.has(command) &&
    CLAUDE_BUILTIN_COMMANDS.some((each) => each.name === command)
  )
    return `/${command} works only in the terminal: show the terminal to use it.`;
  return null;
}
