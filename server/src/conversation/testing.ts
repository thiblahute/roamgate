import type {
  ConversationHerdr,
  HerdrAgentState,
  PaneProcessInfo,
  WriterElsewhere,
} from "./herdr";
import type { HeadlessProcess, HeadlessSpawnOptions } from "./headless";

/** Lets queued promise callbacks run, without timers. */
export async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/**
 * A stand-in for a headless claude: the test pushes stream-json events,
 * reads what was written to stdin, and decides when it exits. `respond`
 * answers writes (an interrupt's control_response, say).
 */
export function fakeClaudeProcess(
  options: {
    pid?: number;
    /** Exit as soon as stdin closes. */
    exitOnEnd?: boolean;
    respond?: (message: Record<string, unknown>, process: FakeClaude) => void;
  } = {},
) {
  const items: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const exit = Promise.withResolvers<number>();
  const written: Record<string, unknown>[] = [];
  let ended = false;
  let killed = false;
  async function* lines() {
    for (;;) {
      if (items.length) {
        yield items.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const fake = {
    written,
    get ended() {
      return ended;
    },
    get killed() {
      return killed;
    },
    alive: true,
    push(event: unknown) {
      items.push(JSON.stringify(event));
      wake?.();
      wake = undefined;
    },
    exit(code = 0) {
      closed = true;
      fake.alive = false;
      wake?.();
      wake = undefined;
      exit.resolve(code);
    },
    process: {} as HeadlessProcess,
  };
  fake.process = {
    lines: lines(),
    write(line) {
      if (ended) throw new Error("The Claude Code process is closing");
      const message = JSON.parse(line) as Record<string, unknown>;
      written.push(message);
      options.respond?.(message, fake);
    },
    end() {
      ended = true;
      if (options.exitOnEnd) fake.exit(0);
    },
    kill() {
      killed = true;
      fake.exit(143);
    },
    exited: exit.promise,
    pid: options.pid ?? 4242,
  };
  return fake;
}

export type FakeClaude = ReturnType<typeof fakeClaudeProcess>;

/** A turn's successful result line, as claude prints it. */
export const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
};

/** Answers an interrupt as the CLI does: a control_response, then a result. */
export function answerInterrupts(
  message: Record<string, unknown>,
  process: FakeClaude,
) {
  const request = message.request as { subtype?: string } | undefined;
  if (message.type !== "control_request" || request?.subtype !== "interrupt")
    return;
  process.push({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: message.request_id,
      response: { still_queued: [] },
    },
  });
  process.push({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
  });
}

/**
 * Answers rewinds as the CLI does (rewind_files, rewind_conversation);
 * `answers` overrides what each subtype answers.
 */
export function answerRewinds(
  answers: {
    files?: Record<string, unknown>;
    conversation?: Record<string, unknown>;
  } = {},
) {
  return (message: Record<string, unknown>, process: FakeClaude) => {
    answerInterrupts(message, process);
    const request = message.request as
      | {
          subtype?: string;
          user_message_id?: string;
          target_message_uuid?: string;
        }
      | undefined;
    if (message.type !== "control_request") return;
    let response: Record<string, unknown> | null = null;
    if (request?.subtype === "rewind_files")
      response = answers.files ?? {
        canRewind: true,
        filesChanged: ["/work/a.txt"],
        insertions: 1,
        deletions: 2,
      };
    else if (request?.subtype === "rewind_conversation")
      response = answers.conversation ?? {
        rewound: true,
        targetMessageUuid: request.target_message_uuid,
        prefillText: "the message",
        precedingAssistantUuid: "a0",
      };
    if (!response) return;
    process.push({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response,
      },
    });
  };
}

