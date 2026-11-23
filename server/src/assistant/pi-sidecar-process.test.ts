/**
 * The real sidecar (bun pi-sidecar-main.ts) with the real Pi SDK against a
 * local Anthropic-style endpoint, and the files it shares with Pi run in
 * the Bun server: the durable stores, auth.json and models.json, written
 * by one side and read by the other.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantConfig } from "../../../shared/assistant";
import { type AssistantDriver, createPiDriver } from "./pi-driver";
import { createPiSidecarDriver, PiSidecar } from "./pi-sidecar-client";

type RunInput = Parameters<AssistantDriver["run"]>[0];
const MAIN = resolve(import.meta.dir, "pi-sidecar-main.ts");

function events(values: Record<string, unknown>[]) {
  return values
    .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    .join("");
}

function reply(index: number, blocks: Record<string, unknown>[], stop: string) {
  return events([
    {
      type: "message_start",
      message: {
        id: `message-${index}`,
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...blocks,
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ]);
}

function text(value: string, index = 0) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: value },
    },
    { type: "content_block_stop", index },
  ];
}

function toolUse(name: string, id: string, index: number) {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index },
  ];
}

/** Answers from the queue; `hang` keeps the stream open. */
type Answer = string | "hang";
let answers: Answer[] = [];
const requests: { messages: unknown[] }[] = [];
let server: ReturnType<typeof Bun.serve>;
let sidecar: PiSidecar;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as { messages: unknown[] });
      const answer = answers.shift() ?? reply(99, text("Spare."), "end_turn");
      const body =
        answer === "hang"
          ? new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    events([
                      {
                        type: "message_start",
                        message: {
                          id: "hanging",
                          type: "message",
                          role: "assistant",
                          model: "test-model",
                          content: [],
                          stop_reason: null,
                          stop_sequence: null,
                          usage: { input_tokens: 1, output_tokens: 0 },
                        },
                      },
                      ...text("Waiting").slice(0, 2),
                    ]),
                  ),
                );
              },
            })
          : answer;
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  sidecar = new PiSidecar({
    argv: [process.execPath, MAIN],
    env: { ...process.env, ROAMGATE_PI_SIDECAR: undefined },
  });
});

afterAll(async () => {
  await sidecar.close();
  server.stop(true);
});

function ranger() {
  const directory = mkdtempSync(join(tmpdir(), "roamgate-pi-sidecar-"));
  chmodSync(directory, 0o700);
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-key" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, "models.json"),
    JSON.stringify({
      providers: { anthropic: { baseUrl: server.url.href.replace(/\/$/, "") } },
    }),
    { mode: 0o600 },
  );
  answers = [];
  requests.length = 0;
  return directory;
}

const config: AssistantConfig = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  credential_source: "assistant",
  allowed_workspaces: [],
};

function input(overrides: Partial<RunInput> = {}) {
  const seen = {
    deltas: [] as string[],
    tools: [] as string[],
    checkpoints: [] as unknown[],
  };
  const run: RunInput = {
    config,
    entries: [],
    text: "Read the workspace status.",
    signal: new AbortController().signal,
    read: async () => ({ text: "Workspace is running." }),
    delta: (value) => seen.deltas.push(value),
    message: () => {},
    tool: (_id, name, status) => seen.tools.push(`${name} ${status}`),
    error: () => {},
    checkpoint: (entries) => {
      seen.checkpoints.push(entries);
    },
    ...overrides,
  };
  return { run, seen };
}

