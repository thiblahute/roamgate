import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { forgeRefLabel } from "../../../shared/forge";
import type {
  MrEffort,
  MrEffortSummary,
  MrItem,
  MrOverlap,
  MrReviewsPush,
  MrReviewsSettings,
} from "../../../shared/mrReviews";
import { onGitlabHost, remoteProject } from "../review/gitlab";
import { claudeCommand } from "./claude";
import { type MrConnection, shQuote } from "./clones";
import {
  createLedgerStore,
  type DerivedFile,
  deriveEffort,
  effortSummary,
  isAuthoredDisposition,
  type LedgerStore,
  overlapOf,
  setDispositions,
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
      for (const effort of (await options.settings()).efforts)
        await refreshOne(effort, force);
    },
    /** The cards, from what is on disk (no git). */
    summaries(settings: MrReviewsSettings): MrEffortSummary[] {
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
      const group = String(params.group ?? existing?.group ?? "");
      if (!current.upstreamGroups.includes(group) && !existing)
        throw new MrReviewsError(
          "an effort is declared on a group headed upstream",
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
      const workspaceId =
        ("workspaceId" in head && head.workspaceId) ||
        deps.upstream.members().find((each) => each.path === head.path)
          ?.workspaceId;
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
