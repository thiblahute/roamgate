/**
 * The machines the archive covers and how to reach them. This machine is read
 * in place; an ssh host is pulled into a mirror with rsync (incremental, over
 * its own connection) or pushes into that mirror itself, and the mirror is
 * then synced like a local directory.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ADAPTERS, type AgentAdapter } from "./adapters";
import type { ArchiveHostSpec, GuiArchiveSettings } from "./settings";

export type ArchiveRuntime = {
  homeDir: string;
  platform: string;
  env: Record<string, string | undefined>;
  /** Roamgate's data directory (settings.json, connections.json). */
  dataDir: string;
};

export type ResolvedHost = {
  id: string;
  /** This machine. */
  self: boolean;
  ssh?: string;
  home?: string;
  pathStyle: "posix" | "windows";
  roots: Record<string, string>;
  enabled: boolean;
};

export const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ConnectionProfile = {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  ssh_destination?: unknown;
};

function readProfiles(runtime: ArchiveRuntime): ConnectionProfile[] {
  const path =
    runtime.env.ROAMGATE_CONNECTIONS_PATH?.trim() ||
    join(runtime.dataDir, "connections.json");
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      profiles?: unknown;
    };
    return Array.isArray(parsed.profiles)
      ? (parsed.profiles as ConnectionProfile[])
      : [];
  } catch {
    return [];
  }
}

function hostIdOf(profile: ConnectionProfile): string | null {
  const raw =
    typeof profile.label === "string" && profile.label.trim()
      ? profile.label
      : typeof profile.id === "string"
        ? profile.id
        : "";
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return SAFE_HOST.test(id) ? id : null;
}

/** This machine's name in the archive. */
export function selfHostId(
  settings: GuiArchiveSettings,
  runtime: ArchiveRuntime,
): string {
  const configured = runtime.env.ROAMGATE_ARCHIVE_HOST?.trim() || settings.host;
  if (configured && SAFE_HOST.test(configured)) return configured;
  const local = readProfiles(runtime).find((p) => p.type === "local");
  const fromProfile = local ? hostIdOf(local) : null;
  if (fromProfile) return fromProfile;
  const short = hostname().split(".")[0]?.toLowerCase() ?? "host";
  return SAFE_HOST.test(short) ? short : "host";
}

/**
 * The hosts in play: this machine, the ssh profiles of Roamgate's own
 * connections (when the file exists), and the configured ones on top.
 */
export function resolveHosts(
  settings: GuiArchiveSettings,
  runtime: ArchiveRuntime,
): ResolvedHost[] {
  const self = selfHostId(settings, runtime);
  const specs = new Map<string, ArchiveHostSpec>();
  for (const profile of readProfiles(runtime)) {
    const id = hostIdOf(profile);
    if (!id || id === self) continue;
    if (profile.type === "ssh" && typeof profile.ssh_destination === "string")
      specs.set(id, { ssh: profile.ssh_destination });
  }
  for (const [id, spec] of Object.entries(settings.hosts))
    specs.set(id, { ...specs.get(id), ...spec });
  const hosts: ResolvedHost[] = [
    {
      id: self,
      self: true,
      home: runtime.homeDir,
      pathStyle: runtime.platform === "win32" ? "windows" : "posix",
      roots: settings.hosts[self]?.roots ?? {},
      enabled: true,
    },
  ];
  for (const [id, spec] of specs) {
    if (id === self || !SAFE_HOST.test(id)) continue;
    hosts.push({
      id,
      self: false,
      ...(spec.ssh ? { ssh: spec.ssh } : {}),
      ...(spec.home ? { home: spec.home } : {}),
      pathStyle: spec.path_style ?? "posix",
      roots: spec.roots ?? {},
      enabled: spec.enabled !== false && Boolean(spec.ssh),
    });
  }
  return hosts;
}

export function enabledAdapters(settings: GuiArchiveSettings): AgentAdapter[] {
  return settings.agents.flatMap((id) => {
    const adapter = ADAPTERS[id];
    return adapter ? [adapter] : [];
  });
}

/** The session root of an agent on this machine. */
export function localRoot(
  adapter: AgentAdapter,
  host: ResolvedHost,
  runtime: ArchiveRuntime,
): string {
  return (
    host.roots[adapter.id] ?? adapter.rootFor(runtime.homeDir, runtime.env)
  );
}

