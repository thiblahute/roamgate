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

export type SshForwardRecord = {
  id: string;
  connectionId: string;
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
    "-L",
    // The remote side resolves "localhost" on the far host, which is what a
    // dev server printing http://localhost:PORT is actually bound to.
    `${FORWARD_BIND_HOST}:${localPort}:localhost:${remotePort}`,
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
    remote_port: record.remotePort,
    local_port: record.localPort,
    ...(record.label ? { label: record.label } : {}),
    state: record.state,
    ...(record.error ? { error: record.error } : {}),
  };
}

export function forwardId(connectionId: string, remotePort: number): string {
  return `${connectionId}:${remotePort}`;
}

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
    remotePort: number;
    label?: string;
  }): SshForwardRecord {
    const remotePort = validateForwardPort(request.remotePort);
    const id = forwardId(request.connectionId, remotePort);
    const existing = records.get(id);
    if (existing && existing.state !== "failed" && existing.state !== "closed")
      return { ...existing };

    const taken = new Set(
      [...records.values()]
        .filter(
          (record) => record.state === "starting" || record.state === "open",
        )
        .map((record) => record.localPort),
    );
    const localPort = chooseLocalPort(
      remotePort,
      (port) => !taken.has(port) && isPortFree(port),
    );
    const record: SshForwardRecord = {
      id,
      connectionId: request.connectionId,
      remotePort,
      localPort,
      label: request.label,
      state: "starting",
    };
    records.set(id, record);

    const argv = sshForwardArgv(request.destination, localPort, remotePort);
    logger.debug("opening ssh forward", { id, localPort, remotePort });
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
