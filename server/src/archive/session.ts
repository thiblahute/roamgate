/** Find an archived session, read it back, put it back for its agent. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  writeSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ADAPTERS, mapCwd } from "./adapters";
import { completeLines } from "./lines";
import {
  type ArchiveRuntime,
  localRoot,
  type ResolvedHost,
  SSH_OPTIONS,
} from "./hosts";
import { type ArchiveDb } from "./store";
import { zstPath } from "./sync";
import { readArchived } from "./zstd";

export type SessionFileInfo = {
  relpath: string;
  subagent: boolean;
  archived_size: number;
  src_size: number | null;
  complete: boolean;
};

export type SessionCopy = {
  host: string;
  project: string;
  main_size: number;
  last_ts: string | null;
};

export type SessionLookup = {
  session: string;
  found: boolean;
  agent: string | null;
  host: string | null;
  project: string | null;
  cwd: string | null;
  title: string | null;
  first_ts: string | null;
  last_ts: string | null;
  files: SessionFileInfo[];
  /** Every host holding a copy; the first is the one described above. */
  copies: SessionCopy[];
  /** The session exists in this machine's agent directory already. */
  live: boolean;
  restorable: boolean;
  /** What to run to continue it (after restoring), if the agent can. */
  resume: string | null;
  candidates?: Array<{ session: string; agent: string; title: string | null }>;
};

type LookupRow = {
  id: number;
  host: string;
  agent: string;
  relpath: string;
  project: string | null;
  session: string;
  subagent: number;
  title: string | null;
  cwd: string | null;
  src_size: number | null;
  archived_size: number;
  first_ts: string | null;
  last_ts: string | null;
};

export type LookupOptions = {
  agent?: string;
  host?: string;
  /** This machine, to tell whether the session is live here. */
  runtime?: ArchiveRuntime;
  self?: ResolvedHost;
};

function emptyLookup(session: string): SessionLookup {
  return {
    session,
    found: false,
    agent: null,
    host: null,
    project: null,
    cwd: null,
    title: null,
    first_ts: null,
    last_ts: null,
    files: [],
    copies: [],
    live: false,
    restorable: false,
    resume: null,
  };
}

/** The session whose id starts with `prefix`, with every copy of it. */
export function lookupSession(
  db: ArchiveDb,
  prefix: string,
  options: LookupOptions = {},
): SessionLookup {
  const clean = prefix.trim().toLowerCase();
  const result = emptyLookup(clean);
  if (!/^[0-9a-z-]{4,80}$/.test(clean)) return result;
  const filters = ["kind = 'transcript'", "lower(session) LIKE ?1 || '%'"];
  const params: string[] = [clean];
  if (options.agent) {
    params.push(options.agent);
    filters.push(`agent = ?${params.length}`);
  }
  if (options.host) {
    params.push(options.host);
    filters.push(`host = ?${params.length}`);
  }
  const rows = db
    .query<LookupRow, string[]>(
      `SELECT id, host, agent, relpath, project, session, subagent, title, cwd, src_size, archived_size, first_ts, last_ts
       FROM files WHERE ${filters.join(" AND ")} ORDER BY subagent, relpath`,
    )
    .all(...params);
  const sessions = new Map<string, LookupRow[]>();
  for (const row of rows) {
    const key = `${row.agent}:${row.session.toLowerCase()}`;
    sessions.set(key, [...(sessions.get(key) ?? []), row]);
  }
  if (sessions.size === 0) return result;
  if (sessions.size > 1) {
    const exact = [...sessions.entries()].find(([key]) =>
      key.endsWith(`:${clean}`),
    );
    if (!exact) {
      return {
        ...result,
        candidates: [...sessions.values()].slice(0, 10).map((group) => ({
          session: group[0]?.session ?? "",
          agent: group[0]?.agent ?? "",
          title: group.find((r) => r.title)?.title ?? null,
        })),
      };
    }
    sessions.clear();
    sessions.set(exact[0], exact[1]);
  }
  const group = [...sessions.values()][0] as LookupRow[];
  const agent = group[0]?.agent as string;
  const byHost = new Map<string, LookupRow[]>();
  for (const row of group)
    byHost.set(row.host, [...(byHost.get(row.host) ?? []), row]);
  const copies: SessionCopy[] = [...byHost.entries()].map(([host, list]) => {
    const main = list.filter((r) => !r.subagent);
    return {
      host,
      project: list[0]?.project ?? "",
      main_size: Math.max(0, ...main.map((r) => r.archived_size)),
      last_ts:
        list
          .map((r) => r.last_ts ?? "")
          .sort()
          .pop() || null,
    };
  });
  copies.sort(
    (a, b) =>
      b.main_size - a.main_size ||
      (b.last_ts ?? "").localeCompare(a.last_ts ?? ""),
  );
  const best = copies[0] as SessionCopy;
  const rowsOfBest = byHost.get(best.host) as LookupRow[];
  const main = rowsOfBest.find((r) => !r.subagent) ?? rowsOfBest[0];
  const adapter = ADAPTERS[agent];
  const files = rowsOfBest.map((r) => ({
    relpath: r.relpath,
    subagent: r.subagent !== 0,
    archived_size: r.archived_size,
    src_size: r.src_size,
    complete: r.src_size !== null && r.archived_size === r.src_size,
  }));
  let live = false;
  if (options.runtime && options.self && adapter && main && !main.subagent) {
    const target = adapter.restoreRelpath({
      relpath: main.relpath,
      session: main.session,
      sourceHome: null,
      targetHome: options.runtime.homeDir,
    });
    live = existsSync(
      join(localRoot(adapter, options.self, options.runtime), target),
    );
  }
  const hasMain = rowsOfBest.some((r) => !r.subagent);
  return {
    ...result,
    session: main?.session ?? clean,
    found: true,
    agent,
    host: best.host,
    project: main?.project ?? null,
    cwd: rowsOfBest.map((r) => r.cwd).find(Boolean) ?? null,
    title:
      [...rowsOfBest]
        .reverse()
        .map((r) => r.title)
        .find(Boolean) ?? null,
    first_ts:
      rowsOfBest
        .map((r) => r.first_ts ?? "")
        .filter(Boolean)
        .sort()[0] ?? null,
    last_ts: best.last_ts,
    files,
    copies,
    live,
    restorable: Boolean(adapter?.supportsResume) && hasMain && !live,
    resume:
      adapter?.resumeCommand(
        main?.session ?? clean,
        rowsOfBest.map((r) => r.cwd).find(Boolean) ?? null,
      ) ?? null,
  };
}

