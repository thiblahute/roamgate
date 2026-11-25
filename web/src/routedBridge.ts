import type {
  AssistantSnapshot,
  AssistantTaskNotification,
} from "../../shared/assistant";
import type { MrCachePush } from "../../shared/forge";
import type { MrReviewsPush } from "../../shared/mrReviews";
import type { ReviewPush } from "../../shared/review";
import type { WorkPush } from "../../shared/work";
import type {
  AssistantDeltaPush,
  Bridge,
  BridgeControlMsg,
  BridgeHello,
  BridgeSocketOptions,
  ConnectionClient,
  ConnectionStatus,
  ConnectionSummary,
  ForwardRecord,
  HerdrEventMsg,
  PopupStatePush,
  TerminalClipboardPush,
  TerminalClosedPush,
  TerminalPush,
  UiSettingPush,
} from "./api";
import { setHttpRouter } from "./httpRoute";
import {
  homeSocketUrl,
  type NodeAdvertisement,
  nodeServesEvent,
  nodeServesGlobalMethod,
  nodeServesHttpPath,
  nodeServesMethod,
  parseNodeAdvertisement,
} from "./nodeRouting";
import type { RpcCallOptions } from "./rpcLanes";

/**
 * The page's bridge. On a page the desktop or the phone's server served it
 * is that server's one socket and nothing else: every call and push goes
 * through the `Bridge` it wraps unchanged.
 *
 * On a page a Roamgate node served (its hello carries `node`), it holds two
 * sockets, each an ordinary `Bridge`: the home's, for everything as on the
 * home's own page, and the node's (the page's own origin), which serves the
 * node's connection's latency-critical families (nodeRouting.ts). Each
 * socket keeps its own runtime generations; the page sees one generation
 * per connection, and for the node's connection one that changes whenever
 * the socket serving it changes, so the page re-reads and re-attaches it as
 * after a reconnect. When the node's socket is down the node's connection
 * goes entirely to the home; when the home's is, the page is served the
 * node's connection alone and the home's families fail without being sent.
 */

type Role = "page" | "home";
type Mode = "none" | "home" | "node";
type Factory = (options: BridgeSocketOptions) => Bridge;

/** How the page reaches its home, on a node page. */
export type HomeReach = "connecting" | "ok" | "signin" | "unreachable";

export interface NodeHomeState {
  home: string;
  connectionId: string;
  reach: HomeReach;
}

/** Whether the page has a session on the home, and can reach it. */
export type HomeProbe = (
  home: string,
) => Promise<Exclude<HomeReach, "connecting">>;

const RPC_TIMEOUT_MS = 30000;

function isGlobalMethod(method: string): boolean {
  return method.startsWith("bridge.") || method.startsWith("connections.");
}

class HomeUnreachableError extends Error {
  readonly code = "home_unreachable";
}

/**
 * Loads an image only an authenticated session can read, then one the home
 * serves to anyone: the first tells a session apart, the second a home that
 * answers from one that does not. The home's cookie is sent: its origin and
 * the node's are the same site.
 */
export const probeHomeWithImages: HomeProbe = (home) => {
  const load = (path: string) =>
    new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = `${home}${path}?probe=${Date.now()}`;
    });
  return load("/roamgate-icon-32.png").then(async (authed) => {
    if (authed) return "ok";
    return (await load("/roamgate-icon-192.png")) ? "signin" : "unreachable";
  });
};

export class RoutedBridge {
  private readonly page: Bridge;
  private home: Bridge | null = null;
  private node: NodeAdvertisement | null = null;

