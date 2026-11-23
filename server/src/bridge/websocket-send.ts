import { serverLogger } from "../utils/logger";

// A send buffer past this limit is only a problem once it stops draining: one
// large reply on a slow link sits above it for seconds and must not cost the
// viewer its connection. Past the hard limit the socket is closed regardless.
export const WS_BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
export const WS_BACKPRESSURE_HARD_LIMIT_BYTES = 64 * 1024 * 1024;
export const WS_STALL_TIMEOUT_MS = 30_000;
export const WS_COALESCE_LIMIT_BYTES = 1024 * 1024;
export const WS_COMPRESSION_MIN_BYTES = 1024;
// WebKit rejects shared-compressor streams interleaved with plain replies.
// Keep compression per connection; inbound decompression can still be shared.
export const WS_PER_MESSAGE_DEFLATE = {
  compress: "dedicated",
  decompress: "shared",
} as const;

const websocketLogger = serverLogger.child("websocket");

// Terminal frames are self-contained repaints, so a frame still waiting to be
// written carries nothing the next frame will not carry as well. Once a viewer
// falls behind, keep only the newest frame per terminal and send it when the
// socket drains. Queueing every repaint instead is what walks the buffer up to
// WS_BACKPRESSURE_LIMIT_BYTES and disconnects a viewer that is merely slow.
const heldPayloads = new WeakMap<WebSocketSendTarget, Map<string, string>>();

// Flow control. The socket's own buffer says little about the link: a local
// reverse proxy (Tailscale serve, Caddy) reads everything at once, so the
// bytes wait in the proxy or in a bufferbloated mobile queue instead, and a
// heartbeat pong sent after an 11 MB reply arrives only once all of it has.
// A browser that announces support acknowledges the characters it received,
// so the bridge keeps only about a second of data in flight: small messages
// (the pong, events, short replies) go out at once, while large ones wait in
// a queue and leave in chunks that interleave with them.
//
// Counts are UTF-16 code units of the text frames on both ends, so neither
// side encodes anything to count.
export const WS_FLOW_INITIAL_WINDOW_CHARS = 256 * 1024;
// Small enough that a pong waits behind under two seconds of data on a
// 40 KB/s link; a faster link grows the window from its measured rate.
export const WS_FLOW_MIN_WINDOW_CHARS = 64 * 1024;
export const WS_FLOW_MAX_WINDOW_CHARS = 8 * 1024 * 1024;
/** How long the data in flight may take to arrive, at the measured rate. */
export const WS_FLOW_TARGET_DELAY_MS = 1000;
/** A rate sample spans at least this much time, so bursty acks average out. */
export const WS_FLOW_RATE_SAMPLE_MS = 250;
/** Messages up to this size skip the queue. */
export const WS_FLOW_URGENT_CHARS = 16 * 1024;
/** Queued messages leave in chunks of this size. */
export const WS_FLOW_CHUNK_CHARS = 64 * 1024;
/** A browser this far behind is not reading: close instead of queueing more. */
export const WS_FLOW_QUEUE_LIMIT_CHARS = 64 * 1024 * 1024;
/** First character of a chunk frame; no JSON message starts with it. */
export const WS_CHUNK_MARKER = "\u0001";
const ACK_PREFIX = '{"ack":';

interface FlowItem {
  /** Set when the payload leaves in chunks. */
  chunkId: number | null;
  /** A newer payload with this key replaces this one until it starts. */
  coalesceKey?: string;
  offset: number;
  payload: string;
}

interface SocketFlow {
  acked: number;
  /** Characters the bridge asked to send, by context, for close logs. */
  asked: Map<string, number>;
  /** When the browser last acknowledged anything (0: never). */
  lastAckAt: number;
  /** In flight was at least half the window at the last acknowledgement. */
  busy: boolean;
  enabled: boolean;
  lastBuffered: number;
  lastProgressAt: number;
  nextChunkId: number;
  pumping: boolean;
  /** Per context, so a context's messages stay in order. */
  queues: Map<string, FlowItem[]>;
  queuedChars: number;
  /** Characters per second, 0 until measured. */
  rate: number;
  sampleAcked: number;
  sampleAt: number;
  sent: number;
  window: number;
}

