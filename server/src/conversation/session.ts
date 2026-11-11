import { randomUUID } from "node:crypto";
import type {
  AgentChatEvent,
  AgentChatMcpRequest,
  AgentChatMcpResult,
  AgentChatMcpServer,
  AgentChatModel,
  AgentChatNextPrompt,
  AgentChatQueued,
  AgentChatStatus,
  AgentChatStreamedText,
} from "../../../shared/agentChat";
import type { AgentPromptAnswer, AgentQuestion } from "../../../shared/review";
import { claudeProtocolDriver } from "./drivers/claude";
import type {
  ControlAnswer,
  McpDriver,
  ModelContext,
  DriverEvent,
  DriverImage,
  PromptRequest,
  ProtocolDriver,
  RewindContext,
} from "./drivers/types";
import type { HeadlessProcess, SpawnHeadless } from "./headless";
import {
  type ConversationResumeState,
  keptResumeState,
  resumeStateOf,
} from "./session-resume";
import { createSessionRewind } from "./session-rewind";
import { createReplyStream } from "./session-stream";
import { createVoiceInput } from "./session-voice";

// Claude's rewind check lives with its driver; re-exported here.
export { rewindCheckOf } from "./drivers/claude-rewind";
export type { ConversationResumeState } from "./session-resume";

/** A permission or a question for the user, answered in the browser. */
export type ConversationPrompt = {
  tool: string;
  input: unknown;
  canAlways: boolean;
  questions?: AgentQuestion[];
  timeoutMs: number;
  signal: AbortSignal;
};

export type ConversationImage = { media_type: string; data: string };

export type ConversationSessionOptions = {
  paneId: string;
  sessionId: string;
  cwd: string;
  spawn: SpawnHeadless;
  emit: (event: AgentChatEvent) => void;
  /** Asks the user; null when nobody answered (the tool is denied). */
  ask: (prompt: ConversationPrompt) => Promise<AgentPromptAnswer | null>;
  readImage: (path: string) => Promise<ConversationImage>;
  /**
   * What goes before the next message's own text: the `!` lines run since
   * the last one, in Claude Code's bash-mode format. `commit` once written.
   */
  prelude?: () => { texts: string[]; commit(): void } | null;
  /** /clear moved the conversation to a new session id. */
  onSessionId?: (sessionId: string, previous: string) => void;
  onStatus?: (status: AgentChatStatus) => void;
  /**
   * The process started (its pid, and the session id its argv resumes,
   * which a probe looks for) or exited (null).
   */
  onProcess?: (pid: number | null, resumedSessionId?: string) => void;
  /**
   * A turn was written to the process (true), or ended: its result came,
   * or the user interrupted it (false). A process that exits between the
   * two cut the turn short.
   */
  onTurn?: (running: boolean) => void;
  /** The process said something new (not a line read again). */
  onOutput?: () => void;
  /**
   * Its process was stopped for being idle (true: `sleep`), or a new one
   * started since (false).
   */
  onAsleep?: (asleep: boolean) => void;
  /** Another session's message reached it (Claude Code's own peers). */
  onPeer?: () => void;
  /** Stopped for being idle by a runtime before this one. */
  asleep?: boolean;
  /** The clock activity is timed with (tests). */
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Messages left queued by an earlier process (another runtime). */
  queue?: AgentChatQueued[];
  /** Deltas sent together within this window (about a frame). */
  coalesceMs?: number;
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
  /** How long an interrupt waits for the CLI to confirm it. */
  interruptWaitMs?: number;
  /** How long a stop waits for the process to exit before killing it. */
  stopWaitMs?: number;
  /**
   * How long a control request waits for the CLI's answer: each step of a
   * rewind, a model switch.
   */
  rewindWaitMs?: number;
  /** How long an MCP action may take (a server's reconnect, a sign-in). */
  mcpWaitMs?: number;
  /**
   * The session's transcript, for what a rewind would restore of the code;
   * null (or none given) when it cannot be read.
   */
  readTranscript?: () => Promise<string | Record<string, unknown>[] | null>;
  /** The agent's protocol; claude when none is given. */
  driver?: ProtocolDriver;
};

type PermissionRequest = PromptRequest;