  private eventHandlers = new Set<(e: HerdrEventMsg) => void>();
  private assistantHandlers = new Set<(snapshot: AssistantSnapshot) => void>();
  private assistantDeltaHandlers = new Set<
    (push: AssistantDeltaPush) => void
  >();
  private assistantNotificationHandlers = new Set<
    (notification: AssistantTaskNotification) => void
  >();
  private terminalHandlers = new Set<(t: TerminalPush) => void>();
  private terminalClipboardHandlers = new Set<
    (clipboard: TerminalClipboardPush) => void
  >();
  private terminalClosedHandlers = new Set<
    (closed: TerminalClosedPush) => void
  >();
  private popupHandlers = new Set<(popup: PopupStatePush) => void>();
  private uiSettingsHandlers = new Set<(push: UiSettingPush) => void>();
  private workspaceTreeHandlers = new Set<(tree: unknown) => void>();
  private mrReviewsHandlers = new Set<(push: MrReviewsPush) => void>();
  private forgeCacheHandlers = new Set<(push: MrCachePush) => void>();
  private workHandlers = new Set<(push: WorkPush) => void>();
  private forwardsHandlers = new Set<(forwards: ForwardRecord[]) => void>();
  private reviewHandlers = new Set<(push: ReviewPush) => void>();
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private controlHandlers = new Set<(c: BridgeControlMsg) => void>();
  private helloHandlers = new Set<(hello: BridgeHello) => void>();
  private runtimeMovedHandlers = new Set<(connectionId: string) => void>();
  private nodeHomeHandlers = new Set<(state: NodeHomeState) => void>();

  // The routed page's own state; the wrapped bridge's when not routed.
  private _status: ConnectionStatus = "disconnected";
  private _mode: Mode = "none";
  private _activeConnectionId = "legacy-default";
  private _clientGeneration = 0;
  private _viewEpoch = 0;
  /** The generations the page holds, as the catalog it read gave them. */
  private readonly pageGenerations = new Map<string, number>();
  /** The home's runtime generations, from its last catalog. */
  private readonly homeGenerations = new Map<string, number>();
  /** The node's runtime generation of its connection, from its catalog. */
  private nodeGeneration: number | null = null;
  private nodeCatalogRead: Promise<void> | null = null;
  /** The generation the page sees for the node's connection. */
  private localGeneration = 1;
  private localKey = "";
  private homeFailed = false;
  private homeReach: HomeReach = "connecting";
  private homeProbing = false;
  private homeWasConnected = false;
  private shownHello: { from: BridgeHello; shown: BridgeHello } | null = null;

  constructor(
    private readonly createBridge: Factory,
    private readonly probeHome: HomeProbe = probeHomeWithImages,
    private readonly pageOrigin: () => string = () =>
      typeof location === "undefined" ? "" : location.origin,
  ) {
    this.page = createBridge({});
    this.attach(this.page, "page");
  }

  /** The node this page was served by, and how its home is reached. */
  get nodeHome(): NodeHomeState | null {
    if (!this.node) return null;
    return {
      home: this.node.home,
      connectionId: this.node.connection_id,
      reach: this.homeReach,
    };
  }

  onNodeHome(cb: (state: NodeHomeState) => void): () => void {
    this.nodeHomeHandlers.add(cb);
    const state = this.nodeHome;
    if (state) cb(state);
    return () => this.nodeHomeHandlers.delete(cb);
  }

  get status(): ConnectionStatus {
    return this.node ? this._status : this.page.status;
  }

  get activeConnectionId(): string {
    return this.node ? this._activeConnectionId : this.page.activeConnectionId;
  }

  get clientGeneration(): number {
    return this.node ? this._clientGeneration : this.page.clientGeneration;
  }

  get hello(): BridgeHello | null {
    if (!this.node) return this.page.hello;
    const from = this.primary()?.hello ?? null;
    if (!from) return null;
    if (this.shownHello?.from !== from) {
      // A node page opens on the node's own connection.
      this.shownHello = {
        from,
        shown: { ...from, default_connection_id: this.node.connection_id },
      };
    }
    return this.shownHello.shown;
  }

