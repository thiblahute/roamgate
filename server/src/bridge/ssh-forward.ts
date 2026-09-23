import { SSH_NONINTERACTIVE_ARGS, validateSshDestination } from "./ssh-command";
import {
  classifySshTunnelFailure,
  readBoundedStderr,
  type SshTunnelError,
} from "./ssh-tunnel";
import { type Logger, silentLogger } from "../utils/logger";

/**
 * On-demand `-L` forwards for a connection's SSH transport, one supervised
 * process each.
 *
 * Deliberately not added to the Herdr tunnel's own `-L` list: ssh cannot gain
 * a forward without being restarted, and restarting that tunnel drops the
 * connection every browser is using. A separate process per forward also
 * means a refused port takes only itself down.
 *
 * Forwards bind loopback only. A forwarded port carries no authentication of
 * its own — whatever is on the far end answers anyone who connects — so the
 * only safe listener is one no other machine can reach. This is also why the
 * feature is limited to running Roamgate on the machine you browse from: a
 * forward bound anywhere else is either useless or exposed.
 */
export const FORWARD_BIND_HOST = "127.0.0.1";

export type SshForwardState = "starting" | "open" | "failed" | "closed";

/**
 * Which way the tunnel runs.
 *
 * `local` (ssh -L) puts a remote service on a local port: the browser reaches
 * something running on the far host. `remote` (ssh -R) is the mirror — a
 * service on this machine appears on the far host, so processes there, agents
 * included, can reach it.
 *
 * The trust story is not symmetric. A local forward exposes the far host's
 * service to this machine alone; a remote forward exposes ours to everything
 * on the far host. Both bind loopback, which is the only reason the second is
 * reasonable at all.
 */
export type SshForwardDirection = "local" | "remote";

export type SshForwardRecord = {
  id: string;
  connectionId: string;
  direction: SshForwardDirection;
  remotePort: number;
  localPort: number;
  label?: string;
  state: SshForwardState;
  error?: string;
};

export type ForwardProcess = {
  exited: Promise<number>;
  stderr?: Promise<string>;
  kill: (signal?: number) => void;
};

export function sshForwardArgv(
  destination: string,
  localPort: number,
  remotePort: number,
  direction: SshForwardDirection = "local",
): string[] {
  return [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
    "-N",
    ...(direction === "local"
      ? [
          "-L",
          // The far side resolves "localhost" on the remote, which is where a
          // dev server printing http://localhost:PORT is actually bound.
          `${FORWARD_BIND_HOST}:${localPort}:localhost:${remotePort}`,
        ]
      : [
          "-R",
          // Bound to the remote's loopback explicitly rather than relying on
          // its GatewayPorts default: a service of ours must not land on the
          // far host's network interfaces.
          `${FORWARD_BIND_HOST}:${remotePort}:localhost:${localPort}`,
        ]),
    "--",
    validateSshDestination(destination),
  ];
}