/** A spawner handing out fakes, recording each start. */
export function fakeSpawner(
  make: () => FakeClaude = () =>
    fakeClaudeProcess({ exitOnEnd: true, respond: answerInterrupts }),
) {
  const spawned: { options: HeadlessSpawnOptions; fake: FakeClaude }[] = [];
  // Processes a holder runs already: an attach takes them, in order.
  const running: FakeClaude[] = [];
  return {
    spawned,
    running,
    spawn: async (options: HeadlessSpawnOptions) => {
      if (options.attachOnly) return running.shift()?.process ?? null;
      const fake = make();
      spawned.push({ options, fake });
      return fake.process;
    },
    alive: () => spawned.filter((each) => each.fake.alive),
  };
}

export type FakeHerdrPane = {
  agent: Record<string, unknown> | null;
  screen: string;
  process: PaneProcessInfo;
};

export const IDLE_SCREEN = [
  "  some answer",
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "\u276f ",
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "  -- INSERT -- \u23f5\u23f5 auto mode on",
].join("\n");

/** Claude idle at its prompt, a background shell still running. */
export const BACKGROUND_SCREEN = [
  "\u273b Worked for 2m 54s \u00b7 1 shell still running",
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "\u276f ",
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
  "  -- INSERT -- \u23f5\u23f5 auto mode on \u00b7 1 shell \u00b7 \u2190 18 agents",
].join("\n");

/** A 38-column pane: the footer's "1 shell" lost its word. */
export const NARROW_SCREEN = [
  "\u273b Cooked for 4s \u00b7 done 12:48 PM \u00b7 1",
  "  shell still running",
  "",
  "\u2500".repeat(38),
  "\u276f",
  "\u2500".repeat(38),
  "  -- INSERT -- \u23f5\u23f5 auto mode on \u00b7 1",
].join("\n");

/** An 18-column pane: nothing of the work is left in the footer. */
export const NARROWEST_SCREEN = [
  "  done 12:41 PM \u00b7",
  "  1 shell still",
  "  running",
  "",
  "\u2500".repeat(18),
  "\u276f",
  "\u2500".repeat(18),
  "  -- INSERT -- \u23f5",
].join("\n");

/** A narrow pane with nothing running: the footer cannot say so. */
export const NARROW_IDLE_SCREEN = [
  "\u23fa ok",
  "\u2500".repeat(30),
  "\u276f",
  "\u2500".repeat(30),
  "  -- INSERT -- \u23f5\u23f5 auto mode",
].join("\n");

/** What /exit asks while background work runs. */
export const EXIT_DIALOG_SCREEN = [
  "\u276f /exit",
  "\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594",
  "   Background work is running",
  "   The following will stop when you exit:",
  "",
  "   shell \u00b7 cd /work/repo && ninja",
  "",
  "   \u276f 1. Exit and stop tasks",
  "     2. Move to background and exit",
  "     3. Stay",
  "",
  "   Enter to confirm \u00b7 Esc to cancel",
].join("\n");

/**
 * A Herdr that knows one pane with an idle claude. `/exit` ends the claude
 * (unless `exitIgnored`), and the holder command typed into the shell
 * "starts" the holder by calling `onHolder`.
 */
