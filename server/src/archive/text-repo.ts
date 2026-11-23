/**
 * The conversation text repo: `<archive>/text.git`, a bare git repo holding
 * the conversation text of every archived transcript, one line per message
 * (text-render.ts), searched with `git grep HEAD` (text-search.ts). It is
 * derived: raw/ is the record, and `rebuild-text` builds the repo again from
 * it.
 *
 * A pass renders what raw/ gained since the last one, from the byte offsets
 * the indexer records (`files.archived_size` and `files.zst_size`, which are
 * also the boundaries of the zstd frames, so a grown file is decompressed
 * from its last frame only), and writes one commit with `git fast-import`.
 * What the pass knows about every file (its path in the repo, how far it was
 * rendered, the renderer's state) is `.roamgate/state.json` in the same
 * commit, so the text and its bookkeeping never disagree.
 */
import { Database } from "bun:sqlite";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { ADAPTERS, type AgentAdapter } from "./adapters";
import { acquireHostLock } from "./lock";
import { completeLines } from "./lines";
import { indexLevelFor, type GuiArchiveSettings } from "./settings";
import { existingArchiveDb } from "./store";
import {
  DEFAULT_TOOL_CALL_CHARS,
  headerLine,
  RENDER_VERSION,
  type RenderOptions,
  type RenderState,
  suffixedPath,
  TextRenderer,
  textPath,
} from "./text-render";

export const TEXT_REPO = "text.git";
export const STATE_PATH = ".roamgate/state.json";
const BRANCH = "refs/heads/main";
/** The lock name; host ids start with a letter or digit, so it never meets one. */
const LOCK = "@text";
const REPACK_EVERY_MS = 24 * 60 * 60 * 1000;
/** fast-import input buffered before waiting for git to read it. */
const FLUSH_BYTES = 4 << 20;

export function textRepoPath(archiveDir: string): string {
  return join(archiveDir, TEXT_REPO);
}

/** What the repo knows about one raw/ file. */
export type TextFileState = {
  path: string;
  /** Source bytes rendered: the end of the last complete line. */
  textBytes: number;
  /** A zstd frame boundary at or before textBytes: source and .zst offsets. */
  seekSrc: number;
  seekZst: number;
  /** The .zst's inode when rendered: a shrunk source starts a new file. */
  ino: number;
  /** Lines in the text file, header included. */
  lines: number;
  render: RenderState;
};

export type TextState = {
  version: number;
  options: RenderOptions;
  files: Record<string, TextFileState>;
  /** Secret-looking values replaced so far. */
  redactions: number;
};

export type TextRepoStatus = {
  exists: boolean;
  path: string;
  head: string | null;
  last_commit: string | null;
  last_repack: string | null;
  files: number;
  redactions: number;
  pack_bytes: number;
  stale_render: boolean;
};

export type TextPassReport = {
  status: "committed" | "unchanged" | "locked" | "deferred";
  files: number;
  lines: number;
  redactions: number;
  commit: string | null;
  repacked: boolean;
  seconds: number;
  message?: string;
};

export type TextPassOptions = {
  archiveDir: string;
  settings: GuiArchiveSettings;
  /** This machine's archive host id, for the committer. */
  host: string;
  log: (message: string) => void;
  /** Asked first: true defers the pass (GameMode runs). */
  busy?: () => Promise<boolean>;
  now?: () => Date;
  /** Run the daily repack when due (default true). */
  repack?: boolean;
};

export function renderOptionsFor(settings: GuiArchiveSettings): RenderOptions {
  return {
    toolCallChars: settings.text_tool_chars ?? DEFAULT_TOOL_CALL_CHARS,
    thinking: settings.thinking,
  };
}

function emptyState(options: RenderOptions): TextState {
  return { version: RENDER_VERSION, options, files: {}, redactions: 0 };
}

// ---------------------------------------------------------------- git

export type GitResult = { code: number; stdout: Buffer; stderr: string };

