/**
 * A voice helper for process tests: it speaks the helper's frames
 * (voice/helper/src/frames.rs) and makes calls whose signalling server is
 * a WebSocket server on 127.0.0.1 that only says welcome, as webrtcsink's
 * does first. Other requests are answered ok.
 */

const JSON_FRAME = 0;

function write(message: object) {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, true);
  frame[4] = JSON_FRAME;
  frame.set(payload, 5);
  process.stdout.write(frame);
}

type Signalling = ReturnType<typeof Bun.serve>;
const calls = new Map<number, Signalling>();

function startCall(id: number): number {
  calls.get(id)?.stop(true);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: undefined })) return undefined;
      return new Response("not a WebSocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "welcome", peerId: `fake-peer-${id}` }));
      },
      message() {},
    },
  });
  calls.set(id, server);
  return server.port ?? 0;
}

function handle(request: Record<string, unknown>) {
  const id = request.id;
  const call = Number(request.call ?? 0);
  switch (request.op) {
    case "call_start":
      write({
        id,
        ok: true,
        rate: 48_000,
        channels: 2,
        music: false,
        signalling_port: startCall(call),
      });
      return;
    case "call_stop":
      calls.get(call)?.stop(true);
      calls.delete(call);
      write({ id, ok: true });
      return;
    default:
      if (id !== undefined) write({ id, ok: true });
  }
}

let buffered = new Uint8Array(0);
for await (const chunk of Bun.stdin.stream()) {
  const joined = new Uint8Array(buffered.length + chunk.length);
  joined.set(buffered);
  joined.set(chunk, buffered.length);
  let at = 0;
  while (joined.length - at >= 4) {
    const length = new DataView(
      joined.buffer,
      joined.byteOffset + at,
    ).getUint32(0, true);
    if (joined.length - at - 4 < length) break;
    const kind = joined[at + 4];
    const payload = joined.slice(at + 5, at + 4 + length);
    at += 4 + length;
    if (kind === JSON_FRAME)
      handle(JSON.parse(new TextDecoder().decode(payload)));
  }
  buffered = joined.slice(at);
}
for (const server of calls.values()) server.stop(true);
export {};
