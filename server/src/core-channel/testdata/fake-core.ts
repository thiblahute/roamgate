/**
 * A core for the channel's tests, on the same channel code: what the Rust
 * core does with the test family (contract/wire/core-channel.md), plus
 * misbehaviours chosen by FAKE_CORE_MODE: `ok` (default), `silent` (never
 * says hello), `crash` (exits at once), `badtoken`, `oldprotocol`.
 */
import { connect } from "node:net";
import { Channel } from "../channel";
import { PROTOCOL } from "../protocol";

const mode = process.env.FAKE_CORE_MODE ?? "ok";
if (mode === "crash") process.exit(3);
const families = (process.env.FAKE_CORE_FAMILIES ?? "test.echo")
  .split(",")
  .filter(Boolean);
const socket = connect(process.env.ROAMGATE_CORE_CHANNEL!);
const encoder = new TextEncoder();

const channel: Channel = new Channel(socket, {
  call: async ({ method, params, ctx }) => {
    if (method === "test.echo.read") return { params, ctx };
    if (method === "test.echo.push") {
      const { key, message, count } = params as {
        key: string;
        message: Record<string, unknown>;
        count: number;
      };
      for (let n = 0; n < count; n++)
        channel.push({ message: { ...message, n }, key });
      return { pushed: count };
    }
    if (method === "test.echo.reverse")
      return channel.reverseCall("test.echo", params, ctx);
    throw new Error(`unknown method ${method}`);
  },
  http: async (request) => {
    const url = new URL(request.url, "http://core");
    if (url.pathname !== "/api/test-echo/stream")
      return { status: 404, headers: [], body: null };
    if (request.method === "POST")
      return {
        status: 200,
        headers: [["content-type", "application/octet-stream"]],
        body: request.body,
      };
    const bytes = Number(url.searchParams.get("bytes") ?? "0");
    let sent = 0;
    return {
      status: 200,
      headers: [["content-type", "text/plain"]],
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= bytes) return controller.close();
          const size = Math.min(100_000, bytes - sent);
          sent += size;
          controller.enqueue(encoder.encode("x".repeat(size)));
        },
      }),
    };
  },
  control: (message) => {
    if (message.t === "owner" || message.t === "welcome")
      channel.push({
        message: { fake_core: message.t, owners: message.owners },
      });
  },
  close: () => process.exit(0),
});

socket.on("connect", () => {
  if (mode === "silent") return;
  channel.send({
    t: "hello",
    protocol: mode === "oldprotocol" ? PROTOCOL + 99 : PROTOCOL,
    token:
      mode === "badtoken" ? "0".repeat(64) : process.env.ROAMGATE_CORE_TOKEN,
    side: "bun",
    version: "fake",
    pid: process.pid,
    families,
    test: true,
  });
});
