import { isRecord } from "./session-utils";
import { SessionImageGoneError, sessionImage } from "./session-images";
import {
  type AgentTask,
  commandOutputsToWatch,
  subagentsToWatch,
  type WorkflowAgentView,
  type WorkflowView,
  withCommandActivity,
  withSubagentActivity,
} from "./session-tasks";
import { heldOpenFiles } from "./task-output-holders";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { enrichAgentActivity } from "./agent-activity";
import { findLineFromEnd } from "./session-tail";
import type { HerdrCall, SessionFile } from "./session-types";
import {
  claudeSuccessorId,
  createAgentSessionResolverContext,
  type AgentSessionResolverContext,
  resolveAgentSession,
} from "./session-resolver";
import {
  localAgentSessionFiles,
  type AgentSessionFileAccess,
} from "./session-file-access";
import { readAntigravitySessionRecords } from "./antigravity-session";
import type { SessionIndexStore } from "./session-index-store";
import {
  createSessionProjectionCache,
  readSessionProjection,
  readsByTail,
  readTailProjection,
  type SessionProjectionCache,
} from "./session-projection-cache";
import {
  HISTORY_WINDOW_LIMIT,
  historyTextHash,
  redactHistoryEntry,
  redactHistoryUpdate,
} from "./session-history";

const MAX_MESSAGES_PER_AGENT = 200;
/** How much of a task the browser gets: an output's end, a subagent's last. */
const TASK_OUTPUT_BYTES = 32 * 1024;
const TASK_ENTRIES = 200;
/** How long a subagent's conversation file, once looked at, is taken as is. */
const SUBAGENT_STAT_MS = 5000;

/**
 * What the session's subagents' own conversations, and its background
 * commands' output files, say of their tasks (session-tasks.ts
 * `withSubagentActivity`, `withCommandActivity`): only those that may say
 * more than the transcript are looked at, each at most every few seconds,
 * as the Tasks sheet and the Workspaces list poll.
 */
export function createTaskWatcher(
  files: AgentSessionFileAccess,
  clock: () => number = Date.now,
) {
  const seen = new Map<
    string,
    { at: number; file: { mtimeMs: number } | null }
  >();
  // Which output files a process holds open, looked up every few seconds.
  let held: {
    at: number;
    checked: Set<string>;
    open: Set<string> | null;
  } | null = null;
  const stat = async (path: string, now: number) => {
    let entry = seen.get(path);
    if (!entry) {
      const file = await files.statFile(path).catch(() => null);
      entry = { at: now, file: file ? { mtimeMs: file.mtimeMs } : null };
      seen.set(path, entry);
    }
    return entry.file;
  };
  const holds = async (paths: string[], now: number) => {
    if (files.remote) return null;
    const fresh =
      held &&
      now - held.at < SUBAGENT_STAT_MS &&
      paths.every((path) => held!.checked.has(path));
    if (!fresh)
      held = {
        at: now,
        checked: new Set(paths),
        open: await heldOpenFiles(paths),
      };
    return held!.open;
  };
  return async (
    sessionPath: string,
    tasks: AgentTask[],
  ): Promise<AgentTask[]> => {
    const now = clock();
    const ids = subagentsToWatch(tasks, now);
    const outputs = commandOutputsToWatch(tasks, now);
    if (!ids.length && !outputs.length) return tasks;
    const dir = `${sessionPath.replace(/\.jsonl$/, "")}/subagents`;
    for (const [path, entry] of seen)
      if (now - entry.at >= SUBAGENT_STAT_MS) seen.delete(path);
    const activity = new Map<string, { mtimeMs: number } | null>();
    await Promise.all(
      ids.map(async (id) => {
        activity.set(id, await stat(`${dir}/agent-${id}.jsonl`, now));
      }),
    );
    let next = withSubagentActivity(tasks, activity, now);
    if (outputs.length) {
      const outputActivity = new Map<string, { mtimeMs: number } | null>();
      await Promise.all(
        outputs.map(async (path) => {
          outputActivity.set(path, await stat(path, now));
        }),
      );
      const open = await holds(outputs, now);
      next = withCommandActivity(next, outputActivity, now, (path) =>
        open ? open.has(path) : null,
      );
    }
    return next;
  };
}
const TASK_ENTRY_CHARS = 4000;