/**
 * The environment of every text repo git: none of the user's git config or
 * GIT_* variables (a `grep.column` or a `GIT_DIR` would change what is
 * written or parsed), UTF-8, never prompting.
 */
export function gitEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("GIT_")) out[key] = value;
  return {
    ...out,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
  };
}

/** Runs git on the bare repo, never prompting, never reading user hooks. */
export function git(
  repo: string,
  args: string[],
  input?: string | Buffer,
): GitResult {
  const result = Bun.spawnSync(
    ["git", "--git-dir", repo, "-c", "core.hooksPath=/dev/null", ...args],
    {
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(),
    },
  );
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString(),
  };
}

function gitOk(repo: string, args: string[]): string {
  const result = git(repo, args);
  if (result.code !== 0)
    throw new Error(
      `git ${args[0]}: exit ${result.code} ${result.stderr.trim().slice(0, 300)}`,
    );
  return result.stdout.toString().trim();
}

export function initTextRepo(repo: string): void {
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  if (!existsSync(join(repo, "HEAD")))
    gitOk(repo, ["init", "--bare", "--quiet", "--initial-branch=main"]);
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["core.commitGraph", "true"],
    ["fetch.writeCommitGraph", "true"],
    ["uploadpack.allowFilter", "true"],
  ] as const)
    gitOk(repo, ["config", key, value]);
}

export function headCommit(repo: string): string | null {
  if (!existsSync(join(repo, "HEAD"))) return null;
  const result = git(repo, ["rev-parse", "--verify", "--quiet", BRANCH]);
  return result.code === 0 ? result.stdout.toString().trim() : null;
}

/** A file of HEAD, or null. */
export function readHeadFile(repo: string, path: string): Buffer | null {
  const result = git(repo, ["cat-file", "blob", `${BRANCH}:${path}`]);
  return result.code === 0 ? result.stdout : null;
}

export function readTextState(repo: string): TextState | null {
  const raw = readHeadFile(repo, STATE_PATH);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as TextState;
    return parsed && typeof parsed.files === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ sources

/** One raw/ file the repo renders. */
export type TextSource = {
  key: string;
  host: string;
  agent: string;
  relpath: string;
  history: boolean;
  zst: string;
  /** Decompressed bytes archived, when the index knows (a frame boundary). */
  archived?: number;
  /** The .zst's size at that point. */
  zstSize?: number;
};

type FileRow = {
  host: string;
  agent: string;
  relpath: string;
  kind: string;
  project: string | null;
  archived_size: number;
  zst_size: number;
  index_level: string;
};

function renderable(
  adapter: AgentAdapter | undefined,
  history: boolean,
): adapter is AgentAdapter {
  return Boolean(adapter && (adapter.indexable || history));
}

/**
 * The raw/ files to render: from the archive database's files table when it
 * exists (its offsets are frame boundaries), else every .zst under raw/.
 * Files whose index level is "none" are left out.
 */
export function textSources(
  archiveDir: string,
  settings: GuiArchiveSettings,
): TextSource[] {
  const raw = join(archiveDir, "raw");
  const out: TextSource[] = [];
  const dbPath = existingArchiveDb(archiveDir);
  if (dbPath) {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 30000");
      const rows = db
        .query<FileRow, []>(
          `SELECT host, agent, relpath, kind, project, archived_size, zst_size, index_level
           FROM files ORDER BY host, agent, relpath`,
        )
        .all();
      for (const row of rows) {
        const history = row.kind === "history";
        const adapter = ADAPTERS[row.agent];
        if (!renderable(adapter, history)) continue;
        if (row.index_level === "none") continue;
        out.push({
          key: `${row.host}/${row.agent}/${row.relpath}`,
          host: row.host,
          agent: row.agent,
          relpath: row.relpath,
          history,
          zst: join(raw, row.host, row.agent, `${row.relpath}.zst`),
          archived: row.archived_size,
          zstSize: row.zst_size,
        });
      }
      return out;
    } finally {
      db.close(false);
    }
  }
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".zst")) {
        const [host, agent, ...rest] = relative(raw, path).split("/");
        const relpath = rest.join("/").replace(/\.zst$/, "");
        if (!host || !agent || !relpath) continue;
        const history = relpath.startsWith("@");
        const adapter = ADAPTERS[agent];
        if (!renderable(adapter, history)) continue;
        const meta = history ? { project: "" } : adapter.classify(relpath);
        if (
          indexLevelFor(settings, { host, agent, project: meta.project }) ===
          "none"
        )
          continue;
        out.push({
          key: `${host}/${agent}/${relpath}`,
          host,
          agent,
          relpath,
          history,
          zst: path,
        });
      }
    }
  };
  walk(raw);
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * Decompressed bytes of a .zst from `seekZst` (a frame boundary, at source
 * offset `seekSrc`), skipping to `from`, up to `end` source bytes when known.
 */