export function fakeHerdr(
  options: {
    sessionId?: string;
    cwd?: string;
    claudePid?: number;
    shellPid?: number;
    exitIgnored?: boolean;
    /**
     * /exit asks first (background work runs): Stay or Escape puts the
     * prompt back, the other answers end claude.
     */
    exitAsks?: boolean;
    onHolder?: (paneId: string) => void;
    /** Herdr maps the pane again when claude resumes. */
    remapOnResume?: boolean;
  } = {},
) {
  const sessionId = options.sessionId ?? "11111111-2222-3333-4444-555555555555";
  const cwd = options.cwd ?? "/work/repo";
  const claudePid = options.claudePid ?? 900;
  const shellPid = options.shellPid ?? 800;
  const live = new Set<number>([claudePid]);
  const calls: [string, ...unknown[]][] = [];
  const reports: { state: HerdrAgentState; sessionId: string }[] = [];
  // Headless claudes on the host, by the session id their argv resumes.
  const probe = {
    running: new Set<string>(),
    fails: false,
    /**
     * Another writer on the session, as writerElsewhere says it (text
     * alone: one outside Herdr's panes).
     */
    elsewhere: null as WriterElsewhere | string | null,
    /** The pane was closed. */
    closed: false,
  };
  const pane: FakeHerdrPane = {
    agent: {
      agent: "claude",
      agent_status: "idle",
      agent_session: { kind: "id", value: sessionId, source: "herdr:claude" },
      foreground_cwd: cwd,
    },
    screen: IDLE_SCREEN,
    process: {
      shell_pid: shellPid,
      foreground_process_group_id: claudePid,
      foreground_processes: [
        { pid: claudePid, argv: ["claude", "--resume", sessionId], cwd },
      ],
    },
  };
  const claudeExited = () => {
    live.delete(claudePid);
    pane.agent = null;
    pane.process = {
      shell_pid: shellPid,
      foreground_process_group_id: shellPid,
      foreground_processes: [],
    };
  };
  const herdr: ConversationHerdr = {
    async agentGet(paneId) {
      calls.push(["agentGet", paneId]);
      return pane.agent ? { ...pane.agent } : null;
    },
    async readDetection(paneId) {
      calls.push(["readDetection", paneId]);
      return pane.screen;
    },
    async processInfo(paneId) {
      calls.push(["processInfo", paneId]);
      return structuredClone(pane.process);
    },
    async prompt(paneId, text) {
      calls.push(["prompt", paneId, text]);
      if (text !== "/exit" || options.exitIgnored) return;
      if (options.exitAsks) pane.screen = EXIT_DIALOG_SCREEN;
      else claudeExited();
    },
    async sendKeys(paneId, keys) {
      calls.push(["sendKeys", paneId, keys]);
      if (pane.screen !== EXIT_DIALOG_SCREEN) return;
      if (keys === "3" || keys === "\x1b") pane.screen = BACKGROUND_SCREEN;
      else claudeExited();
    },
    async sendText(paneId, text) {
      calls.push(["sendText", paneId, text]);
      options.onHolder?.(paneId);
    },
    async reportAgent(params) {
      calls.push([
        "reportAgent",
        params.paneId,
        params.state,
        params.sessionId,
      ]);
      reports.push({ state: params.state, sessionId: params.sessionId });
    },
    async releaseAgent(paneId) {
      calls.push(["releaseAgent", paneId]);
    },
    async pidAlive(pid) {
      return live.has(pid);
    },
    async headlessRunning(sessionIds) {
      calls.push(["headlessRunning", ...sessionIds]);
      if (probe.fails) throw new Error("the host did not answer");
      return sessionIds.some((id) => probe.running.has(id));
    },
    async paneExists(paneId) {
      calls.push(["paneExists", paneId]);
      return !probe.closed;
    },
    async writerElsewhere(paneId) {
      calls.push(["writerElsewhere", paneId]);
      if (probe.fails) throw new Error("the host did not answer");
      return typeof probe.elsewhere === "string"
        ? { text: probe.elsewhere }
        : probe.elsewhere;
    },
  };
  return {
    herdr,
    pane,
    calls,
    reports,
    live,
    probe,
    sessionId,
    cwd,
    claudePid,
    /** The holder exec'd claude --resume: Herdr maps the pane again. */
    resumed(id = sessionId, pid = 901) {
      live.add(pid);
      pane.agent = {
        agent: "claude",
        agent_status: "idle",
        agent_session: { kind: "id", value: id, source: "herdr:claude" },
        foreground_cwd: cwd,
      };
      pane.process = {
        shell_pid: shellPid,
        foreground_process_group_id: pid,
        foreground_processes: [{ pid, argv: ["claude", "--resume", id], cwd }],
      };
    },
  };
}

/** A virtual clock for polling loops: sleeping advances it at once. */
export function virtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await Promise.resolve();
    },
  };
}
