import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Channel,
  ChannelError,
  type ChannelHandlers,
  type ChannelOptions,
  type PushMessage,
} from "./channel";
import { BODY_WINDOW } from "./protocol";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Two channels over a real Unix socket: the front's and the core's. */
async function pair(
  front: ChannelHandlers = {},
  core: ChannelHandlers = {},
  options: { front?: ChannelOptions; core?: ChannelOptions } = {},
): Promise<{
  front: Channel;
  core: Channel;
  frontSocket: Socket;
  coreSocket: Socket;
}> {
  const dir = mkdtempSync(join(tmpdir(), "core-channel-test-"));
  const path = join(dir, "c.sock");
  let server: Server | null = null;
  const accepted = new Promise<Socket>((resolve) => {
    server = createServer(resolve);
    server.listen(path);
  });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const coreSocket = connect(path);
  await new Promise<void>((resolve) => coreSocket.once("connect", resolve));
  const frontSocket = await accepted;
  const frontChannel = new Channel(frontSocket, front, options.front);
  const coreChannel = new Channel(coreSocket, core, options.core);
  cleanups.push(() => {
    frontChannel.destroy();
    coreChannel.destroy();
    server!.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { front: frontChannel, core: coreChannel, frontSocket, coreSocket };
}

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<ChannelError> {
  try {
    await promise;
  } catch (error) {
    return error as ChannelError;
  }
  throw new Error("it did not fail");
}

async function readAll(stream: ReadableStream<Uint8Array> | null) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

describe("calls", () => {
  test("a call gets the core's result, or its error with code and data", async () => {
    const { front } = await pair(
      {},
      {
        call: async ({ method, params, ctx, shadow }) => {
          if (method === "fail")
            throw new ChannelError("it failed", "boom", { why: 1 });
          return { method, params, ctx, shadow };
        },
      },
    );
    expect(
      await front.call("x.get", { a: 1 }, { socket_id: 3 }, { shadow: true }),
    ).toEqual({
      method: "x.get",
      params: { a: 1 },
      ctx: { socket_id: 3 },
      shadow: true,
    });
    const error = await failure(front.call("fail", null));
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.message).toBe("it failed");
    expect(error.code).toBe("boom");
    expect(error.data).toEqual({ why: 1 });
  });

  test("a side with no call handler answers not_owner", async () => {
    const { front } = await pair();
    const error = await failure(front.call("x.get", {}));
    expect(error.code).toBe("not_owner");
  });

  test("cancel aborts the core's work and rejects the caller", async () => {
    let aborted!: () => void;
    const wasAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const { front } = await pair(
      {},
      {
        call: (_call, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted();
              reject(new Error("aborted"));
            });
          }),
      },
    );
    const controller = new AbortController();
    const result = front.call("slow", {}, {}, { signal: controller.signal });
    await Bun.sleep(20);
    controller.abort();
    expect((await failure(result)).code).toBe("cancelled");
    await wasAborted;
  });

  test("a reverse call reaches the front's targets", async () => {
    const { core } = await pair({
      reverseCall: async (target, args, ctx) => {
        if (target !== "echo")
          throw new ChannelError(`unknown target ${target}`, "unknown_target");
        return { args, ctx };
      },
    });
    expect(await core.reverseCall("echo", [1], { lane: "background" })).toEqual(
      { args: [1], ctx: { lane: "background" } },
    );
    expect((await failure(core.reverseCall("nope", null))).code).toBe(
      "unknown_target",
    );
  });

  test("closing rejects what is pending, and says so", async () => {
    let closed: Error | null | undefined;
    const { front, coreSocket } = await pair(
      { close: (error) => (closed = error) },
      { call: () => new Promise(() => {}) },
    );
    const pending = front.call("never", {});
    await Bun.sleep(10);
    coreSocket.destroy();
    expect(await failure(pending)).toBeInstanceOf(Error);
    await Bun.sleep(10);
    expect(closed).toBeNull();
    expect(front.isClosed).toBe(true);
    expect((await failure(front.call("x", {}))).message).toBe("channel closed");
  });
});

