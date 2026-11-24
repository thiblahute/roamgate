#!/usr/bin/env bun
/**
 * Performance baselines of the Rust migration (plan section 5.9).
 *
 *   bun scripts/bench/run.ts [--only a,b] [--quick] [--out result.json]
 *                            [--baseline contract/perf/baseline.json --machine NAME]
 *   bun scripts/bench/run.ts compare <baseline.json> <result.json> [--machine NAME]
 *   bun scripts/bench/run.ts merge <result.json> --baseline <baseline.json> --machine NAME
 *
 * Every run builds its own world (scratch HOME, two Herdr servers, fixture
 * repositories, copies of the user's review and work stores, fake ssh, glab
 * and gh) under ~/.claude/tmp, measures the server named by BENCH_SERVER_CMD
 * (default: this checkout's Bun server from source), and deletes the world.
 * The Rust server: BENCH_SERVER_CMD="<roamgate> front" (the CLI, for the
 * archive, is then the binary itself; BENCH_CLI_CMD overrides it), and
 * BENCH_TEST_CLOCK_SERVER_CMD the same release built with the
 * `roamgate-base/test-clock` feature for the runs on the test clock (forge,
 * the voice helper's ping): a plain release refuses ROAMGATE_TEST_CLOCK.
 * On Linux it waits while GameMode reports a game (results would be noise).
 *
 * The hybrid (a Rust core behind the Bun front, contract/wire/
 * core-channel.md): ROAMGATE_CORE_BIN names the core binary, passed to the
 * server, and BENCH_RUST_FAMILIES (comma separated, families of
 * contract/owners/families.json) the families the world's owners table
 * gives to Rust. The run records both, and compare prints them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, loadavg, platform, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  cliCommand,
  coreBin,
  createEnv,
  destroyEnv,
  FIXTURE_TAG,
  REPO,
  rustFamilies,
  serverCommand,
  testClockServerCommand,
} from "./env";
import {
  measureArchive,
  measureConversation,
  measureForge,
  measureRpc,
  measureRss,
  measureSsh,
  measureStartup,
  measureTerminal,
  type Options,
} from "./metrics";
import { measureVoice } from "./voice";

/** What the Rust server must meet, per metric (plan section 5.9). */
export const GATES: Record<string, { gate: string; rule: string }> = {
  startup: {
    gate: "not_slower",
    rule: "ready_ms.p50 and hello_ms.p50 not above Bun's",
  },
  rss: { gate: "not_higher", rule: "idle and loaded tree_kb not above Bun's" },
  rpc: {
    gate: "p99_within_10pct",
    rule: "per method, ms.p99 not more than 10% above Bun's",
  },
  terminal: {
    gate: "throughput_not_lower_latency_not_higher",
    rule: "throughput.frames_per_s and ansi_bytes_per_s not lower; latency.ms.p50 and p99 not higher",
  },
  terminal_wire: {
    gate: "within_5pct",
    rule: "wire.deflate.wire_bytes_down within 5% of Bun's",
  },
  ssh: {
    gate: "same_sessions_not_slower",
    rule: "ssh_invocations identical per round; all_statuses_ms not slower",
  },
  forge: {
    gate: "identical_counts",
    rule: "calls by kind identical for startup and each refresh",
  },
  archive: {
    gate: "not_slower",
    rule: "ingest_ms, rebuild_text_ms and each search ms.p50 not above Bun's",
  },
  conversation: {
    gate: "identical_sequence_not_later",
    rule: "each turn's event sequence identical; first_delta_ms.p50 and result_ms.p50 not later",
  },
  voice: {
    gate: "not_later",
    rule: "final_to_first_audio.ms.p50 and helper_ping.ms.p50 not later than Bun's",
  },
};

const ALL = [
  "startup",
  "rss",
  "rpc",
  "terminal",
  "ssh",
  "forge",
  "archive",
  "conversation",
  "voice",
] as const;

