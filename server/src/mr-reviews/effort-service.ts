import type { ReviewSnapshot } from "../../../shared/review";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { forgeRefLabel } from "../../../shared/forge";
import {
  type MrEffort,
  type MrEffortSummary,
  type MrItem,
  type MrOverlap,
  type MrReviewsPush,
  type MrReviewsSettings,
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
        ids: new Set(
          branch.commits.flatMap((commit) =>
            commit.patchId ? [commit.patchId] : [],
          ),
        ),
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
    groupLabel: (group: string) => Promise<string | null>;
    /**
     * Makes a worktree workspace through the user's worktree path (the
     * `worktree_command` setting, else Herdr's), from a source workspace.
     */
    createWorktree?: (input: {
      connectionId: string;
      workspaceId: string;
      branch: string;
    }) => Promise<{ path: string; workspaceId?: string }>;
    /** Puts a workspace into a Workspaces-tree group. */
    place?: (input: {
      connectionId: string;
      path: string;
      workspaceId?: string;
      group: string;
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
      // Its ledger stays on disk: declaring it again (or Undo) finds it.
      return { ok: true, version: saved.orderVersion ?? 0 };
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
      const ledger = service.store.ledger(effort.id);
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
      // with the plan's commits picked in source order (no -x). A conflict
      // stops there and is reported; nothing is aborted.
      const effort = await effortOf();
      const ledger = service.store.ledger(effort.id);
      const plan = findPlan(ledger.plans, String(params.plan ?? ""));
      if (!plan)
        throw new MrReviewsError("no such planned request", "not_found");
      if (plan.state !== "accepted")
        throw new MrReviewsError(`accept ${plan.name} first`);
      if (plan.part)
        throw new MrReviewsError(
          `${plan.name} has its part already: ${plan.part.path}`,
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
      const branch =
        (typeof params.branch === "string" && params.branch.trim()) ||
        plan.name
          .toLowerCase()
          .replace(/[^a-z0-9._/-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60);
      if (!/^[A-Za-z0-9][\w./-]*$/.test(branch) || branch.includes(".."))
        throw new MrReviewsError(`"${branch}" is not a branch name`);
      const connection = service.connectionOf(effort.clone.connectionId);
      if (!connection)
        throw new MrReviewsError("that connection is not ready", "unavailable");
      const from = await workspaceAt(
        effort.clone.connectionId,
        [
          effort.head?.connectionId === effort.clone.connectionId
            ? effort.head.path
            : undefined,
          effort.clone.path,
        ],
        effort.head?.connectionId === effort.clone.connectionId
          ? effort.head.workspaceId
          : undefined,
      );
      if (!from)
        throw new MrReviewsError(
          "open a workspace of the effort's clone (or its head) first",
          "not_found",
        );
      if (!deps.createWorktree)
        throw new MrReviewsError(
          "worktrees cannot be made here",
          "unavailable",
        );
      const made = await deps.createWorktree({
        connectionId: effort.clone.connectionId,
        workspaceId: from,
        branch,
      });
      const pick = parsePick(
        (
          await connection.run(
            pickScript(
              made.path,
              [
                upstreamRef(effort),
                `refs/remotes/${effort.target.remote}/${effort.target.branch}`,
              ],
              picked.map((commit) => commit.sha),
            ),
            300_000,
          )
        ).stdout,
      );
      const conflict = pick.conflict
        ? {
            sha: pick.conflict,
            subject:
              picked.find((commit) => commit.sha === pick.conflict)?.subject ??
              "",
            files: pick.files,
          }
        : undefined;
      const part = {
        connectionId: effort.clone.connectionId,
        path: made.path,
        branch,
        ...(made.workspaceId ? { workspaceId: made.workspaceId } : {}),
        ...(conflict ? { conflict } : {}),
      };
      await changePlans(
        service.store,
        effort,
        { action: "part", plan: plan.id, part },
        {
          by: meta.by,
          summary: `Part ${branch} made for ${plan.name}`,
        },
      );
      await deps
        .place?.({
          connectionId: effort.clone.connectionId,
          path: made.path,
          ...(made.workspaceId ? { workspaceId: made.workspaceId } : {}),
          group: effort.group,
        })
        .catch(() => {});
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
        ok: !conflict,
        path: made.path,
        branch,
        picked: pick.picked,
        of: picked.length,
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
        ...(pick.error ? { error: pick.error } : {}),
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
        const agent = await connection
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
 * In a fresh part worktree: moved onto the target when it is elsewhere
 * (only while clean), then the commits picked in order. Prints `P n`
 * (picked), `S sha` for one already in the target (empty, skipped), and
 * on a stop `X sha` with `U file` lines; never aborts.
 */
export function pickScript(dir: string, targets: string[], shas: string[]) {
  return [
    `d=${shQuote(dir)}`,
    '[ -d "$d" ] || { echo "E\tno such worktree"; exit 0; }',
    `t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[0]!)} 2>/dev/null) || t=$(git -C "$d" rev-parse -q --verify ${shQuote(targets[1] ?? targets[0]!)} 2>/dev/null)`,
    'if [ -n "$t" ] && [ "$(git -C "$d" rev-parse HEAD)" != "$t" ] && [ -z "$(git -C "$d" status --porcelain)" ]; then git -C "$d" reset -q --keep "$t" || { echo "E\tcannot move the part onto the target"; exit 0; }; fi',
    "n=0",
    `for c in ${shas.map(shQuote).join(" ")}; do`,
    '  if git -C "$d" -c core.editor=true cherry-pick --allow-empty "$c" >/dev/null 2>&1; then n=$((n+1)); else',
    // Already in the target (picked empty): skipped and said, not a stop.
    '    if [ -z "$(git -C "$d" diff --name-only --diff-filter=U)" ] && [ -z "$(git -C "$d" status --porcelain)" ] && git -C "$d" rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null; then git -C "$d" cherry-pick --skip >/dev/null 2>&1 && { printf "S\t%s\n" "$c"; continue; }; fi',
    '    printf "P\t%s\nX\t%s\n" "$n" "$c"',
    '    git -C "$d" diff --name-only --diff-filter=U | sed "s/^/U\t/"',
    "    exit 0",
    "  fi",
    "done",
    'printf "P\t%s\n" "$n"',
  ].join("\n");
}

export function parsePick(stdout: string): {
  picked: number;
  conflict?: string;
  files: string[];
  skipped: string[];
  error?: string;
} {
  let picked = 0;
  const skipped: string[] = [];
  let conflict: string | undefined;
  let error: string | undefined;
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const [kind, value = ""] = line.split("\t");
    if (kind === "P") picked = Number(value) || 0;
    else if (kind === "X") conflict = value;
    else if (kind === "U" && value) files.push(value);
    else if (kind === "S" && value) skipped.push(value);
    else if (kind === "E") error = value;
  }
  return {
    picked,
    files,
    skipped,
    ...(conflict ? { conflict } : {}),
    ...(error ? { error } : {}),
  };
}