async function* rawRange(
  zst: string,
  seekZst: number,
  seekSrc: number,
  from: number,
  zstEnd: number | undefined,
  end: number | undefined,
): AsyncGenerator<Buffer> {
  if (zstEnd !== undefined && zstEnd <= seekZst) return;
  const file = createReadStream(zst, {
    start: seekZst,
    ...(zstEnd !== undefined ? { end: zstEnd - 1 } : {}),
    highWaterMark: 1 << 20,
  });
  const decompress = zlib.createZstdDecompress();
  file.on("error", (error) => decompress.destroy(error));
  let offset = seekSrc;
  for await (const raw of file.pipe(decompress) as Readable) {
    const chunk = raw as Buffer;
    const start = offset;
    offset += chunk.length;
    if (offset <= from) continue;
    let piece = start < from ? chunk.subarray(from - start) : chunk;
    if (end !== undefined && offset > end) {
      piece = piece.subarray(0, Math.max(0, piece.length - (offset - end)));
      if (piece.length) yield piece;
      return;
    }
    yield piece;
  }
}

// ------------------------------------------------------------- render

export type Rendered = {
  lines: string[];
  textBytes: number;
  /** All source bytes read (the frame end when the read reached it). */
  readTo: number;
  render: RenderState;
  redactions: number;
};

/** Render the complete lines of `chunks` (starting at source byte `from`). */
export async function renderChunks(
  adapter: AgentAdapter,
  history: boolean,
  options: RenderOptions,
  saved: RenderState | undefined,
  chunks: AsyncIterable<Buffer>,
  from: number,
): Promise<Rendered> {
  const renderer = new TextRenderer(adapter, history, options, saved);
  let position = from;
  let readTo = from;
  const counted = (async function* () {
    for await (const chunk of chunks) {
      readTo += chunk.length;
      yield chunk;
    }
  })();
  for await (const { line, length } of completeLines(counted)) {
    position += length;
    renderer.line(line);
  }
  return {
    lines: renderer.lines,
    textBytes: position,
    readTo,
    render: renderer.save(),
    redactions: renderer.redactions,
  };
}

// ------------------------------------------------------------ the pass

type Change = { path: string; content: Buffer } | { remove: string };

class FastImport {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private stdin: import("bun").FileSink | null = null;
  constructor(
    private readonly repo: string,
    private readonly header: () => string,
  ) {}

  private open(): import("bun").FileSink {
    if (this.stdin) return this.stdin;
    this.child = Bun.spawn(
      [
        "git",
        "--git-dir",
        this.repo,
        "fast-import",
        "--quiet",
        "--done",
        "--force",
      ],
      {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
        env: gitEnv(),
      },
    );
    this.stdin = this.child.stdin as import("bun").FileSink;
    this.stdin.write(this.header());
    return this.stdin;
  }

  get used(): boolean {
    return this.stdin !== null;
  }

  /** Bytes written since the last flush. */
  private pending = 0;

