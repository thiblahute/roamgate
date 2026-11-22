/**
 * A fake OpenSSH client for the benchmark's ssh host. It logs every
 * invocation (BENCH_SSH_LOG) and acts it out locally: a master (-M) listens
 * on its control path, -O check/exit talk to it, -L forwards Unix sockets,
 * and a command runs in sh with the remote world's HOME (BENCH_REMOTE_HOME)
 * and Herdr sockets, over the master when its control path is up (a mux
 * session) or as its own login otherwise.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import * as net from "node:net";

const args = process.argv.slice(2);
const log = (kind: string, extra: Record<string, unknown> = {}) => {
  const path = process.env.BENCH_SSH_LOG;
  if (path)
    appendFileSync(
      path,
      `${JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...extra })}\n`,
    );
};

const separator = args.indexOf("--");
const options = separator >= 0 ? args.slice(0, separator) : args;
const rest = separator >= 0 ? args.slice(separator + 1) : [];
const destination = rest[0] ?? "";
const command = rest.slice(1).join(" ");
const value = (flag: string) => {
  const index = options.indexOf(flag);
  return index >= 0 ? options[index + 1] : undefined;
};
const controlPath = value("-S");
const op = value("-O");
const muxOnly = options.some((option) => option === "ProxyCommand=false");
const forwards: { local: string; remote: string }[] = [];
for (let index = 0; index < options.length; index++) {
  if (options[index] !== "-L") continue;
  const spec = options[index + 1] ?? "";
  const colon = spec.indexOf(":");
  forwards.push({ local: spec.slice(0, colon), remote: spec.slice(colon + 1) });
}

const alive = (path: string) =>
  new Promise<boolean>((resolve) => {
    if (!existsSync(path)) return resolve(false);
    const socket = net.createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

async function serveForever(servers: net.Server[], cleanup: () => void) {
  const sockets = new Set<net.Socket>();
  for (const server of servers)
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  await new Promise(() => {});
}

const listen = (server: net.Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    rmSync(path, { force: true });
    server.once("error", reject);
    server.listen(path, resolve);
  });

if (op) {
  // -O check / exit / forward / cancel against a master.
  const up = controlPath ? await alive(controlPath) : false;
  log("control", { op, destination, up });
  if (op === "exit" && controlPath && up) {
    const socket = net.createConnection(controlPath);
    socket.write("exit\n");
    socket.end();
    await Bun.sleep(50);
  }
  process.exit(up ? 0 : 255);
}

if (options.includes("-M")) {
  if (!controlPath) process.exit(255);
  log("master", { destination });
  const server = net.createServer((socket) => {
    socket.on("data", (data) => {
      if (String(data).startsWith("exit")) {
        server.close();
        try {
          unlinkSync(controlPath);
        } catch {}
        process.exit(0);
      }
    });
  });
  await listen(server, controlPath);
  await serveForever([server], () => {
    try {
      unlinkSync(controlPath);
    } catch {}
  });
}

if (forwards.length) {
  const viaMaster = controlPath ? await alive(controlPath) : false;
  log(viaMaster ? "mux-forward" : "forward", {
    destination,
    count: forwards.length,
  });
  const servers: net.Server[] = [];
  for (const forward of forwards) {
    const server = net.createServer((client) => {
      const upstream = net.createConnection(forward.remote);
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    await listen(server, forward.local);
    servers.push(server);
  }
  await serveForever(servers, () => {
    for (const forward of forwards) rmSync(forward.local, { force: true });
  });
}

const viaMaster = controlPath ? await alive(controlPath) : false;
if (!viaMaster && muxOnly) {
  log("mux-refused", { destination });
  process.exit(255);
}
log(viaMaster ? "mux" : "login", {
  destination,
  command: command.slice(0, 120),
});
if (!command) process.exit(0);
const remoteHome = process.env.BENCH_REMOTE_HOME ?? process.env.HOME ?? "/";
const child = spawn("sh", ["-c", command], {
  cwd: remoteHome,
  env: {
    ...process.env,
    HOME: remoteHome,
    HERDR_SOCKET_PATH: process.env.BENCH_REMOTE_CONTROL ?? "",
    HERDR_CLIENT_SOCKET_PATH: process.env.BENCH_REMOTE_CLIENT ?? "",
  },
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 255 : 0)));
