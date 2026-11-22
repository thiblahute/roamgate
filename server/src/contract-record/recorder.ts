import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
 * parsing, redaction and the write happen in a batch every 250 ms (and at
 * exit). Past 20000 queued events new ones are dropped and counted.
 */

export const RECORD_FORMAT_VERSION = 1;
const FLUSH_MS = 250;
const MAX_QUEUE = 20_000;
const MB = 1024 * 1024;

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

  /** Writes every queued event now. */
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
    try {
      // The file's first line comes before the events it holds.
      if (this.fd === null) this.rotate();
    } catch {}
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
    try {
      this.write(text);
    } catch {
      // A full disk or a removed directory: recording is best effort.
    }
    this.counters.flushes += 1;
    this.counters.flushMs += performance.now() - before;
  }

  /** Flushes and closes the file; later events are ignored. */
  close(): void {
    this.flush();
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

  private write(text: string): void {
    const bytes = Buffer.from(text);
    if (this.fd === null || this.fileBytes + bytes.length > this.segmentBytes)
      this.rotate();
    if (this.fd === null) return;
    writeSync(this.fd, bytes);
    this.fileBytes += bytes.length;
    this.counters.bytes += bytes.length;
  }

  private rotate(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.segment += 1;
    const name = `rec-${stamp(this.started)}-${process.pid}-${String(this.segment).padStart(4, "0")}.jsonl`;
    this.file = join(this.directory, name);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.fd = openSync(
      this.file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const header = Buffer.from(
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
    writeSync(this.fd, header);
    this.fileBytes = header.length;
    this.counters.bytes += header.length;
    this.prune();
  }

  /** Removes the oldest recordings while the directory is over its budget. */
  private prune(): void {
    let files: { name: string; size: number }[];
    try {
      files = readdirSync(this.directory)
        .filter((name) => /^rec-.*\.jsonl$/.test(name))
        .sort()
        .map((name) => {
          try {
            return { name, size: statSync(join(this.directory, name)).size };
          } catch {
            return { name, size: 0 };
          }
        });
    } catch {
      return;
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= this.keepBytes) break;
      const path = join(this.directory, file.name);
      if (path === this.file) continue;
      rmSync(path, { force: true });
      total -= file.size;
    }
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
