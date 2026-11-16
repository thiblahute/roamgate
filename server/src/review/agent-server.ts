import type { LaunchSpec } from "../profiles/profiles";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentQuestion,
  commentEdited,
  type ReviewAnchor,
  type ReviewSession,
  type ReviewTarget,
  type ReviewThread,
  REVIEW_USER,
  threadNeedsAnswer,
} from "../../../shared/review";
import { type Logger, silentLogger } from "../utils/logger";
import { HOLD_CLIENT_INSTALLED_SCRIPT } from "../conversation/holder-script";
import {
  type HolderStatus,
  parseHolderStatus,
} from "../conversation/pane-child";
import {
  parseHolderShell,
  parseSuspendedSpec,
} from "../conversation/suspended";
import { REVIEW_CLIENT_CHECKSUM, REVIEW_CLIENT_SCRIPT } from "./agent-client";
import { REVIEW_SKILL } from "./agent-skill";
import {
  AgentMessageError,
  type AgentMessenger,
} from "../agent/agent-messenger";
import { agentAddress } from "../../../shared/agentMessage";
import { ClaudeModError, type ClaudeModHub } from "../agent/claude-mod";
import { writeClaudeModPlugin } from "../agent/claude-mod-plugin";
import { MOD_VIA } from "../../claude-mod/hooks/tools";
import { describeTarget, ReviewError, type ReviewService } from "./service";

/** What the agent server needs to know about a ready connection. */
export type ReviewAgentConnection = {
  id: string;
  /** The Herdr socket, for telling local connections apart. */
  herdrSocketPath?: string;
  sshHost?: string;
  readRoot: (path: string) => Promise<string>;
  readDefaultBase: (root: string) => Promise<string>;
};

export const REVIEW_CLIENT_INSTALLED_SCRIPT = `${REVIEW_CLIENT_SCRIPT}# roamgate-review ${REVIEW_CLIENT_CHECKSUM}\n`;

/** Where the agent looks for the client and the socket, on every host. */
export const REVIEW_HOME_DIR = ".cache/roamgate";

/**
 * The key of this host's own socket (the well-known link's target). An SSH
 * connection's socket is keyed by its connection id, so this key must be one
 * no connection id can take: ids start with a letter or a digit.
 */
export const LOCAL_SOCKET_KEY = "@local";

/** The largest request an agent may send: comments are at most 20k chars. */
export const REVIEW_AGENT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The largest chunk of a conversation holder's log: whole lines, and one
 * line (a tool result with screenshots, say) can pass a megabyte. A chunk
 * refused here is sent again forever, and the conversation is never read.
 */
export const HOLD_OUTPUT_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Long polls at once on one review; more are refused. */
export const REVIEW_AGENT_MAX_WATCHES = 8;

type Server = { stop: (closeActiveConnections?: boolean) => void };

/** Two names of one Herdr socket: the same path, or links to one file. */
function sameSocket(configured: string | undefined, named: string): boolean {
  if (!configured) return false;
  if (configured === named) return true;
  try {
    return realpathSync(configured) === realpathSync(named);
  } catch {
    return false;
  }
}

function intParam(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new ReviewError(`invalid ${field}`);
  return parsed;
}

function locationOf(anchor: ReviewAnchor): string {
  if (!anchor.path && anchor.effort)
    return `effort ${anchor.effort.tab}${anchor.effort.item ? ` ${anchor.effort.item.kind} ${anchor.effort.item.key}` : ""}`;
  if (!anchor.path) return "review";
  if (!anchor.line) return anchor.path;
  const lines = anchor.endLine
    ? `${anchor.line}-${anchor.endLine}`
    : `${anchor.line}`;
  return `${anchor.path}:${lines}${anchor.side === "old" ? " [old]" : ""}`;
}

/** Threads in the shape the skill documents. */
export function threadOutput(thread: ReviewThread) {
  return {
    id: thread.id,
    session: thread.sessionId,
    kind: thread.kind,
    location: locationOf(thread.anchor),
    path: thread.anchor.path ?? null,
    line: thread.anchor.line ?? null,
    end_line: thread.anchor.endLine ?? thread.anchor.line ?? null,
    side: thread.anchor.side ?? null,
    code: thread.anchor.text ?? null,
    // On a part of a chat message: which one, and the words quoted.
    ...(thread.anchor.chat
      ? {
          on_chat_message: {
            entry: thread.anchor.chat.entry,
            at: thread.anchor.chat.at ?? null,
            excerpt: thread.anchor.chat.excerpt ?? null,
            quote: thread.anchor.chat.quote,
            // On a file a tool call changed: that call (the path and
            // lines are the thread's own).
            ...(thread.anchor.chat.call
              ? { tool_call: thread.anchor.chat.call }
              : {}),
          },
        }
      : {}),
    // On what an effort's view shows: the tab, the item, the words.
    ...(thread.anchor.effort
      ? {
          on_effort: {
            tab: thread.anchor.effort.tab,
            item: thread.anchor.effort.item ?? null,
            plan: thread.anchor.effort.plan ?? null,
            quote: thread.anchor.effort.quote ?? null,
          },
        }
      : {}),
    // On a part of an earlier message: which one, and the words quoted.
    ...(thread.anchor.message
      ? {
          on_message: {
            thread: thread.anchor.message.thread,
            comment: thread.anchor.message.comment,
            quote: thread.anchor.message.quote ?? null,
          },
        }
      : {}),
    resolved: thread.resolved,
    // A review comment answering this GitLab discussion, once sent there.
    ...(thread.gitlabReplyTo ? { reply_to: `gl:${thread.gitlabReplyTo}` } : {}),
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      text: comment.body,
      created_at: comment.createdAt,
      ...(commentEdited(comment) ? { edited_at: comment.updatedAt } : {}),
      ...(comment.gitlabDraftId !== undefined ? { gitlab_draft: true } : {}),
    })),
  };
}

