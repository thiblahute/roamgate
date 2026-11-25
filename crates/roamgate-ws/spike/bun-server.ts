// The spike page's server on Bun, sending the same run through the Bun
// server's own websocket-send code, so the browsers check the reference
// implementation with the same page and the wire bytes can be compared.
//
//   ws-spike --dump-plan plan.json && bun bun-server.ts plan.json [port]

import { readFileSync } from "node:fs";
import {
  flushCoalescedMessages,
  receiveWebSocketAck,
  sendWebSocketMessage,
  WS_BACKPRESSURE_HARD_LIMIT_BYTES,
  WS_PER_MESSAGE_DEFLATE,
} from "../../../server/src/bridge/websocket-send";

interface PlanItem {
  context: string;
  key: string | null;
  payload: string;
}

const plan = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  items: PlanItem[];
  manifest: unknown[];
};
const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

const cleanup = () => {};
type Socket = Parameters<typeof sendWebSocketMessage>[0];

function send(ws: Socket, payload: string, context: string, key?: string) {
  sendWebSocketMessage(ws, payload, {
    cleanup,
    context,
    ...(key ? { coalesceKey: key } : {}),
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[3] ?? 0),
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws")
      return server.upgrade(request)
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    if (url.pathname === "/")
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
    backpressureLimit: WS_BACKPRESSURE_HARD_LIMIT_BYTES,
    open(ws) {
      send(
        ws,
        JSON.stringify({
          hello: true,
          bridge_protocol_version: 2,
          backend: "bun",
          capabilities: { flow_control: true },
        }),
        "hello",
      );
    },
    drain(ws) {
      flushCoalescedMessages(ws, { cleanup });
    },
    message(ws, message) {
      const text = typeof message === "string" ? message : message.toString();
      if (receiveWebSocketAck(ws, text, { cleanup })) return;
      const parsed = JSON.parse(text);
      if (parsed.run) {
        for (const item of plan.items)
          send(ws, item.payload, item.context, item.key ?? undefined);
        send(ws, JSON.stringify({ manifest: plan.manifest }), "manifest");
      } else if (typeof parsed.echo === "string") {
        send(
          ws,
          JSON.stringify({
            echoed: parsed.id,
            n: parsed.echo.length,
            h: hash(parsed.echo),
            compressed: null,
          }),
          "message",
        );
      } else if (parsed.stats) {
        send(ws, JSON.stringify({ stats: null }), "message");
      } else if (parsed.report) {
        console.log(
          `REPORT ${JSON.stringify({ ...parsed.report, backend: "bun" })}`,
        );
      }
    },
  },
});
console.log(`listening on http://127.0.0.1:${server.port}`);
