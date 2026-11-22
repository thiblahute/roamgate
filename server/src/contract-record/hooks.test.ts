import { afterEach, describe, expect, it } from "bun:test";
import childProcess from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WS_CHUNK_MARKER } from "../bridge/websocket-send";
import {
  recordCli,
  recordFetch,
  recordServe,
  recordSpawns,
  recordWebSocket,
} from "./hooks";
import { ContractRecorder, type RecordLine } from "./recorder";

const directories: string[] = [];
function recorder(): ContractRecorder {
  const directory = mkdtempSync(join(tmpdir(), "contract-hooks-"));
  directories.push(directory);
  return new ContractRecorder({ directory, role: "test" });
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function lines(rec: ContractRecorder): RecordLine[] {
  rec.flush();
  return readdirSync(rec.directory)
    .sort()
    .flatMap((name) =>
      readFileSync(join(rec.directory, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordLine),
    )
    .filter((line) => line.ch !== "recorder");
}

async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("contract record hooks", () => {
  it("change nothing when record mode is off", () => {
    const fetch = () => new Response("x");
    const websocket = { message() {} };
    expect(recordFetch(null, "http", fetch)).toBe(fetch);
    expect(recordWebSocket(null, () => "ws", websocket)).toBe(websocket);
    expect(recordServe(null, "http")).toBe(Bun.serve);
    const context = { log: () => {}, error: () => {} };
    expect(recordCli(null, ["x"], context).context).toBe(context);
  });

  it("records HTTP exchanges and WebSocket traffic of a server", async () => {
    const rec = recorder();
    const server = recordServe(
      rec,
      "http",
      () => "ws",
    )<{ n: number }>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws")
          return srv.upgrade(req, { data: { n: 1 } })
            ? undefined
            : new Response("no", { status: 400 });
        if (url.pathname === "/api/echo")
          return req.json().then((body) => Response.json({ got: body }));
        return new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ hello: true }));
        },
        message(ws, message) {
          const { id } = JSON.parse(String(message)) as { id: number };
          // A reply sent in flow-control chunks.
          const reply = JSON.stringify({ id, result: { items: [1, 2, 3] } });
          ws.send(`${WS_CHUNK_MARKER}7:0:${reply.slice(0, 10)}`);
          ws.send(`${WS_CHUNK_MARKER}7:1:${reply.slice(10)}`);
          ws.send(new Uint8Array([1, 2, 3]));
        },
      },
    });
    try {
      const echoed = await fetch(
        `http://127.0.0.1:${server.port}/api/echo?token=sekrit`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "s=1" },
          body: JSON.stringify({ password: "pw-pw-pw", a: 1 }),
        },
      );
      expect(await echoed.json()).toEqual({
        got: { password: "pw-pw-pw", a: 1 },
      });
      await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const received: unknown[] = [];
      socket.onmessage = (event) => received.push(event.data);
      await new Promise((resolve) => (socket.onopen = resolve));
      socket.send(JSON.stringify({ id: 5, method: "review.list", params: {} }));
      await until(() => received.length >= 4);
      socket.close(1000, "bye");
      await until(() => lines(rec).some((line) => line.ev === "close"));
    } finally {
      server.stop(true);
    }
    const all = lines(rec);
    const echo = all.find((line) => line.path === "/api/echo")!;
    expect(echo).toMatchObject({
      ch: "http",
      ev: "exchange",
      method: "POST",
      status: 200,
      body: { a: 1 },
      response: { got: { a: 1 } },
    });
    expect(JSON.stringify(all)).not.toContain("pw-pw-pw");
    expect(JSON.stringify(all)).not.toContain("sekrit");
    expect((echo.headers as Record<string, string>).cookie).toMatch(
      /^\[redacted:/,
    );
    const page = all.find((line) => line.path === "/")!;
    expect(page.status).toBe(200);
    expect(page.response).toBeUndefined();
    expect(all.find((line) => line.path === "/ws")).toMatchObject({
      upgrade: true,
    });
    const socketLines = all.filter((line) => line.ch === "ws");
    expect(socketLines.map((line) => line.ev)).toEqual([
      "open",
      "out",
      "in",
      "out",
      "out",
      "close",
    ]);
    expect(new Set(socketLines.map((line) => line.sock)).size).toBe(1);
    expect(socketLines[1]!.msg).toEqual({ hello: true });
    expect(socketLines[2]!.msg).toEqual({
      id: 5,
      method: "review.list",
      params: {},
    });
    expect(socketLines[3]).toMatchObject({
      chunks: 2,
      msg: { id: 5, result: { items: [1, 2, 3] } },
    });
    expect(socketLines[4]).toMatchObject({ binary: 3 });
    expect(socketLines[5]).toMatchObject({ code: 1000, reason: "bye" });
  });

  it("records the agent socket's forms", async () => {
    const rec = recorder();
    const server = recordServe(
      rec,
      "agent",
    )({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => Response.json({ ok: (await req.text()).length }),
    });
    try {
      await fetch(`http://127.0.0.1:${server.port}/v1/message`, {
        method: "POST",
        body: "to=desktop%2Fw1%3Ap1&text=hi",
      });
      await until(() => lines(rec).length > 0);
    } finally {
      server.stop(true);
    }
    expect(lines(rec)[0]).toMatchObject({
      ch: "agent",
      path: "/v1/message",
      body: { to: "desktop/w1:p1", text: "hi" },
      response: { ok: 28 },
    });
  });

  it("records the processes run, without their output", async () => {
    const rec = recorder();
    recordSpawns(rec);
    const proc = Bun.spawn(["sh", "-c", "exit 3", "--token", "abc"], {
      stdout: "ignore",
    });
    await proc.exited;
    Bun.spawnSync(["true"]);
    childProcess.spawnSync("sh", ["-c", "exit 0"]);
    await until(
      () => lines(rec).filter((line) => line.ev === "exit").length >= 3,
    );
    const all = lines(rec);
    expect(all.find((line) => line.ev === "start")).toMatchObject({
      ch: "spawn",
      api: "Bun.spawn",
      argv: ["sh", "-c", "exit 3", "--token", "[redacted]"],
    });
    expect(
      all.find((line) => line.ev === "exit" && line.api === "Bun.spawn"),
    ).toMatchObject({ code: 3 });
    expect(all.find((line) => line.api === "Bun.spawnSync")).toMatchObject({
      code: 0,
      argv: ["true"],
    });
    expect(
      all.find((line) => line.api === "child_process.spawnSync"),
    ).toMatchObject({
      code: 0,
      argv: ["sh", "-c", "exit 0"],
    });
    rec.close();
  });

  it("records a CLI run with what it printed", () => {
    const rec = recorder();
    const printed: string[] = [];
    const { context, finish } = recordCli(
      rec,
      ["auth", "--password", "pw", "rotate"],
      {
        log: (message: string) => printed.push(message),
        error: (message: string) => printed.push(`E ${message}`),
      },
    );
    context.log("done");
    context.error("careful");
    finish(0);
    expect(printed).toEqual(["done", "E careful"]);
    expect(lines(rec)[0]).toMatchObject({
      ch: "cli",
      ev: "run",
      argv: ["auth", "--password", "[redacted]", "rotate"],
      exit: 0,
      stdout: "done\n",
      stderr: "careful\n",
    });
    expect(rec.role).toBe("cli");
  });
});
