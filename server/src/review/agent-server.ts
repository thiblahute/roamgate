import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
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
} from "../../../shared/review";
import { type Logger, silentLogger } from "../utils/logger";
import { REVIEW_CLIENT_CHECKSUM, REVIEW_CLIENT_SCRIPT } from "./agent-client";
import { REVIEW_SKILL } from "./agent-skill";
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

type Server = { stop: (closeActiveConnections?: boolean) => void };

function intParam(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new ReviewError(`invalid ${field}`);
  return parsed;
}

function locationOf(anchor: ReviewAnchor): string {
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
          },
        }
      : {}),
    // On a part of an earlier message: which one, and the words quoted.
    ...(thread.anchor.message
      ? {
          on_message: {
            thread: thread.anchor.message.thread,
            comment: thread.anchor.message.comment,
            quote: thread.anchor.message.quote,
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
    const match = /^([^.\s]+?)\.\.([^.\s]+)$/.exec(compare);
    if (!match) throw new ReviewError("--compare takes OLD NEW");
    return { kind: "range", base: match[1]!, head: match[2]!, compare: true };
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
function parseQuestions(raw: string | null): AgentQuestion[] {
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
}) {
  const logger = args.logger ?? silentLogger;
  const home = args.home ?? homedir();
  const socketDirectory = join(args.directory, "agent");
  const servers = new Map<string, { path: string; server: Server }>();

  function socketPathFor(key: string): string {
    // Unix socket paths are short (104 bytes on macOS); hash the key.
    const name = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return join(socketDirectory, `${name}.sock`);
  }

  function connectionFor(
    socketKey: string,
    form: URLSearchParams,
  ): ReviewAgentConnection {
    const all = args.connections();
    if (socketKey !== "local") {
      const found = all.find((connection) => connection.id === socketKey);
      if (!found) throw new ReviewError("this connection is not ready", 503);
      return found;
    }
    const local = all.filter((connection) => !connection.sshHost);
    const herdrSocket = form.get("herdr_socket");
    const match = herdrSocket
      ? local.find((connection) => connection.herdrSocketPath === herdrSocket)
      : undefined;
    if (match) return match;
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

  function agentName(form: URLSearchParams): string {
    const name = (form.get("agent") ?? "").trim() || "agent";
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
      };
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
    const agent = agentName(form);
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
        .map(({ session, threads }) => ({
          ...sessionOutput(session),
          threads: threads.length,
        }));
    }
    const session = await sessionFor(connection, form);
    const sessionId = session.id;
    if (session.gitlab && (command === "get" || command === "comments"))
      await args.service.refreshGitlab({ sessionId });
    args.service.assertAgentAllowed({ sessionId, author: agent });
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
        const result = await args.service.watch(
          {
            sessionId,
            agent,
            mode: form.get("mode") === "any" ? "any" : "unanswered",
            timeoutMs: timeout * 1000,
          },
          signal,
        );
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

  function listen(socketKey: string): string {
    const existing = servers.get(socketKey);
    if (existing) return existing.path;
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(socketDirectory, 0o700);
    const path = socketPathFor(socketKey);
    rmSync(path, { force: true });
    const server = Bun.serve({
      unix: path,
      fetch: async (request, server) => {
        // Watches are long polls; the client sets its own deadline.
        server.timeout(request, 0);
        const url = new URL(request.url);
        const command = url.pathname.replace(/^\/v1\//, "");
        if (request.method !== "POST" || command === url.pathname)
          return json({ error: "not found" }, 404);
        try {
          const form = formOf(await request.text());
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
    const path = listen("local");
    const base = join(home, REVIEW_HOME_DIR);
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    const client = join(bin, "roamgate-review");
    const temp = `${client}.${process.pid}.tmp`;
    writeFileSync(temp, REVIEW_CLIENT_INSTALLED_SCRIPT, { mode: 0o755 });
    renameSync(temp, client);
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
    linkIfFree(client, join(home, ".local", "bin", "roamgate-review"));
    const link = join(base, "review.sock");
    let current: string | null = null;
    try {
      if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
    } catch {}
    if (current !== path) {
      rmSync(link, { force: true });
      symlinkSync(path, link);
    }
  }

  function stop(socketKey?: string) {
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
