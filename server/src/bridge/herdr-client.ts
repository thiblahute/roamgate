import { EventEmitter } from "node:events";
import * as net from "node:net";
import { type Logger, serverLogger } from "../utils/logger";
import {
  closeDescriptor,
  connectUnix,
  writeDescriptor,
} from "./unix-connect-sync";

const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 8000;

/**
 * Reads whose answer does not depend on who asks: identical calls made while
 * one is in flight share its request (Herdr handles requests one at a time,
 * and a pane.list costs it about 10 ms).
 */
const SHARED_READS = new Set([
  "workspace.list",
  "workspace.get",
  "tab.list",
  "tab.get",
  "pane.list",
  "pane.get",
  "pane.layout",
  "agent.list",
  "agent.get",
]);

/**
 * The topology lists every page, poller and lookup asks for (each browser
 * refreshes them every few seconds and on every event): an answer is reused
 * for READ_REUSE_MS after its request started, unless a Herdr event or a
 * change made through this client came in since.
 */
const REUSED_READS = new Set([
  "workspace.list",
  "tab.list",
  "pane.list",
  "agent.list",
]);
const READ_REUSE_MS = 1000;

/** Methods that change nothing in Herdr, so keep the reads above valid. */
const NON_CHANGING = new Set(["ping"]);

type SharedRead = {
  generation: number;
  startedAt: number;
  result: Promise<unknown>;
};

/** The one-shot socket a call writes its request to. */
type OneShotSocket = {
  /** Bytes the socket took; the rest waits for `drain`. */
  write(data: Buffer): number;
  terminate(): void;
};

type OneShotHandlers = {
  open(socket: OneShotSocket): void;
  drain(socket: OneShotSocket): void;
  data(chunk: Uint8Array): void;
  close(): void;
  error(error: Error & { code?: string }): void;
};

/**
 * Bun.connect where it can: it writes sooner after connecting than node:net,
 * and a request Herdr does not find on its first read waits 100 ms (see
 * connectUnix). Windows keeps node:net, which reaches Herdr's named pipes.
 */
function connectOneShot(
  path: string,
  handlers: OneShotHandlers,
  useBunSocket = process.platform !== "win32",
  connectedFd?: number,
): void {
  if (!useBunSocket) {
    const socket = net.createConnection({ path });
    const wrapped: OneShotSocket = {
      // node:net queues whatever the socket buffer cannot take yet.
      write: (data) => {
        socket.write(data);
        return data.length;
      },
      terminate: () => socket.destroy(),
    };
    socket.on("connect", () => handlers.open(wrapped));
    socket.on("data", (chunk: Buffer) => handlers.data(chunk));
    socket.on("close", () => handlers.close());
    socket.on("error", (error) => handlers.error(error));
    return;
  }
  let wrapped: OneShotSocket | null = null;
  const wrap = (socket: import("bun").Socket<undefined>) =>
    (wrapped ??= {
      write: (data) => socket.write(data),
      terminate: () => socket.terminate(),
    });
  const events = {
    open: (socket: import("bun").Socket<undefined>) =>
      handlers.open(wrap(socket)),
    drain: (socket: import("bun").Socket<undefined>) =>
      handlers.drain(wrap(socket)),
    data: (_socket: unknown, chunk: Uint8Array) => handlers.data(chunk),
    close: () => handlers.close(),
    error: (_socket: unknown, error: Error) => handlers.error(error),
  };
  // A descriptor connectUnix already connected: Bun owns it from here and
  // closes it with the socket. Bun.connect takes { fd } (Bun.FdSocketOptions)
  // though its overloads only declare TCP and unix options.
  (connectedFd === undefined
    ? Bun.connect({ unix: path, socket: events })
    : Bun.connect({
        fd: connectedFd,
        socket: events,
      } satisfies Bun.FdSocketOptions as unknown as Bun.UnixSocketOptions)
  ).catch((error: Error) => handlers.error(error));
}

/**
 * The longest request line Herdr reads, not counting its newline (1 MiB,
 * found by trying against Herdr 0.9.0: a 1 MiB line is answered, one byte
 * more is dropped without an answer).
 */
export const HERDR_MAX_REQUEST_BYTES = 1024 * 1024;

/** Subscription selector: a bare event type or a parameterized subscription. */
export type HerdrSubscription =
  | string
  | { type: string; [key: string]: unknown };

/**
 * Minimal NDJSON client for the Herdr local socket.
 *
 * Herdr's wire model (confirmed against a running 0.7.0 server):
 *
 *   - **RPC is one-request-per-connection.** The server reads a single
 *     request line, writes a single response line, then closes the socket.
 *     So every `call()` opens a fresh connection.
 *   - **Subscriptions are long-lived.** `events.subscribe` keeps its
 *     connection open after the ack and pushes events as subsequent lines
 *     of the shape `{ event: "<name>", data: { ... } }`.
 */
