/**
 * One end of the internal channel (contract/wire/core-channel.md) over a
 * stream socket: frames in and out, requests and their replies, pushes
 * through the coalescing outbound queue, HTTP with streamed bodies and
 * their acknowledgement window, and liveness. Either end can use it; the
 * handshake (`hello`, `welcome`) is its user's.
 */
import type { Socket } from "node:net";
import { FrameReader } from "../utils/frames";
import { realTimers } from "../utils/test-clock";
import {
  BODY_CHUNK,
  BODY_WINDOW,
  CHANNEL_KINDS,
  CHANNEL_MAX_FRAME,
  decodeBody,
  encodeBody,
  encodeMessage,
  FLAG_END,
  FLAG_RESPONSE,
  KIND_BODY,
  KIND_MESSAGE,
  OutboundQueue,
} from "./protocol";

export type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

export const REAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => realTimers.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    realTimers.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => realTimers.now(),
};

/** What the front knows of a request (`ctx`). */
export type CallContext = {
  connection_id?: string;
  connection_generation?: number;
  socket_id?: number;
  lane?: string;
  session_id?: string;
  client_ip?: string;
};

export type Message = { t: string } & Record<string, unknown>;

/** An error reply: its message, and the code and data it may carry. */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export type IncomingCall = {
  method: string;
  params: unknown;
  ctx: CallContext;
  shadow: boolean;
};

export type HttpRequestHead = {
  method: string;
  url: string;
  headers: [string, string][];
  ctx: CallContext;
};

export type ChannelHttpRequest = HttpRequestHead & {
  body: ReadableStream<Uint8Array> | null;
};

export type ChannelHttpResponse = {
  status: number;
  headers: [string, string][];
  body: ReadableStream<Uint8Array> | Uint8Array | null;
};

/** A push as it travels: the browser message and where it goes. */
export type PushMessage = {
  message: Record<string, unknown>;
  key?: string;
  connection_id?: string;
  connection_generation?: number;
  socket_id?: number;
  session_id?: string;
};

export type ChannelHandlers = {
  /** A `call` (the core's side). */
  call?: (call: IncomingCall, signal: AbortSignal) => Promise<unknown>;
  /** A `reverse_call` (the front's side). */
  reverseCall?: (
    target: string,
    args: unknown,
    ctx: CallContext,
    signal: AbortSignal,
  ) => Promise<unknown>;
  push?: (push: PushMessage) => void;
  http?: (
    request: ChannelHttpRequest,
    signal: AbortSignal,
  ) => Promise<ChannelHttpResponse>;
  /** hello, welcome, refused, owner, pong, bye. */
  control?: (message: Message) => void;
  /** The channel closed; `error` when it broke. */
  close?: (error: Error | null) => void;
  log?: (level: "debug" | "warn", message: string) => void;
};

export type ChannelOptions = {
  timers?: Timers;
  /** Send `ping` after this long without sending anything. */
  pingAfterMs?: number;
  /** Close when nothing came for this long. */
  deadAfterMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** For an `http`: resolves with the response head instead. */
  http?: boolean;
};

/** A body coming in, read by its consumer through a stream. */
class IncomingBody {
  readonly stream: ReadableStream<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private done = false;
  private failed: Error | null = null;
  private waiting: (() => void) | null = null;
  private discarding = false;

  constructor(
    private readonly ack: (bytes: number) => void,
    onCancel: () => void,
  ) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (!this.chunks.length && !this.done && !this.failed)
            await new Promise<void>((resolve) => {
              this.waiting = resolve;
            });
          const chunk = this.chunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
            this.ack(chunk.length);
            return;
          }
          if (this.failed) controller.error(this.failed);
          else controller.close();
        },
        cancel: () => {
          this.discarding = true;
          const queued = this.chunks.reduce((sum, c) => sum + c.length, 0);
          this.chunks = [];
          if (queued) this.ack(queued);
          onCancel();
        },
      },
      { highWaterMark: 0 },
    );
  }

  /** A chunk came; true when it was the last. */
  add(bytes: Uint8Array, end: boolean): void {
    if (this.discarding) {
      if (bytes.length) this.ack(bytes.length);
    } else if (bytes.length) this.chunks.push(bytes);
    if (end) this.done = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.done) return;
    this.failed = error;
    this.wake();
  }

  private wake() {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }
}

/** A body going out, held back while its window is full. */
class OutgoingBody {
  private unacked = 0;
  private waiting: (() => void) | null = null;
  stopped = false;

  ack(bytes: number) {
    this.unacked = Math.max(0, this.unacked - bytes);
    this.wake();
  }

  stop() {
    this.stopped = true;
    this.wake();
  }

  async sent(bytes: number) {
    this.unacked += bytes;
    while (this.unacked > BODY_WINDOW && !this.stopped)
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
  }

  private wake() {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }
}

