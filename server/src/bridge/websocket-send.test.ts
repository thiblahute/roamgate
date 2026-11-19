import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import {
  dropCoalescedMessage,
  flushCoalescedMessages,
  receiveWebSocketAck,
  sendWebSocketMessage,
  WS_BACKPRESSURE_HARD_LIMIT_BYTES,
  WS_BACKPRESSURE_LIMIT_BYTES,
  WS_CHUNK_MARKER,
  WS_FLOW_CHUNK_CHARS,
  WS_FLOW_INITIAL_WINDOW_CHARS,
  WS_FLOW_QUEUE_LIMIT_CHARS,
  WS_FLOW_URGENT_CHARS,
  WS_STALL_TIMEOUT_MS,
  webSocketFlowStats,
  WS_COALESCE_LIMIT_BYTES,
  WS_COMPRESSION_MIN_BYTES,
  WS_PER_MESSAGE_DEFLATE,
  WebSocketCleanupTracker,
} from "./websocket-send";

function createWebSocket({
  bufferedAmount = 0,
  bufferedAmounts,
  sendResult = 1,
  sendError,
}: {
  bufferedAmount?: number;
  bufferedAmounts?: number[];
  sendResult?: number;
  sendError?: Error;
} = {}) {
  const sent: string[] = [];
  const compressed: boolean[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const closeArgumentCounts: number[] = [];
  const queuedAmounts = [...(bufferedAmounts ?? [bufferedAmount])];
  let lastBufferedAmount = bufferedAmount;
  return {
    closeArgumentCounts,
    closes,
    sent,
    compressed,
    ws: {
      close(code?: number, reason?: string) {
        closeArgumentCounts.push(arguments.length);
        closes.push([code, reason]);
      },
      getBufferedAmount() {
        lastBufferedAmount = queuedAmounts.shift() ?? lastBufferedAmount;
        return lastBufferedAmount;
      },
      send(payload: string, compress = false) {
        sent.push(payload);
        compressed.push(compress);
        if (sendError) throw sendError;
        return sendResult;
      },
    },
  };
}

function sendWithObservability(
  ws: ReturnType<typeof createWebSocket>["ws"],
  context = "terminal frame",
) {
  let cleanupCount = 0;
  const warnings: string[] = [];
  const result = sendWebSocketMessage(ws, "payload", {
    cleanup: () => {
      cleanupCount += 1;
    },
    context,
    warn: (message) => warnings.push(message),
  });
  return { cleanupCount, result, warnings };
}

test("negotiated compression reduces wire bytes and preserves uncompressed-client compatibility", async () => {
  const frame = JSON.stringify({
    terminal: {
      bytes: Buffer.from("\u001b[2Jterminal output\n".repeat(300)).toString(
        "base64",
      ),
    },
  });
  const messages = ["small terminal frame", frame, frame];
  async function transfer(negotiate: boolean) {
    let wireBytes = 0;
    const sockets = new Set<Socket>();
    const { promise, resolve, reject } = Promise.withResolvers<string[]>();
    const received: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
        message(ws) {
          for (let index = 0; index < messages.length; index++) {
            sendWebSocketMessage(ws, messages[index], {
              context: index === 1 ? "message" : "terminal-frame",
              cleanup: () => reject(new Error("send failed")),
            });
          }
        },
      },
    });
    // Count actual server-to-client TCP bytes, including the upgrade response.
    const proxy = createServer((client) => {
      const upstream = connect(server.port!, "127.0.0.1");
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("error", reject);
        socket.on("close", () => sockets.delete(socket));
      }
      upstream.on("data", (chunk) => {
        wireBytes += chunk.length;
      });
      client.pipe(upstream).pipe(client);
    });
    let ws: WebSocket | undefined;
    const timer = setTimeout(
      () => reject(new Error("compression test timed out")),
      5000,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("missing proxy port");
      // lib.dom's constructor hides Bun's native options overload.
      const BunWebSocket = WebSocket as unknown as new (
        url: string,
        options: Bun.WebSocketOptions,
      ) => WebSocket;
      ws = new BunWebSocket(`ws://127.0.0.1:${address.port}`, {
        perMessageDeflate: negotiate,
      });
      ws.onopen = () => ws!.send("frames");
      ws.onerror = () => reject(new Error("websocket failed"));
      ws.onclose = () =>
        reject(new Error("websocket closed before frames arrived"));
      ws.onmessage = (event) => {
        received.push(String(event.data));
        if (received.length === messages.length) resolve(received);
      };
      expect(await promise).toEqual(messages);
      if (negotiate) {
        expect(ws.extensions).toContain("permessage-deflate");
        expect(ws.extensions).not.toContain("server_no_context_takeover");
        expect(ws.extensions).toContain("client_no_context_takeover");
      } else {
        expect(ws.extensions).toBe("");
      }
      return wireBytes;
    } finally {
      clearTimeout(timer);
      ws?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      server.stop(true);
    }
  }
  const plain = await transfer(false);
  const compressed = await transfer(true);
  // One large RPC stays plain; only the other large message is a terminal frame.
  expect(compressed).toBeLessThan(plain * 0.75);
}, 15_000);

