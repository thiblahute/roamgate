import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Roamgate's side of its Claude Code mod (server/claude-mod): the inbox of
 * each pane whose Claude runs the mod, and what the mod says of the
 * session.
 *
 * The mod long-polls `mod_poll` on the review socket and gets every
 * message for its pane it has not acknowledged, oldest first; it submits
 * each as a prompt once Claude is idle and acknowledges it (`mod_ack`)
 * once its turn started. A message leaves the inbox only then, so a mod
 * that restarts gets again what it had not submitted. The inbox is kept in
 * a file: a Roamgate restart loses nothing a busy session had not taken.
 *
 * A pane's mod is live while it polls. Delivery goes to the mod only then;
 * everything else is typed as before. Messages left when a mod goes away
 * are typed through Herdr once the pane's agent is idle, unless a mod comes
 * back first.
 *
 * The mod also reports turns, waits on the user, the model and usage
 * (`mod_event`): Roamgate lays that over Herdr's screen-detected status.
 *
 * A session with the mod's tools says so (`mod_tools`, every few minutes,
 * in conversation mode's headless claude too): what Roamgate sends that
 * pane then names the tools instead of the review client's commands.
 */

export const CLAUDE_MOD_PROTOCOL = 1;

export type ClaudeModStatus = "idle" | "working" | "blocked";

export type ClaudeModUsage = {
  model?: string;
  context?: { tokens?: number; window?: number; percent?: number };
  rate_limits?: { kind: string; percent_used: number; resets_at?: string }[];
  cost_usd?: number;
  at: string;
};

/** What a live mod says of its pane. */
export type ClaudeModPane = {
  connection_id: string;
  pane_id: string;
  session_id: string;
  /** Claude Code's version. */
  claude: string;
  protocol: number;
  status: ClaudeModStatus;
  /** How the last turn ended: answer, aborted, refusal or error. */
  turn_reason?: string;
  usage?: ClaudeModUsage;
  /** Messages waiting for it; held: those a stop holds. */
  waiting: number;
  held: number;
  since: string;
  updated_at: string;
};

type Item = {
  id: number;
  connectionId: string;
  paneId: string;
  text: string;
  /** Who it is from, for the logs: review, message, companion, ... */
  kind: string;
  queuedAt: number;
  held?: boolean;
};

type Attachment = {
  client: string;
  sessionId: string;
  claude: string;
  protocol: number;
  /** Polls in flight; live while one is. */
  polls: number;
  lastSeen: number;
  since: number;
  status: ClaudeModStatus;
  turnReason?: string;
  usage?: ClaudeModUsage;
  updatedAt: number;
  /** Clients this pane's newer mod replaced. */
  superseded: Set<string>;
  /** It said goodbye: what it left is typed at once. */
  gone?: boolean;
};

/** A pane whose Claude said it has the mod's tools. */
type ToolsSession = {
  sessionId: string;
  client: string;
  seenAt: number;
  /** Conversation mode's: Roamgate starts it again with the same tools. */
  headless: boolean;
  /**
   * Its mod has the Work board's tools (`work_*`): a session started before
   * the mod had them keeps its older mod until it restarts, so the prompts
   * name the review client's `work` command to it instead.
   */
  work: boolean;
  /**
   * Its mod puts Roamgate's rules in the system prompt (a `prompt.compose`
   * section): what is delivered to it is the short form alone.
   */
  rules: boolean;
};

export class ClaudeModError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** What typing an orphaned message did: typed, not yet (busy), or never. */
export type ClaudeModTypeResult = "typed" | "wait" | "gone";

const STORE_VERSION = 1;

