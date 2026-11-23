/**
 * Pi in its sidecar (contract/wire/pi-sidecar.md): the process, started on
 * the first Pi call and stopped after five idle minutes, and an
 * AssistantDriver that runs Pi there. The Bun server uses it only when
 * `ROAMGATE_PI_SIDECAR` names the sidecar; the Rust server's is roamgate-pi.
 */
import type { AssistantDriver } from "./pi-driver";
import { PiSidecarPeer } from "./pi-sidecar-peer";
import {
  type Id,
  PI_SIDECAR_ENV,
  PI_SIDECAR_IDLE_MS,
  PI_SIDECAR_MAX_LINE,
  PI_SIDECAR_PROTOCOL,
  RUN_CALLBACKS,
  RUN_HANDLERS,
  sidecarCommand,
} from "./pi-sidecar-protocol";
import { isStandaloneBinary } from "../config/standalone";

/** What a request's reverse calls and notifications reach. */
type Route = {
  request?(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  notification?(method: string, params: Record<string, unknown>): void;
};

export type SidecarChild = {
  write(line: string): void;
  /** Lines the sidecar writes on stdout. */
  lines: AsyncIterable<string>;
  /** Ends its stdin: the sidecar exits. */
  end(): void;
  kill(): void;
  exited: Promise<number | null>;
};

export type SpawnSidecar = (
  argv: string[],
  env: Record<string, string | undefined>,
) => SidecarChild;

async function* splitLines(
  stream: ReadableStream<Uint8Array>,
  log: (message: string) => void,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let skipping = false;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!skipping) yield line;
      skipping = false;
      index = buffer.indexOf("\n");
    }
    if (buffer.length > PI_SIDECAR_MAX_LINE) {
      log("a line longer than 64 MiB was dropped");
      buffer = "";
      skipping = true;
    }
  }
  if (buffer && !skipping) yield buffer;
}

export const defaultSpawnSidecar: SpawnSidecar = (argv, env) => {
  const child = Bun.spawn(argv, {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  return {
    write(line) {
      child.stdin.write(line);
      child.stdin.flush();
    },
    lines: splitLines(child.stdout, (message) =>
      console.warn(`[assistant] Pi sidecar: ${message}`),
    ),
    end() {
      try {
        child.stdin.end();
      } catch {}
    },
    kill: () => child.kill("SIGKILL"),
    exited: child.exited.then((code) => code ?? null),
  };
};

export class PiSidecar {
  private child: SidecarChild | undefined;
  private peer: PiSidecarPeer | undefined;
  private ready: Promise<void> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly routes = new Map<Id, Route>();

  constructor(
    private readonly options: {
      argv: string[];
      env?: Record<string, string | undefined>;
      spawn?: SpawnSidecar;
      idleMs?: number;
      log?(message: string): void;
    },
  ) {}

  /** Whether a sidecar process is running. */
  get running() {
    return this.child !== undefined;
  }

  private log(message: string) {
    (
      this.options.log ??
      ((text) => console.warn(`[assistant] Pi sidecar: ${text}`))
    )(message);
  }

  private start() {
    const spawn = this.options.spawn ?? defaultSpawnSidecar;
    const child = spawn(this.options.argv, {
      ...(this.options.env ?? process.env),
    });
    const peer = new PiSidecarPeer(
      (line) => child.write(line),
      {
        request: (method, params, signal) => {
          const record = (params ?? {}) as Record<string, unknown>;
          const route = this.routes.get(record.request as Id);
          if (!route?.request) throw new Error(`No request for ${method}`);
          return route.request(method, record, signal);
        },
        notification: (method, params) => {
          const record = (params ?? {}) as Record<string, unknown>;
          this.routes.get(record.request as Id)?.notification?.(method, record);
        },
      },
      (message) => this.log(message),
    );
    this.child = child;
    this.peer = peer;
    void (async () => {
      try {
        for await (const line of child.lines) peer.receive(line);
      } catch {}
      const code = await child.exited.catch(() => null);
      peer.close(new Error(`The Pi sidecar exited (${code ?? "signal"})`));
      if (this.child === child) {
        this.child = undefined;
        this.peer = undefined;
        this.ready = undefined;
        this.routes.clear();
        if (this.idle) clearTimeout(this.idle);
      }
    })();
    this.ready = peer
      .request("initialize", { protocol: PI_SIDECAR_PROTOCOL })
      .then(() => {});
    this.ready.catch(() => {});
  }

  /** A request to the sidecar, started first when it is not running. */
  async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    route?: Route,
  ): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (!this.child) this.start();
    const peer = this.peer!;
    try {
      await this.ready;
      const { id, reply } = peer.start(method, params, signal);
      if (route) this.routes.set(id, route);
      try {
        return await reply;
      } finally {
        this.routes.delete(id);
      }
    } finally {
      this.armIdle(peer);
    }
  }

  private armIdle(peer: PiSidecarPeer) {
    if (this.peer !== peer || peer.busy > 0) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (this.peer === peer && peer.busy === 0) void this.close();
    }, this.options.idleMs ?? PI_SIDECAR_IDLE_MS);
    this.idle.unref?.();
  }

  /** Ends the sidecar: its stdin first, a kill three seconds later. */
  async close() {
    const child = this.child;
    if (!child) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    child.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await child.exited.catch(() => null);
    clearTimeout(timer);
  }
}

