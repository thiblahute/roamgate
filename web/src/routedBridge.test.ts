import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bridge, type ConnectionStatus, type TerminalPush } from "./api";
import { routeHttpUrl, setHttpRouter } from "./httpRoute";
import { nodeServesEvent, nodeServesMethod } from "./nodeRouting";
import { type HomeProbe, RoutedBridge } from "./routedBridge";

const HOME = "https://home.example.ts.net";
const PAGE = "https://mac.example.ts.net";

type Sent = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  connection_id?: string;
  connection_generation?: number;
};

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  bufferedAmount = 0;
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string) {
    const message = JSON.parse(data);
    if ("ack" in message) return;
    this.sent.push(message);
    if (message.method === "bridge.ping")
      this.receive({ id: message.id, result: {} });
  }

  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  hello(node?: Record<string, unknown>) {
    this.receive({
      hello: true,
      bridge_protocol_version: 2,
      default_connection_id: node ? "local" : "desktop",
      capabilities: {
        connection_id: true,
        connection_runtime_generation: true,
      },
      ...(node ? { node } : {}),
    });
  }

  /** The last call of `method` sent on this socket. */
  last(method: string): Sent | undefined {
    const calls = this.sent.filter((call) => call.method === method);
    return calls[calls.length - 1];
  }

  reply(method: string, result: unknown) {
    const call = this.last(method);
    if (!call) throw new Error(`no ${method} on ${this.url}`);
    this.receive({
      id: call.id,
      result,
      ...(call.connection_id === undefined
        ? {}
        : {
            connection_id: call.connection_id,
            connection_generation: call.connection_generation,
          }),
    });
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const created: RoutedBridge[] = [];
let fetched: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  FakeSocket.all = [];
  fetched = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetched.push({ url, init });
    return new Response("{}");
  }) as unknown as typeof fetch;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "mac.example.ts.net", origin: PAGE },
  });
});

afterEach(() => {
  for (const bridge of created.splice(0)) bridge.disconnect();
  setHttpRouter(null);
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
});

function routed(probe: HomeProbe = async () => "unreachable") {
  const bridge = new RoutedBridge(
    (options) => new Bridge(60_000, 60_000, options),
    probe,
    () => PAGE,
  );
  created.push(bridge);
  return bridge;
}

/** Sends a call whose answer the test does not wait for. */
const fire = (call: Promise<unknown>) => void call.catch(() => {});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A node page with both sockets up and both catalogs read. */
async function nodePage(probe?: HomeProbe) {
  const bridge = routed(probe);
  const statuses: ConnectionStatus[] = [];
  bridge.onStatus((status) => statuses.push(status));
  const moved: string[] = [];
  bridge.onRuntimeMoved((id) => moved.push(id));
  bridge.connect();
  const node = FakeSocket.all[0]!;
  node.hello({ home: HOME, connection_id: "local", version: "1.0.0" });
  const home = FakeSocket.all[1]!;
  node.reply("connections.list", {
    connections: [{ id: "local", generation: 7 }],
  });
  await flush();
  home.hello();
  const catalog = bridge.call("connections.list");
  home.reply("connections.list", {
    default_connection_id: "desktop",
    connections: [
      { id: "desktop", generation: 5 },
      { id: "local", generation: 3 },
    ],
  });
  const result = await catalog;
  bridge.setConnectionRuntimeGenerations(result.connections);
  const local = result.connections.find(
    (entry: { id: string }) => entry.id === "local",
  ).generation;
  return { bridge, node, home, statuses, moved, local, result };
}

describe("a page no node served", () => {
  test("is the one socket's bridge, unchanged", async () => {
    const bridge = routed();
    const hellos: unknown[] = [];
    bridge.onHello((hello) => hellos.push(hello));
    bridge.connect();
    const socket = FakeSocket.all[0]!;
    expect(socket.url).toBe("wss://mac.example.ts.net/ws");
    socket.hello();
    expect(FakeSocket.all).toHaveLength(1);
    expect(bridge.status).toBe("connected");
    expect(bridge.hello?.default_connection_id).toBe("desktop");
    expect(hellos).toHaveLength(1);
    expect(bridge.nodeHome).toBeNull();
    const catalog = bridge.call("connections.list");
    socket.reply("connections.list", {
      connections: [{ id: "desktop", generation: 5 }],
    });
    expect((await catalog).connections[0].generation).toBe(5);
    bridge.setConnectionRuntimeGenerations([{ id: "desktop", generation: 5 }]);
    fire(bridge.connection("desktop", 5).call("terminal.input", {}));
    expect(socket.last("terminal.input")?.connection_generation).toBe(5);
    expect(routeHttpUrl("/api/history")).toBe("/api/history");
  });
});

