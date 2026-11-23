import { expect, test } from "bun:test";
import type { AssistantConfig } from "../../../shared/assistant";
import { AssistantUserError } from "./errors";
import type { AssistantDriver } from "./pi-driver";
import {
  createPiSidecarDriver,
  PiSidecar,
  piSidecarFromEnv,
  type SidecarChild,
  type SpawnSidecar,
} from "./pi-sidecar-client";
import { PiSidecarPeer } from "./pi-sidecar-peer";
import { createPiSidecarServer } from "./pi-sidecar-server";

type RunInput = Parameters<AssistantDriver["run"]>[0];
const config: AssistantConfig = {
  provider: "anthropic",
  model: "test",
  credential_source: "assistant",
  allowed_workspaces: [],
};

/** A queue of lines read as an async iterable. */
function lineQueue() {
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(line: string) {
      lines.push(line);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (lines.length) {
          yield lines.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

/**
 * The sidecar's server in this process behind a fake child: the client,
 * peer and server as the real process runs them, without the process.
 */
function inProcess(
  createDriver: (directory: string, credentials: string) => AssistantDriver,
) {
  const spawned: { argv: string[]; child: SidecarChild; kill(): void }[] = [];
  const spawn: SpawnSidecar = (argv) => {
    const out = lineQueue();
    const exited = Promise.withResolvers<number | null>();
    const server = createPiSidecarServer({
      write: (line) => out.push(line.replace(/\n$/, "")),
      createDriver,
    });
    let alive = true;
    const stop = (code: number | null) => {
      if (!alive) return;
      alive = false;
      void server.close();
      out.end();
      exited.resolve(code);
    };
    const child: SidecarChild = {
      write: (line) => {
        if (alive)
          for (const part of line.split("\n")) if (part) server.receive(part);
      },
      lines: out,
      end: () => stop(0),
      kill: () => stop(null),
      exited: exited.promise,
    };
    spawned.push({ argv, child, kill: () => stop(null) });
    return child;
  };
  return { spawn, spawned };
}

function fakeDriver(overrides: Partial<AssistantDriver> = {}): AssistantDriver {
  return {
    catalog: async () => ({ providers: [], models: [] }),
    login: async () => {},
    run: async () => [],
    stop: async () => {},
    dispose: async () => {},
    ...overrides,
  };
}

function runInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    config,
    entries: [],
    text: "Hello",
    signal: new AbortController().signal,
    read: async () => ({ text: "read" }),
    delta: () => {},
    message: () => {},
    tool: () => {},
    error: () => {},
    ...overrides,
  };
}

test("a run streams its events in order and returns the entries Pi kept", async () => {
  const seen: RunInput[] = [];
  const { spawn } = inProcess(() =>
    fakeDriver({
      async run(input) {
        seen.push(input);
        input.delta("Hel");
        input.delta("lo");
        input.tool("t1", "workspace_status", "running");
        input.tool("t1", "workspace_status", "completed", {
          arguments: "{}",
          output: "ok",
        });
        input.thinking?.(["Thinking"]);
        input.sources?.([]);
        input.replace?.("Hello");
        input.steered?.(undefined, "more");
        input.message("Hello");
        input.error();
        return [{ type: "ranger-durable", id: "d1" }];
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger", "/credentials");
  const events: unknown[] = [];
  const entries = await driver.run(
    runInput({
      requestId: "q1",
      steers: [{ requestId: "s1", text: "earlier" }],
      delta: (text) => events.push(["delta", text]),
      message: (text) => events.push(["message", text]),
      tool: (...args) => events.push(["tool", ...args]),
      error: () => events.push(["error"]),
      thinking: (steps) => events.push(["thinking", steps]),
      sources: (sources) => events.push(["sources", sources]),
      replace: (text) => events.push(["replace", text]),
      steered: (id, text) => events.push(["steered", id, text]),
    }),
  );
  expect(entries).toEqual([{ type: "ranger-durable", id: "d1" }]);
  expect(events).toEqual([
    ["delta", "Hel"],
    ["delta", "lo"],
    ["tool", "t1", "workspace_status", "running", undefined],
    [
      "tool",
      "t1",
      "workspace_status",
      "completed",
      { arguments: "{}", output: "ok" },
    ],
    ["thinking", ["Thinking"]],
    ["sources", []],
    ["replace", "Hello"],
    ["steered", undefined, "more"],
    ["message", "Hello"],
    ["error"],
  ]);
  expect(seen[0]!.requestId).toBe("q1");
  expect(seen[0]!.steers).toEqual([{ requestId: "s1", text: "earlier" }]);
  await sidecar.close();
});

test("a callback the parent left out stays out in the sidecar", async () => {
  const seen: RunInput[] = [];
  const { spawn } = inProcess(() =>
    fakeDriver({
      async run(input) {
        seen.push(input);
        return [];
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  await driver.run(runInput({ replace: () => {} }));
  expect(seen[0]!.replace).toBeFunction();
  for (const name of ["checkpoint", "thinking", "sources", "steered"] as const)
    expect(seen[0]![name]).toBeUndefined();
  for (const name of [
    "propose",
    "task",
    "notify",
    "show",
    "arrange",
    "threads",
    "archive",
  ] as const)
    expect(seen[0]![name]).toBeUndefined();
  await sidecar.close();
});

test("checkpoint and save are answered before the sidecar goes on", async () => {
  const order: string[] = [];
  const { spawn } = inProcess(() =>
    fakeDriver({
      async run(input) {
        await input.checkpoint?.([{ type: "ranger-durable", id: "d2" }]);
        order.push("admitted");
        return [];
      },
      async configureModel(_input, save) {
        await save("/ranger/models.json", { providers: {} });
        order.push("reloaded");
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  await driver.run(
    runInput({
      checkpoint: async (entries) => {
        await Bun.sleep(20);
        order.push(`checkpoint ${JSON.stringify(entries)}`);
      },
    }),
  );
  await driver.configureModel!(
    {
      provider: "custom",
      model: "m",
      base_url: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      credential_source: "assistant",
    },
    async (path, value) => {
      await Bun.sleep(20);
      order.push(`save ${path} ${JSON.stringify(value)}`);
    },
  );
  expect(order).toEqual([
    'checkpoint [{"type":"ranger-durable","id":"d2"}]',
    "admitted",
    'save /ranger/models.json {"providers":{}}',
    "reloaded",
  ]);
  await sidecar.close();
});

test("a failed save fails the model configuration in the sidecar", async () => {
  const { spawn } = inProcess(() =>
    fakeDriver({
      async configureModel(_input, save) {
        await save("/ranger/models.json", {});
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  await expect(
    driver.configureModel!(
      {
        provider: "custom",
        model: "m",
        base_url: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        credential_source: "assistant",
      },
      () => {
        throw new Error("Saved session is too large");
      },
    ),
  ).rejects.toThrow("Saved session is too large");
  await sidecar.close();
});

test("tool calls reach the handlers the run declared, with their signal, and no other", async () => {
  const calls: unknown[] = [];
  const { spawn } = inProcess(() =>
    fakeDriver({
      async run(input) {
        const controller = new AbortController();
        calls.push(await input.read("status", { a: 1 }, controller.signal));
        calls.push(await input.task!("list", {}));
        calls.push(
          await input.notify!({ title: "T", body: "B" } as never, undefined),
        );
        calls.push(
          await input.show!({ connection_id: "c", workspace_id: "w" }),
        );
        return [];
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  const signals: unknown[] = [];
  await driver.run(
    runInput({
      read: async (kind, params, signal) => {
        signals.push(signal instanceof AbortSignal);
        return { text: `read ${kind} ${JSON.stringify(params)}` };
      },
      task: async (kind) => ({ text: `task ${kind}` }),
      notify: async (input) => ({ text: `notify ${JSON.stringify(input)}` }),
      show: async (params) => ({ text: `show ${params.workspace_id}` }),
    }),
  );
  expect(calls).toEqual([
    { text: 'read status {"a":1}' },
    { text: "task list" },
    { text: 'notify {"title":"T","body":"B"}' },
    { text: "show w" },
  ]);
  expect(signals).toEqual([true]);
  await sidecar.close();
});

test("a user error keeps its class across the wire, other errors their message", async () => {
  const results: unknown[] = [];
  const { spawn } = inProcess(() =>
    fakeDriver({
      async run(input) {
        for (const kind of ["user", "other"] as const)
          try {
            await input.read(kind as never, {});
          } catch (error) {
            results.push([
              error instanceof AssistantUserError,
              (error as Error).message,
            ]);
          }
        throw new AssistantUserError("Model unavailable");
      },
      async catalog() {
        throw new Error("Invalid model configuration");
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  const failure = await driver
    .run(
      runInput({
        read: async (kind) => {
          if (kind === ("user" as never))
            throw new AssistantUserError("Invalid workspace.");
          throw new Error("socket /run/x refused");
        },
      }),
    )
    .catch((error) => error);
  expect(failure).toBeInstanceOf(AssistantUserError);
  expect(failure.message).toBe("Model unavailable");
  expect(results).toEqual([
    [true, "Invalid workspace."],
    [false, "socket /run/x refused"],
  ]);
  const catalog = await driver.catalog("assistant").catch((error) => error);
  expect(catalog).not.toBeInstanceOf(AssistantUserError);
  expect(catalog.message).toBe("Invalid model configuration");
  await sidecar.close();
});

test("cancelling a run aborts it in the sidecar", async () => {
  let aborted: unknown;
  const started = Promise.withResolvers<void>();
  const { spawn } = inProcess(() =>
    fakeDriver({
      run: (input) =>
        new Promise((_, reject) => {
          started.resolve();
          input.signal.addEventListener("abort", () => {
            aborted = input.signal.reason;
            reject(new Error("Ranger stopped"));
          });
        }),
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  const controller = new AbortController();
  const run = driver.run(runInput({ signal: controller.signal }));
  await started.promise;
  controller.abort(new Error("stop"));
  await expect(run).rejects.toThrow("Ranger stopped");
  expect(aborted).toBeInstanceOf(Error);
  await sidecar.close();
});

test("steer and stop reach the driver of their directory", async () => {
  const calls: string[] = [];
  const { spawn } = inProcess((directory) =>
    fakeDriver({
      steer: async ({ text, requestId }) => {
        calls.push(`${directory} steer ${text} ${requestId}`);
      },
      stop: async () => {
        calls.push(`${directory} stop`);
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const a = createPiSidecarDriver(sidecar, "/a");
  const b = createPiSidecarDriver(sidecar, "/b", "/a");
  await a.steer!({ text: "more", requestId: "r1" });
  await b.stop();
  await a.stop();
  expect(calls).toEqual(["/a steer more r1", "/b stop", "/a stop"]);
  await sidecar.close();
});

test("drivers are kept per directory pair and dispose forgets one", async () => {
  const created: string[] = [];
  const disposed: string[] = [];
  const { spawn } = inProcess((directory, credentials) => {
    created.push(`${directory}|${credentials}`);
    return fakeDriver({
      dispose: async () => {
        disposed.push(directory);
      },
    });
  });
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const main = createPiSidecarDriver(sidecar, "/ranger");
  const task = createPiSidecarDriver(sidecar, "/ranger/tasks/t1", "/ranger");
  await main.catalog("assistant");
  await main.catalog("pi");
  await task.catalog("assistant");
  await task.dispose();
  await task.catalog("assistant");
  expect(created).toEqual([
    "/ranger|/ranger",
    "/ranger/tasks/t1|/ranger",
    "/ranger/tasks/t1|/ranger",
  ]);
  expect(disposed).toEqual(["/ranger/tasks/t1"]);
  await sidecar.close();
});

test("login prompts and events go through the interaction, and a cancelled login aborts its prompt", async () => {
  const { spawn } = inProcess(() =>
    fakeDriver({
      async login(provider, method, interaction) {
        interaction.notify({ type: "info", message: `${provider} ${method}` });
        interaction.notify({
          type: "device_code",
          userCode: "ABCD",
          verificationUri: "https://example.test/device",
        });
        const answer = await interaction.prompt({
          type: "select",
          message: "Pick",
          options: [{ id: "a", label: "A" }],
        });
        interaction.notify({ type: "progress", message: `got ${answer}` });
        if (answer === "wait")
          await interaction.prompt({ type: "secret", message: "Key" });
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  const events: unknown[] = [];
  const prompts: unknown[] = [];
  await driver.login("kimi", "oauth", {
    credential_source: "assistant",
    signal: new AbortController().signal,
    notify: (event) => events.push(event),
    prompt: async (prompt) => {
      prompts.push({ ...prompt, signal: prompt.signal instanceof AbortSignal });
      return "a";
    },
  });
  expect(events).toEqual([
    { type: "info", message: "kimi oauth" },
    {
      type: "device_code",
      userCode: "ABCD",
      verificationUri: "https://example.test/device",
    },
    { type: "progress", message: "got a" },
  ]);
  expect(prompts).toEqual([
    {
      type: "select",
      message: "Pick",
      options: [{ id: "a", label: "A" }],
      signal: true,
    },
  ]);
  const controller = new AbortController();
  const waiting = Promise.withResolvers<void>();
  let promptAborted = false;
  const login = driver.login("kimi", "api_key", {
    credential_source: "assistant",
    signal: controller.signal,
    notify: () => {},
    prompt: (prompt) => {
      if (prompt.type === "select") return Promise.resolve("wait");
      waiting.resolve();
      return new Promise((_, reject) =>
        prompt.signal!.addEventListener("abort", () => {
          promptAborted = true;
          reject(new Error("Login cancelled"));
        }),
      );
    },
  });
  await waiting.promise;
  controller.abort(new Error("cancel"));
  await expect(login).rejects.toThrow();
  expect(promptAborted).toBe(true);
  await sidecar.close();
});

test("the sidecar exiting fails what is in flight, and the next call starts it again", async () => {
  const started = Promise.withResolvers<void>();
  const { spawn, spawned } = inProcess(() =>
    fakeDriver({
      run: () => {
        started.resolve();
        return new Promise(() => {});
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  const run = driver.run(runInput());
  await started.promise;
  spawned[0]!.kill();
  await expect(run).rejects.toThrow("The Pi sidecar exited (signal)");
  await Bun.sleep(0);
  expect(sidecar.running).toBe(false);
  await driver.catalog("assistant");
  expect(spawned).toHaveLength(2);
  await sidecar.close();
});

test("the sidecar stops after its idle time, never while a call is in flight", async () => {
  const release = Promise.withResolvers<void>();
  const { spawn, spawned } = inProcess(() =>
    fakeDriver({
      run: async () => {
        await release.promise;
        return [];
      },
    }),
  );
  const sidecar = new PiSidecar({ argv: ["pi"], spawn, idleMs: 30 });
  const driver = createPiSidecarDriver(sidecar, "/ranger");
  const run = driver.run(runInput());
  await driver.catalog("assistant");
  await Bun.sleep(80);
  expect(sidecar.running).toBe(true);
  release.resolve();
  await run;
  await Bun.sleep(80);
  expect(sidecar.running).toBe(false);
  expect(await spawned[0]!.child.exited).toBe(0);
  // Stop and dispose do not start a sidecar that is not running.
  await driver.stop();
  await driver.dispose();
  expect(spawned).toHaveLength(1);
});

test("output that is not a message is logged and skipped", () => {
  const logged: string[] = [];
  const written: string[] = [];
  const peer = new PiSidecarPeer(
    (line) => written.push(line),
    {
      request: async () => null,
      notification: () => {},
    },
    (message) => logged.push(message),
  );
  peer.receive("Deprecation (warning): something");
  peer.receive("");
  peer.receive('{"jsonrpc":"2.0","id":99,"result":1}');
  expect(logged).toEqual([
    "not a message: Deprecation (warning): something",
    "a reply to no request: 99",
  ]);
  expect(written).toEqual([]);
});

test("an unknown method is refused with its JSON-RPC code", async () => {
  const lines: string[] = [];
  const server = createPiSidecarServer({
    write: (line) => lines.push(line),
    createDriver: () => fakeDriver(),
  });
  server.receive('{"jsonrpc":"2.0","id":1,"method":"nope","params":{}}');
  server.receive(
    '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocol":2}}',
  );
  server.receive(
    '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocol":1}}',
  );
  await Bun.sleep(0);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Unknown method nope" },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "Pi sidecar protocol 2 is not 1" },
    },
    { jsonrpc: "2.0", id: 3, result: { protocol: 1, pid: process.pid } },
  ]);
  await server.close();
});

test("Ranger uses the sidecar only when ROAMGATE_PI_SIDECAR names it", () => {
  const source = { execPath: "/usr/bin/bun", argv: ["bun", "src/index.ts"] };
  expect(piSidecarFromEnv({}, source)).toBeNull();
  expect(piSidecarFromEnv({ ROAMGATE_PI_SIDECAR: "" }, source)).toBeNull();
  const a = piSidecarFromEnv({ ROAMGATE_PI_SIDECAR: "/x/roamgate-pi" }, source);
  expect(a).toBeInstanceOf(PiSidecar);
  expect(
    piSidecarFromEnv({ ROAMGATE_PI_SIDECAR: "/x/roamgate-pi" }, source),
  ).toBe(a!);
});
