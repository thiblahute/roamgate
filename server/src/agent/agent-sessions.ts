import { isRecord } from "./session-utils";
import type { WorkflowAgentView, WorkflowView } from "./session-tasks";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { enrichAgentActivity } from "./agent-activity";
import type { HerdrCall, SessionFile } from "./session-types";
import {
  createAgentSessionResolverContext,
  type AgentSessionResolverContext,
  resolveAgentSession,
} from "./session-resolver";
import {
  localAgentSessionFiles,
  type AgentSessionFileAccess,
} from "./session-file-access";
import { readAntigravitySessionRecords } from "./antigravity-session";
import {
  createSessionProjectionCache,
  readSessionProjection,
  type SessionProjectionCache,
} from "./session-projection-cache";
import {
  HISTORY_WINDOW_LIMIT,
  historyTextHash,
  redactHistoryUpdate,
} from "./session-history";

const MAX_MESSAGES_PER_AGENT = 200;
/** How much of a task the browser gets: an output's end, a subagent's last. */
const TASK_OUTPUT_BYTES = 32 * 1024;
const TASK_ENTRIES = 200;
const TASK_ENTRY_CHARS = 4000;

export function createAgentSessionHandlers(args: {
  herdrCall: HerdrCall;
  files: AgentSessionFileAccess;
}) {
  const resolverContext = createAgentSessionResolverContext();
  const cache = createSessionProjectionCache(args.files);
  return {
    listWithActivity: async (params: Record<string, unknown>) =>
      enrichAgentActivity(
        await args.herdrCall("agent.list", params),
        args.files,
        resolverContext,
      ),
    readHistory: async (params: Record<string, unknown>) => {
      if (params.history_version !== 2) {
        return readAgentMessageHistory(
          params,
          args.herdrCall,
          args.files,
          resolverContext,
          cache,
        );
      }
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) {
        cache.invalidate(resolved);
        return {
          ...resolved,
          history_version: 2 as const,
          mode: "snapshot" as const,
          cursor: { epoch: randomUUID(), revision: 1 },
          window_limit: HISTORY_WINDOW_LIMIT,
          entries: [],
        };
      }
      const { projection, update } = await cache.history(
        resolved,
        params.cursor,
      );
      return {
        ...resolved,
        file: projection.file,
        updated_at: new Date(projection.file.mtimeMs).toISOString(),
        ...redactHistoryUpdate(update),
      };
    },
    readEntry: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) {
        cache.invalidate(resolved);
        throw new Error(resolved.detail || "Agent session is unavailable");
      }
      const projection = await cache.get(resolved);
      const entryId =
        typeof params.entry_id === "string" ? params.entry_id : "";
      const entry = projection.entries.find(
        (candidate) => candidate.id === entryId,
      );
      if (!entry) {
        throw new Error(
          "That history entry is no longer available; refresh the history and try again",
        );
      }
      return {
        entry_id: entry.id,
        text: entry.text,
        text_hash: historyTextHash(entry.text),
      };
    },
    /** What the session ran on the side: background commands, subagents. */
    readTasks: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) return { tasks: [] };
      const projection = await cache.get(resolved);
      // The session they belong to: its transcript's name, its id for Claude.
      return {
        tasks: projection.tasks,
        session: basename(resolved.file.path).replace(/\.jsonl$/, ""),
      };
    },
    readCommands: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) return { commands: [] };
      const projection = await cache.get(resolved);
      return { commands: projection.commands };
    },
    readArtifacts: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) return { artifacts: [] };
      const projection = await cache.get(resolved);
      return { artifacts: projection.artifacts };
    },
    /**
     * A task's details: the end of a command's output, or a subagent's own
     * conversation. Paths come from the transcript, never from the caller.
     */
    readTask: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) throw new Error("Agent session is unavailable");
      const projection = await cache.get(resolved);
      const task = projection.tasks.find((each) => each.id === params.task_id);
      if (!task) throw new Error("That task is no longer in the session");
      const sessionDir = resolved.file.path.replace(/\.jsonl$/, "");
      // A conversation beside the session: a subagent's, a teammate's, or
      // one of a workflow's agents'.
      const conversation = async (path: string) => {
        const file = await args.files.statFile(path);
        if (!file) return [];
        const projected = await readSessionProjection(
          "claude",
          file,
          args.files,
        );
        return projected.entries.slice(-TASK_ENTRIES).map((entry) => ({
          ...entry,
          text: entry.text.slice(0, TASK_ENTRY_CHARS),
        }));
      };
      if (task.kind === "workflow" && task.runId) {
        if (!/^wf_[\w-]+$/.test(task.runId))
          throw new Error("Unknown workflow");
        const runDir = `${sessionDir}/subagents/workflows/${task.runId}`;
        const workflow = await readWorkflowRun(
          args.files,
          runDir,
          `${sessionDir}/workflows/${task.runId}.json`,
        );
        const agentId =
          typeof params.agent_id === "string" ? params.agent_id : "";
        if (agentId) {
          // Only an agent of this run.
          if (
            !workflow.phases.some((phase) =>
              phase.agents.some((agent) => agent.agentId === agentId),
            )
          )
            throw new Error("Unknown workflow agent");
          return {
            task,
            workflow,
            entries: await conversation(`${runDir}/agent-${agentId}.jsonl`),
          };
        }
        return { task, workflow };
      }
      if ((task.kind === "agent" || task.kind === "teammate") && task.agentId) {
        if (!/^[\w-]+$/.test(task.agentId)) throw new Error("Unknown subagent");
        return {
          task,
          entries: await conversation(
            `${sessionDir}/subagents/agent-${task.agentId}.jsonl`,
          ),
        };
      }
      // Claude Code's task output files only.
      if (!task.outputFile?.endsWith(".output")) return { task, output: "" };
      const bytes = await args.files
        .readTail(task.outputFile, TASK_OUTPUT_BYTES)
        .catch(() => new Uint8Array());
      return { task, output: new TextDecoder().decode(bytes) };
    },
    readSummary: (params: Record<string, unknown>) =>
      readAgentSessionSummary(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
        cache,
      ),
    downloadFile: (params: Record<string, unknown>) =>
      downloadAgentSessionFile(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      ),
    downloadAtif: (params: Record<string, unknown>) =>
      downloadAgentSessionAtif(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
        cache,
      ),
  };
}

