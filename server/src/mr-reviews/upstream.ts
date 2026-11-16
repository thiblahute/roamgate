import type { ForgeProvider } from "../../../shared/forge";
import {
  type MrBranchInfo,
  type MrInboxEntry,
  type MrItem,
  type MrReviewsSettings,
  mrBranchKey,
} from "../../../shared/mrReviews";
import {
  type LiveWorkspaceIdentity,
  resolveWorkspaceTree,
  type WorkspaceRef,
  type WorkspaceTree,
  workspaceIdentity,
  workspaceRefKey,
  workspaceTreeAncestors,
} from "../../../shared/workspaceTree";
import { onGitlabHost, remoteProject } from "../review/gitlab";
import { type MrConnection, shQuote } from "./clones";
import { forgeHeadRef } from "./worktree";

/**
 * Branches headed upstream: the workspaces of the Workspaces-tree groups
 * marked "Headed upstream" (and the groups inside them), minus those the
 * user said are not, read from their checkouts (one cheap script per
 * connection, kept a minute; the commits only when the head or the target
 * moved). A branch whose request is open is the request's: it shows no
 * row of its own. Nothing here reads a forge; the only git fetch is of the
 * user's own requests' heads, into refs/roamgate/mr/*, when the inbox says
 * they moved (D13).
 */

/** How long a connection's scan is reused. */
export const UPSTREAM_SCAN_MS = 60_000;
/** Commits read per branch. */
export const BRANCH_COMMITS = 200;
/** Commits a row carries to the pages. */
const ROW_COMMITS = 50;

export type UpstreamMember = {
  connectionId: string;
  workspaceId: string;
  label: string;
  path: string;
  /** The marked group it is in (the nearest). */
  group: string;
};

/** The marked groups and every group below them. */
export function headedGroups(
  tree: WorkspaceTree,
  marked: readonly string[],
): Map<string, string> {
  const set = new Set(marked);
  const out = new Map<string, string>();
  for (const node of tree.nodes) {
    if (node.kind !== "group") continue;
    const marker = workspaceTreeAncestors(tree, node.id).find((id) =>
      set.has(id),
    );
    if (marker) out.set(node.id, marker);
  }
  return out;
}

/** Whether a workspace reference is one of the skipped ones. */
function skipped(ref: WorkspaceRef, skip: readonly WorkspaceRef[]): boolean {
  const key = workspaceRefKey(ref);
  return skip.some(
    (each) =>
      workspaceRefKey(each) === key ||
      (each.connection_id === ref.connection_id &&
        !!each.path &&
        each.path === ref.path),
  );
}

/**
 * The workspaces headed upstream: workspace nodes under a marked group,
 * resolved to the live ones (a connection not listed is not read), minus
 * the skipped.
 */
export function upstreamMembers(
  tree: WorkspaceTree,
  settings: Pick<MrReviewsSettings, "upstreamGroups" | "upstreamSkip">,
  live: ReadonlyMap<string, readonly LiveWorkspaceIdentity[]>,
  /**
   * Where a workspace without a checkout of its own works (its first
   * pane's folder), by `connection\0workspace`.
   */
  dirs: ReadonlyMap<string, string> = new Map(),
): UpstreamMember[] {
  if (!settings.upstreamGroups.length) return [];
  const groups = headedGroups(tree, settings.upstreamGroups);
  const resolved = resolveWorkspaceTree(tree, live);
  const out: UpstreamMember[] = [];
  for (const node of tree.nodes) {
    if (node.kind !== "workspace" || !node.parent) continue;
    const group = workspaceTreeAncestors(tree, node.parent).find((id) =>
      groups.has(id),
    );
    if (!group) continue;
    if (skipped(node.ref, settings.upstreamSkip)) continue;
    const found = resolved.nodes.get(node.id);
    if (found?.state !== "live") continue;
    const identity = live
      .get(found.connectionId)
      ?.find((each) => each.workspace_id === found.workspaceId);
    const path =
      identity?.path ?? dirs.get(`${found.connectionId}\0${found.workspaceId}`);
    if (!identity || !path) continue;
    out.push({
      connectionId: found.connectionId,
      workspaceId: found.workspaceId,
      label: identity.label,
      path,
      group: groups.get(group) ?? group,
    });
  }
  return out;
}