  setConnectionRuntimeGenerations(
    connections: Array<Pick<ConnectionSummary, "id" | "generation">>,
  ): void {
    if (!this.node) {
      this.page.setConnectionRuntimeGenerations(connections);
      return;
    }
    this.pageGenerations.clear();
    for (const connection of connections)
      this.pageGenerations.set(connection.id, connection.generation);
    const local = this.node.connection_id;
    const home: Array<Pick<ConnectionSummary, "id" | "generation">> = [];
    for (const connection of connections) {
      if (connection.id !== local) home.push(connection);
      else {
        const real = this.homeGenerations.get(local);
        if (real !== undefined) home.push({ id: local, generation: real });
      }
    }
    if (this._mode === "home" || this._mode === "none")
      this.home?.setConnectionRuntimeGenerations(home);
  }

  setActiveConnection(connectionId: string): number {
    if (!this.node) return this.page.setActiveConnection(connectionId);
    if (!connectionId) throw new Error("invalid connection_id");
    if (connectionId === this._activeConnectionId)
      return this._clientGeneration;
    this._activeConnectionId = connectionId;
    this._viewEpoch += 1;
    this.page.setActiveConnection(connectionId);
    this.home?.setActiveConnection(connectionId);
    this._clientGeneration += 1;
    return this._clientGeneration;
  }

  advanceActiveConnectionGeneration(): number {
    if (!this.node) return this.page.advanceActiveConnectionGeneration();
    this.page.advanceActiveConnectionGeneration();
    this.home?.advanceActiveConnectionGeneration();
    this._clientGeneration += 1;
    return this._clientGeneration;
  }

  connection(
    connectionId = this.activeConnectionId,
    serverRuntimeGeneration: number | null = null,
  ): ConnectionClient {
    if (!this.node)
      return this.page.connection(connectionId, serverRuntimeGeneration);
    const local = this.node.connection_id;
    const generation = this._clientGeneration;
    const viewEpoch = this._viewEpoch;
    const leaseHeld = () =>
      generation === this._clientGeneration &&
      connectionId === this._activeConnectionId;
    const runtimeHeld = () =>
      serverRuntimeGeneration !== null &&
      this.pageGenerations.get(connectionId) === serverRuntimeGeneration &&
      (connectionId !== local ||
        serverRuntimeGeneration === this.localGeneration);
    return {
      connectionId,
      generation,
      serverRuntimeGeneration,
      viewEpoch,
      call: (method, params = {}, timeoutMs = RPC_TIMEOUT_MS, options = {}) => {
        if (isGlobalMethod(method))
          return Promise.reject(
            new Error(`global RPC cannot use a connection client: ${method}`),
          );
        if (this._mode === "none")
          return Promise.reject(new Error("bridge hello is unavailable"));
        if (!leaseHeld())
          return Promise.reject(new Error("connection changed during request"));
        if (!runtimeHeld())
          return Promise.reject(
            new Error("connection runtime generation is unavailable"),
          );
        const target = this.socketFor(connectionId, method);
        const real = this.realGeneration(target, connectionId);
        if (real === null)
          return Promise.reject(
            new Error("connection runtime generation is unavailable"),
          );
        return target
          .connection(connectionId, real)
          .call(method, params, timeoutMs, options);
      },
      isCurrent: () => this._mode !== "none" && leaseHeld() && runtimeHeld(),
      acceptsServerGeneration: (value: unknown) =>
        serverRuntimeGeneration !== null && value === serverRuntimeGeneration,
    };
  }

  readConnection(
    connectionId: string,
    method: "workspace.list" | "tab.list" | "pane.list" | "agent.list",
  ): Promise<any> {
    if (!this.node) return this.page.readConnection(connectionId, method);
    if (this._mode === "none")
      return Promise.reject(new Error("bridge hello is unavailable"));
    return this.socketFor(connectionId, method).readConnection(
      connectionId,
      method,
    );
  }