test("the real sidecar runs a Pi turn with a workspace tool, checkpoints first, and resumes from its durable pointer", async () => {
  const directory = ranger();
  const driver = createPiSidecarDriver(sidecar, directory);
  try {
    answers = [
      reply(
        1,
        [...text("Inspecting."), ...toolUse("workspace_status", "s1", 1)],
        "tool_use",
      ),
      reply(2, text("It runs."), "end_turn"),
    ];
    let reads = 0;
    const first = input({
      read: async (kind) => {
        reads++;
        expect(kind).toBe("status");
        return { text: "Workspace is running." };
      },
    });
    const entries = await driver.run(first.run);
    expect(entries).toEqual([
      { type: "ranger-durable", id: expect.any(String) },
    ]);
    expect(first.seen.checkpoints).toEqual([entries]);
    expect(first.seen.deltas.join("")).toBe("Inspecting.It runs.");
    expect(first.seen.tools).toEqual([
      "workspace_status running",
      "workspace_status completed",
    ]);
    expect(reads).toBe(1);
    const id = (entries[0] as { id: string }).id;
    expect(existsSync(join(directory, "durable", id, "execution.sqlite"))).toBe(
      true,
    );
    answers = [reply(3, text("Still running."), "end_turn")];
    const second = input({ entries, text: "And now?" });
    expect(await driver.run(second.run)).toEqual(entries);
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("It runs.");
    const details = await driver.readToolDetails!(entries, [
      {
        id: "m1",
        role: "assistant",
        text: "It runs.",
        sent_at: "2026-11-23T00:00:00Z",
        sources: [],
        tools: [{ id: "s1", name: "workspace_status", status: "completed" }],
      },
    ]);
    expect(details[0]!.tools[0]!.output).toContain("Workspace is running.");
    // Stopping a streaming turn through the sidecar ends it.
    answers = ["hang"];
    const streaming = Promise.withResolvers<void>();
    const third = driver.run(
      input({
        entries,
        text: "Wait.",
        delta: (value) => {
          if (value === "Waiting") streaming.resolve();
        },
      }).run,
    );
    await streaming.promise;
    await driver.stop();
    await third.catch(() => {});
  } finally {
    await driver.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a chat Pi started in the Bun server continues in the sidecar, and back", async () => {
  const directory = ranger();
  const local = createPiDriver(directory);
  const remote = createPiSidecarDriver(sidecar, directory);
  try {
    answers = [reply(1, text("First, in Bun."), "end_turn")];
    const entries = await local.run(input({ text: "One" }).run);
    answers = [reply(2, text("Second, in the sidecar."), "end_turn")];
    expect(await remote.run(input({ entries, text: "Two" }).run)).toEqual(
      entries,
    );
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(
      "First, in Bun.",
    );
    answers = [reply(3, text("Third, in Bun again."), "end_turn")];
    expect(await local.run(input({ entries, text: "Three" }).run)).toEqual(
      entries,
    );
    const history = JSON.stringify(requests.at(-1)!.messages);
    expect(history).toContain("First, in Bun.");
    expect(history).toContain("Second, in the sidecar.");
  } finally {
    await local.dispose();
    await remote.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("the sidecar and the Bun server never own one durable store at once", async () => {
  const directory = ranger();
  const local = createPiDriver(directory);
  const remote = createPiSidecarDriver(sidecar, directory);
  try {
    answers = [reply(1, text("Saved."), "end_turn")];
    const entries = await local.run(input({ text: "One" }).run);
    answers = ["hang"];
    const streaming = Promise.withResolvers<void>();
    const held = remote.run(
      input({
        entries,
        text: "Hold it.",
        delta: (value) => {
          if (value === "Waiting") streaming.resolve();
        },
      }).run,
    );
    await streaming.promise;
    const before = requests.length;
    const controller = new AbortController();
    let settled = false;
    const second = local
      .run(input({ entries, text: "Me too.", signal: controller.signal }).run)
      .finally(() => {
        settled = true;
      });
    await Bun.sleep(300);
    // Still waiting for the store the sidecar holds.
    expect(settled).toBe(false);
    controller.abort(new Error("gave up"));
    await second.catch(() => {});
    expect(requests.length).toBe(before);
    await remote.stop();
    await held.catch(() => {});
    answers = [reply(2, text("Mine now."), "end_turn")];
    expect(await local.run(input({ entries, text: "Now?" }).run)).toEqual(
      entries,
    );
  } finally {
    await local.dispose();
    await remote.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("credentials and model connections written on one side are read by the other", async () => {
  const directory = ranger();
  rmSync(join(directory, "auth.json"));
  const local = createPiDriver(directory);
  const remote = createPiSidecarDriver(sidecar, directory);
  const configured = async (driver: AssistantDriver, provider: string) =>
    (await driver.catalog("assistant")).providers.find(
      (entry) => entry.id === provider,
    )?.configured;
  try {
    expect(await configured(remote, "anthropic")).toBe(false);
    await remote.login("anthropic", "api_key", {
      credential_source: "assistant",
      signal: new AbortController().signal,
      prompt: async () => "synthetic-sidecar-key",
      notify: () => {},
    });
    const auth = JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"));
    expect(auth.anthropic).toMatchObject({
      type: "api_key",
      key: "synthetic-sidecar-key",
    });
    expect(await configured(createPiDriver(directory), "anthropic")).toBe(true);
    await local.login("openai", "api_key", {
      credential_source: "assistant",
      signal: new AbortController().signal,
      prompt: async () => "synthetic-bun-key",
      notify: () => {},
    });
    await remote.dispose();
    expect(await configured(remote, "openai")).toBe(true);
    // A model connection: the sidecar asks the server to save models.json,
    // then reads it back.
    const saves: string[] = [];
    await remote.configureModel!(
      {
        provider: "local-llm",
        model: "small",
        base_url: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        api_key: "synthetic-local-key",
        credential_source: "assistant",
      },
      (path, value) => {
        saves.push(path);
        writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      },
    );
    expect(saves).toEqual([join(directory, "models.json")]);
    const catalog = await createPiDriver(directory).catalog("assistant");
    expect(catalog.models.some((model) => model.provider === "local-llm")).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"))[
        "local-llm"
      ],
    ).toMatchObject({ type: "api_key", key: "synthetic-local-key" });
  } finally {
    await local.dispose();
    await remote.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
