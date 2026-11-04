import type { ForgeProvider } from "../../../shared/forge";
import { mrProjectKey } from "../../../shared/mrReviews";
import { onGitlabHost, remoteProject } from "../review/gitlab";

/**
 * The user's own clones of a project, found among the directories their
 * workspaces and panes are in: one script per connection reads each
 * directory's repository, its main checkout and its remotes. Read only.
 */

export type ShellResult = { code: number; stdout: string; stderr: string };

/** A connection the reviews module can work on. */
export type MrConnection = {
  id: string;
  label: string;
  /** A POSIX shell script on the connection's host. */
  run: (script: string, timeoutMs?: number) => Promise<ShellResult>;
  /** Directories of its workspaces and panes. */
  dirs: () => Promise<string[]>;
  /** A Herdr call on the connection. */
  herdr: (method: string, params?: Record<string, unknown>) => Promise<any>;
  /** Conversation mode on the connection, when it runs there. */
  conversation?: {
    /** The session conversation mode holds the pane on, if it does. */
    owned(paneId: string): string | null;
    /** Its own switch: the idle process stops, the other session starts. */
    switch(
      paneId: string,
      sessionId: string,
    ): Promise<{ ok: true } | { ok: false; busy: boolean; reason: string }>;
  };
};

export type FoundClone = {
  connectionId: string;
  /** The main checkout (not a linked worktree). */
  path: string;
  /** The remote that is the project. */
  remote: string;
};

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * For each directory: `R <main checkout>` then `M <name> <url>` per fetch
 * remote. Directories outside a repository print nothing.
 */
export function clonesScript(dirs: string[]): string {
  return [
    "for d in " + dirs.map(shQuote).join(" ") + "; do",
    '  [ -d "$d" ] || continue',
    '  c=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue',
    '  case "$c" in */.git) m=${c%/.git} ;; *) continue ;; esac',
    '  printf "R\\t%s\\n" "$m"',
    // The configured URLs, as written (`remote -v` applies insteadOf).
    `  git -C "$m" config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k u; do n=\${k#remote.}; printf "M\\t%s\\t%s\\n" "\${n%.url}" "$u"; done`,
    "done",
    "exit 0",
  ].join("\n");
}

export type ScannedRepo = {
  path: string;
  remotes: { name: string; url: string }[];
};

export function parseClones(stdout: string): ScannedRepo[] {
  const repos = new Map<string, ScannedRepo>();
  let current: ScannedRepo | null = null;
  for (const line of stdout.split("\n")) {
    const [kind, a, b] = line.split("\t");
    if (kind === "R" && a?.startsWith("/")) {
      current = repos.get(a) ?? { path: a, remotes: [] };
      repos.set(a, current);
    } else if (kind === "M" && current && a && b) {
      if (!current.remotes.some((remote) => remote.name === a))
        current.remotes.push({ name: a, url: b });
    }
  }
  return [...repos.values()];
}

/** Whether a remote URL is the project on its forge host. */
export function remoteIsProject(
  url: string,
  ref: { host: string; project: string; provider: ForgeProvider },
): boolean {
  const remote = remoteProject(url);
  if (!remote) return false;
  const host = ref.host.toLowerCase();
  const onHost =
    ref.provider === "gitlab"
      ? onGitlabHost(remote.host, host)
      : remote.host === host || remote.host === `ssh.${host}`;
  return onHost && remote.project.toLowerCase() === ref.project.toLowerCase();
}

/** The clones of one project among scanned repositories. */
export function matchClones(
  connectionId: string,
  repos: ScannedRepo[],
  ref: { host: string; project: string; provider: ForgeProvider },
): FoundClone[] {
  return repos.flatMap((repo) => {
    // A review worktree's own repository is its clone's: never a clone.
    if (/\.worktrees\/review$/.test(repo.path)) return [];
    const remote = repo.remotes.find((entry) =>
      remoteIsProject(entry.url, ref),
    );
    return remote
      ? [{ connectionId, path: repo.path, remote: remote.name }]
      : [];
  });
}

const SCAN_TTL_MS = 10 * 60_000;

/** Clone lookups, cached per connection. */
export function createCloneFinder() {
  const scans = new Map<
    string,
    { at: number; repos: Promise<ScannedRepo[]> }
  >();
  async function scan(connection: MrConnection): Promise<ScannedRepo[]> {
    const known = scans.get(connection.id);
    if (known && Date.now() - known.at < SCAN_TTL_MS) return known.repos;
    const repos = (async () => {
      const dirs = [
        ...new Set(
          (await connection.dirs()).filter((dir) => dir.startsWith("/")),
        ),
      ].slice(0, 200);
      if (!dirs.length) return [];
      const result = await connection.run(clonesScript(dirs), 30_000);
      return parseClones(result.stdout);
    })();
    const entry = { at: Date.now(), repos };
    scans.set(connection.id, entry);
    repos.catch(() => {
      if (scans.get(connection.id) === entry) scans.delete(connection.id);
    });
    return repos;
  }
  return {
    /** Every clone of the project on the connections, local first. */
    async find(
      connections: MrConnection[],
      ref: { host: string; project: string; provider: ForgeProvider },
    ): Promise<FoundClone[]> {
      const found: FoundClone[] = [];
      for (const connection of connections) {
        try {
          found.push(
            ...matchClones(connection.id, await scan(connection), ref),
          );
        } catch {}
      }
      return found;
    },
    /** Checks a path the user gave: a clone of the project there. */
    async check(
      connection: MrConnection,
      path: string,
      ref: { host: string; project: string; provider: ForgeProvider },
    ): Promise<FoundClone | null> {
      const result = await connection.run(clonesScript([path]), 30_000);
      return (
        matchClones(connection.id, parseClones(result.stdout), ref)[0] ?? null
      );
    },
    forget(connectionId?: string) {
      if (connectionId) scans.delete(connectionId);
      else scans.clear();
    },
    key: mrProjectKey,
  };
}

export type CloneFinder = ReturnType<typeof createCloneFinder>;

/**
 * The order a project's clone is looked for in, and its review worktree
 * made: the default connection, then this machine, then the others.
 */
export function orderConnections<T>(
  entries: { isDefault: boolean; remote: boolean; connection: T }[],
): T[] {
  const rank = (entry: { isDefault: boolean; remote: boolean }) =>
    entry.isDefault ? 0 : entry.remote ? 2 : 1;
  return [...entries]
    .sort((a, b) => rank(a) - rank(b))
    .map((entry) => entry.connection);
}
