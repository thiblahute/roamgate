/**
 * What a session's agent did beside its conversation, as the server reads
 * it from the transcript and the web shows it: background tasks, workflows,
 * published pages and the commands it offers.
 */

/**
 * What a Claude session ran on the side: background commands, monitors and
 * subagents, with how each ended. Read from the transcript: the tool call
 * that started it, its result (task or agent id, output file), and the task
 * notification Claude Code adds when it ends.
 */
export type AgentTask = {
  /** The tool call that started it. */
  id: string;
  kind: "command" | "agent" | "teammate" | "workflow" | "monitor";
  title: string;
  /** The command, or the subagent's type. */
  detail?: string;
  /**
   * Lost: no end notice, and nothing runs it any more: still running a day on
   * (gone with its session), or a command whose output has gone silent with
   * no process holding it open.
   */
  status: "running" | "completed" | "failed" | "stopped" | "lost";
  /** A teammate's name. */
  name?: string;
  /** A workflow's run: its journal and record beside the session. */
  runId?: string;
  exitCode?: number;
  summary?: string;
  startedAt?: string;
  /**
   * A subagent sent a message after it had finished: Claude Code resumes
   * it under the same id, with no new start record, and notifies again
   * when it stops. When that last happened.
   */
  resumedAt?: string;
  endedAt?: string;
  /** Background task or agent id, as notifications name it. */
  taskId?: string;
  /** A subagent's conversation: subagents/agent-<id>.jsonl beside the session. */
  agentId?: string;
  /** Started by one of the session's subagents: that subagent's agent id. */
  parentAgentId?: string;
  /** That subagent's name (or what it was started for). */
  parent?: string;
  /**
   * Not started by this conversation: listed from a message it sent the
   * agent (resuming it) or from the agent's end notice.
   */
  foreign?: boolean;
  outputFile?: string;
  /**
   * Started in a part of the conversation a rewind took back. Listed only
   * while it still runs (a teammate also while idle): what it did is gone
   * from the conversation, not the work it goes on doing.
   */
  rewound?: boolean;
  /**
   * A command run in the foreground that has not answered yet: what the
   * turn waits on now. Never a background task.
   */
  foreground?: boolean;
};

export type WorkflowAgentView = {
  agentId: string;
  label: string;
  state: "running" | "done" | "failed";
  resultPreview?: string;
  durationMs?: number;
  /** When it started, in ms since the epoch. */
  startedAt?: number;
  /** While it runs: when its conversation last changed. */
  lastActiveAt?: number;
};
export type WorkflowView = {
  phases: { title: string; agents: WorkflowAgentView[] }[];
  /** Once it has ended: its record's result, shortened. */
  result?: string;
};

/** What the Workspaces list shows of a task: no output, no long summaries. */
export type AgentTaskSummary = Pick<
  AgentTask,
  | "id"
  | "kind"
  | "title"
  | "status"
  | "name"
  | "startedAt"
  | "resumedAt"
  | "endedAt"
  | "rewound"
>;

/** A page an agent published with Claude Code's Artifact tool. */
export type PublishedArtifact = {
  url: string;
  title: string;
  // The version number when an existing artifact was updated.
  version?: number;
};

/** An artifact as the session left it: its last publish. */
export type SessionArtifact = PublishedArtifact & { published_at?: string };

/** A command the user can type in a Claude session: `/name`. */
export type AgentCommand = { name: string; description: string };
