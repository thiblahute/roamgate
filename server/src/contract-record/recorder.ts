import {
  close,
  closeSync,
  constants,
  mkdirSync,
  open,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  write,
  writeSync,
} from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { dataRoot } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import { DEFAULT_MAX_STRING, Redactor } from "./redact";

/**
 * Contract record mode: `ROAMGATE_CONTRACT_RECORD` makes this process write
 * its external traffic (browser and voice WebSockets, HTTP, the agent socket,
 * the CLI, the processes it runs) as redacted JSONL, the corpus the contract
 * of the Rust migration is checked against and scenarios are seeded from
 * (scripts/contract-record.ts).
 *
 * `1`, `on`, `true` or `yes` records under `<data dir>/contract-record`; any
 * other value is the directory. Unset, empty, `0`, `off` or `false`: no
 * recorder exists and nothing is wrapped, so the cost is nil.
 *
 * Each process writes its own files, `rec-<UTC start>-<pid>-<n>.jsonl` (0600
 * in a 0700 directory), rotated at `ROAMGATE_CONTRACT_RECORD_SEGMENT_MB`
 * (32) and pruned oldest first beyond `ROAMGATE_CONTRACT_RECORD_KEEP_MB`
 * (1024) for the whole directory. The hot path only queues the raw message;
 * parsing and redaction happen in a batch every 250 ms, written behind it
 * off the event loop (and at exit, at once). Past 20000 queued events, or
 * 64 MB of lines the disk has not taken yet, new ones are dropped and
 * counted.
 */

export const RECORD_FORMAT_VERSION = 1;
const FLUSH_MS = 250;
const MAX_QUEUE = 20_000;
/** Lines flushed and not yet written past which batches are dropped. */
const MAX_UNWRITTEN = 64 * 1024 * 1024;
const MB = 1024 * 1024;
const SEGMENT_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_APPEND |
  (constants.O_NOFOLLOW ?? 0);
const openAsync = promisify(open);
const closeAsync = promisify(close);
/** Writes all of `bytes` to `fd`, off the event loop. */
async function writeAsync(fd: number, bytes: Buffer): Promise<void> {
  let at = 0;
  while (at < bytes.length) {
    const written = await new Promise<number>((resolve, reject) =>
      write(fd, bytes, at, bytes.length - at, null, (error, n) =>
        error ? reject(error) : resolve(n),
      ),
    );
    at += written;
  }
}

export type RecordChannel =
  | "ws"
  | "voice"
  | "notifications"
  | "signalling"
  | "http"
  | "agent"
  | "mcp"
  | "cli"
  | "spawn"
  | "recorder";

/** How flush() turns `raw` into the line's `msg`. */
export type RawKind = "message" | "json" | "form" | "text";

export type RecordInput = {
  ch: RecordChannel;
  ev: string;
  sock?: string;
  /** Already plain and small; redacted with the rest at flush. */
  fields?: Record<string, unknown>;
  raw?: string;
  rawKind?: RawKind;
  /** Raw bodies decoded like `raw` into the named fields. */
  bodies?: Record<string, { raw: string; kind: RawKind } | undefined>;
  /** A request URL, written as `path` and `query` with credentials redacted. */
  url?: string;
};

type Queued = RecordInput & { t: number };

export type RecordLine = {
  v: number;
  seq: number;
  t: string;
  pid: number;
  ch: RecordChannel;
  ev: string;
  sock?: string;
  msg?: unknown;
  [field: string]: unknown;
};

export type RecorderOptions = {
  directory: string;
  /** "server", "cli": written in each file's first line. */
  role: string;
  segmentBytes?: number;
  keepBytes?: number;
  maxString?: number;
  now?: () => number;
};

export type RecorderStats = {
  events: number;
  dropped: number;
  bytes: number;
  flushes: number;
  /** Milliseconds spent in flush(): parse, redaction and write. */
  flushMs: number;
  /** Milliseconds spent queueing on the hot path. */
  enqueueMs: number;
};

