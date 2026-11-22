/** The measurements of the Rust migration plan's section 5.9. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { BenchClient, byteCounter, login } from "./client";
import {
  archiveRaw,
  type BenchEnv,
  connect,
  herdr,
  PASSWORD,
  REPO,
  reportClaudeIdle,
  rssTree,
  type ServerHandle,
  serverCommand,
  sha256,
  startServer,
  TestClock,
  waitConnectionReady,
} from "./env";

export type Stats = {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
};

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
    ] ?? 0;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(
      sorted.reduce((sum, value) => sum + value, 0) /
        Math.max(1, sorted.length),
    ),
  };
}

const median = (values: number[]) => stats(values).p50;

export type Options = { quick: boolean; log: (line: string) => void };

/** Server start to /healthz, to the first /ws hello, to a ready connection. */
export async function measureStartup(env: BenchEnv, options: Options) {
  const runs = options.quick ? 2 : 7;
  const samples: {
    ready_ms: number;
    hello_ms: number;
    connection_ready_ms: number;
  }[] = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    const server = await startServer(env, { label: `startup-${index}` });
    try {
      const client = await connect(server.base);
      const helloMs = performance.now() - start;
      await waitConnectionReady(client);
      const readyAll = performance.now() - start;
      samples.push({
        // The handle's own spawn-to-200 time; start above includes a port pick.
        ready_ms: server.readyMs,
        hello_ms: helloMs,
        connection_ready_ms: readyAll,
      });
      client.close();
    } finally {
      await server.stop();
    }
  }
  // The first run warms the file cache and Bun's transpiler cache.
  const kept = runs > 2 ? samples.slice(1) : samples;
  return {
    runs: samples,
    ready_ms: stats(kept.map((s) => s.ready_ms)),
    hello_ms: stats(kept.map((s) => s.hello_ms)),
    connection_ready_ms: stats(kept.map((s) => s.connection_ready_ms)),
  };
}

function startTicker(env: BenchEnv, pane: string) {
  // A clock line a second: the stream stays warm without flooding it.
  herdr(env, [
    "pane",
    "send-text",
    pane,
    "while :; do date +%T.%N; sleep 1; done\n",
  ]);
}

function stopPane(env: BenchEnv, pane: string) {
  herdr(env, ["pane", "send-keys", pane, "C-c"]);
}

async function sampleRss(pid: number, count: number, everyMs: number) {
  const self: number[] = [];
  const tree: number[] = [];
  for (let index = 0; index < count; index++) {
    const rss = rssTree(pid);
    self.push(rss.self);
    tree.push(rss.tree);
    await Bun.sleep(everyMs);
  }
  return {
    self_kb: median(self),
    tree_kb: median(tree),
    samples_self_kb: self,
  };
}