  callConnection(
    connectionId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number | null = RPC_TIMEOUT_MS,
    options: RpcCallOptions = {},
  ): Promise<any> {
    if (!this.node)
      return this.page.callConnection(
        connectionId,
        method,
        params,
        timeoutMs,
        options,
      );
    if (this._mode === "none")
      return Promise.reject(new Error("bridge hello is unavailable"));
    return this.socketFor(connectionId, method).callConnection(
      connectionId,
      method,
      params,
      timeoutMs,
      options,
    );
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number | null = RPC_TIMEOUT_MS,
    options: RpcCallOptions = {},
  ): Promise<any> {
    if (!this.node) return this.page.call(method, params, timeoutMs, options);
    if (!isGlobalMethod(method))
      return this.connection(
        this._activeConnectionId,
        this.pageGenerations.get(this._activeConnectionId) ?? null,
      ).call(method, params, timeoutMs, options);
    const target =
      this._mode === "home"
        ? this.home
        : this._mode === "node" && nodeServesGlobalMethod(method)
          ? this.page
          : null;
    if (!target)
      return Promise.reject(
        this._mode === "node"
          ? new HomeUnreachableError(
              `${method} is served by the home, which is unreachable`,
            )
          : new Error("not connected to bridge"),
      );
    if (method === "connections.list")
      return target
        .call(method, params, timeoutMs, options)
        .then((result) => this.pageCatalog(target, result));
    if (method === "connections.agent_sessions") {
      // Read whole, so the node connection's entries can carry the page's
      // generation for it.
      const whole = { ...params };
      delete whole.since;
      return target
        .call(method, whole, timeoutMs, options)
        .then((result) => this.pageAgentSessions(result));
    }
    return target.call(method, params, timeoutMs, options);
  }

  connect(): void {
    this.page.connect();
    this.home?.connect();
  }

  disconnect(reason?: string): void {
    this.page.disconnect(reason);
    this.home?.disconnect(reason);
  }

  probeConnectionNow(): void {
    this.page.probeConnectionNow();
    this.home?.probeConnectionNow();
  }

  heartbeatWindowMs(): number {
    return (this.primary() ?? this.page).heartbeatWindowMs();
  }

  onHello(cb: (hello: BridgeHello) => void): () => void {
    this.helloHandlers.add(cb);
    const hello = this.status === "connected" || !this.node ? this.hello : null;
    if (hello) cb(hello);
    return () => this.helloHandlers.delete(cb);
  }

  onRuntimeMoved(cb: (connectionId: string) => void): () => void {
    this.runtimeMovedHandlers.add(cb);
    return () => this.runtimeMovedHandlers.delete(cb);
  }

  onEvent(cb: (event: HerdrEventMsg) => void): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  onAssistant(cb: (snapshot: AssistantSnapshot) => void): () => void {
    this.assistantHandlers.add(cb);
    return () => this.assistantHandlers.delete(cb);
  }

  onAssistantDelta(cb: (push: AssistantDeltaPush) => void): () => void {
    this.assistantDeltaHandlers.add(cb);
    return () => this.assistantDeltaHandlers.delete(cb);
  }

  onAssistantNotification(
    cb: (notification: AssistantTaskNotification) => void,
  ): () => void {
    this.assistantNotificationHandlers.add(cb);
    return () => this.assistantNotificationHandlers.delete(cb);
  }

  onTerminal(cb: (terminal: TerminalPush) => void): () => void {
    this.terminalHandlers.add(cb);
    return () => this.terminalHandlers.delete(cb);
  }

  onTerminalClipboard(
    cb: (clipboard: TerminalClipboardPush) => void,
  ): () => void {
    this.terminalClipboardHandlers.add(cb);
    return () => this.terminalClipboardHandlers.delete(cb);
  }

  onPopup(cb: (popup: PopupStatePush) => void): () => void {
    this.popupHandlers.add(cb);
    return () => this.popupHandlers.delete(cb);
  }

  onReview(cb: (push: ReviewPush) => void): () => void {
    this.reviewHandlers.add(cb);
    return () => this.reviewHandlers.delete(cb);
  }

  onForwards(cb: (forwards: ForwardRecord[]) => void): () => void {
    this.forwardsHandlers.add(cb);
    return () => this.forwardsHandlers.delete(cb);
  }

