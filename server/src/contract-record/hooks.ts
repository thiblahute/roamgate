import childProcess from "node:child_process";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { WS_CHUNK_MARKER } from "../bridge/websocket-send";
import type { ContractRecorder, RawKind, RecordChannel } from "./recorder";

/**
 * The wrappers that feed a ContractRecorder. Each takes the recorder (null
 * when record mode is off) and returns its input untouched when it is null,
 * so an unrecorded server runs exactly the code it ran before.
 */

/** Bodies up to this size are recorded; larger ones only by size. */
export const RECORD_BODY_LIMIT = 256 * 1024;

const CAPTURED_TYPE =
  /^(?:application\/(?:[a-z.+-]*\+)?json|application\/x-www-form-urlencoded|text\/plain)\b/i;

function bodyKind(contentType: string | null): RawKind | null {
  if (!contentType || !CAPTURED_TYPE.test(contentType)) return null;
  if (/x-www-form-urlencoded/i.test(contentType)) return "form";
  if (/json/i.test(contentType)) return "json";
  return "text";
}

/** At most `limit` bytes of a body, as text; the rest is cancelled. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ text: string; size: number; cut: boolean }> {
  if (!body) return { text: "", size: 0, cut: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { text: "", size, cut: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), size, cut: false };
}

type Body = { raw: string; kind: RawKind } | undefined;
type Captured = { body: Body; size?: number; cut?: boolean };
const NO_BODY: Captured = { body: undefined };

/** A copy of a message's body to record, or its size only. */
async function captureBody(
  message: Request | Response,
  forcedKind: RawKind | null,
): Promise<Captured> {
  const kind = forcedKind ?? bodyKind(message.headers.get("content-type"));
  const length = Number(message.headers.get("content-length") ?? Number.NaN);
  if (!kind || !message.body)
    return { body: undefined, size: length || undefined };
  if (length > RECORD_BODY_LIMIT)
    return { body: undefined, size: length, cut: true };
  const copy = message.clone();
  const { text, size, cut } = await readCapped(copy.body, RECORD_BODY_LIMIT);
  if (cut) return { body: undefined, size, cut };
  return { body: { raw: text, kind }, size };
}

type FetchHandler = (
  this: unknown,
  request: Request,
  // biome-ignore lint/suspicious/noExplicitAny: Bun's Server type is generic over the socket data.
  server: any,
) => Response | undefined | Promise<Response | undefined>;

/**
 * Records every request and response of a fetch handler as one `exchange`
 * event: method, path, query, headers, status, the JSON, form or text bodies
 * up to 256 KiB, and the time to the response's headers. A WebSocket
 * upgrade records `upgrade: true`.
 */
export function recordFetch<F extends FetchHandler>(
  recorder: ContractRecorder | null,
  channel: RecordChannel,
  fetch: F,
  options: { requestKind?: RawKind } = {},
): F {
  if (!recorder) return fetch;
  const wrapped = async function (
    this: unknown,
    request: Request,
    server: unknown,
  ) {
    const started = performance.now();
    const method = request.method;
    const requestBody =
      method === "GET" || method === "HEAD"
        ? Promise.resolve(NO_BODY)
        : captureBody(request, options.requestKind ?? null).catch(
            () => NO_BODY,
          );
    const fields: Record<string, unknown> = {
      method,
      headers: Object.fromEntries(request.headers),
    };
    let response: Response | undefined;
    try {
      response = await fetch.call(this, request, server);
    } catch (error) {
      void requestBody.then(({ body }) =>
        recorder.record({
          ch: channel,
          ev: "exchange",
          url: request.url,
          fields: {
            ...fields,
            ms: Math.round(performance.now() - started),
            thrown: (error as Error)?.message ?? String(error),
          },
          bodies: { body },
        }),
      );
      throw error;
    }
    const ms = Math.round(performance.now() - started);
    const responseBody =
      response && method !== "HEAD"
        ? captureBody(response, null).catch(() => NO_BODY)
        : Promise.resolve(NO_BODY);
    void Promise.all([requestBody, responseBody]).then(([req, res]) => {
      recorder.record({
        ch: channel,
        ev: "exchange",
        url: request.url,
        fields: {
          ...fields,
          ...(req.size !== undefined ? { size: req.size } : {}),
          ...(req.cut ? { cut: true } : {}),
          ms,
          ...(response
            ? {
                status: response.status,
                response_headers: Object.fromEntries(response.headers),
                ...(res.size !== undefined ? { response_size: res.size } : {}),
                ...(res.cut ? { response_cut: true } : {}),
              }
            : { upgrade: true }),
        },
        bodies: { body: req.body, response: res.body },
      });
    });
    return response;
  };
  return wrapped as unknown as F;
}

