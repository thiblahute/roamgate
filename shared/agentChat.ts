/**
 * Conversation mode: a Claude session driven by a headless, streaming
 * `claude -p` instead of the TUI in its pane. Only one of the two ever runs
 * on a session; the lease says which.
 */

/** Who writes to the session now. */
export type AgentChatOwner = "terminal" | "conversation";

/**
 * Where a session is in its life: owned by the terminal, being handed to
 * conversation mode (the TUI is exiting), owned by conversation mode, or
 * being handed back (the headless process is exiting).
 */
export type AgentChatPhase =
  | "terminal"
  | "to_conversation"
  | "conversation"
  | "to_terminal";

/**
 * The agents conversation mode drives (Herdr's agent names): each has a
 * driver on the server, a headless protocol and its terminal side.
 */
export type ConversationAgent = "claude";

const CONVERSATION_AGENTS: readonly string[] = ["claude"];

/** Whether conversation mode can drive this pane's agent. */
export function isConversationAgent(
  agent: unknown,
): agent is ConversationAgent {
  return typeof agent === "string" && CONVERSATION_AGENTS.includes(agent);
}

/** What a conversation's agent can do; the chat hides what it cannot. */
export type AgentChatCapabilities = {
  /** A message written mid-turn steers it. */
  steer: boolean;
  /** Structured questions to the user (cards with choices). */
  questions: boolean;
  /** Permission cards may offer "always". */
  alwaysAllow: boolean;
  /** `code`: the code is restored too, not only the conversation. */
  rewind: { conversation: boolean; code: boolean } | null;
  /** The agent guesses the next message (the next-prompt chip). */
  promptSuggestions: boolean;
  /**
   * `!` lines: run by Roamgate and read by the agent with the next message
   * ("prelude"), run by the agent itself ("native"), or not offered.
   */
  shellLines: "prelude" | "native" | null;
  /** Work that outlives a turn is tracked (/tasks, the background chip). */
  backgroundTasks: boolean;
  /** Images go inline ("base64") or as the uploaded file's host path. */
  images: "base64" | "path";
  /** Which slash command palette the composer offers. */
  slashCommands: "claude" | null;
};

export const CLAUDE_CAPABILITIES: AgentChatCapabilities = {
  steer: true,
  questions: true,
  alwaysAllow: true,
  rewind: { conversation: true, code: true },
  promptSuggestions: true,
  shellLines: "prelude",
  backgroundTasks: true,
  images: "base64",
  slashCommands: "claude",
};

/**
 * A conversation's capabilities: an older server sends none, and only
 * drove claude.
 */
export function chatCapabilities(
  state: { capabilities?: AgentChatCapabilities | null } | null | undefined,
): AgentChatCapabilities {
  return state?.capabilities ?? CLAUDE_CAPABILITIES;
}

export type AgentChatLease = {
  connection_id: string;
  pane_id: string;
  session_id: string;
  cwd: string;
  owner: AgentChatOwner;
  phase: AgentChatPhase;
  /** The agent conversation mode drives here; absent: claude. */
  agent?: ConversationAgent;
  /** The interactive claude's pid while it is being stopped. */
  terminal_pid?: number;
  /** The headless claude's pid while it runs (local connections). */
  headless_pid?: number;
  /**
   * The session ids headless processes were resumed with (their argv),
   * newest last: after /clear a process still names the old one. A probe
   * looks for any of them before another writer starts.
   */
  headless_session_ids?: string[];
  /**
   * The flags the pane's claude ran with (--model, --permission-mode...):
   * handing back resumes the session with them.
   */
  terminal_args?: string[];
  /**
   * Roamgate's queue of messages typed while a turn ran, kept here while
   * no process holds it (the connection was replaced, Roamgate restarted).
   */
  queue?: AgentChatQueued[];
  /**
   * When the turn that runs was written to the headless process: a
   * restart, or the process exiting, while this is set cut the turn short.
   */
  turn_started_at?: string;
  /** The last turn was cut short; cleared by the next turn or a dismiss. */
  interrupted?: AgentChatInterrupted;
  /**
   * Since when its headless process is stopped for being idle (idle stop):
   * the holder keeps the pane, and the next message starts it again.
   */
  asleep_at?: string;
  /**
   * The pane holder that runs the headless claude: how far Roamgate read
   * its log, and the commands it had not confirmed yet. A runtime after
   * this one reads on from there.
   */
  holder?: {
    id: string;
    offset: number;
    pending?: { seq: number; op: string; [key: string]: unknown }[];
    /**
     * Where the latest child's lines were handled to, with the state they
     * left the conversation in: the next runtime reads only what follows.
     */
    resume?: {
      child: number;
      epoch_offset: number;
      offset: number;
      state: unknown;
    };
  };
  updated_at: string;
};