/** The session Herdr reports for an agent. */
function agentSessionValue(agent: unknown): string | null {
  if (!isRecord(agent) || !isRecord(agent.agent_session)) return null;
  const value = agent.agent_session.value;
  return typeof value === "string" && value ? value : null;
}

/** A pane conversation mode holds: Herdr knows no agent there. */
export type OwnedPane = {
  pane_id: string;
  session_id: string;
  cwd: string;
  agent_status?: string;
  /** The lease's phase; none counts as held ("conversation"). */
  phase?: string;
  /** Herdr's name of the agent driven there; none is claude. */
  agent?: string;
};

function ownedAgentSession(owned: OwnedPane) {
  return {
    source: "roamgate:headless",
    agent: owned.agent ?? "claude",
    kind: "id",
    value: owned.session_id,
  };
}

/**
 * Whether what Herdr says of the pane is still the terminal claude's: only
 * while a takeover starts (the TUI has not exited yet), and only with the
 * session Herdr got from it. Otherwise any claude Herdr sees there is the
 * holder's headless child, detected with no session id and always idle,
 * or the TUI's last word, which no longer holds.
 */
function herdrStillRight(pane: Record<string, unknown>, owned: OwnedPane) {
  if (owned.phase !== "to_conversation") return false;
  if (typeof pane.agent !== "string" || !pane.agent) return false;
  const session = pane.agent_session;
  return isRecord(session) && session.value === owned.session_id;
}

/** Herdr's view of a pane with conversation mode's agent laid over it. */
function overlayPane(
  pane: Record<string, unknown>,
  owned: OwnedPane,
): Record<string, unknown> {
  if (herdrStillRight(pane, owned)) return pane;
  return {
    ...pane,
    agent: owned.agent ?? "claude",
    agent_status: owned.agent_status ?? "idle",
    agent_session: ownedAgentSession(owned),
    foreground_cwd: owned.cwd,
  };
}

/**
 * What Herdr says of panes and agents, with the panes conversation mode
 * holds shown as the Claude panes they are: their holder is no agent to
 * Herdr, which drops their agent and session meanwhile.
 */
export function overlayOwnedPanes(
  method: string,
  params: Record<string, unknown> | undefined,
  result: unknown,
  owned: readonly OwnedPane[],
): unknown {
  if (!owned.length) return result;
  const byPane = new Map(owned.map((each) => [each.pane_id, each]));
  const record = isRecord(result) ? result : {};
  const over = (item: unknown) => {
    if (!isRecord(item) || typeof item.pane_id !== "string") return item;
    const mine = byPane.get(item.pane_id);
    return mine ? overlayPane(item, mine) : item;
  };
  switch (method) {
    case "agent.get": {
      const paneId = typeof params?.target === "string" ? params.target : "";
      const mine = byPane.get(paneId);
      if (!mine) return result;
      const agent = isRecord(record.agent) ? record.agent : {};
      return {
        ...record,
        agent: overlayPane({ ...agent, pane_id: paneId }, mine),
      };
    }
    case "agent.list": {
      if (!Array.isArray(record.agents)) return result;
      const listed = new Set(
        record.agents.flatMap((agent) =>
          isRecord(agent) && typeof agent.pane_id === "string"
            ? [agent.pane_id]
            : [],
        ),
      );
      return {
        ...record,
        agents: [
          ...record.agents.map(over),
          ...owned
            .filter((each) => !listed.has(each.pane_id))
            .map((each) => overlayPane({ pane_id: each.pane_id }, each)),
        ],
      };
    }
    case "pane.list":
      return Array.isArray(record.panes)
        ? { ...record, panes: record.panes.map(over) }
        : result;
    case "pane.get":
      return isRecord(record.pane)
        ? { ...record, pane: over(record.pane) }
        : result;
    default:
      return result;
  }
}

/** A conversation stopped as a shell job in a pane (the chat's Ctrl+Z). */
export type SuspendedPane = {
  pane_id: string;
  session_id: string;
  title?: string;
  suspended_at: string;
};

