/** Archive search: `searchArchive` greps the conversation text repo (text-search.ts). */
import { ADAPTERS } from "./adapters";
import { type ArchiveRuntime } from "./hosts";
import { type GuiArchiveSettings } from "./settings";
import { parseTextLine, type ParsedLine } from "./text-render";
import {
  aggregator,
  type FileInfo,
  grepArgs,
  hiddenBy,
  historyPathspecs,
  lineFilter,
  liveOverlay,
  nodeMatcher,
  nodeTerms,
  type Overlay,
  overlayFiles,
  parseQuery,
  pathInfo,
  projectOfPath,
  rankFiles,
  rawDocs,
  runGrep,
  stateByPath,
  transcriptPathspecs,
} from "./text-search";
import { headCommit, readTextState, textRepoPath } from "./text-repo";

export const SNIPPET_WIDTH = 120;

export type SearchQuery = {
  terms: string[];
  agent?: string;
  host?: string;
  project?: string;
  role?: string;
  kind?: string;
  since?: string;
  until?: string;
  recent?: boolean;
  history?: boolean;
  /** The query is one Perl-compatible regular expression (git grep -P). */
  regex?: boolean;
  /** Search tool output too: greps raw/, slow. */
  toolOutput?: boolean;
  limit: number;
};

export type { SearchHit, SearchResult } from "../../../shared/archiveSearch";
import type { SearchHit, SearchResult } from "../../../shared/archiveSearch";

function lower(char: string): string {
  return char.toLowerCase().charAt(0) || char;
}

/** Context around the first match, with every match in the window in [brackets]. */
export function makeSnippet(
  text: string,
  terms: string[],
  width: number,
): string {
  const chars = Array.from(text);
  const low = chars.map(lower);
  const needles = terms
    .filter(Boolean)
    .map((term) => Array.from(term).map(lower));
  const findAll = (
    needle: string[],
    lo: number,
    hi: number,
  ): Array<[number, number]> => {
    const found: Array<[number, number]> = [];
    if (needle.length === 0 || hi < lo + needle.length) return found;
    let i = lo;
    while (i + needle.length <= hi) {
      let match = true;
      for (let k = 0; k < needle.length; k += 1)
        if (low[i + k] !== needle[k]) {
          match = false;
          break;
        }
      if (match) {
        found.push([i, i + needle.length]);
        i += needle.length;
      } else i += 1;
    }
    return found;
  };
  const firsts = needles
    .map((needle) => findAll(needle, 0, low.length)[0]?.[0])
    .filter((value): value is number => value !== undefined);
  if (firsts.length === 0)
    return chars
      .slice(0, 2 * width)
      .join("")
      .replace(/\n/g, " ");
  const first = Math.min(...firsts);
  const a = Math.max(0, first - width);
  const b = Math.min(chars.length, first + width);
  const ranges = needles
    .flatMap((needle) => findAll(needle, a, b))
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  let out = a > 0 ? "... " : "";
  let at = a;
  for (const [start, end] of merged) {
    out += chars.slice(at, start).join("");
    out += `[${chars.slice(start, end).join("")}]`;
    at = end;
  }
  out += chars.slice(at, b).join("");
  if (b < chars.length) out += " ...";
  return out.replace(/\n/g, " ");
}

// ------------------------------------------------------- the text repo

export type SearchOptions = {
  /** This machine, for the sessions grown since the last commit. */
  runtime?: ArchiveRuntime;
  /** Search the grown sessions too (default when a runtime is given). */
  live?: boolean;
  signal?: AbortSignal;
  /** Progress of a toolOutput search, in raw/ files. */
  onProgress?: (done: number, total: number) => void;
};

export class NoTextRepo extends Error {
  constructor() {
    super(
      "the archive has no text repo yet; run `roamgate archive rebuild-text`",
    );
  }
}

function regexTerms(source: string, texts: string[]): string[] {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "giu");
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(pattern)) {
      if (match[0]) found.add(match[0]);
      if (found.size > 8) break;
    }
  return [...found];
}

