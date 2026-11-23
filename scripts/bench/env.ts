/**
 * The benchmark's isolated world: its own HOME, its own Herdr servers (a
 * local one and one a fake ssh reaches), fixture repositories, copies of the
 * user's stores, and fake ssh, glab and gh that count what the server asks.
 * Nothing here touches the real HOME, Herdr, review socket or forges.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BenchClient, login } from "./client";

export const REPO = join(import.meta.dir, "../..");
/** The fixture repository: a public release of Roamgate itself. */
export const FIXTURE_TAG = "v0.8.15";
export const PASSWORD = "rgbench-pass";

export type BenchEnv = {
  root: string;
  home: string;
  bin: string;
  realHome: string;
  /** Environment of everything started in this world. */
  baseEnv: Record<string, string>;
  herdrSockets: { control: string; client: string };
  remote: { home: string; control: string; client: string };
  repo: string;
  sshRepos: string[];
  logs: { ssh: string; forge: string; claude: string };
  workspaceId: string;
  /** Panes made for the terminal measurements, by role. */
  panes: Record<string, { pane_id: string; terminal_id: string }>;
  terminals: { pane_id: string; terminal_id: string }[];
  agentPane: {
    pane_id: string;
    session: string;
    transcript: string;
    sha256: string;
  } | null;
  log: (line: string) => void;
};

function run(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
) {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${argv.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  return result.stdout;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

export function sha256(path: string) {
  return new Bun.CryptoHasher("sha256")
    .update(readFileSync(path))
    .digest("hex");
}

export function herdr(
  env: BenchEnv,
  args: string[],
  sockets = env.herdrSockets,
  home = env.home,
) {
  const out = run(["herdr", ...args], {
    env: {
      ...env.baseEnv,
      HOME: home,
      HERDR_SOCKET_PATH: sockets.control,
      HERDR_CLIENT_SOCKET_PATH: sockets.client,
    },
  });
  try {
    return JSON.parse(out) as { result: Record<string, any> };
  } catch {
    return { result: {} as Record<string, any> };
  }
}

async function startHerdr(
  env: BenchEnv,
  home: string,
  sockets: { control: string; client: string },
  name: string,
) {
  mkdirSync(dirname(sockets.control), { recursive: true });
  const child = spawn("herdr", ["server"], {
    cwd: env.root,
    env: {
      ...env.baseEnv,
      HOME: home,
      HERDR_SOCKET_PATH: sockets.control,
      HERDR_CLIENT_SOCKET_PATH: sockets.client,
    },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (existsSync(sockets.control)) {
      try {
        herdr(env, ["workspace", "list"], sockets, home);
        env.log(`herdr ${name} up`);
        return;
      } catch {}
    }
    await Bun.sleep(100);
  }
  throw new Error(`herdr ${name} did not start`);
}

/** Copies an SQLite store consistently (WAL included) with sqlite3's backup. */
function backupSqlite(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  run(["sqlite3", "-readonly", from, `.backup '${to.replaceAll("'", "''")}'`]);
}

/** The fixture repo: the tag checked out, then a fixed set of changes. */
function makeFixtureRepo(path: string, changes: boolean) {
  run(["git", "clone", "--quiet", "--shared", "--no-checkout", REPO, path]);
  run(["git", "-C", path, "checkout", "--quiet", "--detach", FIXTURE_TAG]);
  run(["git", "-C", path, "config", "user.email", "bench@example.invalid"]);
  run(["git", "-C", path, "config", "user.name", "Bench"]);
  if (!changes) return;
  const tracked = run(["git", "-C", path, "ls-files", "server/src", "web/src"])
    .split("\n")
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();
  // 30 modified files, every 7th, 5 of them staged; 3 deleted; 8 new.
  const modified = tracked.filter((_, index) => index % 7 === 0).slice(0, 30);
  modified.forEach((file, index) => {
    const full = join(path, file);
    const lines = readFileSync(full, "utf8").split("\n");
    lines.splice(
      Math.min(10 + index, lines.length),
      0,
      `// bench change ${index}`,
    );
    lines.push(`export const benchMarker${index} = ${index};`);
    writeFileSync(full, lines.join("\n"));
  });
  run(["git", "-C", path, "add", ...modified.slice(0, 5)]);
  for (const file of tracked.filter((_, index) => index % 7 === 3).slice(0, 3))
    rmSync(join(path, file));
  mkdirSync(join(path, "bench-new"), { recursive: true });
  for (let index = 0; index < 8; index++)
    writeFileSync(
      join(path, "bench-new", `file-${index}.ts`),
      Array.from(
        { length: 50 + index * 10 },
        (_, line) => `export const v${line} = ${line};`,
      ).join("\n"),
    );
}

/**
 * The session archive's raw/ the fixtures come from: BENCH_ARCHIVE_RAW (a
 * copy brought to a machine without the archive), else this machine's.
 */
export function archiveRaw(realHome: string) {
  return (
    process.env.BENCH_ARCHIVE_RAW ||
    join(realHome, ".config/roamgate/archive/raw")
  );
}

/**
 * A Claude transcript for agent_history.get: the archive's oldest Claude
 * session of 200 KB to 2 MB compressed (old sessions do not change), else
 * the oldest such transcript under ~/.claude/projects.
 */
function pickTranscript(
  realHome: string,
): { path: string; zst: boolean } | null {
  const raw = archiveRaw(realHome);
  const candidates: { path: string; mtime: number; zst: boolean }[] = [];
  if (existsSync(raw)) {
    for (const host of readdirSync(raw).sort()) {
      const claude = join(raw, host, "claude");
      if (!existsSync(claude)) continue;
      for (const project of readdirSync(claude)) {
        const dir = join(claude, project);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".jsonl.zst")) continue;
          const full = join(dir, file);
          const stat = statSync(full);
          if (stat.size >= 200_000 && stat.size <= 2_000_000)
            candidates.push({ path: full, mtime: stat.mtimeMs, zst: true });
        }
      }
      if (candidates.length) break;
    }
  }
  if (!candidates.length) {
    const projects = join(realHome, ".claude/projects");
    if (existsSync(projects))
      for (const project of readdirSync(projects)) {
        const dir = join(projects, project);
        if (!statSync(dir).isDirectory()) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".jsonl")) continue;
          const full = join(dir, file);
          const stat = statSync(full);
          if (stat.size >= 1_000_000 && stat.size <= 10_000_000)
            candidates.push({ path: full, mtime: stat.mtimeMs, zst: false });
        }
      }
  }
  candidates.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  return candidates[0] ?? null;
}