/** Where an archived file's compressed copy lives. */
export function archivedPath(
  archiveDir: string,
  host: string,
  agent: string,
  relpath: string,
): string {
  return zstPath(archiveDir, host, agent, relpath);
}

/** The decompressed bytes of one of a session's files, exactly as archived. */
export function catFile(
  archiveDir: string,
  lookup: SessionLookup,
  relpath?: string,
): AsyncIterable<Buffer> {
  if (!lookup.found || !lookup.host || !lookup.agent)
    throw new Error("session not found");
  const file = relpath
    ? lookup.files.find((f) => f.relpath === relpath)
    : lookup.files.find((f) => !f.subagent);
  if (!file)
    throw new Error(
      relpath
        ? `no such file in the session: ${relpath}`
        : "the session has no main file",
    );
  return readArchived(
    archivedPath(archiveDir, lookup.host, lookup.agent, file.relpath),
  );
}

/**
 * Lines [from, from + limit) of a file (1-based), at most `maxBytes` of
 * them: how an agent reads a long session a piece at a time.
 */
export async function catLines(
  chunks: AsyncIterable<Buffer>,
  from: number,
  limit: number,
  maxBytes: number,
): Promise<{ lines: string[]; next: number | null; truncated: boolean }> {
  const lines: string[] = [];
  let index = 0;
  let bytes = 0;
  let truncated = false;
  for await (const { line } of completeLines(chunks)) {
    index += 1;
    if (index < from) continue;
    if (lines.length >= limit) return { lines, next: index, truncated };
    const text = line.toString("utf8");
    if (bytes + text.length > maxBytes) {
      truncated = true;
      return { lines, next: index, truncated };
    }
    bytes += text.length;
    lines.push(text);
  }
  return { lines, next: null, truncated };
}

