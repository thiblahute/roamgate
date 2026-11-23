/**
 * The Bun server as the portless core of a Rust front (stage 2,
 * contract/wire/core-channel.md, "Stage 2: the Rust front"): it connects
 * to the front's channel, says `hello`, runs the server's own fetch
 * handler on each `http` the front forwards, and turns each browser socket
 * the front accepts for it (`ws_open`) into a virtual socket its WebSocket
 * handlers drive as they would one of Bun.serve's.
 *
 * Nothing here runs unless `ROAMGATE_CORE_CHANNEL` names a channel.
 */
import { connect, type Socket } from "node:net";
import { setRemoteWebSocketFlow } from "../bridge/websocket-send";
import {
  type CallContext,
  Channel,
  ChannelError,
  type ChannelHttpResponse,
  type HttpRequestHead,
  type Message,
} from "./channel";
import { FAMILIES, type Families, PROTOCOL } from "./protocol";

export const CORE_CHANNEL_ENV = "ROAMGATE_CORE_CHANNEL";
export const CORE_TOKEN_ENV = "ROAMGATE_CORE_TOKEN";

/** The channel the front gave this process, or null: no front. */
export function coreChannelOf(
  env: Record<string, string | undefined>,
): { path: string; token: string } | null {
  const path = env[CORE_CHANNEL_ENV];
  if (!path) return null;
  return { path, token: env[CORE_TOKEN_ENV] ?? "" };
}

/** The families the Bun core serves: all of them, the test one aside. */
export function sidecarFamilies(families: Families = FAMILIES): string[] {
  return Object.entries(families)
    .filter(([, family]) => !family.test)
    .map(([name]) => name);
}