/** Where a remote host's agent files are mirrored: tree/ and extra/. */
export function mirrorDir(
  archiveDir: string,
  host: string,
  agent: string,
): string {
  return join(archiveDir, "mirror", host, agent);
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (argv: string[], timeoutMs?: number) => Promise<ExecResult>;

export const defaultExec: Exec = async (
  argv,
  timeoutMs = 6 * 60 * 60 * 1000,
) => {
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** ssh options: BatchMode, a connect timeout, never a shared master. */
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
];

function rsyncShell(): string {
  return `ssh ${SSH_OPTIONS.join(" ")}`;
}

/** Single-quote a word for a POSIX shell. */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The user's home on an ssh host, asked with POSIX sh only. */
export async function remoteHome(
  exec: Exec,
  ssh: string,
): Promise<string | null> {
  const result = await exec(
    ["ssh", ...SSH_OPTIONS, ssh, 'printf %s "$HOME"'],
    60_000,
  );
  const home = result.stdout.trim();
  return result.code === 0 && home.startsWith("/") ? home : null;
}

export class UnreachableHost extends Error {}

function remoteRoot(
  adapter: AgentAdapter,
  host: ResolvedHost,
  home: string | null,
): string | null {
  const configured = host.roots[adapter.id];
  if (configured) return configured;
  if (!home) return null;
  return adapter.rootFor(home, {});
}

/** Pull one agent of an ssh host into its mirror. Returns false when the agent has no sessions there. */
export async function pullAgent(
  exec: Exec,
  archiveDir: string,
  host: ResolvedHost,
  adapter: AgentAdapter,
  home: string | null,
): Promise<boolean> {
  if (!host.ssh) return false;
  if (host.pathStyle === "windows")
    throw new Error("windows hosts are not supported yet");
  if (adapter.snapshot) return false; // live sqlite files are not copied remotely
  const root = remoteRoot(adapter, host, home);
  if (!root) return false;
  const mirror = mirrorDir(archiveDir, host.id, adapter.id);
  const base = [
    "rsync",
    "-rt",
    "--inplace",
    "--partial",
    "--mkpath",
    "--timeout=120",
    "-e",
    rsyncShell(),
  ];
  const tree = await exec([
    ...base,
    ...adapter.rsyncFilters,
    `${host.ssh}:${root}/`,
    `${join(mirror, "tree")}/`,
  ]);
  if (tree.code === 23 || tree.code === 24) {
    // Missing source dir (23) or files vanished (24): the rest was copied.
    if (!/No such file or directory/.test(tree.stderr) || tree.code === 24)
      return true;
    return false;
  }
  if (tree.code !== 0)
    throw new UnreachableHost(
      `rsync ${host.ssh}: exit ${tree.code} ${tree.stderr.trim().slice(0, 300)}`,
    );
  for (const extra of adapter.extraFiles ?? []) {
    const result = await exec([
      ...base,
      `${host.ssh}:${home ?? "~"}/${extra.homePath}`,
      join(mirror, "extra", extra.relpath),
    ]);
    if (result.code !== 0 && result.code !== 23)
      throw new UnreachableHost(`rsync ${host.ssh}: exit ${result.code}`);
  }
  return true;
}

/** Push this machine's files for one agent into the archive home's mirror. */
export async function pushAgent(
  exec: Exec,
  push: NonNullable<GuiArchiveSettings["push"]>,
  hostId: string,
  adapter: AgentAdapter,
  root: string,
  extras: Array<{ path: string; relpath: string }>,
): Promise<void> {
  const remote = push.archive_dir ?? "~/.config/roamgate/claude-archive";
  const mirror = `${remote}/mirror/${hostId}/${adapter.id}`;
  const base = [
    "rsync",
    "-rt",
    "--inplace",
    "--partial",
    "--mkpath",
    "--timeout=120",
    "-e",
    rsyncShell(),
  ];
  if (existsSync(root)) {
    const tree = await exec([
      ...base,
      ...adapter.rsyncFilters,
      `${root}/`,
      `${push.target}:${mirror}/tree/`,
    ]);
    if (tree.code !== 0 && tree.code !== 24)
      throw new UnreachableHost(
        `rsync ${push.target}: exit ${tree.code} ${tree.stderr.trim().slice(0, 300)}`,
      );
  }
  for (const extra of extras) {
    if (!existsSync(extra.path)) continue;
    const result = await exec([
      ...base,
      extra.path,
      `${push.target}:${mirror}/extra/${extra.relpath}`,
    ]);
    if (result.code !== 0 && result.code !== 24)
      throw new UnreachableHost(`rsync ${push.target}: exit ${result.code}`);
  }
}

/** Ask the archive home, over ssh with POSIX sh only, to ingest what was pushed. */
export async function remoteIngest(
  exec: Exec,
  push: NonNullable<GuiArchiveSettings["push"]>,
  hostId: string,
): Promise<ExecResult> {
  const binary = push.binary ?? '"$HOME/.local/bin/roamgate"';
  const dir = push.archive_dir?.startsWith("/")
    ? ` --dir ${shQuote(push.archive_dir)}`
    : "";
  const command = `exec ${binary} archive ingest ${shQuote(hostId)}${dir} --json`;
  return exec(
    ["ssh", ...SSH_OPTIONS, push.target, command],
    6 * 60 * 60 * 1000,
  );
}
