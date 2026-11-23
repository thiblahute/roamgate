import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HERDR_RELAY_READY,
  HERDR_RELAY_SCRIPT,
  HERDR_RELAY_SOCKET_PREFIX,
  herdrRelay,
} from "./herdr-relay";

describe("herdrRelay", () => {
  test("quotes alike in sh and fish", () => {
    // fish reads \\ and \' as escapes inside single quotes.
    expect(HERDR_RELAY_SCRIPT).not.toMatch(/['\\]/);
  });

  test("the script prints the ready line and owns the socket prefix", () => {
    expect(HERDR_RELAY_SCRIPT).toContain(`"${HERDR_RELAY_READY}"`);
    expect(HERDR_RELAY_SCRIPT).toContain(`"${HERDR_RELAY_SOCKET_PREFIX}"`);
  });

  test("listens in the host's Roamgate cache under its token", () => {
    const relay = herdrRelay({
      home: "/home/o'brien/",
      herdrSocket: "/home/o'brien/.config/herdr/herdr.sock",
      token: "abc123",
    });
    expect(relay?.socket).toBe(
      "/home/o'brien/.cache/roamgate/herdr-relay-abc123.sock",
    );
    expect(relay?.command).toStartWith("exec python3 -c '");
    expect(relay?.command).toEndWith(
      ` '/home/o'\\''brien/.config/herdr/herdr.sock' '/home/o'\\''brien/.cache/roamgate/herdr-relay-abc123.sock'`,
    );
  });

  test("leaves hosts whose socket path would be too long to the direct forward", () => {
    expect(
      herdrRelay({
        home: `/home/${"x".repeat(80)}`,
        herdrSocket: "/run/herdr.sock",
        token: "abc",
      }),
    ).toBeNull();
    expect(
      herdrRelay({ home: "relative", herdrSocket: "/h.sock", token: "abc" }),
    ).toBeNull();
    expect(() =>
      herdrRelay({ home: "/home/a", herdrSocket: "/h.sock", token: "../x" }),
    ).toThrow("alphanumeric");
  });
});

const python = Bun.which("python3");

describe.skipIf(!python || process.platform === "win32")(
  "the relay script",
  () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    });

    function tempHome() {
      const home = mkdtempSync(join(tmpdir(), "rg-relay-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      return home;
    }

    /** A Herdr stand-in: notes when each connection opens and what it got. */
    async function fakeHerdr(path: string) {
      const events: Array<{ opened: number; request?: string }> = [];
      const server: Server = createServer((socket) => {
        const event: { opened: number; request?: string } = {
          opened: performance.now(),
        };
        events.push(event);
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          if (!buffer.includes("\n")) return;
          event.request = buffer;
          const { id } = JSON.parse(buffer);
          socket.end(`${JSON.stringify({ id, result: { type: "pong" } })}\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      cleanups.push(() => server.close());
      return events;
    }

    async function startRelay(home: string, herdrSocket: string) {
      const relay = herdrRelay({ home, herdrSocket, token: "test" })!;
      const proc = Bun.spawn(["/bin/sh", "-c", relay.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      cleanups.push(() => proc.kill());
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(`${HERDR_RELAY_READY}\n`);
      return { relay, proc };
    }

    function call(path: string, delayMs: number) {
      return new Promise<{ sent: number; reply: string }>((resolve, reject) => {
        const socket = createConnection(path);
        let reply = "";
        let sent = 0;
        socket.on("connect", () => {
          setTimeout(() => {
            sent = performance.now();
            socket.write('{"id":"p","method":"ping","params":{}}\n');
          }, delayMs);
        });
        socket.on("data", (chunk) => {
          reply += chunk.toString();
        });
        socket.on("end", () => {
          socket.end();
          resolve({ sent, reply });
        });
        socket.on("error", reject);
      });
    }

    test("connects to Herdr only once the request is there", async () => {
      const home = tempHome();
      const herdrSocket = join(home, "herdr.sock");
      const events = await fakeHerdr(herdrSocket);
      const { relay } = await startRelay(home, herdrSocket);

      // Like sshd: connected first, the request a moment later.
      const { sent, reply } = await call(relay.socket, 30);
      expect(JSON.parse(reply)).toEqual({
        id: "p",
        result: { type: "pong" },
      });
      expect(events).toHaveLength(1);
      expect(events[0].opened).toBeGreaterThanOrEqual(sent);
      expect(events[0].request).toBe(
        '{"id":"p","method":"ping","params":{}}\n',
      );
    });

    test("removes its socket when the session ends, and stale ones", async () => {
      const home = tempHome();
      const herdrSocket = join(home, "herdr.sock");
      await fakeHerdr(herdrSocket);
      const directory = join(home, ".cache/roamgate");
      mkdirSync(directory, { recursive: true });
      // A socket file nobody listens on, left by a relay killed outright.
      const stale = join(directory, "herdr-relay-gone.sock");
      const leftover = createServer();
      await new Promise<void>((resolve) => leftover.listen(stale, resolve));
      await new Promise<void>((resolve) => leftover.close(() => resolve()));
      writeFileSync(join(directory, "unrelated.sock"), "");
      if (!existsSync(stale)) writeFileSync(stale, "");

      const { relay, proc } = await startRelay(home, herdrSocket);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(directory, "unrelated.sock"))).toBe(true);
      expect(existsSync(relay.socket)).toBe(true);

      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      expect(existsSync(relay.socket)).toBe(false);
    });
  },
);
