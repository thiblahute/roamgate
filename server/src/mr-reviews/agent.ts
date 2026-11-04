import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantConfig } from "../../../shared/assistant";
import type {
  MrAgentMessage,
  MrAgentSnapshot,
  MrItem,
} from "../../../shared/mrReviews";
import {
  CLAUDE_CODE_PROVIDER,
  createClaudeCodeDriver,
  type SpawnClaudeCode,
  isClaudeCodePointer,
} from "../assistant/claude-driver";
import { createRangerMcp } from "../assistant/claude-mcp";
import { dataRoot, replaceDataFile } from "../config/data-paths";
import { type Logger, serverLogger } from "../utils/logger";
import type { FoundRequest } from "./agent-search";
import {
  createReviewsAgentTools,
  FORGE_CALLS_PER_TURN,
  type MrAgentToolDeps,
  reviewsAgentSystemPrompt,
} from "./agent-tools";

/**
 * The reviews agent: a chat in the Reviews panel with a headless Claude
 * Code agent, as Ranger's (claude-driver.ts): each question is one
 * `claude -p` turn resumed from the chat's session, with only this
 * module's tools over a turn-scoped loopback MCP server (agent-tools.ts).
 * Not a pane session. The session id and the chat are kept in
 * `<data>/mr-reviews/agent.json`, the Claude Code session's own folder in
 * `<data>/mr-reviews/agent/claude`.
 */

/** The model measured best for the job (docs/ARCHITECTURE.md). */
export const REVIEWS_AGENT_MODEL = "opus";
/** Messages kept in the chat. */
const MESSAGES_KEPT = 120;
/** Questions waiting behind the running one, at most. */
const QUEUE_MAX = 5;
const TEXT_MAX = 32_000;
const QUESTION_MAX = 8_000;

type Saved = {
  instance_id: string;
  session?: string;
  messages: MrAgentMessage[];
};

export function mrAgentPath(root = dataRoot()): string {
  return join(root, "mr-reviews", "agent.json");
}

function load(path: string): Saved {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Saved>;
      return {
        instance_id:
          typeof raw.instance_id === "string" ? raw.instance_id : randomUUID(),
        ...(typeof raw.session === "string" ? { session: raw.session } : {}),
        messages: Array.isArray(raw.messages)
          ? raw.messages
              .filter(
                (message) =>
                  message &&
                  typeof message.id === "string" &&
                  (message.role === "user" || message.role === "assistant"),
              )
              // A turn cut by a restart: its tools ran or not, nothing more.
              .map((message) => ({
                ...message,
                tools: (message.tools ?? []).map((tool) =>
                  tool.status === "running"
                    ? { ...tool, status: "failed" as const }
                    : tool,
                ),
                sources: message.sources ?? [],
              }))
              .slice(-MESSAGES_KEPT)
          : [],
      };
    }
  } catch {}
  return { instance_id: randomUUID(), messages: [] };
}

export type MrAgentDeps = Omit<MrAgentToolDeps, "show" | "seen" | "budget"> & {
  path?: string;
  /** Where the Claude Code session lives (its cwd's parent). */
  directory?: string;
  model?: string;
  /** Runs `claude` (tests: a fake). */
  spawn?: SpawnClaudeCode;
  logger?: Logger;
};