  /** Waits for git to take what was written once a few MB are buffered. */
  private async drain(bytes: number): Promise<void> {
    this.pending += bytes;
    if (this.pending < FLUSH_BYTES || !this.stdin) return;
    this.pending = 0;
    await this.stdin.flush();
  }

  async write(change: Change): Promise<void> {
    const sink = this.open();
    if ("remove" in change) {
      sink.write(`D ${quotePath(change.remove)}\n`);
      return;
    }
    sink.write(
      `M 100644 inline ${quotePath(change.path)}\ndata ${change.content.length}\n`,
    );
    sink.write(change.content);
    sink.write("\n");
    await this.drain(change.content.length);
  }

  rename(from: string, to: string): void {
    this.open().write(`R ${quotePath(from)} ${quotePath(to)}\n`);
  }

  async finish(): Promise<void> {
    if (!this.stdin || !this.child) return;
    this.stdin.write("\ndone\n");
    await this.stdin.end();
    const [code, stderr] = await Promise.all([
      this.child.exited,
      new Response(this.child.stderr as ReadableStream).text(),
    ]);
    if (code !== 0)
      throw new Error(
        `git fast-import: exit ${code} ${stderr.trim().slice(0, 300)}`,
      );
  }

  abort(): void {
    this.child?.kill();
  }
}

/** Paths are safe components joined with `/`; quoted only if ever needed. */
function quotePath(path: string): string {
  return /^[A-Za-z0-9._@/-]+$/.test(path) ? path : JSON.stringify(path);
}

function dataBlock(text: string): string {
  return `data ${Buffer.byteLength(text)}\n${text}\n`;
}

type PassContext = {
  repo: string;
  state: TextState;
  /** Paths in HEAD: path -> key, and each key's path in HEAD. */
  owners: Map<string, string>;
  headPaths: Map<string, string>;
  out: FastImport;
  files: number;
  lines: number;
  redactions: number;
  /** The state changed (offsets moved) even if no text did. */
  dirty: boolean;
};

function headContent(ctx: PassContext, key: string): string {
  const path = ctx.headPaths.get(key);
  if (!path) return "";
  const raw = readHeadFile(ctx.repo, path);
  return raw ? raw.toString("utf8") : "";
}

/**
 * Give `key` its path: the base path unless another raw/ file holds it.
 * Claimants are ordered by raw path; the first keeps the base, every other
 * takes the sha256 suffix, so a rebuild gives every file the same name. A
 * newcomer that sorts first takes the base and moves the holder aside.
 */
function claim(ctx: PassContext, key: string, base: string): string {
  const holder = ctx.owners.get(base);
  if (!holder || holder === key) {
    ctx.owners.set(base, key);
    return base;
  }
  if (holder < key) {
    const mine = suffixedPath(base, key);
    ctx.owners.set(mine, key);
    return mine;
  }
  const moved = suffixedPath(base, holder);
  const held = ctx.state.files[holder];
  if (held) {
    ctx.out.rename(base, moved);
    held.path = moved;
    ctx.owners.set(moved, holder);
  }
  ctx.owners.set(base, key);
  return base;
}