/**
 * Herdr's panes with the conversations stopped as shell jobs in them: the
 * pane says so (`suspended_conversation`), for its terminal's banner and
 * fg button. Its agent is left as Herdr sees it (a shell).
 */
export function overlaySuspendedPanes(
  method: string,
  result: unknown,
  suspended: readonly SuspendedPane[],
): unknown {
  if (!suspended.length || (method !== "pane.list" && method !== "pane.get"))
    return result;
  const byPane = new Map(suspended.map((each) => [each.pane_id, each]));
  const over = (item: unknown) => {
    if (!isRecord(item) || typeof item.pane_id !== "string") return item;
    const mine = byPane.get(item.pane_id);
    return mine
      ? {
          ...item,
          suspended_conversation: {
            session_id: mine.session_id,
            ...(mine.title ? { title: mine.title } : {}),
            suspended_at: mine.suspended_at,
          },
        }
      : item;
  };
  const record = isRecord(result) ? result : {};
  if (method === "pane.list")
    return Array.isArray(record.panes)
      ? { ...record, panes: record.panes.map(over) }
      : result;
  return isRecord(record.pane)
    ? { ...record, pane: over(record.pane) }
    : result;
}

/**
 * Herdr's calls, with the session conversation mode owns in a pane: while
 * its holder runs, the pane's claude is headless and Herdr does not know
 * the agent (`agent.get` answers not found).
 */
export function withOwnedSessions(
  herdrCall: HerdrCall,
  owned: () => readonly OwnedPane[],
): HerdrCall {
  return async (method, params, ...rest) => {
    let result: unknown;
    try {
      result = await herdrCall(method, params, ...rest);
    } catch (error) {
      const paneId = typeof params?.target === "string" ? params.target : "";
      if (
        method !== "agent.get" ||
        !owned().some((each) => each.pane_id === paneId) ||
        !/not[_ ]found/i.test(String(error))
      )
        throw error;
      result = {};
    }
    return overlayOwnedPanes(method, params, result, owned());
  };
}

