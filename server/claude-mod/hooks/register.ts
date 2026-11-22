import type { EngineInterface, Register } from "claude-code";
import {
  createModClient,
  type ModClient,
  type ModCommand,
  type ModUsage,
} from "./client.ts";
import {
  identityBody,
  openedText,
  ROAMGATE_TOOLS,
  type RoamgateTool,
  RULES_SECTION_ID,
  reviewTarget,
  rulesSection,
  stopCheckText,
  type ToolBody,
  type ToolIdentity,
  ToolInputError,
  toolArguments,
  toolRequest,
  toolResultText,
  waitingText,
} from "./tools.ts";

/**
 * Roamgate's Claude Code mod. In a Claude session running in a Herdr pane
 * that Roamgate serves, it takes the messages Roamgate has for the session
 * (review and chat comments, other sessions' messages, companion errands,
 * the usage-limit resume) and submits them as prompts once Claude is idle,
 * instead of Roamgate typing them into the terminal; and it tells Roamgate
 * when turns start and end, when Claude waits on the user, and the model,
 * context and plan usage. That part does nothing in a `claude -p` run, in
 * Roamgate's own headless sessions, outside Herdr, or when Roamgate is not
 * running.
 *
 * In every session it also gives Claude tools to answer review and chat
 * comments and to message other sessions (tools.ts), and the user the
 * commands /rg-review and /threads; they say so when Roamgate is not
 * running.
 * A session in a Herdr pane, or Roamgate's own headless one, tells Roamgate
 * it has the tools, so the comments it gets name them instead of the
 * review client's commands.
 */

/** Waits this long before calling a person's permission ask blocked: a
 * hook beneath may answer it in less. */
const ASK_BLOCKED_AFTER_MS = 2000;

/** How often a session tells Roamgate it still has the tools. */
const TOOLS_HELLO_MS = 4 * 60_000;

/** The live client, for this module instance; none when inert. */
let client: ModClient | null = null;
/** The tools by their full names, and the commands by theirs. */
const served = new Map<string, RoamgateTool>();
const commands = new Map<string, "review" | "threads">();
/** Where the tools' requests go and who they come from. */
let toolsSocket = "";
let toolsHello: { cancel(): void } | null = null;
/** Roamgate's own headless session: its tools outlive the process. */
let headless = false;
/** Says the tools are gone (the session ends); none when not announced. */
let toolsGone: (() => Promise<void>) | null = null;
/** Random per module instance, as the inbox client's. */
const toolsClient = randomId();
/**
 * A session Roamgate delivers to (a Herdr pane's, or Roamgate's headless
 * one): its system prompt holds Roamgate's rules, and its turns end with a
 * check of what it left unanswered.
 */
let rulesWanted = false;
/** The rules went into a system prompt: Roamgate is told, once. */
let rulesComposed = false;
/** Says the hello again at once (the rules are in now). */
let helloNow: (() => Promise<void>) | null = null;
/**
 * Tool calls a permission ask stopped, by id, until they end: their tool,
 * the loop they run in (none on the main one), and whether a person is
 * being asked. An ask auto mode's classifier settles never asks a person.
 */
const asks = new Map<
  string,
  { tool: string; agent: string | undefined; person: boolean }
>();
/** Questions being asked. */
let questions = 0;
let blocked = false;
let blockTimer: { cancel(): void } | null = null;

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function socketPath($: EngineInterface): Promise<string> {
  const configured = await $.env.get("ROAMGATE_REVIEW_SOCKET");
  if (configured) return configured;
  const home = (await $.env.get("HOME")) ?? "";
  return `${home}/.cache/roamgate/review.sock`;
}

