import { isRecord, stringValue } from "./session-utils";

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
  /** Lost: still running a day on, with no end notice (gone with its session). */
  status: "running" | "completed" | "failed" | "stopped" | "lost";
  /** A teammate's name. */
  name?: string;
  /** A workflow's run: its journal and record beside the session. */
  runId?: string;
  exitCode?: number;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  /** Background task or agent id, as notifications name it. */
  taskId?: string;
  /** A subagent's conversation: subagents/agent-<id>.jsonl beside the session. */
  agentId?: string;
  outputFile?: string;
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

const MAX_TASKS = 50;
/** A task with no end notice this long after it started is taken as lost. */
const LOST_AFTER_MS = 24 * 60 * 60 * 1000;

function tag(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match?.[1]?.trim() || undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

function endStatus(raw: string | undefined): AgentTask["status"] {
  if (!raw) return "completed";
  const status = raw.toLowerCase();
  if (/fail|error/.test(status)) return "failed";
  if (/kill|stop|cancel/.test(status)) return "stopped";
  return "completed";
}

export function parseSessionTasks(
  records: readonly Record<string, unknown>[],
): AgentTask[] {
  const tasks = new Map<string, AgentTask>();
  const byTaskId = new Map<string, AgentTask>();
  const ended = (task: AgentTask, notice: string, at?: string) => {
    const status = tag(notice, "status");
    const summary = tag(notice, "summary");
    const exit = summary ? /exit code (-?\d+)/i.exec(summary) : null;
    task.status = endStatus(status);
    if (exit) {
      task.exitCode = Number(exit[1]);
      if (task.exitCode !== 0 && task.status === "completed")
        task.status = "failed";
    }
    if (summary) task.summary = summary.slice(0, 500);
    task.endedAt = at ?? task.endedAt;
    task.outputFile = tag(notice, "output-file") ?? task.outputFile;
  };
  // Teammates by name: one works until it says it is idle, and again when
  // it is sent a message.
  const teammates = new Map<string, AgentTask>();
  // TaskStop (KillShell for shells) calls, by tool call: the task they end.
  const stops = new Map<string, string>();
  const notified = (text: string, at?: string) => {
    for (const match of text.matchAll(
      /<teammate-message teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g,
    )) {
      const task = teammates.get(match[1]!);
      if (!task) continue;
      let body: unknown;
      try {
        body = JSON.parse(match[2]!.trim());
      } catch {
        continue;
      }
      if (!isRecord(body) || body.type !== "idle_notification") continue;
      task.status = "completed";
      task.endedAt = at ?? task.endedAt;
      const said = stringValue(body.result);
      if (said) task.summary = said.slice(0, 500);
    }
    for (const match of text.matchAll(
      /<task-notification>[\s\S]*?<\/task-notification>/g,
    )) {
      const notice = match[0];
      const toolUseId = tag(notice, "tool-use-id");
      const taskId = tag(notice, "task-id");
      const task =
        (toolUseId ? tasks.get(toolUseId) : undefined) ??
        (taskId ? byTaskId.get(taskId) : undefined);
      if (task) ended(task, notice, at);
    }
  };

  for (const record of records) {
    const at = stringValue(record.timestamp) || undefined;
    const attachment = isRecord(record.attachment) ? record.attachment : null;
    if (attachment?.type === "queued_command")
      notified(contentText(attachment.prompt), at);
    const message = isRecord(record.message) ? record.message : null;
    if (!message) continue;
    if (typeof message.content === "string") {
      notified(message.content, at);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string")
        notified(part.text, at);
      if (part.type === "tool_use") {
        const id = stringValue(part.id);
        const name = stringValue(part.name);
        const input = isRecord(part.input) ? part.input : {};
        const description = stringValue(input.description);
        if (!id) continue;
        if (
          name === "TaskStop" ||
          name === "KillShell" ||
          name === "KillBash"
        ) {
          const target =
            stringValue(input.task_id) || stringValue(input.shell_id);
          if (target) stops.set(id, target);
          continue;
        }
        if (name === "SendMessage") {
          const teammate = teammates.get(stringValue(input.to));
          if (teammate) {
            teammate.status = "running";
            delete teammate.endedAt;
          }
          continue;
        }
        if (name === "Agent" || name === "Task") {
          // A named agent is a teammate the session talks to.
          const teammate = stringValue(input.name);
          tasks.set(id, {
            id,
            kind: teammate ? "teammate" : "agent",
            title: description || teammate || "Subagent",
            detail: stringValue(input.subagent_type) || undefined,
            ...(teammate ? { name: teammate } : {}),
            status: "running",
            startedAt: at,
          });
          if (teammate) teammates.set(teammate, tasks.get(id)!);
        } else if (name === "Workflow")
          tasks.set(id, {
            id,
            kind: "workflow",
            title: description || stringValue(input.name) || "Workflow",
            status: "running",
            startedAt: at,
          });
        else if (name === "Bash" && input.run_in_background === true)
          tasks.set(id, {
            id,
            kind: "command",
            title: description || stringValue(input.command).slice(0, 120),
            detail: stringValue(input.command).slice(0, 2000) || undefined,
            status: "running",
            startedAt: at,
          });
        else if (name === "Monitor")
          tasks.set(id, {
            id,
            kind: "monitor",
            title: description || "Monitor",
            detail: stringValue(input.command).slice(0, 2000) || undefined,
            status: "running",
            startedAt: at,
          });
      }
      if (part.type === "tool_result") {
        const stopped = stops.get(stringValue(part.tool_use_id));
        if (stopped) {
          const target = byTaskId.get(stopped);
          if (target?.status === "running" && part.is_error !== true) {
            target.status = "stopped";
            target.endedAt = at;
          }
          continue;
        }
        const task = tasks.get(stringValue(part.tool_use_id));
        if (!task) continue;
        const text = contentText(part.content);
        const result = isRecord(record.toolUseResult)
          ? record.toolUseResult
          : {};
        const taskId =
          stringValue(result.backgroundTaskId) ||
          stringValue(result.taskId) ||
          /background with ID: (\w+)/.exec(text)?.[1] ||
          /Task ID: (\w+)/.exec(text)?.[1];
        const agentId =
          stringValue(result.agentId) || /agentId: (\w+)/.exec(text)?.[1];
        if (taskId) {
          task.taskId = taskId;
          byTaskId.set(taskId, task);
        }
        if (agentId) {
          task.agentId = agentId;
          byTaskId.set(agentId, task);
        }
        const runId = stringValue(result.runId);
        if (runId) {
          task.runId = runId;
          task.title =
            stringValue(result.summary) ||
            stringValue(result.workflowName) ||
            task.title;
          task.detail = stringValue(result.workflowName) || task.detail;
        }
        task.outputFile =
          stringValue(result.outputFile) ||
          /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text)?.[1] ||
          task.outputFile;
        if (part.is_error === true) {
          task.status = "failed";
          task.summary = text.slice(0, 500);
          task.endedAt = at;
        } else if (
          (task.kind === "agent" || task.kind === "teammate") &&
          result.isAsync !== true &&
          result.status !== "async_launched" &&
          result.status !== "teammate_spawned"
        ) {
          // A subagent that ran in the foreground ends with its result.
          task.status = "completed";
          task.summary = text.slice(0, 500);
          task.endedAt = at;
        }
      }
    }
  }
  // No end notice a day on: it went with its session (a kill leaves none).
  const latest = records.length
    ? Date.parse(stringValue(records[records.length - 1]!.timestamp))
    : Number.NaN;
  for (const task of tasks.values()) {
    const started = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
    if (
      task.status === "running" &&
      Number.isFinite(started) &&
      Number.isFinite(latest) &&
      latest - started > LOST_AFTER_MS
    ) {
      task.status = "lost";
      task.summary =
        "No end notice a day later: it probably ended with its session.";
    }
  }
  return [...tasks.values()].reverse().slice(0, MAX_TASKS);
}