const flows = new WeakMap<WebSocketSendTarget, SocketFlow>();

function flowOf(ws: WebSocketSendTarget): SocketFlow {
  let flow = flows.get(ws);
  if (!flow) {
    const now = Date.now();
    flow = {
      acked: 0,
      asked: new Map(),
      lastAckAt: 0,
      busy: false,
      enabled: false,
      lastBuffered: 0,
      lastProgressAt: now,
      nextChunkId: 1,
      pumping: false,
      queues: new Map(),
      queuedChars: 0,
      rate: 0,
      sampleAcked: 0,
      sampleAt: now,
      sent: 0,
      window: WS_FLOW_INITIAL_WINDOW_CHARS,
    };
    flows.set(ws, flow);
  }
  return flow;
}

function inFlight(flow: SocketFlow): number {
  return flow.sent - flow.acked;
}

function congested(flow: SocketFlow): boolean {
  return flow.enabled && inFlight(flow) >= flow.window;
}

export interface WebSocketFlowStats {
  acked: number;
  enabled: boolean;
  /** The three contexts the bridge asked to send the most for, with sizes. */
  heaviest: string;
  /** Since the browser last acknowledged, in ms; null when it never did. */
  lastAckAgeMs: number | null;
  queued: number;
  rate: number;
  sent: number;
  window: number;
}

/** What a socket sent and what its browser confirmed, for close logs. */
export function webSocketFlowStats(
  ws: WebSocketSendTarget,
): WebSocketFlowStats {
  const flow = flowOf(ws);
  return {
    acked: flow.acked,
    enabled: flow.enabled,
    heaviest: [...flow.asked]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([context, chars]) => `${context}:${chars}`)
      .join(","),
    lastAckAgeMs: flow.lastAckAt ? Date.now() - flow.lastAckAt : null,
    queued: flow.queuedChars,
    rate: Math.round(flow.rate),
    sent: flow.sent,
    window: flow.window,
  };
}

interface WebSocketSendTarget {
  /** Bun's: 2 closing, 3 closed (absent in some tests). */
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
  send(payload: string, compress?: boolean): number;
}

interface WebSocketSendOptions {
  cleanup: () => void;
  // Set for payloads that fully replace an earlier one with the same key, so a
  // backlogged socket can drop the earlier one instead of queueing both.
  coalesceKey?: string;
  context?: string;
  warn?: (message: string) => void;
}

interface WebSocketSendContext {
  cleanup: () => void;
  context: string;
  warn: (message: string) => void;
}

interface WebSocketCloseOptions {
  code?: number;
  context: string;
  reason?: string;
  warn: (message: string) => void;
}

export class WebSocketCleanupTracker<Socket extends object, Snapshot> {
  private readonly snapshots = new WeakMap<Socket, Snapshot>();

  constructor(private readonly performCleanup: (socket: Socket) => Snapshot) {}

  cleanup(socket: Socket): Snapshot {
    if (this.snapshots.has(socket)) {
      return this.snapshots.get(socket) as Snapshot;
    }
    const snapshot = this.performCleanup(socket);
    this.snapshots.set(socket, snapshot);
    return snapshot;
  }

  complete(socket: Socket): Snapshot {
    const snapshot = this.cleanup(socket);
    this.snapshots.delete(socket);
    return snapshot;
  }
}

function closeWebSocket(
  ws: Pick<WebSocketSendTarget, "close">,
  { code, context, reason, warn }: WebSocketCloseOptions,
): void {
  try {
    if (code === undefined) ws.close();
    else ws.close(code, reason);
  } catch (error) {
    warn(
      `[bridge] websocket close failed during ${context}: ${(error as Error).message}`,
    );
  }
}

