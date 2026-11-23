/**
 * Search of the conversation text repo with `git grep HEAD`: the query's
 * words (or a Perl regex) as grep patterns, machine, agent and project as
 * pathspecs, role, kind and the time range checked on each matching line.
 * Sessions rank by their number of matching messages, then by their latest
 * one; a few matching lines become snippets. Sessions of this machine that
 * grew since the repo's last commit are rendered into a scratch directory
 * and grepped with it, so what was said in the last hour is found too.
 *
 * Tool output is not in the repo; `toolOutput` searches raw/ instead, which
 * reads every transcript and is slow.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ADAPTERS, type AgentAdapter } from "./adapters";
import {
  type ArchiveRuntime,
  enabledAdapters,
  localRoot,
  resolveHosts,
} from "./hosts";
import { completeLines, fileRange } from "./lines";
import {
  anyRuleMatches,
  type ArchiveRule,
  type GuiArchiveSettings,
  indexLevelFor,
} from "./settings";
import { listFiles } from "./sync";
import {
  headerLine,
  type ParsedLine,
  type RenderState,
  suffixedPath,
  textPath,
} from "./text-render";
import {
  gitEnv,
  headCommit,
  readTextState,
  renderChunks,
  STATE_PATH,
  type TextState,
  textRepoPath,
  textSources,
} from "./text-repo";
import { readArchived } from "./zstd";

// ------------------------------------------------------------- queries

type Node =
  | { op: "term"; text: string }
  | { op: "and" | "or"; left: Node; right: Node }
  | { op: "not"; left: Node | null; right: Node };

const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"]|"")*)"|([()])|([^\s"()]+)/g;
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    if (match[1] !== undefined) tokens.push(`"${match[1].replace(/""/g, '"')}`);
    else tokens.push((match[2] ?? match[3]) as string);
  }
  return tokens;
}

/**
 * The query as the index read it: bare words and "quoted phrases" must all
 * appear in one message; AND, OR, NOT and parentheses combine them.
 */
export function parseQuery(query: string): Node | null {
  const tokens = tokenize(query);
  let at = 0;
  const peek = () => tokens[at];
  const primary = (): Node | null => {
    const token = tokens[at];
    if (token === undefined) return null;
    if (token === "(") {
      at += 1;
      const inner = orExpr();
      if (peek() === ")") at += 1;
      return inner;
    }
    if (token === ")") return null;
    at += 1;
    if (token.startsWith('"')) {
      const text = token.slice(1);
      return text ? { op: "term", text } : primary();
    }
    if (OPERATORS.has(token)) return primary();
    const text = token.replace(/\*+$/, "");
    return text ? { op: "term", text } : primary();
  };
  const andExpr = (): Node | null => {
    let left = peek() === "NOT" ? null : primary();
    for (;;) {
      const token = peek();
      if (token === undefined || token === ")" || token === "OR") break;
      if (token === "NOT") {
        at += 1;
        const right = primary();
        if (right) left = { op: "not", left, right };
        continue;
      }
      if (token === "AND" || token === "NEAR") at += 1;
      const right = primary();
      if (!right) break;
      left = left ? { op: "and", left, right } : right;
    }
    return left;
  };
  const orExpr = (): Node | null => {
    let left = andExpr();
    while (peek() === "OR") {
      at += 1;
      const right = andExpr();
      if (right) left = left ? { op: "or", left, right } : right;
    }
    return left;
  };
  const node = orExpr();
  return node;
}

/** The node as git grep pattern arguments. */
export function grepArgs(node: Node): string[] {
  switch (node.op) {
    case "term":
      return ["-e", node.text];
    case "and":
    case "or":
      return [
        "(",
        ...grepArgs(node.left),
        `--${node.op}`,
        ...grepArgs(node.right),
        ")",
      ];
    case "not":
      return node.left
        ? [
            "(",
            ...grepArgs(node.left),
            "--and",
            "--not",
            ...grepArgs(node.right),
            ")",
          ]
        : ["--not", ...grepArgs(node.right)];
  }
}

/** The node as a case-insensitive test of a text (raw/ search). */
export function nodeMatcher(node: Node): (lower: string) => boolean {
  switch (node.op) {
    case "term": {
      const needle = node.text.toLowerCase();
      return (text) => text.includes(needle);
    }
    case "and": {
      const [a, b] = [nodeMatcher(node.left), nodeMatcher(node.right)];
      return (text) => a(text) && b(text);
    }
    case "or": {
      const [a, b] = [nodeMatcher(node.left), nodeMatcher(node.right)];
      return (text) => a(text) || b(text);
    }
    case "not": {
      const a = node.left ? nodeMatcher(node.left) : () => true;
      const b = nodeMatcher(node.right);
      return (text) => a(text) && !b(text);
    }
  }
}