type Agg = ReturnType<ReturnType<typeof aggregator>["result"]>["files"][number];

function buildHits(
  files: Agg[],
  info: (path: string) => FileInfo | null,
  query: SearchQuery,
  settings: Pick<GuiArchiveSettings, "hide">,
  terms: string[],
): { hits: SearchHit[]; total: number; sessions: number } {
  const hits: SearchHit[] = [];
  let total = 0;
  let sessions = 0;
  for (const file of rankFiles(files, query.recent === true)) {
    const meta = info(file.path);
    if (!meta) continue;
    const adapter = ADAPTERS[meta.agent];
    const project = projectOfPath(file.path) || meta.render.project || "";
    if (
      hiddenBy(settings.hide, { host: meta.host, agent: meta.agent, project })
    )
      continue;
    total += file.count;
    sessions += 1;
    if (hits.length >= Math.max(1, query.limit)) continue;
    const classified = meta.history
      ? { project: "", session: "history", subagent: false }
      : (adapter?.classify(meta.relpath) ?? {
          project,
          session: meta.relpath,
          subagent: false,
        });
    const latest = file.recent[file.recent.length - 1] as {
      line: number;
      parsed: ParsedLine;
    };
    const needles = query.regex
      ? regexTerms(
          query.terms.join(" "),
          file.recent.map((entry) => entry.parsed.text),
        )
      : terms;
    hits.push({
      session: classified.session,
      agent: meta.agent,
      host: meta.host,
      project,
      subagent: classified.subagent,
      title: meta.render.lastTitle ?? null,
      ts: latest.parsed.ts,
      role: latest.parsed.role,
      kind: latest.parsed.kind,
      tool: latest.parsed.tool,
      snippet: makeSnippet(latest.parsed.text, needles, SNIPPET_WIDTH),
      doc: latest.line,
      cost_usd: meta.render.cost ?? null,
      matches: file.count,
      snippets: file.recent.map((entry) =>
        makeSnippet(entry.parsed.text, needles, SNIPPET_WIDTH),
      ),
      path: file.path,
      key: meta.key,
    });
  }
  return { hits, total, sessions };
}

/**
 * Search the conversation text with git grep: words or phrases that must all
 * appear in one message (AND, OR, NOT as the index had them), or one Perl
 * regex; one hit per session, sessions ranked by matching messages, then by
 * the latest one (or newest first with `recent`).
 */