function eventText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * A workflow run's phases and agents: live from its journal (an agent
 * started, an agent's result), completed by its record once it has ended.
 */
export async function readWorkflowRun(
  files: AgentSessionFileAccess,
  runDir: string,
  recordPath: string,
): Promise<WorkflowView> {
  const phases: WorkflowView["phases"] = [];
  const phaseOf = (title: string) => {
    let phase = phases.find((each) => each.title === title);
    if (!phase) {
      phase = { title, agents: [] };
      phases.push(phase);
    }
    return phase;
  };
  const agents = new Map<string, WorkflowAgentView>();
  const journal = await files.statFile(`${runDir}/journal.jsonl`);
  if (journal)
    for (const line of (await files.readText(journal.path)).split("\n")) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const agentId = typeof event.agentId === "string" ? event.agentId : "";
      if (!agentId) continue;
      const known = agents.get(agentId);
      if (event.type === "started" && !known) {
        const agent: WorkflowAgentView = {
          agentId,
          label: typeof event.label === "string" ? event.label : agentId,
          state: "running",
        };
        agents.set(agentId, agent);
        phaseOf(typeof event.phase === "string" ? event.phase : "").agents.push(
          agent,
        );
      } else if (event.type === "result" && known) {
        known.state = "done";
        known.resultPreview = eventText(event.result)?.slice(0, 300);
      } else if ((event.type === "error" || event.type === "failed") && known)
        known.state = "failed";
    }
  const recordFile = await files.statFile(recordPath);
  let record: Record<string, unknown> | null = null;
  if (recordFile)
    try {
      record = JSON.parse(await files.readText(recordFile.path));
    } catch {}
  if (!isRecord(record)) {
    await addLiveAgentTimes(files, runDir, phases);
    return { phases };
  }
  // Once it exists, the record gives the phase order and agent states.
  const ordered: WorkflowView["phases"] = [];
  for (const phase of Array.isArray(record.phases) ? record.phases : []) {
    const title =
      isRecord(phase) && typeof phase.title === "string" ? phase.title : "";
    if (title) ordered.push(phaseOf(title));
  }
  for (const item of Array.isArray(record.workflowProgress)
    ? record.workflowProgress
    : []) {
    if (
      !isRecord(item) ||
      item.type !== "workflow_agent" ||
      typeof item.agentId !== "string"
    )
      continue;
    let agent = agents.get(item.agentId);
    if (!agent) {
      agent = {
        agentId: item.agentId,
        label: typeof item.label === "string" ? item.label : item.agentId,
        state: "done",
      };
      agents.set(item.agentId, agent);
      phaseOf(
        typeof item.phaseTitle === "string" ? item.phaseTitle : "",
      ).agents.push(agent);
    }
    if (item.state === "done") agent.state = "done";
    else if (item.state === "error" || item.state === "failed")
      agent.state = "failed";
    if (typeof item.durationMs === "number") agent.durationMs = item.durationMs;
    if (typeof item.startedAt === "number") agent.startedAt = item.startedAt;
    if (typeof item.resultPreview === "string")
      agent.resultPreview = item.resultPreview.slice(0, 300);
  }
  const result = eventText(record.result)?.slice(0, 4000);
  return {
    phases: [...ordered, ...phases.filter((phase) => !ordered.includes(phase))],
    ...(result ? { result } : {}),
  };
}