describe("browser WebSocket cleanup", () => {
  test("preserves the first cleanup snapshot until close handling completes", () => {
    const socket = {};
    let cleanupCount = 0;
    const cleanup = new WebSocketCleanupTracker((socketToCleanup) => {
      expect(socketToCleanup).toBe(socket);
      cleanupCount += 1;
      return { client: "c1", viewedTerminals: ["term_1"] };
    });

    const firstSnapshot = cleanup.cleanup(socket);
    expect(cleanup.cleanup(socket)).toBe(firstSnapshot);
    expect(cleanup.complete(socket)).toBe(firstSnapshot);
    expect(cleanupCount).toBe(1);

    expect(cleanup.cleanup(socket)).not.toBe(firstSnapshot);
    expect(cleanupCount).toBe(2);
  });
});

describe("browser WebSocket sending", () => {
  test("compresses only terminal frames at or above the byte threshold", () => {
    const { ws, compressed } = createWebSocket();
    for (const [context, payload] of [
      ["terminal-frame", "a".repeat(WS_COMPRESSION_MIN_BYTES - 1)],
      ["terminal-frame", "a".repeat(WS_COMPRESSION_MIN_BYTES)],
      ["terminal-frame", "\u00e9".repeat(WS_COMPRESSION_MIN_BYTES / 2)],
      ["terminal-clipboard", "a".repeat(WS_COMPRESSION_MIN_BYTES)],
      ["message", "a".repeat(WS_COMPRESSION_MIN_BYTES)],
    ]) {
      expect(sendWebSocketMessage(ws, payload, { context, cleanup() {} })).toBe(
        true,
      );
    }
    expect(compressed).toEqual([false, true, true, false, false]);
  });

  test("keeps the connection open when Bun queues a message under backpressure", () => {
    for (const sendResult of [-1, 7]) {
      const { closes, sent, ws } = createWebSocket({ sendResult });
      const outcome = sendWithObservability(ws);

      expect(outcome).toEqual({ cleanupCount: 0, result: true, warnings: [] });
      expect(sent).toEqual(["payload"]);
      expect(closes).toEqual([]);
    }
  });

  test("closes a slow connection when a queued send crosses the hard limit", () => {
    const bufferedAmount = WS_BACKPRESSURE_HARD_LIMIT_BYTES + 1;
    const { closes, sent, ws } = createWebSocket({
      bufferedAmounts: [0, bufferedAmount],
      sendResult: -1,
    });
    const outcome = sendWithObservability(ws);

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: [
        `[bridge] closing slow websocket during terminal frame: ${bufferedAmount}B buffered`,
      ],
    });
    expect(sent).toEqual(["payload"]);
    expect(closes).toEqual([[1013, "client too slow"]]);
  });

  test("cleans up when Bun drops a message because of a connection issue", () => {
    const { closeArgumentCounts, closes, sent, ws } = createWebSocket({
      sendResult: 0,
    });
    const outcome = sendWithObservability(ws, "workspace event");

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: ["[bridge] websocket send dropped during workspace event"],
    });
    expect(sent).toEqual(["payload"]);
    expect(closes).toEqual([[undefined, undefined]]);
    expect(closeArgumentCounts).toEqual([0]);
  });

  test("uses Bun's buffered amount API to close a client past the hard limit", () => {
    const bufferedAmount = WS_BACKPRESSURE_HARD_LIMIT_BYTES + 1;
    const { closes, sent, ws } = createWebSocket({ bufferedAmount });
    const outcome = sendWithObservability(ws);

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: [
        `[bridge] closing slow websocket during terminal frame: ${bufferedAmount}B buffered`,
      ],
    });
    expect(sent).toEqual([]);
    expect(closes).toEqual([[1013, "client too slow"]]);
  });

  test("logs and cleans up when sending throws", () => {
    const { closes, sent, ws } = createWebSocket({
      sendError: new Error("socket closed"),
    });
    const outcome = sendWithObservability(ws);

    expect(outcome).toEqual({
      cleanupCount: 1,
      result: false,
      warnings: [
        "[bridge] websocket send failed during terminal frame: socket closed",
      ],
    });
    expect(sent).toEqual(["payload"]);
    expect(closes).toEqual([[undefined, undefined]]);
  });
});