export function createMrAgent(deps: MrAgentDeps) {
  const path = deps.path ?? mrAgentPath();
  const directory = deps.directory ?? join(dirname(path), "agent");
  const model = deps.model ?? REVIEWS_AGENT_MODEL;
  const logger = deps.logger ?? serverLogger.child("mr-reviews");
  const saved = load(path);
  let session = saved.session;
  let instance = saved.instance_id;
  let messages = saved.messages;
  let revision = 1;
  let running = false;
  let error: string | null = null;
  let queue: MrAgentSnapshot["queue"] = [];
  const queued = new Map<string, string | undefined>();
  /** Requests read in this chat: their keys resolve without a call. */
  let seen = new Map<string, FoundRequest>();
  let turnTools: ReturnType<typeof createReviewsAgentTools> = [];
  let controller: AbortController | null = null;

  const mcp = createRangerMcp(undefined, "reviews");
  // Test servers name a stand-in (or a wrapper) for `claude`.
  const command = process.env.ROAMGATE_REVIEWS_AGENT_COMMAND || undefined;
  const driver = createClaudeCodeDriver({
    directory,
    mcp,
    ...(command ? { command } : {}),
    ...(deps.spawn ? { spawn: deps.spawn, available: () => true } : {}),
    tools: () => turnTools,
    systemPrompt: reviewsAgentSystemPrompt,
  });

  function save() {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    replaceDataFile(
      path,
      `${JSON.stringify({
        instance_id: instance,
        ...(session ? { session } : {}),
        messages: messages.slice(-MESSAGES_KEPT),
      } satisfies Saved)}\n`,
    );
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A change: seen at once by the next read, written a moment later. */
  function changed(now = false) {
    revision++;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (now) save();
    else {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        save();
      }, 1_000);
      (saveTimer as { unref?: () => void }).unref?.();
    }
  }

  function snapshot(): MrAgentSnapshot {
    return {
      instance_id: instance,
      revision,
      ...(session ? { session_id: session } : {}),
      model,
      running,
      error,
      messages,
      queue,
    };
  }

  async function turn(text: string, requestId: string | undefined) {
    running = true;
    error = null;
    const at = new Date().toISOString();
    messages = [
      ...messages,
      {
        id: randomUUID(),
        role: "user" as const,
        text,
        sent_at: at,
        tools: [],
        sources: [],
        ...(requestId ? { request_id: requestId } : {}),
      },
    ].slice(-MESSAGES_KEPT);
    const draft: MrAgentMessage = {
      id: randomUUID(),
      role: "assistant",
      text: "",
      sent_at: at,
      tools: [],
      sources: [],
      ...(requestId ? { request_id: requestId } : {}),
    };
    messages = [...messages, draft];
    changed(true);
    controller = new AbortController();
    const signal = controller.signal;
    const budget = { left: FORGE_CALLS_PER_TURN };
    turnTools = createReviewsAgentTools({
      ...deps,
      seen,
      budget,
      show: (item: MrItem) => {
        draft.opens = [...(draft.opens ?? []), item];
        changed();
      },
    });
    const started = Date.now();
    let finalized = "";
    let streamed = "";
    let failed = false;
    const update = () => {
      draft.text = [finalized, streamed]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, TEXT_MAX);
      changed();
    };
    const run = (resume: string | undefined) =>
      driver.run({
        config: {
          provider: CLAUDE_CODE_PROVIDER,
          model,
          credential_source: "assistant",
          allowed_workspaces: [],
          approval_mode: "manual",
        } satisfies AssistantConfig,
        entries: resume ? [{ type: "ranger-claude", session: resume }] : [],
        text,
        signal,
        read: async () => {
          throw new Error("no workspace here");
        },
        checkpoint: (entries) => {
          if (isClaudeCodePointer(entries)) {
            session = entries[0].session;
            changed(true);
          }
        },
        delta: (value) => {
          streamed = (streamed + value).slice(0, TEXT_MAX);
          update();
        },
        message: (value) => {
          if (value)
            finalized = [finalized, value]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, TEXT_MAX);
          streamed = "";
          update();
        },
        thinking: (steps) => {
          draft.thinking = steps.slice(-8).map((step) => step.slice(0, 4000));
          changed();
        },
        tool: (id, name, status, details) => {
          const tool = draft.tools.find((entry) => entry.id === id);
          if (tool) {
            tool.status = status;
            if (details?.output !== undefined) tool.output = details.output;
          } else if (draft.tools.length < 64)
            draft.tools.push({ id, name, status, ...details });
          changed();
        },
        error: () => {
          failed = true;
        },
      });
    try {
      const resumed = session;
      await run(resumed);
      // A session Claude Code no longer has (cleaned up): a new one, once.
      if (failed && resumed && !draft.text && !draft.tools.length) {
        session = undefined;
        failed = false;
        await run(undefined);
      }
      if (failed && !signal.aborted) {
        draft.failed = true;
        error = "The reviews agent could not answer. Try again.";
      }
    } catch (cause) {
      if (!signal.aborted) {
        draft.failed = true;
        error = (cause instanceof Error ? cause.message : String(cause)).slice(
          0,
          300,
        );
      }
    } finally {
      for (const tool of draft.tools)
        if (tool.status === "running") tool.status = "failed";
      controller = null;
      running = false;
      changed(true);
      logger.info("reviews agent answered", {
        model,
        ms: Date.now() - started,
        tools: draft.tools.length,
        forge_calls: FORGE_CALLS_PER_TURN - budget.left,
        ...(draft.failed ? { failed: true } : {}),
      });
      const next = queue.shift();
      if (next) {
        const nextRequest = queued.get(next.id);
        queued.delete(next.id);
        void turn(next.text, nextRequest);
      }
    }
  }

  return {
    snapshot,
    /** A question: answered now, or after the running one (queued). */
    send(
      raw: string,
      options: { requestId?: string; whenBusy?: "queue" } = {},
    ): { queued: boolean } {
      const text = raw.trim().slice(0, QUESTION_MAX);
      if (!text) throw new Error("the question is empty");
      if (!running) {
        void turn(text, options.requestId);
        return { queued: false };
      }
      if (options.whenBusy !== "queue")
        throw new Error("the reviews agent is answering");
      if (queue.length >= QUEUE_MAX)
        throw new Error("too many questions waiting");
      const id = options.requestId ?? randomUUID();
      queue = [
        ...queue,
        {
          id,
          mode: "follow_up",
          text,
          sent_at: new Date().toISOString(),
        },
      ];
      queued.set(id, options.requestId);
      changed();
      return { queued: true };
    },
    /** Takes a waiting question back. */
    unqueue(id: string): boolean {
      const before = queue.length;
      queue = queue.filter((entry) => entry.id !== id);
      queued.delete(id);
      if (queue.length !== before) changed();
      return queue.length !== before;
    },
    /** Stops the running answer; the waiting questions are dropped. */
    async stop() {
      queue = [];
      queued.clear();
      controller?.abort(new Error("stopped"));
      await driver.stop();
      changed();
    },
    /** A new chat: a new session, an empty conversation. */
    async reset() {
      queue = [];
      queued.clear();
      controller?.abort(new Error("stopped"));
      await driver.stop();
      instance = randomUUID();
      session = undefined;
      messages = [];
      seen = new Map();
      error = null;
      changed(true);
    },
    async dispose() {
      await this.stop();
      mcp.stop();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        save();
      }
    },
  };
}

export type MrAgent = ReturnType<typeof createMrAgent>;