function sh(argv: string[]) {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function gameActive(): boolean {
  if (platform() !== "linux") return false;
  const out =
    sh(["/usr/bin/host-spawn", "gamemoded", "-s"]) || sh(["gamemoded", "-s"]);
  return /is active/.test(out);
}

async function waitForNoGame(log: (line: string) => void) {
  while (gameActive()) {
    log("GameMode is active: waiting (polling every 3 minutes)");
    await Bun.sleep(180_000);
  }
}

function machine() {
  const cpu = cpus()[0]?.model ?? "";
  return {
    hostname: hostname(),
    platform: platform(),
    kernel: release(),
    cpu,
    logical_cpus: cpus().length,
    memory_gb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    bun: Bun.version,
    herdr: sh(["herdr", "--version"]),
    server_command: serverCommand()
      .map((part) => part.replace(REPO, "."))
      .join(" "),
    ...(process.env.BENCH_TEST_CLOCK_SERVER_CMD
      ? {
          test_clock_server_command: testClockServerCommand()
            .map((part) => part.replace(REPO, "."))
            .join(" "),
        }
      : {}),
    cli_command: cliCommand()
      .map((part) => part.replace(REPO, "."))
      .join(" "),
    source_commit: sh(["git", "-C", REPO, "rev-parse", "HEAD"]),
    source_dirty: sh(["git", "-C", REPO, "status", "--short"]) !== "",
    fixture: FIXTURE_TAG,
    ...(coreBin() ? { core_bin: coreBin() } : {}),
    rust_families: rustFamilies(),
    ...(platform() === "darwin"
      ? { power: sh(["pmset", "-g", "batt"]).split("\n")[0] ?? "" }
      : {}),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      only: { type: "string" },
      quick: { type: "boolean", default: false },
      out: { type: "string" },
      baseline: { type: "string" },
      machine: { type: "string" },
      keep: { type: "boolean", default: false },
      "ignore-game": { type: "boolean", default: false },
    },
  });
  if (positionals[0] === "compare")
    return compare(positionals[1]!, positionals[2]!, values.machine);
  if (positionals[0] === "merge") {
    // A run made on another machine (--out there) into the baseline.
    if (!values.baseline || !values.machine)
      throw new Error("merge needs --baseline and --machine");
    return storeBaseline(
      values.baseline,
      values.machine,
      JSON.parse(readFileSync(positionals[1]!, "utf8")),
    );
  }
  if (positionals.length) throw new Error(`unknown command ${positionals[0]}`);
  const log = (line: string) =>
    console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${line}`);
  const only = values.only ? values.only.split(",") : [...ALL];
  for (const name of only)
    if (!ALL.includes(name as (typeof ALL)[number]))
      throw new Error(`unknown metric ${name}`);
  const options: Options = { quick: values.quick ?? false, log };
  if (!values["ignore-game"]) await waitForNoGame(log);
  const started = new Date().toISOString();
  const env = await createEnv({ log });
  const metrics: Record<string, unknown> = {};
  const conditions: Record<string, unknown> = {};
  try {
    for (const name of only) {
      if (!values["ignore-game"]) await waitForNoGame(log);
      log(`measuring ${name}`);
      const before = loadavg();
      const run = {
        startup: measureStartup,
        rss: measureRss,
        rpc: measureRpc,
        terminal: measureTerminal,
        ssh: measureSsh,
        forge: measureForge,
        archive: measureArchive,
        conversation: measureConversation,
        voice: measureVoice,
      }[name as (typeof ALL)[number]];
      try {
        metrics[name] = await run(env, options);
      } catch (error) {
        log(`${name} failed: ${error instanceof Error ? error.stack : error}`);
        metrics[name] = { error: String(error) };
      }
      conditions[name] = {
        load_before: before.map((value) => Math.round(value * 100) / 100),
        load_after: loadavg().map((value) => Math.round(value * 100) / 100),
        game_active_after: gameActive(),
      };
    }
  } finally {
    await destroyEnv(env, values.keep);
  }
  const result = {
    started,
    finished: new Date().toISOString(),
    quick: options.quick,
    machine: machine(),
    conditions,
    metrics,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  if (values.baseline) {
    const name = values.machine ?? hostname();
    storeBaseline(values.baseline, name, result);
    log(`baseline for ${name} written to ${values.baseline}`);
  }
  if (!values.out && !values.baseline) process.stdout.write(text);
}

/**
 * Stores a run as a machine's baseline, with the gates. A run of some
 * metrics only (--only) replaces those in the machine's baseline and keeps
 * the others; `added` says when and on what each was measured.
 */
function storeBaseline(
  path: string,
  machine: string,
  result: Record<string, any>,
) {
  const baseline = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { version: 1, gates: GATES, machines: {} };
  baseline.gates = GATES;
  const kept = baseline.machines[machine];
  const names = Object.keys(result.metrics ?? {});
  if (kept && names.length < ALL.length) {
    for (const name of names) {
      kept.metrics[name] = result.metrics[name];
      kept.conditions[name] = result.conditions?.[name];
      kept.added = {
        ...kept.added,
        [name]: {
          started: result.started,
          finished: result.finished,
          quick: result.quick,
          machine: result.machine,
        },
      };
    }
  } else baseline.machines[machine] = result;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** Which server a run measured: its command, and the families Rust owned. */
function describe(label: string, machine: Record<string, any> | undefined) {
  if (!machine) return `${label}: unknown server`;
  const core = machine.core_bin ? `, core ${machine.core_bin}` : "";
  const rust = machine.rust_families?.length
    ? `, Rust owns ${machine.rust_families.join(", ")}`
    : ", every family Bun's";
  return `${label}: ${machine.server_command} on ${machine.hostname} (${machine.source_commit?.slice(0, 10) ?? "?"})${core}${rust}`;
}

/** Checks a run against a stored baseline's gates; exit 1 on a failed gate. */
function compare(
  baselinePath: string,
  resultPath: string,
  machineName?: string,
) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const name = machineName ?? hostname();
  const base = baseline.machines?.[name]?.metrics;
  if (!base) throw new Error(`no baseline for machine ${name}`);
  const now = result.metrics;
  const failures: string[] = [];
  const checks: string[] = [];
  const check = (label: string, ok: boolean, detail: string) => {
    checks.push(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
    if (!ok) failures.push(label);
  };
  const notAbove = (label: string, a?: number, b?: number, slack = 0) => {
    if (typeof a !== "number" || typeof b !== "number") return;
    check(label, b <= a * (1 + slack), `${b} vs baseline ${a}`);
  };
  const notBelow = (label: string, a?: number, b?: number) => {
    if (typeof a !== "number" || typeof b !== "number") return;
    check(label, b >= a, `${b} vs baseline ${a}`);
  };
  if (base.startup && now.startup) {
    notAbove(
      "startup.ready_ms.p50",
      base.startup.ready_ms?.p50,
      now.startup.ready_ms?.p50,
    );
    notAbove(
      "startup.hello_ms.p50",
      base.startup.hello_ms?.p50,
      now.startup.hello_ms?.p50,
    );
  }
  if (base.rss && now.rss) {
    notAbove("rss.idle.tree_kb", base.rss.idle?.tree_kb, now.rss.idle?.tree_kb);
    notAbove(
      "rss.loaded.tree_kb",
      base.rss.three_connections_20_terminals?.tree_kb,
      now.rss.three_connections_20_terminals?.tree_kb,
    );
  }
  if (base.rpc && now.rpc)
    for (const [method, value] of Object.entries<any>(base.rpc.methods ?? {}))
      notAbove(
        `rpc.${method}.p99`,
        value.ms?.p99,
        now.rpc.methods?.[method]?.ms?.p99,
        0.1,
      );
  if (base.terminal && now.terminal) {
    notBelow(
      "terminal.frames_per_s",
      base.terminal.throughput?.frames_per_s,
      now.terminal.throughput?.frames_per_s,
    );
    notBelow(
      "terminal.ansi_bytes_per_s",
      base.terminal.throughput?.ansi_bytes_per_s,
      now.terminal.throughput?.ansi_bytes_per_s,
    );
    notAbove(
      "terminal.latency.p50",
      base.terminal.latency?.ms?.p50,
      now.terminal.latency?.ms?.p50,
    );
    notAbove(
      "terminal.latency.p99",
      base.terminal.latency?.ms?.p99,
      now.terminal.latency?.ms?.p99,
    );
    const a = base.terminal.wire?.deflate?.wire_bytes_down;
    const b = now.terminal.wire?.deflate?.wire_bytes_down;
    if (typeof a === "number" && typeof b === "number")
      check(
        "terminal.wire.deflate",
        Math.abs(b - a) <= a * 0.05,
        `${b} vs baseline ${a}`,
      );
  }
  // Counts compare whatever order their keys were first seen in.
  const canon = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
          )
        : item,
    );
  if (base.ssh && now.ssh) {
    const a = canon(base.ssh.rounds?.map((r: any) => r.ssh_invocations));
    const b = canon(now.ssh.rounds?.map((r: any) => r.ssh_invocations));
    check("ssh.sessions", a === b, `${b} vs baseline ${a}`);
    notAbove(
      "ssh.all_statuses_ms.p50",
      base.ssh.all_statuses_ms?.p50,
      now.ssh.all_statuses_ms?.p50,
    );
    check(
      "ssh.connect",
      canon(base.ssh.connect?.ssh_invocations) ===
        canon(now.ssh.connect?.ssh_invocations),
      `${JSON.stringify(now.ssh.connect?.ssh_invocations)} vs baseline ${JSON.stringify(base.ssh.connect?.ssh_invocations)}`,
    );
  }
  if (base.forge && now.forge) {
    for (const key of [
      "startup",
      "first_refresh",
      "jump_61s",
      "second_refresh",
      "jump_15min",
    ]) {
      const a = canon(base.forge[key]?.calls);
      const b = canon(now.forge[key]?.calls);
      check(`forge.${key}`, a === b, `${b} vs baseline ${a}`);
    }
  }
  if (base.archive && now.archive) {
    notAbove(
      "archive.ingest_ms",
      base.archive.ingest_ms,
      now.archive.ingest_ms,
    );
    notAbove(
      "archive.rebuild_text_ms",
      base.archive.rebuild_text_ms,
      now.archive.rebuild_text_ms,
    );
    for (const [term, value] of Object.entries<any>(base.archive.search ?? {}))
      notAbove(
        `archive.search.${term}`,
        value.ms?.p50,
        now.archive.search?.[term]?.ms?.p50,
      );
  }
  if (base.conversation?.turns && now.conversation?.turns) {
    const a = canon(base.conversation.turns.map((turn: any) => turn.sequence));
    const b = canon(now.conversation.turns.map((turn: any) => turn.sequence));
    check("conversation.sequence", a === b, `${b} vs baseline ${a}`);
    notAbove(
      "conversation.first_delta_ms.p50",
      base.conversation.first_delta_ms?.p50,
      now.conversation.first_delta_ms?.p50,
    );
    notAbove(
      "conversation.result_ms.p50",
      base.conversation.result_ms?.p50,
      now.conversation.result_ms?.p50,
    );
  }
  if (base.voice && now.voice) {
    notAbove(
      "voice.final_to_first_audio.p50",
      base.voice.final_to_first_audio?.ms?.p50,
      now.voice.final_to_first_audio?.ms?.p50,
    );
    notAbove(
      "voice.helper_ping.p50",
      base.voice.helper_ping?.ms?.p50,
      now.voice.helper_ping?.ms?.p50,
    );
  }
  // A metric the baseline has that failed in the run is no pass.
  for (const metric of Object.keys(base))
    if (now[metric]?.error)
      check(metric, false, `failed in the run: ${now[metric].error}`);
  console.log(describe("baseline", baseline.machines[name].machine));
  console.log(describe("run", result.machine));
  console.log(checks.join("\n"));
  if (failures.length) process.exit(1);
}

await main();