/** What the server's fetch handler uses of Bun's Server. */
export type SidecarServer = {
  requestIP(
    req: Request,
  ): { address: string; family: string; port: number } | null;
  timeout(req: Request, seconds: number): void;
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

export type SidecarFetch = (
  req: Request,
  server: SidecarServer,
) => Response | undefined | Promise<Response | undefined>;

/** The server's WebSocket handlers, as Bun.serve takes them. */
export type SidecarWebSocket<WS> = {
  open?(ws: WS): unknown;
  message?(ws: WS, message: string | Buffer): unknown;
  pong?(ws: WS, data: Buffer): unknown;
  close?(ws: WS, code: number, reason: string): unknown;
};

export type SidecarOptions<WS> = {
  path: string;
  token: string;
  version: string;
  pid?: number;
  families?: readonly string[];
  /** The front's scheme, for the requests' URLs. */
  scheme?: "http" | "https";
  fetch: SidecarFetch;
  websocket: SidecarWebSocket<WS>;
  /** The channel closed: the process ends with it. */
  onClose: (error: Error | null) => void;
  log?: (level: "debug" | "info" | "warn", message: string) => void;
  /** The front's `welcome` arrived: it holds the port and forwards. */
  onWelcome?: () => void;
  connect?: (path: string) => Socket;
};

export type Sidecar = {
  channel: Channel;
  /** The virtual sockets open now, by the front's socket id. */
  sockets: ReadonlyMap<number, VirtualSocket>;
};

type SocketLink = {
  send: (message: Message) => void;
  closed: (socket: VirtualSocket) => void;
  close: (socket: VirtualSocket, code: number, reason: string) => void;
  pong: (socket: VirtualSocket) => void;
};

/**
 * A browser socket the front holds, as the server's code sees it: what it
 * uses of Bun's ServerWebSocket. Sends become `ws_send`, a close `ws_end`;
 * back pressure and liveness are the front's.
 */
export class VirtualSocket {
  /** 1 open, 2 closing (closed by the core), 3 closed. */
  readyState = 1;
  private closeRan = false;

  constructor(
    readonly socketId: number,
    readonly transport: "ws" | "raw",
    public data: unknown,
    readonly remoteAddress: string,
    private readonly link: SocketLink,
  ) {}

  /** As Bun's: the bytes handed on, 0 once closed. */
  send(data: string | ArrayBufferView | ArrayBuffer): number {
    if (this.readyState !== 1) return 0;
    if (typeof data === "string") {
      this.link.send({
        t: "ws_send",
        socket_id: this.socketId,
        data,
        binary: false,
      });
      return Buffer.byteLength(data) || 1;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.link.send({
      t: "ws_send",
      socket_id: this.socketId,
      data: bytes.toString("base64"),
      binary: true,
    });
    return bytes.length || 1;
  }

  sendText(data: string): number {
    return this.send(data);
  }

  sendBinary(data: ArrayBufferView | ArrayBuffer): number {
    return this.send(data);
  }

  /** The core closes the browser socket: `ws_end`, then its close handling. */
  close(code?: number, reason?: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.link.send({
      t: "ws_end",
      socket_id: this.socketId,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    this.finish(code ?? 1000, reason ?? "");
  }

  terminate(): void {
    this.close(1006);
  }

  /**
   * The front pings the browser and closes a socket that stops answering
   * (`ws_close`), so an open virtual socket answers for it: the server's
   * own heartbeat (the notification feed's) sees it alive.
   */
  ping(): number {
    if (this.readyState !== 1) return 0;
    queueMicrotask(() => {
      if (this.readyState === 1) this.link.pong(this);
    });
    return 0;
  }

  getBufferedAmount(): number {
    return 0;
  }

  /** Runs the close handling, once, whoever closed. */
  finish(code: number, reason: string): void {
    if (this.closeRan) return;
    this.closeRan = true;
    this.readyState = 3;
    this.link.closed(this);
    this.link.close(this, code, reason);
  }
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://core.invalid").pathname;
  } catch {
    return url;
  }
}

/** The fetch handler's Server for a request the front forwarded. */
function serverFor(
  ctx: CallContext,
  upgrade: SidecarServer["upgrade"] = () => false,
): SidecarServer {
  return {
    requestIP: () =>
      ctx.client_ip
        ? {
            address: ctx.client_ip,
            family: ctx.client_ip.includes(":") ? "IPv6" : "IPv4",
            port: 0,
          }
        : null,
    // The front holds the connection and its idle budget.
    timeout: () => {},
    upgrade,
  };
}

/** The Request the browser sent, on the front's origin. */
export function requestOf(
  head: HttpRequestHead,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  scheme: "http" | "https",
): Request {
  const headers = new Headers();
  for (const [name, value] of head.headers) headers.append(name, value);
  const host = headers.get("host") || "localhost";
  const path = head.url.startsWith("/") ? head.url : `/${head.url}`;
  const method = head.method.toUpperCase();
  const bodyless = method === "GET" || method === "HEAD";
  if (body && bodyless) void body.cancel().catch(() => {});
  return new Request(`${scheme}://${host}${path}`, {
    method,
    headers,
    signal,
    ...(body && !bodyless ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

/** A response's head as the channel carries it (each Set-Cookie apart). */
export function responseHeaders(response: Response): [string, string][] {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie")
      headers.push([name.toLowerCase(), value]);
  });
  for (const cookie of response.headers.getSetCookie())
    headers.push(["set-cookie", cookie]);
  return headers;
}

function settle(result: unknown, warn: (message: string) => void) {
  if (result && typeof (result as Promise<unknown>).then === "function")
    (result as Promise<unknown>).then(undefined, (error) =>
      warn((error as Error)?.message ?? String(error)),
    );
}

export async function startSidecar<WS>(
  options: SidecarOptions<WS>,
): Promise<Sidecar> {
  const log = options.log ?? (() => {});
  const scheme = options.scheme ?? "http";
  const socket = (options.connect ?? ((path) => connect(path)))(options.path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const sockets = new Map<number, VirtualSocket>();
  const handlers = options.websocket;
  const asWs = (vws: VirtualSocket) => vws as unknown as WS;
  const failed = (what: string) => (message: string) =>
    log("warn", `a virtual socket's ${what} failed: ${message}`);

  const send = (message: Message) => channel.send(message);
  const link: SocketLink = {
    send,
    closed: (vws) => {
      if (sockets.get(vws.socketId) === vws) sockets.delete(vws.socketId);
    },
    close: (vws, code, reason) => {
      try {
        settle(handlers.close?.(asWs(vws), code, reason), failed("close"));
      } catch (error) {
        failed("close")((error as Error).message);
      }
    },
    pong: (vws) => {
      try {
        settle(handlers.pong?.(asWs(vws), Buffer.alloc(0)), failed("pong"));
      } catch (error) {
        failed("pong")((error as Error).message);
      }
    },
  };

  const channel: Channel = new Channel(socket, {
    http: async (request, signal): Promise<ChannelHttpResponse> => {
      const req = requestOf(request, request.body, signal, scheme);
      const response = await options.fetch(req, serverFor(request.ctx));
      if (!response)
        throw new ChannelError(
          `${request.method} ${pathnameOf(request.url)} gave no response`,
        );
      let body: ReadableStream<Uint8Array> | null = response.body;
      // As Bun.serve: a HEAD response has no body.
      if (req.method === "HEAD" && body) {
        void body.cancel().catch(() => {});
        body = null;
      }
      return {
        status: response.status,
        headers: responseHeaders(response),
        body,
      };
    },
    wsOpen: async (request, signal) => {
      let upgraded = false;
      let data: unknown;
      const req = requestOf(request, null, signal, scheme);
      const response = await options.fetch(
        req,
        serverFor(request.ctx, (_req, upgrade) => {
          if (upgraded) return false;
          upgraded = true;
          data = upgrade?.data;
          return true;
        }),
      );
      if (!upgraded) {
        if (!response)
          return { accepted: false, status: 500, headers: [], body: "" };
        return {
          accepted: false,
          status: response.status,
          headers: responseHeaders(response),
          body: await response.text(),
        };
      }
      const transport = pathnameOf(request.url) === "/ws" ? "ws" : "raw";
      const vws = new VirtualSocket(
        request.socket_id,
        transport,
        data,
        request.ctx.client_ip ?? "",
        link,
      );
      if (transport === "ws")
        setRemoteWebSocketFlow(vws, {
          send: (payload, context, key) =>
            channel.send({
              t: "ws_send",
              socket_id: vws.socketId,
              data: payload,
              binary: false,
              context,
              ...(key !== undefined ? { key } : {}),
            }),
          drop: (key) =>
            channel.send({ t: "ws_drop", socket_id: vws.socketId, key }),
        });
      sockets.get(request.socket_id)?.finish(1006, "");
      sockets.set(request.socket_id, vws);
      try {
        settle(handlers.open?.(asWs(vws)), failed("open"));
      } catch (error) {
        failed("open")((error as Error).message);
      }
      return { accepted: true, transport };
    },
    socket: (message) => {
      const vws = sockets.get(Number(message.socket_id));
      if (!vws) return;
      if (message.t === "ws_message") {
        if (vws.readyState !== 1) return;
        const text = typeof message.data === "string" ? message.data : "";
        const data = message.binary ? Buffer.from(text, "base64") : text;
        try {
          settle(handlers.message?.(asWs(vws), data), failed("message"));
        } catch (error) {
          failed("message")((error as Error).message);
        }
      } else if (message.t === "ws_close") {
        vws.finish(
          typeof message.code === "number" ? message.code : 1005,
          typeof message.reason === "string" ? message.reason : "",
        );
      }
    },
    control: (message) => {
      if (message.t === "welcome") {
        log("info", "the front welcomed this core");
        options.onWelcome?.();
      } else if (message.t === "refused")
        log("warn", `the front refused this core: ${String(message.reason)}`);
      else if (message.t === "bye") channel.close();
    },
    close: (error) => {
      for (const vws of [...sockets.values()]) vws.finish(1006, "");
      options.onClose(error);
    },
    log: (level, message) => log(level, message),
  });
  channel.send({
    t: "hello",
    protocol: PROTOCOL,
    token: options.token,
    side: "bun",
    version: options.version,
    pid: options.pid ?? process.pid,
    families: options.families ?? sidecarFamilies(),
    test: false,
  });
  return { channel, sockets };
}