/** One request to Roamgate over its socket: the parsed JSON answer. */
async function request(
  $: EngineInterface,
  socket: string,
  command: string,
  body: Record<string, string | number>,
): Promise<unknown> {
  const response = await $.http.fetch(`http://roamgate/v1/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    socketPath: socket,
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(response.text);
  } catch {}
  if (!response.ok) {
    const error =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return parsed;
}

/** Binds the client to the engine: the socket, prompts, timers. */
function hostOf($: EngineInterface, socket: string) {
  return {
    request: (command: ModCommand, body: Record<string, string | number>) =>
      request($, socket, command, body),
    socketExists: () => $.fs.exists(socket),
    async submit(text: string) {
      const result = await $.prompt.submit({ text, asUser: true });
      return result.drop ?? "";
    },
    after: (ms: number, fn: () => void) => $.clock.after(ms, fn),
  };
}

/** Says, in the debug log alone, what the mod does or why not. */
function debug($: EngineInterface, text: string): void {
  void $.ui.log(text, { to: "debug" });
}

/** Starts the client when this session is one Roamgate serves. */
async function start($: EngineInterface): Promise<void> {
  if ((await $.env.get("ROAMGATE_HEADLESS")) === "1")
    return debug($, "inert: Roamgate's own headless session");
  const off = (await $.env.get("ROAMGATE_CLAUDE_MOD")) ?? "";
  if (/^(off|0|no|false)$/i.test(off.trim()))
    return debug($, "inert: ROAMGATE_CLAUDE_MOD is off");
  const pane = await $.env.get("HERDR_PANE_ID");
  if (!pane) return debug($, "inert: not in a Herdr pane");
  // A `claude -p` run in the pane draws nowhere: it is not the pane's.
  const surfaces = await $.session.surfaces();
  if (!surfaces.includes("terminal"))
    return debug($, `inert: no terminal (${surfaces.join(",") || "none"})`);
  const socket = await socketPath($);
  debug($, `pane ${pane}, Roamgate at ${socket}`);
  client?.stop("reload");
  client = createModClient({
    host: hostOf($, socket),
    client: randomId(),
    identity: {
      pane,
      workspace: (await $.env.get("HERDR_WORKSPACE_ID")) ?? "",
      herdr_socket: (await $.env.get("HERDR_SOCKET_PATH")) ?? "",
      session: await $.session.id(),
      cwd: await $.session.cwd(),
      claude: (await $.session.version()).version,
    },
    log: (text) => debug($, text),
  });
  client.start();
  void reportUsage($);
}

/** Who the tools' requests come from: this session, in its pane. */
async function toolIdentity($: EngineInterface): Promise<ToolIdentity> {
  const agent = ((await $.env.get("ROAMGATE_REVIEW_AGENT")) ?? "").trim();
  return {
    pane:
      (await $.env.get("HERDR_PANE_ID")) ||
      (await $.env.get("ROAMGATE_PANE_ID")) ||
      "",
    workspace: (await $.env.get("HERDR_WORKSPACE_ID")) ?? "",
    herdr_socket:
      (await $.env.get("HERDR_SOCKET_PATH")) ||
      (await $.env.get("ROAMGATE_HERDR_SOCKET_PATH")) ||
      "",
    cwd: await $.session.cwd(),
    claude_session: await $.session.id(),
    ...(agent ? { agent } : {}),
  };
}

/** Roamgate's socket is missing: said as is, no prefix. */
class NotRunning extends Error {}

/** A request on the user's or the model's behalf; throws what went wrong. */
async function send(
  $: EngineInterface,
  command: string,
  body: ToolBody,
): Promise<unknown> {
  if (!toolsSocket) toolsSocket = await socketPath($);
  if (!(await $.fs.exists(toolsSocket).catch(() => false)))
    throw new NotRunning(
      `Roamgate is not running here (no review socket at ${toolsSocket}). Tell the user; try again once it runs.`,
    );
  return request($, toolsSocket, command, body);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tool's name as this session calls it (`mcp__roamgate__<name>`). */
function toolName(name: string): string {
  for (const [registered, tool] of served)
    if (tool.name === name) return registered;
  return `mcp__roamgate__${name}`;
}

/** Whether Roamgate delivers to this session: a pane's, or its headless one. */
async function delivered($: EngineInterface): Promise<boolean> {
  if ((await $.env.get("ROAMGATE_HEADLESS")) === "1")
    return !!(await $.env.get("ROAMGATE_PANE_ID"));
  if (!(await $.env.get("HERDR_PANE_ID"))) return false;
  // A script's `claude -p` in a pane is not the pane's session.
  return (await $.session.surfaces()).includes("terminal");
}

/** Registers the tools and the commands; each session has them. */
async function startTools($: EngineInterface): Promise<void> {
  toolsSocket = await socketPath($);
  rulesWanted = await delivered($).catch(() => false);
  served.clear();
  for (const tool of ROAMGATE_TOOLS) {
    try {
      const registered = await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        isDeferred: tool.deferred === true,
      });
      served.set(registered.tool, tool);
    } catch (error) {
      debug($, `tool ${tool.name} not registered: ${messageOf(error)}`);
    }
  }
  commands.clear();
  // /review is Claude Code's own: Roamgate's is /rg-review. A name a
  // later Claude Code takes falls back to the next.
  const wanted = [
    {
      kind: "review" as const,
      names: ["rg-review", "roamgate-open"],
      description:
        "Open Roamgate's review of this branch (or the worktree, BASE..HEAD, compare OLD NEW, a merge request URL)",
      argumentHint: "[worktree | BASE..HEAD | compare OLD NEW | MR URL]",
    },
    {
      kind: "threads" as const,
      names: ["threads", "rg-threads"],
      description:
        "List the Roamgate review and chat threads waiting for this session's answer",
    },
  ];
  for (const command of wanted)
    for (const name of command.names) {
      try {
        const registered = await $.command.register({
          name,
          description: command.description,
          ...(command.argumentHint
            ? { argumentHint: command.argumentHint }
            : {}),
        });
        commands.set(registered.command, command.kind);
        break;
      } catch (error) {
        debug($, `command /${name} not registered: ${messageOf(error)}`);
      }
    }
}

/** Tells Roamgate this pane's session has the tools, now and then. */
async function announceTools($: EngineInterface): Promise<void> {
  headless = (await $.env.get("ROAMGATE_HEADLESS")) === "1";
  const pane =
    (await $.env.get("HERDR_PANE_ID")) ||
    (headless ? await $.env.get("ROAMGATE_PANE_ID") : "");
  if (!pane) return;
  // A script's `claude -p` in a pane is not the pane's session.
  if (!headless && !(await $.session.surfaces()).includes("terminal")) return;
  const hello = async (gone = false) => {
    if (!(await $.fs.exists(toolsSocket).catch(() => false))) return;
    await request($, toolsSocket, "mod_tools", {
      ...identityBody(await toolIdentity($)),
      session: await $.session.id(),
      client: toolsClient,
      tools: ROAMGATE_TOOLS.length,
      // This mod has the Work board's tools: the prompts may name them.
      work: "1",
      // Its system prompt holds the rules: the prompts are short.
      ...(rulesComposed ? { rules: "1" } : {}),
      ...(headless ? { headless: "1" } : {}),
      ...(gone ? { gone: "1" } : {}),
    }).catch((error) => debug($, `tools hello failed: ${messageOf(error)}`));
  };
  toolsHello?.cancel();
  toolsHello = $.clock.every(TOOLS_HELLO_MS, () => void hello());
  toolsGone = () => hello(true);
  helloNow = () => hello();
  await hello();
}

/** A tool call: one request, its JSON answer or the reason it failed. */
async function callTool(
  $: EngineInterface,
  tool: RoamgateTool,
  input: Record<string, unknown>,
) {
  let call: { command: string; body: ToolBody };
  try {
    call = toolRequest(tool, input, await toolIdentity($));
  } catch (error) {
    if (error instanceof ToolInputError)
      return { deny: `${tool.name}: ${error.message}` };
    throw error;
  }
  try {
    return { result: toolResultText(await send($, call.command, call.body)) };
  } catch (error) {
    if (error instanceof NotRunning) return { deny: error.message };
    return { deny: `Roamgate: ${messageOf(error)}` };
  }
}

/** `/rg-review` and `/threads`: a line of text, whatever the surface. */
async function runCommand(
  $: EngineInterface,
  kind: "review" | "threads",
  args: string,
): Promise<string> {
  try {
    const base = identityBody(await toolIdentity($));
    if (kind === "threads") return waitingText(await send($, "waiting", base));
    return openedText(
      await send($, "open", { ...base, ...reviewTarget(args) }),
    );
  } catch (error) {
    // Shown under the plugin's name: "roamgate: ...".
    return messageOf(error);
  }
}

/** The model, context and plan usage, as the status line has them. */
async function usageOf($: EngineInterface): Promise<ModUsage> {
  try {
    const [usage, model] = await Promise.all([
      $.session.usage(),
      $.session.model(),
    ]);
    return {
      model,
      context: {
        tokens: usage.context.tokens,
        window: usage.context.window,
        percent: usage.context.percent,
      },
      rate_limits: usage.rateLimits.map((each) => ({
        kind: each.kind,
        percent_used: each.percentUsed,
        ...(each.resetsAt ? { resets_at: each.resetsAt } : {}),
      })),
      ...(usage.cost ? { cost_usd: usage.cost.usd } : {}),
    };
  } catch {
    return {};
  }
}

async function reportUsage($: EngineInterface): Promise<void> {
  const usage = await usageOf($);
  client?.report({ type: "usage", ...usage });
}

function askingPerson(): boolean {
  for (const ask of asks.values()) if (ask.person) return true;
  return false;
}

/** Says blocked or unblocked when that changed. */
function settleBlocked($: EngineInterface): void {
  const now = askingPerson() || questions > 0;
  if (!now) {
    blockTimer?.cancel();
    blockTimer = null;
    if (blocked) {
      blocked = false;
      client?.report({ type: "unblocked" });
    }
    return;
  }
  if (blocked) return;
  if (questions > 0) {
    blocked = true;
    client?.report({ type: "blocked" });
    return;
  }
  // A permission ask: blocked once it has waited a little.
  if (blockTimer) return;
  blockTimer = $.clock.after(ASK_BLOCKED_AFTER_MS, () => {
    blockTimer = null;
    if (blocked || (!askingPerson() && questions === 0)) return;
    blocked = true;
    client?.report({ type: "blocked" });
  });
}

/**
 * The end-of-turn check: what Roamgate delivered to this session that it
 * left (unanswered threads, items still to triage), as the reason to go
 * on; null when nothing waits or Roamgate cannot tell.
 */
async function stopReminder($: EngineInterface): Promise<string | null> {
  if (!(await $.fs.exists(toolsSocket).catch(() => false))) return null;
  try {
    const answer = await request(
      $,
      toolsSocket,
      "stop_check",
      identityBody(await toolIdentity($)),
    );
    return stopCheckText(answer, toolName);
  } catch (error) {
    debug($, `stop check failed: ${messageOf(error)}`);
    return null;
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    // Before the session goes on: listed from the first prompt.
    try {
      await startTools($);
    } catch (error) {
      debug($, `tools not registered: ${String(error)}`);
    }
    const started = await next(e);
    try {
      await start($);
    } catch (error) {
      client = null;
      debug($, `not started: ${String(error)}`);
    }
    void announceTools($).catch((error) =>
      debug($, `tools not announced: ${String(error)}`),
    );
    return started;
  });

  on("session.end", async ($, e, next) => {
    // /clear and /resume keep this process: the session id changes.
    if (e.reason !== "clear" && e.reason !== "resume") {
      client?.stop(e.reason);
      toolsHello?.cancel();
      toolsHello = null;
      // Roamgate starts its headless session again with the same tools.
      if (!headless) await toolsGone?.();
      toolsGone = null;
    }
    return next(e);
  });

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    if (!rulesWanted) return composed;
    if (!rulesComposed) {
      rulesComposed = true;
      void helloNow?.();
    }
    return {
      sections: [
        ...composed.sections.filter(
          (section) => section.id !== RULES_SECTION_ID,
        ),
        {
          id: RULES_SECTION_ID,
          text: rulesSection(toolName),
          scope: "session",
        },
      ],
    };
  }).catch(($, e, next) => next(e));

  on("classic.Stop", async ($, e, next) => {
    const decided = await next(e);
    // Once: a turn this check already sent on ends as it is.
    if (!rulesWanted || e.stop_hook_active || decided.block) return decided;
    const reminder = await stopReminder($);
    return reminder ? { ...decided, block: reminder } : decided;
  }).catch(($, e, next) => next(e));

  on("command.run", async ($, e, next) => {
    const kind = commands.get(e.command);
    if (!kind) return next(e);
    return { text: await runCommand($, kind, e.args) };
  }).catch(($, e, next) =>
    next.called || !commands.has(e.command)
      ? next(e)
      : { text: "Roamgate: the command failed; try again." },
  );

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined && client) {
      client.setSession(await $.session.id());
      client.report({ type: "turn_start" });
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined && client) {
      // Every call of the main loop has ended; a background subagent's
      // ask may still wait on the person.
      for (const [id, ask] of asks)
        if (ask.agent === undefined) asks.delete(id);
      settleBlocked($);
      // With the usage after it, so Roamgate learns both at once.
      const usage = await usageOf($);
      client?.report({
        type: "turn_complete",
        reason: e.reason,
        aborted: e.isAborted,
        ...usage,
      });
      // Not awaited: a held message's submit waits for the next turn.
      client?.turnComplete();
    }
    return next(e);
  });

  on("tool.check", async ($, e, next) => {
    const decided = await next(e);
    // Not blocked yet: auto mode's classifier settles most asks alone.
    if (client && decided.decision === "ask" && e.tool_use_id)
      asks.set(e.tool_use_id, {
        tool: e.tool,
        agent: e.agentId,
        person: false,
      });
    return decided;
  }).catch(($, e, next) => next(e));

  on("classic.PermissionRequest", async ($, e, next) => {
    // A person is asked: the oldest such ask of this loop is theirs.
    let asked: { person: boolean } | undefined;
    for (const ask of asks.values())
      if (!ask.person && ask.tool === e.tool_name && ask.agent === e.agent_id) {
        asked = ask;
        break;
      }
    if (!asked) return next(e);
    asked.person = true;
    settleBlocked($);
    try {
      const answered = await next(e);
      // A hook beneath answered for the person (Roamgate's own, from
      // afar): the tool runs, or not, without the dialog.
      if (answered.decision) asked.person = false;
      return answered;
    } catch (error) {
      asked.person = false;
      throw error;
    } finally {
      settleBlocked($);
    }
  }).catch(($, e, next) => next(e));

  on("tool.call", async ($, e, next) => {
    // Roamgate's own tools: answered here, one request each.
    const tool = served.get(e.tool);
    if (tool) return callTool($, tool, toolArguments(e));
    const question = client !== null && e.tool === "AskUserQuestion";
    if (question) {
      questions += 1;
      settleBlocked($);
    }
    try {
      return await next(e);
    } finally {
      if (question) questions = Math.max(0, questions - 1);
      // Ran, refused or aborted: whatever its ask was, it is over.
      if (e.tool_use_id) asks.delete(e.tool_use_id);
      if (client) settleBlocked($);
    }
  }).catch(($, e, next) =>
    next.called || !served.has(e.tool)
      ? next(e)
      : { deny: "Roamgate's tool failed; try again, or use roamgate-review" },
  );
};