/**
 * A turn cut short before its end: by a Roamgate restart, or by the
 * headless process exiting (a crash, a kill, an SSH connection lost). What
 * Claude Code had written stays in the transcript; the rest is gone.
 */
export type AgentChatInterrupted = {
  at: string;
  reason: "restart" | "process_exited";
};

/**
 * Roamgate cannot read the conversation process the pane holder runs (its
 * log does not come through, say): nothing is delivered until it is
 * recovered, which ends that process and starts a new one on the session.
 */
export type AgentChatLost = {
  at: string;
  /** Why, as Roamgate last saw it. */
  reason: string;
};

/**
 * A turn that seems to hang: nothing came from Claude (no output, the
 * transcript unchanged) for a long while, or Stop got no answer. The chat
 * offers Interrupt and Restart Claude (a recover).
 */
/**
 * The headless process was stopped after the session sat idle (the
 * `conversation.idle_stop_minutes` setting): the next message wakes it.
 */
export type AgentChatAsleep = {
  /** When it was stopped. */
  since: string;
};

/** How long a conversation sits idle before its process stops (minutes). */
export const DEFAULT_IDLE_STOP_MINUTES = 30;
/** The longest idle stop the setting takes: a day. */
export const MAX_IDLE_STOP_MINUTES = 24 * 60;

/** A valid `conversation.idle_stop_minutes`: 0 (off) to a day, whole. */
export function isIdleStopMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_IDLE_STOP_MINUTES
  );
}

export type AgentChatStuck = {
  /** When Claude last said something. */
  since: string;
  reason: "silent" | "stop_unanswered";
};

/**
 * The pane's environment has an Anthropic API key that Claude Code has no
 * answer for yet (the TUI asks once: use it, or the subscription login).
 * Claude does not start in conversation mode until the user answers; the
 * answer is filed where Claude Code keeps it, so the terminal asks no more.
 */
export type AgentChatApiKeyQuestion = {
  asked_at: string;
};

/** The user's answer: the API key (billed to the API), or the login. */
export type AgentChatApiKeyChoice = "api_key" | "login";

/** What the headless process is doing. */
export type AgentChatStatus =
  | "stopped"
  | "starting"
  | "idle"
  | "working"
  | "blocked";

export type AgentChatQueued = {
  id: string;
  text: string;
  /** Upload paths of the images sent with it. */
  images: string[];
  queued_at: string;
};

export type AgentChatState = {
  pane_id: string;
  owner: AgentChatOwner;
  phase: AgentChatPhase;
  session_id: string | null;
  cwd: string | null;
  status: AgentChatStatus;
  /**
   * The agent conversation mode drives in the pane, and what it can do
   * (see chatCapabilities); sent while a lease exists. An older server
   * sends neither: claude.
   */
  agent?: ConversationAgent;
  capabilities?: AgentChatCapabilities;
  /** A tool call is running: speech steers the turn instead of stopping it. */
  tools_running: boolean;
  /** What it is doing: a tool's name, "thinking", "compacting". */
  activity: string | null;
  queue: AgentChatQueued[];
  /** The last turn was cut short, until the next one starts. */
  interrupted: AgentChatInterrupted | null;
  /** The conversation process cannot be read: Recover starts a new one. */
  lost?: AgentChatLost | null;
  /** The turn seems to hang: Interrupt, or Restart Claude. */
  stuck?: AgentChatStuck | null;
  /** Its process is stopped while idle; the next message wakes it. */
  asleep?: AgentChatAsleep | null;
  /** Claude waits to start until the user says which account pays. */
  api_key_question?: AgentChatApiKeyQuestion | null;
  /**
   * `!` lines run from the chat that Claude has not read yet: running, or
   * done and waiting for the next message, which takes them to Claude.
   */
  shells?: AgentChatShell[];
  /**
   * On a subscription only: the reply text already streamed of the turn
   * that runs, so a browser that comes in the middle of it (a reload)
   * draws all of it, not just what streams after.
   */
  streamed?: AgentChatStreamedText[];
  /**
   * What Claude Code guesses the user will say next, after its last turn
   * (prompt suggestions on); gone once another turn starts.
   */
  next_prompt?: AgentChatNextPrompt | null;
};