describe("terminal frame coalescing under backpressure", () => {
  function sendFrame(
    ws: ReturnType<typeof createWebSocket>["ws"],
    payload: string,
    coalesceKey: string,
  ) {
    return sendWebSocketMessage(ws, payload, {
      cleanup: () => {},
      coalesceKey,
      context: "terminal-frame",
      warn: () => {},
    });
  }

  test("holds a frame back instead of queueing it once the socket is behind", () => {
    const { closes, sent, ws } = createWebSocket({
      bufferedAmount: WS_COALESCE_LIMIT_BYTES + 1,
    });
    expect(sendFrame(ws, "frame-1", "terminal:t1")).toBe(true);
    // Nothing is queued on the socket, and the viewer is not disconnected.
    expect(sent).toEqual([]);
    expect(closes).toEqual([]);
  });

  test("keeps only the newest held frame per key", () => {
    const { sent, ws } = createWebSocket({
      bufferedAmounts: [
        WS_COALESCE_LIMIT_BYTES + 1,
        WS_COALESCE_LIMIT_BYTES + 1,
        0,
      ],
    });
    sendFrame(ws, "frame-1", "terminal:t1");
    sendFrame(ws, "frame-2", "terminal:t1");
    flushCoalescedMessages(ws, { cleanup: () => {}, warn: () => {} });
    // frame-1 is worthless: frame-2 is a complete repaint of the same surface.
    expect(sent).toEqual(["frame-2"]);
  });

  test("compresses the newest held repaint when the socket drains", () => {
    const { sent, compressed, ws } = createWebSocket({
      bufferedAmounts: [
        WS_COALESCE_LIMIT_BYTES + 1,
        WS_COALESCE_LIMIT_BYTES + 1,
        0,
      ],
    });
    const newest = "b".repeat(WS_COMPRESSION_MIN_BYTES);
    sendFrame(ws, "a".repeat(WS_COMPRESSION_MIN_BYTES), "terminal:t1");
    sendFrame(ws, newest, "terminal:t1");
    expect(sent).toEqual([]);
    flushCoalescedMessages(ws, { cleanup: () => {}, warn: () => {} });
    expect(sent).toEqual([newest]);
    expect(compressed).toEqual([true]);
  });

  test("keeps held frames for different terminals apart", () => {
    const { sent, ws } = createWebSocket({
      bufferedAmounts: [
        WS_COALESCE_LIMIT_BYTES + 1,
        WS_COALESCE_LIMIT_BYTES + 1,
        0,
        0,
      ],
    });
    sendFrame(ws, "frame-a", "terminal:t1");
    sendFrame(ws, "frame-b", "terminal:t2");
    flushCoalescedMessages(ws, { cleanup: () => {}, warn: () => {} });
    expect(sent.sort()).toEqual(["frame-a", "frame-b"]);
  });

  test("sends immediately while the socket keeps up", () => {
    const { closes, sent, ws } = createWebSocket({ bufferedAmount: 0 });
    expect(sendFrame(ws, "frame-1", "terminal:t1")).toBe(true);
    expect(sent).toEqual(["frame-1"]);
    expect(closes).toEqual([]);
  });

  test("leaves messages without a coalesce key alone", () => {
    const { sent, ws } = createWebSocket({
      bufferedAmount: WS_COALESCE_LIMIT_BYTES + 1,
    });
    const result = sendWebSocketMessage(ws, "rpc-reply", {
      cleanup: () => {},
      context: "file-list",
      warn: () => {},
    });
    // An RPC reply is not a repaint; dropping it would lose the answer.
    expect(result).toBe(true);
    expect(sent).toEqual(["rpc-reply"]);
  });
});