  onForgeCache(cb: (push: MrCachePush) => void): () => void {
    this.forgeCacheHandlers.add(cb);
    return () => this.forgeCacheHandlers.delete(cb);
  }

  onMrReviews(cb: (push: MrReviewsPush) => void): () => void {
    this.mrReviewsHandlers.add(cb);
    return () => this.mrReviewsHandlers.delete(cb);
  }

  onWork(cb: (push: WorkPush) => void): () => void {
    this.workHandlers.add(cb);
    return () => this.workHandlers.delete(cb);
  }

  onWorkspaceTree(cb: (tree: unknown) => void): () => void {
    this.workspaceTreeHandlers.add(cb);
    return () => this.workspaceTreeHandlers.delete(cb);
  }

  onUiSetting(cb: (push: UiSettingPush) => void): () => void {
    this.uiSettingsHandlers.add(cb);
    return () => this.uiSettingsHandlers.delete(cb);
  }

  onTerminalClosed(cb: (closed: TerminalClosedPush) => void): () => void {
    this.terminalClosedHandlers.add(cb);
    return () => this.terminalClosedHandlers.delete(cb);
  }

  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    cb(this.status);
    return () => this.statusHandlers.delete(cb);
  }

  onControl(cb: (control: BridgeControlMsg) => void): () => void {
    this.controlHandlers.add(cb);
    return () => this.controlHandlers.delete(cb);
  }

  // --- routing ---------------------------------------------------------

  private primary(): Bridge | null {
    if (this._mode === "home") return this.home;
    if (this._mode === "node") return this.page;
    return null;
  }

  /** Whether the node's socket serves its connection now. */
  private nodeRouteUp(): boolean {
    if (!this.node || this.page.status !== "connected") return false;
    const nodeHello = this.page.hello;
    if (nodeHello?.capabilities?.connection_runtime_generation !== true)
      return false;
    const homeHello = this.home?.hello;
    if (
      homeHello &&
      homeHello.bridge_protocol_version !== nodeHello.bridge_protocol_version
    )
      return false;
    return this.nodeGeneration !== null;
  }

  private socketFor(connectionId: string, method: string): Bridge {
    const home = this.home ?? this.page;
    if (!this.node || connectionId !== this.node.connection_id) return home;
    return this.nodeRouteUp() && nodeServesMethod(method) ? this.page : home;
  }

  private realGeneration(target: Bridge, connectionId: string): number | null {
    if (!this.node || connectionId !== this.node.connection_id)
      return this.pageGenerations.get(connectionId) ?? null;
    if (target === this.page) return this.nodeGeneration;
    return this.homeGenerations.get(connectionId) ?? null;
  }

  /** A catalog as the page holds it: the node's connection at its generation. */
  private pageCatalog(source: Bridge, result: unknown): unknown {
    if (!this.node || !result || typeof result !== "object") return result;
    const catalog = result as Record<string, unknown>;
    const local = this.node.connection_id;
    if (Array.isArray(catalog.connections)) {
      const generations =
        source === this.page ? null : new Map<string, number>();
      for (const entry of catalog.connections) {
        if (!entry || typeof entry !== "object") continue;
        const { id, generation } = entry as Record<string, unknown>;
        if (typeof id !== "string" || typeof generation !== "number") continue;
        if (generations) generations.set(id, generation);
        else if (id === local) this.setNodeGeneration(generation);
      }
      if (generations) {
        this.homeGenerations.clear();
        for (const [id, generation] of generations)
          this.homeGenerations.set(id, generation);
      }
      this.updateLocalGeneration(false);
    }
    return {
      ...catalog,
      default_connection_id: local,
      ...(Array.isArray(catalog.connections)
        ? {
            connections: catalog.connections.map((entry) =>
              entry &&
              typeof entry === "object" &&
              (entry as { id?: unknown }).id === local
                ? { ...entry, generation: this.localGeneration }
                : entry,
            ),
          }
        : {}),
    };
  }

  private pageAgentSessions(result: unknown): unknown {
    if (!this.node || !result || typeof result !== "object") return result;
    const answer = result as Record<string, unknown>;
    if (!Array.isArray(answer.connections)) return result;
    const local = this.node.connection_id;
    const real = this.homeGenerations.get(local);
    return {
      ...answer,
      connections: answer.connections.map((entry) => {
        const item = entry as Record<string, unknown> | null;
        return item?.connection_id === local &&
          item.connection_generation === real
          ? { ...item, connection_generation: this.localGeneration }
          : entry;
      }),
    };
  }

  private setNodeGeneration(generation: number | null): void {
    this.nodeGeneration = generation;
    if (!this.node) return;
    this.page.setConnectionRuntimeGenerations(
      generation === null ? [] : [{ id: this.node.connection_id, generation }],
    );
  }

  /** Reads the node's own catalog: its connection's runtime generation. */
  private readNodeCatalog(): void {
    if (!this.node || this.nodeCatalogRead) return;
    const local = this.node.connection_id;
    this.nodeCatalogRead = this.page
      .call("connections.list")
      .then(
        (result: { connections?: unknown }) => {
          const entry = Array.isArray(result?.connections)
            ? (result.connections as Array<Record<string, unknown>>).find(
                (item) => item?.id === local,
              )
            : undefined;
          this.setNodeGeneration(
            typeof entry?.generation === "number" ? entry.generation : null,
          );
        },
        () => this.setNodeGeneration(null),
      )
      .finally(() => {
        this.nodeCatalogRead = null;
        this.updateLocalGeneration(true);
      });
  }

  /**
   * The generation the page sees for the node's connection follows the
   * socket serving it and that socket's runtime: when either changes, the
   * page is told the runtime moved and re-reads the catalog.
   */
  private updateLocalGeneration(announce: boolean): void {
    if (!this.node) return;
    const local = this.node.connection_id;
    const key = this.nodeRouteUp()
      ? `${this._mode}|node|${this.nodeGeneration}`
      : `${this._mode}|home|${this.homeGenerations.get(local) ?? null}`;
    if (key === this.localKey) return;
    const first = this.localKey === "";
    this.localKey = key;
    if (first) return;
    this.localGeneration += 1;
    if (announce && this._mode !== "none") this.emitRuntimeMoved(local);
  }

  private startRouting(node: NodeAdvertisement): void {
    this.node = node;
    this._activeConnectionId = node.connection_id;
    this._clientGeneration = this.page.clientGeneration + 1;
    this._status =
      this.page.status === "disconnected" ? "disconnected" : "connecting";
    this.page.setActiveConnection(node.connection_id);
    const home = this.createBridge({
      url: () => homeSocketUrl(node.home),
      onLoggedOut: () => this.setHomeReach("signin"),
    });
    this.home = home;
    home.setActiveConnection(node.connection_id);
    this.attach(home, "home");
    setHttpRouter((path) => this.routeHttp(path));
    installHomeFetch(node.home, (path) => this.routeHttp(path));
    this.emitNodeHome();
    this.readNodeCatalog();
    home.connect();
  }

  private attach(socket: Bridge, role: Role): void {
    socket.onHello((hello) => {
      if (role === "page" && !this.node) {
        const node = parseNodeAdvertisement(hello, this.pageOrigin());
        if (node) {
          this.startRouting(node);
          return;
        }
        this.helloHandlers.forEach((handler) => handler(hello));
        return;
      }
      if (!this.node) return;
      // Each socket picks its default connection on its first hello; the
      // page's choice is the one both follow.
      if (socket.activeConnectionId !== this._activeConnectionId)
        socket.setActiveConnection(this._activeConnectionId);
      if (role === "page") {
        this.setNodeGeneration(null);
        this.readNodeCatalog();
      }
    });
    let last: ConnectionStatus | null = null;
    socket.onStatus((status) => {
      // Only changes: the first call is the socket's state on subscribing.
      const previous = last;
      last = status;
      if (previous === null || previous === status) return;
      if (!this.node) {
        if (role === "page") this.emitStatus(status);
        return;
      }
      if (role === "home") this.homeStatus(status);
      if (role === "page" && status !== "connected")
        this.setNodeGeneration(null);
      this.recompute();
    });
    socket.onRuntimeMoved((connectionId) => {
      if (!this.node) {
        this.emitRuntimeMoved(connectionId);
        return;
      }
      if (role === "page") {
        if (connectionId === this.node.connection_id) this.readNodeCatalog();
        return;
      }
      if (this._mode === "home") this.emitRuntimeMoved(connectionId);
    });
    const scoped =
      <T extends { connection_id: string; connection_generation?: number }>(
        handlers: Set<(push: T) => void>,
        event: (push: T) => string | null,
      ) =>
      (push: T) => {
        const shown = this.scopedPush(role, push, event(push));
        if (shown) handlers.forEach((handler) => handler(shown));
      };
    socket.onEvent(scoped(this.eventHandlers, (push) => push.event));
    socket.onTerminal(scoped(this.terminalHandlers, () => null));
    socket.onTerminalClipboard(
      scoped(this.terminalClipboardHandlers, () => null),
    );
    socket.onTerminalClosed(scoped(this.terminalClosedHandlers, () => null));
    socket.onPopup(scoped(this.popupHandlers, () => null));
    const shared =
      <T>(handlers: Set<(push: T) => void>) =>
      (push: T) => {
        if (this.node && role !== "home") return;
        handlers.forEach((handler) => handler(push));
      };
    socket.onAssistant(shared(this.assistantHandlers));
    socket.onAssistantDelta(shared(this.assistantDeltaHandlers));
    socket.onAssistantNotification(shared(this.assistantNotificationHandlers));
    socket.onReview(shared(this.reviewHandlers));
    socket.onForwards(shared(this.forwardsHandlers));
    socket.onForgeCache(shared(this.forgeCacheHandlers));
    socket.onMrReviews(shared(this.mrReviewsHandlers));
    socket.onWork(shared(this.workHandlers));
    socket.onWorkspaceTree(shared(this.workspaceTreeHandlers));
    socket.onUiSetting(shared(this.uiSettingsHandlers));
    socket.onControl(shared(this.controlHandlers));
  }

  /**
   * A scoped push as the page takes it, or null when the other socket is
   * the one that delivers it. `event` names a Herdr event push; other
   * scoped pushes (terminals, clipboards, popups) are the node's families.
   */
  private scopedPush<
    T extends { connection_id: string; connection_generation?: number },
  >(role: Role, push: T, event: string | null): T | null {
    if (!this.node) return push;
    const local = this.node.connection_id;
    if (push.connection_id !== local) return role === "home" ? push : null;
    const nodeFamily = event === null || nodeServesEvent(event);
    const fromNode = this.nodeRouteUp() && nodeFamily;
    if ((role === "page") !== fromNode) return null;
    const real =
      role === "page"
        ? this.nodeGeneration
        : (this.homeGenerations.get(local) ?? null);
    if (push.connection_generation !== undefined) {
      if (push.connection_generation !== real) return null;
      return { ...push, connection_generation: this.localGeneration };
    }
    return push;
  }

  private homeStatus(status: ConnectionStatus): void {
    if (status === "connected") {
      this.homeFailed = false;
      this.homeWasConnected = true;
      this.setHomeReach("ok");
      return;
    }
    if (status !== "disconnected") return;
    this.homeFailed = true;
    if (this.homeReach === "signin") return;
    if (this.homeWasConnected) {
      // The socket dropped; it may only have been a blip.
      this.homeWasConnected = false;
      this.setHomeReach("connecting");
      return;
    }
    this.checkHome();
  }

  /** Why the home's socket does not open: no session there, or no home. */
  private checkHome(): void {
    if (!this.node || this.homeProbing) return;
    this.homeProbing = true;
    const home = this.node.home;
    void this.probeHome(home)
      .catch(() => "unreachable" as const)
      .then((reach) => {
        this.homeProbing = false;
        if (this.home?.status === "connected") return;
        this.setHomeReach(reach === "ok" ? "connecting" : reach);
      });
  }

  private setHomeReach(reach: HomeReach): void {
    if (this.homeReach === reach) return;
    this.homeReach = reach;
    this.emitNodeHome();
  }

  private emitNodeHome(): void {
    const state = this.nodeHome;
    if (!state) return;
    this.nodeHomeHandlers.forEach((handler) => handler(state));
  }

  /** The routed page's mode and status, from its two sockets'. */
  private recompute(): void {
    if (!this.node || !this.home) return;
    const homeStatus = this.home.status;
    const nodeStatus = this.page.status;
    const mode: Mode =
      homeStatus === "connected"
        ? "home"
        : nodeStatus === "connected" && this.homeFailed
          ? "node"
          : "none";
    const status: ConnectionStatus =
      mode !== "none"
        ? "connected"
        : homeStatus === "connecting" || nodeStatus === "connecting"
          ? "connecting"
          : "disconnected";
    const previous = this._mode;
    this._mode = mode;
    if (mode !== previous) {
      // The page reads everything again from the socket that now serves it,
      // as after a reconnect: calls of the previous mode fail.
      this.page.advanceActiveConnectionGeneration();
      this.home.advanceActiveConnectionGeneration();
      if (previous !== "none") {
        this._clientGeneration += 1;
        this.emitStatus("disconnected");
      }
      this.updateLocalGeneration(false);
      if (mode !== "none") {
        const hello = this.hello;
        if (hello) this.helloHandlers.forEach((handler) => handler(hello));
      }
    } else {
      this.updateLocalGeneration(true);
    }
    if (status !== this._status) {
      if (this._status === "connected") this._clientGeneration += 1;
      this.emitStatus(status);
    }
  }

  private emitStatus(status: ConnectionStatus): void {
    if (this.node) this._status = status;
    this.statusHandlers.forEach((handler) => handler(status));
  }

  private emitRuntimeMoved(connectionId: string): void {
    for (const handler of this.runtimeMovedHandlers) {
      try {
        handler(connectionId);
      } catch {
        // One listener's failure never blocks the others.
      }
    }
  }

  /**
   * Where the page fetches an HTTP path from: the node's connection's
   * scoped routes from the node while its socket serves it, and every
   * other `/api/` route from the home, by absolute URL.
   */
  routeHttp(path: string): string {
    if (!this.node || !path.startsWith("/") || path.startsWith("//"))
      return path;
    const local = this.node.connection_id;
    const scoped = `/api/connections/${encodeURIComponent(local)}/`;
    if (path.startsWith(scoped)) {
      const nodeUp = this.nodeRouteUp();
      const real = nodeUp
        ? this.nodeGeneration
        : (this.homeGenerations.get(local) ?? null);
      const url = new URL(path, "http://page.invalid");
      if (url.searchParams.has("connection_generation") && real !== null)
        url.searchParams.set("connection_generation", String(real));
      const relative = `${url.pathname}${url.search}${url.hash}`;
      return nodeUp ? relative : `${this.node.home}${relative}`;
    }
    if (nodeServesHttpPath(path, local)) return path;
    if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?"))
      return `${this.node.home}${path}`;
    return path;
  }
}

/**
 * Sends the page's relative `/api/` fetches where routeHttp says, with the
 * home's cookie on those that go to the home.
 */
function installHomeFetch(home: string, route: (path: string) => string) {
  if (typeof globalThis.fetch !== "function") return;
  const original = globalThis.fetch.bind(globalThis);
  const routed = ((input: RequestInfo | URL, init?: RequestInit) => {
    let target = input;
    if (typeof input === "string" && input.startsWith("/"))
      target = route(input);
    const href =
      typeof target === "string"
        ? target
        : target instanceof URL
          ? target.href
          : null;
    if (href?.startsWith(`${home}/`))
      return original(target, { ...init, credentials: "include" });
    return original(target, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(routed, original);
}
