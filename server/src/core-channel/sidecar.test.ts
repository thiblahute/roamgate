import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropCoalescedMessage,
  flushCoalescedMessages,
  receiveWebSocketAck,
  sendWebSocketMessage,
} from "../bridge/websocket-send";
import {
  Channel,
  type ChannelHandlers,
  type ChannelHttpResponse,
  type Message,
} from "./channel";
import { FAMILIES, PROTOCOL } from "./protocol";
import {
  type SidecarFetch,
  type SidecarWebSocket,
  sidecarFamilies,
  startSidecar,
  type VirtualSocket,
} from "./sidecar";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** What the front received, and a wait for the next message that matches. */
class Inbox {
  readonly messages: Message[] = [];
  private waiters: {
    match: (message: Message) => boolean;
    resolve: (message: Message) => void;
  }[] = [];

  add = (message: Message) => {
    this.messages.push(message);
    const waiter = this.waiters.find((w) => w.match(message));
    if (!waiter) return;
    this.waiters = this.waiters.filter((w) => w !== waiter);
    waiter.resolve(message);
  };

  next(match: (message: Message) => boolean): Promise<Message> {
    const seen = this.messages.find(match);
    if (seen) {
      this.messages.splice(this.messages.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve) =>
      this.waiters.push({
        match,
        resolve: (message) => {
          this.messages.splice(this.messages.indexOf(message), 1);
          resolve(message);
        },
      }),
    );
  }
}