describe("dropping a held frame when it goes stale", () => {
  function backloggedSocket() {
    const sent: string[] = [];
    return {
      sent,
      ws: {
        close: () => {},
        getBufferedAmount: () => WS_COALESCE_LIMIT_BYTES + 1,
        send: (payload: string) => {
          sent.push(payload);
          return payload.length;
        },
      },
    };
  }

  test("a dropped payload is never sent on drain", () => {
    const { ws, sent } = backloggedSocket();
    const opts = { cleanup: () => {}, warn: () => {} };
    sendWebSocketMessage(ws, "stale-100x30", {
      ...opts,
      coalesceKey: "terminal:t1",
    });
    dropCoalescedMessage(ws, "terminal:t1");
    flushCoalescedMessages(ws, opts);
    expect(sent).toEqual([]);
  });

  test("dropping one terminal leaves another terminal's held frame alone", () => {
    const sent: string[] = [];
    let buffered = WS_COALESCE_LIMIT_BYTES + 1;
    const ws = {
      close: () => {},
      getBufferedAmount: () => buffered,
      send: (payload: string) => {
        sent.push(payload);
        return payload.length;
      },
    };
    const opts = { cleanup: () => {}, warn: () => {} };
    sendWebSocketMessage(ws, "t1-frame", {
      ...opts,
      coalesceKey: "terminal:t1",
    });
    sendWebSocketMessage(ws, "t2-frame", {
      ...opts,
      coalesceKey: "terminal:t2",
    });
    dropCoalescedMessage(ws, "terminal:t1");
    // The socket caught up, which is when the drain handler flushes.
    buffered = 0;
    flushCoalescedMessages(ws, opts);
    expect(sent).toEqual(["t2-frame"]);
  });
});

describe("a large buffer on a slow link", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("keeps the socket while one large reply drains", () => {
    setSystemTime(new Date(0));
    const buffered = WS_BACKPRESSURE_LIMIT_BYTES * 1.4;
    const { closes, ws } = createWebSocket({ bufferedAmount: buffered });
    expect(sendWithObservability(ws).result).toBe(true);
    // Draining, slowly: still above the limit 40 s later.
    for (let second = 1; second <= 40; second++) {
      setSystemTime(new Date(second * 1000));
      ws.getBufferedAmount = () => buffered - second * 1000;
      expect(sendWithObservability(ws).result).toBe(true);
    }
    expect(closes).toEqual([]);
  });

  test("closes a socket whose buffer stops draining", () => {
    setSystemTime(new Date(0));
    const buffered = WS_BACKPRESSURE_LIMIT_BYTES + 1;
    const { closes, ws } = createWebSocket({ bufferedAmount: buffered });
    expect(sendWithObservability(ws).result).toBe(true);
    setSystemTime(new Date(WS_STALL_TIMEOUT_MS));
    expect(sendWithObservability(ws).result).toBe(true);
    setSystemTime(new Date(WS_STALL_TIMEOUT_MS + 1000));
    const outcome = sendWithObservability(ws);
    expect(outcome.result).toBe(false);
    expect(outcome.warnings).toEqual([
      `[bridge] closing slow websocket during terminal frame: ${buffered}B buffered, not draining for 31s`,
    ]);
    expect(closes).toEqual([[1013, "client too slow"]]);
  });

  test("a drain counts as progress", () => {
    setSystemTime(new Date(0));
    const buffered = WS_BACKPRESSURE_LIMIT_BYTES + 1;
    const { closes, ws } = createWebSocket({ bufferedAmount: buffered });
    sendWithObservability(ws);
    setSystemTime(new Date(WS_STALL_TIMEOUT_MS - 1000));
    flushCoalescedMessages(ws, { cleanup() {} });
    setSystemTime(new Date(WS_STALL_TIMEOUT_MS + 1000));
    expect(sendWithObservability(ws).result).toBe(true);
    expect(closes).toEqual([]);
  });
});

/** Reassembles what a browser would hand to its message handler. */
function reassemble(frames: string[]): string[] {
  const parts = new Map<string, string[]>();
  const messages: string[] = [];
  for (const frame of frames) {
    if (!frame.startsWith(WS_CHUNK_MARKER)) {
      messages.push(frame);
      continue;
    }
    const idEnd = frame.indexOf(":", 1);
    const id = frame.slice(1, idEnd);
    const text = frame.slice(idEnd + 3);
    const list = parts.get(id) ?? [];
    list.push(text);
    parts.set(id, list);
    if (frame[idEnd + 1] === "1") {
      messages.push(list.join(""));
      parts.delete(id);
    }
  }
  return messages;
}