async function renderSource(
  ctx: PassContext,
  source: TextSource,
): Promise<void> {
  const adapter = ADAPTERS[source.agent] as AgentAdapter;
  let ino: number;
  let zstNow: number;
  try {
    const stat = statSync(source.zst);
    ino = stat.ino;
    zstNow = stat.size;
  } catch {
    return; // Not archived yet.
  }
  const known = ctx.state.files[source.key];
  const archived = source.archived;
  const fresh =
    !known ||
    known.ino !== ino ||
    (archived !== undefined && archived < known.textBytes) ||
    zstNow < known.seekZst;
  if (!fresh && archived !== undefined && archived === known.textBytes) return;
  const zstEnd = source.zstSize ?? zstNow;
  if (!fresh && archived === undefined && zstEnd === known.seekZst) return;
  const from = fresh ? 0 : known.textBytes;
  const seekSrc = fresh ? 0 : known.seekSrc;
  const seekZst = fresh ? 0 : known.seekZst;
  let rendered: Rendered;
  try {
    rendered = await renderChunks(
      adapter,
      source.history,
      ctx.state.options,
      fresh ? undefined : known.render,
      rawRange(source.zst, seekZst, seekSrc, from, zstEnd, archived),
      from,
    );
  } catch {
    return; // A frame being written, or damaged: the next pass retries.
  }
  // The read reached the end of the last frame: a boundary to resume from.
  const end = archived ?? rendered.readTo;
  const atBoundary = rendered.textBytes === end;
  const meta = source.history
    ? { project: "", session: "history", subagent: false }
    : adapter.classify(source.relpath);
  const subject = {
    host: source.host,
    agent: source.agent,
    relpath: source.relpath,
    history: source.history,
    ...meta,
  };
  if (fresh || !known.path) {
    // A new file, or one with no text yet: its first lines get a path. Until
    // then it is kept with an empty path, so it is not read again from 0.
    if (!fresh && rendered.textBytes === known.textBytes) return;
    const old = fresh ? known?.path : "";
    if (old) {
      await ctx.out.write({ remove: old });
      if (ctx.owners.get(old) === source.key) ctx.owners.delete(old);
      ctx.headPaths.delete(source.key);
    }
    const base = textPath(subject, rendered.render);
    let path = "";
    if (base && rendered.lines.length > 0) {
      path = claim(ctx, source.key, base);
      const body = `${headerLine(source.key, rendered.render)}\n${rendered.lines.join("\n")}\n`;
      await ctx.out.write({ path, content: Buffer.from(body) });
    }
    const seek = atBoundary
      ? { seekSrc: end, seekZst: zstEnd }
      : fresh
        ? { seekSrc: 0, seekZst: 0 }
        : { seekSrc: known.seekSrc, seekZst: known.seekZst };
    ctx.state.files[source.key] = {
      path,
      textBytes: rendered.textBytes,
      ...seek,
      ino,
      lines: path ? rendered.lines.length + 1 : 0,
      render: rendered.render,
    };
  } else {
    if (rendered.textBytes === known.textBytes) return;
    const header = headerLine(source.key, rendered.render);
    if (rendered.lines.length > 0) {
      const old = headContent(ctx, source.key);
      const rest = old.slice(old.indexOf("\n") + 1);
      const body = `${header}\n${rest}${rendered.lines.join("\n")}\n`;
      await ctx.out.write({ path: known.path, content: Buffer.from(body) });
    }
    known.textBytes = rendered.textBytes;
    if (atBoundary) {
      known.seekSrc = end;
      known.seekZst = zstEnd;
    }
    known.lines += rendered.lines.length;
    known.render = rendered.render;
  }
  ctx.dirty = true;
  if (rendered.lines.length > 0) ctx.files += 1;
  ctx.lines += rendered.lines.length;
  ctx.redactions += rendered.redactions;
}

function commitHeader(
  host: string,
  message: string,
  parent: string | null,
  now: Date,
): string {
  const when = `${Math.floor(now.getTime() / 1000)} +0000`;
  return [
    `commit ${BRANCH}\n`,
    `committer Roamgate <roamgate@${host}> ${when}\n`,
    dataBlock(message),
    parent ? `from ${parent}\n` : "",
  ].join("");
}

