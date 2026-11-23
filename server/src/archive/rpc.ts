/**
 * The archive search view's server side: `bridge.archive.search` and
 * `bridge.archive.open`, read-only, with `archive.hide` applied.
 */
import { type ArchiveRuntime } from "./hosts";
import { openArchived, type OpenedSession } from "./open";
import {
  NoTextRepo,
  type SearchQuery,
  type SearchResult,
  searchArchive,
} from "./search";
import { type GuiArchiveSettings } from "./settings";

export type ArchiveRpcDeps = {
  settings: () => Promise<GuiArchiveSettings>;
  archiveDir: (settings: GuiArchiveSettings) => string;
  runtime: () => ArchiveRuntime;
};

type Params = Record<string, unknown> | undefined;

function text(params: Params, key: string, max: number): string | undefined {
  const value = params?.[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new Error(`invalid ${key}`);
  return value.trim() || undefined;
}

function flag(params: Params, key: string): boolean {
  return params?.[key] === true;
}

export class ArchiveRpcError extends Error {}

export function archiveSearchQuery(params: Params): SearchQuery {
  const query = text(params, "query", 300);
  if (!query) throw new ArchiveRpcError("type something to search for");
  const limit = params?.limit;
  return {
    terms: query.split(/\s+/).filter(Boolean),
    ...(text(params, "host", 64) ? { host: text(params, "host", 64) } : {}),
    ...(text(params, "agent", 40) ? { agent: text(params, "agent", 40) } : {}),
    ...(text(params, "project", 200)
      ? { project: text(params, "project", 200) }
      : {}),
    ...(text(params, "role", 20) ? { role: text(params, "role", 20) } : {}),
    ...(text(params, "since", 32) ? { since: text(params, "since", 32) } : {}),
    ...(text(params, "until", 32) ? { until: text(params, "until", 32) } : {}),
    recent: flag(params, "recent"),
    regex: flag(params, "regex"),
    toolOutput: flag(params, "tool_output"),
    limit:
      typeof limit === "number" && Number.isInteger(limit)
        ? Math.min(Math.max(limit, 1), 200)
        : 50,
  };
}

export function createArchiveRpc(deps: ArchiveRpcDeps) {
  return {
    async search(params: Params): Promise<SearchResult> {
      const settings = await deps.settings();
      try {
        return await searchArchive(
          deps.archiveDir(settings),
          archiveSearchQuery(params),
          settings,
          { runtime: deps.runtime() },
        );
      } catch (error) {
        if (error instanceof NoTextRepo)
          throw new ArchiveRpcError("There is no session archive here yet.", {
            cause: error,
          });
        throw error;
      }
    },
    async open(params: Params): Promise<OpenedSession | null> {
      const settings = await deps.settings();
      const key = text(params, "key", 1000);
      const line = params?.line;
      if (!key || typeof line !== "number" || !Number.isInteger(line))
        throw new ArchiveRpcError("invalid session");
      return openArchived(
        deps.archiveDir(settings),
        settings,
        { key, line, raw: flag(params, "raw") },
        deps.runtime(),
      );
    },
  };
}