export async function searchArchive(
  archiveDir: string,
  query: SearchQuery,
  settings: GuiArchiveSettings,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const raw = query.terms.join(" ").trim();
  if (query.toolOutput) return searchRaw(archiveDir, query, settings, options);
  const repo = textRepoPath(archiveDir);
  const head = headCommit(repo);
  if (!head) throw new NoTextRepo();
  const node = query.regex ? null : parseQuery(raw);
  if (!query.regex && !node)
    return { query: raw, total: 0, hits: [], truncated: false, source: "text" };
  const patterns = query.regex
    ? ["-P", "-e", raw]
    : ["-F", ...grepArgs(node as NonNullable<typeof node>)];
  const state = readTextState(repo);
  const byPath = stateByPath(state);
  const filter = {
    ...(query.host ? { host: query.host } : {}),
    ...(query.agent ? { agent: query.agent } : {}),
    ...(query.project ? { project: query.project } : {}),
  };
  const agg = aggregator(lineFilter(query));
  const pathspecs = transcriptPathspecs(filter);
  await runGrep(
    { repo, tree: true },
    patterns,
    pathspecs,
    (hit) => agg.add(hit.path, hit.line, parseTextLine(hit.text)),
    options.signal,
  );
  let overlay: Overlay | null = null;
  if (options.runtime && options.live !== false) {
    overlay = await liveOverlay(
      archiveDir,
      settings,
      options.runtime,
      state,
      head,
    );
    if (overlay.files.size > 0)
      await runGrep(
        { cwd: overlayFiles(archiveDir) },
        patterns,
        pathspecs,
        (hit) =>
          agg.add(
            hit.path,
            hit.line + (overlay?.files.get(hit.path)?.offset ?? 0),
            parseTextLine(hit.text),
          ),
        options.signal,
      );
  }
  const { files } = agg.result();
  const built = buildHits(
    files,
    (path) => pathInfo(path, state, overlay, byPath),
    query,
    settings,
    nodeTerms(node),
  );
  const result: SearchResult = {
    query: raw,
    total: built.total,
    hits: built.hits,
    truncated: built.sessions > built.hits.length,
    sessions: built.sessions,
    source: "text",
  };
  if (query.history) {
    const entries: NonNullable<SearchResult["history"]> = [];
    const terms = nodeTerms(node);
    await runGrep(
      { repo, tree: true },
      patterns,
      historyPathspecs(query.host),
      (hit) => {
        const parsed = parseTextLine(hit.text);
        if (!parsed) return;
        const needles = query.regex ? regexTerms(raw, [parsed.text]) : terms;
        entries.push({
          host: hit.path.split("/")[0] ?? "",
          ts: parsed.ts,
          project: parsed.tool && parsed.tool !== "-" ? parsed.tool : null,
          snippet: makeSnippet(parsed.text, needles, SNIPPET_WIDTH),
        });
      },
      options.signal,
    );
    entries.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
    result.history = entries.slice(0, query.limit);
  }
  return result;
}

/**
 * Search everything raw/ holds, tool output included, by reading every
 * transcript: minutes on a large archive, so only on explicit request.
 */
export async function searchRaw(
  archiveDir: string,
  query: SearchQuery,
  settings: GuiArchiveSettings,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const raw = query.terms.join(" ").trim();
  let test: (text: string, lower: string) => boolean;
  let terms: string[] = [];
  if (query.regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(raw, "iu");
    } catch (error) {
      throw new Error(`invalid regex: ${(error as Error).message}`, {
        cause: error,
      });
    }
    test = (text) => pattern.test(text);
  } else {
    const node = parseQuery(raw);
    if (!node)
      return {
        query: raw,
        total: 0,
        hits: [],
        truncated: false,
        source: "raw",
      };
    const match = nodeMatcher(node);
    test = (_text, lower) => match(lower);
    terms = nodeTerms(node);
  }
  const keep = lineFilter(query);
  const agg = aggregator(keep);
  const infos = new Map<string, FileInfo>();
  for await (const entry of rawDocs(
    archiveDir,
    settings,
    {
      ...(query.host ? { host: query.host } : {}),
      ...(query.agent ? { agent: query.agent } : {}),
      ...(query.project ? { project: query.project } : {}),
    },
    options.onProgress,
    options.signal,
  )) {
    if (!test(entry.doc.text, entry.lower)) continue;
    infos.set(entry.key, {
      key: entry.key,
      host: entry.host,
      agent: entry.agent,
      relpath: entry.relpath,
      history: false,
      render: { project: entry.project },
    });
    agg.add(entry.key, entry.line, {
      ts: entry.ts,
      role: entry.doc.role,
      kind: entry.doc.kind,
      tool: entry.doc.tool,
      text: entry.doc.text.replace(/\s+/g, " "),
    });
  }
  const { files } = agg.result();
  const built = buildHits(
    files.map((file) => ({ ...file })),
    (key) => infos.get(key) ?? null,
    query,
    settings,
    terms,
  );
  for (const hit of built.hits) {
    hit.project = infos.get(hit.path ?? "")?.render.project ?? hit.project;
    delete hit.path;
  }
  return {
    query: raw,
    total: built.total,
    hits: built.hits,
    truncated: built.sessions > built.hits.length,
    sessions: built.sessions,
    source: "raw",
    warning:
      "searched tool output by reading every archived transcript in raw/: slow",
  };
}