export function createAgentSessionHandlers(args: {
  herdrCall: HerdrCall;
  files: AgentSessionFileAccess;
  /** Where large sessions' indexes are kept across restarts. */
  indexStore?: SessionIndexStore | null;
}) {
  const resolverContext = createAgentSessionResolverContext();
  const cache = createSessionProjectionCache(args.files, undefined, {
    store: args.indexStore ?? null,
  });
  const taskActivity = createTaskWatcher(args.files);
  return {
    /** The pane's session file now, for the history watcher. */
    resolvePath: async (params: Record<string, unknown>) =>
      (
        await resolveAgentSession(
          params,
          args.herdrCall,
          args.files,
          resolverContext,
        )
      ).file?.path ?? null,
    listWithActivity: async (params: Record<string, unknown>) =>
      enrichAgentActivity(
        await args.herdrCall("agent.list", params),
        args.files,
        resolverContext,
      ),
    /** The session a pane's agent runs now; null when none is known. */
    paneSession: async (paneId: string) => {
      let result: unknown;
      try {
        result = await args.herdrCall("agent.get", { target: paneId }, 5000);
      } catch (error) {
        if (/not[_ ]found/i.test(String(error))) return null;
        throw error;
      }
      return agentSessionValue(isRecord(result) ? result.agent : null);
    },
    /**
     * The pane whose agent runs a session now: the one reporting it, else
     * the one reporting the session a Claude session went on in after a
     * resume or /clear. Null when no pane runs it.
     */
    sessionPane: async (sessionId: string) => {
      const listed = await args.herdrCall("agent.list", {}, 10_000);
      const agents =
        isRecord(listed) && Array.isArray(listed.agents) ? listed.agents : [];
      const paneOf = (id: string) => {
        for (const agent of agents)
          if (
            isRecord(agent) &&
            typeof agent.pane_id === "string" &&
            agentSessionValue(agent) === id
          )
            return agent.pane_id;
        return null;
      };
      const pane = paneOf(sessionId);
      if (pane) return pane;
      const next = await claudeSuccessorId(
        sessionId,
        args.files,
        resolverContext,
      ).catch(() => null);
      return next ? paneOf(next) : null;
    },
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
    /** The pane's transcript records for a rewind's scan; null: none. */
    readRecords: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      return resolved.file ? cache.records(resolved) : null;
    },
    /** Entries before one the history shows: a page, as the user scrolls up. */
    readOlder: async (params: Record<string, unknown>) => {
      const beforeId =
        typeof params.before_id === "string" ? params.before_id : "";
      if (!beforeId) throw new Error("before_id is required");
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
      const page = await cache.older(
        resolved,
        beforeId,
        Number(params.limit) || 50,
      );
      return {
        ...resolved,
        entries: page.entries.map(redactHistoryEntry),
        has_more: page.has_more,
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
      const entries = await cache.entries(resolved);
      const entryId =
        typeof params.entry_id === "string" ? params.entry_id : "";
      const entry = entries.find((candidate) => candidate.id === entryId);
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
    /** An image the user sent inline in a message (HistoryEntry.images). */
    readImage: async (params: Record<string, unknown>) => {
      const uuid = typeof params.uuid === "string" ? params.uuid : "";
      const index = typeof params.index === "number" ? params.index : 0;
      if (!/^[\w-]{1,64}$/.test(uuid))
        throw new SessionImageGoneError("invalid uuid");
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file)
        throw new Error(resolved.detail || "Agent session is unavailable");
      // A large transcript is searched from its end for that record's line.
      const image = readsByTail(resolved.agent, resolved.file, args.files)
        ? await findLineFromEnd(
            args.files.readRange!.bind(args.files),
            resolved.file.path,
            resolved.file.size ?? 0,
            JSON.stringify(uuid),
            (line) => sessionImage(line, uuid, index),
          )
        : sessionImage(
            await args.files.readText(resolved.file.path),
            uuid,
            index,
          );
      if (!image)
        throw new SessionImageGoneError("That image is not in the session");
      return image;
    },
    /** The skills and custom commands a Claude session offers as /name. */
    readCommands: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) return { commands: [] };
      const projection = await cache.aggregates(resolved);
      return {
        commands: projection.commands,
        ...(isPartial(projection) ? { partial: true } : {}),
      };
    },
    readArtifacts: async (params: Record<string, unknown>) => {
      const resolved = await resolveAgentSession(
        params,
        args.herdrCall,
        args.files,
        resolverContext,
      );
      if (!resolved.file) return { artifacts: [] };
      const projection = await cache.aggregates(resolved);
      return {
        artifacts: projection.artifacts,
        ...(isPartial(projection) ? { partial: true } : {}),
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
      const projection = await cache.aggregates(resolved);
      // The session they belong to: its transcript's name, its id for Claude.
      return {
        tasks: await taskActivity(resolved.file.path, projection.tasks),
        session: basename(resolved.file.path).replace(/\.jsonl$/, ""),
        ...(isPartial(projection) ? { partial: true } : {}),
      };
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
      let projection = await cache.get(resolved);
      let task = projection.tasks.find((each) => each.id === params.task_id);
      // Read from part of the session: the whole of it may have it.
      if (!task && isPartial(projection)) {
        projection = await cache.get(resolved, { wait: true });
        task = projection.tasks.find((each) => each.id === params.task_id);
      }
      if (!task) throw new Error("That task is no longer in the session");
      [task] = await taskActivity(resolved.file.path, [task]);
      if (!task) throw new Error("That task is no longer in the session");
      const sessionDir = resolved.file.path.replace(/\.jsonl$/, "");
      // A conversation beside the session: a subagent's, a teammate's, or
      // one of a workflow's agents'.
      const conversation = async (path: string) => {
        const file = await args.files.statFile(path);
        if (!file) return [];
        // A long one is read from its end: only that much is shown.
        const projected = readsByTail("claude", file, args.files)
          ? await readTailProjection(file, args.files)
          : await readSessionProjection("claude", file, args.files);
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
    ? await cache.recent(resolved)
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
    ? await cache.aggregates(resolved)
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
    // A large session's index is not ready yet: asked again, it will be.
    ...(isPartial(projected) ? { partial: true } : {}),
  };
}

/** Aggregates from part of a large session (its index not ready yet). */
function isPartial(projected: object): boolean {
  return (projected as { partial?: unknown }).partial === true;
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
    ? await cache.trajectory(resolved, { whole: true })
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