/** The positive words of the node, for snippets. */
export function nodeTerms(node: Node | null): string[] {
  if (!node) return [];
  switch (node.op) {
    case "term":
      return [node.text];
    case "and":
    case "or":
      return [...nodeTerms(node.left), ...nodeTerms(node.right)];
    case "not":
      return nodeTerms(node.left);
  }
}

// ----------------------------------------------------------- pathspecs

/** A filter value as a path component's characters, for a glob. */
function globSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._@-]/g, "_");
}

export type PathFilter = { host?: string; agent?: string; project?: string };

/** Pathspecs selecting the transcripts (never the state or the prompt history). */
export function transcriptPathspecs(filter: PathFilter): string[] {
  const host = filter.host ? globSafe(filter.host) : "*";
  const agent = filter.agent ? globSafe(filter.agent) : "*";
  const out: string[] = [];
  if (filter.project)
    out.push(`:(glob)${host}/${agent}/*${globSafe(filter.project)}*/**`);
  else if (filter.host || filter.agent) out.push(`:(glob)${host}/${agent}/**`);
  out.push(`:(exclude)${dirname(STATE_PATH)}`, ":(exclude,glob)*/@history/**");
  return out;
}

export function historyPathspecs(host?: string): string[] {
  return [`:(glob)${host ? globSafe(host) : "*"}/@history/**`];
}

// --------------------------------------------------------------- grep

export type GrepLine = { path: string; line: number; text: string };

/**
 * Stream git grep's matching lines. `tree` greps HEAD of the bare repo;
 * without it, the files of `cwd` (the scratch directory) with --no-index.
 * Exit 1 (no match) is no error.
 */