/** A user line carrying another Claude session's or a teammate's message. */
const PEER_LINE =
  /^\{"type":"user".*(?:<cross-session-message\b|<teammate-message\b|"origin":\{"kind":"peer")/;

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * One conversation-owned session: its long-lived headless claude (started
 * on demand, living until handback, stop or the pane closes), the turn state the stream gives, Roamgate's
 * queue of messages typed while it works, and the bridge from the CLI's
 * permission requests to the browser's prompt cards.
 */
export function createConversationSession(options: ConversationSessionOptions) {
  const coalesceMs = options.coalesceMs ?? 16;
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 15 * 60_000;
  const questionTimeoutMs = options.questionTimeoutMs ?? 30 * 60_000;
  const interruptWaitMs = options.interruptWaitMs ?? 3000;
  const stopWaitMs = options.stopWaitMs ?? 10_000;
  const rewindWaitMs = options.rewindWaitMs ?? 30_000;
  const mcpWaitMs = options.mcpWaitMs ?? 45_000;
  const log = options.log ?? (() => {});
  const driver = options.driver ?? claudeProtocolDriver;
  const agentName = driver.displayName;
  const now = options.now ?? Date.now;
  // When the process last said something new, or a turn was written to
  // it: what a turn that hangs is timed from.
  let lastActivity = now();
  // Its process was stopped while idle (sleep): the next start wakes it,
  // and the chat says so while it starts.
  let asleep = options.asleep ?? false;
  let waking = false;

  let sessionId = options.sessionId;
  let proc: HeadlessProcess | null = null;
  // Its stdin was closed (a stop, a hand-back): it is on its way out and
  // takes nothing more; the next turn waits for it and starts another.
  let ending = false;
  let starting: Promise<HeadlessProcess | null> | null = null;
  let spawnAbort: AbortController | null = null;
  let exited: Promise<void> | null = null;
  let disposed = false;
  // A hand-back is stopping the process: nothing more is written.
  let stopping = false;
  let turn = false;
  let compacting = false;
  // Messages on their way to stdin (reading images, starting the process).
  let delivering = 0;
  // An interrupt was asked: what it abandons is the partial reply it keeps.
  let interrupting = false;
  let activity: string | null = null;
  // Claude Code's guess at the next message, offered while nothing runs.
  let nextPrompt: AgentChatNextPrompt | null = null;
  // The turn's latest content block: only while it is reply text does
  // speech interrupt (the barge-in mix); otherwise it steers.
  let lastBlock: "text" | "thinking" | "tool_use" | null = null;
  const tools = new Set<string>();
  // Tasks (Bash commands, subagents) that may run past their turn.
  const tasks = new Set<string>();
  const prompts = new Map<string, AbortController>();
  // The requests behind those prompts: a reader after this one asks them
  // again.
  const asking = new Map<string, PermissionRequest>();
  const interrupts = new Map<string, () => void>();
  // Control requests waiting for their answer (a rewind's steps).
  const controls = new Map<
    string,
    (answer: { error?: string; response?: Record<string, unknown> }) => void
  >();
  let resultWaiters: (() => void)[] = [];
  const queue: AgentChatQueued[] = (options.queue ?? []).map((item) => ({
    ...item,
  }));
  // The ids of the messages taken lately: one sent twice (a retried call)
  // is taken once.
  const taken: string[] = queue.map((item) => item.id);
  function take(id: string): boolean {
    if (taken.includes(id)) return false;
    taken.push(id);
    if (taken.length > 64) taken.shift();
    return true;
  }
  // The process exited in a turn and the queue was sent on to a new one:
  // once only, until a turn ends, so a process that keeps dying does not
  // keep being started.
  let respawnedForQueue = false;
  let lastStatus: {
    status: AgentChatStatus;
    tools: boolean;
    /** The running tool calls' ids, space-joined. */
    running: string;
    activity: string | null;
  } | null = null;
  let codec = driver.createCodec();
  // Replaying what an earlier reader handled already (after a new runtime
  // or a restart): the state is rebuilt, nothing reaches the browsers, and
  // the prompts still open at its end are asked again, once.
  let muted = false;
  // Looking for that process: its state is not known yet.
  let attaching = false;
  // What Herdr was last told.
  let reported: AgentChatStatus | null = null;
  const deferred = new Map<string, PermissionRequest>();
  // Catching up on the lines that were in when the process was taken (the
  // replayed ones and those after): no prompt is asked before their end,
  // since a later line may show it answered already.
  let catching = false;
  let caughtUp: Promise<void> = Promise.resolve();
  // The messages written lately, by uuid: one claude never got (the holder
  // dropped it) goes back in the queue.
  const recent = new Map<string, { text: string; images: string[] }>();
  function remember(uuid: string, text: string, images: string[]) {
    recent.delete(uuid);
    recent.set(uuid, { text, images });
    if (recent.size > 16) recent.delete(recent.keys().next().value!);
  }
  // The message that started the turn that runs.
  let turnUuid: string | null = null;
  // The model the process runs, as its turns' start or a switch said, and
  // the name the user last switched it to (/model).
  let model: string | null = null;
  let chosenModel: string | null = null;

  // The reply on its way to the browsers, and what was sent of it.
  const reply = createReplyStream({
    coalesceMs,
    emit: options.emit,
    muted: () => muted,
  });
  const emit = reply.emit;
  const flushDeltas = reply.flush;

  function status(): AgentChatStatus {
    if (!proc) {
      if (!starting) return "stopped";
      // Started ahead of any turn (a takeover warms it up): nobody waits
      // on it yet, so it does not look busy.
      return turn || delivering > 0 || queue.length ? "starting" : "idle";
    }
    if (prompts.size) return "blocked";
    return turn || compacting ? "working" : "idle";
  }

  /** What the chat says it does: a tool, thinking, or waking up. */
  function shownActivity(): string | null {
    if (waking && status() === "starting") return "waking";
    return turn || compacting ? activity : null;
  }

  function pushStatus() {
    const now = {
      status: status(),
      tools: tools.size > 0,
      running: [...tools].join(" "),
      activity: shownActivity(),
    };
    reportStatus(now.status);
    if (
      lastStatus &&
      lastStatus.status === now.status &&
      lastStatus.tools === now.tools &&
      lastStatus.running === now.running &&
      lastStatus.activity === now.activity
    )
      return;
    lastStatus = now;
    emit({
      type: "status",
      status: now.status,
      tools_running: now.tools,
      running_tools: [...tools],
      activity: now.activity,
    });
  }

  /**
   * Tells Herdr the agent's state when it changes. Not while the process a
   * runtime before this one started is being read again: a replayed turn
   * ran before, and reported again Herdr would see the agent work and
   * finish once more, and tell the user so. Only the state the replay ends
   * in goes, once it is over.
   */
  function reportStatus(now: AgentChatStatus) {
    if (muted || attaching || now === reported) return;
    reported = now;
    options.onStatus?.(now);
  }

  function setNextPrompt(next: AgentChatNextPrompt | null) {
    if (next === nextPrompt) return;
    if (next && nextPrompt && next.uuid === nextPrompt.uuid) return;
    nextPrompt = next;
    emit({ type: "next_prompt", next_prompt: next ? { ...next } : null });
  }

  function pushQueue() {
    emit({ type: "queue", queue: queue.map((item) => ({ ...item })) });
    // A message queued while the process starts waits on it.
    pushStatus();
  }

  function write(lines: string[]) {
    if (!proc || ending) throw new Error("The conversation process is closing");
    for (const line of lines) proc.write(`${line}\n`);
  }

  /** The lines of a user message, its images read when sent inline. */
  async function userMessage(
    text: string,
    images: string[],
    uuid: string,
    prelude: string[] = [],
    steer = false,
  ): Promise<string[]> {
    const inline = driver.capabilities.images === "base64";
    const read: DriverImage[] = await Promise.all(
      images.map(async (path) =>
        inline ? { path, ...(await options.readImage(path)) } : { path },
      ),
    );
    return codec.message({ text, images: read, uuid, prelude, steer });
  }

  /** Writes a turn's message; the process starts first when it is not up. */
  async function deliver(
    text: string,
    images: string[],
    uuid: string = randomUUID(),
  ) {
    delivering += 1;
    try {
      // The `!` lines run since the last message: Claude reads them first,
      // as in the terminal.
      const prelude = options.prelude?.() ?? null;
      const message = await userMessage(text, images, uuid, prelude?.texts);
      await ensureProcess();
      write(message);
      prelude?.commit();
      remember(uuid, text, images);
    } finally {
      delivering -= 1;
    }
    turnUuid = uuid;
    turn = true;
    lastActivity = now();
    activity = null;
    lastBlock = null;
    setNextPrompt(null);
    options.onTurn?.(true);
    pushStatus();
    return uuid;
  }

  function handle(item: DriverEvent) {
    switch (item.kind) {
      case "model":
        model = item.model;
        return;
      case "init":
        if (item.model) model = item.model;
        if (item.session_id !== sessionId) {
          const previous = sessionId;
          sessionId = item.session_id;
          setNextPrompt(null);
          emit({ type: "session", session_id: sessionId, previous });
          options.onSessionId?.(sessionId, previous);
        }
        return;
      case "reset": {
        const previous = sessionId;
        if (item.new_session_id === previous) return;
        sessionId = item.new_session_id;
        setNextPrompt(null);
        emit({ type: "session", session_id: sessionId, previous });
        options.onSessionId?.(sessionId, previous);
        return;
      }
      case "status":
        if (item.status === "requesting") {
          turn = true;
          setNextPrompt(null);
        }
        compacting = item.status === "compacting";
        if (compacting) activity = "compacting";
        else if (activity === "compacting") activity = null;
        pushStatus();
        return;
      case "block_start":
        turn = true;
        setNextPrompt(null);
        lastBlock = item.block;
        activity =
          item.block === "tool_use"
            ? item.name || "tool"
            : item.block === "thinking"
              ? "thinking"
              : null;
        emit({
          type: "block_start",
          message_id: item.message_id,
          index: item.index,
          block: item.block,
          ...(item.tool_use_id ? { tool_use_id: item.tool_use_id } : {}),
          ...(item.name ? { name: item.name } : {}),
        });
        pushStatus();
        return;
      case "delta":
        reply.delta({
          message_id: item.message_id,
          index: item.index,
          text: item.text,
        });
        return;
      case "block_stop":
        emit({
          type: "block_stop",
          message_id: item.message_id,
          index: item.index,
        });
        return;
      case "assistant_text":
        emit({
          type: "block_stop",
          message_id: item.message_id,
          index: item.index,
          text: item.text,
          ...(item.command_output
            ? { command_output: item.command_output }
            : {}),
        });
        return;
      case "abandoned":
        // An interrupt abandons the reply it cut: Claude Code keeps that
        // partial text in the transcript, so the chat keeps it too.
        if (interrupting) return;
        // A retry's blocks: their deltas never reach the browser either.
        reply.dropPending(item.message_id, item.from_index);
        emit({
          type: "abandoned",
          message_id: item.message_id,
          from_index: item.from_index,
        });
        return;
      case "thinking":
        if (activity === null && turn) {
          activity = "thinking";
          pushStatus();
        }
        return;
      case "tool_use":
        tools.add(item.tool_use_id);
        emit({
          type: "tool_use",
          tool_use_id: item.tool_use_id,
          name: item.name,
          input: item.input,
          message_id: item.message_id,
          index: item.index,
        });
        pushStatus();
        return;
      case "tool_result":
        tools.delete(item.tool_use_id);
        emit({
          type: "tool_result",
          tool_use_id: item.tool_use_id,
          is_error: item.is_error,
          text: item.text,
        });
        pushStatus();
        return;
      case "user_replay":
        setNextPrompt(null);
        emit({
          type: "user",
          uuid: item.uuid,
          text: item.text,
          images: item.images,
        });
        return;
      case "interrupted":
        return;
      case "permission_request":
        if (catching) deferred.set(item.request_id, item);
        else void answerPermission(item);
        return;
      case "permission_cancel":
        deferred.delete(item.request_id);
        asking.delete(item.request_id);
        prompts.get(item.request_id)?.abort();
        return;
      case "control_response": {
        const done = interrupts.get(item.request_id);
        if (done) {
          interrupts.delete(item.request_id);
          done();
        }
        const answered = controls.get(item.request_id);
        if (answered) {
          controls.delete(item.request_id);
          answered({
            ...(item.error !== undefined ? { error: item.error } : {}),
            ...(item.response ? { response: item.response } : {}),
          });
        }
        return;
      }
      case "result":
        // A message steered in while the turn ended runs as a turn of its
        // own: still working (no handover may cut it).
        turn = (item.queued_turns ?? 0) > 0;
        respawnedForQueue = false;
        compacting = false;
        interrupting = false;
        activity = null;
        lastBlock = null;
        tools.clear();
        options.onTurn?.(turn);
        emit({
          type: "result",
          subtype: item.subtype,
          is_error: item.is_error,
          interrupted: item.interrupted,
          text: item.text,
          ...(item.cost_usd !== undefined ? { cost_usd: item.cost_usd } : {}),
          ...(item.duration_ms !== undefined
            ? { duration_ms: item.duration_ms }
            : {}),
        });
        for (const done of resultWaiters) done();
        resultWaiters = [];
        pushStatus();
        if (!catching) flushQueue();
        return;
      case "compact_boundary":
        emit({
          type: "notice",
          kind: "compact",
          text:
            item.pre_tokens && item.post_tokens
              ? `Compacted ${item.pre_tokens} tokens to ${item.post_tokens}`
              : "Compacted",
        });
        return;
      case "api_retry":
        emit({
          type: "notice",
          kind: "api_retry",
          text: `Retrying (${item.attempt}/${item.max_retries})${item.error ? `: ${item.error}` : ""}`,
        });
        return;
      case "permission_denied":
        emit({ type: "notice", kind: "permission_denied", text: item.message });
        return;
      case "task_started":
        tasks.add(item.task_id);
        return;
      case "task_ended":
        tasks.delete(item.task_id);
        return;
      case "prompt_suggestion":
        // Only for a box with nothing on its way: a turn that runs or a
        // queued message makes it stale at once.
        if (turn || compacting || delivering > 0 || queue.length) return;
        setNextPrompt({
          uuid: item.uuid || randomUUID(),
          text: item.suggestion,
        });
        return;
    }
  }

  async function answerPermission(item: PermissionRequest) {
    const controller = new AbortController();
    prompts.set(item.request_id, controller);
    asking.set(item.request_id, item);
    pushStatus();
    const prompt = driver.promptOf(item);
    let answer: AgentPromptAnswer | null = null;
    try {
      answer = await options.ask({
        ...prompt,
        timeoutMs: prompt.questions?.length
          ? questionTimeoutMs
          : permissionTimeoutMs,
        signal: controller.signal,
      });
    } catch (error) {
      log("permission prompt failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (prompts.get(item.request_id) !== controller) return;
    prompts.delete(item.request_id);
    asking.delete(item.request_id);
    // Cancelled by the CLI (an interrupt): it expects no answer.
    if (!controller.signal.aborted && proc) write(codec.answer(item, answer));
    pushStatus();
  }

  /** Whether a message written now would start a turn at once. */
  function ready() {
    return (
      !turn &&
      !compacting &&
      !prompts.size &&
      !starting &&
      delivering === 0 &&
      !rewinds.running()
    );
  }

  /**
   * Writes what waits in the queue, in order, as one turn; true once it is
   * written. Undelivered, it goes back in the queue, first: nothing typed
   * is lost.
   */
  async function drainQueue(uuid?: string): Promise<boolean> {
    if (!queue.length || !ready()) return false;
    const items = queue.splice(0);
    pushQueue();
    const text = items
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n\n");
    const images = items.flatMap((item) => item.images);
    try {
      // A single message keeps its id, so its replay carries the sender's
      // uuid; several go as one turn under a new one.
      await deliver(
        text,
        images,
        uuid ?? (items.length === 1 ? items[0]!.id : randomUUID()),
      );
      return true;
    } catch (error) {
      log("queued messages not delivered", {
        error: error instanceof Error ? error.message : String(error),
      });
      queue.unshift(...items);
      pushQueue();
      return false;
    }
  }

  function flushQueue() {
    void drainQueue();
  }

  async function ensureProcess(): Promise<HeadlessProcess>;
  async function ensureProcess(
    attachOnly: true,
  ): Promise<HeadlessProcess | null>;
  async function ensureProcess(
    attachOnly = false,
  ): Promise<HeadlessProcess | null> {
    for (;;) {
      if (disposed) throw new Error("The conversation is closed");
      if (stopping && !attachOnly)
        throw new Error("The session is being handed back to the terminal");
      if (starting) {
        const started = await starting;
        if (started || attachOnly) return started;
        continue;
      }
      if (!proc) break;
      if (!ending) return proc;
      if (attachOnly) return proc;
      // Closing: it takes nothing more; the next one starts after.
      await (exited ?? proc.exited.then(() => undefined));
    }
    const controller = new AbortController();
    spawnAbort = controller;
    const resumed = sessionId;
    // Asleep: this start wakes it.
    waking = asleep && !attachOnly;
    starting = (async () => {
      await Promise.resolve();
      attaching = attachOnly;
      pushStatus();
      const child = await options.spawn({
        paneId: options.paneId,
        sessionId: resumed,
        cwd: options.cwd,
        ...(attachOnly ? { attachOnly } : {}),
        signal: controller.signal,
      });
      if (!child) return null;
      if (disposed) {
        child.detach?.();
        throw new Error("The conversation is closed");
      }
      // Kept even while a stop waits for this start: the stop then ends it.
      proc = child;
      ending = false;
      if (asleep) {
        asleep = false;
        options.onAsleep?.(false);
      }
      codec = driver.createCodec();
      options.onProcess?.(child.pid ?? null, resumed);
      log("conversation process started", { session: sessionId });
      exited = read(child);
      return child;
    })().finally(() => {
      // Read from here: muted while it replays what ran before.
      attaching = false;
      waking = false;
      starting = null;
      if (spawnAbort === controller) spawnAbort = null;
    });
    try {
      return await starting;
    } finally {
      pushStatus();
    }
  }

  /**
   * What the holder notes in the log: what was written to the process.
   * Notes of writes this runtime did not make (an earlier one did, or its
   * unconfirmed commands were sent on) bring the state along: a turn that
   * runs, a prompt answered already.
   */
  function holderNote(line: string) {
    let note: { kind?: unknown; request_id?: unknown; dropped?: unknown };
    try {
      note = JSON.parse(line);
    } catch {
      return;
    }
    // Dropped: claude never got it (seen once the process exits).
    if (note.dropped) return;
    if (note.kind === "user" && !turn) {
      turn = true;
      setNextPrompt(null);
      activity = null;
      lastBlock = null;
      options.onTurn?.(true);
      pushStatus();
    } else if (
      note.kind === driver.answerKind &&
      typeof note.request_id === "string"
    ) {
      deferred.delete(note.request_id);
      asking.delete(note.request_id);
      // Answered by another runtime: the card asked again goes.
      prompts.get(note.request_id)?.abort();
    }
  }

  /** The replay is over: the browsers hear from here. */
  function unmute() {
    if (!muted) return;
    flushDeltas();
    muted = false;
    lastStatus = null;
    pushStatus();
  }

  /**
   * Caught up with what was in when the process was taken: the prompts
   * still open are asked, and what waited goes once it is idle.
   */
  function endCatchUp() {
    unmute();
    if (!catching) return;
    catching = false;
    const open = [...deferred.values()];
    deferred.clear();
    for (const item of open) void answerPermission(item);
    if (!turn) flushQueue();
  }

  /** User messages claude never got go back first in the queue. */
  function requeue(lines: string[]): string[] {
    const items: AgentChatQueued[] = [];
    for (const line of lines) {
      const message = driver.parseWrittenMessage(line);
      if (!message) continue;
      const uuid = message.uuid ?? randomUUID();
      const known = recent.get(uuid);
      const text = known?.text ?? message.text;
      const images = known?.images ?? [];
      if (!text && !images.length) continue;
      items.push({
        id: uuid,
        text,
        images,
        queued_at: new Date().toISOString(),
      });
    }
    if (items.length) {
      log(`messages ${driver.agent} never got go back in the queue`, {
        session: sessionId,
        count: items.length,
      });
      queue.unshift(...items);
      pushQueue();
    }
    return items.map((item) => item.id);
  }

  /** Takes up the state a reader before this one saved (resumeState). */
  function restore(value: unknown): boolean {
    const state = resumeStateOf(value);
    if (!state) return false;
    turn = state.turn;
    compacting = state.compacting === true;
    activity = typeof state.activity === "string" ? state.activity : null;
    lastBlock = state.last_block ?? null;
    tools.clear();
    for (const id of state.tools) if (typeof id === "string") tools.add(id);
    tasks.clear();
    for (const id of state.tasks) if (typeof id === "string") tasks.add(id);
    // Asked again once the lines after it are handled (one may answer it).
    for (const item of state.prompts)
      if (item && typeof item.request_id === "string")
        deferred.set(item.request_id, item);
    nextPrompt = state.next_prompt ?? null;
    reply.restore(state.streamed);
    turnUuid = typeof state.turn_uuid === "string" ? state.turn_uuid : null;
    respawnedForQueue = state.respawned_for_queue === true;
    for (const id of state.taken)
      if (typeof id === "string" && !taken.includes(id)) taken.push(id);
    while (taken.length > 64) taken.shift();
    for (const [uuid, message] of state.recent)
      if (typeof uuid === "string" && message) recent.set(uuid, message);
    codec.restore(state.parser);
    options.onTurn?.(turn);
    log("conversation state taken up where it was saved", {
      session: sessionId,
      turn,
    });
    return true;
  }

  async function read(child: HeadlessProcess) {
    const restored = child.resume !== undefined && restore(child.resume);
    const replayed = child.replayed ?? 0;
    const catchUp = Math.max(child.catchUp ?? 0, replayed);
    const done = Promise.withResolvers<void>();
    caughtUp = done.promise;
    let index = 0;
    muted = replayed > 0;
    // Restored prompts are asked once caught up, even with nothing to read.
    catching = catchUp > 0 || restored;
    if (!catching) done.resolve();
    else if (catchUp === 0) {
      endCatchUp();
      done.resolve();
    }
    try {
      for await (const line of child.lines) {
        index += 1;
        if (line.startsWith('{"type":"roamgate_input"')) holderNote(line);
        else {
          // Claude Code's message from another session (SendMessage) or a
          // teammate: no idle stop for a while (its address dies with it).
          if (!muted && PEER_LINE.test(line)) options.onPeer?.();
          for (const item of codec.line(line)) handle(item);
          if (!catching && !muted) {
            lastActivity = now();
            options.onOutput?.();
          }
        }
        if (index >= replayed) unmute();
        if (index >= catchUp && catching) {
          endCatchUp();
          done.resolve();
        }
      }
    } catch (error) {
      log("conversation stream failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Detached (this runtime goes): the process runs on in the holder.
    if (disposed) {
      done.resolve();
      return;
    }
    endCatchUp();
    done.resolve();
    const code = await child.exited.catch(() => -1);
    flushDeltas();
    if (proc !== child) return;
    // What it was written but never got: not a turn cut short, and sent
    // again to the next process.
    const lost = requeue(child.undelivered?.() ?? []);
    if (turnUuid && lost.includes(turnUuid)) {
      turn = false;
      compacting = false;
      options.onTurn?.(false);
    }
    proc = null;
    ending = false;
    interrupting = false;
    lastBlock = null;
    for (const controller of prompts.values()) controller.abort();
    prompts.clear();
    asking.clear();
    deferred.clear();
    for (const done of interrupts.values()) done();
    interrupts.clear();
    for (const answered of controls.values())
      answered({ error: `${agentName} stopped` });
    controls.clear();
    tools.clear();
    tasks.clear();
    const wasTurn = turn || compacting;
    turn = false;
    compacting = false;
    activity = null;
    if (wasTurn) {
      emit({
        type: "notice",
        kind: "process_exited",
        text: `${agentName} stopped in the middle of the turn (exit ${code})`,
      });
      emit({
        type: "result",
        subtype: "process_exited",
        is_error: true,
        interrupted: true,
        text: "",
      });
    }
    for (const done of resultWaiters) done();
    resultWaiters = [];
    options.onProcess?.(null);
    log("conversation process exited", { session: sessionId, code });
    pushStatus();
    // What waited for that turn goes to a new process, once.
    if (queue.length && !disposed && !stopping) {
      if (!respawnedForQueue) {
        respawnedForQueue = true;
        flushQueue();
      } else
        emit({
          type: "notice",
          kind: "error",
          text: `${agentName} stopped again; the queued messages wait for the next one you send`,
        });
    }
  }

  function waitForResult(timeoutMs: number): Promise<boolean> {
    if (!turn && !compacting) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resultWaiters = resultWaiters.filter((each) => each !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      resultWaiters.push(done);
    });
  }

  /** Stops the turn; the process stays up and keeps the partial reply. */
  async function interrupt(): Promise<boolean> {
    if (!proc || (!turn && !compacting && !prompts.size)) return false;
    const requestId = `roamgate-interrupt-${randomUUID()}`;
    const confirmed = new Promise<void>((resolve) =>
      interrupts.set(requestId, resolve),
    );
    for (const controller of prompts.values()) controller.abort();
    interrupting = true;
    // Stopped on purpose: the process exiting now cuts nothing short.
    options.onTurn?.(false);
    write(codec.interrupt(requestId));
    const ok = await Promise.race([
      confirmed.then(() => true),
      delay(interruptWaitMs).then(() => false),
    ]);
    interrupts.delete(requestId);
    return ok;
  }

  /** Asks the CLI something over its control protocol; null: no answer. */
  async function control(
    child: HeadlessProcess,
    kind: string,
    params: Record<string, unknown>,
    waitMs = rewindWaitMs,
  ): Promise<ControlAnswer> {
    if (proc !== child || ending)
      return { error: "The conversation process is closing" };
    const requestId = `roamgate-${kind}-${randomUUID()}`;
    const lines = codec.request(kind, params, requestId);
    if (!lines) return { error: `${agentName} cannot do that` };
    const answer = new Promise<{
      error?: string;
      response?: Record<string, unknown>;
    }>((resolve) => controls.set(requestId, resolve));
    write(lines);
    const answered = await Promise.race([
      answer,
      delay(waitMs).then(() => null),
    ]);
    controls.delete(requestId);
    return answered;
  }

  /**
   * The models the running process offers (/model's picker); null when
   * none runs (nothing is started for it) or it cannot say. Asked briefly:
   * the picker has the profile's list otherwise.
   */
  async function listModels(): Promise<AgentChatModel[] | null> {
    const models = driver.models;
    const child = proc;
    if (!models || !child || ending || stopping || disposed) return null;
    try {
      return await models.list({
        control: (kind, params) =>
          control(child, kind, params, Math.min(rewindWaitMs, 5000)),
      });
    } catch (error) {
      log("the agent's models could not be listed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Switches the session's model (/model) for its next turns: a turn that
   * runs keeps its own. Starts the process when none runs, so the agent
   * itself says whether it has that model. `nextTurn`: a turn ran.
   */
  async function setModel(
    value: string,
  ): Promise<
    | { ok: true; model: string | null; nextTurn: boolean }
    | { ok: false; reason: string }
  > {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    const models = driver.models;
    if (!models) return refuse(`${agentName} cannot switch models`);
    if (rewinds.running())
      return refuse("A rewind is running; switch once it is done");
    if (stopping) return refuse("The session is being handed back");
    let child: HeadlessProcess;
    try {
      child = await ensureProcess();
    } catch (error) {
      return refuse(
        `${agentName} did not start (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const nextTurn = turn || compacting;
    let result:
      | { ok: true; model: string | null }
      | { ok: false; reason: string };
    try {
      result = await models.set(
        { control: (kind, params) => control(child, kind, params) },
        value,
      );
    } catch (error) {
      result = refuse(error instanceof Error ? error.message : String(error));
    }
    if (result.ok) {
      model = result.model ?? model;
      chosenModel = value;
    }
    // What waited for a process (a start that failed) goes now, on it.
    if (queue.length && !disposed) flushQueue();
    return result.ok ? { ...result, nextTurn } : result;
  }

  /**
   * Runs something of /mcp on the session's process, started when none
   * runs: only it knows its servers, and a start costs no turn. Looking
   * counts as activity, so no idle stop ends a sign-in under way.
   */
  async function withMcp<T>(
    waitMs: number,
    run: (
      mcp: McpDriver,
      context: ModelContext,
    ) => Promise<T | { ok: false; reason: string }>,
  ): Promise<T | { ok: false; reason: string }> {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    const mcp = driver.mcp;
    if (!mcp) return refuse(`${agentName} has no MCP servers to manage`);
    if (rewinds.running())
      return refuse("A rewind is running; try once it is done");
    if (stopping) return refuse("The session is being handed back");
    let child: HeadlessProcess;
    try {
      child = await ensureProcess();
    } catch (error) {
      return refuse(
        `${agentName} did not start (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    lastActivity = now();
    try {
      return await run(mcp, {
        control: (kind, params) => control(child, kind, params, waitMs),
      });
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    } finally {
      // What waited for a process (a start that failed) goes now, on it.
      if (queue.length && !disposed) flushQueue();
    }
  }

  /** The session's MCP servers (/mcp), or why they cannot be told. */
  function mcpStatus() {
    return withMcp<{ ok: true; servers: AgentChatMcpServer[] }>(
      Math.min(mcpWaitMs, 20_000),
      (mcp, context) => mcp.status(context),
    );
  }

  /** Acts on one of the session's MCP servers (/mcp). */
  function mcpAction(request: AgentChatMcpRequest) {
    return withMcp<AgentChatMcpResult>(mcpWaitMs, (mcp, context) =>
      mcp.act(context, request),
    );
  }

  /**
   * Moves the running command or subagent the tool call `toolUseId`
   * started to the background, as Ctrl+B does in the terminal; all of the
   * turn's when none is named. The call returns at once and the turn goes
   * on; the task keeps running and its end is notified. `backgrounded`:
   * a named call was found running in the foreground.
   */
  async function background(
    toolUseId?: string,
  ): Promise<
    { ok: true; backgrounded: boolean } | { ok: false; reason: string }
  > {
    const child = proc;
    if (!driver.capabilities.backgroundTools)
      return { ok: false, reason: `${agentName} cannot do that` };
    if (!child || ending || stopping || disposed || (!turn && !compacting))
      return { ok: false, reason: "Nothing runs in the foreground" };
    const answer = await control(
      child,
      "background_tasks",
      toolUseId ? { tool_use_id: toolUseId } : {},
      Math.min(rewindWaitMs, 5000),
    );
    if (!answer) return { ok: false, reason: `${agentName} did not answer` };
    if (answer.error) return { ok: false, reason: answer.error };
    lastActivity = now();
    return {
      ok: true,
      backgrounded: toolUseId ? answer.response?.backgrounded !== false : true,
    };
  }

  /** Stops one of the session's background tasks (its task or agent id). */
  async function stopTask(
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const child = proc;
    if (!driver.capabilities.backgroundTools)
      return { ok: false, reason: `${agentName} cannot do that` };
    if (!child || ending || disposed)
      return { ok: false, reason: `${agentName} is not running` };
    const answer = await control(
      child,
      "stop_task",
      { task_id: taskId },
      Math.min(rewindWaitMs, 5000),
    );
    if (!answer) return { ok: false, reason: `${agentName} did not answer` };
    if (answer.error) return { ok: false, reason: answer.error };
    return { ok: true };
  }

  /** What a rewind needs of this session. */
  const rewindContext: RewindContext = {
    sessionId: () => sessionId,
    ensureProcess: () => ensureProcess(),
    stopProcess: () => stopProcess(),
    control,
    ...(options.readTranscript
      ? { readTranscript: options.readTranscript }
      : {}),
    log,
  };

  // Rewinds, through the driver: while one runs nothing is written (what
  // is sent waits in the queue) and no handover may cut it.
  const rewinds = createSessionRewind({
    driver,
    context: rewindContext,
    stopping: () => stopping,
    queueLength: () => queue.length,
    busy,
    running: () => ({ process: proc !== null, prompts: prompts.size }),
    interrupt,
    waitForResult,
    interruptWaitMs,
    emit,
    pushStatus,
    flushQueue: () => {
      if (!disposed) flushQueue();
    },
  });
  const { rewind, rewindCheck } = rewinds;

  function busy() {
    return (
      turn ||
      compacting ||
      prompts.size > 0 ||
      delivering > 0 ||
      rewinds.running()
    );
  }

  /**
   * Closes stdin and waits for the process to exit, killing it if it does
   * not. True once no process runs. Over SSH, killing the ssh client says
   * nothing of the claude on the host: that stays false (unsure).
   */
  async function stopProcess(): Promise<boolean> {
    // A start waiting (for an SSH slot, say) gives up; one that already
    // spawned leaves its process to be ended below.
    spawnAbort?.abort();
    if (starting) await starting.catch(() => undefined);
    const child = proc;
    if (!child) return true;
    const done = exited ?? child.exited.then(() => undefined);
    ending = true;
    child.end();
    const gone = await Promise.race([
      done.then(() => true),
      delay(stopWaitMs).then(() => false),
    ]);
    if (gone) return true;
    log("conversation process did not exit; killing it", {
      session: sessionId,
    });
    child.kill();
    return Promise.race([
      done.then(() => true),
      delay(stopWaitMs).then(() => false),
    ]);
  }

  return {
    paneId: options.paneId,
    sessionId: () => sessionId,
    cwd: options.cwd,
    alive: () => proc !== null || starting !== null,
    pid: () => proc?.pid ?? null,
    /**
     * A turn runs, a prompt waits, or a message is on its way to stdin: no
     * handover now.
     */
    busy,
    /**
     * A turn runs, with nothing asked of the user: what may hang, and
     * since when nothing came from it (epoch ms), and whether a tool runs.
     */
    activity: () => ({
      running: (turn || compacting) && prompts.size === 0,
      since: lastActivity,
      tools: tools.size > 0,
    }),
    /** Tasks that may outlive their turn (background commands, agents). */
    backgroundTasks: () => tasks.size,
    state: () => ({
      status: status(),
      tools_running: tools.size > 0,
      running_tools: [...tools],
      activity: shownActivity(),
      queue: queue.map((item) => ({ ...item })),
      next_prompt: nextPrompt ? { ...nextPrompt } : null,
    }),
    /** The reply text sent so far of the turn that runs, by block. */
    streamed: (): AgentChatStreamedText[] => reply.streamed(),
    /**
     * Starts the process ahead of the first turn. When it cannot start,
     * what was typed meanwhile stays queued and the chat says so.
     */
    warm: () =>
      ensureProcess().then(
        () => flushQueue(),
        (error: unknown) => {
          if (queue.length)
            emit({
              type: "notice",
              kind: "error",
              text: `${agentName} did not start (${error instanceof Error ? error.message : String(error)}); the queued messages wait for the next one you send`,
            });
          throw error;
        },
      ),

    /**
     * A typed message: written now when Claude is idle, else held in
     * Roamgate's queue (editable) until the turn ends.
     */
    async send(input: { text: string; images?: string[]; uuid?: string }) {
      const text = input.text.trim();
      const images = input.images ?? [];
      if (!text && !images.length) throw new Error("Nothing to send");
      if (input.uuid && !take(input.uuid))
        return {
          status: queue.some((each) => each.id === input.uuid)
            ? ("queued" as const)
            : ("sent" as const),
          id: input.uuid,
        };
      const item: AgentChatQueued = {
        id: input.uuid ?? randomUUID(),
        text,
        images,
        queued_at: new Date().toISOString(),
      };
      if (!ready()) {
        queue.push(item);
        pushQueue();
        return { status: "queued" as const, id: item.id };
      }
      if (queue.length) {
        // Left from a start that failed: they go first, with this one.
        queue.push(item);
        pushQueue();
        return {
          status: (await drainQueue(item.id))
            ? ("sent" as const)
            : ("queued" as const),
          id: item.id,
        };
      }
      const id = await deliver(text, images, input.uuid);
      return { status: "sent" as const, id };
    },

    /** A spoken message, the barge-in mix (session-voice.ts). */
    voice: createVoiceInput({
      turn: () => ({
        running: turn,
        compacting,
        prompts: prompts.size,
        tools: tools.size,
        lastBlock,
      }),
      ready,
      take,
      queued: (id) => queue.some((each) => each.id === id),
      queueLength: () => queue.length,
      enqueue: (item) => {
        queue.push(item);
        pushQueue();
      },
      drainQueue,
      deliver,
      interrupt,
      waitForResult,
      interruptWaitMs,
      delivering: (change) => {
        delivering += change;
      },
      steerMessage: (text, uuid) => userMessage(text, [], uuid, [], true),
      write,
      remember,
    }),

    interrupt,
    waitForResult,
    rewind,
    rewindCheck,
    listModels,
    setModel,
    mcpStatus,
    mcpAction,
    background,
    stopTask,
    /** The model the process runs, as it last said; null: not known. */
    model: () => model,
    /** The name the user last switched it to (/model); null: none. */
    chosenModel: () => chosenModel,

    editQueued(id: string, text: string): boolean {
      const item = queue.find((each) => each.id === id);
      if (!item) return false;
      item.text = text.trim();
      pushQueue();
      return true;
    },
    removeQueued(id: string): AgentChatQueued | null {
      const at = queue.findIndex((each) => each.id === id);
      if (at < 0) return null;
      const [item] = queue.splice(at, 1);
      pushQueue();
      return item ?? null;
    },
    queueLength: () => queue.length,
    /** The queue, emptied: kept elsewhere while no process holds it. */
    takeQueue(): AgentChatQueued[] {
      return queue.splice(0).map((item) => ({ ...item }));
    },

    /**
     * Stops the process of an idle session (idle stop): nothing runs, waits
     * or is on its way. The holder keeps the pane; the next message starts
     * a process again ("Waking"), and one written while this stop runs
     * waits for it and starts the next. False when it was not idle, or the
     * process did not exit.
     */
    async sleep(): Promise<boolean> {
      if (
        !proc ||
        ending ||
        starting ||
        stopping ||
        disposed ||
        busy() ||
        queue.length ||
        tasks.size
      )
        return false;
      asleep = true;
      options.onAsleep?.(true);
      const stopped = await stopProcess();
      if (!stopped) log("an idle process did not stop", { session: sessionId });
      return stopped;
    },
    /** Its process is stopped for being idle, until a message wakes it. */
    asleep: () => asleep,
    /** When the process last said something, or a turn was written (ms). */
    idleSince: () => lastActivity,

    /** Closes stdin and waits for the process to exit (stopProcess). */
    async stop(): Promise<boolean> {
      stopping = true;
      try {
        return await stopProcess();
      } finally {
        stopping = false;
      }
    },

    /**
     * Reads the process the holder runs for this session, if any (one a
     * runtime before this one started); its turn, prompts and reply so far
     * come back. False when none runs.
     */
    /**
     * Where the process's lines were handled to, with the state they left:
     * what a runtime after this one takes up (ConversationResumeState).
     * Null when no process is read; undefined while that is not known yet
     * (it is being attached, or replayed): an earlier save still holds.
     */
    resumeState():
      | {
          child: number;
          epoch_offset: number;
          offset: number;
          state: ConversationResumeState;
        }
      | null
      | undefined {
      if (starting || attaching || muted) return undefined;
      if (!proc || ending || disposed) return null;
      const position = proc.position?.();
      if (!position) return null;
      const state: ConversationResumeState = {
        version: 1,
        turn,
        compacting,
        activity,
        last_block: lastBlock,
        tools: [...tools],
        tasks: [...tasks],
        prompts: [...deferred.values(), ...asking.values()],
        next_prompt: nextPrompt ? { ...nextPrompt } : null,
        // Deltas not sent yet are part of the text so far.
        streamed: reply.snapshot(),
        turn_uuid: turnUuid,
        respawned_for_queue: respawnedForQueue,
        taken: [...taken],
        recent: [...recent].map(([uuid, message]) => [uuid, { ...message }]),
        parser: codec.save(),
      };
      const kept = keptResumeState(state);
      return kept ? { ...position, state: kept } : null;
    },

    async attach(): Promise<boolean> {
      if (!(await ensureProcess(true))) return false;
      // Its turn, prompts and tasks are known only once the lines that were
      // in are handled: nobody may act on the state before.
      await caughtUp;
      if (disposed) return false;
      // What waited goes once it is idle (now, or at its result).
      if (!turn) flushQueue();
      return true;
    },

    /**
     * `detach`: this runtime goes, but the process runs on in the holder
     * (the next runtime reads it). Otherwise it is ended.
     */
    dispose(disposeOptions: { detach?: boolean } = {}) {
      disposed = true;
      spawnAbort?.abort();
      flushDeltas();
      for (const controller of prompts.values()) controller.abort();
      if (disposeOptions.detach && proc?.detach) {
        proc.detach();
        return;
      }
      proc?.end();
      proc?.kill();
    },
  };
}

export type ConversationSession = ReturnType<typeof createConversationSession>;