/**
 * Closes a socket whose buffer stopped draining, or grew past the hard limit.
 * A buffer that is large but shrinking belongs to a slow link catching up.
 */
function closeSlowWebSocket(
  ws: WebSocketSendTarget,
  { cleanup, context, warn }: WebSocketSendContext,
): boolean {
  const bufferedAmount = ws.getBufferedAmount();
  if (!Number.isFinite(bufferedAmount)) return false;
  const flow = flowOf(ws);
  const now = Date.now();
  if (
    bufferedAmount <= WS_BACKPRESSURE_LIMIT_BYTES ||
    bufferedAmount < flow.lastBuffered
  ) {
    flow.lastProgressAt = now;
  }
  flow.lastBuffered = bufferedAmount;
  const stalledMs = now - flow.lastProgressAt;
  if (
    bufferedAmount <= WS_BACKPRESSURE_HARD_LIMIT_BYTES &&
    stalledMs <= WS_STALL_TIMEOUT_MS
  ) {
    return false;
  }

  warn(
    bufferedAmount > WS_BACKPRESSURE_HARD_LIMIT_BYTES
      ? `[bridge] closing slow websocket during ${context}: ${bufferedAmount}B buffered`
      : `[bridge] closing slow websocket during ${context}: ${bufferedAmount}B buffered, not draining for ${Math.round(stalledMs / 1000)}s`,
  );
  cleanup();
  closeWebSocket(ws, {
    code: 1013,
    context,
    reason: "client too slow",
    warn,
  });
  return true;
}

function defaultWarn(message: string): void {
  websocketLogger.warn("send failed", {
    detail: message.replace(/^\[bridge\] /, ""),
  });
}

export function sendWebSocketMessage(
  ws: WebSocketSendTarget,
  payload: string,
  {
    cleanup,
    coalesceKey,
    context = "message",
    warn = defaultWarn,
  }: WebSocketSendOptions,
): boolean {
  // The browser left while this was being made (a slow connection test or
  // connect answering after its page closed): nothing can reach it, and
  // its close already cleaned up. Bun would drop it (send gives 0).
  if (ws.readyState !== undefined && ws.readyState >= 2) {
    cleanup();
    websocketLogger.debug("send after close skipped", { context });
    return false;
  }
  const sendContext = { cleanup, context, warn };
  const flow = flowOf(ws);
  flow.asked.set(context, (flow.asked.get(context) ?? 0) + payload.length);
  if (coalesceKey !== undefined) {
    const held = heldPayloads.get(ws);
    if (ws.getBufferedAmount() > WS_COALESCE_LIMIT_BYTES || congested(flow)) {
      if (held) held.set(coalesceKey, payload);
      else heldPayloads.set(ws, new Map([[coalesceKey, payload]]));
      return true;
    }
    held?.delete(coalesceKey);
    // A large replacement (a review's snapshot) still leaves in chunks.
    if (flow.enabled && payload.length > WS_FLOW_CHUNK_CHARS)
      return enqueue(ws, flow, payload, sendContext, coalesceKey);
    return writeFrame(ws, flow, payload, sendContext);
  }
  if (
    flow.enabled &&
    (payload.length > WS_FLOW_URGENT_CHARS || flow.queues.has(context))
  ) {
    return enqueue(ws, flow, payload, sendContext);
  }
  return writeFrame(ws, flow, payload, sendContext);
}