describe("pushes and control", () => {
  test("pushes arrive in order; a queued one is replaced by a newer one with its key", async () => {
    const got: PushMessage[] = [];
    const { core, coreSocket } = await pair({ push: (push) => got.push(push) });
    // Hold the writes back so that they queue.
    const write = coreSocket.write.bind(coreSocket);
    let held = true;
    const pending: (() => void)[] = [];
    (coreSocket as { write: unknown }).write = (bytes: Uint8Array) => {
      if (!held) return write(bytes);
      pending.push(() => write(bytes));
      return false;
    };
    core.push({ message: { first: 1 } });
    core.push({ message: { review: 1 }, key: "review" });
    core.push({ message: { other: 1 } });
    core.push({ message: { review: 2 }, key: "review" });
    held = false;
    for (const run of pending) run();
    coreSocket.emit("drain");
    await Bun.sleep(20);
    expect(got.map((push) => push.message)).toEqual([
      { first: 1 },
      { other: 1 },
      { review: 2 },
    ]);
    expect(got[2]!.key).toBe("review");
  });

  test("control messages go to the control handler; unknown ones are ignored", async () => {
    const control: unknown[] = [];
    const logs: string[] = [];
    const { front, core } = await pair(
      {},
      {
        control: (message) => control.push(message),
        log: (_level, message) => logs.push(message),
      },
    );
    front.send({ t: "owner", owners: { a: "rust" } });
    front.send({ t: "future_thing", x: 1 });
    front.send({ t: "future_thing", x: 2 });
    expect((await failure(core.reverseCall("x", null))).code).toBe(
      "unknown_target",
    );
    expect(control).toEqual([{ t: "owner", owners: { a: "rust" } }]);
    expect(logs).toEqual(["ignoring channel messages of type future_thing"]);
  });

  test("a frame that is not one closes the channel", async () => {
    let closed: Error | null | undefined;
    const { coreSocket } = await pair({ close: (error) => (closed = error) });
    coreSocket.write(new Uint8Array([2, 0, 0, 0, 9, 0]));
    await Bun.sleep(20);
    expect(closed).toBeInstanceOf(Error);
  });

  test("pings after a silence, and a peer that says nothing for long is dropped", async () => {
    let closed: Error | null | undefined;
    const pongs: unknown[] = [];
    await pair(
      {
        control: (message) => pongs.push(message),
        close: (error) => (closed = error),
      },
      {},
      { front: { pingAfterMs: 20, deadAfterMs: 200 } },
    );
    await Bun.sleep(80);
    expect(pongs.length).toBeGreaterThan(0);
    expect(closed).toBeUndefined();
    // A core that stops answering.
    const silent = await pair(
      { close: (error) => (closed = error) },
      {},
      { front: { deadAfterMs: 50 } },
    );
    void silent;
    await Bun.sleep(150);
    expect(closed?.message).toBe("nothing came for 0 s");
  });
});

describe("http", () => {
  test("a request's body streams to the core and the response streams back", async () => {
    const { front } = await pair(
      {},
      {
        http: async (request) => {
          const body = await readAll(request.body);
          return {
            status: 201,
            headers: [["x-echo", `${request.method} ${request.url}`]],
            body: streamOf([body, new TextEncoder().encode("!")]),
          };
        },
      },
    );
    const sent = new Uint8Array(700 * 1024).fill(7);
    const response = await front.http({
      method: "POST",
      url: "/api/x?y=1",
      headers: [["content-type", "application/octet-stream"]],
      ctx: { client_ip: "127.0.0.1" },
      body: streamOf([sent.subarray(0, 300 * 1024), sent.subarray(300 * 1024)]),
    });
    expect(response.status).toBe(201);
    expect(response.headers).toEqual([["x-echo", "POST /api/x?y=1"]]);
    const back = await readAll(response.body as ReadableStream<Uint8Array>);
    expect(back.length).toBe(sent.length + 1);
    expect(back[0]).toBe(7);
    expect(back[back.length - 1]).toBe(33);
  });

  test("a handler's failure before its head is an error", async () => {
    const { front } = await pair(
      {},
      {
        http: async () => {
          throw new ChannelError("no such path", "not_found");
        },
      },
    );
    const error = await failure(
      front.http({
        method: "GET",
        url: "/x",
        headers: [],
        ctx: {},
        body: null,
      }),
    );
    expect(error.code).toBe("not_found");
  });

  test("a slow reader holds the sender to the window", async () => {
    let produced = 0;
    const chunk = new Uint8Array(256 * 1024);
    const { front } = await pair(
      {},
      {
        http: async () => ({
          status: 200,
          headers: [],
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (produced >= 32 * 1024 * 1024) controller.close();
              else {
                produced += chunk.length;
                controller.enqueue(chunk);
              }
            },
          }),
        }),
      },
    );
    const response = await front.http({
      method: "GET",
      url: "/big",
      headers: [],
      ctx: {},
      body: null,
    });
    await Bun.sleep(100);
    // Nothing read: at most the window (and the chunk being sent) went out.
    expect(produced).toBeLessThanOrEqual(BODY_WINDOW + 2 * chunk.length);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
    }
    expect(total).toBe(32 * 1024 * 1024);
  });

  test("cancelling the response stops the core's body", async () => {
    let cancelled = false;
    const { front } = await pair(
      {},
      {
        http: async () => ({
          status: 200,
          headers: [],
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      },
    );
    const response = await front.http({
      method: "GET",
      url: "/endless",
      headers: [],
      ctx: {},
      body: null,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
  });
});