function key(connectionId: string, paneId: string): string {
  return `${connectionId}\n${paneId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** The usage a mod reported, kept to the fields Roamgate reads. */
export function parseModUsage(
  event: Record<string, unknown>,
  at: string,
): ClaudeModUsage {
  const usage: ClaudeModUsage = { at };
  if (typeof event.model === "string" && event.model)
    usage.model = event.model.slice(0, 200);
  if (isRecord(event.context)) {
    const context: NonNullable<ClaudeModUsage["context"]> = {};
    const tokens = finite(event.context.tokens);
    const window = finite(event.context.window);
    const percent = finite(event.context.percent);
    if (tokens !== undefined) context.tokens = tokens;
    if (window !== undefined) context.window = window;
    if (percent !== undefined) context.percent = percent;
    usage.context = context;
  }
  if (Array.isArray(event.rate_limits))
    usage.rate_limits = event.rate_limits.slice(0, 8).flatMap((each) => {
      if (!isRecord(each) || typeof each.kind !== "string") return [];
      const used = finite(each.percent_used);
      if (used === undefined) return [];
      return [
        {
          kind: each.kind.slice(0, 40),
          percent_used: used,
          ...(typeof each.resets_at === "string" &&
          !Number.isNaN(Date.parse(each.resets_at))
            ? { resets_at: each.resets_at }
            : {}),
        },
      ];
    });
  const cost = finite(event.cost_usd);
  if (cost !== undefined) usage.cost_usd = cost;
  return usage;
}

export function createClaudeModHub(args: {
  /** Where the inbox is kept; null keeps it in memory. */
  file?: string | null;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Each event a mod reports (debug level). */
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Types a message whose mod went away, as Roamgate types for a session
   * without one: through Herdr, once the pane's agent is idle.
   */
  type?: (
    connectionId: string,
    paneId: string,
    text: string,
  ) => Promise<ClaudeModTypeResult>;
  /** A pane's mod came, went, or said something new. */
  onChange?: (
    connectionId: string,
    paneId: string,
    change: "attach" | "detach" | "status" | "usage" | "turn_complete",
  ) => void;
  /** Longest hold of a poll (the mod's fetch gives up at 30 s). */
  maxHoldMs?: number;
  /** A mod is live this long after its last poll ended. */
  liveMs?: number;
  /** Its messages are typed instead after this long without a poll. */
  orphanMs?: number;
  /** How often orphaned messages are tried. */
  sweepMs?: number;
  /** How long an orphaned message may wait for an idle agent. */
  orphanLimitMs?: number;
  /** Messages older than this are dropped (a day). */
  maxAgeMs?: number;
  /** Messages a pane's inbox may hold. */
  maxPerPane?: number;
  /** A terminal session has the tools this long after it last said so. */
  toolsLiveMs?: number;
  /** A headless one, stopped when idle and started again: this long. */
  toolsHeadlessMs?: number;
}) {
  const now = args.now ?? Date.now;
  const log = args.log ?? (() => {});
  const maxHoldMs = args.maxHoldMs ?? 25_000;
  const liveMs = args.liveMs ?? 45_000;
  const orphanMs = args.orphanMs ?? 90_000;
  const sweepMs = args.sweepMs ?? 5_000;
  const orphanLimitMs = args.orphanLimitMs ?? 30 * 60_000;
  const maxAgeMs = args.maxAgeMs ?? 24 * 60 * 60_000;
  const maxPerPane = args.maxPerPane ?? 50;
  const toolsLiveMs = args.toolsLiveMs ?? 10 * 60_000;
  const toolsHeadlessMs = args.toolsHeadlessMs ?? 7 * 24 * 60 * 60_000;
  const startedAt = now();

  let epoch = randomBytes(8).toString("hex");
  let nextId = 1;
  const items: Item[] = [];
  const attachments = new Map<string, Attachment>();
  const toolSessions = new Map<string, ToolsSession>();
  /** Polls waiting for a message, by pane. */
  const waiters = new Map<string, Set<() => void>>();
  /** Panes whose orphaned messages are being typed now. */
  const typing = new Set<string>();
  let disposed = false;

  load();

  function load() {
    if (!args.file) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(args.file, "utf8"));
    } catch {
      return;
    }
    if (!isRecord(raw) || raw.version !== STORE_VERSION) return;
    if (typeof raw.epoch === "string" && raw.epoch) epoch = raw.epoch;
    const stored = Array.isArray(raw.items) ? raw.items : [];
    const oldest = now() - maxAgeMs;
    for (const each of stored) {
      if (
        !isRecord(each) ||
        typeof each.id !== "number" ||
        typeof each.connection_id !== "string" ||
        typeof each.pane_id !== "string" ||
        typeof each.text !== "string" ||
        typeof each.queued_at !== "number" ||
        each.queued_at < oldest
      )
        continue;
      items.push({
        id: each.id,
        connectionId: each.connection_id,
        paneId: each.pane_id,
        text: each.text,
        kind: typeof each.kind === "string" ? each.kind : "",
        queuedAt: each.queued_at,
      });
    }
    items.sort((a, b) => a.id - b.id);
    for (const each of Array.isArray(raw.tools) ? raw.tools : []) {
      if (
        !isRecord(each) ||
        typeof each.connection_id !== "string" ||
        typeof each.pane_id !== "string" ||
        typeof each.session_id !== "string" ||
        typeof each.client !== "string" ||
        typeof each.seen_at !== "number"
      )
        continue;
      toolSessions.set(key(each.connection_id, each.pane_id), {
        sessionId: each.session_id,
        client: each.client,
        work: each.work === true,
        rules: each.rules === true,
        seenAt: each.seen_at,
        headless: each.headless === true,
      });
    }
    const highest = items.at(-1)?.id ?? 0;
    nextId = Math.max(
      typeof raw.next_id === "number" ? raw.next_id : 1,
      highest + 1,
    );
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function save() {
    if (!args.file || saveTimer || disposed) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeNow();
    }, 100);
    (saveTimer as { unref?: () => void }).unref?.();
  }

  function writeNow() {
    if (!args.file) return;
    const body = JSON.stringify({
      version: STORE_VERSION,
      epoch,
      next_id: nextId,
      items: items.map((each) => ({
        id: each.id,
        connection_id: each.connectionId,
        pane_id: each.paneId,
        text: each.text,
        kind: each.kind,
        queued_at: each.queuedAt,
      })),
      tools: [...toolSessions]
        .filter(([, each]) => toolsFresh(each))
        .map(([at, each]) => {
          const [connectionId = "", paneId = ""] = at.split("\n");
          return {
            connection_id: connectionId,
            pane_id: paneId,
            session_id: each.sessionId,
            client: each.client,
            seen_at: each.seenAt,
            ...(each.work ? { work: true } : {}),
            ...(each.rules ? { rules: true } : {}),
            headless: each.headless,
          };
        }),
    });
    try {
      mkdirSync(dirname(args.file), { recursive: true, mode: 0o700 });
      const temp = `${args.file}.${process.pid}.tmp`;
      writeFileSync(temp, body, { mode: 0o600 });
      renameSync(temp, args.file);
    } catch (error) {
      log("claude mod inbox not saved", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function paneItems(at: string): Item[] {
    return items.filter((each) => key(each.connectionId, each.paneId) === at);
  }

  function remove(item: Item) {
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
    save();
  }

  function wake(at: string) {
    const waiting = waiters.get(at);
    if (!waiting) return;
    waiters.delete(at);
    for (const resolve of waiting) resolve();
  }

  function toolsFresh(entry: ToolsSession): boolean {
    return (
      now() - entry.seenAt < (entry.headless ? toolsHeadlessMs : toolsLiveMs)
    );
  }

  /**
   * A session says it has the mod's tools (`mod_tools`), or no longer
   * (`gone`, its claude exits). Kept in the inbox's file: conversation
   * mode's claude is stopped when idle and started again with them.
   */
  function tools(input: {
    connectionId: string;
    paneId: string;
    sessionId: string;
    client: string;
    headless: boolean;
    gone: boolean;
    /** The mod has the Work board's tools (one from before them says nothing). */
    work?: boolean;
    /** The mod's system prompt section holds Roamgate's rules. */
    rules?: boolean;
  }) {
    if (!input.client) throw new ClaudeModError("the mod sent no client id");
    const at = key(input.connectionId, input.paneId);
    const known = toolSessions.get(at);
    if (input.gone) {
      // Only the session that said it: a newer one in the pane stays.
      if (known?.client === input.client) {
        toolSessions.delete(at);
        save();
      }
      return { ok: true };
    }
    const fresh =
      !known ||
      known.client !== input.client ||
      known.sessionId !== input.sessionId ||
      known.headless !== input.headless ||
      known.work !== (input.work === true) ||
      known.rules !== (input.rules === true);
    toolSessions.set(at, {
      sessionId: input.sessionId,
      client: input.client,
      seenAt: now(),
      headless: input.headless,
      work: input.work === true,
      rules: input.rules === true,
    });
    // Each hello moves the time; the file only needs it for a headless one.
    if (fresh || input.headless) save();
    if (fresh)
      args.debug?.("claude mod tools", {
        connection: input.connectionId,
        pane: input.paneId,
        session: input.sessionId,
        headless: input.headless,
      });
    return { ok: true };
  }

  function isLive(attachment: Attachment | undefined): boolean {
    return (
      !!attachment &&
      !attachment.gone &&
      (attachment.polls > 0 || now() - attachment.lastSeen < liveMs)
    );
  }

  function snapshot(at: string, attachment: Attachment): ClaudeModPane {
    const [connectionId = "", paneId = ""] = at.split("\n");
    const mine = paneItems(at);
    return {
      connection_id: connectionId,
      pane_id: paneId,
      session_id: attachment.sessionId,
      claude: attachment.claude,
      protocol: attachment.protocol,
      status: attachment.status,
      ...(attachment.turnReason ? { turn_reason: attachment.turnReason } : {}),
      ...(attachment.usage ? { usage: attachment.usage } : {}),
      waiting: mine.length,
      held: mine.filter((each) => each.held).length,
      since: new Date(attachment.since).toISOString(),
      updated_at: new Date(attachment.updatedAt).toISOString(),
    };
  }

  function messagesFor(at: string, after: number) {
    return paneItems(at)
      .filter((each) => each.id > after)
      .slice(0, 20)
      .map((each) => ({ id: each.id, text: each.text }));
  }

  /**
   * The pane's attachment for this client, made when it is new (its first
   * poll or event: the newest client takes the pane); null for a client a
   * newer one replaced.
   */
  function attach(
    at: string,
    input: {
      connectionId: string;
      paneId: string;
      sessionId: string;
      client: string;
      claude?: string;
      protocol?: number;
    },
  ): Attachment | null {
    let attachment = attachments.get(at);
    if (attachment?.superseded.has(input.client)) return null;
    if (attachment && attachment.client === input.client && !attachment.gone) {
      if (input.claude) attachment.claude = input.claude.slice(0, 80);
      if (input.protocol) attachment.protocol = input.protocol;
      if (input.sessionId && input.sessionId !== attachment.sessionId) {
        attachment.sessionId = input.sessionId;
        attachment.updatedAt = now();
        args.onChange?.(input.connectionId, input.paneId, "status");
      }
      return attachment;
    }
    const previous =
      attachment && attachment.client !== input.client ? attachment : undefined;
    attachment = {
      client: input.client,
      sessionId: input.sessionId,
      claude: (input.claude ?? "").slice(0, 80),
      protocol: input.protocol ?? CLAUDE_MOD_PROTOCOL,
      polls: 0,
      lastSeen: now(),
      since: now(),
      status: "idle",
      updatedAt: now(),
      superseded: new Set([
        ...(attachments.get(at)?.superseded ?? []),
        ...(previous ? [previous.client] : []),
      ]),
    };
    attachments.set(at, attachment);
    // The replaced mod's waiting poll answers now: superseded.
    wake(at);
    log("claude mod attached", {
      connection: input.connectionId,
      pane: input.paneId,
      session: input.sessionId,
      ...(attachment.claude ? { claude: attachment.claude } : {}),
      ...(previous ? { replaced: true } : {}),
    });
    args.onChange?.(input.connectionId, input.paneId, "attach");
    return attachment;
  }

  /** Says hello and waits for messages (`mod_poll`). */
  async function poll(input: {
    connectionId: string;
    paneId: string;
    sessionId: string;
    client: string;
    claude: string;
    protocol: number;
    after: number;
    waitMs: number;
    signal?: AbortSignal;
  }) {
    if (!input.client) throw new ClaudeModError("the mod sent no client id");
    if (!Number.isSafeInteger(input.protocol) || input.protocol < 1)
      throw new ClaudeModError("the mod sent no protocol version");
    const at = key(input.connectionId, input.paneId);
    const attachment = attach(at, input);
    if (!attachment) return { protocol: CLAUDE_MOD_PROTOCOL, superseded: true };
    const mine = attachment;
    mine.polls += 1;
    mine.lastSeen = now();
    try {
      const after = Math.max(0, Math.floor(input.after) || 0);
      let messages = messagesFor(at, after);
      const hold = Math.min(Math.max(input.waitMs || 0, 0), maxHoldMs);
      if (!messages.length && hold > 0 && !input.signal?.aborted) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            waiters.get(at)?.delete(finish);
            input.signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, hold);
          (timer as { unref?: () => void }).unref?.();
          const set = waiters.get(at) ?? new Set();
          set.add(finish);
          waiters.set(at, set);
          input.signal?.addEventListener("abort", finish);
        });
        if (attachments.get(at)?.client !== input.client)
          return { protocol: CLAUDE_MOD_PROTOCOL, superseded: true };
        messages = messagesFor(at, after);
      }
      return { protocol: CLAUDE_MOD_PROTOCOL, epoch, messages };
    } finally {
      mine.polls = Math.max(0, mine.polls - 1);
      mine.lastSeen = now();
    }
  }

  /** The mod submitted a message, holds it, or could not (`mod_ack`). */
  function ack(input: {
    connectionId: string;
    paneId: string;
    client: string;
    id: number;
    outcome: string;
    reason: string;
  }) {
    const at = key(input.connectionId, input.paneId);
    const item = paneItems(at).find((each) => each.id === input.id);
    if (!item) return { ok: true, known: false };
    const fields = {
      connection: input.connectionId,
      pane: input.paneId,
      id: item.id,
      kind: item.kind,
    };
    if (input.outcome === "submitted") {
      remove(item);
      log("claude mod submitted a message", {
        ...fields,
        waited_ms: now() - item.queuedAt,
      });
    } else if (input.outcome === "held") {
      if (!item.held) {
        item.held = true;
        log("claude mod holds a message until the user's next turn", {
          ...fields,
          reason: input.reason.slice(0, 200),
        });
      }
    } else if (input.outcome === "failed") {
      remove(item);
      log("claude mod could not submit a message", {
        ...fields,
        reason: input.reason.slice(0, 300),
      });
    } else throw new ClaudeModError(`unknown outcome: ${input.outcome}`);
    return { ok: true, known: true };
  }

  /** What the mod says of its session (`mod_event`). */
  function event(input: {
    connectionId: string;
    paneId: string;
    client: string;
    sessionId: string;
    event: Record<string, unknown>;
  }) {
    const at = key(input.connectionId, input.paneId);
    const type = String(input.event.type ?? "");
    if (!input.client) throw new ClaudeModError("the mod sent no client id");
    // A goodbye from a mod Roamgate does not know changes nothing.
    const known = attachments.get(at);
    if (
      type === "bye" &&
      (!known || known.client !== input.client || known.gone)
    )
      return { ok: true, known: false };
    // A mod's event before its first poll answers (or after a restart)
    // says hello too; one a newer mod replaced speaks for nothing.
    const attachment = attach(at, input);
    if (!attachment) return { ok: true, known: false };
    attachment.lastSeen = Math.max(attachment.lastSeen, now());
    const change = (what: "status" | "usage" | "turn_complete" | "detach") => {
      attachment.updatedAt = now();
      args.onChange?.(input.connectionId, input.paneId, what);
    };
    switch (type) {
      case "turn_start":
        attachment.status = "working";
        delete attachment.turnReason;
        // A turn started: what a stop held goes after it.
        for (const each of paneItems(at)) delete each.held;
        change("status");
        break;
      case "turn_complete":
        attachment.status = "idle";
        attachment.turnReason = String(input.event.reason ?? "").slice(0, 40);
        // The usage after the turn comes with it.
        if ("model" in input.event || "context" in input.event)
          attachment.usage = parseModUsage(
            input.event,
            new Date(now()).toISOString(),
          );
        change("turn_complete");
        break;
      case "blocked":
        attachment.status = "blocked";
        change("status");
        break;
      case "unblocked":
        if (attachment.status === "blocked") {
          attachment.status = "working";
          change("status");
        }
        break;
      case "usage":
        attachment.usage = parseModUsage(
          input.event,
          new Date(now()).toISOString(),
        );
        change("usage");
        break;
      case "bye":
        attachment.gone = true;
        wake(at);
        log("claude mod left", {
          connection: input.connectionId,
          pane: input.paneId,
          reason: String(input.event.reason ?? "").slice(0, 40),
          waiting: paneItems(at).length,
        });
        change("detach");
        break;
      default:
        return { ok: true, known: false };
    }
    args.debug?.("claude mod event", {
      connection: input.connectionId,
      pane: input.paneId,
      type,
      status: attachment.status,
      ...(attachment.turnReason ? { reason: attachment.turnReason } : {}),
      ...(attachment.usage && type !== "turn_start"
        ? {
            model: attachment.usage.model,
            context_percent: attachment.usage.context?.percent,
            limits: attachment.usage.rate_limits
              ?.map((each) => `${each.kind}:${each.percent_used}`)
              .join(","),
          }
        : {}),
    });
    return { ok: true, known: true };
  }

  /**
   * A message for a pane's Claude, when its mod is live: its id, or null
   * (type it as before).
   */
  function deliver(
    connectionId: string,
    paneId: string,
    text: string,
    kind = "",
  ): { id: number } | null {
    if (disposed) return null;
    const at = key(connectionId, paneId);
    if (!isLive(attachments.get(at))) return null;
    if (!text.trim()) return null;
    if (paneItems(at).length >= maxPerPane)
      throw new ClaudeModError(
        `${maxPerPane} messages already wait for that session`,
        429,
      );
    const item: Item = {
      id: nextId++,
      connectionId,
      paneId,
      text,
      kind,
      queuedAt: now(),
    };
    items.push(item);
    save();
    wake(at);
    log("message queued for a claude mod", {
      connection: connectionId,
      pane: paneId,
      id: item.id,
      kind,
    });
    return { id: item.id };
  }

  /** Types what a mod left behind, once its pane's agent is idle. */
  async function sweep() {
    if (disposed) return;
    const oldest = now() - maxAgeMs;
    for (const each of [...items])
      if (each.queuedAt < oldest) {
        remove(each);
        log("claude mod message expired", {
          connection: each.connectionId,
          pane: each.paneId,
          id: each.id,
        });
      }
    // Mods silent for long are gone; gone ones with nothing left forgotten.
    for (const [at, attachment] of [...attachments]) {
      if (!attachment.gone && !isLive(attachment)) {
        if (now() - attachment.lastSeen < orphanMs) continue;
        attachment.gone = true;
        args.onChange?.(...(at.split("\n") as [string, string]), "detach");
      }
      if (attachment.gone && !paneItems(at).length) attachments.delete(at);
    }
    const panes = new Set(
      items.map((each) => key(each.connectionId, each.paneId)),
    );
    for (const at of panes) {
      const attachment = attachments.get(at);
      if (isLive(attachment) || typing.has(at)) continue;
      if (attachment && !attachment.gone) continue;
      // Since a restart, its mod may yet come back.
      if (!attachment && now() - startedAt < orphanMs) continue;
      const next = paneItems(at)[0];
      if (!next || !args.type) continue;
      if (now() - next.queuedAt > orphanLimitMs + orphanMs) {
        remove(next);
        log("claude mod message dropped: its session stayed busy", {
          connection: next.connectionId,
          pane: next.paneId,
          id: next.id,
        });
        continue;
      }
      typing.add(at);
      try {
        const result = await args.type(
          next.connectionId,
          next.paneId,
          next.text,
        );
        // A mod came back meanwhile: it has the message (if not typed).
        if (result === "typed" || result === "gone") {
          remove(next);
          log(
            result === "typed"
              ? "claude mod message typed instead"
              : "claude mod message dropped: no agent in its pane",
            {
              connection: next.connectionId,
              pane: next.paneId,
              id: next.id,
            },
          );
        }
      } catch (error) {
        log("claude mod message not typed yet", {
          connection: next.connectionId,
          pane: next.paneId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        typing.delete(at);
      }
    }
  }

  const sweeper = setInterval(() => void sweep(), sweepMs);
  (sweeper as { unref?: () => void }).unref?.();

  return {
    poll,
    ack,
    event,
    tools,
    /** Whether the pane's Claude has the mod's Work board tools (`work_*`). */
    hasWorkTools(connectionId: string, paneId: string): boolean {
      const entry = toolSessions.get(key(connectionId, paneId));
      return !!entry && entry.work && toolsFresh(entry);
    },
    /** Whether the pane's Claude has Roamgate's rules in its system prompt. */
    hasRules(connectionId: string, paneId: string): boolean {
      const entry = toolSessions.get(key(connectionId, paneId));
      return !!entry && entry.rules && toolsFresh(entry);
    },
    /** Whether the pane's Claude has the mod's tools (it said so lately). */
    hasTools(connectionId: string, paneId: string): boolean {
      const entry = toolSessions.get(key(connectionId, paneId));
      return !!entry && toolsFresh(entry);
    },
    deliver,
    /** Whether the pane's Claude runs a live mod. */
    live: (connectionId: string, paneId: string) =>
      isLive(attachments.get(key(connectionId, paneId))),
    /** What the pane's live mod says; null without one. */
    pane(connectionId: string, paneId: string): ClaudeModPane | null {
      const at = key(connectionId, paneId);
      const attachment = attachments.get(at);
      return attachment && isLive(attachment) ? snapshot(at, attachment) : null;
    },
    /** Every live mod of a connection. */
    panes(connectionId: string): ClaudeModPane[] {
      const out: ClaudeModPane[] = [];
      for (const [at, attachment] of attachments)
        if (at.startsWith(`${connectionId}\n`) && isLive(attachment))
          out.push(snapshot(at, attachment));
      return out;
    },
    /** Messages waiting for a pane, live mod or not. */
    waiting: (connectionId: string, paneId: string) =>
      paneItems(key(connectionId, paneId)).length,
    sweep,
    /** Writes the inbox now (shutdown). */
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      writeNow();
    },
    dispose() {
      if (disposed) return;
      clearInterval(sweeper);
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        writeNow();
      }
      disposed = true;
      for (const at of [...waiters.keys()]) wake(at);
    },
    /** For tests: removes the inbox file. */
    clearFile() {
      if (args.file) rmSync(args.file, { force: true });
    },
  };
}

export type ClaudeModHub = ReturnType<typeof createClaudeModHub>;

/** Herdr's status of a pane, with what its live mod says laid over it. */
function overlayStatus(herdr: unknown, mod: ClaudeModStatus): string {
  if (mod === "idle") return herdr === "done" ? "done" : "idle";
  if (mod === "working") return herdr === "blocked" ? "blocked" : "working";
  return "blocked";
}

function overlayAgent(
  item: Record<string, unknown>,
  mod: ClaudeModPane,
): Record<string, unknown> {
  // Only a Claude Herdr sees there: the mod runs inside it.
  if (item.agent !== "claude") return item;
  const session = isRecord(item.agent_session) ? item.agent_session : null;
  return {
    ...item,
    agent_status: overlayStatus(item.agent_status, mod.status),
    ...(mod.session_id && session?.value !== mod.session_id
      ? {
          agent_session: {
            ...(session ?? {}),
            source: "roamgate:mod",
            agent: "claude",
            kind: "id",
            value: mod.session_id,
          },
        }
      : {}),
  };
}

/**
 * What Herdr says of panes and agents, with the state of each pane's live
 * Claude mod laid over Herdr's screen detection: working and idle are the
 * mod's (Herdr's done stays: idle and unseen), blocked is either's, and the
 * session is the mod's.
 */
export function overlayModPanes(
  method: string,
  params: Record<string, unknown> | undefined,
  result: unknown,
  mods: readonly ClaudeModPane[],
): unknown {
  if (!mods.length || !isRecord(result)) return result;
  const byPane = new Map(mods.map((each) => [each.pane_id, each]));
  const over = (item: unknown) => {
    if (!isRecord(item) || typeof item.pane_id !== "string") return item;
    const mine = byPane.get(item.pane_id);
    return mine ? overlayAgent(item, mine) : item;
  };
  switch (method) {
    case "agent.get": {
      const paneId = typeof params?.target === "string" ? params.target : "";
      const mine = byPane.get(paneId);
      if (!mine || !isRecord(result.agent)) return result;
      return {
        ...result,
        agent: overlayAgent({ pane_id: paneId, ...result.agent }, mine),
      };
    }
    case "agent.list":
      return Array.isArray(result.agents)
        ? { ...result, agents: result.agents.map(over) }
        : result;
    case "pane.list":
      return Array.isArray(result.panes)
        ? { ...result, panes: result.panes.map(over) }
        : result;
    case "pane.get":
      return isRecord(result.pane)
        ? { ...result, pane: over(result.pane) }
        : result;
    default:
      return result;
  }
}
