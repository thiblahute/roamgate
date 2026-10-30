import { randomUUID } from "node:crypto";
import type {
  AgentChatEvent,
  AgentChatQueued,
  AgentChatStatus,
  AgentChatStreamedText,
  AgentChatVoiceAction,
} from "../../../shared/agentChat";
import type { AgentPromptAnswer, AgentQuestion } from "../../../shared/review";
import { parseQuestions } from "../review/agent-server";
import type { HeadlessProcess, SpawnHeadless } from "./headless";
import { createStreamParser, type StreamItem } from "./stream";

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
};

const STOP_WORDS =
  /^\s*(?:stop|stop it|stop now|arr[e\u00ea]te|halt)\s*[.!]*\s*$/i;

/** A spoken "stop": always an interrupt, never a message. */
export function isSpokenStop(text: string): boolean {
  return STOP_WORDS.test(text);
}

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
  const log = options.log ?? (() => {});

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
  // The turn's latest content block: only while it is reply text does
  // speech interrupt (the barge-in mix); otherwise it steers.
  let lastBlock: "text" | "thinking" | "tool_use" | null = null;
  const tools = new Set<string>();
  // Tasks (Bash commands, subagents) that may run past their turn.
  const tasks = new Set<string>();
  const prompts = new Map<string, AbortController>();
  const interrupts = new Map<string, () => void>();
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
    activity: string | null;
  } | null = null;
  let parser = createStreamParser();
  // Replaying what an earlier reader handled already (after a new runtime
  // or a restart): the state is rebuilt, nothing reaches the browsers, and
  // the prompts still open at its end are asked again, once.
  let muted = false;
  const deferred = new Map<
    string,
    Extract<StreamItem, { kind: "permission_request" }>
  >();
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

  // Deltas wait here for about a frame, per block.
  const pending = new Map<
    string,
    { message_id: string; index: number; text: string }
  >();
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;

  // The reply text the browsers were sent of the turn that runs, by block:
  // a browser that subscribes in the middle of it (a reload) starts from
  // there, not from the next delta.
  const streamed = new Map<string, AgentChatStreamedText>();

  function track(event: AgentChatEvent) {
    switch (event.type) {
      case "delta": {
        const key = `${event.message_id}:${event.index}`;
        const block = streamed.get(key);
        if (block) block.text += event.text;
        else
          streamed.set(key, {
            message_id: event.message_id,
            index: event.index,
            text: event.text,
            done: false,
          });
        return;
      }
      case "block_stop": {
        const key = `${event.message_id}:${event.index}`;
        const block = streamed.get(key);
        if (event.text !== undefined)
          streamed.set(key, {
            message_id: event.message_id,
            index: event.index,
            text: event.text,
            done: true,
          });
        else if (block) block.done = true;
        return;
      }
      case "abandoned":
        for (const [key, block] of streamed)
          if (
            block.message_id === event.message_id &&
            block.index >= event.from_index
          )
            streamed.delete(key);
        return;
      case "result":
      case "session":
        streamed.clear();
        return;
    }
  }

  function flushDeltas() {
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = null;
    for (const delta of pending.values()) {
      const event = { type: "delta" as const, ...delta };
      track(event);
      if (!muted) options.emit(event);
    }
    pending.clear();
  }

  function emit(event: AgentChatEvent) {
    flushDeltas();
    track(event);
    if (!muted) options.emit(event);
  }

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

  function pushStatus() {
    const now = {
      status: status(),
      tools: tools.size > 0,
      activity: turn || compacting ? activity : null,
    };
    if (
      lastStatus &&
      lastStatus.status === now.status &&
      lastStatus.tools === now.tools &&
      lastStatus.activity === now.activity
    )
      return;
    const changed = lastStatus?.status !== now.status;
    lastStatus = now;
    emit({
      type: "status",
      status: now.status,
      tools_running: now.tools,
      activity: now.activity,
    });
    if (changed) options.onStatus?.(now.status);
  }

  function pushQueue() {
    emit({ type: "queue", queue: queue.map((item) => ({ ...item })) });
    // A message queued while the process starts waits on it.
    pushStatus();
  }

  function write(value: unknown) {
    if (!proc || ending) throw new Error("The conversation process is closing");
    proc.write(`${JSON.stringify(value)}\n`);
  }

  async function userMessage(text: string, images: string[], uuid: string) {
    const blocks = await Promise.all(
      images.map(async (path) => ({
        type: "image",
        source: { type: "base64", ...(await options.readImage(path)) },
      })),
    );
    return {
      type: "user",
      uuid,
      message: {
        role: "user",
        content: blocks.length
          ? [...(text ? [{ type: "text", text }] : []), ...blocks]
          : text,
      },
    };
  }

  /** Writes a turn's message; the process starts first when it is not up. */
  async function deliver(
    text: string,
    images: string[],
    uuid: string = randomUUID(),
  ) {
    delivering += 1;
    try {
      const message = await userMessage(text, images, uuid);
      await ensureProcess();
      write(message);
      remember(uuid, text, images);
    } finally {
      delivering -= 1;
    }
    turnUuid = uuid;
    turn = true;
    activity = null;
    lastBlock = null;
    options.onTurn?.(true);
    pushStatus();
    return uuid;
  }

  function handle(item: StreamItem) {
    switch (item.kind) {
      case "init":
        if (item.session_id !== sessionId) {
          const previous = sessionId;
          sessionId = item.session_id;
          emit({ type: "session", session_id: sessionId, previous });
          options.onSessionId?.(sessionId, previous);
        }
        return;
      case "reset": {
        const previous = sessionId;
        if (item.new_session_id === previous) return;
        sessionId = item.new_session_id;
        emit({ type: "session", session_id: sessionId, previous });
        options.onSessionId?.(sessionId, previous);
        return;
      }
      case "status":
        if (item.status === "requesting") turn = true;
        compacting = item.status === "compacting";
        if (compacting) activity = "compacting";
        else if (activity === "compacting") activity = null;
        pushStatus();
        return;
      case "block_start":
        turn = true;
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
      case "delta": {
        const key = `${item.message_id}:${item.index}`;
        const held = pending.get(key);
        if (held) held.text += item.text;
        else
          pending.set(key, {
            message_id: item.message_id,
            index: item.index,
            text: item.text,
          });
        deltaTimer ??= setTimeout(flushDeltas, coalesceMs);
        return;
      }
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
        });
        return;
      case "abandoned":
        // An interrupt abandons the reply it cut: Claude Code keeps that
        // partial text in the transcript, so the chat keeps it too.
        if (interrupting) return;
        // A retry's blocks: their deltas never reach the browser either.
        for (const [key, held] of pending)
          if (
            held.message_id === item.message_id &&
            held.index >= item.from_index
          )
            pending.delete(key);
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
        prompts.get(item.request_id)?.abort();
        return;
      case "control_response": {
        const done = interrupts.get(item.request_id);
        if (done) {
          interrupts.delete(item.request_id);
          done();
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
    }
  }

  async function answerPermission(
    item: Extract<StreamItem, { kind: "permission_request" }>,
  ) {
    const controller = new AbortController();
    prompts.set(item.request_id, controller);
    pushStatus();
    const input =
      item.input && typeof item.input === "object"
        ? (item.input as Record<string, unknown>)
        : {};
    const questions =
      item.tool_name === "AskUserQuestion"
        ? parseQuestions(JSON.stringify(input.questions ?? []))
        : [];
    let answer: AgentPromptAnswer | null = null;
    try {
      answer = await options.ask({
        tool: item.tool_name,
        input: questions.length
          ? { question: questions[0]!.question }
          : item.input,
        canAlways: !questions.length && item.suggestions.length > 0,
        ...(questions.length ? { questions } : {}),
        timeoutMs: questions.length ? questionTimeoutMs : permissionTimeoutMs,
        signal: controller.signal,
      });
    } catch (error) {
      log("permission prompt failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (prompts.get(item.request_id) !== controller) return;
    prompts.delete(item.request_id);
    // Cancelled by the CLI (an interrupt): it expects no answer.
    if (!controller.signal.aborted && proc) {
      let response: Record<string, unknown>;
      if (answer && typeof answer === "object")
        response = {
          behavior: "allow",
          updatedInput: { ...input, answers: answer.answers },
        };
      else if (answer === "allow")
        response = { behavior: "allow", updatedInput: item.input };
      else if (answer === "always")
        response = {
          behavior: "allow",
          updatedInput: item.input,
          updatedPermissions: item.suggestions,
        };
      else
        response = {
          behavior: "deny",
          message:
            answer === "deny"
              ? "The user said no from Roamgate"
              : "Nobody answered in Roamgate in time",
          interrupt: false,
        };
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: item.request_id,
          response,
        },
      });
    }
    pushStatus();
  }

  /** Whether a message written now would start a turn at once. */
  function ready() {
    return (
      !turn && !compacting && !prompts.size && !starting && delivering === 0
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
    starting = (async () => {
      await Promise.resolve();
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
      parser = createStreamParser();
      options.onProcess?.(child.pid ?? null, resumed);
      log("conversation process started", { session: sessionId });
      exited = read(child);
      return child;
    })().finally(() => {
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
      activity = null;
      lastBlock = null;
      options.onTurn?.(true);
      pushStatus();
    } else if (
      note.kind === "control_response" &&
      typeof note.request_id === "string"
    ) {
      deferred.delete(note.request_id);
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
      let message: { uuid?: unknown; message?: { content?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const uuid =
        typeof message.uuid === "string" ? message.uuid : randomUUID();
      const known = recent.get(uuid);
      const content = message.message?.content;
      const text =
        known?.text ??
        (typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .flatMap((block: { type?: unknown; text?: unknown }) =>
                  block?.type === "text" && typeof block.text === "string"
                    ? [block.text]
                    : [],
                )
                .join("\n\n")
            : "");
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
      log("messages claude never got go back in the queue", {
        session: sessionId,
        count: items.length,
      });
      queue.unshift(...items);
      pushQueue();
    }
    return items.map((item) => item.id);
  }

  async function read(child: HeadlessProcess) {
    const replayed = child.replayed ?? 0;
    const catchUp = Math.max(child.catchUp ?? 0, replayed);
    const done = Promise.withResolvers<void>();
    caughtUp = done.promise;
    let index = 0;
    muted = replayed > 0;
    catching = catchUp > 0;
    if (!catching) done.resolve();
    try {
      for await (const line of child.lines) {
        index += 1;
        if (line.startsWith('{"type":"roamgate_input"')) holderNote(line);
        else for (const item of parser.line(line)) handle(item);
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
    for (const done of interrupts.values()) done();
    interrupts.clear();
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
        text: `Claude stopped in the middle of the turn (exit ${code})`,
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
          text: "Claude stopped again; the queued messages wait for the next one you send",
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
    write({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    });
    const ok = await Promise.race([
      confirmed.then(() => true),
      delay(interruptWaitMs).then(() => false),
    ]);
    interrupts.delete(requestId);
    return ok;
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
    busy: () => turn || compacting || prompts.size > 0 || delivering > 0,
    /** Tasks that may outlive their turn (background commands, agents). */
    backgroundTasks: () => tasks.size,
    state: () => ({
      status: status(),
      tools_running: tools.size > 0,
      activity: turn || compacting ? activity : null,
      queue: queue.map((item) => ({ ...item })),
    }),
    /** The reply text sent so far of the turn that runs, by block. */
    streamed: (): AgentChatStreamedText[] =>
      [...streamed.values()].map((block) => ({ ...block })),
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
              text: `Claude did not start (${error instanceof Error ? error.message : String(error)}); the queued messages wait for the next one you send`,
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

    /**
     * A spoken message, the barge-in mix: "stop" interrupts; while Claude
     * is writing reply text the turn is interrupted (the partial reply
     * stays) and the speech becomes the next turn; at any other point of a
     * turn (tools, thinking, between two steps) the speech goes to stdin
     * now and steers the same turn. A pending prompt is left alone: the
     * speech waits in the queue.
     */
    async voice(input: {
      text: string;
      stop?: boolean;
      uuid?: string;
    }): Promise<{ action: AgentChatVoiceAction; id?: string }> {
      const text = input.text.trim();
      if (input.stop || isSpokenStop(text)) {
        await interrupt();
        return { action: "interrupted" };
      }
      if (!text) throw new Error("Nothing to send");
      if (input.uuid && !take(input.uuid))
        return {
          action: queue.some((each) => each.id === input.uuid)
            ? "queued"
            : "sent",
          id: input.uuid,
        };
      if (ready()) {
        if (!queue.length) {
          const id = await deliver(text, [], input.uuid);
          return { action: "sent", id };
        }
        // Left from a start that failed: they go first, with this one.
        const id = input.uuid ?? randomUUID();
        queue.push({
          id,
          text,
          images: [],
          queued_at: new Date().toISOString(),
        });
        pushQueue();
        return { action: (await drainQueue(id)) ? "sent" : "queued", id };
      }
      if (!turn || prompts.size || compacting) {
        const item: AgentChatQueued = {
          id: input.uuid ?? randomUUID(),
          text,
          images: [],
          queued_at: new Date().toISOString(),
        };
        queue.push(item);
        pushQueue();
        return { action: "queued", id: item.id };
      }
      if (tools.size || lastBlock !== "text") {
        const id = input.uuid ?? randomUUID();
        delivering += 1;
        try {
          const message = await userMessage(text, [], id);
          // The turn may have ended meanwhile: then it is a turn of its own.
          if (!turn) return { action: "sent", id: await deliver(text, [], id) };
          write(message);
          remember(id, text, []);
        } finally {
          delivering -= 1;
        }
        return { action: "steered", id };
      }
      await interrupt();
      await waitForResult(interruptWaitMs);
      const id = await deliver(text, [], input.uuid);
      return { action: "interrupted_then_sent", id };
    },

    interrupt,
    waitForResult,

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
     * Closes stdin and waits for the process to exit, killing it if it does
     * not. True once no process runs. Over SSH, killing the ssh client says
     * nothing of the claude on the host: that stays false (unsure).
     */
    async stop(): Promise<boolean> {
      stopping = true;
      try {
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
        const killed = await Promise.race([
          done.then(() => true),
          delay(stopWaitMs).then(() => false),
        ]);
        return killed;
      } finally {
        stopping = false;
      }
    },

    /**
     * Reads the process the holder runs for this session, if any (one a
     * runtime before this one started); its turn, prompts and reply so far
     * come back. False when none runs.
     */
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