/** A front listening on a Unix socket: its channel once the core connects. */
async function listen(handlers: ChannelHandlers = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-test-"));
  const path = join(dir, "core.sock");
  const inbox = new Inbox();
  let server: Server | null = null;
  const front = new Promise<Channel>((resolve) => {
    server = createServer((socket: Socket) => {
      resolve(
        new Channel(socket, {
          ...handlers,
          socket: inbox.add,
          control: inbox.add,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(path, resolve));
  cleanups.push(() => {
    server!.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, front, inbox };
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts)
        controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

/** A forwarded response's body, to read. */
function bodyOf(response: ChannelHttpResponse): Response {
  return new Response(response.body as ReadableStream<Uint8Array> | null);
}

/** A Bun core with the given fetch and WebSocket handlers. */
async function core(
  fetch: SidecarFetch,
  websocket: SidecarWebSocket<VirtualSocket> = {},
) {
  const { path, front, inbox } = await listen();
  const closed = Promise.withResolvers<Error | null>();
  const sidecar = await startSidecar<VirtualSocket>({
    path,
    token: "a".repeat(64),
    version: "9.9.9",
    pid: 4242,
    families: ["alpha"],
    fetch,
    websocket,
    onClose: (error) => closed.resolve(error),
  });
  const channel = await front;
  cleanups.push(() => {
    channel.destroy();
    sidecar.channel.destroy();
  });
  return { front: channel, inbox, sidecar, closed: closed.promise };
}

const head = (
  url: string,
  headers: [string, string][] = [],
  method = "GET",
) => ({
  method,
  url,
  headers: [["host", "front.example:8787"], ...headers] as [string, string][],
  ctx: { client_ip: "100.64.0.7", session_id: "0123456789abcdef" },
});

describe("the Bun core's channel", () => {
  test("says hello as the Bun side, with its families", async () => {
    const { inbox } = await core(() => new Response("x"));
    const hello = await inbox.next((m) => m.t === "hello");
    expect(hello).toEqual({
      t: "hello",
      protocol: PROTOCOL,
      token: "a".repeat(64),
      side: "bun",
      version: "9.9.9",
      pid: 4242,
      families: ["alpha"],
      test: false,
    });
  });

  test("serves every family but the test one by default", () => {
    const families = sidecarFamilies();
    expect(families).toContain("settings");
    expect(families).not.toContain("test.echo");
    expect(families.length).toBe(Object.keys(FAMILIES).length - 1);
  });

  test("ends when the front closes the channel", async () => {
    const { front, closed } = await core(() => new Response("x"));
    front.close();
    expect(await closed).toBeNull();
  });
});

describe("http from the front", () => {
  test("runs the fetch handler on the browser's request, bodies streamed both ways", async () => {
    let seen: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      ip: string | undefined;
    } | null = null;
    const { front } = await core(async (req, server) => {
      seen = {
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
        ip: server.requestIP(req)?.address,
      };
      server.timeout(req, 60);
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(streamOf(["one ", "two ", "three"]), {
        status: 201,
        headers,
      });
    });
    const response = await front.http({
      ...head("/api/thing?x=1", [["cookie", "s=1"]], "POST"),
      body: streamOf(["he", "llo"]),
    });
    expect(response.status).toBe(201);
    expect(response.headers).toContainEqual(["content-type", "text/plain"]);
    expect(response.headers.filter(([name]) => name === "set-cookie")).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(await bodyOf(response).text()).toBe("one two three");
    expect(seen!).toEqual({
      url: "http://front.example:8787/api/thing?x=1",
      method: "POST",
      headers: {
        host: "front.example:8787",
        cookie: "s=1",
      },
      body: "hello",
      ip: "100.64.0.7",
    });
  });

  test("a request never upgrades, and a HEAD answer has no body", async () => {
    const { front } = await core((req, server) => {
      if (server.upgrade(req, { data: {} })) return undefined;
      return new Response("not upgraded", { status: 400 });
    });
    const refused = await front.http({ ...head("/ws"), body: null });
    expect(refused.status).toBe(400);
    expect(await bodyOf(refused).text()).toBe("not upgraded");
    const { front: other } = await core(
      () => new Response("body", { headers: { "x-a": "1" } }),
    );
    const response = await other.http({
      ...head("/x", [], "HEAD"),
      body: null,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });
});

describe("virtual sockets", () => {
  const routes: SidecarFetch = (req, server) => {
    const url = new URL(req.url);
    if (req.headers.get("origin") === "null")
      return new Response("forbidden", {
        status: 403,
        headers: { "x-why": "origin" },
      });
    if (url.pathname === "/ws" || url.pathname === "/api/notifications/ws")
      if (server.upgrade(req, { data: { path: url.pathname } }))
        return undefined;
    return new Response("websocket upgrade failed", { status: 400 });
  };

  test("ws_open runs the routing: a refusal is the response, as text", async () => {
    const { front } = await core(routes);
    expect(
      await front.wsOpen({
        socket_id: 3,
        ...head("/ws", [["origin", "null"]]),
      }),
    ).toEqual({
      accepted: false,
      status: 403,
      headers: [["x-why", "origin"]],
      body: "forbidden",
    });
  });

  test("an accepted /ws socket opens, sends through the front's flow and closes once", async () => {
    const opened: VirtualSocket[] = [];
    const received: (string | Buffer)[] = [];
    const closes: [number, string][] = [];
    const cleanup: string[] = [];
    const options = (key?: string) => ({
      cleanup: () => cleanup.push("cleanup"),
      context: "terminal-frame",
      ...(key ? { coalesceKey: key } : {}),
    });
    const { front, inbox, sidecar } = await core(routes, {
      open(ws) {
        opened.push(ws);
        sendWebSocketMessage(ws, '{"hello":true}', { cleanup: () => {} });
      },
      message(ws, message) {
        received.push(message);
        if (typeof message === "string" && message.startsWith('{"ack":'))
          return void receiveWebSocketAck(ws, message, options());
        const text =
          typeof message === "string" ? message : [...message].join(",");
        sendWebSocketMessage(ws, `echo ${text}`, options("t1"));
      },
      close(_ws, code, reason) {
        closes.push([code, reason]);
      },
    });
    expect(await front.wsOpen({ socket_id: 7, ...head("/ws") })).toEqual({
      accepted: true,
      transport: "ws",
    });
    // open's send went out before the reply.
    expect(await inbox.next((m) => m.t === "ws_send")).toEqual({
      t: "ws_send",
      socket_id: 7,
      data: '{"hello":true}',
      binary: false,
      context: "message",
    });
    const ws = opened[0]!;
    expect(ws.data).toEqual({ path: "/ws" });
    expect(ws.remoteAddress).toBe("100.64.0.7");
    expect(ws.readyState).toBe(1);
    expect(ws.getBufferedAmount()).toBe(0);
    expect(sidecar.sockets.get(7)).toBe(ws);

    front.send({ t: "ws_message", socket_id: 7, data: "hi", binary: false });
    expect(await inbox.next((m) => m.t === "ws_send")).toEqual({
      t: "ws_send",
      socket_id: 7,
      data: "echo hi",
      binary: false,
      context: "terminal-frame",
      key: "t1",
    });
    front.send({
      t: "ws_message",
      socket_id: 7,
      data: Buffer.from([1, 2, 3]).toString("base64"),
      binary: true,
    });
    await inbox.next((m) => m.t === "ws_send" && m.data === "echo 1,2,3");
    expect(Buffer.isBuffer(received[1])).toBe(true);
    expect([...(received[1] as Buffer)]).toEqual([1, 2, 3]);

    // The front's flow: no ack handling, flush or held messages here.
    front.send({
      t: "ws_message",
      socket_id: 7,
      data: '{"ack":100}',
      binary: false,
    });
    dropCoalescedMessage(ws, "t1");
    expect(await inbox.next((m) => m.t === "ws_drop")).toEqual({
      t: "ws_drop",
      socket_id: 7,
      key: "t1",
    });
    flushCoalescedMessages(ws, { cleanup: () => {} });

    front.send({ t: "ws_close", socket_id: 7, code: 1001, reason: "away" });
    front.send({ t: "ws_close", socket_id: 7, code: 1001, reason: "away" });
    front.send({ t: "ws_message", socket_id: 7, data: "late", binary: false });
    // A round trip after them: they were handled.
    expect(await front.wsOpen({ socket_id: 8, ...head("/ws") })).toMatchObject({
      accepted: true,
    });
    expect(closes).toEqual([[1001, "away"]]);
    expect(ws.readyState).toBe(3);
    expect(sidecar.sockets.has(7)).toBe(false);
    expect(received).toHaveLength(3);
    // A send after the close is skipped as today.
    expect(sendWebSocketMessage(ws, "x", options())).toBe(false);
    expect(cleanup).toEqual(["cleanup"]);
    expect(ws.send("x")).toBe(0);
  });

  test("a raw socket sends as it is; the core's close is a ws_end", async () => {
    let socket: VirtualSocket | null = null;
    const closes: [number, string][] = [];
    const pongs: number[] = [];
    const { front, inbox } = await core(routes, {
      open(ws) {
        socket = ws;
      },
      pong() {
        pongs.push(1);
      },
      close(_ws, code, reason) {
        closes.push([code, reason]);
      },
    });
    expect(
      await front.wsOpen({
        socket_id: 11,
        ...head("/api/notifications/ws"),
      }),
    ).toEqual({ accepted: true, transport: "raw" });
    const ws = socket!;
    ws.send("text");
    ws.send(new Uint8Array([255, 0]));
    expect(await inbox.next((m) => m.t === "ws_send")).toEqual({
      t: "ws_send",
      socket_id: 11,
      data: "text",
      binary: false,
    });
    expect(await inbox.next((m) => m.t === "ws_send")).toEqual({
      t: "ws_send",
      socket_id: 11,
      data: Buffer.from([255, 0]).toString("base64"),
      binary: true,
    });
    // The front pings the browser: the core's heartbeat sees it answer.
    ws.ping();
    await Promise.resolve();
    expect(pongs).toEqual([1]);

    ws.close(4001, "Logged out");
    ws.close(4001, "Logged out");
    expect(await inbox.next((m) => m.t === "ws_end")).toEqual({
      t: "ws_end",
      socket_id: 11,
      code: 4001,
      reason: "Logged out",
    });
    front.send({ t: "ws_close", socket_id: 11, code: 1005, reason: "" });
    await front.wsOpen({ socket_id: 12, ...head("/ws") });
    expect(closes).toEqual([[4001, "Logged out"]]);
    expect(ws.readyState).toBe(3);
    expect(inbox.messages.filter((m) => m.t === "ws_end")).toEqual([]);
  });

  test("a closing channel closes the sockets", async () => {
    const closes: [number, string][] = [];
    const { front, closed } = await core(routes, {
      close(_ws, code, reason) {
        closes.push([code, reason]);
      },
    });
    await front.wsOpen({ socket_id: 1, ...head("/ws") });
    front.close();
    await closed;
    expect(closes).toEqual([[1006, ""]]);
  });
});

describe("the server as a Rust front's core", () => {
  test("opens no port, serves the front's requests and sockets, and ends with the channel", async () => {
    const { path, front: accepted, inbox } = await listen();
    const root = mkdtempSync(join(tmpdir(), "sidecar-process-"));
    const token = "b".repeat(64);
    const password = "sidecar-test-secret";
    const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
      cwd: join(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOME: root,
        APPDATA: root,
        XDG_CONFIG_HOME: root,
        XDG_DATA_HOME: join(root, "data"),
        HOST: "127.0.0.1",
        PORT: "0",
        OPEN_BROWSER: "0",
        ROAMGATE_PASSWORD: password,
        ROAMGATE_PIN: "",
        HERDR_GUI_PIN: "",
        ROAMGATE_CONNECTIONS_PATH: join(root, "connections.json"),
        ROAMGATE_SETTINGS_PATH: join(root, "settings.json"),
        HERDR_SOCKET_PATH: join(root, "missing-control.sock"),
        HERDR_CLIENT_SOCKET_PATH: join(root, "missing-render.sock"),
        HERDR_SSH_HOST: "",
        HERDR_SESSION: "",
        ROAMGATE_TLS_CERT: "",
        ROAMGATE_TLS_KEY: "",
        ROAMGATE_CORE_BIN: "",
        ROAMGATE_CORE_CHANNEL: path,
        ROAMGATE_CORE_TOKEN: token,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    const outputDone = Promise.all(
      [child.stdout, child.stderr].map(async (stream) => {
        for await (const chunk of stream)
          output += new TextDecoder().decode(chunk);
      }),
    );
    cleanups.push(async () => {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    });
    const front = await accepted;
    const hello = await inbox.next((m) => m.t === "hello");
    expect(hello).toMatchObject({
      protocol: PROTOCOL,
      token,
      side: "bun",
      pid: child.pid,
      families: sidecarFamilies(),
      test: false,
    });
    front.send({
      t: "welcome",
      protocol: PROTOCOL,
      side: "rust",
      owners: {},
      shadow: { enabled: false, rate: 0 },
    });

    // The gate is the core's: a login over the channel, its cookie after.
    const unauthorized = await front.http({
      ...head("/api/health"),
      body: null,
    });
    expect(unauthorized.status).toBe(401);
    await bodyOf(unauthorized).text();
    const login = await front.http({
      ...head("/api/login", [["content-type", "application/json"]], "POST"),
      body: streamOf([JSON.stringify({ password })]),
    });
    expect(login.status).toBe(200);
    await bodyOf(login).text();
    const cookie = login.headers
      .find(([name]) => name === "set-cookie")![1]
      .split(";", 1)[0]!;
    const health = await front.http({
      ...head("/api/health", [["cookie", cookie]]),
      body: null,
    });
    expect(health.status).toBe(200);
    expect(await bodyOf(health).json()).toMatchObject({
      ok: true,
      auth_required: true,
    });

    // A socket from a sandboxed page is refused by the core's routing.
    expect(
      await front.wsOpen({
        socket_id: 1,
        ...head("/ws", [
          ["cookie", cookie],
          ["origin", "null"],
        ]),
      }),
    ).toMatchObject({ accepted: false, status: 403, body: "forbidden" });

    expect(
      await front.wsOpen({
        socket_id: 2,
        ...head("/ws", [["cookie", cookie]]),
      }),
    ).toEqual({ accepted: true, transport: "ws" });
    const greeting = await inbox.next((m) => m.t === "ws_send");
    expect(greeting).toMatchObject({ socket_id: 2, context: "hello" });
    expect(JSON.parse(String(greeting.data))).toMatchObject({ hello: true });

    front.send({
      t: "ws_message",
      socket_id: 2,
      data: JSON.stringify({ id: "p1", method: "bridge.ping" }),
      binary: false,
    });
    const pong = await inbox.next(
      (m) => m.t === "ws_send" && String(m.data).includes('"p1"'),
    );
    expect(pong).toMatchObject({ socket_id: 2, context: "bridge-ping" });
    expect(JSON.parse(String(pong.data))).toEqual({
      id: "p1",
      result: { ok: true },
    });

    front.send({ t: "ws_close", socket_id: 2, code: 1001, reason: "" });
    // Its close ran: a logout closes no socket of that login any more.
    const logout = await front.http({
      ...head(
        "/api/logout",
        [
          ["cookie", cookie],
          ["x-roamgate-logout", "1"],
        ],
        "POST",
      ),
      body: null,
    });
    expect(logout.status).toBe(204);

    front.close();
    expect(await child.exited).toBe(0);
    await outputDone;
    expect(output).not.toContain("INFO bridge listening");
    expect(output).toContain("serving a Rust front");
    expect(inbox.messages.filter((m) => m.t === "ws_end")).toEqual([]);
  }, 30_000);
});
