import { randomBytes } from "node:crypto";

/**
 * What the activity log keeps of a workspace's repository: its root (the
 * main checkout for a linked worktree), the branch checked out and the URL
 * of its remote. Read with git on the connection's host, a few paths per
 * command, never modifying anything.
 */
export type RepoInfo = {
  /**
   * Null when git cannot tell: a linked worktree whose repository keeps its
   * git directory apart (`repo.git`); Herdr's root then stands.
   */
  root: string | null;
  branch: string | null;
  remoteUrl: string | null;
  isWorktree: boolean;
};

/** Runs a POSIX shell script on the connection's host. */
export type RunHostScript = (
  connectionId: string,
  script: string,
) => Promise<{ code: number; stdout: string }>;

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The script reading `paths`; its output is parsed by parseRepoInfo. */
export function repoInfoScript(paths: readonly string[], marker: string) {
  return [
    "export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0",
    ...paths.map(
      (path, index) => `p=${shQuote(path)}
printf '${marker} begin ${index}\\n'
if top=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null); then
  printf 'top %s\\n' "$top"
  printf 'common %s\\n' "$(git -C "$p" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  printf 'gitdir %s\\n' "$(git -C "$p" rev-parse --path-format=absolute --git-dir 2>/dev/null)"
  b=$(git -C "$p" symbolic-ref --short -q HEAD 2>/dev/null)
  printf 'branch %s\\n' "$b"
  r=""
  [ -n "$b" ] && r=$(git -C "$p" config --get "branch.$b.remote" 2>/dev/null)
  [ -z "$r" ] || [ "$r" = "." ] && r=origin
  u=$(git -C "$p" remote get-url "$r" 2>/dev/null || git -C "$p" remote get-url "$(git -C "$p" remote 2>/dev/null | head -n 1)" 2>/dev/null)
  printf 'remote %s\\n' "$u"
fi
printf '${marker} end ${index}\\n'`,
    ),
  ].join("\n");
}

/**
 * A remote URL without credentials: an https URL's user and password are
 * dropped (a token can sit there), scp-style `user@host:path` is kept.
 */
export function cleanRemoteUrl(value: string): string | null {
  const url = value.trim();
  if (!url || url.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parsed.username = "";
        parsed.password = "";
      } else parsed.password = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }
  return url;
}

function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function parseRepoInfo(
  output: string,
  paths: readonly string[],
  marker: string,
): Map<string, RepoInfo | null> {
  const result = new Map<string, RepoInfo | null>();
  let index: number | null = null;
  let fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.startsWith(`${marker} begin `)) {
      index = Number(line.slice(marker.length + 7));
      fields = new Map();
      continue;
    }
    if (line.startsWith(`${marker} end `)) {
      const path = index === null ? undefined : paths[index];
      if (path !== undefined) {
        const top = fields.get("top");
        if (!top) result.set(path, null);
        else {
          const common = fields.get("common") || null;
          const gitDir = fields.get("gitdir") || null;
          const isWorktree = !!common && !!gitDir && common !== gitDir;
          // A linked worktree's repository is its main checkout.
          const root = !isWorktree
            ? top
            : common && /\/\.git\/?$/.test(common)
              ? dirname(common)
              : null;
          result.set(path, {
            root,
            branch: fields.get("branch") || null,
            remoteUrl: cleanRemoteUrl(fields.get("remote") ?? ""),
            isWorktree,
          });
        }
      }
      index = null;
      continue;
    }
    if (index === null) continue;
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    if (["top", "common", "gitdir", "branch", "remote"].includes(key))
      fields.set(key, space < 0 ? "" : line.slice(space + 1));
  }
  return result;
}

/** Reads `paths` on a connection's host; null for one that is no repository. */
export async function readRepoInfo(
  run: RunHostScript,
  connectionId: string,
  paths: readonly string[],
): Promise<Map<string, RepoInfo | null>> {
  if (paths.length === 0) return new Map();
  const marker = `__ROAMGATE_REPO_${randomBytes(4).toString("hex")}__`;
  const output = await run(connectionId, repoInfoScript(paths, marker));
  if (output.code !== 0)
    throw new Error(`repository read exited ${output.code}`);
  return parseRepoInfo(output.stdout, paths, marker);
}
