import { randomUUID } from "node:crypto";
import { forgeRefLabel } from "../../../shared/forge";
import type { MrItem } from "../../../shared/mrReviews";
import { mrHomePrompt, mrProjectKey } from "../../../shared/mrReviews";
import type { ReviewSnapshot } from "../../../shared/review";
import type { AgentCommand } from "../profiles/profiles";
import { type Logger, serverLogger } from "../utils/logger";
import { claudeCommand, profileLaunch } from "./claude";
import { type MrConnection, remoteIsProject, shQuote } from "./clones";
import { MrReviewsError } from "./rpc";
import type { MrHomeRecord, MrProjectRecord, MrStore } from "./store";
import { fetchScript, parseFetch, projectUrl } from "./worktree";

/**
 * A request's home: a workspace of its own, where its review is shown and
 * its agent keeps its notes. Opening a request that has one (on its
 * branch, named after it, or made here) shows its review there, not in the
 * project's shared review workspace. "Start a review with a home" makes
 * one: a worktree through the user's worktree path on the request's head,
 * named after it, placed where the project's reviews go, with a Claude
 * session told its job. Nothing is ever sent to a forge: git only fetches.
 */

/** The workspace label of a request's home: "!3326 rtpgccbwe: Fix...". */
export function homeLabel(
  item: Pick<MrItem, "provider" | "number" | "title" | "host" | "project">,
): string {
  const ref = forgeRefLabel(item, true);
  const title = item.title.replace(/\s+/g, " ").trim();
  const full = `${ref} ${title}`;
  return full.length > 60 ? `${full.slice(0, 59).trimEnd()}…` : full;
}

