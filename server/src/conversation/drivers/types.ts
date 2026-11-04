import type {
  AgentChatCapabilities,
  AgentChatRewindCheck,
  AgentChatRewindMode,
  AgentChatRewindResult,
  ConversationAgent,
} from "../../../../shared/agentChat";
import type {
  AgentPromptAnswer,
  AgentQuestion,
} from "../../../../shared/review";
import type { HeadlessProcess } from "../headless";
import type { PaneProcess } from "../herdr";
import type { ApiKeyAnswer } from "./claude-env";
import type { StreamItem } from "./claude-stream";

/**
 * Conversation mode's drivers: what one agent needs to be driven headless
 * (the protocol driver) and handed over to and from its TUI (the terminal
 * driver). The core (session, service, handover, holder) is the same for
 * every agent; it reaches the agent only through these.
 */

/**
 * What one line of the headless process means, normalized: every driver's
 * codec turns its own protocol into these.
 */
export type DriverEvent = StreamItem;

/** A permission or a question the process asks the user. */
export type PromptRequest = Extract<
  DriverEvent,
  { kind: "permission_request" }
>;

/** What the browser is asked for a PromptRequest. */
export type DriverPrompt = {
  tool: string;
  input: unknown;
  canAlways: boolean;
  /** A structured question rather than a permission. */
  questions?: AgentQuestion[];
};

/** An image of a message: inline data, or the upload's path on the host. */
export type DriverImage = { path: string; media_type?: string; data?: string };

export type DriverMessage = {
  text: string;
  images: DriverImage[];
  uuid: string;
  /** Texts read before the message's own (the `!` lines run since). */
  prelude: string[];
  /** Written while a turn runs: it steers that turn. */
  steer: boolean;
};

/** What the pane holder is told to run (its start command). */
export type HolderStartCommand = Record<string, unknown>;

export type StartOptions = {
  sessionId: string;
  /** The pane it runs in: the headless process is told it (PANE_NAMES). */
  paneId?: string;
  cwd: string;
  /** The pane's TUI's kept flags (the lease's terminal_args). */
  flags?: string[];
  /** The user's answer about the pane's API key, filed by the holder. */
  apiKeyAnswer?: ApiKeyAnswer;
};

/**
 * One process's protocol: decodes its lines into DriverEvents and encodes
 * what is written to it. Its state is serializable (save/restore), so a
 * runtime after this one reads on where this one stopped.
 */
export type DriverCodec = {
  line(line: string): DriverEvent[];
  save(): unknown;
  restore(state: unknown): void;
  /** The lines that write a user message. */
  message(message: DriverMessage): string[];
  /** The lines that stop the turn; a `control_response` event confirms. */
  interrupt(requestId: string): string[];
  /** The lines that answer a prompt; null: nobody answered in time. */
  answer(request: PromptRequest, answer: AgentPromptAnswer | null): string[];
  /** A request of the agent's own (rewind steps...); null: not supported. */
  request(
    kind: string,
    params: Record<string, unknown>,
    requestId: string,
  ): string[] | null;
};

/** A control request's answer; null when none came in time. */
export type ControlAnswer = {
  error?: string;
  response?: Record<string, unknown>;
} | null;

/** What a rewind needs of the session that runs it. */
export type RewindContext = {
  sessionId(): string;
  /** Starts the process when it is not up. */
  ensureProcess(): Promise<HeadlessProcess>;
  /** Ends the process; true once none runs. */
  stopProcess(): Promise<boolean>;
  control(
    child: HeadlessProcess,
    kind: string,
    params: Record<string, unknown>,
  ): Promise<ControlAnswer>;
  readTranscript?: () => Promise<string | Record<string, unknown>[] | null>;
  log(message: string, fields?: Record<string, unknown>): void;
};

export type RewindDriver = {
  /** What a transcript (text or records) says of a rewind to before `uuid`. */
  checkTranscript(
    transcript: string | Record<string, unknown>[] | null,
    uuid: string,
  ): AgentChatRewindCheck;
  /** What a rewind to before `uuid` would do to the code; starts nothing. */
  check(context: RewindContext, uuid: string): Promise<AgentChatRewindCheck>;
  /** Rewinds, the session being idle and nothing written meanwhile. */
  run(
    context: RewindContext,
    input: { uuid: string; lastSeen?: string; mode: AgentChatRewindMode },
  ): Promise<AgentChatRewindResult>;
};

export type ProtocolDriver = {
  agent: ConversationAgent;
  /** The agent's name in every user-facing string ("Claude"). */
  displayName: string;
  capabilities: AgentChatCapabilities;
  /** What the holder runs: argv, cwd and environment changes. */
  startCommand(options: StartOptions): HolderStartCommand;
  createCodec(): DriverCodec;
  /** What the user is asked for a prompt request. */
  promptOf(request: PromptRequest): DriverPrompt;
  /**
   * What the holder notes of a line written to the process: a user
   * message (kind "user"), an answer to a request (answerKind, with its
   * request id), or anything else.
   */
  inputKind(line: string): { kind: string; request_id?: string };
  answerKind: string;
  /** A written user message the process never got, back to its text. */
  parseWrittenMessage(line: string): { uuid?: string; text: string } | null;
  /** Present when capabilities.rewind is. */
  rewind?: RewindDriver;
};

/** The TUI's screen, for a handover from the terminal. */
export type TerminalReadiness = {
  /** Background work exiting would stop (the switch waits for it). */
  background: string | null;
  /** False when the screen cannot say (a pane too narrow). */
  backgroundKnown: boolean;
  /** Why the TUI cannot be exited now (a draft, a dialog), if anything. */
  refusal: string | null;
};

export type TerminalDriver = {
  agent: ConversationAgent;
  /** Herdr's agent name for the TUI. */
  herdrAgent: string;
  displayName: string;
  /** A TUI of this agent, never the headless child. */
  isAgentProcess(process: PaneProcess): boolean;
  /** The TUI's flags its headless run and its resumed TUI keep. */
  keptFlags(process: PaneProcess): string[];
  readiness(screen: string): TerminalReadiness;
  /** What is typed into the TUI to exit it. */
  exitCommand: string;
  /** The TUI asks before exiting: the key that stays. */
  exitDialog(screen: string): { stayKey: string } | null;
  /** The background work the screen shows, if any. */
  backgroundWork(screen: string): string | null;
  /** The command line that resumes the session in the TUI. */
  resumeArgv(sessionId: string, flags: readonly string[]): string[];
  /** `ps -eo pid=,args=` lists a headless process on these sessions. */
  headlessProbe(ps: string, sessionIds: readonly string[]): boolean;
  /** The pid of an interactive TUI on these sessions, if any. */
  interactiveWriter(
    ps: string,
    sessionIds: readonly string[],
    exceptPids?: readonly number[],
  ): number | null;
};

export type ConversationDriver = {
  protocol: ProtocolDriver;
  terminal: TerminalDriver;
};