export class Channel {
  private readonly reader = new FrameReader(CHANNEL_KINDS, CHANNEL_MAX_FRAME);
  private readonly queue = new OutboundQueue<Uint8Array>();
  private readonly timers: Timers;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** The peer's requests we answer: their aborts. */
  private readonly serving = new Map<number, AbortController>();
  /** Bodies coming in: of the peer's requests, of our requests' responses. */
  private readonly requestBodiesIn = new Map<number, IncomingBody>();
  private readonly responseBodiesIn = new Map<number, IncomingBody>();
  /** Bodies going out: of our requests, of our responses to the peer's. */
  private readonly requestBodiesOut = new Map<number, OutgoingBody>();
  private readonly responseBodiesOut = new Map<number, OutgoingBody>();
  private blocked = false;
  private closed = false;
  private lastSent: number;
  private lastReceived: number;
  private pingTimer: unknown = null;
  private deadTimer: unknown = null;
  private pingCount = 0;
  private readonly unknownLogged = new Set<string>();

  constructor(
    private readonly socket: Socket,
    private readonly handlers: ChannelHandlers = {},
    private readonly options: ChannelOptions = {},
  ) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.lastSent = this.lastReceived = this.timers.now();
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("drain", () => {
      this.blocked = false;
      this.flush();
    });
    socket.on("error", (error) => this.shutdown(error));
    socket.on("close", () => this.shutdown(null));
    this.armPing();
    this.armDead();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends a control message (hello, welcome, owner, bye...). */
  send(message: Message): void {
    this.write(encodeMessage(message));
  }

  call(
    method: string,
    params: unknown,
    ctx: CallContext = {},
    options: { shadow?: boolean; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.request(
      {
        t: "call",
        method,
        params: params ?? null,
        ctx,
        ...(options.shadow ? { shadow: true } : {}),
      },
      options.signal,
    );
  }

  reverseCall(
    target: string,
    args: unknown,
    ctx?: CallContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      {
        t: "reverse_call",
        target,
        args: args ?? null,
        ...(ctx ? { ctx } : {}),
      },
      signal,
    );
  }

  push(push: PushMessage): void {
    this.write(encodeMessage({ t: "push", ...push }), push.key ?? null);
  }