/**
 * For each directory: `W <dir>`, `B <branch>`, `H <head>`, `D <dirty
 * files>`, `P <unpushed>` (against its own upstream branch), `M <name>
 * <url>` per remote, and for `upstream` then `origin`, when they have a
 * default branch: `T <remote> <ref> <sha> <behind> <ahead>`. Cheap: no log.
 */
export function upstreamScanScript(dirs: string[]): string {
  return [
    `for d in ${dirs.map(shQuote).join(" ")}; do`,
    '  [ -d "$d" ] || continue',
    '  git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || continue',
    '  printf "W\\t%s\\n" "$d"',
    '  b=$(git -C "$d" symbolic-ref --short -q HEAD 2>/dev/null) && printf "B\\t%s\\n" "$b"',
    '  h=$(git -C "$d" rev-parse -q --verify HEAD 2>/dev/null) && printf "H\\t%s\\n" "$h"',
    '  printf "D\\t%s\\n" "$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d " ")"',
    `  p=$(git -C "$d" rev-list --count '@{u}..HEAD' 2>/dev/null) && printf "P\\t%s\\n" "$p"`,
    `  git -C "$d" config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k u; do n=\${k#remote.}; printf "M\\t%s\\t%s\\n" "\${n%.url}" "$u"; done`,
    "  for r in upstream origin; do",
    '    git -C "$d" config --get "remote.$r.url" >/dev/null 2>&1 || continue',
    '    t=$(git -C "$d" symbolic-ref --short -q "refs/remotes/$r/HEAD" 2>/dev/null)',
    '    if [ -z "$t" ]; then for c in main master; do git -C "$d" rev-parse -q --verify "refs/remotes/$r/$c" >/dev/null 2>&1 && t="$r/$c" && break; done; fi',
    '    [ -n "$t" ] || continue',
    '    s=$(git -C "$d" rev-parse -q --verify "$t" 2>/dev/null) || continue',
    '    c=$(git -C "$d" rev-list --left-right --count "$t...HEAD" 2>/dev/null | tr "\\t" " ")',
    '    printf "T\\t%s\\t%s\\t%s\\t%s\\n" "$r" "$t" "$s" "$c"',
    "  done",
    "done",
    "exit 0",
  ].join("\n");
}

export type ScannedCheckout = {
  branch?: string;
  head?: string;
  dirty: number;
  unpushed?: number;
  remotes: { name: string; url: string }[];
  targets: {
    remote: string;
    ref: string;
    sha: string;
    behind: number;
    ahead: number;
  }[];
};

export function parseUpstreamScan(
  stdout: string,
): Map<string, ScannedCheckout> {
  const dirs = new Map<string, ScannedCheckout>();
  let current: ScannedCheckout | null = null;
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    const [kind, a, b, c, d] = parts;
    if (kind === "W" && a?.startsWith("/")) {
      current = { dirty: 0, remotes: [], targets: [] };
      dirs.set(a, current);
    } else if (!current || !a) continue;
    else if (kind === "B") current.branch = a;
    else if (kind === "H" && /^[0-9a-f]{40,64}$/.test(a)) current.head = a;
    else if (kind === "D") current.dirty = Number(a) || 0;
    else if (kind === "P" && /^\d+$/.test(a)) current.unpushed = Number(a);
    else if (kind === "M" && b) current.remotes.push({ name: a, url: b });
    else if (kind === "T" && b && c && d) {
      const [behind, ahead] = d.split(" ").map(Number);
      if (Number.isFinite(behind) && Number.isFinite(ahead))
        current.targets.push({
          remote: a,
          ref: b,
          sha: c,
          behind: behind!,
          ahead: ahead!,
        });
    }
  }
  return dirs;
}

