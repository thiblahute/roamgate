/**
 * A minimal browser stand-in for the benchmark: logs in, opens /ws, speaks
 * the bridge's RPC and acknowledges like the web client (flow control and
 * chunk reassembly as in web/src/api.ts), and counts what it receives.
 */

export async function login(base: string, password: string): Promise<string> {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password }),
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!response.ok || !cookie.includes("="))
    throw new Error(`login failed: ${response.status}`);
  return cookie;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const CHUNK_MARKER = 1;
// The web client's constants (web/src/api.ts).
const FLOW_ACK_DELAY_MS = 100;
const FLOW_ACK_CHARS = 32 * 1024;

export class BenchClient {
  ws!: WebSocket;
  hello: Record<string, unknown> | null = null;
  /** Characters (UTF-16 code units) of text frames received. */
  received = 0;
  frames = 0;
  private reported = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private flowControl = false;
  private chunks = new Map<string, string[]>();
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<
    (message: Record<string, unknown>, at: number) => void
  >();
  private helloWaiters: ((hello: Record<string, unknown>) => void)[] = [];

  constructor(
    private readonly base: string,
    private readonly cookie: string,
    private readonly options: { ack?: boolean; connectionId?: string } = {},
  ) {}

  /** perMessageDeflate false: offer no compression (Bun offers it by default). */
  async open(
    options: { perMessageDeflate?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const url = `${this.base.replace(/^http/, "ws")}/ws`;
    this.ws = new WebSocket(url, {
      headers: { cookie: this.cookie, origin: this.base },
      ...(options.perMessageDeflate === false
        ? { perMessageDeflate: false }
        : {}),
    } as unknown as string[]);
    const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.helloWaiters.push(resolve);
      this.ws.onerror = () => reject(new Error("websocket error"));
      this.ws.onclose = (event) =>
        reject(new Error(`websocket closed ${event.code} ${event.reason}`));
    });
    this.ws.onmessage = (event) => this.receive(String(event.data));
    const result = await hello;
    this.ws.onclose = () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("websocket closed"));
      this.pending.clear();
    };
    return result;
  }

  on(listener: (message: Record<string, unknown>, at: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    connectionId = this.options.connectionId,
  ): Promise<T> {
    const id = `b${++this.sequence}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    this.ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(connectionId ? { connection_id: connectionId } : {}),
      }),
    );
    return promise;
  }

  close() {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ws.close();
  }

  private receive(data: string) {
    const at = performance.now();
    this.frames += 1;
    this.received += data.length;
    this.scheduleAck();
    let text: string | null = data;
    if (data.charCodeAt(0) === CHUNK_MARKER) {
      const idEnd = data.indexOf(":", 1);
      if (idEnd < 0 || data[idEnd + 2] !== ":") return;
      const id = data.slice(1, idEnd);
      const last = data[idEnd + 1] === "1";
      const part = data.slice(idEnd + 3);
      const parts = this.chunks.get(id);
      if (!last) {
        if (parts) parts.push(part);
        else this.chunks.set(id, [part]);
        return;
      }
      this.chunks.delete(id);
      text = parts ? parts.join("") + part : part;
    }
    const message = JSON.parse(text) as Record<string, unknown>;
    if (message.hello === true && !this.hello) {
      this.hello = message;
      const capabilities = message.capabilities as Record<string, unknown>;
      this.flowControl =
        this.options.ack !== false && capabilities?.flow_control === true;
      this.sendAck();
      for (const waiter of this.helloWaiters.splice(0)) waiter(message);
    }
    const id = typeof message.id === "string" ? message.id : null;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      if (message.error !== undefined && message.error !== null)
        pending.reject(new Error(JSON.stringify(message.error).slice(0, 300)));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message, at);
  }

  private scheduleAck() {
    if (!this.flowControl) return;
    if (this.received - this.reported >= FLOW_ACK_CHARS) {
      this.sendAck();
      return;
    }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.sendAck();
    }, FLOW_ACK_DELAY_MS);
  }

  private sendAck() {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (!this.flowControl || this.reported === this.received) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.reported = this.received;
    this.ws.send(`{"ack":${this.received}}`);
  }
}

/**
 * A TCP relay in front of the server that counts the bytes each way: the
 * wire cost of a session, after WebSocket compression.
 */
export async function byteCounter(targetPort: number) {
  const net = await import("node:net");
  const counts = { up: 0, down: 0 };
  const sockets = new Set<import("node:net").Socket>();
  const server = net.createServer((client) => {
    const upstream = net.createConnection({
      host: "127.0.0.1",
      port: targetPort,
    });
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (chunk) => {
      counts.up += Buffer.byteLength(chunk);
    });
    upstream.on("data", (chunk) => {
      counts.down += Buffer.byteLength(chunk);
    });
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    port,
    counts,
    reset() {
      counts.up = 0;
      counts.down = 0;
    },
    stop() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
