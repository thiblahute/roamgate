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

export type AgentChatLease = {
  connection_id: string;
  pane_id: string;
  session_id: string;
  cwd: string;
  owner: AgentChatOwner;
  phase: AgentChatPhase;
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
   * The pane holder that runs the headless claude: how far Roamgate read
   * its log, and the commands it had not confirmed yet. A runtime after
   * this one reads on from there.
   */
  holder?: {
    id: string;
    offset: number;
    pending?: { seq: number; op: string; [key: string]: unknown }[];
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
  /** A tool call is running: speech steers the turn instead of stopping it. */
  tools_running: boolean;
  /** What it is doing: a tool's name, "thinking", "compacting". */
  activity: string | null;
  queue: AgentChatQueued[];
  /** The last turn was cut short, until the next one starts. */
  interrupted: AgentChatInterrupted | null;
  /**
   * On a subscription only: the reply text already streamed of the turn
   * that runs, so a browser that comes in the middle of it (a reload)
   * draws all of it, not just what streams after.
   */
  streamed?: AgentChatStreamedText[];
};

/** A text block of the running turn, as streamed so far. */
export type AgentChatStreamedText = {
  message_id: string;
  index: number;
  text: string;
  /** Its complete text came (the CLI's assistant message). */
  done: boolean;
};

/** A refused or accepted handover, with the reason when refused. */
export type AgentChatHandoverResult =
  | {
      ok: true;
      owner: AgentChatOwner;
      session_id: string;
      confirmed?: boolean;
      detail?: string;
    }
  | { ok: false; reason: string };

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
  /** A turn was cut short (or that notice went: null). */
  | { type: "interrupted"; interrupted: AgentChatInterrupted | null }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      interrupted: boolean;
      text: string;
      cost_usd?: number;
      duration_ms?: number;
    }
  /** /clear started a new session. */
  | { type: "session"; session_id: string; previous: string | null }
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