/**
 * The commits of each `dir target` pair beyond the target, newest first:
 * `W <dir>` then `C <sha> <author time> <subject>` and `I <patch id>
 * <sha>` lines.
 */
export function branchCommitsScript(
  pairs: { dir: string; target: string }[],
): string {
  return [
    ...pairs.flatMap(({ dir, target }) => [
      `d=${shQuote(dir)}; t=${shQuote(target)}`,
      'printf "W\\t%s\\n" "$d"',
      `git -C "$d" log --no-merges --max-count=${BRANCH_COMMITS} --format='C%x09%H%x09%at%x09%s' "$t..HEAD" 2>/dev/null`,
      `git -C "$d" log --no-merges --max-count=${BRANCH_COMMITS} -p --format='commit %H' "$t..HEAD" 2>/dev/null | git -C "$d" patch-id --stable 2>/dev/null | awk '{ print "I\\t" $1 "\\t" $2 }'`,
    ]),
    "exit 0",
  ].join("\n");
}

export type BranchCommit = {
  sha: string;
  at: number;
  subject: string;
  patchId?: string;
};

export function parseBranchCommits(
  stdout: string,
): Map<string, BranchCommit[]> {
  const out = new Map<string, BranchCommit[]>();
  let current: BranchCommit[] | null = null;
  let bySha = new Map<string, BranchCommit>();
  for (const line of stdout.split("\n")) {
    const [kind, a, b, ...rest] = line.split("\t");
    if (kind === "W" && a?.startsWith("/")) {
      current = [];
      bySha = new Map();
      out.set(a, current);
    } else if (!current || !a) continue;
    else if (kind === "C" && /^[0-9a-f]{40,64}$/.test(a)) {
      const commit = { sha: a, at: Number(b) || 0, subject: rest.join("\t") };
      current.push(commit);
      bySha.set(a, commit);
    } else if (kind === "I" && b) {
      const commit = bySha.get(b);
      if (commit) commit.patchId = a;
    }
  }
  return out;
}

/**
 * The forge project a checkout's work is headed to: the first of
 * `upstream`, `origin` whose remote is a project on one of the user's
 * hosts, with its default branch.
 */
export function targetOf(
  checkout: ScannedCheckout,
  hosts: readonly { host: string; provider: ForgeProvider }[],
): {
  provider: ForgeProvider;
  host: string;
  project: string;
  target: ScannedCheckout["targets"][number];
} | null {
  for (const target of checkout.targets) {
    const url = checkout.remotes.find(
      (remote) => remote.name === target.remote,
    )?.url;
    const remote = url ? remoteProject(url) : null;
    if (!remote) continue;
    const host = hosts.find((each) =>
      each.provider === "gitlab"
        ? onGitlabHost(remote.host, each.host)
        : remote.host === each.host || remote.host === `ssh.${each.host}`,
    );
    if (host)
      return {
        provider: host.provider,
        host: host.host,
        project: remote.project,
        target,
      };
  }
  return null;
}

/** A branch read from a member's checkout, before its rows are made. */
export type UpstreamBranch = {
  key: string;
  provider: ForgeProvider;
  host: string;
  project: string;
  branch: string;
  member: UpstreamMember;
  connectionLabel: string;
  head: string;
  dirty: number;
  unpushed?: number;
  target: { ref: string; sha: string; behind: number; ahead: number };
  commits: BranchCommit[];
};

/**
 * The request a branch is: one of the user's on the target project from
 * that branch (open or merged; a closed one leaves the branch's work
 * unproposed), or one whose commits hold all of the branch's by patch id.
 */