  /** Sends an HTTP request; resolves with the response once its head came. */
  async http(
    request: ChannelHttpRequest,
    signal?: AbortSignal,
  ): Promise<ChannelHttpResponse> {
    const id = this.nextId++;
    const head = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, http: true });
    });
    const abort = () => this.cancel(id);
    signal?.addEventListener("abort", abort, { once: true });
    this.send({
      t: "http",
      id,
      method: request.method,
      url: request.url,
      headers: request.headers,
      ctx: request.ctx,
      body: request.body !== null,
    });
    if (request.body) {
      const out = new OutgoingBody();
      this.requestBodiesOut.set(id, out);
      void this.pump(id, 0, request.body, out).finally(() =>
        this.requestBodiesOut.delete(id),
      );
    }
    try {
      return (await head) as ChannelHttpResponse;
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      throw error;
    }
  }

  /** Says `bye` and closes once it is written. */
  close(): void {
    if (this.closed) return;
    this.send({ t: "bye" });
    this.flush();
    this.socket.end();
  }

  /** Closes at once. */
  destroy(error?: Error): void {
    this.socket.destroy();
    this.shutdown(error ?? null);
  }

  private request(message: Message, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new ChannelError("channel closed"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    if (signal) {
      const abort = () => this.cancel(id);
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        () => signal.removeEventListener("abort", abort),
        () => signal.removeEventListener("abort", abort),
      );
    }
    this.send({ ...message, id });
    return promise;
  }

  /** We no longer want the answer to our request `id`. */
  private cancel(id: number) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    this.requestBodiesOut.get(id)?.stop();
    const body = this.responseBodiesIn.get(id);
    this.responseBodiesIn.delete(id);
    body?.fail(new ChannelError("cancelled"));
    if (this.closed) return;
    this.send({ t: "cancel", id });
    pending?.reject(new ChannelError("cancelled", "cancelled"));
  }

  private write(bytes: Uint8Array, key: string | null = null) {
    if (this.closed) return;
    this.queue.enqueue(bytes, key);
    this.lastSent = this.timers.now();
    this.flush();
  }

  private flush() {
    while (!this.blocked && !this.closed) {
      const bytes = this.queue.take();
      if (!bytes) return;
      if (!this.socket.write(bytes)) this.blocked = true;
    }
  }

  private onData(chunk: Buffer) {
    this.lastReceived = this.timers.now();
    const frames = this.reader.push(chunk);
    for (const frame of frames) {
      if (this.closed) return;
      if (frame.kind === KIND_BODY) this.onBody(frame.payload);
      else if (frame.kind === KIND_MESSAGE) {
        let message: Message;
        try {
          message = JSON.parse(new TextDecoder().decode(frame.payload));
        } catch {
          this.destroy(new ChannelError("a message that is not JSON"));
          return;
        }
        if (!message || typeof message !== "object" || !message.t) {
          this.destroy(new ChannelError("a message without a type"));
          return;
        }
        this.onMessage(message);
      }
    }
    if (this.reader.error) this.destroy(this.reader.error);
  }

  private onBody(payload: Uint8Array) {
    const chunk = decodeBody(payload);
    if (!chunk) {
      this.destroy(new ChannelError("a body chunk too short"));
      return;
    }
    const end = (chunk.flags & FLAG_END) !== 0;
    const bodies =
      chunk.flags & FLAG_RESPONSE
        ? this.responseBodiesIn
        : this.requestBodiesIn;
    const body = bodies.get(chunk.stream);
    if (!body) {
      // A body nobody reads any more (cancelled): acknowledge it away.
      if (chunk.bytes.length)
        this.send({
          t: "ack",
          id: chunk.stream,
          response: (chunk.flags & FLAG_RESPONSE) !== 0,
          bytes: chunk.bytes.length,
        });
      return;
    }
    body.add(chunk.bytes, end);
    if (end) bodies.delete(chunk.stream);
  }

  private onMessage(message: Message) {
    const id = typeof message.id === "number" ? message.id : -1;
    switch (message.t) {
      case "reply": {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = message.error as
          | { message?: string; code?: string; data?: unknown }
          | undefined;
        if (error)
          pending.reject(
            new ChannelError(
              String(error.message ?? "error"),
              error.code,
              error.data,
            ),
          );
        else pending.resolve(message.result);
        return;
      }
      case "http_resp": {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        let body: ReadableStream<Uint8Array> | null = null;
        if (message.body) {
          const incoming = new IncomingBody(
            (bytes) => this.send({ t: "ack", id, response: true, bytes }),
            () => this.cancel(id),
          );
          this.responseBodiesIn.set(id, incoming);
          body = incoming.stream;
        }
        pending.resolve({
          status: Number(message.status),
          headers: (message.headers as [string, string][]) ?? [],
          body,
        });
        return;
      }
      case "ack": {
        const out = message.response
          ? this.responseBodiesOut.get(id)
          : this.requestBodiesOut.get(id);
        out?.ack(Number(message.bytes) || 0);
        return;
      }
      case "cancel": {
        this.serving.get(id)?.abort();
        this.responseBodiesOut.get(id)?.stop();
        const body = this.requestBodiesIn.get(id);
        this.requestBodiesIn.delete(id);
        body?.fail(new ChannelError("cancelled"));
        return;
      }
      case "call":
        this.serve(id, (signal) => {
          if (!this.handlers.call)
            throw new ChannelError(
              `no family here answers ${String(message.method)}`,
              "not_owner",
            );
          return this.handlers.call(
            {
              method: String(message.method),
              params: message.params,
              ctx: (message.ctx as CallContext) ?? {},
              shadow: message.shadow === true,
            },
            signal,
          );
        });
        return;
      case "reverse_call":
        this.serve(id, (signal) => {
          if (!this.handlers.reverseCall)
            throw new ChannelError(
              `unknown target ${String(message.target)}`,
              "unknown_target",
            );
          return this.handlers.reverseCall(
            String(message.target),
            message.args,
            (message.ctx as CallContext) ?? {},
            signal,
          );
        });
        return;
      case "http":
        this.serveHttp(id, message);
        return;
      case "push":
        this.handlers.push?.(message as unknown as PushMessage);
        return;
      case "ping":
        this.send({ t: "pong", n: message.n ?? 0 });
        return;
      case "welcome":
      case "hello":
      case "refused":
      case "owner":
      case "pong":
      case "bye":
        this.handlers.control?.(message);
        return;
      default:
        if (!this.unknownLogged.has(message.t)) {
          this.unknownLogged.add(message.t);
          this.handlers.log?.(
            "debug",
            `ignoring channel messages of type ${message.t}`,
          );
        }
    }
  }

  private serve(id: number, run: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController();
    this.serving.set(id, controller);
    void (async () => {
      try {
        const result = await run(controller.signal);
        this.reply(id, { result: result ?? null });
      } catch (error) {
        this.reply(id, { error: errorBody(error) });
      } finally {
        this.serving.delete(id);
      }
    })();
  }

  private reply(id: number, body: Record<string, unknown>) {
    if (this.closed) return;
    let frame = encodeMessage({ t: "reply", id, ...body });
    if (frame.length - 4 > CHANNEL_MAX_FRAME)
      frame = encodeMessage({
        t: "reply",
        id,
        error: {
          message: "reply too large for the channel",
          code: "too_large",
        },
      });
    this.write(frame);
  }

  private serveHttp(id: number, message: Message) {
    const controller = new AbortController();
    this.serving.set(id, controller);
    let body: ReadableStream<Uint8Array> | null = null;
    if (message.body) {
      const incoming = new IncomingBody(
        (bytes) => this.send({ t: "ack", id, response: false, bytes }),
        () => {},
      );
      this.requestBodiesIn.set(id, incoming);
      body = incoming.stream;
    }
    void (async () => {
      try {
        if (!this.handlers.http)
          throw new ChannelError("no family here serves HTTP", "not_owner");
        const response = await this.handlers.http(
          {
            method: String(message.method),
            url: String(message.url),
            headers: (message.headers as [string, string][]) ?? [],
            ctx: (message.ctx as CallContext) ?? {},
            body,
          },
          controller.signal,
        );
        if (this.closed) return;
        this.send({
          t: "http_resp",
          id,
          status: response.status,
          headers: response.headers,
          body: response.body !== null,
        });
        if (response.body) {
          const out = new OutgoingBody();
          this.responseBodiesOut.set(id, out);
          const stream =
            response.body instanceof Uint8Array
              ? new ReadableStream<Uint8Array>({
                  start(c) {
                    c.enqueue(response.body as Uint8Array);
                    c.close();
                  },
                })
              : response.body;
          try {
            await this.pump(id, FLAG_RESPONSE, stream, out);
          } finally {
            this.responseBodiesOut.delete(id);
          }
        }
      } catch (error) {
        this.reply(id, { error: errorBody(error) });
      } finally {
        this.serving.delete(id);
        const incoming = this.requestBodiesIn.get(id);
        if (incoming) {
          // The handler did not read the whole body: drop the rest.
          this.requestBodiesIn.delete(id);
          incoming.stream.cancel().catch(() => {});
        }
      }
    })();
  }

  /** Sends `stream` as body chunks of stream `id`, within the window. */
  private async pump(
    id: number,
    flags: number,
    stream: ReadableStream<Uint8Array>,
    out: OutgoingBody,
  ) {
    const reader = stream.getReader();
    try {
      for (;;) {
        if (out.stopped || this.closed) {
          await reader.cancel().catch(() => {});
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        for (let at = 0; at < value.length; at += BODY_CHUNK) {
          const part = value.subarray(at, at + BODY_CHUNK);
          this.write(encodeBody(id, flags, part));
          await out.sent(part.length);
          if (out.stopped || this.closed) {
            await reader.cancel().catch(() => {});
            return;
          }
        }
      }
      this.write(encodeBody(id, flags | FLAG_END, new Uint8Array(0)));
    } catch (error) {
      // The body's source failed: end the stream so the reader is not left
      // waiting, and say so.
      this.handlers.log?.(
        "warn",
        `a body of stream ${id} failed: ${(error as Error).message}`,
      );
      this.write(encodeBody(id, flags | FLAG_END, new Uint8Array(0)));
    } finally {
      reader.releaseLock();
    }
  }

  private armPing() {
    const after = this.options.pingAfterMs;
    if (!after || this.closed) return;
    const wait = Math.max(0, this.lastSent + after - this.timers.now());
    this.pingTimer = this.timers.setTimeout(() => {
      if (this.closed) return;
      if (this.timers.now() - this.lastSent >= after)
        this.send({ t: "ping", n: ++this.pingCount });
      this.armPing();
    }, wait || after);
  }

  private armDead() {
    const after = this.options.deadAfterMs;
    if (!after || this.closed) return;
    const wait = Math.max(0, this.lastReceived + after - this.timers.now());
    this.deadTimer = this.timers.setTimeout(() => {
      if (this.closed) return;
      if (this.timers.now() - this.lastReceived >= after) {
        this.destroy(
          new ChannelError(`nothing came for ${Math.round(after / 1000)} s`),
        );
        return;
      }
      this.armDead();
    }, wait || after);
  }

  private shutdown(error: Error | null) {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) this.timers.clearTimeout(this.pingTimer);
    if (this.deadTimer) this.timers.clearTimeout(this.deadTimer);
    const gone = error ?? new ChannelError("channel closed", "closed");
    for (const pending of this.pending.values()) pending.reject(gone);
    this.pending.clear();
    for (const controller of this.serving.values()) controller.abort();
    this.serving.clear();
    for (const body of [
      ...this.requestBodiesIn.values(),
      ...this.responseBodiesIn.values(),
    ])
      body.fail(gone);
    for (const out of [
      ...this.requestBodiesOut.values(),
      ...this.responseBodiesOut.values(),
    ])
      out.stop();
    this.handlers.close?.(error);
  }
}

function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof ChannelError
      ? error.code
      : typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : undefined;
  const data = error instanceof ChannelError ? error.data : undefined;
  return {
    message,
    ...(code ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}