export class HerdrClient extends EventEmitter {
  private logger: Logger;
  private connectionId: string | undefined;
  /** Bun.connect for one-shot calls; false keeps node:net, as on Windows. */
  private useBunSocket: boolean;
  /**
   * Connect and write each request in one synchronous step where the
   * platform allows it (see connectUnix), so Herdr's first read finds
   * the request instead of sleeping 100 ms.
   */
  private syncConnect: boolean;

  constructor(
    private socketPath: string,
    options: {
      logger?: Logger;
      connectionId?: string;
      useBunSocket?: boolean;
      syncConnect?: boolean;
      readReuseMs?: number;
    } = {},
  ) {
    super();
    this.logger = options.logger ?? serverLogger.child("herdr");
    this.connectionId = options.connectionId;
    this.useBunSocket = options.useBunSocket ?? process.platform !== "win32";
    this.syncConnect =
      this.useBunSocket &&
      (options.syncConnect ?? process.platform === "linux");
    this.readReuseMs = options.readReuseMs ?? READ_REUSE_MS;
  }

  /**
   * Bumped by every Herdr event and by every change made through this
   * client (when it starts and when it ends): a read started before that is
   * neither joined nor reused afterwards.
   */
  private readGeneration = 0;
  private sharedReads = new Map<string, SharedRead>();
  private reusedReads = new Map<string, SharedRead>();
  private readReuseMs: number;

  /** Forget shared and reused reads: Herdr's state may have changed. */
  invalidateReads(): void {
    this.readGeneration += 1;
    this.sharedReads.clear();
    this.reusedReads.clear();
  }

