/**
 * The Pi sidecar's side of its wire (contract/wire/pi-sidecar.md): Pi
 * drivers, one per Ranger directory pair, served to the process that
 * started the sidecar. Every callback and tool handler of a run is a
 * notification or a reverse request to that process.
 */
import type {
  AssistantConfig,
  AssistantMessage,
} from "../../../shared/assistant";
import { isRecord } from "../agent/session-utils";
import type { AssistantDriver } from "./pi-driver";
import { MethodNotFound, PiSidecarPeer } from "./pi-sidecar-peer";
import {
  type Id,
  PI_SIDECAR_PROTOCOL,
  RUN_CALLBACKS,
  RUN_HANDLERS,
} from "./pi-sidecar-protocol";

type RunInput = Parameters<AssistantDriver["run"]>[0];
type CreateDriver = (
  directory: string,
  credentialDirectory: string,
) => AssistantDriver;

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name}`);
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function names(value: unknown, allowed: readonly string[]): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter(
      (name): name is string =>
        typeof name === "string" && allowed.includes(name),
    ),
  );
}

export type PiSidecarServer = {
  /** One line from the parent. */
  receive(line: string): void;
  /** The parent is gone: stop every run and dispose every driver. */
  close(): Promise<void>;
};

export function createPiSidecarServer(options: {
  write(line: string): void;
  createDriver: CreateDriver;
  log?(message: string): void;
}): PiSidecarServer {
  const drivers = new Map<string, AssistantDriver>();
  function driverOf(params: Record<string, unknown>) {
    const directory = text(params.directory, "directory");
    const credentials = text(
      params.credential_directory ?? directory,
      "credential directory",
    );
    const key = JSON.stringify([directory, credentials]);
    let driver = drivers.get(key);
    if (!driver) {
      driver = options.createDriver(directory, credentials);
      drivers.set(key, driver);
    }
    return { key, driver };
  }

  function runInput(
    id: Id,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): RunInput {
    const input = record(params.input, "run input");
    const callbacks = names(params.callbacks, RUN_CALLBACKS);
    const handlers = names(params.handlers, RUN_HANDLERS);
    const event = (type: string, args: unknown[]) =>
      peer.notify("run.event", { request: id, type, args });
    const tool =
      (handler: string) =>
      (...args: unknown[]) => {
        const last = args.at(-1);
        const toolSignal = last instanceof AbortSignal ? last : undefined;
        if (toolSignal) args = args.slice(0, -1);
        while (args.length && args.at(-1) === undefined)
          args = args.slice(0, -1);
        return peer.request(
          "run.tool",
          { request: id, handler, args },
          toolSignal ? AbortSignal.any([toolSignal, signal]) : signal,
        ) as Promise<never>;
      };
    const run: RunInput = {
      config: record(input.config, "configuration") as AssistantConfig,
      entries: Array.isArray(input.entries) ? input.entries : [],
      text: text(input.text, "text"),
      ...(typeof input.request_id === "string"
        ? { requestId: input.request_id }
        : {}),
      ...(input.recover === true ? { recover: true } : {}),
      ...(Array.isArray(input.steers)
        ? {
            steers: input.steers.filter(
              (steer): steer is { requestId: string; text: string } =>
                isRecord(steer) &&
                typeof steer.requestId === "string" &&
                typeof steer.text === "string",
            ),
          }
        : {}),
      signal,
      read: tool("read"),
      delta: (value) => event("delta", [value]),
      message: (value) => event("message", [value]),
      tool: (toolId, name, status, details) =>
        event(
          "tool",
          details === undefined
            ? [toolId, name, status]
            : [toolId, name, status, details],
        ),
      error: () => event("error", []),
    };
    // A callback's presence changes what Pi reports: only the parent's.
    if (callbacks.has("checkpoint"))
      run.checkpoint = (entries) =>
        peer
          .request("run.checkpoint", { request: id, entries }, signal)
          .then(() => {});
    if (callbacks.has("replace"))
      run.replace = (value) => event("replace", [value]);
    if (callbacks.has("thinking"))
      run.thinking = (steps) => event("thinking", [steps]);
    if (callbacks.has("sources"))
      run.sources = (sources) => event("sources", [sources]);
    if (callbacks.has("steered"))
      run.steered = (requestId, value) =>
        event("steered", [requestId ?? null, value]);
    for (const handler of RUN_HANDLERS)
      if (handler !== "read" && handlers.has(handler))
        (run as Record<string, unknown>)[handler] = tool(handler);
    return run;
  }

  async function request(
    method: string,
    raw: unknown,
    signal: AbortSignal,
    id: Id,
  ): Promise<unknown> {
    const params = record(raw ?? {}, "parameters");
    switch (method) {
      case "initialize":
        if (params.protocol !== PI_SIDECAR_PROTOCOL)
          throw new Error(
            `Pi sidecar protocol ${String(params.protocol)} is not ${PI_SIDECAR_PROTOCOL}`,
          );
        return { protocol: PI_SIDECAR_PROTOCOL, pid: process.pid };
      case "catalog":
        return driverOf(params).driver.catalog(
          params.source as AssistantConfig["credential_source"],
        );
      case "configure_model": {
        const { driver } = driverOf(params);
        if (!driver.configureModel) throw new Error("Invalid model connection");
        await driver.configureModel(
          record(params.input, "model connection") as never,
          (path, value) =>
            peer
              .request("configure_model.save", { request: id, path, value })
              .then(() => {}),
        );
        return null;
      }
      case "read_tool_details": {
        const { driver } = driverOf(params);
        if (!driver.readToolDetails)
          return structuredClone(params.messages ?? []);
        return driver.readToolDetails(
          Array.isArray(params.entries) ? params.entries : [],
          (Array.isArray(params.messages)
            ? params.messages
            : []) as AssistantMessage[],
          typeof params.source_directory === "string"
            ? params.source_directory
            : undefined,
        );
      }
      case "login":
        await driverOf(params).driver.login(
          text(params.provider, "provider"),
          params.method === "oauth" ? "oauth" : "api_key",
          {
            credential_source:
              params.credential_source as AssistantConfig["credential_source"],
            signal,
            prompt: (prompt) =>
              peer.request(
                "login.prompt",
                {
                  request: id,
                  prompt: {
                    type: prompt.type,
                    message: prompt.message,
                    ...(prompt.options
                      ? {
                          options: prompt.options.map((option) => ({
                            id: option.id,
                            label: option.label,
                          })),
                        }
                      : {}),
                  },
                },
                prompt.signal
                  ? AbortSignal.any([prompt.signal, signal])
                  : signal,
              ) as Promise<string>,
            notify: (event) =>
              peer.notify("login.event", { request: id, event }),
          },
        );
        return null;
      case "run":
        return driverOf(params).driver.run(runInput(id, params, signal));
      case "steer": {
        const { driver } = driverOf(params);
        if (!driver.steer) throw new Error("Ranger is not running");
        await driver.steer({
          text: text(params.text, "text"),
          requestId: text(params.request_id, "request"),
        });
        return null;
      }
      case "stop":
        await driverOf(params).driver.stop();
        return null;
      case "dispose": {
        const { key, driver } = driverOf(params);
        drivers.delete(key);
        await driver.dispose();
        return null;
      }
      default:
        throw new MethodNotFound(`Unknown method ${method}`);
    }
  }

  const peer = new PiSidecarPeer(
    options.write,
    { request, notification: () => {} },
    options.log,
  );
  return {
    receive: (line) => peer.receive(line),
    async close() {
      peer.close(new Error("Pi sidecar closed"));
      const all = [...drivers.values()];
      drivers.clear();
      await Promise.allSettled(
        all.map(async (driver) => {
          await driver.stop();
          await driver.dispose();
        }),
      );
    },
  };
}

/**
 * Serves drivers over this process's stdin and stdout until stdin closes,
 * then exits: the sidecar's main. Console output goes to stderr, keeping
 * stdout for the wire.
 */
export async function servePiSidecarStdio(createDriver: CreateDriver) {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  const stdout = Bun.stdout.writer();
  const server = createPiSidecarServer({
    write(line) {
      stdout.write(line);
      stdout.flush();
    },
    createDriver,
    log: (message) => console.error(`[pi-sidecar] ${message}`),
  });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      server.receive(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer) server.receive(buffer);
  await server.close();
  process.exit(0);
}
