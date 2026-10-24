import { randomUUID } from "node:crypto";
import type {
  AgentPermissionPrompt,
  AgentPromptAnswer,
  AgentQuestion,
  ReviewPush,
} from "../../../shared/review";

/** What an agent's permission hook asks, for the browser to answer. */
export type PermissionRequest = {
  connectionId: string;
  paneId: string;
  agent: string;
  tool: string;
  input: unknown;
  canAlways: boolean;
  /** Claude's questions, answered with the chosen options. */
  questions?: AgentQuestion[];
  /** How long the hook waits before the terminal asks instead. */
  timeoutMs: number;
  /** The hook went away: the terminal is asking now. */
  signal?: AbortSignal;
};

const DETAIL_CHARS = 2000;

/** The line that says what a tool would do: its command, file, or URL. */
export function permissionSummary(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const fields = input as Record<string, unknown>;
    for (const key of [
      "command",
      "file_path",
      "notebook_path",
      "url",
      "pattern",
      "path",
      "query",
      "description",
    ]) {
      const value = fields[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return tool;
}

/**
 * The permission prompts agents' hooks are waiting on, per connection. Each
 * waits until the browser answers, the hook gives up, or it times out; an
 * unanswered prompt goes back to the terminal's own dialog.
 */
export function createAgentPrompts(args: {
  publish: (push: ReviewPush) => void;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const open = new Map<
    string,
    {
      prompt: AgentPermissionPrompt;
      finish: (answer: AgentPromptAnswer | null) => void;
    }
  >();

  function list(connectionId: string): AgentPermissionPrompt[] {
    return [...open.values()]
      .map((entry) => entry.prompt)
      .filter((prompt) => prompt.connectionId === connectionId);
  }

  function publish(connectionId: string) {
    args.publish({
      type: "prompts",
      connectionId,
      prompts: list(connectionId),
    });
  }

  function request(
    params: PermissionRequest,
  ): Promise<AgentPromptAnswer | null> {
    const id = randomUUID();
    const created = now();
    let detail: string | undefined;
    try {
      detail = JSON.stringify(params.input, null, 2)?.slice(0, DETAIL_CHARS);
    } catch {
      detail = undefined;
    }
    const prompt: AgentPermissionPrompt = {
      id,
      connectionId: params.connectionId,
      paneId: params.paneId,
      agent: params.agent,
      tool: params.tool,
      summary: permissionSummary(params.tool, params.input).slice(0, 500),
      detail,
      canAlways: params.canAlways,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + params.timeoutMs).toISOString(),
      ...(params.questions ? { questions: params.questions } : {}),
    };
    return new Promise((resolve) => {
      const finish = (answer: AgentPromptAnswer | null) => {
        if (!open.has(id)) return;
        clearTimeout(timer);
        params.signal?.removeEventListener("abort", onAbort);
        open.delete(id);
        publish(params.connectionId);
        resolve(answer);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), params.timeoutMs);
      params.signal?.addEventListener("abort", onAbort, { once: true });
      open.set(id, { prompt, finish });
      publish(params.connectionId);
      if (params.signal?.aborted) finish(null);
    });
  }

  /** False when the prompt is gone: answered, or back in the terminal. */
  function answer(params: {
    connectionId: string;
    id: string;
    answer: AgentPromptAnswer;
  }): boolean {
    const entry = open.get(params.id);
    if (!entry || entry.prompt.connectionId !== params.connectionId)
      return false;
    // Questions take answers; permissions take a decision.
    if ((typeof params.answer === "object") !== !!entry.prompt.questions)
      return false;
    if (params.answer === "always" && !entry.prompt.canAlways) return false;
    entry.finish(params.answer);
    return true;
  }

  /** Hands a prompt back to the terminal, unanswered. */
  function release(params: { connectionId: string; id: string }): boolean {
    const entry = open.get(params.id);
    if (!entry || entry.prompt.connectionId !== params.connectionId)
      return false;
    entry.finish(null);
    return true;
  }

  return { request, answer, release, list };
}

export type AgentPrompts = ReturnType<typeof createAgentPrompts>;