const shared = new Map<string, PiSidecar>();

/** The sidecar `ROAMGATE_PI_SIDECAR` names, or null for Pi in-process. */
export function piSidecarFromEnv(
  env: Record<string, string | undefined> = process.env,
  runtime: { execPath: string; argv: readonly string[] } = process,
): PiSidecar | null {
  const argv = sidecarCommand(
    env[PI_SIDECAR_ENV],
    isStandaloneBinary(runtime) ? "bun" : runtime.execPath,
  );
  if (!argv) return null;
  const key = JSON.stringify(argv);
  let sidecar = shared.get(key);
  if (!sidecar) {
    const childEnv = { ...env };
    delete childEnv[PI_SIDECAR_ENV];
    sidecar = new PiSidecar({ argv, env: childEnv });
    shared.set(key, sidecar);
  }
  return sidecar;
}

/** Pi's driver for one Ranger directory, run in the sidecar. */
export function createPiSidecarDriver(
  sidecar: PiSidecar,
  directory: string,
  credentialDirectory = directory,
): AssistantDriver {
  const where = { directory, credential_directory: credentialDirectory };
  return {
    async catalog(source) {
      return (await sidecar.call("catalog", { ...where, source })) as Awaited<
        ReturnType<AssistantDriver["catalog"]>
      >;
    },
    async configureModel(input, save) {
      await sidecar.call("configure_model", { ...where, input }, undefined, {
        request: async (method, params) => {
          if (method !== "configure_model.save")
            throw new Error(`Unexpected ${method}`);
          await save(String(params.path), params.value);
          return null;
        },
      });
    },
    async readToolDetails(entries, messages, sourceDirectory) {
      return (await sidecar.call("read_tool_details", {
        ...where,
        entries,
        messages,
        ...(sourceDirectory !== undefined
          ? { source_directory: sourceDirectory }
          : {}),
      })) as Awaited<
        ReturnType<NonNullable<AssistantDriver["readToolDetails"]>>
      >;
    },
    async login(provider, method, interaction) {
      await sidecar.call(
        "login",
        {
          ...where,
          provider,
          method,
          credential_source: interaction.credential_source,
        },
        interaction.signal,
        {
          request: (name, params, signal) => {
            if (name !== "login.prompt") throw new Error(`Unexpected ${name}`);
            const prompt = params.prompt as Parameters<
              Parameters<AssistantDriver["login"]>[2]["prompt"]
            >[0];
            return interaction.prompt({ ...prompt, signal });
          },
          notification: (name, params) => {
            if (name === "login.event")
              interaction.notify(
                params.event as Parameters<
                  Parameters<AssistantDriver["login"]>[2]["notify"]
                >[0],
              );
          },
        },
      );
    },
    async run(input) {
      const handlers = RUN_HANDLERS.filter((name) => input[name] !== undefined);
      const callbacks = RUN_CALLBACKS.filter(
        (name) => input[name] !== undefined,
      );
      return (await sidecar.call(
        "run",
        {
          ...where,
          input: {
            config: input.config,
            entries: input.entries,
            text: input.text,
            ...(input.requestId !== undefined
              ? { request_id: input.requestId }
              : {}),
            ...(input.recover ? { recover: true } : {}),
            ...(input.steers ? { steers: input.steers } : {}),
          },
          callbacks,
          handlers,
        },
        input.signal,
        {
          request: async (method, params, signal) => {
            if (method === "run.checkpoint") {
              await input.checkpoint?.(params.entries as unknown[]);
              return null;
            }
            if (method !== "run.tool") throw new Error(`Unexpected ${method}`);
            const name = params.handler as (typeof RUN_HANDLERS)[number];
            const handler = handlers.includes(name)
              ? (input[name] as (...args: unknown[]) => Promise<unknown>)
              : undefined;
            if (!handler) throw new Error("Unknown tool handler");
            const args = Array.isArray(params.args) ? params.args : [];
            return handler(...args, signal);
          },
          notification: (method, params) => {
            if (method !== "run.event") return;
            const args = Array.isArray(params.args) ? params.args : [];
            switch (params.type) {
              case "delta":
                return input.delta(String(args[0]));
              case "message":
                return input.message(String(args[0]));
              case "tool":
                return input.tool(
                  String(args[0]),
                  String(args[1]),
                  args[2] as "running" | "completed" | "failed",
                  args[3] as Parameters<typeof input.tool>[3],
                );
              case "error":
                return input.error();
              case "replace":
                return input.replace?.(String(args[0]));
              case "thinking":
                return input.thinking?.(args[0] as string[]);
              case "sources":
                return input.sources?.(
                  args[0] as Parameters<NonNullable<typeof input.sources>>[0],
                );
              case "steered":
                return input.steered?.(
                  typeof args[0] === "string" ? args[0] : undefined,
                  String(args[1]),
                );
            }
          },
        },
      )) as unknown[];
    },
    async steer({ text, requestId }) {
      await sidecar.call("steer", { ...where, text, request_id: requestId });
    },
    async stop() {
      if (sidecar.running) await sidecar.call("stop", where);
    },
    async dispose() {
      if (sidecar.running) await sidecar.call("dispose", where);
    },
  };
}
