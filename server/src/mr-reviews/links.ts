import type { MrItem, MrWorkspaceLink } from "../../../shared/mrReviews";
import { type MrConnection, remoteIsProject, shQuote } from "./clones";

/**
 * The workspaces that are a request's: on its source branch in a clone of
 * its project, named after it, or its review workspace. Read from each
 * connection's workspaces (Herdr) and one git script per connection, kept
 * a little while; no forge call.
 */

/** A workspace as matched: where it is and what its checkout is on. */
export type ScannedWorkspace = {
  connectionId: string;
  connectionLabel: string;
  workspaceId: string;
  label: string;
  /** The checkout's branch, its upstream ("origin/x") and remote URLs. */
  branch?: string;
  upstream?: string;
  remotes: string[];
};

/**
 * For each directory: `W <dir>`, then `B <branch>`, `U <upstream>` and
 * `M <url>` per remote. Directories outside a repository print only W.
 */
export function workspaceScript(dirs: string[]): string {
  return [
    `for d in ${dirs.map(shQuote).join(" ")}; do`,
    '  [ -d "$d" ] || continue',
    '  printf "W\\t%s\\n" "$d"',
    '  b=$(git -C "$d" symbolic-ref --short -q HEAD 2>/dev/null) && printf "B\\t%s\\n" "$b"',
    `  u=$(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) && printf "U\\t%s\\n" "$u"`,
    `  git -C "$d" config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k v; do printf "M\\t%s\\n" "$v"; done`,
    "done",
    "exit 0",
  ].join("\n");
}

export type ScannedDir = {
  branch?: string;
  upstream?: string;
  remotes: string[];
};

export function parseWorkspaceScan(stdout: string): Map<string, ScannedDir> {
  const dirs = new Map<string, ScannedDir>();
  let current: ScannedDir | null = null;
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const kind = line.slice(0, tab);
    const value = line.slice(tab + 1);
    if (kind === "W" && value.startsWith("/")) {
      current = { remotes: [] };
      dirs.set(value, current);
    } else if (!current || !value) continue;
    else if (kind === "B") current.branch = value;
    else if (kind === "U") current.upstream = value;
    else if (kind === "M" && !current.remotes.includes(value))
      current.remotes.push(value);
  }
  return dirs;
}

