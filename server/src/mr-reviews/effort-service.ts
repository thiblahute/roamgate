import type { ReviewSnapshot } from "../../../shared/review";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { forgeRefLabel } from "../../../shared/forge";
import {
  type MrEffort,
  type MrEffortSummary,
  type MrInboxEntry,
  type MrItem,
  type MrOverlap,
  type MrReviewsPush,
  type MrPlan,
  type MrReviewsSettings,
  fixupTargets,
  upstreamWorkspaceHome,
} from "../../../shared/mrReviews";
import { onGitlabHost, remoteProject } from "../review/gitlab";
import { claudeCommand } from "./claude";
import { type MrConnection, shQuote } from "./clones";
import {
  changePlans,
  changesOf,
  createLedgerStore,
  decideMatches,
  type DerivedCommit,
  type DerivedFile,
  deriveEffort,
  effortSummary,
  findPlan,
  isAuthoredDisposition,
  type LedgerStore,
  overlapOf,
  type PlanAction,
  setDispositions,
  snapshotOf,
  TARGET_CHECK_MS,
  undoLedger,
  upstreamRef,
} from "./efforts";
import { effortPlanEntries } from "./effort-board";
import { homeSourceScript, parseHomeSource } from "./home";
import { MrReviewsError } from "./rpc";
import {
  parseRequestPatchIds,
  requestPatchIdsScript,
  type UpstreamScanner,
} from "./upstream";

/**
 * The efforts of the user's Reviews: their ledgers derived when a head
 * moved (at most every minute, the target asked of its remote at most
 * every TARGET_CHECK_MS), their cards for the inbox, and their RPCs.
 */

const EFFORT_REFRESH_MS = 60_000;