function writeFakes(env: BenchEnv) {
  const fakes = join(import.meta.dir, "fakes");
  // claude: the headless one conversation mode starts (never the real one).
  for (const [tool, script] of [
    ["ssh", "ssh.ts"],
    ["glab", "glab.ts"],
    ["gh", "gh.ts"],
    ["claude", "claude-headless.ts"],
  ] as const) {
    const target = join(env.bin, tool);
    writeFileSync(
      target,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fakes, script))} "$@"\n`,
    );
    chmodSync(target, 0o755);
  }
  // glab's and gh's configuration: the hosts the inbox finds.
  mkdirSync(join(env.home, ".config/glab-cli"), { recursive: true });
  writeFileSync(
    join(env.home, ".config/glab-cli/config.yml"),
    "host: gitlab.bench.test\nhosts:\n  gitlab.bench.test:\n    token: bench-token\n    api_host: gitlab.bench.test\n",
    { mode: 0o600 },
  );
  mkdirSync(join(env.home, ".config/gh"), { recursive: true });
  writeFileSync(
    join(env.home, ".config/gh/hosts.yml"),
    "github.com:\n    oauth_token: bench-token\n    user: me\n",
    { mode: 0o600 },
  );
}

export type EnvOptions = {
  root?: string;
  /** How many remote workspaces the fake ssh host has. */
  sshWorkspaces?: number;
  terminals?: number;
  log?: (line: string) => void;
};

export async function createEnv(options: EnvOptions = {}): Promise<BenchEnv> {
  const realHome = homedir();
  const root =
    options.root ??
    join(
      realHome,
      ".claude/tmp",
      `rgbench-${process.pid}-${Date.now().toString(36)}`,
    );
  if (existsSync(root)) throw new Error(`${root} exists`);
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [home, bin, join(root, "herdr"), join(root, "logs")])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log =
    options.log ?? ((line: string) => console.error(`[bench] ${line}`));
  const remoteHome = join(root, "remote-home");
  mkdirSync(remoteHome, { recursive: true });
  const env: BenchEnv = {
    root,
    home,
    bin,
    realHome,
    baseEnv: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      BENCH_SSH_LOG: join(root, "logs/ssh.jsonl"),
      BENCH_FORGE_LOG: join(root, "logs/forge.jsonl"),
      BENCH_CLAUDE_LOG: join(root, "logs/claude.jsonl"),
      BENCH_REMOTE_HOME: remoteHome,
      BENCH_REMOTE_CONTROL: join(root, "remote-herdr/herdr.sock"),
      BENCH_REMOTE_CLIENT: join(root, "remote-herdr/herdr-client.sock"),
      // A HOME of its own, a fake ssh: its SSH hosts are fakes. (Bun's
      // guard reads that HOME as the account's; the Rust core's does not.)
      ROAMGATE_ALLOW_SSH: "1",
    },
    herdrSockets: {
      control: join(root, "herdr/herdr.sock"),
      client: join(root, "herdr/herdr-client.sock"),
    },
    remote: {
      home: remoteHome,
      control: join(root, "remote-herdr/herdr.sock"),
      client: join(root, "remote-herdr/herdr-client.sock"),
    },
    repo: join(root, "fixtures/repo"),
    sshRepos: [],
    logs: {
      ssh: join(root, "logs/ssh.jsonl"),
      forge: join(root, "logs/forge.jsonl"),
      claude: join(root, "logs/claude.jsonl"),
    },
    workspaceId: "",
    panes: {},
    terminals: [],
    agentPane: null,
    log,
  };
  try {
    await populate(env, options);
  } catch (error) {
    await destroyEnv(env, !!process.env.BENCH_KEEP);
    throw error;
  }
  return env;
}

async function populate(env: BenchEnv, options: EnvOptions) {
  const { root, home, realHome, log } = env;
  const remoteHome = env.remote.home;
  writeFakes(env);

  log("fixture repositories");
  makeFixtureRepo(env.repo, true);
  for (let index = 0; index < (options.sshWorkspaces ?? 8); index++) {
    const path = join(root, "fixtures", `remote-${index}`);
    makeFixtureRepo(path, index % 2 === 0);
    env.sshRepos.push(path);
  }

  log("copies of the user's stores");
  const realConfig = join(realHome, ".config/roamgate");
  const config = join(home, ".config/roamgate");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const reviews = join(realConfig, "reviews/reviews.sqlite");
  if (existsSync(reviews)) {
    // Every review on this server's one connection, so that it lists them.
    const copy = join(config, "reviews/reviews.sqlite");
    backupSqlite(reviews, copy);
    run([
      "sqlite3",
      copy,
      "update sessions set connection_id = 'legacy-default', data = json_set(data, '$.connectionId', 'legacy-default');",
    ]);
  }
  const work = join(realConfig, "work");
  if (existsSync(work)) {
    mkdirSync(join(config, "work"), { recursive: true, mode: 0o700 });
    for (const file of readdirSync(work))
      if (statSync(join(work, file)).isFile())
        copyFileSync(join(work, file), join(config, "work", file));
  }
  const activity = join(realConfig, "activity.sqlite");
  if (existsSync(activity))
    backupSqlite(activity, join(config, "activity.sqlite"));
  writeFileSync(
    join(root, "settings.json"),
    JSON.stringify(
      {
        mr_reviews: {
          hosts: [
            { host: "gitlab.bench.test", provider: "gitlab" },
            { host: "github.com", provider: "github" },
          ],
          followed: [
            {
              host: "gitlab.bench.test",
              provider: "gitlab",
              project: "upstream/app",
            },
          ],
          curation: false,
          inference: false,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "connections.json"),
    JSON.stringify({ version: 1, connections: [] }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "connections-ssh.json"),
    JSON.stringify({
      version: 2,
      default_connection_id: "local",
      profiles: [
        {
          id: "local",
          label: "LOCAL",
          type: "local",
          control_socket_path: env.herdrSockets.control,
          client_socket_path: env.herdrSockets.client,
          auto_connect: true,
        },
        {
          id: "bench-ssh",
          label: "BENCH",
          type: "ssh",
          ssh_destination: "bench-remote",
          remote_control_socket_path: env.remote.control,
          remote_client_socket_path: env.remote.client,
          auto_connect: true,
        },
      ],
    }),
    { mode: 0o600 },
  );

  log("herdr servers");
  await startHerdr(env, home, env.herdrSockets, "local");
  await startHerdr(env, remoteHome, env.remote, "remote");
  // Workspaces opened on their checkouts, as Herdr worktree workspaces:
  // their git status is what the server enriches workspace lists with.
  const created = herdr(env, [
    "worktree",
    "open",
    "--cwd",
    env.repo,
    "--path",
    env.repo,
    "--label",
    "bench",
    "--no-focus",
  ]);
  env.workspaceId = created.result.root_pane.workspace_id;
  const first = created.result.root_pane;
  env.panes.flood = { pane_id: first.pane_id, terminal_id: first.terminal_id };
  const addTab = (label: string) => {
    const tab = herdr(env, [
      "tab",
      "create",
      "--workspace",
      env.workspaceId,
      "--cwd",
      env.repo,
      "--label",
      label,
    ]);
    return {
      pane_id: tab.result.root_pane.pane_id,
      terminal_id: tab.result.root_pane.terminal_id,
    };
  };
  env.panes.echo = addTab("echo");
  env.panes.agent = addTab("agent");
  for (let index = 0; index < (options.terminals ?? 20); index++)
    env.terminals.push(addTab(`t${index}`));
  for (const [index, path] of env.sshRepos.entries())
    herdr(
      env,
      [
        "worktree",
        "open",
        "--cwd",
        path,
        "--path",
        path,
        "--label",
        `remote-${index}`,
        "--no-focus",
      ],
      env.remote,
      remoteHome,
    );

  // A Claude pane whose session Herdr knows, with a real transcript.
  const transcript = pickTranscript(realHome);
  if (transcript) {
    const session = basename(transcript.path).replace(/\.jsonl(\.zst)?$/, "");
    const projectDir = join(
      home,
      ".claude/projects",
      env.repo.replaceAll(/[^A-Za-z0-9]/g, "-"),
    );
    mkdirSync(projectDir, { recursive: true });
    const target = join(projectDir, `${session}.jsonl`);
    if (transcript.zst)
      writeFileSync(
        target,
        Bun.zstdDecompressSync(readFileSync(transcript.path)),
      );
    else copyFileSync(transcript.path, target);
    // Herdr sees a claude process in the pane (a script named claude,
    // outside every PATH the server uses), so the agent stays.
    const agentBin = join(root, "agentbin");
    mkdirSync(agentBin, { recursive: true });
    // It shows Claude's idle prompt and quits on /exit, as conversation
    // mode's takeover expects of the TUI.
    const rule = "\u2500".repeat(40);
    writeFileSync(
      join(agentBin, "claude"),
      [
        "#!/bin/sh",
        `printf '\\033[2J\\033[H  some answer\\n${rule}\\n\u276f \\n${rule}\\n  -- INSERT -- \u23f5\u23f5 auto mode on\\n'`,
        'while IFS= read -r line; do case "$line" in *"/exit"*) exit 0 ;; esac; done',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    herdr(env, [
      "pane",
      "send-text",
      env.panes.agent.pane_id,
      `${join(agentBin, "claude")}\n`,
    ]);
    for (let i = 0; i < 50; i++) {
      try {
        if (
          herdr(env, ["agent", "get", env.panes.agent.pane_id]).result.agent
            ?.agent === "claude"
        )
          break;
      } catch {}
      await Bun.sleep(100);
    }
    reportClaudeIdle(env, env.panes.agent.pane_id);
    herdr(env, [
      "pane",
      "report-agent-session",
      "--source",
      "herdr:claude",
      "--agent",
      "claude",
      "--seq",
      String(Date.now() * 1_000_000 + 1),
      "--agent-session-id",
      session,
      "--agent-session-path",
      target,
      env.panes.agent.pane_id,
    ]);
    env.agentPane = {
      pane_id: env.panes.agent.pane_id,
      session,
      transcript: target,
      sha256: sha256(target),
    };
  }
}

/** What Claude's Herdr hook reports when a turn ends: the pane is idle. */
export function reportClaudeIdle(env: BenchEnv, pane: string) {
  herdr(env, [
    "pane",
    "report-agent",
    "--source",
    "claude",
    "--agent",
    "claude",
    "--seq",
    String(Date.now() * 1_000_000),
    "--state",
    "idle",
    pane,
  ]);
}

export type ServerHandle = {
  pid: number;
  port: number;
  base: string;
  /** Spawn to /healthz answering 200, ms. */
  readyMs: number;
  stop(): Promise<void>;
  exited: Promise<number | null>;
};

export type ServerOptions = {
  /** The server command; default: this checkout's Bun server from source. */
  command?: string[];
  connections?: "none" | "ssh";
  testClock?: string;
  extraEnv?: Record<string, string>;
  label?: string;
};

/** The Rust core of the hybrid (ROAMGATE_CORE_BIN), or none. */
export function coreBin(): string | undefined {
  return process.env.ROAMGATE_CORE_BIN || undefined;
}

/**
 * The families the world's owners table gives to Rust
 * (BENCH_RUST_FAMILIES, comma separated): known to
 * contract/owners/families.json, and only with a core to run them.
 */
export function rustFamilies(): string[] {
  const families = (process.env.BENCH_RUST_FAMILIES ?? "")
    .split(",")
    .map((family) => family.trim())
    .filter(Boolean);
  if (!families.length) return [];
  const known = Object.keys(
    JSON.parse(
      readFileSync(join(REPO, "contract/owners/families.json"), "utf8"),
    ).families,
  );
  for (const family of families)
    if (!known.includes(family))
      throw new Error(`BENCH_RUST_FAMILIES: unknown family ${family}`);
  if (!coreBin())
    throw new Error("BENCH_RUST_FAMILIES needs ROAMGATE_CORE_BIN");
  return families;
}

/**
 * The world's owners table (<data>/runtime/owners.json,
 * contract/wire/core-channel.md): the families of BENCH_RUST_FAMILIES are
 * Rust's, shadow reads off (they would add work the run does not measure).
 */
function writeOwners(env: BenchEnv) {
  const families = rustFamilies();
  const path = join(env.home, ".config/roamgate/runtime/owners.json");
  if (!families.length) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        owners: Object.fromEntries(families.map((family) => [family, "rust"])),
        shadow: { enabled: false, rate: 0 },
        core: coreBin(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export function serverCommand(): string[] {
  const custom = process.env.BENCH_SERVER_CMD;
  if (custom) return custom.split(" ").filter(Boolean);
  return [process.execPath, join(REPO, "server/src/index.ts")];
}

export async function startServer(
  env: BenchEnv,
  options: ServerOptions = {},
): Promise<ServerHandle> {
  const port = await freePort();
  const logPath = join(
    env.root,
    "logs",
    `server-${options.label ?? "run"}-${port}.log`,
  );
  const command = options.command ?? serverCommand();
  writeOwners(env);
  const core = coreBin();
  const start = performance.now();
  const child = Bun.spawn([...command, "--port", String(port)], {
    cwd: join(REPO, "server"),
    env: {
      ...env.baseEnv,
      PORT: String(port),
      HOST: "127.0.0.1",
      ROAMGATE_DISABLE_UPDATE_CHECK: "1",
      ROAMGATE_PASSWORD: PASSWORD,
      ROAMGATE_SETTINGS_PATH: join(env.root, "settings.json"),
      ROAMGATE_CONNECTIONS_PATH: join(
        env.root,
        options.connections === "ssh"
          ? "connections-ssh.json"
          : "connections.json",
      ),
      ROAMGATE_ASSISTANT_DIR: join(env.root, "assistant"),
      ROAMGATE_WEB_PUSH_PATH: join(env.root, "push.json"),
      ROAMGATE_ARCHIVE_DIR: join(env.root, "archive"),
      HERDR_SOCKET_PATH: env.herdrSockets.control,
      HERDR_CLIENT_SOCKET_PATH: env.herdrSockets.client,
      ...(options.testClock ? { ROAMGATE_TEST_CLOCK: options.testClock } : {}),
      ...(core ? { ROAMGATE_CORE_BIN: core } : {}),
      ...options.extraEnv,
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(`${logPath}.err`),
  });
  const base = `http://127.0.0.1:${port}`;
  let readyMs = -1;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`server exited ${child.exitCode}; see ${logPath}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) {
        readyMs = performance.now() - start;
        break;
      }
    } catch {}
    if (performance.now() - start > 60_000)
      throw new Error(`server did not start; see ${logPath}`);
    await Bun.sleep(2);
  }
  return {
    pid: child.pid,
    port,
    base,
    readyMs,
    exited: child.exited,
    async stop() {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await child.exited;
      clearTimeout(timer);
    },
  };
}

export async function connect(
  base: string,
  options: { ack?: boolean; connectionId?: string } = {},
) {
  const cookie = await login(base, PASSWORD);
  const client = new BenchClient(base, cookie, options);
  await client.open();
  return client;
}

/** Every process: its parent and resident set (kB). */
function processTable(): Map<number, { ppid: number; rss: number }> {
  const table = new Map<number, { ppid: number; rss: number }>();
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
        );
        const match = /VmRSS:\s+(\d+)/.exec(
          readFileSync(`/proc/${entry}/status`, "utf8"),
        );
        table.set(Number(entry), { ppid, rss: Number(match?.[1] ?? 0) });
      } catch {}
    }
    return table;
  }
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
  }).stdout;
  for (const line of out.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid) table.set(pid, { ppid: ppid ?? 0, rss: rss ?? 0 });
  }
  return table;
}

/** Resident set of a process and its descendants, kB. */
export function rssTree(pid: number): { self: number; tree: number } {
  const table = processTable();
  const children = new Map<number, number[]>();
  for (const [child, { ppid }] of table)
    children.set(ppid, [...(children.get(ppid) ?? []), child]);
  let tree = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    tree += table.get(p)?.rss ?? 0;
    stack.push(...(children.get(p) ?? []));
  }
  return { self: table.get(pid)?.rss ?? 0, tree };
}

/** Processes started in this world: by HOME, or naming its directory. */
function worldProcesses(env: BenchEnv): number[] {
  const mine: number[] = [];
  const homes = [`HOME=${env.home}`, `HOME=${env.remote.home}`];
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const environ = readFileSync(`/proc/${entry}/environ`, "utf8");
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (
          homes.some((home) => environ.includes(`${home}\0`)) ||
          cmdline.includes(env.root)
        )
          mine.push(Number(entry));
      } catch {}
    }
    return mine;
  }
  // ps -E appends each (own) process's environment to its command.
  const out = spawnSync("ps", ["-axwwE", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const text = match[2]!;
    if (
      homes.some((home) => text.includes(`${home} `) || text.endsWith(home)) ||
      text.includes(env.root)
    )
      mine.push(Number(match[1]));
  }
  return mine;
}

/** Kills every process still running from this world, then removes it. */
export async function destroyEnv(env: BenchEnv, keep = false) {
  for (const [sockets, home] of [
    [env.herdrSockets, env.home],
    [env.remote, env.remote.home],
  ] as const) {
    try {
      herdr(env, ["server", "stop"], sockets, home);
    } catch {}
  }
  await Bun.sleep(500);
  const mine = worldProcesses(env);
  for (const pid of mine)
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  if (mine.length) env.log(`killed ${mine.length} leftover processes`);
  if (!keep) rmSync(env.root, { recursive: true, force: true });
}

/** Waits until the default connection answers workspace.list; ms waited. */
export async function waitConnectionReady(
  client: BenchClient,
  connectionId?: string,
  timeoutMs = 60_000,
) {
  const start = performance.now();
  for (;;) {
    try {
      await client.call("workspace.list", {}, connectionId);
      return performance.now() - start;
    } catch (error) {
      if (performance.now() - start > timeoutMs) throw error;
      await Bun.sleep(5);
    }
  }
}

/**
 * The server's test clock (contract/wire/test-clock.md). `pump` moves it
 * along with real time while the harness waits; `advance` jumps.
 */
export class TestClock {
  private socket: import("node:net").Socket | null = null;
  private buffer = "";
  private waiters: ((line: string) => void)[] = [];
  private pumping = false;
  private pumpDone: Promise<void> | null = null;
  constructor(readonly path: string) {}

  async connect(timeoutMs = 30_000) {
    const net = await import("node:net");
    const start = performance.now();
    for (;;) {
      try {
        this.socket = await new Promise<import("node:net").Socket>(
          (resolve, reject) => {
            const socket = net.createConnection(this.path);
            socket.once("connect", () => resolve(socket));
            socket.once("error", reject);
          },
        );
        break;
      } catch (error) {
        if (performance.now() - start > timeoutMs) throw error;
        await Bun.sleep(5);
      }
    }
    this.socket.on("data", (data) => {
      this.buffer += String(data);
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        this.waiters.shift()?.(line);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  request(line: string): Promise<string> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.socket!.write(`${line}\n`);
    });
  }

  async advance(ms: number) {
    const reply = await this.request(`advance ${Math.round(ms)}`);
    if (reply.startsWith("error")) throw new Error(reply);
    return Number(reply);
  }

  /** Moves the clock by `stepMs` every `stepMs` of real time. */
  startPump(stepMs = 10) {
    if (this.pumping) return;
    this.pumping = true;
    this.pumpDone = (async () => {
      while (this.pumping) {
        await this.advance(stepMs);
        await Bun.sleep(stepMs);
      }
    })();
  }

  async stopPump() {
    this.pumping = false;
    await this.pumpDone;
  }

  close() {
    this.socket?.destroy();
  }
}