export function validateForwardPort(value: unknown): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(value)}`);
  }
  return port;
}

/**
 * Prefers the remote's own number so the address a user reads in terminal
 * output is the address they type, and falls back upwards when it is taken —
 * the mapping is then reported rather than hidden, since the URL changes.
 */
export function chooseLocalPort(
  preferred: number,
  isFree: (port: number) => boolean,
  span = 64,
): number {
  if (isFree(preferred)) return preferred;
  for (let offset = 1; offset <= span; offset++) {
    const candidate = preferred + offset;
    if (candidate <= 65535 && isFree(candidate)) return candidate;
  }
  throw new Error(
    `No free local port near ${preferred}; close a forward and retry`,
  );
}

/** The bridge protocol is snake_case on the wire; internals are not. */
export type ForwardWire = {
  id: string;
  connection_id: string;
  direction: SshForwardDirection;
  remote_port: number;
  local_port: number;
  label?: string;
  state: SshForwardState;
  error?: string;
};

export function forwardToWire(record: SshForwardRecord): ForwardWire {
  return {
    id: record.id,
    connection_id: record.connectionId,
    direction: record.direction,
    remote_port: record.remotePort,
    local_port: record.localPort,
    ...(record.label ? { label: record.label } : {}),
    state: record.state,
    ...(record.error ? { error: record.error } : {}),
  };
}

export function forwardId(
  connectionId: string,
  remotePort: number,
  direction: SshForwardDirection = "local",
): string {
  return `${connectionId}:${direction}:${remotePort}`;
}

export type SshForwards = ReturnType<typeof createSshForwards>;

export function createSshForwards(args: {
  logger?: Logger;
  spawn?: (argv: string[]) => ForwardProcess;
  isPortFree?: (port: number) => boolean;
}) {
  const logger = args.logger ?? silentLogger;
  const spawn =
    args.spawn ??
    ((argv: string[]): ForwardProcess => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, LC_ALL: "C" },
      });
      return {
        exited: proc.exited,
        stderr: readBoundedStderr(proc.stderr),
        kill: (signal) => proc.kill(signal),
      };
    });
  const isPortFree = args.isPortFree ?? defaultPortIsFree;
  const records = new Map<string, SshForwardRecord>();
  const processes = new Map<string, ForwardProcess>();
  const listeners = new Set<(forwards: SshForwardRecord[]) => void>();

  const publish = () => {
    const snapshot = list();
    for (const listener of listeners) listener(snapshot);
  };

  function list(): SshForwardRecord[] {
    return [...records.values()].map((record) => ({ ...record }));
  }

  function open(request: {
    connectionId: string;
    destination: string;
    /** The port on whichever host owns the service: the far host for a local
     * forward, this one for a remote forward. */
    port: number;
    direction?: SshForwardDirection;
    label?: string;
  }): SshForwardRecord {
    const direction = request.direction ?? "local";
    const port = validateForwardPort(request.port);
    const id = forwardId(request.connectionId, port, direction);
    const existing = records.get(id);
    if (existing && existing.state !== "failed" && existing.state !== "closed")
      return { ...existing };

    const taken = new Set(
      [...records.values()]
        .filter(
          (record) => record.state === "starting" || record.state === "open",
        )
        .filter((record) => record.direction === "local")
        .map((record) => record.localPort),
    );
    // Only a local forward binds here, so only it can be moved to a free
    // port. A remote forward asks the far host for one, and whether that
    // succeeds is ssh's answer to give: ExitOnForwardFailure turns a taken
    // port into an immediate exit carrying its own reason.
    const localPort =
      direction === "local"
        ? chooseLocalPort(
            port,
            (candidate) => !taken.has(candidate) && isPortFree(candidate),
          )
        : port;
    const record: SshForwardRecord = {
      id,
      connectionId: request.connectionId,
      direction,
      remotePort: port,
      localPort,
      label: request.label,
      state: "starting",
    };
    records.set(id, record);

    const argv = sshForwardArgv(
      request.destination,
      localPort,
      record.remotePort,
      direction,
    );
    logger.debug("opening ssh forward", {
      id,
      direction,
      localPort,
      remotePort: record.remotePort,
    });
    const proc = spawn(argv);
    processes.set(id, proc);
    // ExitOnForwardFailure means a refused bind exits immediately; staying up
    // is the only evidence the forward is live, since ssh -N prints nothing.
    void proc.exited.then(async (code) => {
      if (processes.get(id) !== proc) return;
      processes.delete(id);
      const current = records.get(id);
      if (!current || current.state === "closed") return;
      const failure: SshTunnelError = classifySshTunnelFailure(
        code,
        (await proc.stderr?.catch(() => "")) ?? "",
      );
      records.set(id, { ...current, state: "failed", error: failure.message });
      logger.warn("ssh forward exited", { id, code, error: failure.message });
      publish();
    });
    publish();
    return { ...record };
  }

  /** A forward is only reported open once it has survived its own startup. */
  function markOpen(id: string) {
    const current = records.get(id);
    if (!current || current.state !== "starting") return;
    records.set(id, { ...current, state: "open" });
    publish();
  }

  function close(id: string): boolean {
    const proc = processes.get(id);
    processes.delete(id);
    proc?.kill();
    const current = records.get(id);
    if (!current) return false;
    records.delete(id);
    publish();
    return true;
  }

  /** Forwards belong to the connection that opened them and die with it. */
  function closeConnection(connectionId: string) {
    for (const record of [...records.values()]) {
      if (record.connectionId === connectionId) close(record.id);
    }
  }

  function closeAll() {
    for (const record of [...records.values()]) close(record.id);
  }

  function onChange(listener: (forwards: SshForwardRecord[]) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { list, open, markOpen, close, closeConnection, closeAll, onChange };
}

function defaultPortIsFree(port: number): boolean {
  try {
    const server = Bun.listen({
      hostname: FORWARD_BIND_HOST,
      port,
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export type ListeningPort = {
  port: number;
  /** Process name when the remote reported one; ss only shows it for your
   * own processes unless privileged, so it is often absent. */
  process?: string;
};

/**
 * Ports a remote is listening on, from `ss -ltnH` (or `netstat -ltn`).
 *
 * Loopback-bound listeners are the interesting ones: a service bound to a
 * routable address is already reachable without a tunnel, while one on
 * 127.0.0.1 is exactly what cannot be reached from here. Addresses like
 * 0.0.0.0 and :: listen on loopback too, so they count.
 *
 * This exists because printed URLs only ever name one port: a dev server
 * announces its page and says nothing about the websocket beside it.
 */
export function parseListeningPorts(output: string): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^(Netid|Proto|Active)/i.test(trimmed)) continue;
    const columns = trimmed.split(/\s+/);
    // ss -ltnH: State Recv-Q Send-Q Local:Port Peer:Port [users:(...)]
    // netstat -ltn: Proto Recv-Q Send-Q Local:Port Peer:Port State
    const local = columns.find(
      (column, index) => index > 1 && /^\[?[\d.:a-f*]+\]?:\d+$/i.test(column),
    );
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const host = local.slice(0, local.lastIndexOf(":"));
    if (!listensOnLoopback(host)) continue;
    const process = trimmed.match(/users:\(\("([^"]+)"/)?.[1];
    const existing = byPort.get(port);
    if (!existing) byPort.set(port, process ? { port, process } : { port });
    else if (process && !existing.process) existing.process = process;
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function listensOnLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare === "localhost" ||
    // Wildcards cover loopback as well as every other interface.
    bare === "0.0.0.0" ||
    bare === "*" ||
    bare === "::" ||
    bare.startsWith("127.")
  );
}

/**
 * `-p` is what makes the result usable: an unprivileged user sees the process
 * behind their own sockets and nothing behind root's, which is exactly the
 * line between "a server I started" and "a system daemon". `ss` is not
 * everywhere, so fall back rather than reporting nothing.
 */
export const LISTENING_PORTS_COMMAND =
  "ss -ltnpH 2>/dev/null || netstat -ltnp 2>/dev/null";

/**
 * Narrows a scan to the listeners worth offering.
 *
 * A developer machine listens on a dozen ports it never thinks about — sshd,
 * resolved, CUPS, mDNS — and burying a dev server among them is how VS Code's
 * process-based detection earned its reputation for over-forwarding. Ports
 * whose process the caller can see are the caller's own, so that split does
 * the work without a denylist of well-known ports to maintain.
 *
 * Where nothing is named at all — `ss` without `-p` support, or a netstat that
 * refuses — the split carries no information, so everything is kept rather
 * than reporting an empty machine.
 */
export function ownedListeningPorts(
  ports: readonly ListeningPort[],
): ListeningPort[] {
  const named = ports.filter((entry) => entry.process);
  return named.length > 0 ? named : [...ports];
}