async function runPass(
  repo: string,
  options: TextPassOptions,
  state: TextState,
  sources: TextSource[],
): Promise<Omit<TextPassReport, "repacked" | "seconds" | "status">> {
  const now = options.now?.() ?? new Date();
  const parent = headCommit(repo);
  const ctx: PassContext = {
    repo,
    state,
    owners: new Map(),
    headPaths: new Map(),
    out: new FastImport(repo, () =>
      commitHeader(options.host, "Archive text", parent, now),
    ),
    files: 0,
    lines: 0,
    redactions: 0,
    dirty: false,
  };
  for (const [key, file] of Object.entries(state.files)) {
    if (!file.path) continue;
    ctx.owners.set(file.path, key);
    ctx.headPaths.set(key, file.path);
  }
  try {
    for (const source of sources) await renderSource(ctx, source);
    // A first pass commits even with nothing to render: the repo exists.
    if (!ctx.dirty && !ctx.out.used && parent)
      return { files: 0, lines: 0, redactions: 0, commit: null };
    state.redactions += ctx.redactions;
    await ctx.out.write({
      path: STATE_PATH,
      content: Buffer.from(`${JSON.stringify(state)}\n`),
    });
    await ctx.out.finish();
  } catch (error) {
    ctx.out.abort();
    throw error;
  }
  return {
    files: ctx.files,
    lines: ctx.lines,
    redactions: ctx.redactions,
    commit: headCommit(repo),
  };
}

function repackStamp(repo: string): string {
  return join(repo, "roamgate-repack");
}

/** `git repack -d --geometric=2` and the commit-graph, once a day. */
export function maybeRepack(repo: string, now: Date, force = false): boolean {
  let last = 0;
  try {
    last = Date.parse(readFileSync(repackStamp(repo), "utf8").trim()) || 0;
  } catch {
    // Never repacked.
  }
  if (!force && now.getTime() - last < REPACK_EVERY_MS) return false;
  gitOk(repo, ["repack", "-d", "-q", "--geometric=2"]);
  gitOk(repo, ["commit-graph", "write", "--reachable"]);
  writeFileSync(repackStamp(repo), `${now.toISOString()}\n`, { mode: 0o600 });
  return true;
}

/**
 * The hourly pass: render what raw/ gained into one commit, then the daily
 * repack. Deferred while `busy()` says so; skipped while another pass runs.
 */
export async function updateTextRepo(
  options: TextPassOptions,
): Promise<TextPassReport> {
  const started = Date.now();
  const base = {
    files: 0,
    lines: 0,
    redactions: 0,
    commit: null,
    repacked: false,
  };
  if (options.busy && (await options.busy()))
    return {
      ...base,
      status: "deferred",
      seconds: 0,
      message: "deferred while GameMode runs",
    };
  const release = acquireHostLock(options.archiveDir, LOCK);
  if (!release)
    return {
      ...base,
      status: "locked",
      seconds: 0,
      message: "another text pass is running",
    };
  try {
    const repo = textRepoPath(options.archiveDir);
    initTextRepo(repo);
    const current = renderOptionsFor(options.settings);
    let state = readTextState(repo);
    if (!state) state = emptyState(current);
    else if (
      state.version !== RENDER_VERSION ||
      state.options.toolCallChars !== current.toolCallChars ||
      state.options.thinking !== current.thinking
    )
      options.log(
        "archive text: the render settings changed; `roamgate archive rebuild-text` applies them",
      );
    const result = await runPass(
      repo,
      options,
      state,
      textSources(options.archiveDir, options.settings),
    );
    const repacked =
      options.repack === false
        ? false
        : maybeRepack(repo, options.now?.() ?? new Date());
    return {
      ...result,
      status: result.commit ? "committed" : "unchanged",
      repacked,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    release();
  }
}

/**
 * Build the repo again from raw/ with the current render settings, beside
 * the old one, then swap it in. The old history is dropped: it is derived.
 */
export async function rebuildTextRepo(
  options: TextPassOptions,
): Promise<TextPassReport> {
  const started = Date.now();
  const release = acquireHostLock(options.archiveDir, LOCK);
  if (!release)
    return {
      files: 0,
      lines: 0,
      redactions: 0,
      commit: null,
      repacked: false,
      status: "locked",
      seconds: 0,
      message: "another text pass is running",
    };
  const repo = textRepoPath(options.archiveDir);
  const next = `${repo}.new`;
  const old = `${repo}.old`;
  try {
    rmSync(next, { recursive: true, force: true });
    initTextRepo(next);
    const state = emptyState(renderOptionsFor(options.settings));
    const sources = textSources(options.archiveDir, options.settings);
    options.log(`archive text: rendering ${sources.length} file(s)`);
    const result = await runPass(next, options, state, sources);
    maybeRepack(next, options.now?.() ?? new Date(), true);
    rmSync(old, { recursive: true, force: true });
    if (existsSync(repo)) renameSync(repo, old);
    renameSync(next, repo);
    rmSync(old, { recursive: true, force: true });
    return {
      ...result,
      status: result.commit ? "committed" : "unchanged",
      repacked: true,
      seconds: (Date.now() - started) / 1000,
    };
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  } finally {
    release();
  }
}

function packBytes(repo: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        try {
          total += statSync(path).size;
        } catch {
          // Gone.
        }
    }
  };
  walk(join(repo, "objects"));
  return total;
}

