import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RecordLine } from "./recorder";

/**
 * Reading a contract recording (recorder.ts) back: its files in order, and
 * each line classified as the contract surface it belongs to (an RPC
 * request or reply, a push, an HTTP or agent socket exchange, ...), which
 * is what check.ts validates and seed.ts turns into scenarios.
 */

export type Recorded = RecordLine & { file: string; line: number };

/** The recording files under the given files and directories, in order. */
export function recordingFiles(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory())
      files.push(
        ...readdirSync(path)
          .filter((name) => /^rec-.*\.jsonl$/.test(name))
          .sort()
          .map((name) => join(path, name)),
      );
    else files.push(path);
  }
  return files;
}

/**
 * Every line of the recordings, file by file (a process's segments are
 * consecutive and in order, so a socket's messages come in order).
 */
export function* readRecordings(paths: readonly string[]): Generator<Recorded> {
  for (const file of recordingFiles(paths)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index];
      if (!text) continue;
      let parsed: RecordLine;
      try {
        parsed = JSON.parse(text) as RecordLine;
      } catch {
        // A line cut by a crash mid-write.
        continue;
      }
      yield { ...parsed, file, line: index + 1 };
    }
  }
}

export type Surface =
  | "rpc.request"
  | "rpc.reply"
  | "push"
  | "ws.ack"
  | "ws.open"
  | "ws.close"
  | "voice.in"
  | "voice.out"
  | "notifications.in"
  | "notifications.out"
  | "signalling.in"
  | "signalling.out"
  | "http"
  | "agent"
  | "mcp"
  | "cli"
  | "spawn"
  | "recorder";

export type Classified = {
  surface: Surface;
  /** The method, push, route, command or program. */
  name: string;
  /** What the contract describes: params, a reply's result, a push. */
  payload: unknown;
  /** A reply's error instead of a result. */
  error?: boolean;
  /** HTTP and agent socket: the request's body and query. */
  request?: { method?: string; path?: string; query?: unknown; body?: unknown };
  /** HTTP and agent socket: the status. */
  status?: number;
  record: Recorded;
};

const ENVELOPE_KEYS = new Set(["connection_id", "connection_generation"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A message without the connection envelope's own keys. */
export function unwrapEnvelope(message: unknown): unknown {
  if (!isObject(message)) return message;
  if (!Object.keys(message).some((key) => ENVELOPE_KEYS.has(key)))
    return message;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message))
    if (!ENVELOPE_KEYS.has(key)) out[key] = value;
  return out;
}

/** A push's name: its `event`, `type`, or its one top-level key. */
export function pushName(message: unknown): string {
  if (!isObject(message)) return typeof message;
  if (message.hello === true) return "hello";
  if (typeof message.event === "string") return `event:${message.event}`;
  if (typeof message.type === "string") return message.type;
  if (typeof message.method === "string") return `method:${message.method}`;
  const keys = Object.keys(message);
  if (keys.length === 1) return keys[0]!;
  return keys.sort().join("+") || "{}";
}

/** A socket message's name on the voice, notification and call sockets. */
function socketMessageName(message: unknown): string {
  if (!isObject(message)) return typeof message;
  for (const key of ["op", "type", "event", "kind", "method"])
    if (typeof message[key] === "string") return `${key}:${message[key]}`;
  if (typeof message.binary === "number") return "binary";
  return pushName(message);
}

/** A path with its variable segments as `{}`, for grouping. */
export function routeName(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      /^\[redacted:[0-9a-f]+\]$/.test(segment) ||
      /^[0-9]+$/.test(segment) ||
      /^[0-9a-f-]{8,}$/i.test(segment) ||
      /\.[a-z0-9]{1,5}$/i.test(segment)
        ? "{}"
        : segment,
    )
    .join("/");
}

function programName(argv: unknown): string {
  if (!Array.isArray(argv) || !argv.length) return "?";
  const program = String(argv[0]).split(/[\\/]/).pop() ?? "?";
  const sub = argv
    .slice(1)
    .find((arg) => typeof arg === "string" && !arg.startsWith("-"));
  return sub && /^[a-z][a-z0-9_-]*$/i.test(String(sub))
    ? `${program} ${sub}`
    : program;
}

/** Remembers which method each socket's pending request id is for. */
export class Classifier {
  private readonly pending = new Map<string, string>();

  classify(record: Recorded): Classified | null {
    const { ch, ev } = record;
    const msg = record.msg;
    if (ch === "recorder")
      return { surface: "recorder", name: ev, payload: record, record };
    if (ch === "ws") {
      if (ev === "open")
        return { surface: "ws.open", name: "open", payload: null, record };
      if (ev === "close")
        return {
          surface: "ws.close",
          name: "close",
          payload: record.code,
          record,
        };
      if (ev === "in") {
        if (!isObject(msg)) return null;
        if ("ack" in msg && Object.keys(msg).length === 1)
          return { surface: "ws.ack", name: "ack", payload: msg, record };
        const method = typeof msg.method === "string" ? msg.method : "?";
        if (msg.id !== undefined)
          this.pending.set(`${record.sock}\u0000${String(msg.id)}`, method);
        return {
          surface: "rpc.request",
          name: method,
          payload: msg.params ?? {},
          record,
        };
      }
      if (ev === "out") {
        const message = unwrapEnvelope(msg);
        if (!isObject(message)) return null;
        if (
          message.id !== undefined &&
          ("result" in message || "error" in message)
        ) {
          const key = `${record.sock}\u0000${String(message.id)}`;
          const method = this.pending.get(key) ?? "?";
          this.pending.delete(key);
          const error = "error" in message && !("result" in message);
          return {
            surface: "rpc.reply",
            name: method,
            payload: error ? message.error : message.result,
            error,
            record,
          };
        }
        return {
          surface: "push",
          name: pushName(message),
          payload: message,
          record,
        };
      }
      return null;
    }
    if (ch === "voice" || ch === "notifications" || ch === "signalling") {
      if (ev !== "in" && ev !== "out") return null;
      const payload =
        msg ?? (record.binary !== undefined ? { binary: record.binary } : null);
      return {
        surface: `${ch}.${ev}` as Surface,
        name: socketMessageName(payload),
        payload,
        record,
      };
    }
    if (ch === "http" || ch === "agent" || ch === "mcp") {
      if (ev !== "exchange") return null;
      const path = typeof record.path === "string" ? record.path : "";
      const method = typeof record.method === "string" ? record.method : "GET";
      let name: string;
      if (ch === "agent") name = path.replace(/^\/v1\//, "");
      else if (ch === "mcp")
        name =
          isObject(record.body) && typeof record.body.method === "string"
            ? record.body.method
            : `${method} ${path}`;
      else name = `${method} ${routeName(path)}`;
      return {
        surface: ch,
        name,
        payload: record.response,
        request: { method, path, query: record.query, body: record.body },
        status: typeof record.status === "number" ? record.status : undefined,
        record,
      };
    }
    if (ch === "cli")
      return {
        surface: "cli",
        name: programName(["roamgate", ...((record.argv as unknown[]) ?? [])]),
        payload: record,
        record,
      };
    if (ch === "spawn") {
      if (ev !== "exit") return null;
      return {
        surface: "spawn",
        name: programName(record.argv),
        payload: record,
        record,
      };
    }
    return null;
  }
}