function enqueue(
  ws: WebSocketSendTarget,
  flow: SocketFlow,
  payload: string,
  sendContext: WebSocketSendContext,
  coalesceKey?: string,
): boolean {
  const queue = flow.queues.get(sendContext.context);
  const waiting =
    coalesceKey === undefined
      ? undefined
      : queue?.find(
          (item) => item.coalesceKey === coalesceKey && item.offset === 0,
        );
  if (waiting) {
    flow.queuedChars += payload.length - waiting.payload.length;
    waiting.payload = payload;
    if (waiting.chunkId === null && payload.length > WS_FLOW_CHUNK_CHARS)
      waiting.chunkId = flow.nextChunkId++;
    return pumpFlow(ws, flow, sendContext);
  }
  const item: FlowItem = {
    chunkId: payload.length > WS_FLOW_CHUNK_CHARS ? flow.nextChunkId++ : null,
    offset: 0,
    payload,
    ...(coalesceKey === undefined ? {} : { coalesceKey }),
  };
  if (queue) queue.push(item);
  else flow.queues.set(sendContext.context, [item]);
  flow.queuedChars += payload.length;
  if (flow.queuedChars > WS_FLOW_QUEUE_LIMIT_CHARS) {
    sendContext.warn(
      `[bridge] closing slow websocket during ${sendContext.context}: ${flow.queuedChars} characters queued, ${inFlight(flow)} unacknowledged`,
    );
    flow.queues.clear();
    flow.queuedChars = 0;
    sendContext.cleanup();
    closeWebSocket(ws, {
      code: 1013,
      context: sendContext.context,
      reason: "client too slow",
      warn: sendContext.warn,
    });
    return false;
  }
  return pumpFlow(ws, flow, sendContext);
}