/** RSS idle, then with 3 connections and 20 warm terminal streams. */
export async function measureRss(env: BenchEnv, options: Options) {
  const settle = options.quick ? 3000 : 15_000;
  const server = await startServer(env, { label: "rss" });
  const clients: BenchClient[] = [];
  try {
    const first = await connect(server.base);
    clients.push(first);
    await waitConnectionReady(first);
    await Bun.sleep(settle);
    const idle = await sampleRss(server.pid, 5, 1000);
    for (const terminal of env.terminals) startTicker(env, terminal.pane_id);
    clients.push(await connect(server.base), await connect(server.base));
    let frames = 0;
    for (const client of clients)
      client.on((message) => {
        if (message.terminal) frames += 1;
      });
    await Promise.all(
      env.terminals.map((terminal, index) =>
        clients[index % clients.length]!.call("terminal.attach", {
          terminal_id: terminal.terminal_id,
          cols: 120,
          rows: 40,
          relay_active: false,
        }),
      ),
    );
    await Bun.sleep(settle);
    const framesBefore = frames;
    const loaded = await sampleRss(server.pid, 5, 1000);
    const framesPerSecond = (frames - framesBefore) / 5;
    for (const terminal of env.terminals) stopPane(env, terminal.pane_id);
    return {
      idle,
      three_connections_20_terminals: {
        ...loaded,
        terminal_frames_per_s: framesPerSecond,
      },
      terminals: env.terminals.length,
      connections: clients.length,
    };
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
}

/** The review with the most threads in the copied store. */
function biggestReview(env: BenchEnv): { id: string; threads: number } | null {
  const db = join(env.home, ".config/roamgate/reviews/reviews.sqlite");
  if (!existsSync(db)) return null;
  const out = spawnSync(
    "sqlite3",
    [
      "-readonly",
      db,
      "select session_id, count(*) from threads group by session_id order by count(*) desc, session_id limit 1;",
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  const [id, threads] = out.split("|");
  return id ? { id, threads: Number(threads) } : null;
}

export async function waitForQuiet(
  path: string,
  quietMs: number,
  timeoutMs = 120_000,
) {
  const start = performance.now();
  let size = existsSync(path) ? statSync(path).size : 0;
  let since = performance.now();
  while (performance.now() - start < timeoutMs) {
    await Bun.sleep(100);
    const now = existsSync(path) ? statSync(path).size : 0;
    if (now !== size) {
      size = now;
      since = performance.now();
    } else if (performance.now() - since >= quietMs) return;
  }
}

function readJsonl(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** RPC latency p50 and p99 per family, 1000 calls each after a warm-up. */
export async function measureRpc(env: BenchEnv, options: Options) {
  const calls = options.quick ? 100 : 1000;
  const warmup = options.quick ? 10 : 50;
  const budgetMs = options.quick ? 20_000 : 180_000;
  const server = await startServer(env, { label: "rpc" });
  try {
    const client = await connect(server.base);
    await waitConnectionReady(client);
    // The inbox has its entries (from the fake forges) before it is read.
    await client.call("bridge.mr_reviews.inbox", { fresh: true });
    await waitForQuiet(env.logs.forge, 2000);
    const review = biggestReview(env);
    const methods: [string, Record<string, unknown>][] = [
      ["file.list", { workspace_id: env.workspaceId, path: "server/src" }],
      ["git.diff_summary", { workspace_id: env.workspaceId }],
      ...(review
        ? ([["review.get", { session_id: review.id }]] as [
            string,
            Record<string, unknown>,
          ][])
        : []),
      ...(env.agentPane
        ? ([
            [
              "agent_history.get",
              { pane_id: env.agentPane.pane_id, workspace_id: env.workspaceId },
            ],
          ] as [string, Record<string, unknown>][])
        : []),
      ["bridge.work.board", {}],
      ["bridge.mr_reviews.inbox", {}],
    ];
    const results: Record<string, unknown> = {};
    for (const [method, params] of methods) {
      let size = 0;
      const warmStart = performance.now();
      for (let index = 0; index < warmup; index++) {
        const reply = await client.call(method, params);
        size = JSON.stringify(reply).length;
        if (index >= 5 && performance.now() - warmStart > 20_000) break;
      }
      // 1000 calls, or as many as fit in the time budget for a slow
      // method (at least 200).
      const latencies: number[] = [];
      const began = performance.now();
      for (let index = 0; index < calls; index++) {
        const start = performance.now();
        await client.call(method, params);
        latencies.push(performance.now() - start);
        if (
          index + 1 >= Math.min(200, calls) &&
          performance.now() - began > budgetMs
        )
          break;
      }
      results[method] = { ms: stats(latencies), reply_chars: size };
      options.log(
        `rpc ${method}: p50 ${stats(latencies).p50} ms, p99 ${stats(latencies).p99} ms`,
      );
    }
    client.close();
    return {
      calls_per_method: calls,
      warmup_per_method: warmup,
      fixtures: {
        review: review ? { threads: review.threads } : null,
        agent_transcript_sha256: env.agentPane?.sha256 ?? null,
      },
      methods: results,
    };
  } finally {
    await server.stop();
  }
}

function terminalText(message: Record<string, any>): string {
  const bytes = message.terminal?.bytes;
  return typeof bytes === "string"
    ? Buffer.from(bytes, "base64").toString("latin1")
    : "";
}

/** A fixed, colored text: the fixture's own history with patches. */
function floodFile(env: BenchEnv) {
  const path = join(env.root, "flood.txt");
  if (!existsSync(path)) {
    const out = spawnSync(
      "git",
      ["-C", env.repo, "log", "-p", "--color=always", "-n", "400", "HEAD"],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
    ).stdout;
    writeFileSync(path, out.subarray(0, 4 * 1024 * 1024));
  }
  return path;
}

/**
 * Terminal throughput (a pane printing as fast as it can for a fixed time),
 * input-to-echo frame latency, and the bytes a scripted terminal session
 * costs on the wire with and without per-message deflate.
 */
export async function measureTerminal(env: BenchEnv, options: Options) {
  const server = await startServer(env, { label: "terminal" });
  const proxy = await byteCounter(server.port);
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    const cookie = await login(base, PASSWORD);
    const client = new BenchClient(base, cookie);
    await client.open();
    await waitConnectionReady(client);
    const extensions = client.ws.extensions;

    // Throughput: the flood pane at 160x48.
    const flood = env.panes.flood!;
    const file = floodFile(env);
    const seconds = options.quick ? 4 : 10;
    let frames = 0;
    let payload = 0;
    let decoded = 0;
    let counting = false;
    const off = client.on((message) => {
      if (!counting || message.terminal === undefined) return;
      const terminal = message.terminal as Record<string, unknown>;
      if (terminal.terminal_id !== flood.terminal_id) return;
      frames += 1;
      payload += JSON.stringify(message).length;
      decoded += terminalText(message).length;
    });
    await client.call("terminal.attach", {
      terminal_id: flood.terminal_id,
      cols: 160,
      rows: 48,
      relay_active: false,
    });
    await Bun.sleep(1000);
    herdr(env, [
      "pane",
      "send-text",
      flood.pane_id,
      `clear; end=$(($(date +%s) + ${seconds + 3})); while [ $(date +%s) -lt $end ]; do cat ${file}; done\n`,
    ]);
    await Bun.sleep(1500);
    proxy.reset();
    counting = true;
    const start = performance.now();
    await Bun.sleep(seconds * 1000);
    counting = false;
    const elapsed = (performance.now() - start) / 1000;
    const throughput = {
      seconds: elapsed,
      frames_per_s: frames / elapsed,
      message_chars_per_s: payload / elapsed,
      ansi_bytes_per_s: decoded / elapsed,
      wire_bytes_down_per_s: proxy.counts.down / elapsed,
      size: "160x48",
    };
    off();
    await client.call("terminal.detach", { terminal_id: flood.terminal_id });
    await Bun.sleep(4000);

    // Frame latency: a keystroke in the echo pane until a frame shows it.
    const echo = env.panes.echo!;
    let waiting: { token: string; resolve: (at: number) => void } | null = null;
    const offEcho = client.on((message, at) => {
      if (!waiting || message.terminal === undefined) return;
      if (
        (message.terminal as Record<string, unknown>).terminal_id !==
        echo.terminal_id
      )
        return;
      if (terminalText(message).includes(waiting.token)) {
        const current = waiting;
        waiting = null;
        current.resolve(at);
      }
    });
    await client.call("terminal.attach", {
      terminal_id: echo.terminal_id,
      cols: 120,
      rows: 40,
      relay_active: false,
    });
    await Bun.sleep(1000);
    const samples = options.quick ? 30 : 200;
    const latencies: number[] = [];
    const input = (text: string) =>
      client.call("terminal.input", {
        terminal_id: echo.terminal_id,
        data: Buffer.from(text).toString("base64"),
      });
    for (let index = 0; index < samples; index++) {
      const token = `zq${index.toString(36).padStart(4, "0")}`;
      const seen = new Promise<number>((resolve) => {
        waiting = { token, resolve };
      });
      const sent = performance.now();
      await input(token);
      const at = await Promise.race([seen, Bun.sleep(5000).then(() => -1)]);
      if (at > 0) latencies.push(at - sent);
      waiting = null;
      await input("\x15");
      await Bun.sleep(40);
    }
    offEcho();
    await client.call("terminal.detach", { terminal_id: echo.terminal_id });
    client.close();
    const latency = { ms: stats(latencies), lost: samples - latencies.length };

    // Bytes on the wire for one scripted session, with and without deflate.
    const wire = await scriptedSession(env, server, proxy);
    return { websocket_extensions: extensions, throughput, latency, wire };
  } finally {
    proxy.stop();
    await server.stop();
  }
}

async function scriptedSession(
  env: BenchEnv,
  server: ServerHandle,
  proxy: Awaited<ReturnType<typeof byteCounter>>,
) {
  const pane = env.panes.echo!;
  const steps = [
    "clear\n",
    "ls -la server/src\n",
    "git log --oneline -40\n",
    "cat package.json\n",
    "git status --short | head -40\n",
    "seq 1 300\n",
    "clear\n",
  ];
  const result: Record<string, unknown> = {};
  for (const mode of ["deflate", "plain"] as const) {
    const cookie = await login(`http://127.0.0.1:${proxy.port}`, PASSWORD);
    proxy.reset();
    const client = new BenchClient(`http://127.0.0.1:${proxy.port}`, cookie);
    await client.open(mode === "plain" ? { perMessageDeflate: false } : {});
    await waitConnectionReady(client);
    const afterHello = {
      up: proxy.counts.up,
      down: proxy.counts.down,
      chars: client.received,
    };
    await client.call("terminal.attach", {
      terminal_id: pane.terminal_id,
      cols: 120,
      rows: 40,
      relay_active: false,
    });
    await Bun.sleep(800);
    for (const step of steps) {
      await client.call("terminal.input", {
        terminal_id: pane.terminal_id,
        data: Buffer.from(step).toString("base64"),
      });
      await Bun.sleep(700);
    }
    await client.call("terminal.detach", { terminal_id: pane.terminal_id });
    await Bun.sleep(500);
    result[mode] = {
      extensions: client.ws.extensions,
      wire_bytes_down: proxy.counts.down - afterHello.down,
      wire_bytes_up: proxy.counts.up - afterHello.up,
      message_chars_down: client.received - afterHello.chars,
    };
    client.close();
    await Bun.sleep(300);
  }
  return { steps: steps.length, ...result };
}

/**
 * Git status for N workspaces of an ssh host (the fake ssh, which counts
 * logins, master sessions and multiplexed sessions).
 */
export async function measureSsh(env: BenchEnv, options: Options) {
  writeFileSync(env.logs.ssh, "");
  const start = performance.now();
  const server = await startServer(env, { label: "ssh", connections: "ssh" });
  try {
    const client = await connect(server.base);
    const connected = await waitConnectionReady(client, "bench-ssh");
    const connectedMs = performance.now() - start;
    // The first list's batch (cold statuses) finishes with the connection's
    // own setup: both count as connecting.
    await waitForQuiet(env.logs.ssh, 3000);
    const afterConnect = readJsonl(env.logs.ssh).length;
    const rounds = options.quick ? 2 : 5;
    const runs: Record<string, unknown>[] = [];
    let lastBatch = performance.now();
    for (let round = 0; round < rounds; round++) {
      // Every checkout gets a new file, and the cached statuses age past the
      // refresh period (GIT_STATUS_REFRESH_MS, 20 s): the next list makes
      // one batch for all of them and pushes every status.
      for (const repo of env.sshRepos)
        writeFileSync(
          join(repo, `bench-round-${round}.txt`),
          `round ${round}\n`,
        );
      const wait = 21_000 - (performance.now() - lastBatch);
      if (wait > 0) await Bun.sleep(wait);
      const before = readJsonl(env.logs.ssh).length;
      const seen = new Set<string>();
      const done = Promise.withResolvers<number>();
      const off = client.on((message, at) => {
        const data =
          (message as Record<string, any>).event === "workspace.git_status"
            ? (message as Record<string, any>).data
            : (message as Record<string, any>).type === "workspace.git_status"
              ? message
              : null;
        const statuses = data?.statuses as
          | { checkout_path: string }[]
          | undefined;
        if (!statuses) return;
        for (const status of statuses) seen.add(status.checkout_path);
        if (seen.size >= env.sshRepos.length) done.resolve(at);
      });
      const sent = performance.now();
      const list = await client.call<Record<string, any>>(
        "workspace.list",
        {},
        "bench-ssh",
      );
      void list;
      const at =
        seen.size >= env.sshRepos.length
          ? performance.now()
          : await Promise.race([
              done.promise,
              Bun.sleep(30_000).then(() => -1),
            ]);
      off();
      lastBatch = performance.now();
      await Bun.sleep(1000);
      const entries = readJsonl(env.logs.ssh).slice(before);
      const kinds: Record<string, number> = {};
      for (const entry of entries)
        kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
      runs.push({
        all_statuses_ms: at > 0 ? at - sent : null,
        statuses_seen: seen.size,
        ssh_invocations: kinds,
      });
      options.log(`ssh round ${round}: ${JSON.stringify(runs.at(-1))}`);
    }
    const connectKinds: Record<string, number> = {};
    for (const entry of readJsonl(env.logs.ssh).slice(0, afterConnect))
      connectKinds[entry.kind] = (connectKinds[entry.kind] ?? 0) + 1;
    client.close();
    return {
      workspaces: env.sshRepos.length,
      connect: {
        ms_from_spawn: connectedMs,
        ms_after_hello: connected,
        ssh_invocations: connectKinds,
      },
      rounds: runs,
      all_statuses_ms: stats(
        runs
          .map((run) => run.all_statuses_ms as number | null)
          .filter((value): value is number => value !== null),
      ),
      real_ssh_localhost:
        "not run: the remote side would log in with the real HOME and reach the real Herdr",
    };
  } finally {
    await server.stop();
  }
}

/**
 * Inbox refreshes against the fake forges: calls and bytes by kind. The
 * server runs on the test clock, so nothing periodic runs unless the
 * harness moves time: startup, a refresh asked for, the same after the
 * one-minute floor, and the idle period's own refresh.
 */
export async function measureForge(env: BenchEnv) {
  writeFileSync(env.logs.forge, "");
  const clock = new TestClock(join(env.root, "clock.sock"));
  const serverPromise = startServer(env, {
    label: "forge",
    testClock: clock.path,
  });
  await clock.connect();
  clock.startPump();
  const server = await serverPromise;
  const summarize = (entries: Record<string, any>[]) => {
    const calls: Record<string, number> = {};
    let bytes = 0;
    for (const entry of entries) {
      const key = `${entry.tool}:${entry.kind}`;
      calls[key] = (calls[key] ?? 0) + 1;
      bytes += Number(entry.bytes ?? 0);
    }
    return { total: entries.length, calls, bytes };
  };
  const since = (before: number) =>
    summarize(readJsonl(env.logs.forge).slice(before));
  try {
    const client = await connect(server.base);
    await waitConnectionReady(client);
    await waitForQuiet(env.logs.forge, 3000);
    const startup = since(0);
    const refresh = async () => {
      const before = readJsonl(env.logs.forge).length;
      const inbox = await client.call<Record<string, any>>(
        "bridge.mr_reviews.inbox",
        { fresh: true },
      );
      await waitForQuiet(env.logs.forge, 2000);
      const after = await client.call<Record<string, any>>(
        "bridge.mr_reviews.inbox",
        {},
      );
      return {
        entries_in_reply: Array.isArray(inbox.entries)
          ? inbox.entries.length
          : null,
        entries_after: Array.isArray(after.entries)
          ? after.entries.length
          : null,
        ...since(before),
      };
    };
    const jump = async (ms: number) => {
      await clock.stopPump();
      const before = readJsonl(env.logs.forge).length;
      await clock.advance(ms);
      clock.startPump();
      await waitForQuiet(env.logs.forge, 2000);
      return since(before);
    };
    const first = await refresh();
    const minute = await jump(61_000);
    const second = await refresh();
    const idle = await jump(15 * 60_000);
    client.close();
    return {
      fixture:
        "scripts/bench/fakes/forge.ts: per forge 80 own requests (30 open) and 25 followed",
      clock: "test clock, pumped at real speed, jumped where named",
      startup,
      first_refresh: first,
      jump_61s: minute,
      second_refresh: second,
      jump_15min: idle,
    };
  } finally {
    await clock.stopPump();
    clock.close();
    await server.stop();
  }
}

/**
 * Conversation mode on the Claude pane, with the fake TUI and headless
 * Claude: the takeover, then turns of 400 deltas 2 ms apart. Per turn: the
 * time to the first delta pushed, to the result, the delta pushes (the
 * coalescing) and the event sequence.
 */
export async function measureConversation(env: BenchEnv, options: Options) {
  if (!env.agentPane) return { skipped: "no Claude transcript to resume" };
  writeFileSync(env.logs.claude, "");
  const pane = env.agentPane.pane_id;
  const server = await startServer(env, { label: "conversation" });
  try {
    const client = await connect(server.base);
    await waitConnectionReady(client);
    const events: { at: number; type: string; chars: number }[] = [];
    client.on((message, at) => {
      const event = message.event;
      const data = message.data as Record<string, any> | undefined;
      if (
        typeof event !== "string" ||
        !event.startsWith("agent_chat.") ||
        data?.pane_id !== pane
      )
        return;
      events.push({
        at,
        type: event.slice("agent_chat.".length),
        chars: typeof data.text === "string" ? data.text.length : 0,
      });
    });
    await client.call("agent_chat.subscribe", { pane_id: pane });
    // The takeover the chat asks for: the TUI gets /exit, roamgate-hold
    // takes the pane and the headless process starts.
    reportClaudeIdle(env, pane);
    options.log(
      `conversation agent: ${JSON.stringify(herdr(env, ["agent", "get", pane]).result).slice(0, 300)}`,
    );
    const handoverStart = performance.now();
    const handover = await client.call("agent_chat.handover", {
      pane_id: pane,
      to: "conversation",
      session_id: env.agentPane.session,
    });
    let takeoverMs: number | null = null;
    let lastState: unknown = null;
    while (performance.now() - handoverStart < 60_000) {
      lastState = await client.call<Record<string, any>>("agent_chat.state", {
        pane_id: pane,
      });
      const state = lastState as Record<string, any>;
      const phase = state?.lease?.phase ?? state?.phase ?? state?.mode;
      if (phase === "conversation") {
        takeoverMs = performance.now() - handoverStart;
        break;
      }
      await Bun.sleep(50);
    }
    options.log(
      `conversation handover: ${JSON.stringify(handover).slice(0, 200)} state ${JSON.stringify(lastState).slice(0, 400)}`,
    );
    const turns = options.quick ? 2 : 6;
    const results: Record<string, unknown>[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const from = events.length;
      const sent = performance.now();
      await client.call("agent_chat.send", {
        pane_id: pane,
        text: `bench turn ${turn}`,
      });
      const deadline = performance.now() + (turn === 0 ? 90_000 : 30_000);
      while (
        performance.now() < deadline &&
        !events.slice(from).some((event) => event.type === "result")
      )
        await Bun.sleep(20);
      const mine = events.slice(from);
      const deltas = mine.filter((event) => event.type === "delta");
      const result = mine.find((event) => event.type === "result");
      const sequence: string[] = [];
      for (const event of mine)
        if (sequence.at(-1) !== event.type) sequence.push(event.type);
      results.push({
        first_delta_ms: deltas[0] ? deltas[0].at - sent : null,
        result_ms: result ? result.at - sent : null,
        delta_pushes: deltas.length,
        delta_chars: deltas.reduce((sum, event) => sum + event.chars, 0),
        stream_ms: deltas.length ? deltas.at(-1)!.at - deltas[0]!.at : null,
        sequence,
      });
      options.log(
        `conversation turn ${turn}: ${JSON.stringify(results.at(-1)).slice(0, 300)}`,
      );
      await Bun.sleep(500);
    }
    client.close();
    const later = results.slice(1);
    const pick = (key: string) =>
      stats(
        later
          .map((result) => result[key] as number | null)
          .filter((value): value is number => value !== null),
      );
    return {
      fake: "scripts/bench/fakes/claude-headless.ts: 400 deltas, 2 ms apart, per turn",
      takeover_ms: takeoverMs,
      takeover_turn: results[0],
      turns: later,
      first_delta_ms: pick("first_delta_ms"),
      result_ms: pick("result_ms"),
      delta_pushes: pick("delta_pushes"),
    };
  } finally {
    await server.stop();
  }
}

/**
 * Archive ingest and search on a fixed corpus: the archive's oldest Claude
 * sessions of this machine (sessions that no longer change).
 */
export async function measureArchive(env: BenchEnv, options: Options) {
  const raw = archiveRaw(env.realHome);
  if (!existsSync(raw)) return { skipped: "no archive on this machine" };
  const hosts = readdirSync(raw).sort();
  const files: { path: string; mtime: number; host: string }[] = [];
  for (const host of hosts) {
    const claude = join(raw, host, "claude");
    if (!existsSync(claude)) continue;
    for (const project of readdirSync(claude)) {
      const dir = join(claude, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir))
        if (file.endsWith(".jsonl.zst"))
          files.push({
            path: join(dir, file),
            mtime: statSync(join(dir, file)).mtimeMs,
            host,
          });
    }
  }
  files.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  const corpus = files.slice(0, options.quick ? 40 : 300);
  const archive = join(env.root, "archive");
  const hash = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  // As a pushing machine leaves them: plain transcripts in the host's
  // mirror tree, which ingest compresses into raw/ and indexes.
  for (const file of corpus) {
    const target = join(
      archive,
      "mirror",
      "bench",
      "claude",
      "tree",
      relative(join(raw, file.host, "claude"), file.path).replace(/\.zst$/, ""),
    );
    mkdirSync(join(target, ".."), { recursive: true });
    const data = Bun.zstdDecompressSync(readFileSync(file.path));
    writeFileSync(target, data);
    bytes += data.length;
    hash.update(relative(raw, file.path));
    hash.update(data);
  }
  const cli = (args: string[]) => {
    const start = performance.now();
    const result = spawnSync(
      serverCommand()[0]!,
      [...serverCommand().slice(1), "archive", ...args],
      {
        cwd: join(REPO, "server"),
        env: {
          ...env.baseEnv,
          ROAMGATE_ARCHIVE_DIR: archive,
          ROAMGATE_ARCHIVE_HOST: "bench",
          ROAMGATE_SETTINGS_PATH: join(env.root, "settings.json"),
          ROAMGATE_CONNECTIONS_PATH: join(env.root, "connections.json"),
        },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    const ms = performance.now() - start;
    if (result.status !== 0 && result.status !== 1)
      throw new Error(
        `archive ${args.join(" ")}: ${result.status} ${result.stderr.slice(0, 400)}`,
      );
    return { ms, stdout: result.stdout, status: result.status };
  };
  const ingest = cli(["ingest", "bench", "--json"]);
  const ingested = JSON.parse(ingest.stdout || "{}");
  const text = cli(["rebuild-text", "--now", "--json"]);
  const terms = [
    "herdr",
    "websocket reconnect",
    "gstreamer pipeline",
    '"merge request"',
    "test clock",
  ];
  const search: Record<string, unknown> = {};
  const repeats = options.quick ? 2 : 5;
  for (const term of terms) {
    const runs: number[] = [];
    let lines = 0;
    for (let index = 0; index < repeats; index++) {
      const result = cli(["search", ...term.split(" "), "-n", "50"]);
      runs.push(result.ms);
      lines = result.stdout.split("\n").filter(Boolean).length;
    }
    search[term] = { ms: stats(runs), result_lines: lines };
  }
  const indexRuns: number[] = [];
  for (let index = 0; index < repeats; index++)
    indexRuns.push(cli(["search", "--index", "herdr", "-n", "50"]).ms);
  return {
    corpus: {
      sessions: corpus.length,
      bytes,
      sha256: hash.digest("hex"),
      source: "oldest Claude sessions of the archive's raw/",
    },
    ingest_ms: ingest.ms,
    ingest_report: ingested.agents ?? null,
    rebuild_text_ms: text.ms,
    search,
    search_index_ms: stats(indexRuns),
  };
}

export { sha256 };