export function createEffortService(options: {
  root: string;
  settings: () => Promise<MrReviewsSettings>;
  connections: () => MrConnection[];
  items: () => MrItem[];
  upstream: UpstreamScanner;
  publish?: (push: MrReviewsPush) => void;
  /** The inbox version and order, for a push that only says "effort". */
  current: () => Promise<{ version: number; order: string[] }>;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const store: LedgerStore = createLedgerStore(options.root);
  const lastRun = new Map<string, number>();
  const lastTarget = new Map<string, number>();
  const running = new Map<string, Promise<DerivedFile | null>>();
  /** Request patch ids read in a clone: `clone\0key` -> head, ids. */
  const requestIds = new Map<string, { head: string; ids: Set<string> }>();

  const connectionOf = (id: string) =>
    options.connections().find((each) => each.id === id);

  async function requestsFor(
    effort: MrEffort,
    connection: MrConnection,
    url: string,
  ) {
    const remote = remoteProject(url);
    const hosts = (await options.settings()).hosts;
    const host = remote
      ? hosts.find((each) =>
          each.provider === "gitlab"
            ? onGitlabHost(remote.host, each.host)
            : remote.host === each.host,
        )
      : undefined;
    if (!remote || !host) return [];
    const own = options
      .items()
      .filter(
        (item) =>
          item.reasons.includes("authored") &&
          item.state === "open" &&
          item.provider === host.provider &&
          item.host.toLowerCase() === host.host.toLowerCase() &&
          item.project.toLowerCase() === remote.project.toLowerCase() &&
          !!item.headSha,
      )
      .slice(0, 60);
    const stale = own.filter(
      (item) =>
        requestIds.get(`${effort.clone.path}\0${item.key}`)?.head !==
        item.headSha,
    );
    if (stale.length) {
      const read = parseRequestPatchIds(
        (
          await connection.run(
            requestPatchIdsScript(
              effort.clone.path,
              effort.target.remote,
              upstreamRef(effort),
              stale.map((item) => ({
                key: item.key,
                provider: item.provider,
                number: item.number,
                head: item.headSha,
              })),
            ),
            300_000,
          )
        ).stdout,
      );
      for (const item of stale)
        requestIds.set(`${effort.clone.path}\0${item.key}`, {
          head: item.headSha,
          ids: read.get(item.key) ?? new Set(),
        });
    }
    return own.map((item) => ({
      key: item.key,
      label: forgeRefLabel(item),
      ids:
        requestIds.get(`${effort.clone.path}\0${item.key}`)?.ids ?? new Set(),
    }));
  }

  /** Derives one effort when due (or now, forced). */
  function refreshOne(
    effort: MrEffort,
    force = false,
  ): Promise<DerivedFile | null> {
    const busy = running.get(effort.id);
    if (busy) return busy;
    if (!force && now() - (lastRun.get(effort.id) ?? 0) < EFFORT_REFRESH_MS)
      return Promise.resolve(store.derived(effort.id));
    const connection = connectionOf(effort.clone.connectionId);
    if (!connection) return Promise.resolve(store.derived(effort.id));
    lastRun.set(effort.id, now());
    const checkTarget =
      force || now() - (lastTarget.get(effort.id) ?? 0) >= TARGET_CHECK_MS;
    if (checkTarget) lastTarget.set(effort.id, now());
    const run = deriveEffort({
      effort,
      connection,
      store,
      checkTarget,
      requests: (url) => requestsFor(effort, connection, url),
      parts: partsOf(effort),
      elsewhere: takenElsewhere(effort.id),
      now,
      force,
    })
      .then(({ derived, ran }) => {
        if (!ran && derived.error) store.writeDerived(effort.id, derived);
        if (ran) push(effort.id, { by: "user" });
        return derived;
      })
      .catch(() => store.derived(effort.id))
      .finally(() => running.delete(effort.id));
    running.set(effort.id, run);
    return run;
  }

  /**
   * Commits in another effort's planned requests or parts, by patch id:
   * that effort's name (D4: in one plan or part across efforts).
   */
  function takenElsewhere(effortId: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const other of known) {
      if (other.id === effortId) continue;
      const plans = store.ledger(other.id).plans;
      if (!plans.length) continue;
      const patchOf = new Map(
        (store.derived(other.id)?.commits ?? []).map((commit) => [
          commit.key,
          commit.patchId,
        ]),
      );
      for (const plan of plans)
        for (const key of plan.commits) {
          const id = patchOf.get(key) ?? key;
          if (!out.has(id)) out.set(id, other.name);
        }
    }
    return out;
  }
  /** The efforts declared, as last read (for takenElsewhere). */
  let known: MrEffort[] = [];

  /** The patch ids of each part: branches of the effort's group. */
  function partsOf(effort: MrEffort) {
    // A part made for a plan holds its commits even where their patch ids
    // changed: fixups folded, or made from a branch holding them already
    // (both checked tree to tree when it was made).
    const plans = store.ledger(effort.id).plans;
    const patchIds = new Map(
      (store.derived(effort.id)?.commits ?? []).map((commit) => [
        commit.key,
        commit.patchId,
      ]),
    );
    return options.upstream
      .branches()
      .filter(
        (branch) =>
          branch.member.group === effort.group &&
          branch.member.path !== effort.clone.path &&
          branch.member.path !== effort.head?.path,
      )
      .map((branch) => ({
        label: branch.branch,
        ids: new Set([
          ...branch.commits.flatMap((commit) =>
            commit.patchId ? [commit.patchId] : [],
          ),
          ...plans
            .filter(
              (plan) =>
                plan.part?.path === branch.member.path && !plan.part.conflict,
            )
            .flatMap((plan) =>
              plan.commits.flatMap((key) => {
                const id = patchIds.get(key);
                return id ? [id] : [];
              }),
            ),
        ]),
      }));
  }

  async function push(
    effortId: string,
    meta: { by: "user" | "agent"; summary?: string; journal?: number },
  ) {
    if (!options.publish) return;
    const { version, order } = await options.current();
    options.publish({
      version,
      order,
      changed: ["effort"],
      by: meta.by,
      ...(meta.summary ? { summary: meta.summary } : {}),
      effort: {
        id: effortId,
        ...(meta.journal !== undefined ? { journal: meta.journal } : {}),
      },
    });
  }

  /** Overlaps of each effort with the others and with branches (D23). */
  function overlaps(efforts: MrEffort[]): Map<string, MrOverlap[]> {
    const sets = new Map<string, Set<string>>();
    for (const effort of efforts)
      sets.set(
        effort.id,
        new Set(
          (store.derived(effort.id)?.commits ?? []).map(
            (commit) => commit.patchId,
          ),
        ),
      );
    const out = new Map<string, MrOverlap[]>();
    for (const effort of efforts) {
      const mine = sets.get(effort.id)!;
      const list: MrOverlap[] = [];
      if (mine.size) {
        for (const other of efforts) {
          if (other.id === effort.id) continue;
          const found = overlapOf(mine, sets.get(other.id)!, {
            with: other.name,
            kind: "effort",
          });
          if (found) list.push(found);
        }
        for (const branch of options.upstream.branches()) {
          if (branch.member.path === effort.clone.path) continue;
          const ids = new Set(
            branch.commits.flatMap((commit) =>
              commit.patchId ? [commit.patchId] : [],
            ),
          );
          if (!ids.size) continue;
          const found = overlapOf(mine, ids, {
            with: branch.branch,
            kind: "branch",
          });
          if (found && found.relation !== "contains") list.push(found);
        }
      }
      out.set(effort.id, list);
    }
    return out;
  }

  /** Resolves a ref name to one exact ref of the clone, else says why. */
  async function exactRef(
    connection: MrConnection,
    clone: string,
    name: string,
  ): Promise<string> {
    const short = name.replace(/^refs\/(heads|remotes)\//, "");
    const script = `git -C ${shQuote(clone)} for-each-ref --format='%(refname)' ${shQuote(`refs/heads/${short}`)} ${shQuote(`refs/remotes/${short}`)} ${shQuote(`refs/remotes/*/${short}`)}`;
    const found = [
      ...new Set(
        (await connection.run(script, 30_000)).stdout
          .split("\n")
          .filter((line) => line.startsWith("refs/")),
      ),
    ];
    if (name.startsWith("refs/") && found.includes(name)) return name;
    if (found.length === 1) return found[0]!;
    // A local branch first, as git reads a short name.
    if (
      !name.startsWith("refs/remotes/") &&
      found.includes(`refs/heads/${short}`)
    )
      return `refs/heads/${short}`;
    throw new MrReviewsError(
      found.length
        ? `"${name}" is ambiguous in ${clone}: ${found.join(", ")}`
        : `No ref "${name}" in ${clone}`,
    );
  }

  return {
    store,
    refreshOne,
    /** Derives every due effort (after an inbox refresh, on a viewer). */
    async refresh(force = false) {
      known = (await options.settings()).efforts;
      for (const effort of known) await refreshOne(effort, force);
    },
    takenElsewhere,
    /** The cards, from what is on disk (no git). */
    summaries(settings: MrReviewsSettings): MrEffortSummary[] {
      known = settings.efforts;
      const found = overlaps(settings.efforts);
      return settings.efforts.map((effort) =>
        effortSummary(
          effort,
          store.derived(effort.id),
          found.get(effort.id) ?? [],
          effort.head
            ? {
                connectionId: effort.head.connectionId,
                ...(effort.head.workspaceId
                  ? { workspaceId: effort.head.workspaceId }
                  : {}),
              }
            : undefined,
          { ledger: store.ledger(effort.id), seen: store.seen(effort.id) },
        ),
      );
    },
    exactRef,
    connectionOf,
    push,
    /** Derives a candidate effort in a scratch place: what it would hold. */
    async preview(effort: MrEffort, others: MrEffort[]) {
      const connection = connectionOf(effort.clone.connectionId);
      if (!connection)
        throw new MrReviewsError("that connection is not ready", "unavailable");
      const root = join(options.root, `.preview-${now()}`);
      const scratch = createLedgerStore(root);
      try {
        const { derived } = await deriveEffort({
          effort,
          connection,
          store: scratch,
          checkTarget: true,
          requests: (url) => requestsFor(effort, connection, url),
          now,
          force: true,
        });
        const mine = new Set(derived.commits.map((commit) => commit.patchId));
        const list: MrOverlap[] = [];
        for (const other of others) {
          const theirs = new Set(
            (store.derived(other.id)?.commits ?? []).map((c) => c.patchId),
          );
          const found = overlapOf(mine, theirs, {
            with: other.name,
            kind: "effort",
          });
          if (found) list.push(found);
        }
        return effortSummary(effort, derived, list);
      } finally {
        // Its writes are behind: done first, or they would make it again.
        await scratch.flush();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export type EffortService = ReturnType<typeof createEffortService>;

/** An effort named by id or name (case-insensitive). */
export function findEffort(efforts: MrEffort[], name: string): MrEffort | null {
  const lower = name.trim().toLowerCase();
  return (
    efforts.find((each) => each.id === name) ??
    efforts.find((each) => each.name.toLowerCase() === lower) ??
    null
  );
}

/**
 * `bridge.mr_reviews.effort.*` and `ledger.*`: declare, update, delete,
 * read, refresh and preview efforts; set and undo dispositions. Nothing
 * here touches a forge beyond git fetches of the target (D13).
 */
export async function handleEffortRpc(
  deps: {
    service: EffortService;
    settings: () => Promise<MrReviewsSettings>;
    edit: <T>(change: () => Promise<T>) => Promise<T>;
    save: (
      settings: MrReviewsSettings,
      meta: { by: "user" | "agent"; summary?: string; undoable?: boolean },
    ) => Promise<MrReviewsSettings>;
    upstream: UpstreamScanner;
    /** The inbox's entries as computed (no forge call): the Board's cards. */
    entries?: () => Promise<MrInboxEntry[]>;
    groupLabel: (group: string) => Promise<string | null>;
    /**
     * Makes a worktree workspace through the user's worktree path (the
     * `worktree_command` setting, else Herdr's), from the repository's
     * parent workspace, or from its main checkout's path (`cwd`) when no
     * workspace is open there.
     */
    createWorktree?: (
      input: { connectionId: string; branch: string } & (
        | { workspaceId: string; cwd?: never }
        | { cwd: string; workspaceId?: never }
      ),
    ) => Promise<{ path: string; workspaceId?: string }>;
    /**
     * Puts a workspace in the Workspaces tree: under the workspace `under`
     * (nested in its node, as Move into... does) when given, else into the
     * group `group`.
     */
    place?: (input: {
      connectionId: string;
      path: string;
      workspaceId?: string;
      group: string;
      under?: { connectionId: string; path: string; workspaceId?: string };
    }) => Promise<void>;
    /** Opens a Roamgate review of a range in a workspace's Changes. */
    openRange?: (input: {
      connectionId: string;
      workspaceId: string;
      root: string;
      base: string;
      head: string;
      title: string;
      compare?: boolean;
    }) =>
      | { sessionId: string; snapshot?: ReviewSnapshot }
      | Promise<{ sessionId: string; snapshot?: ReviewSnapshot }>;
    /**
     * The effort's review: the threads on its view, for its leader. Found
     * by the effort wherever it was opened; made in the head's checkout
     * when `open` (the first comment), else null.
     */
    effortReview?: (input: {
      effort: string;
      connectionId: string;
      workspaceId?: string;
      root: string;
      title: string;
      open: boolean;
    }) => ReviewSnapshot | null | Promise<ReviewSnapshot | null>;
  },
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { service } = deps;
  const meta =
    params.by === "agent"
      ? {
          by: "agent" as const,
          undoable: true,
          ...(typeof params.summary === "string"
            ? { summary: params.summary.slice(0, 200) }
            : {}),
        }
      : { by: "user" as const };
  /**
   * The Herdr workspace at a checkout: a workspace headed upstream there,
   * else any open workspace of the connection there (its cwd or its
   * worktree), else the id last known.
   */
  const workspaceAt = async (
    connectionId: string,
    paths: (string | undefined)[],
    known?: string,
  ): Promise<string | undefined> => {
    const wanted = paths.filter((path): path is string => !!path);
    for (const path of wanted) {
      const member = deps.upstream
        .members()
        .find(
          (each) =>
            each.connectionId === connectionId &&
            each.path === path &&
            !!each.workspaceId,
        );
      if (member) return member.workspaceId;
    }
    const listed = await service
      .connectionOf(connectionId)
      ?.herdr("workspace.list", {})
      .catch(() => null);
    const workspaces: any[] = Array.isArray(listed?.workspaces)
      ? listed.workspaces
      : [];
    for (const path of wanted) {
      const found = workspaces.find(
        (each) => each?.worktree?.checkout_path === path || each?.cwd === path,
      );
      if (typeof found?.workspace_id === "string") return found.workspace_id;
    }
    return known;
  };
  /**
   * Where a part's worktree starts: Herdr refuses a linked worktree as the
   * source, so, as the workspace menu's New worktree does, the repository's
   * parent workspace (its main checkout, found through the clone's
   * repository even when that is a separate directory such as
   * gstreamer.git), never the head's linked one. With none open, the main
   * checkout's path, which Herdr and the worktree command take as well.
   */
  const partSource = async (
    effort: MrEffort,
    connection: MrConnection,
  ): Promise<{ workspaceId: string } | { cwd: string }> => {
    const connectionId = effort.clone.connectionId;
    const head =
      effort.head?.connectionId === connectionId ? effort.head : undefined;
    const main = await mainCheckout(connection, effort.clone.path);
    if (main?.checkout) {
      const at = await workspaceAt(connectionId, [main.checkout]);
      if (at) return { workspaceId: at };
    }
    const listed = await connection
      .herdr("workspace.list", {})
      .catch(() => null);
    const workspaces: any[] = Array.isArray(listed?.workspaces)
      ? listed.workspaces
      : [];
    const known = await workspaceAt(
      connectionId,
      [head?.path, effort.clone.path],
      head?.workspaceId,
    );
    const workspace = workspaces.find((each) => each?.workspace_id === known);
    const parent = workspace && repoParentWorkspace(workspaces, workspace);
    if (parent) return { workspaceId: parent };
    if (main?.checkout) return { cwd: main.checkout };
    if (known && workspace?.worktree?.is_linked_worktree !== true)
      return { workspaceId: known };
    // A repository with no checkout of its own is said by its path: the
    // generic words would send the user looking for a main checkout there
    // is none of.
    throw new MrReviewsError(
      main
        ? `the repository ${main.repository} has no checkout of its own (no gitdir file naming one, no core.worktree, nothing beside it without .git): worktrees start from a checkout, so check it out, or open a workspace on a checkout of it first`
        : "open a workspace on the main checkout of the effort's clone first: worktrees start from there",
      "not_found",
    );
  };
  /**
   * A part's stop as its worktree has it now, not as the pick left it:
   * a pick resolved and committed there is no stop any more, another one
   * is the new stop. Read when the view asks; kept without a journal entry
   * (the worktree's state, not a decision).
   */
  const livePartStops = async (effort: MrEffort, commits: DerivedCommit[]) => {
    const ledger = service.store.ledger(effort.id);
    const stopped = ledger.plans.filter((plan) => plan.part?.conflict);
    const connection = stopped.length
      ? service.connectionOf(effort.clone.connectionId)
      : null;
    if (!connection) return ledger;
    const out = await connection
      .run(partStopsScript(stopped.map((plan) => plan.part!.path)), 30_000)
      .catch(() => null);
    if (!out) return ledger;
    const now = parsePartStops(out.stdout);
    const changed = stopped.filter((plan) => {
      const live = now.get(plan.part!.path);
      const was = plan.part!.conflict!;
      return (
        live !== undefined &&
        (live === null ||
          live.sha !== was.sha ||
          Boolean(live.folding) !== Boolean(was.folding) ||
          live.files.join("\n") !== was.files.join("\n"))
      );
    });
    if (!changed.length) return ledger;
    return service.store.queue(effort.id, () => {
      const latest = service.store.ledger(effort.id);
      for (const plan of latest.plans) {
        const live = plan.part?.conflict ? now.get(plan.part.path) : undefined;
        if (live === undefined || !plan.part) continue;
        if (live === null) delete plan.part.conflict;
        else
          plan.part.conflict = {
            sha: live.sha,
            subject:
              live.subject ??
              (live.sha === plan.part.conflict!.sha
                ? plan.part.conflict!.subject
                : (commits.find((commit) => commit.sha === live.sha)?.subject ??
                  "")),
            files: live.files,
            ...(live.folding ? { folding: true } : {}),
          };
      }
      service.store.writeLedger(effort.id, latest);
      return latest;
    });
  };
  /**
   * A part's new worktree in the Workspaces tree: under the effort's head
   * workspace when it has one, else in its group (and there too when the
   * head cannot take it).
   */
  const placePart = async (
    effort: MrEffort,
    made: { path: string; workspaceId?: string },
  ) => {
    const placed = {
      connectionId: effort.clone.connectionId,
      path: made.path,
      ...(made.workspaceId ? { workspaceId: made.workspaceId } : {}),
      group: effort.group,
    };
    const underHead = effort.head
      ? await deps
          .place?.({
            ...placed,
            under: {
              connectionId: effort.head.connectionId,
              path: effort.head.path,
              ...(effort.head.workspaceId
                ? { workspaceId: effort.head.workspaceId }
                : {}),
            },
          })
          .then(() => true)
          .catch(() => false)
      : false;
    if (!underHead) await deps.place?.(placed).catch(() => {});
  };
  /**
   * Refresh part: an existing part's record read again from its branch as
   * it is now (moved by hand onto a port or a squashed commit, say).
   * Nothing is made, picked or moved: the worktree at its path and the
   * branch it is on are only read, and only the record is rewritten,
   * journaled for Undo. Its base: the part it stacks on when its branch
   * holds that part's tip, else the target; from: the branch given, else
   * an upstream/* branch at its commit; ported when it does not hold the
   * plan's changes as they are but is a port of them on its base; its
   * fixups left as commits read from its branch; its stop read from its
   * worktree. A worktree or branch gone is refused, unless from names an
   * existing local branch to attach the part to: its worktree when it has
   * one, else a new worktree at a free path on it (the branch not moved).
   */
  const refreshPart = async (input: {
    effort: MrEffort;
    plan: MrPlan;
    picked: DerivedCommit[];
    on: MrPlan | undefined;
    stacked: MrPlan[];
    upstream: string;
    upstreamOf: (plan: MrPlan) => string;
  }) => {
    const { effort, plan, picked, on, stacked } = input;
    const was = plan.part!;
    const connection = service.connectionOf(effort.clone.connectionId);
    if (!connection)
      throw new MrReviewsError("that connection is not ready", "unavailable");
    const clone = effort.clone.path;
    const named = typeof params.from === "string" ? params.from.trim() : "";
    if (
      named &&
      !(/^[A-Za-z0-9][\w./-]*$/.test(named) && !named.includes(".."))
    )
      throw new MrReviewsError(`"${named}" is not a branch name`);
    const branchAt = async (name: string) =>
      parseBranchWorktrees(
        (await connection.run(branchWorktreesScript(clone, name), 30_000))
          .stdout,
      );
    const now = parsePartCheckout(
      (
        await connection.run(
          partCheckoutScript(was.path, clone, was.branch),
          30_000,
        )
      ).stdout,
    );
    let path = was.path;
    let workspaceId = was.workspaceId;
    let branch: string;
    let from: string | undefined;
    let attached: "existing" | "made" | undefined;
    if (now.branch) {
      branch = now.branch;
      if (named) {
        if (!(await branchAt(named)).sha)
          throw new MrReviewsError(
            `${named} is not a local branch of the clone: nothing changed`,
          );
        from = named;
      }
    } else {
      const why =
        now.state === "detached"
          ? `its worktree ${was.path} is on no branch`
          : now.state === "unborn"
            ? `its branch ${now.unborn} is gone (its worktree ${was.path} is on no commit)`
            : `its worktree ${was.path} is gone${now.stored ? "" : `, and so is its branch ${was.branch}`}`;
      if (!named)
        throw new MrReviewsError(
          `${plan.name}'s part cannot be read: ${why}. Give from (an existing local branch) to attach the part to it; nothing changed`,
          "gone",
        );
      const found = await branchAt(named);
      if (!found.sha)
        throw new MrReviewsError(
          `${plan.name}'s part cannot be read (${why}), and ${named} is not a local branch of the clone: nothing changed`,
        );
      branch = named;
      if (found.worktree) {
        path = found.worktree;
        attached = "existing";
        workspaceId = await workspaceAt(effort.clone.connectionId, [path]);
      } else {
        if (!deps.createWorktree)
          throw new MrReviewsError(
            "worktrees cannot be made here",
            "unavailable",
          );
        const made = await deps
          .createWorktree({
            connectionId: effort.clone.connectionId,
            branch: named,
            ...(await partSource(effort, connection)),
          })
          .catch((error) => {
            throw new MrReviewsError(readableError(error));
          });
        // Its own checkout of that branch, the branch where it was.
        const at = (
          await connection.run(
            `cd ${shQuote(made.path)} 2>/dev/null && printf '%s\\n%s\\n' "$(pwd -P)" "$(git rev-parse --show-toplevel 2>/dev/null)" && git symbolic-ref -q HEAD && git rev-parse HEAD`,
            30_000,
          )
        ).stdout
          .trim()
          .split("\n");
        if (
          !at[0] ||
          at[0] !== at[1] ||
          at[2] !== `refs/heads/${named}` ||
          at[3] !== found.sha
        )
          throw new MrReviewsError(
            `${made.path} is not a worktree on ${named} at ${found.sha.slice(0, 10)}: not recorded as the part`,
          );
        path = made.path;
        workspaceId = made.workspaceId;
        attached = "made";
        await placePart(effort, made);
      }
    }
    const targets = [
      upstreamRef(effort),
      `refs/remotes/${effort.target.remote}/${effort.target.branch}`,
    ];
    const baseRef = on?.part ? `refs/heads/${on.part.branch}` : undefined;
    const content = parsePartContent(
      (
        await connection.run(
          partContentScript(clone, branch, targets, baseRef),
          120_000,
        )
      ).stdout,
    );
    if (!content.sha)
      throw new MrReviewsError(
        `the branch ${branch} cannot be read: nothing changed`,
        "gone",
      );
    const base = content.onBase && on?.part ? on.part.branch : undefined;
    const carries = parseCarries(
      (
        await connection.run(
          carriesScript(
            clone,
            branch,
            targets,
            picked.map((commit) => commit.sha),
            content.onBase,
          ),
          120_000,
        )
      ).stdout,
    );
    const stop = parsePartStops(
      (await connection.run(partStopsScript([path]), 30_000)).stdout,
    ).get(path);
    const conflict = stop
      ? {
          sha: stop.sha,
          subject:
            stop.subject ??
            picked.find((commit) => commit.sha === stop.sha)?.subject ??
            "",
          files: stop.files,
          ...(stop.folding ? { folding: true } : {}),
        }
      : undefined;
    const onBranch = carries.sha
      ? picked.length
      : pickedOnBranch(picked, content.onBranch);
    // Not the plan's changes as they are, nor stopped picking them: a
    // port of them on its base, its content its own.
    let ported:
      | { onlyInPlan: string[]; onlyInBranch: string[]; summary: string }
      | undefined;
    if (!carries.sha && !conflict && onBranch < picked.length) {
      const ons = [
        ...(baseRef ? [{ label: "base", ref: baseRef }] : []),
        ...stacked.flatMap((each) =>
          [...(each.part?.from ? [each.part.from] : []), input.upstreamOf(each)]
            .filter((name) => name !== branch)
            .map((name) => ({ label: "upstream", ref: `refs/heads/${name}` })),
        ),
      ];
      const prepared = parsePrepared(
        (
          await connection.run(
            preparedScript(clone, branch, ons, targets, effort.source),
            120_000,
          )
        ).stdout,
      );
      const planFiles = new Set(picked.flatMap((commit) => commit.files));
      if (prepared.sha && prepared.files.some((file) => planFiles.has(file)))
        ported = portedDifference([...planFiles], prepared.files);
    }
    from ??= [
      ...content.upstream.filter((name) => name === input.upstream),
      ...content.upstream,
    ].find((name) => name !== branch);
    const left = [...picked];
    const unfolded = content.fixups.map((subject) => {
      const at = left.findIndex((commit) => commit.subject === subject);
      const [commit] = at < 0 ? [] : left.splice(at, 1);
      return { sha: commit?.sha ?? "", subject };
    });
    const fixupsInPlan = picked.filter((commit) =>
      new RegExp(FIXUP_SUBJECT).test(commit.subject),
    ).length;
    const folded =
      !ported && !conflict && onBranch === picked.length
        ? Math.max(0, fixupsInPlan - unfolded.filter((each) => each.sha).length)
        : 0;
    const part = {
      connectionId: effort.clone.connectionId,
      path,
      branch,
      ...(workspaceId ? { workspaceId } : {}),
      ...(from ? { from } : {}),
      ...(ported ? { ported: true } : {}),
      ...(base ? { base } : {}),
      ...(conflict ? { conflict } : {}),
      unfolded: unfolded.map((each) => each.subject),
      refreshed: new Date().toISOString(),
    };
    const said = [
      ...(from ? [`from ${from}`] : []),
      ...(base ? [`on ${base}`] : []),
      ...(ported ? ["ported"] : []),
      ...(conflict ? ["stopped"] : []),
    ];
    await changePlans(
      service.store,
      effort,
      { action: "part", plan: plan.id, part },
      {
        by: meta.by,
        summary: `Part ${branch} of ${plan.name} refreshed${said.length ? ` (${said.join(", ")})` : ""}`,
      },
    );
    await service.refreshOne(effort, true);
    await service.push(effort.id, { by: meta.by });
    return {
      ok: !conflict,
      refreshed: true,
      path,
      branch,
      sha: content.sha,
      picked: onBranch,
      of: picked.length,
      ...(attached ? { attached } : {}),
      ...(from ? { from } : {}),
      ...(ported
        ? {
            ported: true,
            differs: {
              only_in_plan: ported.onlyInPlan,
              only_in_branch: ported.onlyInBranch,
              summary: ported.summary,
            },
          }
        : {}),
      ...(base ? { base } : {}),
      ...(on?.part && !base ? { not_on: on.part.branch } : {}),
      ...(folded ? { folded } : {}),
      ...(unfolded.length ? { unfolded } : {}),
      ...(!carries.sha && !ported && carries.not
        ? { not_held: carries.not }
        : {}),
      ...(conflict ? { conflict } : {}),
    };
  };
  const effortOf = async () => {
    const found = findEffort(
      (await deps.settings()).efforts,
      String(params.id ?? params.effort ?? ""),
    );
    if (!found) throw new MrReviewsError("no such effort", "not_found");
    return found;
  };
  switch (method) {
    case "bridge.mr_reviews.effort.set":
    case "bridge.mr_reviews.effort.preview": {
      // Declared on a group headed upstream; the source resolved once to
      // an exact ref of the clone (refused when ambiguous).
      const current = await deps.settings();
      const existing = params.id
        ? findEffort(current.efforts, String(params.id))
        : null;
      // Its home: a group headed upstream, or a workspace headed upstream
      // by itself (its home id).
      const group = String(params.group ?? existing?.group ?? "");
      if (
        !current.upstreamGroups.includes(group) &&
        !current.upstreamWorkspaces.some(
          (ref) => upstreamWorkspaceHome(ref) === group,
        ) &&
        !existing
      )
        throw new MrReviewsError(
          "an effort is declared on a group or a workspace headed upstream",
        );
      const members = deps.upstream
        .members()
        .filter(
          (member) => member.group === group || member.path === params.clone,
        );
      const clonePath =
        typeof params.clone === "string" && params.clone.startsWith("/")
          ? params.clone
          : (existing?.clone.path ?? members[0]?.path);
      const member = members.find((each) => each.path === clonePath);
      const connectionId =
        member?.connectionId ?? existing?.clone.connectionId ?? "";
      if (!clonePath || !connectionId)
        throw new MrReviewsError(
          "no clone: put a workspace of the source's clone in the group, or give clone",
        );
      const connection = service.connectionOf(connectionId);
      if (!connection)
        throw new MrReviewsError("that connection is not ready", "unavailable");
      const sourceName =
        typeof params.source === "string" && params.source.trim()
          ? params.source.trim()
          : existing?.source;
      if (!sourceName)
        throw new MrReviewsError("source (a branch) is required");
      const source =
        existing && sourceName === existing.source
          ? existing.source
          : await service.exactRef(connection, clonePath, sourceName);
      const targetText =
        typeof params.target === "string" && params.target.includes("/")
          ? params.target
          : existing
            ? `${existing.target.remote}/${existing.target.branch}`
            : "origin/main";
      const slash = targetText.indexOf("/");
      const feeders: string[] = [];
      const feederNames = Array.isArray(params.feeders)
        ? (params.feeders as unknown[]).filter(
            (each): each is string => typeof each === "string",
          )
        : (existing?.feeders ?? []);
      for (const name of feederNames.slice(0, 20))
        feeders.push(
          existing?.feeders.includes(name)
            ? name
            : await service.exactRef(connection, clonePath, name),
        );
      const effort: MrEffort = {
        id:
          existing?.id ??
          `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        group,
        name:
          (typeof params.name === "string" && params.name.trim()) ||
          existing?.name ||
          (await deps.groupLabel(group)) ||
          source.replace(/^refs\/(heads|remotes)\//, ""),
        clone: { connectionId, path: clonePath },
        source,
        target: {
          remote: targetText.slice(0, slash),
          branch: targetText.slice(slash + 1),
        },
        feeders,
        ...(params.head && typeof params.head === "string"
          ? (() => {
              const head = deps.upstream
                .members()
                .find(
                  (each) =>
                    each.path === params.head || each.label === params.head,
                );
              return head
                ? {
                    head: {
                      connectionId: head.connectionId,
                      path: head.path,
                      workspaceId: head.workspaceId,
                    },
                  }
                : {};
            })()
          : existing?.head
            ? { head: existing.head }
            : {}),
      };
      if (method === "bridge.mr_reviews.effort.preview")
        return {
          effort,
          preview: await service.preview(
            effort,
            current.efforts.filter((each) => each.id !== effort.id),
          ),
        };
      const saved = await deps.edit(async () => {
        const latest = await deps.settings();
        const efforts = latest.efforts.some((each) => each.id === effort.id)
          ? latest.efforts.map((each) =>
              each.id === effort.id ? effort : each,
            )
          : [...latest.efforts, effort];
        return deps.save({ ...latest, efforts }, meta);
      });
      void service.refreshOne(effort, true);
      return { ok: true, effort, version: saved.orderVersion ?? 0 };
    }
    case "bridge.mr_reviews.effort.delete": {
      // A name several efforts share (a duplicate declared by mistake)
      // deletes none: its id says which.
      const wanted = String(params.id ?? params.effort ?? "");
      const declared = (await deps.settings()).efforts;
      const named = declared.filter(
        (each) => each.name.toLowerCase() === wanted.trim().toLowerCase(),
      );
      if (!declared.some((each) => each.id === wanted) && named.length > 1)
        throw new MrReviewsError(
          `several efforts are named ${named[0]!.name}: give its id (${named
            .map((each) => `${each.id}: ${each.source} in ${each.clone.path}`)
            .join("; ")})`,
        );
      const effort = await effortOf();
      const saved = await deps.edit(async () => {
        const latest = await deps.settings();
        return deps.save(
          {
            ...latest,
            efforts: latest.efforts.filter((each) => each.id !== effort.id),
          },
          meta,
        );
      });
      // Only its declaration goes. Its ledger (marks, plans, history)
      // stays on disk under its own id, for Undo, and no other effort's
      // ledger, no branch and no worktree is touched.
      return {
        ok: true,
        effort: { id: effort.id, name: effort.name },
        version: saved.orderVersion ?? 0,
      };
    }
    case "bridge.mr_reviews.effort.refresh": {
      const effort = await effortOf();
      await service.refreshOne(effort, true);
      return { ok: true };
    }
    case "bridge.mr_reviews.effort.get": {
      const effort = await effortOf();
      const settings = await deps.settings();
      const derived = service.store.derived(effort.id);
      const ledger = await livePartStops(effort, derived?.commits ?? []);
      return {
        effort,
        summary: service
          .summaries(settings)
          .find((each) => each.id === effort.id),
        commits: derived?.commits ?? [],
        feeders: derived?.feeders ?? [],
        daily: derived?.daily ?? [],
        journal: ledger.journal
          .slice(-10)
          .map(({ id, at, by, summary }) => ({ id, at, by, summary })),
        proposals: Object.fromEntries(
          Object.entries(derived?.proposals ?? {}).filter(
            ([key]) => !ledger.matches[key]?.accepted,
          ),
        ),
        plans: ledger.plans,
        changes: changesOf(derived, ledger, service.store.seen(effort.id)),
        ...(deps.entries
          ? {
              board: effortPlanEntries({
                effort,
                plans: ledger.plans,
                branches: deps.upstream.branches(),
                entries: await deps.entries(),
                patchIds: deps.upstream.patchIds(),
              }),
            }
          : {}),
      };
    }
    case "bridge.mr_reviews.effort.seen": {
      // What the user saw: What changed starts again from here.
      const effort = await effortOf();
      const derived = service.store.derived(effort.id);
      if (derived)
        service.store.writeSeen(
          effort.id,
          snapshotOf(derived, service.store.ledger(effort.id)),
        );
      await service.push(effort.id, { by: "user" });
      return { ok: true };
    }
    case "bridge.mr_reviews.ledger.match": {
      const effort = await effortOf();
      const decisions = Array.isArray(params.decisions)
        ? (params.decisions as unknown[]).flatMap((each) => {
            const value = each as Record<string, unknown>;
            return value &&
              typeof value.commit === "string" &&
              typeof value.match === "string" &&
              typeof value.accept === "boolean"
              ? [
                  {
                    commit: value.commit,
                    match: value.match,
                    accept: value.accept,
                  },
                ]
              : [];
          })
        : [];
      if (
        !decisions.length ||
        decisions.length !== (params.decisions as unknown[]).length
      )
        throw new MrReviewsError(
          "decisions: [{commit, match, accept}] (commit and match shas)",
        );
      const accepted = decisions.filter((each) => each.accept).length;
      const result = await decideMatches(service.store, effort, {
        decisions,
        by: meta.by,
        summary:
          "summary" in meta && meta.summary
            ? meta.summary
            : `${accepted} match${accepted === 1 ? "" : "es"} confirmed, ${decisions.length - accepted} rejected`,
      }).catch((error) => {
        throw new MrReviewsError(
          error instanceof Error ? error.message : String(error),
        );
      });
      await service.refreshOne(effort, true);
      await service.push(effort.id, {
        by: meta.by,
        ...("summary" in meta && meta.summary ? { summary: meta.summary } : {}),
        journal: result.journal,
      });
      return { ok: true, ...result };
    }
    case "bridge.mr_reviews.ledger.plans": {
      const effort = await effortOf();
      const action = String(params.action ?? "");
      const list = (value: unknown) =>
        Array.isArray(value)
          ? (value as unknown[]).filter(
              (each): each is string => typeof each === "string",
            )
          : undefined;
      const plan = String(params.plan ?? "");
      let change: PlanAction;
      if (action === "propose")
        change = {
          action,
          name: String(params.name ?? plan),
          commits: list(params.commits) ?? [],
          ...(list(params.depends_on)
            ? { dependsOn: list(params.depends_on)! }
            : {}),
          ...(params.accepted === true ? { accepted: true } : {}),
        };
      else if (action === "accept" || action === "drop")
        change = { action, plan };
      else if (action === "edit")
        change = {
          action,
          plan,
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          ...(list(params.commits) ? { commits: list(params.commits)! } : {}),
          ...(list(params.add) ? { add: list(params.add)! } : {}),
          ...(list(params.remove) ? { remove: list(params.remove)! } : {}),
          ...(list(params.depends_on)
            ? { dependsOn: list(params.depends_on)! }
            : {}),
        };
      else if (action === "split")
        change = {
          action,
          plan,
          name: String(params.name ?? ""),
          commits: list(params.commits) ?? [],
        };
      else
        throw new MrReviewsError(
          "action: propose, accept, edit, split or drop",
        );
      const verb: Record<string, string> = {
        propose: "proposed",
        accept: "accepted",
        edit: "changed",
        split: "split",
        drop: "dropped",
      };
      const result = await changePlans(service.store, effort, change, {
        by: meta.by,
        summary:
          "summary" in meta && meta.summary
            ? meta.summary
            : `Planned request ${"name" in change && change.name ? change.name : plan} ${verb[action]}`,
        taken: service.takenElsewhere(effort.id),
      }).catch((error) => {
        throw new MrReviewsError(
          error instanceof Error ? error.message : String(error),
        );
      });
      await service.refreshOne(effort, true);
      await service.push(effort.id, {
        by: meta.by,
        ...("summary" in meta && meta.summary ? { summary: meta.summary } : {}),
        journal: result.journal,
      });
      return { ok: true, ...result };
    }
    case "bridge.mr_reviews.effort.part": {
      // An accepted planned request gets its part (D25): a worktree in the
      // effort's group through the user's worktree path, on the target,
      // with the plan's commits picked in source order (no -x) and their
      // fixups folded into their targets. A conflict stops there and is
      // reported; nothing is aborted. Its base: the part of the plan it
      // depends on (the last one in source order), or of the plan its
      // fixups all fix (refused while that one has none); the target
      // otherwise. When a local upstream/<plan> branch (or the one named by
      // from) already holds the plan's changes over the target, the part
      // starts at its commit instead, nothing picked; when it is a port of
      // the plan (its own content) sitting on the base, too, said ported:
      // its commits, never the source's. That branch is only read, never
      // moved.
      const effort = await effortOf();
      const ledger = service.store.ledger(effort.id);
      const plan = findPlan(ledger.plans, String(params.plan ?? ""));
      if (!plan)
        throw new MrReviewsError("no such planned request", "not_found");
      if (plan.state !== "accepted")
        throw new MrReviewsError(`accept ${plan.name} first`);
      // Refreshed: its record read again from its branch as it is now.
      const refresh = params.refresh === true;
      if (plan.part && !refresh)
        throw new MrReviewsError(
          `${plan.name} has its part already: ${plan.part.path}`,
        );
      if (refresh && !plan.part)
        throw new MrReviewsError(
          `${plan.name} has no part to refresh: make it first`,
          "not_found",
        );
      const commits = service.store.derived(effort.id)?.commits ?? [];
      const bykey = new Map(commits.map((commit) => [commit.key, commit]));
      const picked = plan.commits.flatMap((key) => {
        const commit = bykey.get(key);
        return commit ? [commit] : [];
      });
      if (picked.length !== plan.commits.length)
        throw new MrReviewsError(
          "some of its commits are no longer on the source: edit the plan",
        );
      const slugOf = (name: string) =>
        name
          .toLowerCase()
          .replace(/[^a-z0-9._/-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60);
      const slug = slugOf(plan.name);
      const upstreamOf = (name: string) =>
        name.startsWith("upstream/") ? name : `upstream/${name}`;
      // Its base: the part it stacks on. Plans in source order (their
      // last commit), the last one wins.
      const position = new Map(
        commits.map((commit, index) => [commit.key, index]),
      );
      const lastAt = (each: MrPlan) =>
        Math.max(-1, ...each.commits.map((key) => position.get(key) ?? -1));
      const planOfKey = new Map(
        ledger.plans.flatMap((each) =>
          each.commits.map((key) => [key, each] as const),
        ),
      );
      const fixes = fixupTargets(commits);
      const fixed = new Map<string, MrPlan>();
      const fixupOnly =
        picked.length > 0 &&
        picked.every((commit) => {
          const target = fixes[position.get(commit.key) ?? -1];
          const of =
            target === undefined || target < 0
              ? undefined
              : planOfKey.get(commits[target]!.key);
          if (!of || of.id === plan.id) return false;
          fixed.set(of.id, of);
          return true;
        });
      if (fixupOnly && !refresh) {
        const without = [...fixed.values()].find((each) => !each.part);
        if (without)
          throw new MrReviewsError(
            `${plan.name} only fixes commits of ${without.name}: make the part of ${without.name} first, ${plan.name}'s part starts on it`,
          );
      }
      const stacked = [
        ...plan.dependsOn.flatMap((id) => {
          const each = ledger.plans.find((other) => other.id === id);
          return each?.part ? [each] : [];
        }),
        ...(fixupOnly ? fixed.values() : []),
      ];
      const on = stacked.sort((a, b) => lastAt(b) - lastAt(a))[0];
      if (on?.part?.conflict && !refresh)
        throw new MrReviewsError(
          `the part of ${on.name} (${on.part.branch}), which this one starts on, is stopped at a conflict: resolve it there first`,
        );
      const baseRef = on?.part ? `refs/heads/${on.part.branch}` : undefined;
      if (refresh)
        return refreshPart({
          effort,
          plan,
          picked,
          on,
          stacked,
          upstream: upstreamOf(slug),
          upstreamOf: (each) => upstreamOf(slugOf(each.name)),
        });
      const branch =
        (typeof params.branch === "string" && params.branch.trim()) || slug;
      const isBranchName = (name: string) =>
        /^[A-Za-z0-9][\w./-]*$/.test(name) && !name.includes("..");
      if (!isBranchName(branch))
        throw new MrReviewsError(`"${branch}" is not a branch name`);
      const named = typeof params.from === "string" ? params.from.trim() : "";
      if (named && !isBranchName(named))
        throw new MrReviewsError(`"${named}" is not a branch name`);
      const base = named || upstreamOf(slug);
      const connection = service.connectionOf(effort.clone.connectionId);
      if (!connection)
        throw new MrReviewsError("that connection is not ready", "unavailable");
      if (!deps.createWorktree)
        throw new MrReviewsError(
          "worktrees cannot be made here",
          "unavailable",
        );
      // A new branch only: an existing one (here or on origin) is someone
      // else's work, which a part must never check out or move.
      const taken = (
        await connection.run(
          `git -C ${shQuote(effort.clone.path)} for-each-ref --format='%(refname)' ${shQuote(`refs/heads/${branch}`)} ${shQuote(`refs/remotes/origin/${branch}`)}`,
          30_000,
        )
      ).stdout.trim();
      if (taken)
        throw new MrReviewsError(
          `the branch ${branch} exists already (${taken.split("\n")[0]}): name the part's branch with branch`,
        );
      const targets = [
        upstreamRef(effort),
        `refs/remotes/${effort.target.remote}/${effort.target.branch}`,
      ];
      const carries = parseCarries(
        (
          await connection.run(
            carriesScript(
              effort.clone.path,
              base,
              targets,
              picked.map((commit) => commit.sha),
            ),
            120_000,
          )
        ).stdout,
      );
      if (named && carries.missing)
        throw new MrReviewsError(`${named} is not a local branch of the clone`);
      if (
        baseRef &&
        !(
          await connection.run(
            `git -C ${shQuote(effort.clone.path)} rev-parse -q --verify ${shQuote(`${baseRef}^{commit}`)}`,
            30_000,
          )
        ).stdout.trim()
      )
        throw new MrReviewsError(
          `the branch ${on!.part!.branch} of ${on!.name}'s part, which this one starts on, is gone`,
        );
      // Not the plan's changes as they are: a port of it on the base is
      // still the part's start (its content, said), never the source's
      // commits picked beside it. A branch named by from must touch the
      // plan's files as well.
      let start = carries.sha ? carries.sha : undefined;
      let ported:
        | { onlyInPlan: string[]; onlyInBranch: string[]; summary: string }
        | undefined;
      if (!start && !carries.missing) {
        const ons = [
          ...(baseRef ? [{ label: "base", ref: baseRef }] : []),
          ...stacked.flatMap((each) =>
            [
              ...(each.part?.from ? [each.part.from] : []),
              upstreamOf(slugOf(each.name)),
            ].map((name) => ({ label: "upstream", ref: `refs/heads/${name}` })),
          ),
        ];
        const prepared = parsePrepared(
          (
            await connection.run(
              preparedScript(
                effort.clone.path,
                base,
                ons,
                targets,
                effort.source,
              ),
              120_000,
            )
          ).stdout,
        );
        const planFiles = new Set(picked.flatMap((commit) => commit.files));
        const usable =
          prepared.sha &&
          (!named || prepared.files.some((file) => planFiles.has(file)));
        if (usable) {
          start = prepared.sha;
          ported = portedDifference([...planFiles], prepared.files);
        } else if (named)
          throw new MrReviewsError(
            `${named} does not hold the plan's changes over the target (${carries.not ?? "unknown"}) and is no port of it on the part's base (${prepared.sha ? "none of the plan's files" : (prepared.not ?? "unknown")}): nothing made`,
          );
      }
      const from = await partSource(effort, connection);
      const made = await deps
        .createWorktree({
          connectionId: effort.clone.connectionId,
          branch,
          ...from,
        })
        .catch((error) => {
          throw new MrReviewsError(readableError(error));
        });
      // The checkout made must be the new branch's own: never an existing
      // worktree its path led to, which is left as it is, unrecorded.
      const at = (
        await connection.run(
          `cd ${shQuote(made.path)} 2>/dev/null && printf '%s\\n%s\\n' "$(pwd -P)" "$(git rev-parse --show-toplevel 2>/dev/null)" && git symbolic-ref -q HEAD`,
          30_000,
        )
      ).stdout
        .trim()
        .split("\n");
      if (!at[0] || at[0] !== at[1] || at[2] !== `refs/heads/${branch}`)
        throw new MrReviewsError(
          `${made.path} is not a new worktree on ${branch}${at[2] ? ` (it is on ${at[2].replace(/^refs\/heads\//, "")})` : ""}: nothing picked there, and it is not this part`,
        );
      const pick = parsePick(
        (
          await connection.run(
            pickScript(
              made.path,
              start ? [start] : baseRef ? [baseRef] : targets,
              start ? [] : picked.map((commit) => commit.sha),
              branch,
            ),
            300_000,
          )
        ).stdout,
      );
      // Only the commits read back on the branch count as picked (before
      // the fixups are folded, by patch id; folding must keep the tree).
      // From a branch holding them all, checked tree to tree: all of them.
      const onBranch = start
        ? pick.error || ported
          ? 0
          : picked.length
        : pick.onBranch
          ? pickedOnBranch(picked, pick.onBranch)
          : 0;
      const missing =
        !start && !pick.error && !pick.conflict
          ? picked.length - pick.skipped.length - onBranch
          : 0;
      const error =
        pick.error ??
        (missing > 0
          ? `${missing} of the plan's commits are not on ${branch}`
          : pick.fold && !pick.fold.sameTree
            ? `folding the fixups changed what ${branch} holds: look at it there`
            : undefined);
      const conflict = pick.conflict
        ? {
            sha: pick.conflict,
            subject:
              picked.find((commit) => commit.sha === pick.conflict)?.subject ??
              "",
            files: pick.files,
          }
        : pick.folding
          ? {
              sha: pick.folding.sha,
              subject: pick.folding.subject,
              files: pick.files,
              folding: true,
            }
          : undefined;
      // Fixups whose target is not in the part stay commits: said.
      const left = [...picked];
      const unfolded = (pick.fold?.unfolded ?? []).map((subject) => {
        const at = left.findIndex((commit) => commit.subject === subject);
        const [commit] = at < 0 ? [] : left.splice(at, 1);
        return { sha: commit?.sha ?? "", subject };
      });
      const folded =
        pick.fold && pick.onBranch
          ? Math.max(0, pick.onBranch.count - pick.fold.count)
          : 0;
      const part = {
        connectionId: effort.clone.connectionId,
        path: made.path,
        branch,
        ...(made.workspaceId ? { workspaceId: made.workspaceId } : {}),
        ...(start ? { from: base } : {}),
        ...(ported ? { ported: true } : {}),
        ...(!start && on?.part ? { base: on.part.branch } : {}),
        ...(conflict ? { conflict } : {}),
        ...(!start && !conflict && !pick.error
          ? { unfolded: unfolded.map((each) => each.subject) }
          : {}),
      };
      await changePlans(
        service.store,
        effort,
        { action: "part", plan: plan.id, part },
        {
          by: meta.by,
          summary: `Part ${branch} made for ${plan.name}${start ? ` from ${base}${ported ? " (ported)" : ""}` : on?.part ? ` on ${on.part.branch}` : ""}`,
        },
      );
      await placePart(effort, made);
      // Its branch is a request not proposed yet until its request opens.
      await deps.upstream.refresh(true);
      const row = deps.upstream
        .branches()
        .find((each) => each.member.path === made.path);
      if (row)
        await deps.edit(async () => {
          const latest = await deps.settings();
          if (latest.unsent.some((each) => each.key === row.key)) return latest;
          return deps.save(
            {
              ...latest,
              unsent: [
                ...latest.unsent,
                {
                  key: row.key,
                  title: plan.name.slice(0, 300),
                  at: new Date().toISOString(),
                },
              ],
            },
            meta,
          );
        });
      await service.refreshOne(effort, true);
      await service.push(effort.id, { by: meta.by });
      return {
        ok: !conflict && !error,
        path: made.path,
        branch,
        picked: onBranch,
        of: picked.length,
        ...(start ? { from: base } : {}),
        ...(ported
          ? {
              ported: true,
              differs: {
                only_in_plan: ported.onlyInPlan,
                only_in_branch: ported.onlyInBranch,
                summary: ported.summary,
              },
            }
          : {}),
        ...(!start && on?.part ? { base: on.part.branch } : {}),
        ...(folded ? { folded } : {}),
        ...(unfolded.length ? { unfolded } : {}),
        ...(pick.skipped.length
          ? {
              skipped: pick.skipped.map((sha) => ({
                sha,
                subject:
                  picked.find((commit) => commit.sha === sha)?.subject ?? "",
              })),
            }
          : {}),
        ...(conflict ? { conflict } : {}),
        ...(error ? { error } : {}),
      };
    }
    case "bridge.mr_reviews.effort.open_commit": {
      // `d`: the commit's diff as a Roamgate review in the head workspace's
      // Changes (D32: the page goes there); with `from`, two versions of
      // one commit compared tree to tree.
      const effort = await effortOf();
      const sha = String(params.sha ?? "");
      if (!/^[0-9a-f]{7,40}$/.test(sha))
        throw new MrReviewsError("sha: a commit id");
      const from = params.from === undefined ? "" : String(params.from);
      if (from && !/^[0-9a-f]{7,40}$/.test(from))
        throw new MrReviewsError("from: a commit id");
      const head = effort.head ?? {
        connectionId: effort.clone.connectionId,
        path: effort.clone.path,
      };
      const workspaceId = await workspaceAt(
        head.connectionId,
        [head.path],
        "workspaceId" in head ? head.workspaceId : undefined,
      );
      if (!workspaceId)
        throw new MrReviewsError(
          "its head workspace is not open: open it, or set head",
          "not_found",
        );
      if (!deps.openRange)
        throw new MrReviewsError(
          "reviews cannot be opened here",
          "unavailable",
        );
      const subject =
        service.store
          .derived(effort.id)
          ?.commits.find((commit) => commit.sha.startsWith(sha))?.subject ??
        sha;
      const opened = await deps.openRange({
        connectionId: head.connectionId,
        workspaceId,
        root: head.path,
        ...(from
          ? { base: from, head: sha, compare: true }
          : { base: `${sha}^`, head: sha }),
        title: (from ? `${subject} (two versions)` : subject).slice(0, 120),
      });
      return {
        ok: true,
        connectionId: head.connectionId,
        workspaceId,
        ...opened,
      };
    }
    case "bridge.mr_reviews.effort.diff": {
      // Between two versions of one commit (D24): read on demand, never kept.
      const effort = await effortOf();
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!/^[0-9a-f]{7,40}$/.test(from) || !/^[0-9a-f]{7,40}$/.test(to))
        throw new MrReviewsError("from and to: commit ids");
      const connection = service.connectionOf(effort.clone.connectionId);
      if (!connection)
        throw new MrReviewsError("that connection is not ready", "unavailable");
      const d = shQuote(effort.clone.path);
      const read = await connection.run(
        `git -C ${d} range-diff --no-color ${from}^! ${to}^! 2>/dev/null || git -C ${d} diff --no-color ${from} ${to}`,
        60_000,
      );
      const text = read.stdout;
      return {
        text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n...` : text,
      };
    }
    case "bridge.mr_reviews.effort.threads": {
      // The threads on the effort's view (its review, target `effort`):
      // delivered to its leader as review comments, answered in place.
      const effort = await effortOf();
      if (!deps.effortReview)
        throw new MrReviewsError(
          "reviews cannot be opened here",
          "unavailable",
        );
      const head = effort.head ?? {
        connectionId: effort.clone.connectionId,
        path: effort.clone.path,
      };
      const open = params.open === true;
      const workspaceId = open
        ? await workspaceAt(
            head.connectionId,
            [head.path],
            "workspaceId" in head ? head.workspaceId : undefined,
          )
        : undefined;
      const snapshot = await deps.effortReview({
        effort: effort.id,
        connectionId: head.connectionId,
        ...(workspaceId ? { workspaceId } : {}),
        root: head.path,
        title: `Effort ${effort.name}`,
        open,
      });
      return { snapshot };
    }
    case "bridge.mr_reviews.effort.leader": {
      // The effort's leader is the Claude session of its head workspace
      // (D15); only the user starts it (D18).
      const effort = await effortOf();
      const head = effort.head ?? {
        connectionId: effort.clone.connectionId,
        path: effort.clone.path,
      };
      const connection = service.connectionOf(head.connectionId);
      if (!connection)
        throw new MrReviewsError("that connection is not ready", "unavailable");
      const workspaceId = await workspaceAt(
        head.connectionId,
        [head.path],
        "workspaceId" in head ? head.workspaceId : undefined,
      );
      if (!workspaceId)
        throw new MrReviewsError(
          "its head workspace is not open: open it, or set head",
          "not_found",
        );
      const listed = await connection.herdr("pane.list", {});
      const panes: { pane_id: string }[] = (
        Array.isArray(listed?.panes) ? listed.panes : []
      ).filter((pane: any) => pane?.workspace_id === workspaceId);
      let free: string | null = null;
      for (const pane of panes) {
        // A pane conversation mode holds runs its Claude, even stopped:
        // Herdr sees only the holder there, yet a message wakes the session.
        const held = !!connection.conversation?.owned(pane.pane_id);
        const agent = held
          ? { agent: "claude" }
          : await connection
              .herdr("agent.get", { target: pane.pane_id })
              .then((answer: any) => answer?.agent ?? null)
              .catch(() => null);
        const name = typeof agent?.agent === "string" ? agent.agent : "";
        if (/claude/i.test(name))
          return {
            state: "ready",
            connectionId: head.connectionId,
            workspaceId,
            paneId: pane.pane_id,
          };
        if (!name && !free) free = pane.pane_id;
      }
      if (params.start !== true || !free)
        return {
          state: free ? "none" : "busy",
          connectionId: head.connectionId,
          workspaceId,
        };
      await connection.herdr("pane.send_text", {
        pane_id: free,
        text: claudeCommand(randomUUID(), false),
      });
      return {
        state: "starting",
        connectionId: head.connectionId,
        workspaceId,
        paneId: free,
      };
    }
    case "bridge.mr_reviews.effort.history": {
      const effort = await effortOf();
      const key = String(params.key ?? "");
      if (!key) throw new MrReviewsError("key is required");
      return { versions: service.store.history(effort.id, key) };
    }
    case "bridge.mr_reviews.ledger.set": {
      const effort = await effortOf();
      if (!isAuthoredDisposition(params.disposition))
        throw new MrReviewsError(
          "disposition: not_for_upstream, superseded, planned, upstream, in_review or unsorted",
        );
      if (
        !Array.isArray(params.commits) ||
        params.commits.some((each) => typeof each !== "string")
      )
        throw new MrReviewsError("commits (shas or keys) are required");
      const commits = params.commits as string[];
      const result = await setDispositions(service.store, effort, {
        commits,
        disposition: params.disposition,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        ...(typeof params.pointer === "string"
          ? { pointer: params.pointer }
          : {}),
        by: meta.by,
        summary:
          meta.by === "agent" && "summary" in meta && meta.summary
            ? meta.summary
            : `${commits.length} commit${commits.length === 1 ? "" : "s"} ${String(params.disposition).replace(/_/g, " ")}`,
      });
      if (result.unknown.length)
        throw new MrReviewsError(
          `not in the ledger (or ambiguous): ${result.unknown.slice(0, 20).join(", ")}; nothing changed`,
        );
      await service.refreshOne(effort, true);
      await service.push(effort.id, {
        by: meta.by,
        ...("summary" in meta && meta.summary ? { summary: meta.summary } : {}),
        journal: result.journal,
      });
      return { ok: true, ...result };
    }
    case "bridge.mr_reviews.ledger.undo": {
      const effort = await effortOf();
      const done = await undoLedger(
        service.store,
        effort.id,
        typeof params.journal === "number" ? params.journal : undefined,
      );
      if (!done.undone) throw new MrReviewsError("nothing to undo", "gone");
      await service.refreshOne(effort, true);
      await service.push(effort.id, { by: "user" });
      return { ok: true, ...done };
    }
    default:
      return undefined;
  }
}

/**
 * The main checkout of the repository a checkout belongs to, where Herdr
 * starts new worktrees from: the folder of its git common directory
 * (`<root>/.git`); for a clone kept in a repository directory, as
 * gstreamer.git is (the first entry of `git worktree list`, with no work
 * tree of its own), the checkout the MR home finds for it
 * (`homeSourceScript`: the one its `gitdir` file names, `core.worktree`, or
 * the directory beside it without `.git`, when that checkout's repository
 * is this one). `checkout` is null when the repository has no checkout of
 * its own (a bare one, or one whose checkout is gone); the whole is null
 * when git cannot tell the repository.
 */
export async function mainCheckout(
  connection: MrConnection,
  path: string,
): Promise<{ repository: string; checkout: string | null } | null> {
  const run = await connection
    .run(
      `git -C ${shQuote(path)} rev-parse --path-format=absolute --git-common-dir`,
      30_000,
    )
    .catch(() => null);
  const repository =
    run?.code === 0 ? run.stdout.trim().replace(/\/+$/, "") : "";
  if (!repository.startsWith("/")) return null;
  if (repository.endsWith("/.git"))
    return { repository, checkout: repository.slice(0, -"/.git".length) };
  const source = await connection
    .run(homeSourceScript(repository), 30_000)
    .catch(() => null);
  return {
    repository,
    checkout: source ? parseHomeSource(source.stdout) || null : null,
  };
}

/**
 * A linked worktree workspace's repository parent, as the workspace menu
 * finds it: the one Roamgate recorded, else the only main checkout of the
 * same repository. The workspace itself when it is not a linked worktree.
 */
export function repoParentWorkspace(
  workspaces: any[],
  workspace: any,
): string | undefined {
  const worktree = workspace?.worktree;
  if (worktree?.is_linked_worktree !== true)
    return worktree?.is_linked_worktree === false
      ? workspace.workspace_id
      : undefined;
  const mains = workspaces.filter(
    (each) =>
      each?.worktree?.is_linked_worktree === false &&
      !!worktree.repo_key &&
      each.worktree.repo_key === worktree.repo_key &&
      typeof each.workspace_id === "string",
  );
  const explicit = mains.find(
    (each) => each.workspace_id === worktree.parent_workspace_id,
  );
  return (explicit ?? (mains.length === 1 ? mains[0] : undefined))
    ?.workspace_id;
}

/**
 * An error as the user reads it: without Herdr's code prefix
 * (`linked_worktree_source: ...`) or a closing period, which the toast adds.
 */
export function readableError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/^[a-z][a-z0-9_]*: /, "")
    .trim()
    .replace(/\.+$/, "");
}

/**
 * In a fresh part worktree: refused unless it is on the part's branch;
 * moved onto the target when it is elsewhere, only while clean and only
 * while the branch was just made (one reflog entry: never an existing
 * branch's commits dropped), then the commits picked in order. Prints
 * `P n` (picked), `S sha` for one already in the target (empty,
 * skipped), and on a stop `X sha` with `U file` lines; never aborts.
 * Then what the branch holds over the target, read back: `N count` and
 * an `I patch-id` line per commit with a diff. Then, when the picks all
 * went in, every fixup!, squash! and amend! commit folded into its
 * target (a non-interactive autosquash rebase onto the target; a squash!
 * adds its body to the target's message, never its subject line):
 * `T same|differs` (the tree against the one before folding), `F count`
 * (the commits left) and `K subject` per fixup left as a commit (its
 * target not in the part); on a stop `R sha subject` with `U file` lines,
 * never aborted.
 */
export function pickScript(
  dir: string,
  targets: string[],
  shas: string[],
  branch: string,
) {
  return [
    `d=${shQuote(dir)}`,
    '[ -d "$d" ] || { echo "E\tno such worktree"; exit 0; }',
    `[ "$(git -C "$d" symbolic-ref -q HEAD)" = ${shQuote(`refs/heads/${branch}`)} ] || { echo "E\tthe worktree is not on the part's branch"; exit 0; }`,
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[0]!)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[1] ?? targets[0]!)} 2>/dev/null)`,
    'report() { [ -n "$t" ] || return 0; printf "N\t%s\n" "$(git -C "$d" rev-list --count "$t"..HEAD)"; git -C "$d" log --no-merges -p --format="commit %H" "$t"..HEAD | git -C "$d" patch-id --stable | awk \'{ print "I\t" $1 }\'; }',
    `fresh=$(git -C "$d" reflog show --format=%H ${shQuote(`refs/heads/${branch}`)} 2>/dev/null | wc -l)`,
    'if [ -n "$t" ] && [ "$(git -C "$d" rev-parse HEAD)" != "$t" ]; then',
    '  if [ "$fresh" -ne 1 ] || [ -n "$(git -C "$d" status --porcelain)" ]; then echo "E\tthe branch is not a fresh one on a clean worktree: not moved onto the target"; exit 0; fi',
    '  git -C "$d" reset -q --keep "$t" || { echo "E\tcannot move the part onto the target"; exit 0; }',
    "fi",
    "n=0",
    `for c in ${shas.map(shQuote).join(" ")}; do`,
    '  if git -C "$d" -c core.editor=true cherry-pick --allow-empty "$c" >/dev/null 2>&1; then n=$((n+1)); else',
    // Already in the target (picked empty): skipped and said, not a stop.
    '    if [ -z "$(git -C "$d" diff --name-only --diff-filter=U)" ] && [ -z "$(git -C "$d" status --porcelain)" ] && git -C "$d" rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null; then git -C "$d" cherry-pick --skip >/dev/null 2>&1 && { printf "S\t%s\n" "$c"; continue; }; fi',
    '    printf "P\t%s\nX\t%s\n" "$n" "$c"',
    '    git -C "$d" diff --name-only --diff-filter=U | sed "s/^/U\t/"',
    "    report",
    "    exit 0",
    "  fi",
    "done",
    'printf "P\t%s\n" "$n"',
    "report",
    `[ -n "$t" ] && git -C "$d" log --format=%s "$t"..HEAD | grep -qE ${shQuote(FIXUP_SUBJECT)} || exit 0`,
    'before=$(git -C "$d" rev-parse "HEAD^{tree}")',
    // Its own editor for a squash!'s message: the squash! subject lines
    // out, the target's message and any body the squash! adds kept.
    `if GIT_EDITOR=${shQuote('f() { grep -v "^squash! " "$1" > "$1.rg"; mv "$1.rg" "$1"; }; f')} git -C "$d" -c sequence.editor=: -c rebase.updateRefs=false -c rebase.autoStash=false -c rebase.abbreviateCommands=false rebase -i --autosquash --empty=keep --no-verify "$t" >/dev/null 2>&1; then`,
    '  [ "$(git -C "$d" rev-parse "HEAD^{tree}")" = "$before" ] && echo "T\tsame" || echo "T\tdiffers"',
    '  printf "F\t%s\n" "$(git -C "$d" rev-list --count "$t"..HEAD)"',
    `  git -C "$d" log --reverse --format=%s "$t"..HEAD | grep -E ${shQuote(FIXUP_SUBJECT)} | sed "s/^/K\t/"`,
    'elif r=$(git -C "$d" rev-parse -q --verify REBASE_HEAD 2>/dev/null); then',
    '  printf "R\t%s\t%s\n" "$r" "$(git -C "$d" log -1 --format=%s "$r")"',
    '  git -C "$d" diff --name-only --diff-filter=U | sed "s/^/U\t/"',
    'else echo "E\tfolding the fixups failed"; fi',
  ].join("\n");
}

const FIXUP_SUBJECT = "^(fixup|squash|amend)! ";

/**
 * Whether a local branch already holds a plan's changes over the target:
 * `M` when there is no such branch, `N reason` when it does not, `Y sha`
 * when it does. The plan's changes, squashed: its commits merged in turn
 * onto the tree where the branch leaves the target; held when merging
 * that squashed change into the branch cleanly leaves its tree as it is
 * (all of it there already). Only read: no ref, index or worktree
 * touched.
 */
export function carriesScript(
  dir: string,
  branch: string,
  targets: string[],
  shas: string[],
  onto?: string,
) {
  return [
    `d=${shQuote(dir)}`,
    `b=$(git -C "$d" rev-parse -q --verify ${shQuote(`refs/heads/${branch}^{commit}`)} 2>/dev/null) || { echo M; exit 0; }`,
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[0]!)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[1] ?? targets[0]!)} 2>/dev/null) || { echo "N\tthe target is unknown"; exit 0; }`,
    '[ "$(git -C "$d" rev-list --count "$t..$b")" -gt 0 ] || { echo "N\tnothing over the target"; exit 0; }',
    onto
      ? `m=${shQuote(onto)}`
      : 'm=$(git -C "$d" merge-base "$t" "$b") || { echo "N\tno common history with the target"; exit 0; }',
    'base=$(git -C "$d" rev-parse "$m^{tree}")',
    "cur=$base",
    `for c in ${shas.map(shQuote).join(" ")}; do`,
    '  p=$(git -C "$d" rev-parse -q --verify "$c^" 2>/dev/null) || { printf "N\t%s is a root commit\n" "$c"; exit 0; }',
    '  out=$(git -C "$d" merge-tree --write-tree --merge-base="$p" "$cur" "$c" 2>/dev/null) || { printf "N\t%s does not apply where it leaves the target\n" "$c"; exit 0; }',
    '  cur=$(printf "%s\n" "$out" | head -n 1)',
    "done",
    '[ "$cur" != "$base" ] || { echo "N\tthe plan changes nothing there"; exit 0; }',
    'out=$(git -C "$d" merge-tree --write-tree --merge-base="$base" "$b" "$cur" 2>/dev/null) || { echo "N\tsome plan changes are not there"; exit 0; }',
    '[ "$(printf "%s\n" "$out" | head -n 1)" = "$(git -C "$d" rev-parse "$b^{tree}")" ] && printf "Y\t%s\n" "$b" || echo "N\tsome plan changes are not there"',
  ].join("\n");
}

/**
 * A part's worktree as it is now: `W branch sha` when it is a worktree on
 * a branch, `U branch` on a branch with no commit (gone), `D` on no
 * branch, `M` when there is no worktree at its path; then `S sha` when
 * the branch it was recorded on still exists. Only read.
 */
export function partCheckoutScript(
  path: string,
  clone: string,
  branch: string,
) {
  return [
    `d=${shQuote(path)}`,
    'if [ -d "$d" ] && p=$(cd "$d" 2>/dev/null && pwd -P) && [ "$p" = "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" ]; then',
    '  if r=$(git -C "$d" symbolic-ref -q HEAD); then',
    '    if s=$(git -C "$d" rev-parse -q --verify "$r^{commit}" 2>/dev/null); then printf "W\t%s\t%s\n" "${r#refs/heads/}" "$s"; else printf "U\t%s\n" "${r#refs/heads/}"; fi',
    "  else echo D; fi",
    "else echo M; fi",
    `s=$(git -C ${shQuote(clone)} rev-parse -q --verify ${shQuote(`refs/heads/${branch}^{commit}`)} 2>/dev/null) && printf "S\t%s\n" "$s"`,
    "exit 0",
  ].join("\n");
}

export function parsePartCheckout(stdout: string): {
  branch?: string;
  sha?: string;
  state: "ok" | "unborn" | "detached" | "missing";
  unborn?: string;
  /** The branch it was recorded on exists still. */
  stored: boolean;
} {
  let out: ReturnType<typeof parsePartCheckout> = {
    state: "missing",
    stored: false,
  };
  let stored = false;
  for (const line of stdout.split("\n")) {
    const [kind, value = "", sha = ""] = line.split("\t");
    if (kind === "W" && value && /^[0-9a-f]{40,64}$/.test(sha))
      out = { branch: value, sha, state: "ok", stored: false };
    else if (kind === "U" && value)
      out = { state: "unborn", unborn: value, stored: false };
    else if (kind === "D") out = { state: "detached", stored: false };
    else if (kind === "S" && value) stored = true;
  }
  return { ...out, stored };
}

/**
 * A local branch of the clone: `S sha` when it exists, then `W path` for
 * the worktree it is checked out in, if any. Only read.
 */
export function branchWorktreesScript(clone: string, branch: string) {
  return [
    `c=${shQuote(clone)}`,
    `s=$(git -C "$c" rev-parse -q --verify ${shQuote(`refs/heads/${branch}^{commit}`)} 2>/dev/null) || exit 0`,
    'printf "S\t%s\n" "$s"',
    `git -C "$c" worktree list --porcelain | awk -v want=${shQuote(`branch refs/heads/${branch}`)} '/^worktree /{p=substr($0,10)} $0==want{print "W\t" p}'`,
  ].join("\n");
}

export function parseBranchWorktrees(stdout: string): {
  sha?: string;
  worktree?: string;
} {
  let sha: string | undefined;
  let worktree: string | undefined;
  for (const line of stdout.split("\n")) {
    const [kind, ...rest] = line.split("\t");
    const value = rest.join("\t");
    if (kind === "S" && /^[0-9a-f]{40,64}$/.test(value)) sha = value;
    else if (kind === "W" && value && !worktree) worktree = value;
  }
  return { ...(sha ? { sha } : {}), ...(worktree ? { worktree } : {}) };
}

/**
 * What a part's branch holds, read in the clone: `H sha` (its tip), `A
 * sha` when it holds the tip of base (the part it stacks on), `N count`
 * and an `I patch-id` line per commit with a diff over the target, `K
 * subject` per fixup!, squash! or amend! commit over its base (or the
 * target), `U ref` per upstream/* branch at its tip. Only read.
 */
export function partContentScript(
  clone: string,
  branch: string,
  targets: string[],
  base?: string,
) {
  return [
    `d=${shQuote(clone)}`,
    `b=$(git -C "$d" rev-parse -q --verify ${shQuote(`refs/heads/${branch}^{commit}`)} 2>/dev/null) || exit 0`,
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[0]!)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[1] ?? targets[0]!)} 2>/dev/null) || exit 0`,
    'printf "H\t%s\n" "$b"',
    "start=$t",
    ...(base
      ? [
          `if r=$(git -C "$d" rev-parse -q --verify ${shQuote(`${base}^{commit}`)} 2>/dev/null) && [ "$(git -C "$d" merge-base "$r" "$b")" = "$r" ]; then printf "A\t%s\n" "$r"; start=$r; fi`,
        ]
      : []),
    'printf "N\t%s\n" "$(git -C "$d" rev-list --count "$t..$b")"',
    'git -C "$d" log --no-merges -p --format="commit %H" "$t..$b" | git -C "$d" patch-id --stable | awk \'{ print "I\t" $1 }\'',
    `git -C "$d" log --reverse --no-merges --format=%s "$start..$b" | grep -E ${shQuote(FIXUP_SUBJECT)} | sed "s/^/K\t/"`,
    'git -C "$d" for-each-ref --points-at "$b" --format="U\t%(refname)" refs/heads/upstream/',
    "exit 0",
  ].join("\n");
}

export function parsePartContent(stdout: string): {
  sha?: string;
  onBase?: string;
  onBranch: { count: number; ids: string[] };
  fixups: string[];
  upstream: string[];
} {
  let sha: string | undefined;
  let onBase: string | undefined;
  const onBranch = { count: 0, ids: [] as string[] };
  const fixups: string[] = [];
  const upstream: string[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, ...rest] = line.split("\t");
    const value = rest.join("\t");
    if (kind === "H" && /^[0-9a-f]{40,64}$/.test(value)) sha = value;
    else if (kind === "A" && /^[0-9a-f]{40,64}$/.test(value)) onBase = value;
    else if (kind === "N") onBranch.count = Number(value) || 0;
    else if (kind === "I" && value) onBranch.ids.push(value);
    else if (kind === "K" && value) fixups.push(value);
    else if (kind === "U" && value.startsWith("refs/heads/"))
      upstream.push(value.slice("refs/heads/".length));
  }
  return {
    ...(sha ? { sha } : {}),
    ...(onBase ? { onBase } : {}),
    onBranch,
    fixups,
    upstream,
  };
}

/**
 * Whether a local branch is a port of a plan sitting on the part's base:
 * `M` when there is no such branch; `N reason` when it is not; else
 * `O label ref sha` for what it is built on (one of ons, each when its
 * tip is where the branch leaves it, or the target, an older commit of
 * it as well), none of its own commits on the source, then `B file` for
 * each file it changes over there. Only read: no ref, index or worktree
 * touched.
 */
export function preparedScript(
  dir: string,
  branch: string,
  ons: { label: string; ref: string }[],
  targets: string[],
  source: string,
) {
  return [
    `d=${shQuote(dir)}`,
    `b=$(git -C "$d" rev-parse -q --verify ${shQuote(`refs/heads/${branch}^{commit}`)} 2>/dev/null) || { echo M; exit 0; }`,
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[0]!)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[1] ?? targets[0]!)} 2>/dev/null) || { echo "N\tthe target is unknown"; exit 0; }`,
    `src=$(git -C "$d" rev-parse -q --verify ${shQuote(`${source}^{commit}`)} 2>/dev/null)`,
    '[ "$(git -C "$d" rev-list --count "$t..$b")" -gt 0 ] || { echo "N\tnothing over the target"; exit 0; }',
    'own() { [ -z "$src" ] || [ "$(git -C "$d" rev-list --count "$1..$b" "^$src")" = "$(git -C "$d" rev-list --count "$1..$b")" ]; }',
    'on() { printf "O\t%s\t%s\t%s\n" "$1" "$2" "$b"; git -C "$d" diff --name-only "$3" "$b" | sed "s/^/B\t/"; exit 0; }',
    ...ons.map(
      ({ label, ref }) =>
        `r=$(git -C "$d" rev-parse -q --verify ${shQuote(`${ref}^{commit}`)} 2>/dev/null) && [ "$r" != "$b" ] && [ "$(git -C "$d" merge-base "$r" "$b")" = "$r" ] && own "$r" && on ${shQuote(label)} ${shQuote(ref)} "$r"`,
    ),
    'm=$(git -C "$d" merge-base "$t" "$b") || { echo "N\tno common history with the target"; exit 0; }',
    `own "$t" && on target ${shQuote(targets[0]!)} "$m"`,
    'echo "N\tsome of its commits are on the source"',
  ].join("\n");
}

export function parsePrepared(stdout: string): {
  sha?: string;
  on?: { label: string; ref: string };
  files: string[];
  missing?: true;
  not?: string;
} {
  const files: string[] = [];
  let found: { sha: string; on: { label: string; ref: string } } | undefined;
  for (const line of stdout.split("\n")) {
    const [kind, value = "", ...rest] = line.split("\t");
    if (kind === "M") return { missing: true, files };
    if (kind === "N") return { not: value, files };
    if (kind === "O" && /^[0-9a-f]{40,64}$/.test(rest[1] ?? ""))
      found = { sha: rest[1]!, on: { label: value, ref: rest[0]! } };
    else if (kind === "B" && value && found)
      files.push([value, ...rest].join("\t"));
  }
  return found ? { ...found, files } : { not: "it could not be read", files };
}

/** A port against the plan: the files only one of them changes, in short. */
export function portedDifference(planFiles: string[], branchFiles: string[]) {
  const inPlan = new Set(planFiles);
  const inBranch = new Set(branchFiles);
  const onlyInPlan = [...inPlan].filter((file) => !inBranch.has(file)).sort();
  const onlyInBranch = [...inBranch].filter((file) => !inPlan.has(file)).sort();
  const some = (files: string[]) =>
    `${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`;
  const parts = [
    ...(onlyInPlan.length ? [`only in the plan: ${some(onlyInPlan)}`] : []),
    ...(onlyInBranch.length
      ? [`only in the branch: ${some(onlyInBranch)}`]
      : []),
  ];
  return {
    onlyInPlan: onlyInPlan.slice(0, 50),
    onlyInBranch: onlyInBranch.slice(0, 50),
    summary: parts.length
      ? parts.join("; ")
      : "the same files, their content its own",
  };
}

export function parseCarries(stdout: string): {
  sha?: string;
  missing?: true;
  not?: string;
} {
  for (const line of stdout.split("\n")) {
    const [kind, value = ""] = line.split("\t");
    if (kind === "M") return { missing: true };
    if (kind === "Y" && /^[0-9a-f]{40,64}$/.test(value)) return { sha: value };
    if (kind === "N") return { not: value };
  }
  return { not: "it could not be read" };
}

/**
 * For each part worktree: `X path sha` with `U path file` lines while a
 * pick is stopped there (`R path sha subject` while folding its fixups
 * is), `D path` when none is. A missing worktree says
 * nothing (its stop is kept as it was).
 */
export function partStopsScript(paths: string[]) {
  return [
    `for d in ${paths.map(shQuote).join(" ")}; do`,
    '  [ -d "$d" ] || continue',
    '  if c=$(git -C "$d" rev-parse -q --verify CHERRY_PICK_HEAD 2>/dev/null); then',
    '    printf "X\t%s\t%s\n" "$d" "$c"',
    '    git -C "$d" diff --name-only --diff-filter=U | while IFS= read -r f; do printf "U\t%s\t%s\n" "$d" "$f"; done',
    '  elif c=$(git -C "$d" rev-parse -q --verify REBASE_HEAD 2>/dev/null); then',
    '    printf "R\t%s\t%s\t%s\n" "$d" "$c" "$(git -C "$d" log -1 --format=%s "$c")"',
    '    git -C "$d" diff --name-only --diff-filter=U | while IFS= read -r f; do printf "U\t%s\t%s\n" "$d" "$f"; done',
    '  elif git -C "$d" rev-parse -q --verify HEAD >/dev/null 2>&1; then printf "D\t%s\n" "$d"; fi',
    "done",
  ].join("\n");
}

/** A part's path: its stop now, or null when the pick is no longer stopped. */
export function parsePartStops(stdout: string) {
  const out = new Map<
    string,
    { sha: string; files: string[]; subject?: string; folding?: true } | null
  >();
  for (const line of stdout.split("\n")) {
    const [kind, path = "", value = "", ...rest] = line.split("\t");
    if (kind === "D" && path) out.set(path, null);
    else if (kind === "X" && path && value)
      out.set(path, { sha: value, files: [] });
    else if (kind === "R" && path && value)
      out.set(path, {
        sha: value,
        files: [],
        subject: rest.join("\t"),
        folding: true,
      });
    else if (kind === "U" && value) out.get(path)?.files.push(value);
  }
  return out;
}

export function parsePick(stdout: string): {
  picked: number;
  conflict?: string;
  files: string[];
  skipped: string[];
  error?: string;
  /** Read back: commits over the target and their patch ids (with a diff). */
  onBranch?: { count: number; ids: string[] };
  /** The fixups folded: the commits left, the same tree, those left as commits. */
  fold?: { count: number; sameTree: boolean; unfolded: string[] };
  /** Folding the fixups stopped here: the part's commit and its subject. */
  folding?: { sha: string; subject: string };
} {
  let picked = 0;
  let onBranch: { count: number; ids: string[] } | undefined;
  let fold:
    | { count: number; sameTree: boolean; unfolded: string[] }
    | undefined;
  let folding: { sha: string; subject: string } | undefined;
  let sameTree = false;
  const unfolded: string[] = [];
  const skipped: string[] = [];
  let conflict: string | undefined;
  let error: string | undefined;
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, value = "", ...rest] = line.split("\t");
    if (kind === "P") picked = Number(value) || 0;
    else if (kind === "X") conflict = value;
    else if (kind === "U" && value) files.push(value);
    else if (kind === "S" && value) skipped.push(value);
    else if (kind === "E") error = value;
    else if (kind === "N") onBranch = { count: Number(value) || 0, ids: [] };
    else if (kind === "I" && value && onBranch) onBranch.ids.push(value);
    else if (kind === "T") sameTree = value === "same";
    else if (kind === "F")
      fold = { count: Number(value) || 0, sameTree, unfolded };
    else if (kind === "K" && value) unfolded.push([value, ...rest].join("\t"));
    else if (kind === "R" && value)
      folding = { sha: value, subject: rest.join("\t") };
  }
  return {
    picked,
    files,
    skipped,
    ...(conflict ? { conflict } : {}),
    ...(error ? { error } : {}),
    ...(onBranch ? { onBranch } : {}),
    ...(fold ? { fold } : {}),
    ...(folding ? { folding } : {}),
  };
}

/**
 * How many of a part's commits its branch really holds over the target:
 * those with a diff by patch id, the empty ones (no patch id) by the
 * commits left over. Never more than were asked for.
 */
export function pickedOnBranch(
  commits: { patchId: string }[],
  onBranch: { count: number; ids: string[] },
) {
  const ids = new Set(onBranch.ids);
  const withDiff = commits.filter(
    (commit) => !commit.patchId.startsWith("sha:"),
  );
  const found = withDiff.filter((commit) => ids.has(commit.patchId)).length;
  const empty = commits.length - withDiff.length;
  const spare = Math.max(0, onBranch.count - onBranch.ids.length);
  return found + Math.min(empty, spare);
}