function sessionOutput(session: ReviewSession) {
  return {
    id: session.id,
    title: session.title,
    target: describeTarget(session.target),
    root: session.root,
    gitlab: session.gitlab,
    summary: session.summary,
    handoff_at: session.handoffAt ?? null,
    agent: session.agent,
    updated_at: session.updatedAt,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value, null, 2)}`, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The client sends a flat JSON object; values are read as strings. */
export function formOf(body: string): URLSearchParams {
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new ReviewError("invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ReviewError("invalid request");
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") throw new ReviewError(`invalid ${key}`);
    form.set(key, String(value));
  }
  return form;
}

export function parseTargetFlags(
  form: URLSearchParams,
  defaultBase: () => Promise<string>,
): Promise<ReviewTarget> | ReviewTarget {
  const mr = form.get("mr");
  if (mr) return { kind: "mr", url: mr };
  if (form.get("worktree")) return { kind: "worktree" };
  const compare = form.get("compare");
  if (compare) {
    // Git refuses ".." in ref names: the two refs split there.
    const [base, head, ...rest] = compare.split("..");
    if (!base || !head || rest.length)
      throw new ReviewError("--compare takes OLD NEW");
    return { kind: "range", base, head, compare: true };
  }
  const range = form.get("range");
  if (range) {
    const match = /^([^.\s]+?)\.\.\.?([^.\s]*)$/.exec(range);
    if (!match) throw new ReviewError("--range takes BASE..HEAD");
    return { kind: "range", base: match[1]!, head: match[2] || "HEAD" };
  }
  return defaultBase().then((base) => ({ kind: "range", base, head: "HEAD" }));
}

/** Claude's AskUserQuestion questions, as its hook passes them on. */
export function parseQuestions(raw: string | null): AgentQuestion[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentQuestion[] => {
    if (!item || typeof item !== "object") return [];
    const { question, header, options, multiSelect } = item as Record<
      string,
      unknown
    >;
    if (typeof question !== "string" || !Array.isArray(options)) return [];
    return [
      {
        question: question.slice(0, 2000),
        ...(typeof header === "string" ? { header: header.slice(0, 40) } : {}),
        options: options.flatMap((option) => {
          const { label, description } = (option ?? {}) as Record<
            string,
            unknown
          >;
          return typeof label === "string"
            ? [
                {
                  label: label.slice(0, 200),
                  ...(typeof description === "string"
                    ? { description: description.slice(0, 1000) }
                    : {}),
                },
              ]
            : [];
        }),
        multiSelect: multiSelect === true,
      },
    ];
  });
}

export function createReviewAgentServer(args: {
  service: ReviewService;
  /** The bridge's private directory for sockets. */
  directory: string;
  connections: () => ReviewAgentConnection[];
  logger?: Logger;
  home?: string;
  /** Whether any browser could answer a permission prompt now. */
  hasViewers?: () => boolean;
  /**
   * An agent telling the user they need to act: a notification, and the
   * agent in their list of what needs them.
   */
  notify?: (input: {
    connectionId: string;
    paneId: string;
    agent: string;
    title?: string;
    text: string;
  }) => Promise<void>;
  /**
   * Workspaces an agent makes or starts work in, placed under the agent's
   * own workspace in the Workspaces list, or into a group of it
   * (`place`, `worktree`, `workspace`; `groups` lists the groups).
   */
  workspaces?: (input: {
    connectionId: string;
    paneId: string;
    /** The agent's workspace, as its pane's environment says. */
    workspaceId: string;
    command: "place" | "worktree" | "workspace" | "groups";
    params: Record<string, string>;
  }) => Promise<Record<string, unknown>>;
  /**
   * The Reviews board's tools for any agent session (`roamgate-review
   * reviews TOOL JSON`, the mod's reviews_* tools): `params` checked
   * against the tool's schema there. Local state only, never a forge.
   */
  reviews?: (input: {
    connectionId: string;
    paneId: string;
    workspaceId: string;
    agent: string;
    tool: string;
    params: unknown;
  }) => Promise<string>;
  /**
   * Agent sessions messaging each other (`roamgate-review sessions` and
   * `message`): the sessions Roamgate manages, across connections.
   */
  messages?: Pick<AgentMessenger, "list" | "send">;
  /**
   * A claude the user just started in a pane (`roamgate-review
   * claude-start`, its SessionStart hook): conversation mode takes it when
   * Roamgate's claude start setting says so.
   */
  claudeStart?: (input: {
    connectionId: string;
    paneId: string;
    sessionId: string;
    source: string;
  }) => Promise<Record<string, unknown>>;
  /**
   * Roamgate's Claude Code mod (server/claude-mod): its inbox long-poll
   * (`mod_poll`), acknowledgements (`mod_ack`), session events
   * (`mod_event`), and a session saying it has the mod's tools
   * (`mod_tools`).
   */
  claudeMod?: Pick<ClaudeModHub, "poll" | "ack" | "event" | "tools">;
  /** A start prepared for a pane (roamgate-hold --launch), taken once. */
  launch?: (input: {
    connectionId: string;
    paneId: string;
    token: string;
  }) => LaunchSpec | null;
  /**
   * Conversation mode's pane holder (roamgate-hold): `hold` waits until the
   * session goes back to the terminal (or a while passes), `handback` asks
   * for it now. Both answer `{action: "resume", session_id, cwd}` once the
   * headless process is gone.
   */
  holder?: {
    hold: (input: {
      connectionId: string;
      paneId: string;
      sessionId: string;
      signal: AbortSignal;
      /** What a holder running the headless claude says of it. */
      status: HolderStatus | null;
      /** What it says of itself and its shell (job control, pid). */
      shell?: ReturnType<typeof parseHolderShell>;
    }) => Promise<Record<string, unknown>>;
    /** A holder sending its log from `offset` to `end`. */
    output: (input: {
      connectionId: string;
      paneId: string;
      holderId: string;
      offset: number;
      end: number;
      data: string;
    }) => Record<string, unknown>;
    handback: (input: {
      connectionId: string;
      paneId: string;
      sessionId: string;
    }) => Promise<Record<string, unknown>>;
    /**
     * `fg` brought back a holder stopped as a shell job: it asks for the
     * session it kept, in conversation mode again.
     */
    fg?: (input: {
      connectionId: string;
      paneId: string;
      spec: NonNullable<ReturnType<typeof parseSuspendedSpec>>;
      status: HolderStatus | null;
      shell: ReturnType<typeof parseHolderShell>;
    }) => Promise<Record<string, unknown>>;
  };
}) {
  const logger = args.logger ?? silentLogger;
  const home = args.home ?? homedir();
  const socketDirectory = join(args.directory, "agent");
  const servers = new Map<string, { path: string; server: Server }>();
  /** Watches in progress, by review. */
  const watches = new Map<string, number>();

  function socketPathFor(key: string): string {
    // Unix socket paths are short (104 bytes on macOS); hash the key.
    const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return join(socketDirectory, `${name}.sock`);
  }

  /**
   * The connection a request comes from. A pane naming its Herdr socket is
   * never taken for another connection's (a holder told to resume by a
   * connection that has no lease for its pane would start a second writer).
   */
  function connectionFor(
    socketKey: string,
    form: URLSearchParams,
  ): ReviewAgentConnection {
    const all = args.connections();
    if (socketKey !== LOCAL_SOCKET_KEY) {
      const found = all.find((connection) => connection.id === socketKey);
      if (!found) throw new ReviewError("this connection is not ready", 503);
      return found;
    }
    const local = all.filter((connection) => !connection.sshHost);
    const herdrSocket = form.get("herdr_socket");
    // A pane names its Herdr server: one Roamgate is not connected to is
    // refused, so its pane ids never reach another server's panes.
    if (herdrSocket) {
      const match = local.find((connection) =>
        sameSocket(connection.herdrSocketPath, herdrSocket),
      );
      if (match) return match;
      throw new ReviewError(
        "this pane's Herdr server is not one of Roamgate's connections",
        503,
      );
    }
    if (local.length === 1) return local[0]!;
    throw new ReviewError(
      local.length === 0
        ? "no local connection is ready"
        : "cannot tell which local connection this pane belongs to",
      503,
    );
  }

  async function sessionFor(
    connection: ReviewAgentConnection,
    form: URLSearchParams,
  ): Promise<ReviewSession> {
    // A comment names its review: an agent answering across a workspace's
    // repositories need not say which one.
    const comment = form.get("comment");
    const owner =
      !form.get("session") && comment
        ? args.service.sessionOfComment({
            connectionId: connection.id,
            commentId: comment,
          })
        : null;
    const id = form.get("session") || owner;
    if (id) {
      const { session } = args.service.get({ sessionId: id });
      if (session.connectionId !== connection.id)
        throw new ReviewError("no such review", 404);
      return session;
    }
    const root = await rootOf(connection, form);
    const latest = args.service.list({ connectionId: connection.id, root })[0];
    if (!latest)
      throw new ReviewError(
        "no review is open for this checkout; run `roamgate-review open`",
        404,
      );
    return latest.session;
  }

  async function rootOf(
    connection: ReviewAgentConnection,
    form: URLSearchParams,
  ): Promise<string> {
    const cwd = form.get("cwd");
    if (!cwd || !cwd.startsWith("/"))
      throw new ReviewError("the client did not send its directory");
    try {
      return await connection.readRoot(cwd);
    } catch (error) {
      throw new ReviewError(
        error instanceof Error ? error.message : "not inside a Git repository",
      );
    }
  }

  /**
   * Who writes. The client always says; the mod's tools leave it out: the
   * review's own agent when it runs in the asking pane, else Claude.
   */
  function agentName(form: URLSearchParams, session?: ReviewSession): string {
    let name = (form.get("agent") ?? "").trim();
    if (!name && form.get("via") === MOD_VIA)
      name =
        session?.agent.name && session.agent.paneId === form.get("pane")
          ? session.agent.name
          : "Claude";
    name ||= "agent";
    if (name === REVIEW_USER)
      throw new ReviewError(`"${REVIEW_USER}" is the user's name`);
    return name;
  }

  async function handle(
    socketKey: string,
    command: string,
    form: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (command === "skill") return { skill: REVIEW_SKILL };
    const connection = connectionFor(socketKey, form);
    if (command === "permission") {
      // An agent's permission hook: wait for the user's answer from the
      // browser, or none (the terminal asks then).
      const paneId = form.get("pane");
      // Nobody to ask: the terminal must not wait for nothing.
      if (!paneId || args.hasViewers?.() === false) return { answer: null };
      let input: unknown;
      try {
        input = JSON.parse(form.get("input") ?? "null");
      } catch {
        input = form.get("input");
      }
      const seconds = Number(form.get("timeout") ?? 60);
      logger.info("agent permission prompt waiting", {
        connection: connection.id,
        pane: paneId,
        tool: form.get("tool") || "tool",
      });
      const answer = await args.service.prompts.request({
        connectionId: connection.id,
        paneId,
        agent: form.get("agent") || "agent",
        tool: form.get("tool") || "tool",
        input,
        canAlways: form.get("can_always") === "1",
        timeoutMs:
          Math.min(Math.max(Number.isFinite(seconds) ? seconds : 60, 1), 3600) *
          1000,
        signal,
      });
      logger.info("agent permission prompt ended", {
        connection: connection.id,
        pane: paneId,
        answer: answer ?? "none",
      });
      return { answer };
    }
    if (command === "questions") {
      // Claude's AskUserQuestion, from its PreToolUse hook: the answers from
      // the browser, or none (the terminal asks then).
      const paneId = form.get("pane");
      if (!paneId || args.hasViewers?.() === false) return { answers: null };
      const questions = parseQuestions(form.get("questions"));
      if (!questions.length) return { answers: null };
      const seconds = Number(form.get("timeout") ?? 180);
      logger.info("agent questions waiting", {
        connection: connection.id,
        pane: paneId,
        questions: questions.length,
      });
      const answer = await args.service.prompts.request({
        connectionId: connection.id,
        paneId,
        agent: form.get("agent") || "agent",
        tool: "AskUserQuestion",
        input: { question: questions[0]!.question },
        canAlways: false,
        questions,
        timeoutMs:
          Math.min(
            Math.max(Number.isFinite(seconds) ? seconds : 180, 1),
            3600,
          ) * 1000,
        signal,
      });
      logger.info("agent questions ended", {
        connection: connection.id,
        pane: paneId,
        answered: !!answer,
      });
      return {
        answers: answer && typeof answer === "object" ? answer.answers : null,
        // Put away unanswered: the hook denies the tool, saying so.
        ...(answer === "dismiss" ? { dismissed: true } : {}),
      };
    }
    if (
      command === "hold" ||
      command === "handback" ||
      command === "hold_output" ||
      command === "fg"
    ) {
      const paneId = form.get("pane");
      const sessionId = form.get("session") ?? "";
      if (!paneId)
        throw new ReviewError("roamgate-hold runs inside a Herdr pane");
      if (!args.holder)
        throw new ReviewError("conversation mode is unavailable", 503);
      if (command === "hold_output") {
        const offset = Number(form.get("offset"));
        const end = Number(form.get("end"));
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(end) ||
          offset < 0 ||
          end < offset
        )
          throw new ReviewError("invalid offsets");
        return args.holder.output({
          connectionId: connection.id,
          paneId,
          holderId: form.get("holder_id") ?? "",
          offset,
          end,
          data: form.get("data") ?? "",
        });
      }
      if (command === "fg") {
        const spec = parseSuspendedSpec(form);
        if (!spec) throw new ReviewError("invalid stopped session");
        if (!args.holder.fg)
          return { action: "refused", reason: "fg is unavailable here" };
        return args.holder.fg({
          connectionId: connection.id,
          paneId,
          spec,
          status: parseHolderStatus(form),
          shell: parseHolderShell(form),
        });
      }
      return command === "hold"
        ? args.holder.hold({
            connectionId: connection.id,
            paneId,
            sessionId,
            signal,
            status: parseHolderStatus(form),
            shell: parseHolderShell(form),
          })
        : args.holder.handback({
            connectionId: connection.id,
            paneId,
            sessionId,
          });
    }
    if (
      command === "mod_poll" ||
      command === "mod_ack" ||
      command === "mod_event" ||
      command === "mod_tools"
    )
      return claudeModRequest(connection.id, command, form, signal);
    if (command === "waiting") return waiting(connection.id, form);
    if (command === "launch") {
      const paneId = form.get("pane");
      const token = form.get("token") ?? "";
      if (!paneId)
        throw new ReviewError(
          "roamgate-hold --launch runs inside a Herdr pane",
        );
      if (!/^[0-9a-f]{16,64}$/.test(token))
        throw new ReviewError("invalid launch token");
      const spec = args.launch?.({
        connectionId: connection.id,
        paneId,
        token,
      });
      if (!spec)
        throw new ReviewError("no such start for this pane (it expired?)", 404);
      logger.info("agent launched from a pane", {
        connection: connection.id,
        pane: paneId,
        program: spec.argv[0],
      });
      return spec;
    }
    if (command === "claude_start") {
      const paneId = form.get("pane");
      const sessionId = form.get("session") ?? "";
      if (!paneId)
        throw new ReviewError("claude-start runs inside a Herdr pane");
      if (!/^[0-9a-f-]{8,64}$/i.test(sessionId))
        throw new ReviewError("invalid session id");
      if (!args.claudeStart)
        return {
          action: "terminal",
          reason: "conversation mode is unavailable",
        };
      return args.claudeStart({
        connectionId: connection.id,
        paneId,
        sessionId,
        source: form.get("source") ?? "",
      });
    }
    if (command === "notify") {
      // The agent itself says the user needs to act: no review involved.
      const paneId = form.get("pane");
      const text = (form.get("text") ?? "").trim();
      const title = (form.get("title") ?? "").trim();
      if (!paneId) throw new ReviewError("notify runs inside a Herdr pane");
      if (!text) throw new ReviewError("say what the user needs to do");
      if (text.length > 2000 || title.length > 200)
        throw new ReviewError("keep it short: 2000 characters, title 200");
      if (!args.notify) throw new ReviewError("notifications are unavailable");
      await args.notify({
        connectionId: connection.id,
        paneId,
        agent: agentName(form),
        ...(title ? { title } : {}),
        text,
      });
      logger.info("agent notified the user", {
        connection: connection.id,
        pane: paneId,
      });
      return { notified: true };
    }
    if (command === "reviews") {
      if (!args.reviews)
        throw new ReviewError("the Reviews board is unavailable", 503);
      const tool = (form.get("tool") ?? "").trim();
      if (!tool) throw new ReviewError("tool is required");
      let params: unknown = {};
      const raw = form.get("params");
      if (raw?.trim()) {
        try {
          params = JSON.parse(raw);
        } catch {
          throw new ReviewError("params must be a JSON object");
        }
      }
      if (!params || typeof params !== "object" || Array.isArray(params))
        throw new ReviewError("params must be a JSON object");
      try {
        const text = await args.reviews({
          connectionId: connection.id,
          paneId: form.get("pane") ?? "",
          workspaceId: form.get("workspace") ?? "",
          agent: (form.get("agent") ?? "").trim(),
          tool,
          params,
        });
        // JSON answers come back as JSON (after the line saying what
        // in them other people wrote, when there is one).
        const at = text.startsWith("{") ? 0 : text.indexOf("\n") + 1;
        try {
          return {
            tool,
            ...(at ? { note: text.slice(0, at - 1) } : {}),
            result: JSON.parse(text.slice(at)),
          };
        } catch {
          return { tool, result: text };
        }
      } catch (error) {
        if (error instanceof ReviewError) throw error;
        const status =
          (error as { code?: string }).code === "not_found" ? 404 : 400;
        throw new ReviewError(
          error instanceof Error ? error.message : String(error),
          status,
        );
      }
    }
    if (command === "sessions" || command === "message") {
      if (!args.messages)
        throw new ReviewError("messaging other sessions is unavailable", 503);
      const paneId = form.get("pane") ?? "";
      try {
        if (command === "sessions") {
          const self = paneId ? agentAddress(connection.id, paneId) : null;
          return {
            sessions: (await args.messages.list()).map((session) =>
              session.address === self
                ? { ...session, self: true as const }
                : session,
            ),
          };
        }
        if (!paneId)
          throw new ReviewError(
            "message runs inside an agent session's pane: a reply needs your address",
          );
        return await args.messages.send({
          from: { connectionId: connection.id, paneId },
          to: form.get("to") ?? "",
          text: form.get("text") ?? "",
        });
      } catch (error) {
        if (error instanceof AgentMessageError)
          throw new ReviewError(error.message, error.status);
        throw error;
      }
    }
    if (
      command === "place" ||
      command === "worktree" ||
      command === "workspace" ||
      command === "groups"
    ) {
      const paneId = form.get("pane") ?? "";
      if (!paneId && command !== "groups")
        throw new ReviewError(`${command} runs inside a Herdr pane`);
      if (!args.workspaces)
        throw new ReviewError("workspace placement is unavailable");
      const params: Record<string, string> = {};
      for (const key of [
        "workspace_id",
        "path",
        "branch",
        "repo",
        "base",
        "label",
        "dir",
        "cwd",
        "group",
        "create_group",
      ]) {
        const value = form.get(key);
        if (value) params[key] = value.slice(0, 4096);
      }
      return args.workspaces({
        connectionId: connection.id,
        paneId,
        workspaceId: form.get("workspace") ?? "",
        command,
        params,
      });
    }
    let agent = agentName(form);
    const pane = form.get("pane") || undefined;
    const text = form.get("text") ?? undefined;
    const comment = form.get("comment") ?? undefined;
    const message = form.get("message") || undefined;
    if (command === "open") {
      // --repo PATH or PATH=BASE..HEAD, repeatable: the other repositories
      // worked on from here, each reviewed in the same workspace, against
      // its default branch unless a range is given.
      const repoEntries = (form.get("repo") ?? "")
        .split("\n")
        .filter((entry) => entry.startsWith("/"))
        .map((entry) => {
          const at = entry.lastIndexOf("=");
          const range = at > 0 ? entry.slice(at + 1) : "";
          return range.includes("..")
            ? { path: entry.slice(0, at), range }
            : { path: entry, range: "" };
        });
      let root: string;
      try {
        root = await rootOf(connection, form);
      } catch (error) {
        if (!repoEntries.length) throw error;
        root = await rootOf(
          connection,
          new URLSearchParams({ cwd: repoEntries[0]!.path }),
        );
      }
      const target = await parseTargetFlags(form, () =>
        connection.readDefaultBase(root),
      );
      const workspaceId = form.get("workspace") || undefined;
      const opened = args.service.open({
        connectionId: connection.id,
        root,
        target,
        title: form.get("title") || undefined,
        workspaceId,
        paneId: pane,
        agent,
        message,
      });
      const repos = [{ root, session: opened.session.id }];
      for (const entry of repoEntries) {
        const other = await rootOf(
          connection,
          new URLSearchParams({ cwd: entry.path }),
        );
        if (repos.some((repo) => repo.root === other)) continue;
        const extra = args.service.open({
          connectionId: connection.id,
          root: other,
          target: await parseTargetFlags(
            new URLSearchParams(entry.range ? { range: entry.range } : {}),
            () => connection.readDefaultBase(other),
          ),
          workspaceId,
          paneId: pane,
          agent,
          raise: false,
        });
        repos.push({ root: other, session: extra.session.id });
      }
      // A merge request's review: refused when it is confidential, or
      // GitLab cannot tell.
      await args.service.assertAgentAllowed({
        sessionId: opened.session.id,
        author: agent,
      });
      return {
        session: sessionOutput(opened.session),
        // A security merge request's discussions are not shared with agents.
        threads: opened.mergeRequest?.security
          ? []
          : opened.threads.map(threadOutput),
        ...(repos.length > 1 ? { repos } : {}),
      };
    }
    if (command === "list") {
      const root = await rootOf(connection, form);
      return args.service
        .list({ connectionId: connection.id, root })
        .filter(({ session }) =>
          args.service.agentMayRead({ sessionId: session.id }),
        )
        .map(({ session, threads }) => ({
          ...sessionOutput(session),
          threads: threads.length,
        }));
    }
    const session = await sessionFor(connection, form);
    const sessionId = session.id;
    agent = agentName(form, session);
    if (session.gitlab && (command === "get" || command === "comments"))
      await args.service.refreshGitlab({ sessionId });
    await args.service.assertAgentAllowed({ sessionId, author: agent });
    switch (command) {
      case "get":
      case "comments": {
        const snapshot = args.service.get({ sessionId });
        return {
          session: sessionOutput(snapshot.session),
          threads: snapshot.threads.map(threadOutput),
        };
      }
      case "add": {
        const line = intParam(form.get("line"), "line");
        return threadOutput(
          await args.service.addThread({
            sessionId,
            kind:
              form.get("draft") === "1" || form.get("kind") === "draft"
                ? "draft"
                : "discussion",
            author: agent,
            text,
            anchor: {
              path: form.get("file") || undefined,
              line,
              endLine: intParam(form.get("end_line"), "end line"),
              side: form.get("side") || undefined,
            },
          }),
        );
      }
      case "reply":
        return threadOutput(
          await args.service.reply({
            sessionId,
            commentId: comment,
            author: agent,
            text,
          }),
        );
      case "edit":
        return threadOutput(
          await args.service.edit({
            sessionId,
            commentId: comment,
            author: agent,
            text,
          }),
        );
      case "delete": {
        const result = await args.service.deleteComment({
          sessionId,
          commentId: comment,
          author: agent,
        });
        return { deleted: result.deleted };
      }
      case "resolve":
      case "reopen":
        return threadOutput(
          args.service.resolve({
            sessionId,
            commentId: comment,
            resolved: command === "resolve" && form.get("unresolve") !== "1",
          }),
        );
      case "watch": {
        const timeout = intParam(form.get("timeout"), "timeout") ?? 1800;
        const active = watches.get(sessionId) ?? 0;
        if (active >= REVIEW_AGENT_MAX_WATCHES)
          throw new ReviewError(
            "too many agents are watching this review",
            429,
          );
        watches.set(sessionId, active + 1);
        let result: Awaited<ReturnType<ReviewService["watch"]>>;
        try {
          result = await args.service.watch(
            {
              sessionId,
              agent,
              mode: form.get("mode") === "any" ? "any" : "unanswered",
              timeoutMs: timeout * 1000,
            },
            signal,
          );
        } finally {
          const left = (watches.get(sessionId) ?? 1) - 1;
          if (left > 0) watches.set(sessionId, left);
          else watches.delete(sessionId);
        }
        // Threads may come from the workspace's other repositories.
        const roots = new Map<string, string>();
        const repoOf = (sessionId: string) => {
          if (!roots.has(sessionId))
            roots.set(sessionId, args.service.get({ sessionId }).session.root);
          return roots.get(sessionId)!;
        };
        return {
          outcome: result.outcome,
          session: result.session ? sessionOutput(result.session) : null,
          ...(result.summary ? { overall_comment: result.summary } : {}),
          threads: result.threads.map((thread) => ({
            ...threadOutput(thread),
            repo: repoOf(thread.sessionId),
          })),
        };
      }
      case "summary":
        return args.service.agentSummary({ sessionId, author: agent, text });
      case "working":
        return sessionOutput(
          args.service.agentStatus({
            sessionId,
            agent,
            paneId: pane,
            state: form.get("done") === "1" ? "done" : "working",
            commentId: comment || undefined,
            message,
          }).session,
        );
      case "update":
        return sessionOutput(
          args.service.agentStatus({
            sessionId,
            agent,
            paneId: pane,
            state: "update",
            message,
          }).session,
        );
      default:
        throw new ReviewError(`unknown command: ${command}`, 404);
    }
  }

  /**
   * The threads waiting for the asking session's answer (`/threads`): in
   * the reviews and chats whose agent runs in its pane or is its session.
   */
  function waiting(connectionId: string, form: URLSearchParams) {
    const paneId = form.get("pane") ?? "";
    const claude = form.get("claude_session") ?? "";
    if (!paneId && !claude)
      throw new ReviewError("waiting runs inside an agent session");
    const reviews = args.service
      .list({ connectionId, chats: true })
      .filter(({ session }) => {
        const agentSession =
          session.target.kind === "chat"
            ? session.target.chat
            : session.agent.sessionId;
        return (
          ((paneId && session.agent.paneId === paneId) ||
            (claude && agentSession === claude)) &&
          args.service.agentMayRead({ sessionId: session.id })
        );
      })
      .map(({ session, threads }) => ({
        session: sessionOutput(session),
        threads: threads
          .filter((thread) =>
            threadNeedsAnswer(thread, session.agent.name ?? "agent", {
              suggestions: !session.gitlab,
            }),
          )
          .map(threadOutput),
      }))
      .filter((review) => review.threads.length > 0);
    return { reviews };
  }

  /** A request of the Claude mod running in one of the connection's panes. */
  async function claudeModRequest(
    connectionId: string,
    command: "mod_poll" | "mod_ack" | "mod_event" | "mod_tools",
    form: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown> {
    const paneId = form.get("pane");
    if (!paneId)
      throw new ReviewError("the Claude mod runs inside a Herdr pane");
    if (!args.claudeMod)
      throw new ReviewError("the Claude mod is unavailable", 503);
    const session = form.get("session") ?? "";
    const sessionId = /^[0-9a-f-]{8,64}$/i.test(session) ? session : "";
    const client = (form.get("client") ?? "").slice(0, 64);
    try {
      if (command === "mod_tools")
        return args.claudeMod.tools({
          connectionId,
          paneId,
          sessionId,
          client,
          headless: form.get("headless") === "1",
          gone: form.get("gone") === "1",
        });
      if (command === "mod_poll")
        return await args.claudeMod.poll({
          connectionId,
          paneId,
          sessionId,
          client,
          claude: form.get("claude") ?? "",
          protocol: Number(form.get("protocol")),
          after: Number(form.get("after") ?? 0),
          waitMs: Number(form.get("wait_ms") ?? 0),
          signal,
        });
      if (command === "mod_ack")
        return args.claudeMod.ack({
          connectionId,
          paneId,
          client,
          id: Number(form.get("id")),
          outcome: form.get("outcome") ?? "",
          reason: form.get("reason") ?? "",
        });
      let event: unknown;
      try {
        event = JSON.parse(form.get("event") ?? "");
      } catch {
        throw new ReviewError("invalid event");
      }
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new ReviewError("invalid event");
      return args.claudeMod.event({
        connectionId,
        paneId,
        client,
        sessionId,
        event: event as Record<string, unknown>,
      });
    } catch (error) {
      if (error instanceof ClaudeModError)
        throw new ReviewError(error.message, error.status);
      throw error;
    }
  }

  function listen(socketKey: string): string {
    const existing = servers.get(socketKey);
    if (existing) return existing.path;
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(socketDirectory, 0o700);
    const path = socketPathFor(socketKey);
    rmSync(path, { force: true });
    const server = Bun.serve({
      unix: path,
      maxRequestBodySize: HOLD_OUTPUT_MAX_BODY_BYTES,
      fetch: async (request, server) => {
        // Watches are long polls; the client sets its own deadline.
        server.timeout(request, 0);
        const url = new URL(request.url);
        const command = url.pathname.replace(/^\/v1\//, "");
        if (request.method !== "POST" || command === url.pathname)
          return json({ error: "not found" }, 404);
        // Only a holder's log is larger than an agent's request.
        const limit =
          command === "hold_output"
            ? HOLD_OUTPUT_MAX_BODY_BYTES
            : REVIEW_AGENT_MAX_BODY_BYTES;
        if (Number(request.headers.get("content-length") ?? 0) > limit)
          return json({ error: "request too large" }, 413);
        try {
          const body = await request.text();
          if (Buffer.byteLength(body) > limit)
            return json({ error: "request too large" }, 413);
          const form = formOf(body);
          return json(await handle(socketKey, command, form, request.signal));
        } catch (error) {
          const status = error instanceof ReviewError ? error.status : 500;
          if (status === 500)
            logger.warn("review agent request failed", {
              command,
              error: error instanceof Error ? error.message : String(error),
            });
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            status,
          );
        }
      },
    });
    chmodSync(path, 0o600);
    servers.set(socketKey, { path, server });
    return path;
  }

  /** Links `link` to `target` when its directory exists and it is free. */
  function linkIfFree(target: string, link: string): void {
    try {
      if (!statSync(dirname(link)).isDirectory()) return;
      try {
        if (!lstatSync(link).isSymbolicLink()) return;
        if (readlinkSync(link) === target) return;
        // A link to an old install of ours is replaced; others are kept.
        if (!readlinkSync(link).includes(REVIEW_HOME_DIR)) return;
        rmSync(link, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
      symlinkSync(target, link);
    } catch (error) {
      logger.warn("review link not made", {
        link,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Installs the client and points the well-known socket path here. */
  function installLocal(): void {
    const path = listen(LOCAL_SOCKET_KEY);
    const base = join(home, REVIEW_HOME_DIR);
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    const client = join(bin, "roamgate-review");
    const temp = `${client}.${process.pid}.tmp`;
    writeFileSync(temp, REVIEW_CLIENT_INSTALLED_SCRIPT, { mode: 0o755 });
    renameSync(temp, client);
    // Conversation mode's pane holder, beside it.
    const holder = join(bin, "roamgate-hold");
    const holderTemp = `${holder}.${process.pid}.tmp`;
    writeFileSync(holderTemp, HOLD_CLIENT_INSTALLED_SCRIPT, { mode: 0o755 });
    renameSync(holderTemp, holder);
    const skillDirectory = join(base, "skills", "roamgate-review");
    mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(skillDirectory, "SKILL.md"), REVIEW_SKILL, {
      mode: 0o644,
    });
    // Where agents find them without being told: Claude Code's skills and
    // the PATH. Only where those exist, and never over the user's own.
    linkIfFree(
      skillDirectory,
      join(home, ".claude", "skills", "roamgate-review"),
    );
    // Codex reads ~/.codex/skills/<name>/SKILL.md the same way.
    linkIfFree(
      skillDirectory,
      join(home, ".codex", "skills", "roamgate-review"),
    );
    linkIfFree(client, join(home, ".local", "bin", "roamgate-review"));
    // The Claude mod's marketplace: installed only if the user asks.
    try {
      writeClaudeModPlugin(home);
    } catch (error) {
      logger.warn("claude mod files not written", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const link = join(base, "review.sock");
    let current: string | null = null;
    try {
      if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
    } catch {}
    if (current !== path) {
      // Replaced in one step: a client never finds the link missing.
      const next = `${link}.${process.pid}.tmp`;
      rmSync(next, { force: true });
      symlinkSync(path, next);
      renameSync(next, link);
    }
    linked = link;
  }

  /** The well-known link, when it still points at this bridge. */
  let linked: string | null = null;
  function unlinkIfOurs() {
    if (!linked) return;
    try {
      if (readlinkSync(linked) === socketPathFor(LOCAL_SOCKET_KEY))
        rmSync(linked, { force: true });
    } catch {}
    linked = null;
  }

  function stop(socketKey?: string) {
    if (socketKey === undefined || socketKey === LOCAL_SOCKET_KEY)
      unlinkIfOurs();
    for (const [key, entry] of servers) {
      if (socketKey !== undefined && key !== socketKey) continue;
      entry.server.stop(true);
      rmSync(entry.path, { force: true });
      servers.delete(key);
    }
  }

  return {
    listen,
    installLocal,
    stop,
    socketPath: (socketKey: string) => servers.get(socketKey)?.path,
    exists: (socketKey: string) =>
      existsSync(socketPathFor(socketKey)) && servers.has(socketKey),
    directory: dirname(socketPathFor("x")),
  };
}

export type ReviewAgentServer = ReturnType<typeof createReviewAgentServer>;