/** Which recorded channel a server socket belongs to. */
export type SocketChannel<T> = (ws: ServerWebSocket<T>) => RecordChannel;

type Recorded = {
  id: string;
  channel: RecordChannel;
  chunks: Map<string, string[]>;
};

let socketCounter = 0;

function binaryLength(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

/**
 * Records a WebSocket handler's traffic: `open`, every message `in` and
 * `out` (a flow-controlled reply's chunks reassembled into one message;
 * binary frames by length only) and `close`, each with the socket's id.
 */
export function recordWebSocket<T>(
  recorder: ContractRecorder | null,
  channelOf: SocketChannel<T>,
  handler: WebSocketHandler<T>,
): WebSocketHandler<T> {
  if (!recorder) return handler;
  const sockets = new WeakMap<ServerWebSocket<T>, Recorded>();

  function outgoing(socket: Recorded, data: unknown) {
    if (typeof data !== "string") {
      recorder?.record({
        ch: socket.channel,
        ev: "out",
        sock: socket.id,
        fields: { binary: binaryLength(data) },
      });
      return;
    }
    if (data.startsWith(WS_CHUNK_MARKER)) {
      // `\u0001<chunk id>:<done 0|1>:<text>` (bridge/websocket-send.ts)
      const first = data.indexOf(":");
      const second = data.indexOf(":", first + 1);
      if (first > 0 && second > first) {
        const id = data.slice(1, first);
        const done = data.slice(first + 1, second) === "1";
        const parts = socket.chunks.get(id) ?? [];
        parts.push(data.slice(second + 1));
        if (!done) {
          socket.chunks.set(id, parts);
          return;
        }
        socket.chunks.delete(id);
        recorder?.record({
          ch: socket.channel,
          ev: "out",
          sock: socket.id,
          fields: { chunks: parts.length },
          raw: parts.join(""),
        });
        return;
      }
    }
    recorder?.record({
      ch: socket.channel,
      ev: "out",
      sock: socket.id,
      raw: data,
    });
  }

  function attach(ws: ServerWebSocket<T>): Recorded {
    const existing = sockets.get(ws);
    if (existing) return existing;
    socketCounter += 1;
    const channel = channelOf(ws);
    const socket: Recorded = {
      id: `${channel}-${process.pid}-${socketCounter}`,
      channel,
      chunks: new Map(),
    };
    sockets.set(ws, socket);
    const send = ws.send.bind(ws);
    // Every send path (the flow-controlled queue, voice, the notification
    // feed) ends in ws.send.
    (ws as { send: typeof ws.send }).send = (data, compress) => {
      outgoing(socket, data);
      return send(data, compress);
    };
    return socket;
  }

  return {
    ...handler,
    open(ws) {
      const socket = attach(ws);
      recorder.record({
        ch: socket.channel,
        ev: "open",
        sock: socket.id,
      });
      return handler.open?.(ws);
    },
    message(ws, message) {
      const socket = attach(ws);
      if (typeof message === "string")
        recorder.record({
          ch: socket.channel,
          ev: "in",
          sock: socket.id,
          raw: message,
        });
      else
        recorder.record({
          ch: socket.channel,
          ev: "in",
          sock: socket.id,
          fields: { binary: binaryLength(message) },
        });
      return handler.message?.(ws, message);
    },
    close(ws, code, reason) {
      const socket = attach(ws);
      recorder.record({
        ch: socket.channel,
        ev: "close",
        sock: socket.id,
        fields: { code, reason: reason || undefined },
      });
      return handler.close?.(ws, code, reason);
    },
  };
}

/** A command line's arguments, a credential after a credential flag hidden. */
function argvOf(argv: readonly unknown[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const raw of argv) {
    const arg = String(raw);
    if (hideNext) {
      out.push("[redacted]");
      hideNext = false;
      continue;
    }
    const flag =
      /^--?([a-z0-9_-]*(?:password|passwd|token|secret|pin|auth|api-?key))(=.*)?$/i.exec(
        arg,
      );
    if (flag) {
      if (flag[2]) out.push(`--${flag[1]}=[redacted]`);
      else {
        out.push(arg);
        hideNext = true;
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

type SpawnArgs = { argv: string[]; cwd?: string };

function bunSpawnArgs(args: unknown[]): SpawnArgs {
  const [first, second] = args as [unknown, { cwd?: string } | undefined];
  if (Array.isArray(first)) return { argv: argvOf(first), cwd: second?.cwd };
  if (first && typeof first === "object") {
    const options = first as { cmd?: unknown[]; cwd?: string };
    return { argv: argvOf(options.cmd ?? []), cwd: options.cwd };
  }
  return { argv: [] };
}

function nodeSpawnArgs(args: unknown[]): SpawnArgs {
  const [command, rest, options] = args as [unknown, unknown, unknown];
  const list = Array.isArray(rest) ? rest : [];
  const opts = (Array.isArray(rest) ? options : rest) as
    | { cwd?: string }
    | undefined;
  return { argv: argvOf([command, ...list]), cwd: opts?.cwd };
}

let spawnsPatched = false;
/** The recorder the patched spawn functions write to (the latest given). */
let spawnRecorder: ContractRecorder | null = null;

/**
 * Records every process this one runs, through Bun.spawn, Bun.spawnSync and
 * node:child_process (spawn, spawnSync, execFile, execFileSync): its
 * arguments and working directory at `start`, its exit code and duration at
 * `exit`. Output and environment are not recorded.
 */
export function recordSpawns(recorder: ContractRecorder | null): void {
  if (!recorder) return;
  spawnRecorder = recorder;
  if (spawnsPatched) return;
  spawnsPatched = true;
  const bun = Bun as unknown as Record<string, (...args: unknown[]) => unknown>;
  const node = childProcess as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;

  function started(api: string, info: SpawnArgs, pid: number | undefined) {
    spawnRecorder?.record({
      ch: "spawn",
      ev: "start",
      fields: { api, argv: info.argv, cwd: info.cwd, pid },
    });
  }
  function exited(
    api: string,
    info: SpawnArgs,
    pid: number | undefined,
    begun: number,
    code: unknown,
    extra: Record<string, unknown> = {},
  ) {
    spawnRecorder?.record({
      ch: "spawn",
      ev: "exit",
      fields: {
        api,
        argv: info.argv,
        pid,
        code: typeof code === "number" || code === null ? code : String(code),
        ms: Math.round(performance.now() - begun),
        ...extra,
      },
    });
  }

  const spawn = bun.spawn!;
  bun.spawn = function (this: unknown, ...args: unknown[]) {
    const begun = performance.now();
    const proc = spawn.apply(this ?? Bun, args) as {
      pid?: number;
      exited?: Promise<number>;
    };
    const info = bunSpawnArgs(args);
    started("Bun.spawn", info, proc.pid);
    void proc.exited?.then(
      (code) => exited("Bun.spawn", info, proc.pid, begun, code),
      () => undefined,
    );
    return proc;
  };
  const spawnSync = bun.spawnSync!;
  bun.spawnSync = function (this: unknown, ...args: unknown[]) {
    const begun = performance.now();
    const info = bunSpawnArgs(args);
    const result = spawnSync.apply(this ?? Bun, args) as {
      pid?: number;
      exitCode?: number | null;
      stdout?: { byteLength?: number };
      stderr?: { byteLength?: number };
    };
    exited("Bun.spawnSync", info, result.pid, begun, result.exitCode, {
      stdout_bytes: result.stdout?.byteLength,
      stderr_bytes: result.stderr?.byteLength,
    });
    return result;
  };

  for (const name of ["spawn", "execFile"] as const) {
    const original = node[name]!;
    node[name] = function (this: unknown, ...args: unknown[]) {
      const begun = performance.now();
      const child = original.apply(this ?? childProcess, args) as {
        pid?: number;
        once?: (event: string, listener: (code: unknown) => void) => void;
      };
      const info = nodeSpawnArgs(args);
      started(`child_process.${name}`, info, child.pid);
      child.once?.("exit", (code) =>
        exited(`child_process.${name}`, info, child.pid, begun, code),
      );
      return child;
    };
  }
  for (const name of ["spawnSync", "execFileSync"] as const) {
    const original = node[name]!;
    node[name] = function (this: unknown, ...args: unknown[]) {
      const begun = performance.now();
      const info = nodeSpawnArgs(args);
      try {
        const result = original.apply(this ?? childProcess, args) as {
          pid?: number;
          status?: number | null;
        };
        exited(
          `child_process.${name}`,
          info,
          result?.pid,
          begun,
          name === "spawnSync" ? result?.status : 0,
        );
        return result;
      } catch (error) {
        exited(`child_process.${name}`, info, undefined, begun, null, {
          error: (error as Error).message,
        });
        throw error;
      }
    };
  }
}

/**
 * Records one CLI invocation: its arguments, exit code, duration and what it
 * printed through the context's log and error (64 KiB at most each). Returns
 * the context to run it with and the function to call with its result.
 */
export function recordCli<
  C extends {
    log: (message: string) => void;
    error: (message: string) => void;
  },
>(
  recorder: ContractRecorder | null,
  argv: readonly string[],
  context: C,
): { context: C; finish: (result: unknown) => void } {
  if (!recorder) return { context, finish: () => undefined };
  const begun = performance.now();
  const limit = 64 * 1024;
  const output = { out: "", err: "" };
  const capture =
    (stream: "out" | "err", print: (message: string) => void) =>
    (message: string) => {
      if (output[stream].length < limit) output[stream] += `${message}\n`;
      print(message);
    };
  return {
    context: {
      ...context,
      log: capture("out", context.log),
      error: capture("err", context.error),
    },
    finish(result) {
      recorder.role = "cli";
      recorder.record({
        ch: "cli",
        ev: "run",
        fields: {
          argv: argvOf(argv),
          exit: typeof result === "number" ? result : String(result),
          ms: Math.round(performance.now() - begun),
          stdout: output.out.slice(0, limit),
          stderr: output.err.slice(0, limit),
        },
      });
    },
  };
}

/**
 * Bun.serve, recording the server's traffic: its fetch handler on `channel`,
 * its WebSocket handler on the channel `socketChannel` gives each socket.
 * Bun.serve itself when record mode is off.
 */
export function recordServe(
  recorder: ContractRecorder | null,
  channel: RecordChannel,
  // biome-ignore lint/suspicious/noExplicitAny: any socket data.
  socketChannel: SocketChannel<any> = () => "ws",
): typeof Bun.serve {
  if (!recorder) return Bun.serve;
  const serve = (options: {
    fetch?: FetchHandler;
    // biome-ignore lint/suspicious/noExplicitAny: any socket data.
    websocket?: WebSocketHandler<any>;
  }) =>
    Bun.serve({
      ...options,
      ...(options.fetch
        ? {
            fetch: recordFetch(
              recorder,
              channel,
              options.fetch,
              // The agent socket's clients post JSON or forms, whatever their header.
              channel === "agent" ? { requestKind: "form" } : {},
            ),
          }
        : {}),
      ...(options.websocket
        ? {
            websocket: recordWebSocket(
              recorder,
              socketChannel,
              options.websocket,
            ),
          }
        : {}),
    } as Parameters<typeof Bun.serve>[0]);
  return serve as unknown as typeof Bun.serve;
}
