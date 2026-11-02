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
  outputFile?: string;
  /**
   * Started in a part of the conversation a rewind took back. Listed only
   * while it still runs (a teammate also while idle): what it did is gone
   * from the conversation, not the work it goes on doing.
   */
  rewound?: boolean;
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
/**
 * Records of the transcript that replay what was sent to the model (the
 * request and its messages): their tool calls and texts repeat ones the
 * conversation already has, and must not start or end a task again.
 */
const REQUEST_RECORD_TYPES = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
]);

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

/**
 * The tasks a transcript's records started. `rewound` names the records a
 * rewind took back (session-rewind.ts): tasks they started are flagged and
 * kept while they run, and end notices, which come on the conversation's
 * line after the rewind, end them all the same.
 */
export function parseSessionTasks(
  records: readonly Record<string, unknown>[],
  options: { rewound?: ReadonlySet<string> | null } = {},
): AgentTask[] {
  const tasks = new Map<string, AgentTask>();
  const byTaskId = new Map<string, AgentTask>();
  // Teammates idle since their last message: still there to be woken.
  const idle = new Set<AgentTask>();
  const ended = (task: AgentTask, notice: string, at?: string) => {
    const status = tag(notice, "status");
    const summary = tag(notice, "summary");
    const exit = summary ? /exit code (-?\d+)/i.exec(summary) : null;
    task.status = endStatus(status);
    idle.delete(task);
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
  // SendMessage calls, by tool call: their result says if one resumed a
  // subagent that had finished.
  const sends = new Set<string>();
  // A resumed subagent, by the id its result names: in full, or as the
  // short prefix "Resuming agent a6f37b8" gives.
  const resumable = (id: string) => {
    const exact = byTaskId.get(id);
    if (exact) return exact;
    if (id.length < 7) return undefined;
    for (const [key, task] of byTaskId)
      if (task.agentId === key && key.startsWith(id)) return task;
    return undefined;
  };
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
      idle.add(task);
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
    if (
      typeof record.type === "string" &&
      REQUEST_RECORD_TYPES.has(record.type)
    )
      continue;
    const at = stringValue(record.timestamp) || undefined;
    const rewound =
      typeof record.uuid === "string" &&
      options.rewound?.has(record.uuid) === true;
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
          sends.add(id);
          // A teammate idle since its last message works on the next one.
          // Any other agent: its result says whether it was resumed.
          const teammate = teammates.get(stringValue(input.to));
          if (teammate && idle.has(teammate)) {
            teammate.status = "running";
            idle.delete(teammate);
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
        const started = tasks.get(id);
        if (rewound && started) started.rewound = true;
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
        if (sends.has(stringValue(part.tool_use_id))) {
          if (part.is_error === true) continue;
          // Resumed: running again until its next end notice. Queued for
          // one that still runs: nothing changes.
          const result = isRecord(record.toolUseResult)
            ? record.toolUseResult
            : {};
          const resumed =
            stringValue(result.resumedAgentId) ||
            stringValue(result.revivedAgentId) ||
            /"resumedAgentId"\s*:\s*"([\w-]+)"/.exec(
              contentText(part.content),
            )?.[1] ||
            /Resuming agent ([\w-]+)/.exec(contentText(part.content))?.[1];
          const task = resumed ? resumable(resumed) : undefined;
          if (task && task.status !== "running") {
            task.status = "running";
            task.resumedAt = at;
            idle.delete(task);
            delete task.endedAt;
            delete task.exitCode;
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
        // A call the permission check refused never started: no task id, and
        // its result is an error string (no is_error flag).
        const refused =
          typeof record.toolUseResult === "string" &&
          /^Error:/.test(record.toolUseResult);
        if (part.is_error === true || (refused && !taskId)) {
          task.status = "failed";
          task.summary = (text || String(record.toolUseResult)).slice(0, 500);
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
  const listed: AgentTask[] = [];
  for (const task of tasks.values()) {
    const since = task.resumedAt ?? task.startedAt;
    const started = since ? Date.parse(since) : Number.NaN;
    const old =
      Number.isFinite(started) &&
      Number.isFinite(latest) &&
      latest - started > LOST_AFTER_MS;
    if (task.status === "running" && old) {
      task.status = "lost";
      task.summary =
        "No end notice a day later: it probably ended with its session.";
    }
    // Rewound history stays hidden once its task is done.
    if (task.rewound && task.status !== "running" && !(idle.has(task) && !old))
      continue;
    listed.push(task);
  }
  return listed.reverse().slice(0, MAX_TASKS);
}

/**
 * A background command whose output file has not been written this long is
 * looked at: while a process still holds that file open it runs on, and
 * once none does it is taken as lost (its end notice never came).
 */
export const COMMAND_SILENT_MS = 10 * 60 * 1000;
/**
 * Where nothing can tell whether a process holds the output open, a command
 * silent this long is taken as lost.
 */
export const COMMAND_SILENT_UNCHECKED_MS = 60 * 60 * 1000;

/** A command's output file, as last written: `null` when it is gone. */
export type CommandOutputActivity = ReadonlyMap<
  string,
  { mtimeMs: number } | null
>;

/**
 * The output files of the running commands that have been silent long
 * enough to be looked at (see `withCommandActivity`).
 */
export function commandOutputsToWatch(
  tasks: readonly AgentTask[],
  now: number,
): string[] {
  const paths: string[] = [];
  for (const task of tasks) {
    if (task.kind !== "command" || task.status !== "running") continue;
    if (!task.outputFile) continue;
    const started = Date.parse(task.resumedAt ?? task.startedAt ?? "");
    if (Number.isFinite(started) && now - started < COMMAND_SILENT_MS) continue;
    paths.push(task.outputFile);
  }
  return [...new Set(paths)];
}

/**
 * The running commands whose output has been silent past `COMMAND_SILENT_MS`
 * and that no process holds open (`held` says: true, false, or null when it
 * cannot tell) are taken as lost, ended at their output's last write. Copies,
 * never the tasks given; a command that writes again is running again on the
 * next read, since this is computed from the output on every read.
 */
export function withCommandActivity(
  tasks: readonly AgentTask[],
  activity: CommandOutputActivity,
  now: number,
  held: (path: string) => boolean | null,
): AgentTask[] {
  return tasks.map((task) => {
    if (task.kind !== "command" || task.status !== "running") return task;
    if (!task.outputFile) return task;
    const file = activity.get(task.outputFile);
    if (!file || !Number.isFinite(file.mtimeMs)) return task;
    const silent = now - file.mtimeMs;
    if (silent < COMMAND_SILENT_MS) return task;
    const open = held(task.outputFile);
    if (open === true) return task;
    if (open === null && silent < COMMAND_SILENT_UNCHECKED_MS) return task;
    const minutes = Math.round(silent / 60_000);
    return {
      ...task,
      status: "lost",
      endedAt: new Date(file.mtimeMs).toISOString(),
      summary: `No output for ${minutes} minutes and no process writes it: it ended without a result.`,
    };
  });
}

/**
 * A subagent taken as running again (resumed by a message, or its
 * conversation growing after it had finished) is taken as stopped once its
 * conversation has not changed for this long, should its end notice never
 * come. Longer than the longest single tool call (a Bash command may run 10
 * minutes) plus a long model turn; short enough that one that died with its
 * notice lost leaves the running count within half an hour.
 */
export const SUBAGENT_STALE_MS = 30 * 60 * 1000;
/**
 * A subagent's conversation written this long after its end notice: more
 * than the few milliseconds between its last record and the notice.
 */
const GREW_AFTER_END_MS = 2000;

/**
 * A subagent's own conversation file, as last seen: `null` when it has none.
 * Only the subagents `subagentsToWatch` names are asked about.
 */
export type SubagentActivity = ReadonlyMap<string, { mtimeMs: number } | null>;

/**
 * The subagents whose conversation tells more than the transcript does:
 * one taken as running again since it was resumed, whose end notice may
 * never come, and the few that ended most recently, which a message may
 * have resumed without the session's transcript saying so yet.
 */
export function subagentsToWatch(
  tasks: readonly AgentTask[],
  now: number,
  limit = 8,
): string[] {
  const ids: string[] = [];
  const ended: { id: string; at: number }[] = [];
  for (const task of tasks) {
    if (task.kind !== "agent" && task.kind !== "teammate") continue;
    if (!task.agentId || !/^[\w-]+$/.test(task.agentId)) continue;
    if (task.status === "running") {
      if (task.resumedAt) ids.push(task.agentId);
      continue;
    }
    const at = Date.parse(task.endedAt ?? task.startedAt ?? "");
    if (Number.isFinite(at) && now - at < LOST_AFTER_MS)
      ended.push({ id: task.agentId, at });
  }
  ended.sort((a, b) => b.at - a.at);
  return [...ids, ...ended.slice(0, limit).map((each) => each.id)];
}

/**
 * The tasks with what their subagents' conversations say: one that ended
 * and whose conversation has grown since runs again; one taken as running
 * again whose conversation has not changed for `SUBAGENT_STALE_MS` is taken
 * as stopped. Copies, never the tasks given.
 */
export function withSubagentActivity(
  tasks: readonly AgentTask[],
  activity: SubagentActivity,
  now: number,
): AgentTask[] {
  return tasks.map((task) => {
    const file = task.agentId ? activity.get(task.agentId) : undefined;
    if (!file || !Number.isFinite(file.mtimeMs)) return task;
    const fresh = now - file.mtimeMs < SUBAGENT_STALE_MS;
    if (task.status === "running") {
      if (!task.resumedAt) return task;
      const resumed = Date.parse(task.resumedAt);
      const last = Math.max(file.mtimeMs, resumed);
      if (!Number.isFinite(last) || now - last < SUBAGENT_STALE_MS) return task;
      return {
        ...task,
        status: "completed",
        endedAt: new Date(last).toISOString(),
        summary: `No activity for ${SUBAGENT_STALE_MS / 60_000} minutes after it was resumed: taken as done.`,
      };
    }
    const ended = Date.parse(task.endedAt ?? "");
    const grew =
      Number.isFinite(ended) && file.mtimeMs > ended + GREW_AFTER_END_MS;
    if (!grew || !fresh) return task;
    const next: AgentTask = {
      ...task,
      status: "running",
      resumedAt: task.endedAt,
    };
    delete next.endedAt;
    delete next.exitCode;
    return next;
  });
}