/** The repository name of a project path ("group/sub/name" -> "name"). */
function repoName(project: string): string {
  return project.slice(project.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * Whether a checkout's remotes are the request's project: one of them is,
 * or (a fork) one has the same repository name on the same host. Unknown
 * (no remote read) is not a match.
 */
function sameProject(
  remotes: string[],
  item: Pick<MrItem, "host" | "project" | "provider">,
): boolean {
  if (remotes.some((url) => remoteIsProject(url, item))) return true;
  const name = repoName(item.project);
  const host = item.host.toLowerCase();
  return remotes.some((url) => {
    const match =
      /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i.exec(
        url.trim(),
      );
    if (!match) return false;
    const urlHost = match[1]!.toLowerCase();
    return (
      (urlHost === host || urlHost.endsWith(`.${host}`)) &&
      repoName(match[2]!) === name
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The workspaces that are the request's, each with why: the home made for
 * it, its checkout is on
 * the source branch (or tracks it) in a clone of the project, its name
 * carries the request's number or branch, or it is the request's review
 * workspace. A generic branch (the target's own name) never matches.
 */
export function matchWorkspaces(
  item: Pick<
    MrItem,
    | "key"
    | "host"
    | "project"
    | "provider"
    | "number"
    | "sourceBranch"
    | "targetBranch"
  >,
  workspaces: ScannedWorkspace[],
  review?: { connectionId: string; workspaceId?: string },
  /** The home made for it ("Start a review with a home"). */
  home?: { connectionId: string; workspaceId: string },
): MrWorkspaceLink[] {
  const links = new Map<string, MrWorkspaceLink>();
  const add = (
    workspace: ScannedWorkspace,
    why: MrWorkspaceLink["why"][number],
  ) => {
    const id = `${workspace.connectionId}\n${workspace.workspaceId}`;
    const link = links.get(id) ?? {
      connectionId: workspace.connectionId,
      connectionLabel: workspace.connectionLabel,
      workspaceId: workspace.workspaceId,
      label: workspace.label,
      why: [],
    };
    if (!link.why.includes(why)) link.why.push(why);
    links.set(id, link);
  };
  const branch = item.sourceBranch;
  const usable =
    !!branch && branch !== item.targetBranch && !/^(main|master)$/.test(branch);
  const mark = item.provider === "gitlab" ? "!" : "#";
  const byNumber = new RegExp(
    `(?:${escapeRegExp(mark)}|\\b(?:mr|pr)[-_ ]?)${item.number}(?!\\d)`,
    "i",
  );
  for (const workspace of workspaces) {
    const project = sameProject(workspace.remotes, item);
    if (
      home &&
      home.connectionId === workspace.connectionId &&
      home.workspaceId === workspace.workspaceId
    )
      add(workspace, "home");
    if (review?.workspaceId && review.connectionId === workspace.connectionId)
      if (review.workspaceId === workspace.workspaceId)
        add(workspace, "review");
    if (usable && project) {
      const upstream = workspace.upstream?.slice(
        workspace.upstream.indexOf("/") + 1,
      );
      if (workspace.branch === branch || upstream === branch)
        add(workspace, "branch");
    }
    // A name is only trusted in the project's clone, or outside any repository.
    if (project || !workspace.remotes.length) {
      const label = workspace.label;
      if (
        byNumber.test(label) ||
        (usable && branch.length >= 4 && label.includes(branch))
      )
        add(workspace, "name");
    }
  }
  const rank = (link: MrWorkspaceLink) =>
    link.why.includes("home")
      ? 0
      : link.why.includes("branch")
        ? 1
        : link.why.includes("name")
          ? 2
          : 3;
  return [...links.values()].sort((a, b) => rank(a) - rank(b));
}

/** How long a connection's scan is reused. */
export const LINK_SCAN_MS = 60_000;

type HerdrPane = {
  workspace_id?: string;
  cwd?: string;
  foreground_cwd?: string;
};

type HerdrWorkspace = {
  workspace_id?: string;
  label?: string;
  cwd?: string;
  worktree?: { checkout_path?: string };
};

/** Each connection's workspaces, scanned and kept LINK_SCAN_MS. */
export function createWorkspaceLinker(options: {
  connections: () => MrConnection[];
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const scans = new Map<
    string,
    { at: number; workspaces: Promise<ScannedWorkspace[]> }
  >();
  async function scanConnection(
    connection: MrConnection,
  ): Promise<ScannedWorkspace[]> {
    // Herdr gives a workspace's checkout when it is one; its panes' folders
    // say where the work is otherwise.
    const [listed, panes] = (await Promise.all([
      connection.herdr("workspace.list"),
      connection.herdr("pane.list").catch(() => null),
    ])) as [
      { workspaces?: HerdrWorkspace[] } | null,
      { panes?: HerdrPane[] } | null,
    ];
    const workspaces = (listed?.workspaces ?? []).filter(
      (each): each is HerdrWorkspace & { workspace_id: string } =>
        typeof each.workspace_id === "string",
    );
    const dirsOf = new Map<string, string[]>();
    const note = (id: string | undefined, dir: string | undefined) => {
      if (!id || !dir?.startsWith("/")) return;
      const list = dirsOf.get(id) ?? [];
      if (!list.includes(dir) && list.length < 4) list.push(dir);
      dirsOf.set(id, list);
    };
    for (const each of workspaces) {
      note(each.workspace_id, each.worktree?.checkout_path);
      note(each.workspace_id, each.cwd);
    }
    for (const pane of panes?.panes ?? []) {
      note(pane.workspace_id, pane.foreground_cwd);
      note(pane.workspace_id, pane.cwd);
    }
    const dirs = [...new Set([...dirsOf.values()].flat())].slice(0, 200);
    const scanned = dirs.length
      ? parseWorkspaceScan(
          (await connection.run(workspaceScript(dirs), 30_000)).stdout,
        )
      : new Map<string, ScannedDir>();
    // One entry per checkout of a workspace (matching merges them).
    return workspaces.flatMap((each) => {
      const base = {
        connectionId: connection.id,
        connectionLabel: connection.label,
        workspaceId: each.workspace_id,
        label: each.label ?? "",
      };
      const found = (dirsOf.get(each.workspace_id) ?? []).flatMap((dir) => {
        const checkout = scanned.get(dir);
        return checkout?.remotes.length || checkout?.branch ? [checkout] : [];
      });
      if (!found.length) return [{ ...base, remotes: [] }];
      return found.map((checkout) => ({
        ...base,
        ...(checkout.branch ? { branch: checkout.branch } : {}),
        ...(checkout.upstream ? { upstream: checkout.upstream } : {}),
        remotes: checkout.remotes,
      }));
    });
  }
  function scan(connection: MrConnection): Promise<ScannedWorkspace[]> {
    const known = scans.get(connection.id);
    if (known && now() - known.at < LINK_SCAN_MS) return known.workspaces;
    const entry = { at: now(), workspaces: scanConnection(connection) };
    scans.set(connection.id, entry);
    entry.workspaces.catch(() => {
      if (scans.get(connection.id) === entry) scans.delete(connection.id);
    });
    return entry.workspaces;
  }
  return {
    /** The linked workspaces of each request, by key. */
    async links(
      items: MrItem[],
      reviews: Record<string, { connectionId: string; workspaceId?: string }>,
      homes: Record<string, { connectionId: string; workspaceId: string }> = {},
    ): Promise<Record<string, MrWorkspaceLink[]>> {
      const all: ScannedWorkspace[] = [];
      for (const connection of options.connections()) {
        try {
          all.push(...(await scan(connection)));
        } catch {
          // A connection that does not answer has no link to give.
        }
      }
      const out: Record<string, MrWorkspaceLink[]> = {};
      for (const item of items) {
        const found = matchWorkspaces(
          item,
          all,
          reviews[item.key],
          homes[item.key],
        );
        if (found.length) out[item.key] = found;
      }
      return out;
    },
    forget() {
      scans.clear();
    },
  };
}
