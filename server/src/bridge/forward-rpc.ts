import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import type { SshForwardRecord } from "./ssh-forward";
import {
  forwardToWire,
  LISTENING_PORTS_COMMAND,
  ownedListeningPorts,
  parseListeningPorts,
  validateForwardPort,
} from "./ssh-forward";
import { sshCommandArgv } from "./ssh-command";

/**
 * Opens and closes on-demand port forwards for one connection's SSH
 * transport. Forwarding is only offered where the browser and the Roamgate
 * server share a machine: a forward binds on whichever host runs `ssh`, so
 * anywhere else the port is either unreachable from the browser or exposed
 * beyond it. Connections without an SSH transport are refused outright rather
 * than silently doing nothing.
 */
export function createForwardRpcHandler(args: {
  connectionId?: string;
  connectionGeneration?: number;
  sshHost: () => string | undefined;
  runProcess: (
    argv: string[],
    input?: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  forwards: {
    list: () => SshForwardRecord[];
    open: (request: {
      connectionId: string;
      destination: string;
      remotePort: number;
      label?: string;
    }) => SshForwardRecord;
    markOpen: (id: string) => void;
    close: (id: string) => boolean;
  };
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
  ) => boolean;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
}) {
  const serialize = (message: Record<string, unknown>) =>
    args.connectionId
      ? serializeConnectionEnvelope(
          args.connectionId,
          message,
          args.connectionGeneration,
        )
      : JSON.stringify(message);

  return async function handleForwardRpc(
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    method: string,
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean,
  ) {
    const fail = (detail: string) => {
      args.markRpcError(ws, id, detail);
      args.safeSend(ws, serialize({ id, error: { message: detail } }), method);
    };
    const reply = (result: Record<string, unknown>) =>
      requestIsCurrent()
        ? args.safeSend(ws, serialize({ id, result }), method)
        : fail(CONNECTION_CHANGED_DURING_REQUEST);

    try {
      if (method === "forward.list") {
        return reply({ forwards: args.forwards.list().map(forwardToWire) });
      }
      const destination = args.sshHost();
      if (!destination) {
        return fail(
          "This connection is local; port forwarding applies to SSH connections",
        );
      }
      if (method === "forward.open") {
        const remotePort = validateForwardPort(params.remote_port);
        const label =
          typeof params.label === "string" && params.label.trim()
            ? params.label.trim().slice(0, 64)
            : undefined;
        const record = args.forwards.open({
          connectionId: args.connectionId ?? "",
          destination,
          remotePort,
          label,
        });
        // ssh -N says nothing on success, so treat surviving its own startup
        // as the signal. ExitOnForwardFailure means a refused bind has already
        // exited by now and the record reads "failed" instead.
        await new Promise((resolve) => setTimeout(resolve, 250));
        args.forwards.markOpen(record.id);
        const settled =
          args.forwards.list().find((entry) => entry.id === record.id) ??
          record;
        if (settled.state === "failed") {
          return fail(settled.error ?? "The forward could not be opened");
        }
        return reply({ forward: forwardToWire(settled) });
      }
      if (method === "forward.candidates") {
        // Asked for, never polled: one ssh round trip when someone opens the
        // ports list, rather than a standing cost on every connection.
        const { stdout } = await args.runProcess(
          sshCommandArgv(destination, LISTENING_PORTS_COMMAND),
        );
        const forwarded = new Set(
          args.forwards
            .list()
            .filter((entry) => entry.state !== "failed")
            .map((entry) => entry.remotePort),
        );
        return reply({
          candidates: ownedListeningPorts(parseListeningPorts(stdout)).filter(
            (entry) => !forwarded.has(entry.port),
          ),
        });
      }
      if (method === "forward.close") {
        const forwardId = String(params.id ?? "");
        if (!forwardId) return fail("forward.close requires id");
        return reply({ closed: args.forwards.close(forwardId) });
      }
      return fail(`unknown forward method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