export function requestOfBranch(
  branch: Pick<
    UpstreamBranch,
    "provider" | "host" | "project" | "branch" | "commits"
  >,
  items: readonly MrItem[],
  patchIds: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): MrItem | null {
  const same = (item: MrItem) =>
    item.provider === branch.provider &&
    item.host.toLowerCase() === branch.host.toLowerCase() &&
    item.project.toLowerCase() === branch.project.toLowerCase();
  const own = items.filter(
    (item) =>
      item.reasons.includes("authored") &&
      same(item) &&
      item.state !== "closed",
  );
  const byName = own.find((item) => item.sourceBranch === branch.branch);
  if (byName) return byName;
  const ids = branch.commits.flatMap((commit) =>
    commit.patchId ? [commit.patchId] : [],
  );
  if (!ids.length || ids.length !== branch.commits.length) return null;
  return (
    own.find((item) => {
      const held = patchIds.get(item.key);
      return !!held && ids.every((id) => held.has(id));
    }) ?? null
  );
}

/** A branch's row in the inbox (own work, lane Not proposed upstream yet). */
export function branchEntry(
  branch: UpstreamBranch,
  settings: Pick<MrReviewsSettings, "unsent">,
  user: string,
): MrInboxEntry {
  const unsent = settings.unsent.find((each) => each.key === branch.key);
  const oldest = branch.commits[branch.commits.length - 1];
  const newest = branch.commits[0];
  const info: MrBranchInfo = {
    name: branch.branch,
    connectionId: branch.member.connectionId,
    connectionLabel: branch.connectionLabel,
    workspaceId: branch.member.workspaceId,
    workspaceLabel: branch.member.label,
    path: branch.member.path,
    target: branch.target.ref,
    ahead: branch.target.ahead,
    behind: branch.target.behind,
    dirty: branch.dirty,
    ...(branch.unpushed !== undefined ? { unpushed: branch.unpushed } : {}),
    commits: branch.commits.slice(0, ROW_COMMITS).map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      at: new Date(commit.at * 1000).toISOString(),
    })),
    group: branch.member.group,
  };
  return {
    provider: branch.provider,
    host: branch.host,
    project: branch.project,
    number: 0,
    key: branch.key,
    url: "",
    title: unsent?.title || oldest?.subject || branch.branch,
    author: user,
    draft: false,
    state: "open",
    updatedAt: newest ? new Date(newest.at * 1000).toISOString() : "",
    headSha: branch.head,
    sourceBranch: branch.branch,
    targetBranch:
      unsent?.target ??
      branch.target.ref.slice(branch.target.ref.indexOf("/") + 1),
    pipeline: null,
    notes: 0,
    reasons: ["authored"],
    section: "authored",
    unread: null,
    isNew: false,
    branch: info,
    ...(unsent ? { unsent: true } : {}),
  };
}

/**
 * Reads the members' branches, each connection at most every
 * UPSTREAM_SCAN_MS, the commits only when a head or a target moved.
 */