describe("a node page", () => {
  test("opens the home's socket and shows the home's hello on the node's connection", async () => {
    const { bridge, home, statuses, result } = await nodePage();
    expect(home.url).toBe("wss://home.example.ts.net/ws");
    expect(statuses).toEqual(["disconnected", "connecting", "connected"]);
    expect(bridge.hello?.default_connection_id).toBe("local");
    expect(result.default_connection_id).toBe("local");
    expect(bridge.nodeHome).toEqual({
      home: HOME,
      connectionId: "local",
      reach: "ok",
    });
  });

  test("sends the node's families of its connection to the node, at the node's generation", async () => {
    const { bridge, node, home, local } = await nodePage();
    expect(bridge.setActiveConnection("local")).toBe(bridge.clientGeneration);
    const client = bridge.connection("local", local);
    expect(client.isCurrent()).toBe(true);
    fire(client.call("terminal.input", { data: "x" }));
    expect(node.last("terminal.input")).toMatchObject({
      connection_id: "local",
      connection_generation: 7,
    });
    fire(client.call("git.commit", {}));
    expect(home.last("git.commit")).toMatchObject({
      connection_id: "local",
      connection_generation: 3,
    });
    expect(node.last("git.commit")).toBeUndefined();
    fire(bridge.readConnection("local", "pane.list"));
    expect(node.last("pane.list")?.connection_generation).toBe(7);
    fire(bridge.callConnection("local", "review.get", {}));
    expect(home.last("review.get")?.connection_generation).toBe(3);
  });

  test("sends other connections and shared calls to the home", async () => {
    const { bridge, node, home } = await nodePage();
    bridge.setActiveConnection("desktop");
    fire(bridge.connection("desktop", 5).call("terminal.input", {}));
    expect(home.last("terminal.input")?.connection_generation).toBe(5);
    fire(bridge.call("bridge.work.list", {}));
    expect(home.last("bridge.work.list")).toBeDefined();
    expect(node.last("bridge.work.list")).toBeUndefined();
  });

  test("takes the node's families' pushes from the node, at the page's generation", async () => {
    const { bridge, node, home, local } = await nodePage();
    const terminals: TerminalPush[] = [];
    const events: string[] = [];
    const work: unknown[] = [];
    bridge.onTerminal((push) => terminals.push(push));
    bridge.onEvent((push) =>
      events.push(`${push.event}@${push.connection_generation}`),
    );
    bridge.onWork((push) => work.push(push));
    const terminal = {
      terminal_id: "t",
      width: 1,
      height: 1,
      full: true,
      bytes: "",
    };
    node.receive({
      connection_id: "local",
      connection_generation: 7,
      terminal,
    });
    home.receive({
      connection_id: "local",
      connection_generation: 3,
      terminal,
    });
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.connection_generation).toBe(local);
    node.receive({
      connection_id: "local",
      connection_generation: 7,
      event: "pane.created",
      data: {},
    });
    home.receive({
      connection_id: "local",
      connection_generation: 3,
      event: "pane.created",
      data: {},
    });
    home.receive({
      connection_id: "local",
      connection_generation: 3,
      event: "agent_chat.delta",
      data: {},
    });
    node.receive({
      connection_id: "local",
      connection_generation: 7,
      event: "agent_chat.delta",
      data: {},
    });
    home.receive({
      connection_id: "desktop",
      connection_generation: 5,
      event: "pane.created",
      data: {},
    });
    expect(events).toEqual([
      `pane.created@${local}`,
      `agent_chat.delta@${local}`,
      "pane.created@5",
    ]);
    const push = { changed: ["items"], by: "user" };
    node.receive({ work: push });
    home.receive({ work: push });
    expect(work).toHaveLength(1);
  });

  test("falls back to the home for the node's connection while the node's socket is down, and back", async () => {
    const { bridge, node, home, moved, local } = await nodePage();
    bridge.setActiveConnection("local");
    const terminals: Array<number | undefined> = [];
    bridge.onTerminal((push) => terminals.push(push.connection_generation));
    node.close();
    expect(bridge.status).toBe("connected");
    expect(moved).toEqual(["local"]);
    // The page's held generation is gone: its calls fail until it re-reads.
    expect(bridge.connection("local", local).isCurrent()).toBe(false);
    const catalog = bridge.call("connections.list");
    home.reply("connections.list", {
      connections: [{ id: "local", generation: 3 }],
    });
    const fallback = (await catalog).connections[0].generation;
    expect(fallback).toBeGreaterThan(local);
    bridge.setConnectionRuntimeGenerations([
      { id: "local", generation: fallback },
    ]);
    fire(bridge.connection("local", fallback).call("terminal.input", {}));
    expect(home.last("terminal.input")?.connection_generation).toBe(3);
    const terminal = {
      terminal_id: "t",
      width: 1,
      height: 1,
      full: true,
      bytes: "",
    };
    home.receive({
      connection_id: "local",
      connection_generation: 3,
      terminal,
    });
    expect(terminals).toEqual([fallback]);

    // The node returns (the bridge reconnects it).
    bridge.connect();
    const again = FakeSocket.all[FakeSocket.all.length - 1]!;
    expect(again.url).toBe("wss://mac.example.ts.net/ws");
    again.hello({ home: HOME, connection_id: "local", version: "1.0.0" });
    again.reply("connections.list", {
      connections: [{ id: "local", generation: 8 }],
    });
    await flush();
    expect(moved).toEqual(["local", "local"]);
    const back = bridge.call("connections.list");
    home.reply("connections.list", {
      connections: [{ id: "local", generation: 3 }],
    });
    const returned = (await back).connections[0].generation;
    expect(returned).toBeGreaterThan(fallback);
    bridge.setConnectionRuntimeGenerations([
      { id: "local", generation: returned },
    ]);
    fire(bridge.connection("local", returned).call("terminal.input", {}));
    expect(again.last("terminal.input")?.connection_generation).toBe(8);
  });

  test("keeps serving the node's connection from the node while the home is down, without sending the home's calls", async () => {
    const { bridge, node, home, statuses } = await nodePage();
    bridge.setActiveConnection("local");
    statuses.length = 0;
    const before = bridge.clientGeneration;
    home.close();
    expect(statuses).toEqual(["disconnected", "connected"]);
    expect(bridge.clientGeneration).toBeGreaterThan(before);
    expect(bridge.hello?.default_connection_id).toBe("local");
    const catalog = bridge.call("connections.list");
    node.reply("connections.list", {
      connections: [{ id: "local", generation: 7 }],
    });
    const generation = (await catalog).connections[0].generation;
    bridge.setConnectionRuntimeGenerations([{ id: "local", generation }]);
    fire(bridge.connection("local", generation).call("terminal.input", {}));
    expect(node.last("terminal.input")?.connection_generation).toBe(7);
    await expect(bridge.call("bridge.work.list", {})).rejects.toMatchObject({
      code: "home_unreachable",
    });
    await expect(
      bridge.connection("local", generation).call("git.commit", {}),
    ).rejects.toThrow();
    expect(node.last("bridge.work.list")).toBeUndefined();
    expect(node.last("git.commit")).toBeUndefined();
  });

  test("offers the home's sign-in when its socket is refused and the home answers", async () => {
    const bridge = routed(async () => "signin");
    const reaches: string[] = [];
    bridge.onNodeHome((state) => reaches.push(state.reach));
    bridge.connect();
    const node = FakeSocket.all[0]!;
    node.hello({ home: HOME, connection_id: "local", version: "1.0.0" });
    FakeSocket.all[1]!.close(1006);
    await flush();
    expect(reaches).toEqual(["connecting", "signin"]);
    expect(bridge.nodeHome?.reach).toBe("signin");
  });

  test("a logout on the home asks to sign in there, and leaves the node page", async () => {
    const { bridge, home } = await nodePage();
    home.close(4001);
    expect(bridge.nodeHome?.reach).toBe("signin");
  });

  test("routes HTTP paths to the node or the home", async () => {
    const { bridge, local } = await nodePage();
    expect(
      routeHttpUrl(
        `/api/connections/local/file?connection_generation=${local}`,
      ),
    ).toBe("/api/connections/local/file?connection_generation=7");
    expect(
      routeHttpUrl("/api/connections/desktop/file?connection_generation=5"),
    ).toBe(`${HOME}/api/connections/desktop/file?connection_generation=5`);
    expect(routeHttpUrl("/api/history")).toBe(`${HOME}/api/history`);
    expect(routeHttpUrl("/api/health")).toBe("/api/health");
    expect(routeHttpUrl("/assets/app.js")).toBe("/assets/app.js");
    await fetch("/api/history");
    await fetch("/api/health", { credentials: "same-origin" });
    expect(fetched[0]).toMatchObject({
      url: `${HOME}/api/history`,
      init: { credentials: "include" },
    });
    expect(fetched[1]).toMatchObject({
      url: "/api/health",
      init: { credentials: "same-origin" },
    });
    expect(bridge.routeHttp("/api/connections/local/raw")).toBe(
      "/api/connections/local/raw",
    );
  });
});

describe("the routing table", () => {
  test("serves terminals, Herdr, files, git reads and agent session reads from the node", () => {
    for (const method of [
      "terminal.attach",
      "terminal.input",
      "pane.list",
      "tab.create",
      "workspace.focus",
      "file.read",
      "git.diff_files",
      "git.refs",
      "agent.list",
      "agent_session.get",
      "agent_history.subscribe",
      "popup.close",
    ])
      expect(nodeServesMethod(method)).toBe(true);
    for (const method of [
      "git.commit",
      "git.pull",
      "worktree.open",
      "agent_chat.send",
      "agent_profile.launch",
      "forward.open",
      "review.get",
      "settings.get",
    ])
      expect(nodeServesMethod(method)).toBe(false);
  });

  test("takes Herdr events from the node and the home's own events from the home", () => {
    expect(nodeServesEvent("pane.created")).toBe(true);
    expect(nodeServesEvent("workspace.git_status")).toBe(true);
    expect(nodeServesEvent("agent_history.changed")).toBe(true);
    expect(nodeServesEvent("agent_chat.delta")).toBe(false);
    expect(nodeServesEvent("roamgate.task_notification")).toBe(false);
    expect(nodeServesEvent("worktree.created")).toBe(false);
  });
});