describe("flow control", () => {
  function flowSocket() {
    const socket = createWebSocket();
    const send = (payload: string, context = "message", coalesceKey?: string) =>
      sendWebSocketMessage(socket.ws, payload, {
        cleanup() {},
        coalesceKey,
        context,
        warn() {},
      });
    const sentChars = () =>
      socket.sent.reduce((total, frame) => total + frame.length, 0);
    const ackAll = () =>
      receiveWebSocketAck(socket.ws, `{"ack":${sentChars()}}`, {
        cleanup() {},
        warn() {},
      });
    return { ...socket, ackAll, send, sentChars };
  }

  test("stays off until the browser acknowledges, for older pages", () => {
    const { send, sent } = flowSocket();
    const large = "x".repeat(WS_FLOW_INITIAL_WINDOW_CHARS * 3);
    send(large);
    expect(sent).toEqual([large]);
  });

  test("treats only acknowledgements as acknowledgements", () => {
    const { ws } = flowSocket();
    expect(
      receiveWebSocketAck(ws, '{"id":"1","method":"bridge.ping"}', {
        cleanup() {},
      }),
    ).toBe(false);
    expect(receiveWebSocketAck(ws, '{"ack":0}', { cleanup() {} })).toBe(true);
    expect(webSocketFlowStats(ws).enabled).toBe(true);
  });

  test("keeps about a window in flight and sends a large message in chunks", () => {
    const { ackAll, send, sent, sentChars } = flowSocket();
    ackAll();
    const large = JSON.stringify({ id: "r", result: "y".repeat(2_000_000) });
    expect(send(large, "review")).toBe(true);

    expect(
      sent.every((frame) => frame.length <= WS_FLOW_CHUNK_CHARS + 16),
    ).toBe(true);
    expect(sentChars()).toBeLessThan(
      WS_FLOW_INITIAL_WINDOW_CHARS + WS_FLOW_CHUNK_CHARS + 16,
    );
    // A pong goes out at once, between the chunks.
    send('{"id":"ping","result":{"ok":true}}', "bridge-ping");
    expect(sent.at(-1)).toBe('{"id":"ping","result":{"ok":true}}');

    while (reassemble(sent).length < 2) ackAll();
    expect(reassemble(sent)).toEqual([
      '{"id":"ping","result":{"ok":true}}',
      large,
    ]);
  });

  test("never splits a surrogate pair across chunks", () => {
    const { ackAll, send, sent } = flowSocket();
    ackAll();
    const large = `${"a".repeat(WS_FLOW_CHUNK_CHARS - 1)}\u{1f600}${"b".repeat(WS_FLOW_CHUNK_CHARS)}`;
    send(large);
    while (reassemble(sent).length < 1) ackAll();
    for (const frame of sent) {
      const lastCode = frame.charCodeAt(frame.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    }
    expect(reassemble(sent)).toEqual([large]);
  });

  test("keeps a context's messages in order behind a queued one", () => {
    const { ackAll, send, sent } = flowSocket();
    ackAll();
    const large = "L".repeat(WS_FLOW_INITIAL_WINDOW_CHARS * 2);
    send(large, "review");
    send("small review update", "review");
    send("other", "agent-list");
    expect(sent.at(-1)).toBe("other");
    while (reassemble(sent).length < 3) ackAll();
    expect(reassemble(sent)).toEqual(["other", large, "small review update"]);
  });

  test("interleaves a queued reply of another context with a large one", () => {
    const { ackAll, send, sent } = flowSocket();
    ackAll();
    const large = "L".repeat(WS_FLOW_INITIAL_WINDOW_CHARS * 4);
    const medium = "M".repeat(WS_FLOW_URGENT_CHARS * 2);
    send(large, "review");
    send(medium, "agent-list");
    ackAll();
    ackAll();
    // The medium reply arrived long before the large one is complete.
    expect(reassemble(sent)).toEqual([medium]);
  });

  test("holds terminal repaints while the window is full and sends the newest on ack", () => {
    const { ackAll, send, sent } = flowSocket();
    ackAll();
    send("x".repeat(WS_FLOW_INITIAL_WINDOW_CHARS * 2), "review");
    const before = sent.length;
    send("frame 1", "terminal-frame", "t1");
    send("frame 2", "terminal-frame", "t1");
    expect(sent.length).toBe(before);
    while (!sent.includes("frame 2")) ackAll();
    expect(sent.includes("frame 1")).toBe(false);
  });

  test("closes a browser that stops reading past the queue limit", () => {
    const { ackAll, closes, send } = flowSocket();
    ackAll();
    const chunk = "q".repeat(8 * 1024 * 1024);
    let result = true;
    for (let i = 0; i <= WS_FLOW_QUEUE_LIMIT_CHARS / chunk.length; i++)
      result = send(chunk, "review");
    expect(result).toBe(false);
    expect(closes).toEqual([[1013, "client too slow"]]);
  });
});
