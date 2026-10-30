import { isRecord } from "./session-utils";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { enrichAgentActivity } from "./agent-activity";
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

/** The session Herdr reports for an agent. */
function agentSessionValue(agent: unknown): string | null {
  if (!isRecord(agent) || !isRecord(agent.agent_session)) return null;
  const value = agent.agent_session.value;
  return typeof value === "string" && value ? value : null;
}

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
      // A message's images, with their data while the session keeps it.
      const images = entry.images?.map((image) => ({
        ...image,
        data: projection.images[image.hash]?.data,
      }));
      return {
        entry_id: entry.id,
        text: entry.text,
        text_hash: historyTextHash(entry.text),
        ...(images?.length && images.every((image) => image.data)
          ? { images }
          : {}),
      };
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