export function textRepoStatus(
  archiveDir: string,
  settings: GuiArchiveSettings,
): TextRepoStatus {
  const repo = textRepoPath(archiveDir);
  const head = headCommit(repo);
  if (!head)
    return {
      exists: false,
      path: repo,
      head: null,
      last_commit: null,
      last_repack: null,
      files: 0,
      redactions: 0,
      pack_bytes: 0,
      stale_render: false,
    };
  const state = readTextState(repo);
  const when = git(repo, ["log", "-1", "--format=%cI", BRANCH]);
  let lastRepack: string | null = null;
  try {
    lastRepack = readFileSync(repackStamp(repo), "utf8").trim() || null;
  } catch {
    // Never.
  }
  const current = renderOptionsFor(settings);
  return {
    exists: true,
    path: repo,
    head,
    last_commit: when.code === 0 ? when.stdout.toString().trim() : null,
    last_repack: lastRepack,
    files: state ? Object.keys(state.files).length : 0,
    redactions: state?.redactions ?? 0,
    pack_bytes: packBytes(repo),
    stale_render: state
      ? state.version !== RENDER_VERSION ||
        state.options.toolCallChars !== current.toolCallChars ||
        state.options.thinking !== current.thinking
      : false,
  };
}

/** Where the archive home keeps its text repo, as an scp-like ssh path. */
export function remoteTextRepo(ssh: string, remoteDir?: string): string {
  const dir = (remoteDir ?? "~/.config/roamgate/archive").replace(/^~\//, "");
  return `${ssh}:${dir.replace(/\/+$/, "")}/${TEXT_REPO}`;
}

export type FetchReport = { updated: boolean; head: string | null };

/**
 * Fetch the archive home's text repo over ssh (read-only, never pushed
 * back) into this machine's archive, for local search. A rebuilt home
 * repo replaces the local branch.
 */
export function fetchTextRepo(
  archiveDir: string,
  ssh: string,
  sshOptions: readonly string[],
  remoteDir?: string,
  /** The ssh program (tests run a local stand-in). */
  sshProgram = "ssh",
): FetchReport {
  const repo = textRepoPath(archiveDir);
  initTextRepo(repo);
  const before = headCommit(repo);
  const result = git(repo, [
    "-c",
    `core.sshCommand=${[sshProgram, ...sshOptions].join(" ")}`,
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    remoteTextRepo(ssh, remoteDir),
    `+${BRANCH}:${BRANCH}`,
  ]);
  if (result.code !== 0)
    throw new Error(
      `git fetch ${ssh}: exit ${result.code} ${result.stderr.trim().slice(0, 300)}`,
    );
  writeFileSync(
    join(repo, "roamgate-fetched"),
    `${new Date().toISOString()}\n`,
    {
      mode: 0o600,
    },
  );
  const head = headCommit(repo);
  return { updated: head !== before, head };
}

/** Since the last fetch from the archive home. */
export function textRepoAgeMs(archiveDir: string, now = Date.now()): number {
  try {
    return (
      now - statSync(join(textRepoPath(archiveDir), "roamgate-fetched")).mtimeMs
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
