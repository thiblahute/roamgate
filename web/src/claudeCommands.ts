import { useEffect, useState } from "react";
import type { AgentCommand } from "../../shared/agentSession";
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

/** Antigravity CLI (`agy`) built-in slash commands. */
export const AGY_BUILTIN_COMMANDS: AgentCommand[] = [
  { name: "usage", description: "Show model quota usage" },
  { name: "context", description: "Show context usage" },
  {
    name: "mode",
    description: "Switch mode (default, accept-edits, auto, plan)",
  },
  { name: "model", description: "Choose the reasoning model" },
  { name: "compact", description: "Compact conversation history" },
  { name: "goal", description: "Run until a goal is finished" },
  { name: "plan", description: "Plan carefully before executing" },
  { name: "grill-me", description: "Interview to align on a plan" },
  { name: "schedule", description: "Run on a schedule or timer" },
  { name: "browser", description: "Invoke a browser agent" },
  { name: "teamwork", description: "Invoke an autonomous agent team" },
  { name: "learn", description: "Capture reusable skills or rules" },
  { name: "boost", description: "Invoke the Boost orchestrator" },
  { name: "swarm", description: "Run parallel agents on a task" },
  { name: "help", description: "Show commands and keyboard shortcuts" },
  { name: "config", description: "Open the settings editor" },
  { name: "clear", description: "Clear the terminal and reset context" },
  { name: "resume", description: "Open the conversation picker" },
  { name: "fork", description: "Clone the conversation" },
  { name: "rewind", description: "Roll back to an earlier message" },
  { name: "rename", description: "Rename the current session" },
  { name: "planning", description: "Enable multi-turn planning mode" },
  { name: "fast", description: "Enable fast mode without reasoning plans" },
  { name: "diff", description: "Review changes, turns, and commits" },
  { name: "artifact", description: "Open the artifact review panel" },
  { name: "agents", description: "Manage agents and subagents" },
  { name: "tasks", description: "Monitor background shell tasks" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "skills", description: "Browse loaded skills" },
  { name: "hooks", description: "Browse active script hooks" },
  { name: "plugin", description: "Browse and manage plugins" },
  { name: "permissions", description: "Manage tool permissions" },
  { name: "keybindings", description: "Edit keyboard shortcuts" },
  { name: "statusline", description: "Customize the status bar" },
  { name: "title", description: "Configure terminal window title updates" },
  { name: "add-dir", description: "Add a directory to the active workspace" },
  { name: "open", description: "Open a path in the system editor" },
  { name: "btw", description: "Ask a side question without interrupting" },
  { name: "copy", description: "Copy the last agent response" },
  { name: "feedback", description: "Open the feedback panel" },
  { name: "logout", description: "Sign out and remove auth tokens" },
  { name: "exit", description: "Exit Antigravity CLI" },
];

const REFRESH_MS = 60_000;

/** The /commands a Claude or AGY pane offers: its own, then the session's. */
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
  const agy = enabled && pane.agent === "agy";
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
  if (agy) return AGY_BUILTIN_COMMANDS;
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
 * Claude Code): sent as text, or, for /rewind, /model and /mcp, the chat's
 * own sheet (`/model <name>` switches at once, kept for the next starts).
 */
const CONVERSATION_BUILTINS = new Set([
  "clear",
  "compact",
  "context",
  "cost",
  "mcp",
  "model",
  "rewind",
]);

/** AGY commands that work in ACP conversation mode. */
const AGY_CONVERSATION_BUILTINS = new Set([
  "usage",
  "context",
  "mode",
  "model",
  "compact",
  "goal",
  "plan",
  "grill-me",
  "schedule",
  "browser",
  "teamwork",
  "learn",
  "boost",
  "swarm",
]);

/** `/mcp`, with or without the arguments Claude Code's own command takes. */
export function isMcpCommand(text: string): boolean {
  return /^\s*\/mcp(?:\s[\s\S]*)?$/.test(text);
}

/** The commands offered in conversation mode: no TUI-only ones. */
export function conversationCommands(
  commands: readonly AgentCommand[],
  kind: "claude" | "agy" = "claude",
): AgentCommand[] {
  if (kind === "agy") {
    const builtin = new Set(AGY_BUILTIN_COMMANDS.map((each) => each.name));
    return commands.filter(
      (each) =>
        !builtin.has(each.name) || AGY_CONVERSATION_BUILTINS.has(each.name),
    );
  }
  const builtin = new Set(CLAUDE_BUILTIN_COMMANDS.map((each) => each.name));
  return commands.filter(
    (each) => !builtin.has(each.name) || CONVERSATION_BUILTINS.has(each.name),
  );
}

/**
 * Why a message cannot go to conversation mode, or null: a command only
 * the agent's terminal TUI has. (A `!` line runs, as bash mode: shellLine.)
 */
export function conversationRefusal(
  text: string,
  kind: "claude" | "agy" = "claude",
): string | null {
  const trimmed = text.trim();
  const command = /^\/([\w:.-]+)/.exec(trimmed)?.[1];
  if (!command) return null;
  if (kind === "agy") {
    if (
      !AGY_CONVERSATION_BUILTINS.has(command) &&
      AGY_BUILTIN_COMMANDS.some((each) => each.name === command)
    )
      return `/${command} works only in the terminal: show the terminal to use it.`;
    return null;
  }
  if (
    !CONVERSATION_BUILTINS.has(command) &&
    CLAUDE_BUILTIN_COMMANDS.some((each) => each.name === command)
  )
    return `/${command} works only in the terminal: show the terminal to use it.`;
  return null;
}