/** Claude Code's predicted next user message. Never sent by itself. */
export type AgentChatNextPrompt = { uuid: string; text: string };

/**
 * A `!` line run from the chat on the pane's host, as Claude Code's bash
 * mode: its output so far, each stream cut at BASH_OUTPUT_LIMIT.
 */
export type AgentChatShell = {
  id: string;
  command: string;
  status: "running" | "done" | "stopped" | "failed";
  stdout: string;
  stderr: string;
  /** Output past the cap was left out (Claude reads the cap only). */
  truncated: boolean;
  /** Null while it runs, and when it was stopped or could not start. */
  exit_code: number | null;
  /** The directory it runs in, on the pane's host. */
  cwd?: string;
  started_at: string;
  finished_at?: string;
  /** Why it could not start or finish. */
  error?: string;
  /**
   * Sent to Claude with a message: the transcript shows it from now on.
   * The browser keeps the last few sent, for what the transcript does not
   * keep of them (how they ended).
   */
  delivered?: boolean;
};

/** A text block of the running turn, as streamed so far. */
export type AgentChatStreamedText = {
  message_id: string;
  index: number;
  text: string;
  /** Its complete text came (the CLI's assistant message). */
  done: boolean;
};

/**
 * Another Claude on the same session, in another pane of the pane's Herdr:
 * a switch to conversation mode waits until it is gone, as two writers
 * would mix their turns in one transcript. Only an idle one may be asked
 * to quit.
 */
export type AgentChatOtherWriter = {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  /** As Herdr names them; a browser that knows the pane names it itself. */
  workspace_label?: string;
  tab_label?: string;
  /** The agent's name, as shown: "Claude". */
  agent_name: string;
  /**
   * What Herdr says it does: idle (at its prompt, no turn running),
   * working (a turn or a background task), blocked (it waits for an
   * answer in its terminal), or unknown.
   */
  status: "idle" | "working" | "blocked" | "unknown";
  /** Why it did not quit when the user asked it to, if they did. */
  quit_refusal?: string;
};

/** Where the other writer is, by Herdr's names: "roamgate / Tab 2". */
export function otherWriterPlace(
  writer: Pick<
    AgentChatOtherWriter,
    "pane_id" | "workspace_label" | "tab_label"
  >,
): string {
  const names = [writer.workspace_label, writer.tab_label].filter(
    (name): name is string => !!name,
  );
  return names.length ? names.join(" / ") : `pane ${writer.pane_id}`;
}

/** What the other writer does, said after where it is: ", where Claude is idle". */
export function otherWriterDoing(
  writer: Pick<AgentChatOtherWriter, "agent_name" | "status">,
): string {
  const name = writer.agent_name;
  switch (writer.status) {
    case "idle":
      return `, where ${name} is idle`;
    case "working":
      return `, where ${name} is working`;
    case "blocked":
      return `, where ${name} waits for an answer`;
    default:
      return "";
  }
}

/** Why the switch waits for the other writer. */
export function otherWriterWhy(
  writer: Pick<AgentChatOtherWriter, "agent_name">,
): string {
  const name = writer.agent_name;
  return `Only one ${name} can write a session, so conversation mode waits until that one is closed`;
}

/** A refused or accepted handover, with the reason when refused. */
export type AgentChatHandoverResult =
  | {
      ok: true;
      owner: AgentChatOwner;
      session_id: string;
      confirmed?: boolean;
      detail?: string;
      /**
       * Handed back stopped (the chat's Ctrl+Z): the pane's shell has its
       * prompt, and `fg` there brings the conversation back.
       */
      suspended?: boolean;
    }
  | {
      ok: false;
      reason: string;
      /**
       * Refused for now, not for good: Claude's background work (a shell,
       * a monitor) would stop with it. A switch asked "when idle" waits on.
       */
      waiting?: "background_tasks";
      /**
       * Refused because another Claude runs the session in another pane:
       * which, so the user can go there or, when it is idle, have it quit
       * (`quit_writer` on the next switch).
       */
      writer?: AgentChatOtherWriter;
    };

/** What a rewind restores: as Claude Code's /rewind offers it. */
export type AgentChatRewindMode = "both" | "conversation" | "code";