const ENABLED = new Set(["1", "on", "true", "yes"]);
const DISABLED = new Set(["", "0", "off", "false", "no"]);

/** The directory to record to, or null when record mode is off. */
export function contractRecordDirectory(
  environment: Record<string, string | undefined> = process.env,
  root: () => string = dataRoot,
): string | null {
  const value = roamgateEnv("CONTRACT_RECORD", environment)?.trim();
  if (value === undefined || DISABLED.has(value.toLowerCase())) return null;
  if (ENABLED.has(value.toLowerCase())) return join(root(), "contract-record");
  return resolve(value);
}

function megabytes(
  name: string,
  fallback: number,
  environment: Record<string, string | undefined>,
): number {
  const value = Number(roamgateEnv(name, environment));
  return Number.isFinite(value) && value > 0 ? value * MB : fallback * MB;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

export class ContractRecorder {
  readonly redactor: Redactor;
  readonly directory: string;
  /** "server", "cli": written in each file's first line. */
  role: string;
  private readonly segmentBytes: number;
  private readonly keepBytes: number;
  private readonly now: () => number;
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fd: number | null = null;
  private file = "";
  private fileBytes = 0;
  private segment = 0;
  private seq = 0;
  private droppedSinceFlush = 0;
  private closed = false;
  /** Lines flushed and not yet written, and their size. */
  private unwritten: Buffer[] = [];
  private unwrittenBytes = 0;
  /** The writes under way, when they are. */
  private writing: Promise<void> | null = null;
  /** The next segment's first line, when made ahead of its events. */
  private header: Buffer | null = null;
  private readonly started: number;
  readonly counters: RecorderStats = {
    events: 0,
    dropped: 0,
    bytes: 0,
    flushes: 0,
    flushMs: 0,
    enqueueMs: 0,
  };

  constructor(options: RecorderOptions) {
    this.directory = options.directory;
    this.role = options.role;
    this.segmentBytes = options.segmentBytes ?? 32 * MB;
    this.keepBytes = options.keepBytes ?? 1024 * MB;
    this.now = options.now ?? Date.now;
    this.redactor = new Redactor({
      maxString: options.maxString ?? DEFAULT_MAX_STRING,
    });
    this.started = this.now();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  /** Queues one event; cheap, never throws. */
  record(input: RecordInput): void {
    if (this.closed) return;
    const before = performance.now();
    if (this.queue.length >= MAX_QUEUE) {
      this.droppedSinceFlush += 1;
      this.counters.dropped += 1;
    } else {
      this.queue.push({ ...input, t: this.now() });
      this.counters.events += 1;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
    this.counters.enqueueMs += performance.now() - before;
  }

  /**
   * Turns every queued event into lines now and writes them behind, off
   * the event loop: a synchronous write to a busy disk stalled every call
   * for seconds (5 s on 2026-11-23).
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length && !this.droppedSinceFlush) return;
    const before = performance.now();
    const batch = this.queue;
    this.queue = [];
    if (this.droppedSinceFlush) {
      batch.push({
        ch: "recorder",
        ev: "dropped",
        fields: { count: this.droppedSinceFlush },
        t: this.now(),
      });
      this.droppedSinceFlush = 0;
    }
    // The file's first line comes before the events it holds.
    if (this.segment === 0 && !this.header) this.header = this.nextSegment();
    if (this.unwrittenBytes > MAX_UNWRITTEN) {
      // The disk is that far behind: these are dropped and counted.
      this.droppedSinceFlush += batch.length;
      this.counters.dropped += batch.length;
      return;
    }
    let text = "";
    for (const item of batch) {
      try {
        text += `${JSON.stringify(this.line(item))}\n`;
      } catch (error) {
        text += `${JSON.stringify({
          v: RECORD_FORMAT_VERSION,
          seq: ++this.seq,
          t: new Date(item.t).toISOString(),
          pid: process.pid,
          ch: "recorder",
          ev: "unserializable",
          of: `${item.ch}.${item.ev}`,
          error: (error as Error).message,
        })}\n`;
      }
    }
    this.unwritten.push(Buffer.from(text));
    this.unwrittenBytes += text.length;
    this.counters.flushes += 1;
    this.counters.flushMs += performance.now() - before;
    // Started after this run of code: flushSync() takes the lines first.
    this.writing ??= Promise.resolve().then(() => this.writeBehind());
  }

  /** flush(), its lines written before it returns (tests, exit). */
  flushSync(): void {
    this.flush();
    this.writeNow();
  }

  /** Resolves once every line flushed so far is written. */
  async drain(): Promise<void> {
    while (this.writing) await this.writing;
  }

  /** Writes what is queued and closes the file; later events are ignored. */
  close(): void {
    this.flushSync();
    this.closed = true;
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  stats(): RecorderStats & { file: string; uptimeMs: number } {
    return {
      ...this.counters,
      file: this.file,
      uptimeMs: this.now() - this.started,
    };
  }

  private line(item: Queued): RecordLine {
    const line: RecordLine = {
      v: RECORD_FORMAT_VERSION,
      seq: ++this.seq,
      t: new Date(item.t).toISOString(),
      pid: process.pid,
      ch: item.ch,
      ev: item.ev,
    };
    if (item.sock) line.sock = item.sock;
    if (item.fields) {
      const fields = this.redactor.value(item.fields) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(fields))
        if (!(key in line)) line[key] = value;
    }
    if (item.url) {
      try {
        const { path, query } = this.redactor.url(new URL(item.url));
        line.path = path;
        if (query) line.query = query;
      } catch {
        line.path = this.redactor.string(item.url);
      }
    }
    if (item.bodies)
      for (const [key, body] of Object.entries(item.bodies))
        if (body) line[key] = this.decode(body.raw, body.kind);
    if (item.raw !== undefined) line.msg = this.decode(item.raw, item.rawKind);
    return line;
  }

  private decode(raw: string, kind: RawKind = "message"): unknown {
    const first = raw.trimStart()[0];
    // The agent socket takes JSON or a form, whatever its header says.
    if (kind === "form" && first !== "{") return this.redactor.form(raw);
    if (kind === "text") return this.redactor.string(raw);
    if (first === "{" || first === "[") {
      try {
        const parsed = JSON.parse(raw);
        return kind === "message"
          ? this.redactor.message(parsed)
          : this.redactor.value(parsed);
      } catch {}
    }
    return { text: this.redactor.string(raw) };
  }

  /** The unwritten batches, as one buffer (taken from the queue). */
  private takeUnwritten(): Buffer | null {
    if (!this.unwritten.length) return null;
    const bytes = Buffer.concat(this.unwritten);
    this.unwritten = [];
    this.unwrittenBytes = 0;
    return bytes;
  }

  /** Writes the batches one after the other, off the event loop. */
  private async writeBehind(): Promise<void> {
    try {
      for (;;) {
        const bytes = this.takeUnwritten();
        if (!bytes) break;
        try {
          if (
            this.fd === null ||
            this.fileBytes + bytes.length > this.segmentBytes
          )
            await this.rotate();
          if (this.fd === null) continue;
          await writeAsync(this.fd, bytes);
          this.fileBytes += bytes.length;
          this.counters.bytes += bytes.length;
        } catch {
          // A full disk or a removed directory: recording is best effort.
        }
      }
    } finally {
      this.writing = null;
    }
  }

  /** Writes the batches now, on the event loop (tests, exit). */
  private writeNow(): void {
    const bytes = this.takeUnwritten();
    if (!bytes || this.closed) return;
    try {
      if (this.fd === null || this.fileBytes + bytes.length > this.segmentBytes)
        this.rotateSync();
      if (this.fd === null) return;
      writeSync(this.fd, bytes);
      this.fileBytes += bytes.length;
      this.counters.bytes += bytes.length;
    } catch {
      // See writeBehind().
    }
  }

  /** The next segment's path, and its first line. */
  private nextSegment(): Buffer {
    this.segment += 1;
    const name = `rec-${stamp(this.started)}-${process.pid}-${String(this.segment).padStart(4, "0")}.jsonl`;
    this.file = join(this.directory, name);
    return Buffer.from(
      `${JSON.stringify({
        v: RECORD_FORMAT_VERSION,
        seq: ++this.seq,
        t: new Date(this.now()).toISOString(),
        pid: process.pid,
        ch: "recorder",
        ev: "start",
        role: this.role,
        segment: this.segment,
        platform: process.platform,
      })}\n`,
    );
  }

  private opened(header: Buffer, fd: number) {
    this.fd = fd;
    this.fileBytes = header.length;
    this.counters.bytes += header.length;
  }

  /** Starts the next segment, off the event loop. */
  private async rotate(): Promise<void> {
    const old = this.fd;
    this.fd = null;
    if (old !== null) await closeAsync(old);
    const header = this.header ?? this.nextSegment();
    this.header = null;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const fd = await openAsync(this.file, SEGMENT_FLAGS, 0o600);
    await writeAsync(fd, header);
    this.opened(header, fd);
    await this.prune();
  }

  /** rotate(), on the event loop (tests, exit). */
  private rotateSync(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    const header = this.header ?? this.nextSegment();
    this.header = null;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const fd = openSync(this.file, SEGMENT_FLAGS, 0o600);
    writeSync(fd, header);
    this.opened(header, fd);
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return;
    }
    const files = this.recordings(names, (path) => statSync(path).size);
    for (const path of this.pruned(files)) rmSync(path, { force: true });
  }

  /** The recordings in the directory, oldest first, with their sizes. */
  private recordings(
    names: string[],
    size: (path: string) => number,
  ): { path: string; size: number }[] {
    return names
      .filter((name) => /^rec-.*\.jsonl$/.test(name))
      .sort()
      .map((name) => {
        const path = join(this.directory, name);
        try {
          return { path, size: size(path) };
        } catch {
          return { path, size: 0 };
        }
      });
  }

  /** The oldest recordings to remove for the directory to fit its budget. */
  private pruned(files: { path: string; size: number }[]): string[] {
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const out: string[] = [];
    for (const file of files) {
      if (total <= this.keepBytes) break;
      if (file.path === this.file) continue;
      out.push(file.path);
      total -= file.size;
    }
    return out;
  }

  /** Removes the oldest recordings while the directory is over its budget. */
  private async prune(): Promise<void> {
    let files: { path: string; size: number }[];
    try {
      const names = await readdir(this.directory);
      const sizes = new Map<string, number>();
      await Promise.all(
        names.map(async (name) => {
          try {
            sizes.set(name, (await stat(join(this.directory, name))).size);
          } catch {}
        }),
      );
      files = this.recordings(names, (path) => sizes.get(basename(path)) ?? 0);
    } catch {
      return;
    }
    for (const path of this.pruned(files)) await rm(path, { force: true });
  }
}

let shared: ContractRecorder | null | undefined;

/**
 * This process's recorder, created on first use from the environment; null
 * when record mode is off.
 */
export function contractRecorder(
  role = "server",
  environment: Record<string, string | undefined> = process.env,
): ContractRecorder | null {
  if (shared !== undefined) return shared;
  const directory = contractRecordDirectory(environment);
  if (!directory) {
    shared = null;
    return shared;
  }
  try {
    shared = new ContractRecorder({
      directory,
      role,
      segmentBytes: megabytes("CONTRACT_RECORD_SEGMENT_MB", 32, environment),
      keepBytes: megabytes("CONTRACT_RECORD_KEEP_MB", 1024, environment),
    });
  } catch (error) {
    console.error(
      `[bridge] contract record mode off: ${(error as Error).message}`,
    );
    shared = null;
    return shared;
  }
  const recorder = shared;
  process.on("exit", () => recorder.close());
  return shared;
}

/** Tests only: forget the process recorder. */
export function resetContractRecorderForTests(): void {
  shared?.close();
  shared = undefined;
}
