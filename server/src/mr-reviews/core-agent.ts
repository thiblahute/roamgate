import { dirname, join } from "node:path";
import type { AssistantConfig } from "../../../shared/assistant";
import {
  CLAUDE_CODE_PROVIDER,
  createClaudeCodeDriver,
} from "../assistant/claude-driver";
import { createRangerMcp } from "../assistant/claude-mcp";
import { AssistantUserError } from "../assistant/errors";
import type { RangerTool } from "../assistant/ranger-tools";
import { mrAgentPath } from "./agent";

/**
 * The reviews agent's turns for the Rust core while it owns the reviews:
 * the core keeps the chat and runs the tools, Bun's Claude Code driver
 * (agent.ts's, the same MCP server name and stand-in command) runs each
 * turn. A tool's call goes to the core (`agent_tool`), and what the turn
 * reports comes back to it in order (`agent_event`).
 */

/** A tool as the core describes it (contract/tools/catalog.json). */
type CoreTool = {
  name: string;
  description: string;
  parameters: RangerTool["parameters"];
  replay?: "safe" | "unsafe";
  sequential?: boolean;
};

export type CoreAgentTurn = {
  turn_id: string;
  model: string;
  resume?: string | null;
  text: string;
  system_prompt: string;
  tools: CoreTool[];
};

export function createCoreAgentTurns(deps: {
  /** An `internal.mr_reviews.<op>` call to the core. */
  call: (op: string, params: unknown) => Promise<unknown>;
  directory?: string;
}) {
  const mcp = createRangerMcp(undefined, "reviews");
  // Test servers name a stand-in (or a wrapper) for `claude`.
  const command = process.env.ROAMGATE_REVIEWS_AGENT_COMMAND || undefined;
  let tools: RangerTool[] = [];
  let prompt = "";
  const driver = createClaudeCodeDriver({
    directory: deps.directory ?? join(dirname(mrAgentPath()), "agent"),
    mcp,
    ...(command ? { command } : {}),
    tools: () => tools,
    systemPrompt: () => prompt,
  });
  const running = new Map<string, AbortController>();

  async function run(turn: CoreAgentTurn): Promise<{ ok: true }> {
    const controller = new AbortController();
    running.set(turn.turn_id, controller);
    // What the turn reports reaches the core in its order.
    let chain: Promise<unknown> = Promise.resolve();
    const send = (event: Record<string, unknown>) => {
      chain = chain
        .then(() =>
          deps.call("agent_event", { turn_id: turn.turn_id, ...event }),
        )
        .catch(() => undefined);
      return chain;
    };
    prompt = turn.system_prompt;
    tools = turn.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      replay: tool.replay ?? "unsafe",
      sequential: !!tool.sequential,
      call: async (params: unknown) => {
        const answer = (await deps.call("agent_tool", {
          turn_id: turn.turn_id,
          name: tool.name,
          params,
        })) as { text?: string; error?: { user?: boolean; message?: string } };
        if (answer.error) {
          const message = answer.error.message ?? "the tool failed";
          throw answer.error.user
            ? new AssistantUserError(message)
            : new Error(message);
        }
        return { text: answer.text ?? "" };
      },
    }));
    try {
      await driver.run({
        config: {
          provider: CLAUDE_CODE_PROVIDER,
          model: turn.model,
          credential_source: "assistant",
          allowed_workspaces: [],
          approval_mode: "manual",
        } satisfies AssistantConfig,
        entries: turn.resume
          ? [{ type: "ranger-claude", session: turn.resume }]
          : [],
        text: turn.text,
        signal: controller.signal,
        read: async () => {
          throw new Error("no workspace here");
        },
        checkpoint: (entries) => send({ kind: "checkpoint", entries }),
        delta: (text) => void send({ kind: "delta", text }),
        message: (text) => void send({ kind: "message", text }),
        thinking: (steps) => void send({ kind: "thinking", steps }),
        tool: (id, name, status, details) =>
          void send({
            kind: "tool",
            id,
            name,
            status,
            ...(details ? { details } : {}),
          }),
        error: () => void send({ kind: "error" }),
      });
    } finally {
      running.delete(turn.turn_id);
      await chain;
    }
    return { ok: true };
  }

  return {
    run,
    /** Stops the running turn. */
    async stop(): Promise<{ ok: true }> {
      for (const controller of running.values())
        controller.abort(new Error("stopped"));
      await driver.stop();
      return { ok: true };
    },
  };
}