export function createUpstreamScanner(options: {
  connections: () => MrConnection[];
  tree: () => Promise<WorkspaceTree>;
  settings: () => Promise<MrReviewsSettings>;
  /** The inbox's requests: a branch's own request covers it. */
  items?: () => MrItem[];
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  let branches: UpstreamBranch[] = [];
  let lastMembers: UpstreamMember[] = [];
  let at = 0;
  let running: Promise<void> | null = null;
  /** Commits by `dir\0head\0target`. */
  const commitsCache = new Map<string, BranchCommit[]>();
  /** The patch ids of the user's requests' commits, by key, at a head. */
  const requestIds = new Map<string, { head: string; ids: Set<string> }>();
  const patchIds = () =>
    new Map([...requestIds].map(([key, value]) => [key, value.ids]));

  /**
   * For branches no request names, the patch ids of the user's open
   * requests on their project, read from the branch's clone (their heads
   * fetched there only when they moved).
   */
  async function readRequestIds(
    connection: MrConnection,
    found: UpstreamBranch[],
  ) {
    const items = options.items?.() ?? [];
    for (const branch of found) {
      if (requestOfBranch(branch, items, patchIds())) continue;
      const candidates = items.filter(
        (item) =>
          item.reasons.includes("authored") &&
          item.state === "open" &&
          item.provider === branch.provider &&
          item.host.toLowerCase() === branch.host.toLowerCase() &&
          item.project.toLowerCase() === branch.project.toLowerCase() &&
          !!item.headSha &&
          requestIds.get(item.key)?.head !== item.headSha,
      );
      if (!candidates.length) continue;
      const remote = branch.target.ref.slice(0, branch.target.ref.indexOf("/"));
      try {
        const read = parseRequestPatchIds(
          (
            await connection.run(
              requestPatchIdsScript(
                branch.member.path,
                remote,
                branch.target.ref,
                candidates.slice(0, 20).map((item) => ({
                  key: item.key,
                  provider: item.provider,
                  number: item.number,
                  head: item.headSha,
                })),
              ),
              120_000,
            )
          ).stdout,
        );
        for (const item of candidates.slice(0, 20))
          requestIds.set(item.key, {
            head: item.headSha,
            ids: read.get(item.key) ?? new Set(),
          });
      } catch {
        // Tried again when the scan runs next.
      }
    }
  }

  async function scan(): Promise<void> {
    const settings = await options.settings();
    if (!settings.upstreamGroups.length) {
      branches = [];
      return;
    }
    const tree = await options.tree();
    const connections = options.connections();
    const live = new Map<string, LiveWorkspaceIdentity[]>();
    const dirs = new Map<string, string>();
    for (const connection of connections) {
      try {
        const [listed, panes] = (await Promise.all([
          connection.herdr("workspace.list"),
          connection.herdr("pane.list").catch(() => null),
        ])) as [
          { workspaces?: Parameters<typeof workspaceIdentity>[0][] } | null,
          {
            panes?: {
              workspace_id?: string;
              cwd?: string;
              foreground_cwd?: string;
            }[];
          } | null,
        ];
        // Herdr gives a worktree's checkout; any other workspace is where
        // its first pane is (the tree names it by its label then, as the
        // pages do).
        for (const pane of panes?.panes ?? []) {
          const dir = pane.cwd || pane.foreground_cwd;
          const key = `${connection.id}\0${pane.workspace_id}`;
          if (pane.workspace_id && dir?.startsWith("/") && !dirs.has(key))
            dirs.set(key, dir);
        }
        live.set(
          connection.id,
          (listed?.workspaces ?? [])
            .filter((each) => typeof each?.workspace_id === "string")
            .map((each) => workspaceIdentity(each)),
        );
      } catch {
        // Not read: its workspaces show as they were last.
      }
    }
    const members = upstreamMembers(tree, settings, live, dirs);
    lastMembers = members;
    const next: UpstreamBranch[] = [];
    for (const connection of connections) {
      const mine = members.filter(
        (member) => member.connectionId === connection.id,
      );
      if (!mine.length) continue;
      const dirs = [...new Set(mine.map((member) => member.path))];
      let scanned: Map<string, ScannedCheckout>;
      try {
        scanned = parseUpstreamScan(
          (await connection.run(upstreamScanScript(dirs), 30_000)).stdout,
        );
      } catch {
        continue;
      }
      const wanted: { dir: string; target: string; cache: string }[] = [];
      const found: {
        member: UpstreamMember;
        checkout: ScannedCheckout;
        target: NonNullable<ReturnType<typeof targetOf>>;
      }[] = [];
      for (const member of mine) {
        const checkout = scanned.get(member.path);
        if (!checkout?.branch || !checkout.head) continue;
        const target = targetOf(checkout, settings.hosts);
        if (!target || !target.target.ahead) continue;
        found.push({ member, checkout, target });
        const cache = `${member.path}\0${checkout.head}\0${target.target.sha}`;
        if (!commitsCache.has(cache))
          wanted.push({ dir: member.path, target: target.target.ref, cache });
      }
      if (wanted.length) {
        try {
          const read = parseBranchCommits(
            (await connection.run(branchCommitsScript(wanted), 120_000)).stdout,
          );
          for (const each of wanted)
            commitsCache.set(each.cache, read.get(each.dir) ?? []);
        } catch {
          // Read again next time.
        }
      }
      const before = next.length;
      for (const { member, checkout, target } of found) {
        const commits =
          commitsCache.get(
            `${member.path}\0${checkout.head}\0${target.target.sha}`,
          ) ?? [];
        next.push({
          key: mrBranchKey({ ...target, branch: checkout.branch! }),
          provider: target.provider,
          host: target.host,
          project: target.project,
          branch: checkout.branch!,
          member,
          connectionLabel: connection.label,
          head: checkout.head!,
          dirty: checkout.dirty,
          ...(checkout.unpushed !== undefined
            ? { unpushed: checkout.unpushed }
            : {}),
          target: target.target,
          commits,
        });
      }
      await readRequestIds(connection, next.slice(before));
    }
    // A cache entry no branch uses any more goes.
    const used = new Set(
      next.map(
        (branch) =>
          `${branch.member.path}\0${branch.head}\0${branch.target.sha}`,
      ),
    );
    for (const key of commitsCache.keys())
      if (!used.has(key)) commitsCache.delete(key);
    branches = next;
  }

  return {
    /** The branches as last read. */
    branches: () => branches,
    /** The workspaces headed upstream as last read. */
    members: () => lastMembers,
    /** The user's requests' patch ids read for linking, by key. */
    patchIds,
    /** Reads them again unless read within UPSTREAM_SCAN_MS (or forced). */
    refresh(force = false): Promise<void> {
      if (running) return running;
      if (!force && now() - at < UPSTREAM_SCAN_MS) return Promise.resolve();
      at = now();
      running = scan()
        .catch(() => {})
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}

export type UpstreamScanner = ReturnType<typeof createUpstreamScanner>;

/**
 * Fetches the user's open requests' heads of a branch's target project
 * into refs/roamgate/mr/<number> when the local ref is not at the head the
 * inbox knows (D13), then prints `R <key>` and the patch ids of the
 * request's commits beyond the target (`I <patch id>`).
 */
export function requestPatchIdsScript(
  dir: string,
  remote: string,
  target: string,
  requests: {
    key: string;
    provider: ForgeProvider;
    number: number;
    head: string;
  }[],
): string {
  return [
    `d=${shQuote(dir)}; r=${shQuote(remote)}; t=${shQuote(target)}`,
    'export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"',
    ...requests.flatMap((request) => {
      const local = `refs/roamgate/mr/${request.number}`;
      return [
        `if [ "$(git -C "$d" rev-parse -q --verify ${local} 2>/dev/null)" != ${shQuote(request.head)} ]; then git -C "$d" fetch -q --no-tags "$r" ${shQuote(`+${forgeHeadRef(request.provider, request.number)}:${local}`)} >/dev/null 2>&1; fi`,
        `printf "R\\t%s\\n" ${shQuote(request.key)}`,
        `git -C "$d" log --no-merges --max-count=${BRANCH_COMMITS} -p --format='commit %H' "$t..${local}" 2>/dev/null | git -C "$d" patch-id --stable 2>/dev/null | awk '{ print "I\\t" $1 }'`,
      ];
    }),
    "exit 0",
  ].join("\n");
}

export function parseRequestPatchIds(stdout: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const line of stdout.split("\n")) {
    const [kind, value] = line.split("\t");
    if (kind === "R" && value) {
      current = new Set();
      out.set(value, current);
    } else if (kind === "I" && value && current) current.add(value);
  }
  return out;
}