  /**
   * Herdr RPC. Reads in SHARED_READS join an identical one in flight, and
   * those in REUSED_READS reuse a recent answer (see READ_REUSE_MS); each
   * caller gets its own copy of the result. A shared read checks each
   * caller's beforeSend for that caller only (a read sent for a caller whose
   * check then fails changes nothing; that caller is just refused).
   * `fresh` asks Herdr anew, for a check a decision rests on.
   */
  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000,
    beforeSend?: () => void,
    options: { fresh?: boolean } = {},
  ): Promise<any> {
    if (SHARED_READS.has(method)) {
      return this.sharedRead(
        method,
        params,
        timeoutMs,
        beforeSend,
        options.fresh === true,
      );
    }
    if (NON_CHANGING.has(method)) {
      return this.request(method, params, timeoutMs, beforeSend);
    }
    this.invalidateReads();
    const result = this.request(method, params, timeoutMs, beforeSend);
    const settled = () => this.invalidateReads();
    result.then(settled, settled);
    return result;
  }

  private sharedRead(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    beforeSend: (() => void) | undefined,
    fresh: boolean,
  ): Promise<any> {
    const key = `${method}\n${JSON.stringify(params)}`;
    const generation = this.readGeneration;
    const now = performance.now();
    const reusable = this.reusedReads.get(key);
    const inFlight = this.sharedReads.get(key);
    let read: SharedRead;
    let reuse: "cache" | "in_flight" | null = null;
    if (
      !fresh &&
      reusable?.generation === generation &&
      now - reusable.startedAt < this.readReuseMs
    ) {
      read = reusable;
      reuse = "cache";
    } else if (!fresh && inFlight?.generation === generation) {
      read = inFlight;
      reuse = "in_flight";
    } else {
      const started: SharedRead = {
        generation,
        startedAt: now,
        result: this.request(method, params, timeoutMs),
      };
      read = started;
      this.sharedReads.set(key, started);
      const forget = () => {
        if (this.sharedReads.get(key) === started) this.sharedReads.delete(key);
      };
      started.result.then(() => {
        forget();
        const kept = this.reusedReads.get(key);
        // Never replace an answer with one Herdr was asked for earlier.
        if (
          REUSED_READS.has(method) &&
          this.readGeneration === started.generation &&
          (!kept || kept.startedAt <= started.startedAt)
        )
          this.reusedReads.set(key, started);
      }, forget);
    }
    if (reuse && this.logger.enabled("debug")) {
      void read.result.then(
        () =>
          this.logger.debug("herdr call reused", {
            connection: this.connectionId,
            method,
            reuse,
            total_ms: Math.round(performance.now() - now),
            age_ms: Math.round(performance.now() - read.startedAt),
          }),
        () => undefined,
      );
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };
      // Like an unshared call: checked after call() returns.
      queueMicrotask(() => {
        try {
          beforeSend?.();
        } catch (error) {
          settle(() =>
            reject(
              error instanceof Error
                ? error
                : new Error("RPC dispatch rejected"),
            ),
          );
          return;
        }
        // The request that started carries its caller's own timeout.
        if (reuse === "in_flight") {
          timer = setTimeout(
            () => settle(() => reject(new Error(`timeout: ${method}`))),
            timeoutMs,
          );
        }
        read.result.then(
          (value) => settle(() => resolve(structuredClone(value))),
          (error) => settle(() => reject(error)),
        );
      });
    });
  }

  /** One-shot RPC: open -> send one request -> read one response -> close. */
  private request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000,
    beforeSend?: () => void,
  ): Promise<any> {
    const requestId = `r_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    // What the socket has not taken yet. A Bun socket write takes only
    // what fits in the socket buffer, and a long request (a long message
    // sent with pane.send_input) does not fit in one; Herdr waits for the
    // whole line.
    const request = JSON.stringify({ id: requestId, method, params }) + "\n";
    let unsent = Buffer.from(request);
    // Herdr drops a request line over 1 MiB without answering, so refuse it
    // before connecting or arming the timeout.
    const lineBytes = unsent.length - 1;
    if (lineBytes > HERDR_MAX_REQUEST_BYTES) {
      return Promise.reject(
        new Error(
          `${method}: too large for Herdr (${Math.ceil(lineBytes / 1024)} KiB, at most 1024)`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      let s: OneShotSocket | null = null;
      let buf = "";
      let done = false;
      const decoder = new TextDecoder();
      // Debug timing: total call time, plus write -> first response byte,
      // which isolates the round trip and Herdr's own wait from the connect.
      const logger = this.logger;
      const connectionId = this.connectionId;
      const startedAt = performance.now();
      let writtenAt: number | null = null;
      let firstByteAt: number | null = null;
      let responseBytes = 0;

      const timer = setTimeout(
        () => finish(new Error(`timeout: ${method}`)),
        timeoutMs,
      );

      function finish(err?: Error, val?: any) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          // One-shot RPCs never reuse the socket. Force closure so a peer that
          // keeps its readable side half-open cannot retain our descriptor
          // after a timeout or malformed response.
          s?.terminate();
        } catch {
          /* already closed */
        }
        if (logger.enabled("debug")) {
          const finishedAt = performance.now();
          logger.debug("herdr call", {
            connection: connectionId,
            method,
            status: err ? "error" : "ok",
            req_bytes: Buffer.byteLength(request),
            resp_bytes: responseBytes,
            total_ms: Math.round(finishedAt - startedAt),
            connect_ms:
              writtenAt === null
                ? undefined
                : Math.round(writtenAt - startedAt),
            first_byte_ms:
              writtenAt === null || firstByteAt === null
                ? undefined
                : Math.round(firstByteAt - writtenAt),
            error: err?.message,
          });
        }
        if (err) reject(err);
        else resolve(val);
      }

      const onData = (chunk: Uint8Array) => {
        firstByteAt ??= performance.now();
        responseBytes += chunk.byteLength;
        buf += decoder.decode(chunk, { stream: true });
        const i = buf.indexOf("\n");
        if (i === -1) {
          if (Buffer.byteLength(buf) > MAX_NDJSON_LINE_BYTES) {
            finish(new Error("Herdr response line is too large"));
          }
          return;
        }
        const line = buf.slice(0, i).trim();
        if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
          return finish(new Error("Herdr response line is too large"));
        }
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(new Error("bad JSON from Herdr"));
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
          return finish(new Error("invalid response envelope from Herdr"));
        }
        const envelope = msg as Record<string, unknown>;
        const hasResult = Object.hasOwn(envelope, "result");
        const hasError = Object.hasOwn(envelope, "error");
        if (
          envelope.id !== requestId ||
          hasResult === hasError ||
          (hasError &&
            (!envelope.error ||
              typeof envelope.error !== "object" ||
              Array.isArray(envelope.error)))
        ) {
          return finish(new Error("invalid response envelope from Herdr"));
        }
        if (hasError) {
          const error = envelope.error as Record<string, unknown>;
          const code = typeof error.code === "string" ? error.code : "error";
          const message =
            typeof error.message === "string"
              ? error.message
              : "Herdr request failed";
          finish(new Error(`${code}: ${message}`));
        } else {
          finish(undefined, envelope.result);
        }
      };
      const sendRest = (socket: OneShotSocket) => {
        while (unsent.length) {
          const written = socket.write(unsent);
          // A full socket buffer: drain() sends the rest.
          if (written <= 0) return;
          unsent = unsent.subarray(written);
        }
        writtenAt ??= performance.now();
      };
      const fail = (error: unknown, fallback: string) =>
        finish(error instanceof Error ? error : new Error(fallback));
      // beforeSend runs once, as late as possible before the first byte.
      let checked = false;
      const check = () => {
        if (checked) return;
        checked = true;
        beforeSend?.();
      };
      const handlers: OneShotHandlers = {
        open(socket) {
          s = socket;
          if (done) {
            socket.terminate();
            return;
          }
          try {
            check();
            sendRest(socket);
          } catch (error) {
            fail(error, "RPC dispatch rejected");
          }
        },
        drain(socket) {
          if (done || !unsent.length) return;
          try {
            sendRest(socket);
          } catch (error) {
            fail(error, "RPC write failed");
          }
        },
        data: onData,
        close() {
          finish(new Error(`connection closed before response: ${method}`));
        },
        error(e) {
          finish(new Error(`${e.code ?? "error"}: ${e.message}`));
        },
      };
      if (!this.syncConnect) {
        connectOneShot(this.socketPath, handlers, this.useBunSocket);
        return;
      }
      // After this call returns, like the open callback, so a caller's
      // beforeSend still sees what it changed right after calling. Connect,
      // check and write stay one synchronous step.
      queueMicrotask(() => {
        if (done) return;
        const fd = connectUnix(this.socketPath);
        if (fd === null) {
          connectOneShot(this.socketPath, handlers, true);
          return;
        }
        try {
          check();
        } catch (error) {
          closeDescriptor(fd);
          fail(error, "RPC dispatch rejected");
          return;
        }
        unsent = unsent.subarray(writeDescriptor(fd, unsent));
        if (!unsent.length) writtenAt = performance.now();
        connectOneShot(this.socketPath, handlers, true, fd);
      });
    });
  }

  /**
   * Long-lived event subscription. Returns a `close` handle and a `ready`
   * promise that resolves once the subscription is acknowledged.
   */
  subscribe(
    types: HerdrSubscription[],
    ackTimeoutMs = SUBSCRIPTION_ACK_TIMEOUT_MS,
  ): {
    close: () => void;
    ready: Promise<void>;
    closed: Promise<void>;
  } {
    const s = net.createConnection({ path: this.socketPath });
    let buf = "";
    let acked = false;
    let readySettled = false;
    let closeRequested = false;
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    let closedResolve!: () => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    const ackTimer = setTimeout(
      () => {
        if (readySettled) return;
        readySettled = true;
        readyReject(new Error("subscription acknowledgement timed out"));
        s.destroy();
      },
      Math.max(1, ackTimeoutMs),
    );
    const resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(ackTimer);
      readyResolve();
    };
    const rejectReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(ackTimer);
      readyReject(error);
    };
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });

    s.on("error", (e) => {
      this.emit("error", e);
      if (!acked) rejectReady(e);
    });
    s.on("connect", () => {
      s.write(
        JSON.stringify({
          id: "sub",
          method: "events.subscribe",
          params: {
            subscriptions: types.map((t) =>
              typeof t === "string" ? { type: t } : t,
            ),
          },
        }) + "\n",
      );
    });
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
          rejectReady(new Error("Herdr subscription line is too large"));
          s.destroy();
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          if (!acked) {
            rejectReady(new Error("bad subscription JSON from Herdr"));
            s.destroy();
            return;
          }
          continue;
        }
        if (!acked) {
          if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
            rejectReady(new Error("invalid subscription acknowledgement"));
            s.destroy();
            return;
          }
          const envelope = msg as Record<string, unknown>;
          const hasResult = Object.hasOwn(envelope, "result");
          const hasError = Object.hasOwn(envelope, "error");
          if (envelope.id !== "sub" || hasResult === hasError) {
            rejectReady(new Error("invalid subscription acknowledgement"));
            s.destroy();
            return;
          }
          acked = true;
          if (hasError) {
            const error = envelope.error;
            const message =
              error &&
              typeof error === "object" &&
              !Array.isArray(error) &&
              typeof (error as { message?: unknown }).message === "string"
                ? (error as { message: string }).message
                : "subscribe failed";
            rejectReady(new Error(message));
            s.destroy();
          } else {
            // Events may have been missed while not subscribed.
            this.invalidateReads();
            resolveReady();
          }
          continue;
        }
        if (
          msg &&
          typeof msg === "object" &&
          !Array.isArray(msg) &&
          typeof (msg as { event?: unknown }).event === "string"
        ) {
          this.invalidateReads();
          this.emit("event", msg);
        }
      }
      if (Buffer.byteLength(buf) > MAX_NDJSON_LINE_BYTES) {
        rejectReady(new Error("Herdr subscription line is too large"));
        s.destroy();
      }
    });
    s.on("close", () => {
      if (!acked) {
        rejectReady(new Error("subscription closed before acknowledgement"));
      }
      clearTimeout(ackTimer);
      closedResolve();
      this.emit("subscription_closed");
    });

    const close = () => {
      if (closeRequested) return;
      closeRequested = true;
      s.destroy();
    };

    return { close, ready, closed };
  }

  ping(): Promise<any> {
    return this.request("ping");
  }
}