/** The next frame of a queued item: the payload itself, or its next chunk. */
function takeFrame(item: FlowItem): { frame: string; done: boolean } {
  if (item.chunkId === null) {
    item.offset = item.payload.length;
    return { frame: item.payload, done: true };
  }
  let end = Math.min(item.offset + WS_FLOW_CHUNK_CHARS, item.payload.length);
  // A surrogate pair split across two text frames would reach the browser as
  // two replacement characters.
  const last = item.payload.charCodeAt(end - 1);
  if (end < item.payload.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  const done = end === item.payload.length;
  const frame = `${WS_CHUNK_MARKER}${item.chunkId}:${done ? 1 : 0}:${item.payload.slice(item.offset, end)}`;
  item.offset = end;
  return { frame, done };
}

/**
 * Sends queued frames while the window has room, one frame per context in
 * turn so a small reply is not stuck behind a large one of another context.
 */
function pumpFlow(
  ws: WebSocketSendTarget,
  flow: SocketFlow,
  { cleanup, warn }: Omit<WebSocketSendContext, "context">,
): boolean {
  if (flow.pumping) return true;
  flow.pumping = true;
  try {
    while (flow.queuedChars > 0 && inFlight(flow) < flow.window) {
      const next = flow.queues.entries().next();
      if (next.done) break;
      const [context, items] = next.value;
      const item = items[0];
      const before = item.offset;
      const { frame, done } = takeFrame(item);
      flow.queuedChars -= item.offset - before;
      flow.queues.delete(context);
      if (done) items.shift();
      if (items.length) flow.queues.set(context, items);
      if (!writeFrame(ws, flow, frame, { cleanup, context, warn })) {
        flow.queues.clear();
        flow.queuedChars = 0;
        return false;
      }
    }
    return true;
  } finally {
    flow.pumping = false;
  }
}

function writeFrame(
  ws: WebSocketSendTarget,
  flow: SocketFlow,
  payload: string,
  sendContext: WebSocketSendContext,
): boolean {
  const { cleanup, context, warn } = sendContext;
  try {
    if (closeSlowWebSocket(ws, sendContext)) return false;

    const result = ws.send(
      payload,
      context === "terminal-frame" &&
        Buffer.byteLength(payload) >= WS_COMPRESSION_MIN_BYTES,
    );
    if (result !== 0) flow.sent += payload.length;
    if (result === 0) {
      cleanup();
      warn(`[bridge] websocket send dropped during ${context}`);
      closeWebSocket(ws, { context, warn });
      return false;
    }
    if (result === -1 && closeSlowWebSocket(ws, sendContext)) return false;
    return true;
  } catch (error) {
    cleanup();
    warn(
      `[bridge] websocket send failed during ${context}: ${(error as Error).message}`,
    );
    closeWebSocket(ws, { context, warn });
    return false;
  }
}

// Drop a held payload that has gone stale. A frame is sized for the surface it
// was rendered against, so once that surface resizes the held frame paints a
// partial screen: short by the rows and columns the surface gained. A resize
// makes the terminal emit a fresh frame anyway, so dropping the held one loses
// nothing and is the only way to avoid painting the stale size.
export function dropCoalescedMessage(
  ws: WebSocketSendTarget,
  coalesceKey: string,
): void {
  heldPayloads.get(ws)?.delete(coalesceKey);
}

/**
 * Handles a browser's acknowledgement (`{"ack":<characters received>}`),
 * which also turns flow control on for its socket. Returns false for any
 * other message, which is then an RPC.
 */
export function receiveWebSocketAck(
  ws: WebSocketSendTarget,
  text: string,
  {
    cleanup,
    warn = defaultWarn,
  }: Omit<WebSocketSendOptions, "coalesceKey" | "context">,
): boolean {
  if (!text.startsWith(ACK_PREFIX)) return false;
  const received = Number(text.slice(ACK_PREFIX.length, -1));
  if (!Number.isFinite(received)) return true;
  const flow = flowOf(ws);
  const now = Date.now();
  // A long silence with data in flight: the link or the page stalled.
  if (flow.lastAckAt && now - flow.lastAckAt > 5_000 && inFlight(flow) > 0)
    websocketLogger.debug("acknowledgements resumed", {
      gap_ms: now - flow.lastAckAt,
      unacked: inFlight(flow),
    });
  flow.lastAckAt = now;
  if (!flow.enabled) {
    flow.enabled = true;
    flow.sampleAt = now;
    flow.sampleAcked = flow.acked;
  }
  flow.acked = Math.max(flow.acked, Math.min(received, flow.sent));
  if (!flow.busy) {
    flow.sampleAt = now;
    flow.sampleAcked = flow.acked;
  } else if (now - flow.sampleAt >= WS_FLOW_RATE_SAMPLE_MS) {
    // Only a link kept busy shows its rate. Sizing the window to a fixed
    // delay at that rate lets it grow while data arrives faster than the
    // target and shrink once queueing delay builds up.
    const sample =
      ((flow.acked - flow.sampleAcked) * 1000) / (now - flow.sampleAt);
    flow.rate = flow.rate ? flow.rate * 0.75 + sample * 0.25 : sample;
    flow.window = Math.min(
      WS_FLOW_MAX_WINDOW_CHARS,
      Math.max(
        WS_FLOW_MIN_WINDOW_CHARS,
        Math.round((flow.rate * WS_FLOW_TARGET_DELAY_MS) / 1000),
      ),
    );
    flow.sampleAt = now;
    flow.sampleAcked = flow.acked;
  }
  if (pumpFlow(ws, flow, { cleanup, warn }) && !congested(flow)) {
    flushCoalescedMessages(ws, { cleanup, warn });
  }
  flow.busy = inFlight(flow) >= flow.window / 2;
  return true;
}

// Send the frames held back while the socket was behind. Call this when the
// socket drains. Each held payload is the newest repaint for its terminal, so
// one send per key restores the viewer to the current surface.
export function flushCoalescedMessages(
  ws: WebSocketSendTarget,
  {
    cleanup,
    context = "terminal-frame",
    warn,
  }: Omit<WebSocketSendOptions, "coalesceKey">,
): void {
  // A drain is progress, whatever the buffer reads next.
  flowOf(ws).lastProgressAt = Date.now();
  const held = heldPayloads.get(ws);
  if (!held?.size) return;
  const entries = Array.from(held);
  held.clear();
  for (const [coalesceKey, payload] of entries) {
    const sent = sendWebSocketMessage(ws, payload, {
      cleanup,
      coalesceKey,
      context,
      warn,
    });
    // A failed send has already closed the socket; stop rather than retry.
    if (!sent) return;
  }
}