/**
 * A rewind in conversation mode. `prefill` is the message rewound to, for
 * the chat's box; `files` the files the code restore changed. `code`, when
 * the code was asked for: "restored", or "none" when the turns rewound
 * changed no file Claude Code can restore (the conversation alone was cut).
 * Refused with `no_checkpoint`: files were edited (`files`, when known),
 * but Claude Code kept no checkpoint of them (edits from before checkpoints
 * were on); nothing was rewound, and the conversation alone still can be.
 */
export type AgentChatRewindResult =
  | {
      ok: true;
      prefill?: string;
      files?: string[];
      code?: "restored" | "none";
    }
  | { ok: false; reason: string; no_checkpoint?: true; files?: string[] };

/**
 * What a rewind to before a message could do to the code, known before the
 * user picks, from the transcript: "none" when the turns after it edited no
 * file with Claude's file tools, "no_checkpoint" when they did (`files`)
 * but Claude Code kept no checkpoint for the message, "restorable" when it
 * did, "unknown" when the transcript does not tell.
 */
export type AgentChatRewindCheck = {
  code: "restorable" | "none" | "no_checkpoint" | "unknown";
  files?: string[];
};

export type AgentChatBlockType = "text" | "thinking" | "tool_use";

/**
 * Events pushed to the browsers subscribed to a pane, as
 * `{event: "agent_chat.<type>", data}` in a connection envelope. Text blocks
 * are keyed by API message id and block index, which history entries carry
 * too (`message_id`, `block_index`); tools by their tool_use id.
 */
export type AgentChatEvent =
  | {
      type: "block_start";
      message_id: string;
      index: number;
      block: AgentChatBlockType;
      tool_use_id?: string;
      name?: string;
    }
  | { type: "delta"; message_id: string; index: number; text: string }
  | {
      type: "block_stop";
      message_id: string;
      index: number;
      /** The block's full text, or a tool call's input as JSON. */
      text?: string;
      /**
       * The text is what a command run in Claude Code itself printed: the
       * uuid of the transcript record that has it.
       */
      command_output?: { uuid: string };
    }
  /** A retry or an interrupt dropped these blocks: remove them. */
  | { type: "abandoned"; message_id: string; from_index: number }
  | {
      type: "tool_use";
      tool_use_id: string;
      name: string;
      input: unknown;
      message_id: string;
      index: number;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      is_error: boolean;
      text: string;
    }
  /** The CLI accepted a user message (its replay): settles the outbox. */
  | { type: "user"; uuid: string; text: string; images: number }
  | {
      type: "status";
      status: AgentChatStatus;
      tools_running: boolean;
      activity: string | null;
    }
  | { type: "queue"; queue: AgentChatQueued[] }
  /** A `!` line's progress; delivered ones leave the state. */
  | { type: "shell"; shell: AgentChatShell }
  /** A turn was cut short (or that notice went: null). */
  | { type: "interrupted"; interrupted: AgentChatInterrupted | null }
  /** The conversation process cannot be read (or can again: null). */
  | { type: "lost"; lost: AgentChatLost | null }
  /** The turn seems to hang (or not any more: null). */
  | { type: "stuck"; stuck: AgentChatStuck | null }
  /** Its process was stopped while idle (or woke up again: null). */
  | { type: "asleep"; asleep: AgentChatAsleep | null }
  /** The API key question waits for an answer (or not any more: null). */
  | {
      type: "api_key_question";
      api_key_question: AgentChatApiKeyQuestion | null;
    }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      interrupted: boolean;
      text: string;
      cost_usd?: number;
      duration_ms?: number;
    }
  /** A predicted next message after a turn, or none any more (null). */
  | { type: "next_prompt"; next_prompt: AgentChatNextPrompt | null }
  /** /clear started a new session. */
  | { type: "session"; session_id: string; previous: string | null }
  /**
   * The conversation was rewound to before the user's message `uuid`:
   * what was streamed since is no longer the conversation's.
   */
  | { type: "rewound"; uuid: string }
  | {
      type: "lease";
      owner: AgentChatOwner;
      phase: AgentChatPhase;
      session_id: string | null;
    }
  | {
      type: "notice";
      kind:
        | "api_retry"
        | "compact"
        | "permission_denied"
        | "process_exited"
        | "error";
      text: string;
    };

export type AgentChatEventEnvelope = {
  event: `agent_chat.${AgentChatEvent["type"]}`;
  data: AgentChatEvent & { pane_id: string; session_id: string | null };
};

/** What a spoken message did while Claude was working (the barge-in mix). */
export type AgentChatVoiceAction =
  | "sent"
  | "queued"
  | "interrupted"
  | "interrupted_then_sent"
  | "steered";