export async function runGrep(
  options: { repo?: string; cwd?: string; tree?: boolean },
  patterns: string[],
  pathspecs: string[],
  onLine: (hit: GrepLine) => void,
  signal?: AbortSignal,
): Promise<void> {
  const argv = [
    "git",
    ...(options.repo ? ["--git-dir", options.repo] : []),
    "grep",
    "-I",
    "-n",
    "-i",
    "--no-color",
    ...(options.tree ? [] : ["--no-index"]),
    ...patterns,
    ...(options.tree ? ["HEAD"] : []),
    "--",
    ...pathspecs,
  ];
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(),
  });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const prefix = options.tree ? "HEAD:" : "";
  const stderr = new Response(child.stderr).text();
  try {
    for await (const { line } of completeLines(
      child.stdout as unknown as AsyncIterable<Uint8Array>,
    )) {
      const text = line.toString("utf8");
      if (!text.startsWith(prefix)) continue;
      const rest = text.slice(prefix.length);
      const first = rest.indexOf(":");
      const second = rest.indexOf(":", first + 1);
      if (first < 0 || second < 0) continue;
      onLine({
        path: rest.slice(0, first),
        line: Number(rest.slice(first + 1, second)),
        text: rest.slice(second + 1),
      });
    }
    const code = await child.exited;
    if (code !== 0 && code !== 1) {
      const message = (await stderr).trim().slice(0, 300);
      throw new Error(`git grep: exit ${code} ${message}`);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

// ------------------------------------------------------------ overlay

export type OverlayFile = {
  key: string;
  /** Lines of the file already in HEAD: the scratch file's line 1 is offset+1. */
  offset: number;
  render: RenderState;
};

export type Overlay = { dir: string; files: Map<string, OverlayFile> };

type Manifest = {
  head: string | null;
  files: Record<string, { size: number } & OverlayFile & { path: string }>;
};

export function overlayDir(archiveDir: string): string {
  return join(archiveDir, "text-live");
}

/** Where the overlay's files are: what its grep runs in. */
export function overlayFiles(archiveDir: string): string {
  return join(overlayDir(archiveDir), "files");
}

/**
 * This machine's transcripts that grew past what the repo holds, rendered
 * into `<archive>/text-live/` at their repo paths (only the new lines, with
 * the line offset kept). Cached by file size until the next commit.
 */
export async function liveOverlay(
  archiveDir: string,
  settings: GuiArchiveSettings,
  runtime: ArchiveRuntime,
  state: TextState | null,
  head: string | null,
): Promise<Overlay> {
  const dir = overlayFiles(archiveDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifestPath = join(overlayDir(archiveDir), "manifest.json");
  let manifest: Manifest = { head, files: {} };
  try {
    const old = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (old.head === head) manifest = old;
  } catch {
    // None yet.
  }
  const self = resolveHosts(settings, runtime)[0];
  const files = new Map<string, OverlayFile>();
  const next: Manifest = { head, files: {} };
  const taken = new Set(Object.values(state?.files ?? {}).map((f) => f.path));
  if (self) {
    for (const adapter of enabledAdapters(settings)) {
      if (!adapter.indexable) continue;
      const root = localRoot(adapter, self, runtime);
      const candidates: Array<{
        path: string;
        relpath: string;
        size: number;
        history: boolean;
      }> = listFiles(root, adapter).map((file) => ({
        ...file,
        history: false,
      }));
      for (const extra of adapter.extraFiles ?? []) {
        try {
          const path = join(runtime.homeDir, extra.homePath);
          const { size } = Bun.file(path);
          if (size > 0)
            candidates.push({
              path,
              relpath: extra.relpath,
              size,
              history: true,
            });
        } catch {
          // No history here.
        }
      }
      for (const file of candidates) {
        const key = `${self.id}/${adapter.id}/${file.relpath}`;
        const meta = file.history
          ? { project: "", session: "history", subagent: false }
          : adapter.classify(file.relpath);
        const subject = {
          host: self.id,
          agent: adapter.id,
          project: meta.project,
        };
        if (anyRuleMatches(settings.exclude, subject)) continue;
        if (indexLevelFor(settings, subject) === "none") continue;
        const known = state?.files[key];
        const from = known?.textBytes ?? 0;
        if (file.size <= from) continue;
        const cached = manifest.files[key];
        if (cached && cached.size === file.size) {
          next.files[key] = cached;
          files.set(cached.path, cached);
          continue;
        }
        let rendered: Awaited<ReturnType<typeof renderChunks>>;
        try {
          rendered = await renderChunks(
            adapter,
            file.history,
            state?.options ?? {
              toolCallChars: 2000,
              thinking: settings.thinking,
            },
            known?.render,
            fileRange(file.path, from, file.size),
            from,
          );
        } catch {
          continue;
        }
        if (rendered.lines.length === 0) continue;
        let path = known?.path ?? null;
        let body: string;
        let offset: number;
        if (known && path) {
          body = `${rendered.lines.join("\n")}\n`;
          offset = known.lines;
        } else {
          path = textPath(
            {
              host: self.id,
              agent: adapter.id,
              relpath: file.relpath,
              history: file.history,
              ...meta,
            },
            rendered.render,
          );
          if (!path) continue;
          if (taken.has(path)) path = suffixedPath(path, key);
          body = `${headerLine(key, rendered.render)}\n${rendered.lines.join("\n")}\n`;
          offset = 0;
        }
        const target = join(dir, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, body, { mode: 0o600 });
        renameSync(tmp, target);
        const entry = {
          key,
          offset,
          render: rendered.render,
          size: file.size,
          path,
        };
        next.files[key] = entry;
        files.set(path, entry);
      }
    }
  }
  // Scratch files no longer wanted.
  for (const [key, entry] of Object.entries(manifest.files))
    if (!next.files[key] || next.files[key].path !== entry.path)
      rmSync(join(dir, entry.path), { force: true });
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, manifestPath);
  return { dir, files };
}

// ------------------------------------------------------------- search

/** How many matching lines of a session become its snippets. */
export const SNIPPETS_PER_SESSION = 3;

type Agg = {
  path: string;
  count: number;
  lastTs: string;
  recent: Array<{ line: number; parsed: ParsedLine }>;
};

export type FileInfo = {
  key: string;
  host: string;
  agent: string;
  relpath: string;
  history: boolean;
  render: RenderState;
};

/** What a repo path is: from the state, else from its layout. */
export function pathInfo(
  path: string,
  state: TextState | null,
  overlay: Overlay | null,
  byPath: Map<string, string>,
): FileInfo | null {
  const key = byPath.get(path) ?? overlay?.files.get(path)?.key;
  if (key) {
    const [host = "", agent = "", ...rest] = key.split("/");
    const relpath = rest.join("/");
    return {
      key,
      host,
      agent,
      relpath,
      history: relpath.startsWith("@"),
      render:
        overlay?.files.get(path)?.render ?? state?.files[key]?.render ?? {},
    };
  }
  return null;
}

export type Aggregated = {
  total: number;
  files: Agg[];
};

/** Fold matching lines into per-file counts, keeping the latest few. */
export function aggregator(filter: (parsed: ParsedLine) => boolean) {
  const files = new Map<string, Agg>();
  let total = 0;
  return {
    add(path: string, line: number, parsed: ParsedLine | null) {
      if (!parsed || !filter(parsed)) return;
      total += 1;
      let agg = files.get(path);
      if (!agg) {
        agg = { path, count: 0, lastTs: "", recent: [] };
        files.set(path, agg);
      }
      agg.count += 1;
      if (parsed.ts && parsed.ts > agg.lastTs) agg.lastTs = parsed.ts;
      agg.recent.push({ line, parsed });
      if (agg.recent.length > SNIPPETS_PER_SESSION) agg.recent.shift();
    },
    result(): Aggregated {
      return { total, files: [...files.values()] };
    },
  };
}

export function lineFilter(query: {
  role?: string;
  kind?: string;
  since?: string;
  until?: string;
}): (parsed: ParsedLine) => boolean {
  return (parsed) =>
    (!query.role || parsed.role === query.role) &&
    (!query.kind || parsed.kind === query.kind) &&
    (!query.since || (parsed.ts !== null && parsed.ts >= query.since)) &&
    (!query.until || (parsed.ts !== null && parsed.ts <= query.until));
}

export function rankFiles(files: Agg[], recent: boolean): Agg[] {
  return files.sort((a, b) =>
    recent
      ? b.lastTs.localeCompare(a.lastTs) || b.count - a.count
      : b.count - a.count || b.lastTs.localeCompare(a.lastTs),
  );
}

/** A project rule or filter against a path's project component. */
export function hiddenBy(
  rules: readonly ArchiveRule[],
  subject: { host: string; agent: string; project: string },
): boolean {
  return anyRuleMatches(
    rules.map((rule) =>
      rule.project ? { ...rule, project: globSafe(rule.project) } : rule,
    ),
    subject,
  );
}

export function projectOfPath(path: string): string {
  const parts = path.split("/");
  return parts[1] === "@history" ? "" : (parts[2] ?? "");
}

export { headCommit, readTextState, textRepoPath, textSources };
export type { AgentAdapter };

/** Each raw/ file's text, for the slow search of tool output. */
export async function* rawDocs(
  archiveDir: string,
  settings: GuiArchiveSettings,
  filter: PathFilter,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): AsyncGenerator<{
  key: string;
  host: string;
  agent: string;
  relpath: string;
  project: string;
  line: number;
  ts: string | null;
  doc: { role: string; kind: string; tool: string | null; text: string };
  lower: string;
}> {
  const sources = textSources(archiveDir, settings).filter(
    (source) =>
      !source.history &&
      (!filter.host || source.host === filter.host) &&
      (!filter.agent || source.agent === filter.agent),
  );
  let done = 0;
  for (const source of sources) {
    signal?.throwIfAborted();
    onProgress?.(done, sources.length);
    done += 1;
    const adapter = ADAPTERS[source.agent] as AgentAdapter;
    const meta = adapter.classify(source.relpath);
    if (filter.project && !meta.project.includes(filter.project)) continue;
    if (!existsSync(source.zst)) continue;
    const state = {
      thinking: settings.thinking,
      unknown: new Map(),
    } as Parameters<AgentAdapter["parse"]>[1];
    let line = 0;
    let lastTs: string | null = null;
    try {
      for await (const { line: raw } of completeLines(
        readArchived(source.zst),
      )) {
        line += 1;
        if (raw.length === 0) continue;
        let record: unknown;
        try {
          record = JSON.parse(raw.toString("utf8"));
        } catch {
          continue;
        }
        lastTs = adapter.timestampOf(record)?.slice(0, 19) ?? lastTs;
        for (const doc of adapter.parse(record, state))
          yield {
            key: source.key,
            host: source.host,
            agent: source.agent,
            relpath: source.relpath,
            project: state.project || meta.project,
            line,
            ts: lastTs,
            doc,
            lower: doc.text.toLowerCase(),
          };
      }
    } catch {
      // A damaged or growing file: skipped.
    }
  }
  onProgress?.(sources.length, sources.length);
}

export function stateByPath(state: TextState | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, file] of Object.entries(state?.files ?? {}))
    if (file.path) out.set(file.path, key);
  return out;
}

export function textRepoExists(archiveDir: string): boolean {
  return headCommit(textRepoPath(archiveDir)) !== null;
}