/** A branch name git and the worktree command take, from the forge's. */
export function homeBranchName(
  item: Pick<MrItem, "sourceBranch" | "number">,
): string {
  const cleaned = (item.sourceBranch ?? "")
    .replace(/[^\w./-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .replace(/\.lock$/, "")
    .slice(0, 120);
  return cleaned && !/^(main|master)$/.test(cleaned)
    ? cleaned
    : `review/${item.number}`;
}

/**
 * The branch to make in the clone: the request's own name unless the clone
 * has a branch of that name (the user's, never moved): then review/N-name.
 * Prints `NAME <branch>`.
 */
export function homeBranchScript(
  clone: string,
  wanted: string,
  number: number,
): string {
  const other = `review/${number}-${wanted}`.slice(0, 200);
  return [
    `cd ${shQuote(clone)} || exit 2`,
    `b=${shQuote(wanted)}`,
    `if git show-ref --verify --quiet "refs/heads/$b"; then b=${shQuote(other)}; fi`,
    `if git show-ref --verify --quiet "refs/heads/$b"; then b="$b-$(date +%Y%m%d-%H%M%S)"; fi`,
    'printf "NAME %s\\n" "$b"',
  ].join("\n");
}

/**
 * Puts the new worktree's branch on the request's head. The worktree is
 * fresh (made from the target's tip a moment ago): `--keep` still refuses
 * to lose anything a setup hook may have written. Prints `AT <sha>`.
 */
export function homeCheckoutScript(path: string, sha: string): string {
  return [
    `cd ${shQuote(path)} || exit 2`,
    `git cat-file -e ${shQuote(`${sha}^{commit}`)} 2>/dev/null || { echo NOCOMMIT; exit 3; }`,
    `git reset -q --keep ${shQuote(sha)} >&2 || exit 4`,
    'echo "AT $(git rev-parse HEAD)"',
  ].join("\n");
}

/** The checkout's top and its remotes: `T <top>`, then `R <name> <url>`. */
export function homeRootScript(dir: string): string {
  return [
    `cd ${shQuote(dir)} 2>/dev/null || exit 2`,
    'printf "T\\t%s\\n" "$(git rev-parse --show-toplevel 2>/dev/null)"',
    `git config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k v; do n=\${k#remote.}; printf "R\\t%s\\t%s\\n" "\${n%.url}" "$v"; done`,
    "exit 0",
  ].join("\n");
}

export function parseHomeRoot(stdout: string): {
  top: string;
  remotes: { name: string; url: string }[];
} {
  let top = "";
  const remotes: { name: string; url: string }[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, a = "", b = ""] = line.split("\t");
    if (kind === "T" && a.startsWith("/")) top = a;
    else if (kind === "R" && a && b) remotes.push({ name: a, url: b });
  }
  return { top, remotes };
}

/**
 * The clone's own checkout, where its worktrees start from. Herdr's
 * worktree actions, and Roamgate's worktree path before them, run
 * work-tree commands there (`git rev-parse --show-toplevel`), which a
 * repository directory refuses: "this operation must be run in a work
 * tree". A checkout is its own, and so is the work tree `core.worktree`
 * gives a repository directory. A repository directory such as
 * gstreamer.git (the first entry of `git worktree list`, with no work tree
 * of its own) has the checkout its `gitdir` file names, or the directory
 * beside it without `.git`, when that checkout's repository is this one.
 * Prints `TOP\t<checkout>`, empty when there is none.
 */
export function homeSourceScript(clone: string): string {
  const beside = clone.replace(/\/+$/, "").replace(/\.git$/, "");
  return [
    `cd ${shQuote(clone)} 2>/dev/null || exit 2`,
    "t=$(git rev-parse --show-toplevel 2>/dev/null)",
    'if [ -z "$t" ]; then',
    '  c=$(cd "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)',
    `  for d in "$(sed -n 's,/\\.git$,,p' gitdir 2>/dev/null)" ${shQuote(beside)}; do`,
    '    [ -n "$d" ] && [ -d "$d" ] || continue',
    '    d=$(cd "$d" 2>/dev/null && pwd -P) || continue',
    '    [ -n "$c" ] && [ "$(cd "$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)" = "$c" ] || continue',
    '    t=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) && [ -n "$t" ] && break',
    "  done",
    "fi",
    'printf "TOP\\t%s\\n" "$t"',
    "exit 0",
  ].join("\n");
}

/** The checkout `homeSourceScript` printed; empty when there is none. */
export function parseHomeSource(stdout: string): string {
  const line = stdout.split("\n").find((each) => each.startsWith("TOP\t"));
  const top = line?.slice(4).trim() ?? "";
  return top.startsWith("/") ? top : "";
}

/**
 * Makes the home's worktree with git, from an existing worktree of the
 * repository (`git worktree add` needs no work tree of the clone), on a new
 * branch at the request's head. Prints `MADE <path>`; the exit code says
 * which step failed (homeWorktreeError).
 */
export function homeWorktreeScript(
  from: string,
  path: string,
  branch: string,
  sha: string,
): string {
  return [
    `cd ${shQuote(from)} 2>/dev/null || exit 2`,
    `mkdir -p "$(dirname ${shQuote(path)})" || exit 3`,
    `git worktree add -q -b ${shQuote(branch)} ${shQuote(path)} ${shQuote(sha)} >&2 || exit 4`,
    `printf "MADE %s\\n" "$(cd ${shQuote(path)} && pwd -P)"`,
  ].join("\n");
}

/** Why homeWorktreeScript failed: the command and directory, with git's words. */
export function homeWorktreeError(
  result: { code: number; stdout: string; stderr: string },
  from: string,
  path: string,
  branch: string,
  sha: string,
): string {
  const said = (result.stderr || result.stdout).trim().slice(-300);
  const command = `git -C ${from} worktree add -b ${branch} ${path} ${sha.slice(0, 12)}`;
  if (result.code === 2) return `cannot enter ${from}`;
  if (result.code === 3) return `cannot create the directory of ${path}`;
  return `${command} failed${said ? `: ${said}` : ""}`;
}

/** Where a home made with git goes: beside the review worktree. */
export function homeWorktreePath(
  reviewWorktree: string,
  branch: string,
): string {
  const name = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  return `${reviewWorktree.replace(/\/+$/, "").replace(/\/[^/]*$/, "")}/${name || "home"}`;
}

/** Control characters out of text from a forge, before it reaches an agent. */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** The first prompt of a request's home agent, from the setting. */
export function homePromptFor(template: string, item: MrItem): string {
  return mrHomePrompt(template, {
    url: item.url,
    ref: forgeRefLabel(item),
    title: plain(item.title).slice(0, 300),
    author: plain(item.author || "unknown").slice(0, 100),
    target: plain(item.targetBranch || "its target branch").slice(0, 200),
    source: plain(item.sourceBranch || "").slice(0, 200),
    project: item.project,
  });
}

export type MrHomeOpen = {
  connectionId: string;
  workspaceId: string;
  sessionId: string;
  snapshot: ReviewSnapshot;
  root: string;
};

export type MrHomeStart = MrHomeOpen & {
  /** Made now, or the request's home made before. */
  created: boolean;
  branch?: string;
  agent: {
    state: "prompted" | "starting" | "foreign" | "none";
    paneId: string | null;
    session?: string;
  };
};

type PaneAgent = { name: string | null; status: string };

export function createMrHomes(deps: {
  item: (key: string) => MrItem;
  store: MrStore;
  connections: () => MrConnection[];
  settings: () => Promise<{ homePrompt: string }>;
  /** The project's clone, review worktree and workspace (made when missing). */
  project: (
    item: MrItem,
  ) => Promise<{ conn: MrConnection; record: MrProjectRecord } | null>;
  /** A worktree workspace through the user's worktree path (or Herdr's). */
  createWorktree?: (input: {
    connectionId: string;
    workspaceId: string;
    branch: string;
  }) => Promise<{ path: string; workspaceId?: string }>;
  /** Puts a new workspace where the project's reviews go in the tree. */
  placeWorkspace?: (params: {
    projectKey: string;
    connectionId: string;
    workspaceId: string;
    label: string;
    worktree: string;
    clone: string;
  }) => Promise<void>;
  openReview: (params: {
    connectionId: string;
    workspaceId: string;
    root: string;
    url: string;
    title: string;
    paneId?: string;
  }) => ReviewSnapshot;
  markSeen: (key: string) => void;
  /** The claude start setting (claude_start_mode). */
  startMode?: () => Promise<"terminal" | "conversation">;
  /** The new session's profile command (tests; else the default profile). */
  agentCommand?: (session: string) => AgentCommand;
  sleep?: (ms: number) => Promise<void>;
  /** How long the background delivery keeps trying. */
  deliverMs?: number;
  pollMs?: number;
  logger?: Logger;
}) {
  const logger = deps.logger ?? serverLogger.child("mr-reviews");
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deliverMs = deps.deliverMs ?? 10 * 60_000;
  const pollMs = deps.pollMs ?? 1_000;
  /** One start at a time per request. */
  const starting = new Map<string, Promise<MrHomeStart>>();

  function connection(id: string): MrConnection {
    const found = deps.connections().find((each) => each.id === id);
    if (!found)
      throw new MrReviewsError(
        `the connection ${id} is not ready`,
        "unavailable",
      );
    return found;
  }

  /** The folder a workspace works in: its checkout, else its first pane's. */
  async function folderOf(
    conn: MrConnection,
    workspaceId: string,
  ): Promise<string | null> {
    const listed = await conn.herdr("workspace.list", {});
    const workspace = (
      Array.isArray(listed?.workspaces) ? listed.workspaces : []
    ).find((each: any) => each?.workspace_id === workspaceId);
    if (!workspace) return null;
    const own = workspace.worktree?.checkout_path || workspace.cwd;
    if (typeof own === "string" && own.startsWith("/")) return own;
    const panes = await conn.herdr("pane.list", {}).catch(() => null);
    const pane = (Array.isArray(panes?.panes) ? panes.panes : []).find(
      (each: any) => each?.workspace_id === workspaceId,
    );
    const dir = pane?.foreground_cwd || pane?.cwd;
    return typeof dir === "string" && dir.startsWith("/") ? dir : null;
  }

  /**
   * Opens the request's review in one of its workspaces: its head fetched
   * into that checkout first (read only), from the remote that is the
   * project when it has one.
   */
  async function openIn(
    key: string,
    where: { connectionId: string; workspaceId: string },
    paneId?: string,
  ): Promise<MrHomeOpen> {
    const item = deps.item(key);
    const conn = connection(where.connectionId);
    const folder = await folderOf(conn, where.workspaceId);
    if (!folder)
      throw new MrReviewsError(
        "that workspace is not open any more",
        "not_found",
      );
    const read = parseHomeRoot(
      (await conn.run(homeRootScript(folder), 30_000)).stdout,
    );
    if (!read.top)
      throw new MrReviewsError(`${folder} is not a Git checkout`, "invalid");
    const remote = read.remotes.find((each) => remoteIsProject(each.url, item));
    if (item.headSha) {
      const fetched = await conn
        .run(
          fetchScript(
            read.top,
            remote?.name ?? projectUrl(item.host, item.project),
            item.provider,
            [
              {
                number: item.number,
                headSha: item.headSha,
                ...(item.baseSha
                  ? { baseSha: item.baseSha, targetBranch: item.targetBranch }
                  : {}),
              },
            ],
          ),
          180_000,
        )
        .catch(() => null);
      if (fetched && parseFetch(fetched.stdout).missing.includes(item.number))
        logger.info("request head not fetched in its home", { mr: key });
    }
    const snapshot = deps.openReview({
      connectionId: conn.id,
      workspaceId: where.workspaceId,
      root: read.top,
      url: item.url,
      title: `${forgeRefLabel(item)} ${item.title}`.slice(0, 300),
      ...(paneId ? { paneId } : {}),
    });
    deps.store.update((state) => {
      const home = state.homes?.[key];
      if (
        home &&
        home.connectionId === conn.id &&
        home.workspaceId === where.workspaceId
      )
        home.sessionId = snapshot.session.id;
    });
    deps.markSeen(key);
    return {
      connectionId: conn.id,
      workspaceId: where.workspaceId,
      sessionId: snapshot.session.id,
      snapshot,
      root: read.top,
    };
  }

  async function agentOf(
    conn: MrConnection,
    paneId: string,
  ): Promise<PaneAgent> {
    const answer = await conn
      .herdr("agent.get", { target: paneId })
      .catch(() => null);
    const agent = answer?.agent ?? null;
    const name = typeof agent?.agent === "string" ? agent.agent : null;
    return {
      name: name && /claude/i.test(name) ? "claude" : name,
      status: String(agent?.agent_status ?? agent?.status ?? "unknown"),
    };
  }

  /** Sends the prompt once the session waits for one; false: not yet. */
  async function deliver(
    conn: MrConnection,
    paneId: string,
    session: string,
    text: string,
  ): Promise<boolean> {
    if (conn.conversation?.owned(paneId) === session) {
      if (
        conn.conversation.prompt &&
        (await conn.conversation.prompt(paneId, text))
      )
        return true;
    }
    const agent = await agentOf(conn, paneId);
    if (
      agent.name !== "claude" ||
      (agent.status !== "idle" && agent.status !== "done")
    )
      return false;
    await conn.herdr("agent.prompt", { target: paneId, text });
    return true;
  }

  /** The home's first pane: where its Claude runs. */
  async function firstPane(
    conn: MrConnection,
    workspaceId: string,
  ): Promise<string | null> {
    const listed = await conn.herdr("pane.list", {});
    const pane = (Array.isArray(listed?.panes) ? listed.panes : []).find(
      (each: any) => each?.workspace_id === workspaceId,
    );
    return typeof pane?.pane_id === "string" ? pane.pane_id : null;
  }

  /** Each request's prompt delivery under way (tests wait for it). */
  const deliveries = new Map<string, Promise<boolean>>();

  /**
   * Starts Claude in the home's pane, then gives it its job once it waits
   * for a prompt (a trust question first is fine: it is told after),
   * in the background.
   */
  async function startAgent(
    conn: MrConnection,
    key: string,
    paneId: string | null,
    text: string,
  ): Promise<MrHomeStart["agent"]> {
    if (!paneId) return { state: "none", paneId: null };
    const running = await agentOf(conn, paneId);
    if (running.name) return { state: "foreign", paneId };
    const session = randomUUID();
    deps.store.update((state) => {
      const home = state.homes?.[key];
      if (home) home.claudeSession = session;
    });
    const mode = (await deps.startMode?.()) ?? "terminal";
    const command = deps.agentCommand;
    // A new session: the default profile, as the review workspace's Claude.
    await conn.herdr("pane.send_text", {
      pane_id: paneId,
      text:
        profileLaunch(
          conn,
          paneId,
          session,
          false,
          mode,
          command ? () => command(session) : undefined,
        ) ?? claudeCommand(session, false, mode),
    });
    const delivery = (async () => {
      for (let waited = 0; waited < deliverMs; waited += pollMs) {
        await sleep(pollMs);
        if (await deliver(conn, paneId, session, text).catch(() => false)) {
          logger.info("home agent prompted", { mr: key });
          return true;
        }
      }
      logger.info("home agent never got its prompt", { mr: key });
      return false;
    })();
    deliveries.set(key, delivery);
    return { state: "starting", paneId, session };
  }

  /**
   * The workspace of the clone's own checkout: a new worktree starts from
   * the repository's parent workspace (Herdr refuses a linked worktree's,
   * such as the review workspace). Opened on the checkout when none is.
   */
  async function cloneWorkspace(
    conn: MrConnection,
    checkout: string,
    item: MrItem,
  ): Promise<string> {
    const trim = (path: unknown) =>
      typeof path === "string" ? path.replace(/\/+$/, "") : "";
    const listed = await conn.herdr("workspace.list", {});
    const found = (
      Array.isArray(listed?.workspaces) ? listed.workspaces : []
    ).find(
      (each: any) =>
        trim(each?.worktree?.checkout_path) === trim(checkout) ||
        (!each?.worktree?.checkout_path && trim(each?.cwd) === trim(checkout)),
    );
    if (typeof found?.workspace_id === "string") return found.workspace_id;
    // Herdr's list may give no folder: a pane working in the clone says it.
    const panes = await conn.herdr("pane.list", {}).catch(() => null);
    const pane = (Array.isArray(panes?.panes) ? panes.panes : []).find(
      (each: any) =>
        typeof each?.workspace_id === "string" &&
        (trim(each?.cwd) === trim(checkout) ||
          trim(each?.foreground_cwd) === trim(checkout)),
    );
    if (pane) return pane.workspace_id as string;
    const created = await conn.herdr("workspace.create", {
      cwd: checkout,
      label: item.project.split("/").pop() ?? item.project,
      focus: false,
    });
    const id = created?.workspace?.workspace_id;
    if (typeof id !== "string" || !id)
      throw new MrReviewsError(
        "Herdr did not open the project's clone",
        "herdr",
      );
    return id;
  }

  /**
   * The home's worktree made with git when the clone is a repository
   * directory with no checkout of its own: Herdr starts no worktree there
   * (not a work tree), nor from its linked worktrees, so git makes it from
   * the project's review worktree, beside it, and Herdr opens it as a
   * workspace. The user's worktree path is not run.
   */
  async function gitWorktree(
    conn: MrConnection,
    record: MrProjectRecord,
    branch: string,
    sha: string,
    key: string,
  ): Promise<{ path: string; workspaceId: string }> {
    const path = homeWorktreePath(record.worktree, branch);
    const made = await conn.run(
      homeWorktreeScript(record.worktree, path, branch, sha),
      120_000,
    );
    const at = /^MADE (\/.*)$/m.exec(made.stdout)?.[1]?.trim();
    if (made.code !== 0 || !at)
      throw new MrReviewsError(
        `cannot make the home's worktree on ${conn.label}: ${homeWorktreeError(made, record.worktree, path, branch, sha)}`,
        "worktree",
      );
    logger.info("home worktree made with git: the clone has no checkout", {
      mr: key,
      clone: record.clone,
      path: at,
    });
    const created = await conn.herdr("workspace.create", {
      cwd: at,
      label: branch,
      focus: false,
    });
    const id = created?.workspace?.workspace_id;
    if (typeof id !== "string" || !id)
      throw new MrReviewsError(
        `Herdr did not open the home's worktree ${at}`,
        "herdr",
      );
    return { path: at, workspaceId: id };
  }

  /** Whether a recorded home's workspace is still there. */
  async function liveHome(home: MrHomeRecord): Promise<boolean> {
    const conn = deps
      .connections()
      .find((each) => each.id === home.connectionId);
    if (!conn) return false;
    const listed = await conn.herdr("workspace.list", {}).catch(() => null);
    return (Array.isArray(listed?.workspaces) ? listed.workspaces : []).some(
      (each: any) => each?.workspace_id === home.workspaceId,
    );
  }

  async function start(key: string): Promise<MrHomeStart> {
    const item = deps.item(key);
    const known = deps.store.get().homes?.[key];
    if (known && (await liveHome(known))) {
      const opened = await openIn(key, known);
      return {
        ...opened,
        created: false,
        ...(known.branch ? { branch: known.branch } : {}),
        agent: {
          state: known.claudeSession ? "starting" : "none",
          paneId: null,
          ...(known.claudeSession ? { session: known.claudeSession } : {}),
        },
      };
    }
    if (!item.headSha)
      throw new MrReviewsError(
        "the forge gave no head for this request",
        "invalid",
      );
    if (!deps.createWorktree)
      throw new MrReviewsError("worktrees cannot be made here", "unavailable");
    const project = await deps.project(item);
    if (!project)
      throw new MrReviewsError(
        `no clone of ${item.project} is known: open its review once to pick one`,
        "not_found",
      );
    const { conn, record } = project;
    if (!record.workspaceId)
      throw new MrReviewsError(
        "the project's review workspace is missing",
        "invalid",
      );
    // Its head in the clone (shared with every linked worktree).
    const remote = record.remote || projectUrl(item.host, item.project);
    await conn.run(
      fetchScript(record.clone, remote, item.provider, [
        { number: item.number, headSha: item.headSha },
      ]),
      180_000,
    );
    const named = /NAME (\S+)/.exec(
      (
        await conn.run(
          homeBranchScript(record.clone, homeBranchName(item), item.number),
          30_000,
        )
      ).stdout,
    )?.[1];
    if (!named)
      throw new MrReviewsError("cannot name the home's branch", "worktree");
    // Where the worktree starts from: the clone's own checkout, never the
    // repository directory itself (no work tree: Herdr and the worktree
    // path fail there with "this operation must be run in a work tree").
    const source = parseHomeSource(
      (await conn.run(homeSourceScript(record.clone), 30_000)).stdout,
    );
    const made = source
      ? await deps
          .createWorktree({
            connectionId: conn.id,
            workspaceId: await cloneWorkspace(conn, source, item),
            branch: named,
          })
          .catch((error) => {
            throw new MrReviewsError(
              `cannot make the home's worktree from ${source} on ${conn.label}: ${error instanceof Error ? error.message : String(error)}`,
              "worktree",
            );
          })
      : await gitWorktree(conn, record, named, item.headSha, key);
    const workspaceId = made.workspaceId;
    if (!workspaceId)
      throw new MrReviewsError(
        "the worktree was made without a workspace",
        "herdr",
      );
    const moved = await conn.run(
      homeCheckoutScript(made.path, item.headSha),
      60_000,
    );
    if (!/^AT /m.test(moved.stdout))
      logger.info("home not moved to the request's head", {
        mr: key,
        error: (moved.stderr || moved.stdout).trim().slice(-200),
      });
    const label = homeLabel(item);
    await conn
      .herdr("workspace.rename", { workspace_id: workspaceId, label })
      .catch((error) =>
        logger.info("home not renamed", { mr: key, error: String(error) }),
      );
    const home: MrHomeRecord = {
      connectionId: conn.id,
      workspaceId,
      path: made.path,
      branch: named,
      at: new Date().toISOString(),
    };
    deps.store.update((state) => {
      state.homes = { ...state.homes, [key]: home };
    });
    if (deps.placeWorkspace)
      await deps
        .placeWorkspace({
          projectKey: mrProjectKey(item),
          connectionId: conn.id,
          workspaceId,
          label,
          worktree: made.path,
          clone: record.clone,
        })
        .catch((error) =>
          logger.info("home not placed", { mr: key, error: String(error) }),
        );
    // Its review first, bound to the pane its Claude runs in: the prompt
    // tells the agent to work in it.
    const paneId = await firstPane(conn, workspaceId).catch(() => null);
    const opened = await openIn(
      key,
      { connectionId: conn.id, workspaceId },
      paneId ?? undefined,
    );
    const text = homePromptFor((await deps.settings()).homePrompt, item);
    const agent = await startAgent(conn, key, paneId, text).catch(
      (error): MrHomeStart["agent"] => {
        logger.info("home agent not started", {
          mr: key,
          error: String(error),
        });
        return { state: "none", paneId };
      },
    );
    logger.info("review home made", { mr: key, branch: named });
    return { ...opened, created: true, branch: named, agent };
  }

  return {
    openIn,
    /** The prompt delivery of a request's home agent, while it runs. */
    delivered: (key: string) => deliveries.get(key) ?? Promise.resolve(false),
    start(key: string): Promise<MrHomeStart> {
      const running = starting.get(key);
      if (running) return running;
      const next = start(key).finally(() => starting.delete(key));
      starting.set(key, next);
      return next;
    },
  };
}

export type MrHomes = ReturnType<typeof createMrHomes>;