/** File times that do not change: a meta file's, an ended agent's transcript. */
const settledTimes = new WeakMap<AgentSessionFileAccess, Map<string, number>>();
const SETTLED_TIMES_LIMIT = 2000;

/**
 * While a run has no record yet, its agents' times from their files: each
 * meta file is written as its agent starts, and its transcript as it works.
 * A file that no longer changes is read once; over SSH only running agents
 * are read, so a poll costs one stat per running agent.
 */
async function addLiveAgentTimes(
  files: AgentSessionFileAccess,
  runDir: string,
  phases: WorkflowView["phases"],
) {
  let settled = settledTimes.get(files);
  if (!settled || settled.size > SETTLED_TIMES_LIMIT) {
    settled = new Map();
    settledTimes.set(files, settled);
  }
  const known = settled;
  const mtime = async (path: string) =>
    (await files.statFile(path).catch(() => null))?.mtimeMs;
  const settledMtime = async (path: string) => {
    let time = known.get(path);
    if (time === undefined) {
      time = await mtime(path);
      if (time !== undefined) known.set(path, time);
    }
    return time;
  };
  const agents = phases
    .flatMap((phase) => phase.agents)
    .filter(
      (agent) =>
        /^[\w-]+$/.test(agent.agentId) &&
        (!files.remote || agent.state === "running"),
    );
  await Promise.all(
    agents.map(async (agent) => {
      const started = await settledMtime(
        `${runDir}/agent-${agent.agentId}.meta.json`,
      );
      if (started !== undefined) agent.startedAt = Math.round(started);
      const transcript = `${runDir}/agent-${agent.agentId}.jsonl`;
      if (agent.state === "running") {
        const active = await mtime(transcript);
        if (active !== undefined) agent.lastActiveAt = Math.round(active);
        return;
      }
      const ended = await settledMtime(transcript);
      if (started !== undefined && ended !== undefined)
        agent.durationMs = Math.max(0, Math.round(ended - started));
    }),
  );
}

export async function readAgentMessageHistory(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
  resolverContext?: AgentSessionResolverContext,
  cache?: SessionProjectionCache,
) {
  const resolved = await resolveAgentSession(
    rawParams,
    herdrCall,
    files,
    resolverContext,
  );
  if (!resolved.file) {
    cache?.invalidate(resolved);
    return {
      ...resolved,
      messages: [],
    };
  }
  const projected = cache
    ? await cache.get(resolved)
    : await readSessionProjection(resolved.agent, resolved.file, files);
  const messages = projected.messages.slice(-MAX_MESSAGES_PER_AGENT);
  return {
    ...resolved,
    file: projected.file,
    updated_at: new Date(projected.file.mtimeMs).toISOString(),
    messages,
  };
}