/** The last record of a file that carries a uuid (to chain an appended message). */
function tailRecord(path: string): Record<string, unknown> | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (
          typeof record.uuid === "string" &&
          (record.type === "user" || record.type === "assistant")
        )
          return record;
      } catch {
        // A cut line at the start of the window.
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export function restoredNote(host: string, cwd: string | null): string {
  return `[Roamgate] This session was restored from another computer (${host}) by the session archive. It was recorded there${cwd ? ` in ${cwd}` : ""}: file paths, installed tools and the environment may differ on this machine. Check before relying on them.`;
}

export type RestoreAction = {
  relpath: string;
  path: string;
  status: "restored" | "exists";
};

export type ResumeResult = {
  session: string;
  agent: string;
  from_host: string;
  restored: RestoreAction[];
  note_appended: boolean;
  /** Run in `cwd` to continue the session. */
  command: string | null;
  cwd: string | null;
  message: string;
};

/** Where a session file reads from: this archive, or another machine's over ssh. */
export type FileSource = (
  lookup: SessionLookup,
  relpath: string,
) => AsyncIterable<Buffer>;

export function localFileSource(archiveDir: string): FileSource {
  return (lookup, relpath) => catFile(archiveDir, lookup, relpath);
}

/** Files of an archive on another machine, streamed through `roamgate archive cat`. */
export function sshFileSource(
  ssh: string,
  binary = '"$HOME/.local/bin/roamgate"',
): FileSource {
  return (lookup, relpath) =>
    (async function* () {
      const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
      const command = `exec ${binary} archive cat ${quote(lookup.session)} --agent ${quote(lookup.agent ?? "")} --host ${quote(lookup.host ?? "")} --file ${quote(relpath)}`;
      const child = Bun.spawn(["ssh", ...SSH_OPTIONS, ssh, command], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>)
        yield Buffer.from(chunk);
      const code = await child.exited;
      if (code !== 0) throw new Error(`ssh ${ssh}: archive cat exited ${code}`);
    })();
}

async function writeNew(
  dest: string,
  chunks: AsyncIterable<Buffer>,
): Promise<boolean> {
  mkdirSync(dirname(dest), { recursive: true });
  const temporary = join(dirname(dest), `.${randomUUID()}.restoring`);
  try {
    await pipeline(chunks, createWriteStream(temporary, { mode: 0o600 }));
    try {
      linkSync(temporary, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    return true;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Put a session back into this machine's agent directory, only for files
 * that do not exist there (never an overwrite), mapping the project
 * directory to this machine's home, and say so in the conversation.
 */
export async function resumeSession(
  lookup: SessionLookup,
  options: {
    runtime: ArchiveRuntime;
    self: ResolvedHost;
    source: FileSource;
    dryRun?: boolean;
    now?: Date;
  },
): Promise<ResumeResult> {
  if (!lookup.found || !lookup.agent || !lookup.host)
    throw new Error("session not found in the archive");
  const adapter = ADAPTERS[lookup.agent];
  if (!adapter) throw new Error(`unknown agent: ${lookup.agent}`);
  const cwd = lookup.cwd ? mapCwd(lookup.cwd, options.runtime.homeDir) : null;
  const base = {
    session: lookup.session,
    agent: lookup.agent,
    from_host: lookup.host,
    cwd,
    note_appended: false,
  };
  if (!adapter.supportsResume)
    return {
      ...base,
      restored: [],
      command: null,
      message: `${adapter.label} sessions are archived but cannot be restored automatically; read one with: roamgate archive cat ${lookup.session} --agent ${lookup.agent}`,
    };
  const root = localRoot(adapter, options.self, options.runtime);
  const restored: RestoreAction[] = [];
  let mainPath: string | null = null;
  for (const file of lookup.files) {
    const relpath = adapter.restoreRelpath({
      relpath: file.relpath,
      session: lookup.session,
      sourceHome: null,
      targetHome: options.runtime.homeDir,
    });
    const path = join(root, relpath);
    if (existsSync(path)) {
      restored.push({ relpath, path, status: "exists" });
      continue;
    }
    if (!options.dryRun)
      await writeNew(path, options.source(lookup, file.relpath));
    restored.push({ relpath, path, status: "restored" });
    if (!file.subagent) mainPath = path;
  }
  let noteAppended = false;
  if (mainPath && !options.dryRun && lookup.agent === "claude") {
    const last = tailRecord(mainPath);
    const record = {
      parentUuid: typeof last?.uuid === "string" ? last.uuid : null,
      isSidechain: false,
      userType: "external",
      cwd:
        cwd ??
        (typeof last?.cwd === "string" ? last.cwd : options.runtime.homeDir),
      sessionId: lookup.session,
      ...(typeof last?.version === "string" ? { version: last.version } : {}),
      ...(typeof last?.gitBranch === "string"
        ? { gitBranch: last.gitBranch }
        : {}),
      type: "user",
      message: { role: "user", content: restoredNote(lookup.host, lookup.cwd) },
      uuid: randomUUID(),
      timestamp: (options.now ?? new Date()).toISOString(),
    };
    const fd = openSync(mainPath, "a+");
    try {
      const existing = fstatSync(fd).size;
      let prefix = "";
      if (existing > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, existing - 1);
        if (last[0] !== 10) prefix = "\n";
      }
      writeSync(fd, `${prefix}${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
    noteAppended = true;
  }
  const command = adapter.resumeCommand(lookup.session, cwd);
  const here = restored.filter((r) => r.status === "restored").length;
  return {
    ...base,
    note_appended: noteAppended,
    restored,
    command,
    message:
      here === 0
        ? "everything is here already: nothing was restored"
        : `restored ${here} file(s) from ${lookup.host}${command ? `; continue with: ${cwd ? `cd ${cwd} && ` : ""}${command}` : ""}`,
  };
}