export async function readAgentSessionSummary(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
  resolverContext?: AgentSessionResolverContext,
  cache?: SessionProjectionCache,
) {
  const resolved = await resolveAgentSession(
    rawParams,
    herdrCall,
    files,
    resolverContext,
  );
  if (!resolved.file) {
    cache?.invalidate(resolved);
    return {
      ...resolved,
      stats: { turns: 0, records: 0, token_usage: null },
      title: null,
      text: null,
      truncated: false,
      trajectory: null,
    };
  }
  const projected = cache
    ? await cache.get(resolved)
    : await readSessionProjection(resolved.agent, resolved.file, files);
  const stats = projected.stats;
  const includeText = rawParams.include_text === true;
  const includeTrajectory = rawParams.include_trajectory === true;
  const previewLimit = Math.max(
    1,
    Math.min(Number(rawParams.preview_limit) || 512 * 1024, 2 * 1024 * 1024),
  );
  let text: string | null = null;
  let truncated = false;
  if (includeText) {
    if (resolved.agent === "agy") {
      const records = await readAntigravitySessionRecords(resolved.file.path);
      const ndjson = records.map((r) => JSON.stringify(r)).join("\n");
      truncated = ndjson.length > previewLimit;
      text = truncated ? ndjson.slice(0, previewLimit) : ndjson;
    } else {
      const bytes = await files.readPrefix(
        resolved.file.path,
        previewLimit + 1,
      );
      truncated =
        bytes.length > previewLimit ||
        (projected.file.size ?? 0) > previewLimit;
      text = new TextDecoder("utf-8", { fatal: false }).decode(
        truncated ? bytes.subarray(0, previewLimit) : bytes,
      );
    }
  }
  const trajectory = !includeTrajectory
    ? null
    : cache
      ? await cache.trajectory(resolved)
      : (await readSessionProjection(resolved.agent, resolved.file, files))
          .trajectory;
  return {
    ...resolved,
    file: projected.file,
    updated_at: new Date(projected.file.mtimeMs).toISOString(),
    stats,
    title: projected.title,
    text,
    truncated,
    trajectory,
  };
}

function contentDispositionFilename(path: string) {
  const isDb = path.endsWith(".db");
  const fallbackDefault = isDb ? "session.db" : "session.jsonl";
  const fallback =
    basename(path).replace(/[^\x20-\x7e]|["\r\n]/g, "_") || fallbackDefault;
  return `attachment; filename="${fallback}"`;
}

function contentDispositionAtifFilename(file: SessionFile) {
  const name = (file.sessionId || basename(file.path))
    .replace(/\.[^.]+$/, "")
    .replace(/[^\x20-\x7e]|["\r\n]/g, "_");
  const filename = `${name || "session"}.atif.json`;
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function downloadAgentSessionFile(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
  resolverContext?: AgentSessionResolverContext,
) {
  const resolved = await resolveAgentSession(
    rawParams,
    herdrCall,
    files,
    resolverContext,
  );
  if (!resolved.file) {
    return new Response(resolved.detail || "session file unavailable", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const body = await files.readDownloadBody(resolved.file.path);
  const isDb = resolved.file.path.endsWith(".db");
  return new Response(body, {
    headers: {
      "content-type": isDb
        ? "application/vnd.sqlite3"
        : "application/x-ndjson; charset=utf-8",
      "content-length": String(resolved.file.size ?? 0),
      "content-disposition": contentDispositionFilename(resolved.file.path),
      "x-agent-session-path": encodeURIComponent(resolved.file.path),
    },
  });
}

export async function downloadAgentSessionAtif(
  rawParams: Record<string, unknown>,
  herdrCall: HerdrCall,
  files: AgentSessionFileAccess = localAgentSessionFiles,
  resolverContext?: AgentSessionResolverContext,
  cache?: SessionProjectionCache,
) {
  const resolved = await resolveAgentSession(
    rawParams,
    herdrCall,
    files,
    resolverContext,
  );
  if (!resolved.file) {
    return new Response(resolved.detail || "session file unavailable", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const trajectory = cache
    ? await cache.trajectory(resolved)
    : (await readSessionProjection(resolved.agent, resolved.file, files))
        .trajectory;
  return new Response(`${JSON.stringify(trajectory, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": contentDispositionAtifFilename(resolved.file),
      "x-agent-session-path": encodeURIComponent(resolved.file.path),
    },
  });
}
