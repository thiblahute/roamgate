import { forgeRefLabel } from "../../../shared/forge";
import type { MrItem, MrReviewsSettings } from "../../../shared/mrReviews";
import { mrProjectKey } from "../../../shared/mrReviews";
import type { ReviewSnapshot } from "../../../shared/review";
import { type Logger, serverLogger } from "../utils/logger";
import {
  type CloneFinder,
  type FoundClone,
  type MrConnection,
  shQuote,
} from "./clones";
import type { MrInboxService } from "./inbox";
import { MrReviewsError } from "./rpc";
import type { MrProjectRecord, MrStore } from "./store";
import {
  type CheckoutResult,
  type FetchWant,
  type LocalChanges,
  checkoutScript,
  ensureWorktreeScript,
  fetchScript,
  parseCheckout,
  parseFetch,
  parseStatus,
  projectUrl,
  reviewWorktreePath,
  statusScript,
} from "./worktree";

/**
 * Opening a request for review: its project's clone (found, or asked for),
 * the project's review worktree and its "Reviews · project" workspace,
 * the request's review in the review pane (it diffs the request's commits
 * from the shared objects, whatever is checked out), and the checkout of
 * its head, detached, when the setting says so. Local changes in the
 * worktree are never lost: the user picks keeping them on a branch or
 * dropping them.
 */

export type MrOpenResult =
  | {
      needClone: {
        host: string;
        project: string;
        connections: { id: string; label: string }[];
      };
    }
  | {
      connectionId: string;
      workspaceId: string;
      sessionId: string;
      snapshot: ReviewSnapshot;
      worktree: string;
      checkout: MrCheckoutState;
    };

export type MrCheckoutState =
  | { state: "done"; head: string; kept?: string; discarded?: boolean }
  | { state: "deferred" }
  | { state: "dirty"; changes: string[] }
  | { state: "missing" }
  | { state: "error"; message: string };

export type MrOpenerDeps = {
  inbox: MrInboxService;
  store: MrStore;
  settings: () => Promise<MrReviewsSettings>;
  /** Remembers the clone the user picked (settings `clones`). */
  saveClone: (
    key: string,
    clone: { connectionId: string; path: string },
  ) => Promise<void>;
  /** The ready connections, the default one first. */
  connections: () => MrConnection[];
  /** The default connection, ready or not (none: no default). */
  defaultConnection?: () => {
    id: string;
    label: string;
    ready: boolean;
  } | null;
  clones: CloneFinder;
  /** Puts a new review workspace in its place in the Workspaces tree. */
  placeWorkspace?: (params: {
    projectKey: string;
    connectionId: string;
    workspaceId: string;
    label: string;
    worktree: string;
    clone: string;
  }) => Promise<void>;
  /** The review pane's open (review service), never raising it elsewhere. */
  openReview: (params: {
    connectionId: string;
    workspaceId: string;
    root: string;
    url: string;
    title: string;
  }) => ReviewSnapshot;
  logger?: Logger;
};

export function workspaceLabel(project: string): string {
  return `Reviews · ${project.split("/").pop() ?? project}`;
}

export function createMrOpener(deps: MrOpenerDeps) {
  const logger = deps.logger ?? serverLogger.child("mr-reviews");
  /** One worktree operation at a time per project. */
  const locks = new Map<string, Promise<unknown>>();
  function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve();
    const next = before.catch(() => {}).then(work);
    locks.set(key, next);
    const clear = () => {
      if (locks.get(key) === next) locks.delete(key);
    };
    // The caller gets the failure; the lock only lets go.
    next.then(clear, clear);
    return next;
  }

  function connection(id: string): MrConnection {
    const found = deps.connections().find((entry) => entry.id === id);
    if (!found)
      throw new MrReviewsError(
        `the connection ${id} is not ready`,
        "unavailable",
      );
    return found;
  }

  function item(key: string): MrItem {
    const found = deps.inbox.item(key);
    if (!found)
      throw new MrReviewsError("no such request in the inbox", "not_found");
    return found;
  }

  /** The project's clone: the record's, the picked one, or one found. */
  async function cloneOf(entry: MrItem): Promise<FoundClone | null> {
    const key = mrProjectKey(entry);
    const record = deps.store.get().projects[key];
    if (record && deps.connections().some((c) => c.id === record.connectionId))
      return {
        connectionId: record.connectionId,
        path: record.clone,
        remote: record.remote ?? "",
      };
    const picked = (await deps.settings()).clones[key];
    if (
      picked &&
      deps.connections().some((c) => c.id === picked.connectionId)
    ) {
      const checked = await deps.clones
        .check(connection(picked.connectionId), picked.path, entry)
        .catch(() => null);
      return (
        checked ?? {
          connectionId: picked.connectionId,
          path: picked.path,
          remote: "",
        }
      );
    }
    // A new project goes to the default connection's clone first: with
    // that connection down, nothing is decided elsewhere meanwhile.
    const preferred = deps.defaultConnection?.();
    if (preferred && !preferred.ready)
      throw new MrReviewsError(
        `${preferred.label}, the default connection, is not connected: ${entry.project}'s review goes there once it is (or pick a clone in Reviews' settings)`,
        "unavailable",
      );
    const found = await deps.clones.find(deps.connections(), entry);
    return found[0] ?? null;
  }

  /** The workspace workspaceFor just created, to place in the tree. */
  let placing: { workspaceId: string; label: string } | null = null;

  async function workspaceFor(
    conn: MrConnection,
    worktree: string,
    project: string,
    known?: string,
  ): Promise<string> {
    const listed = await conn.herdr("workspace.list", {});
    const workspaces: any[] = Array.isArray(listed?.workspaces)
      ? listed.workspaces
      : [];
    const existing =
      workspaces.find((w) => known && w?.workspace_id === known) ??
      workspaces.find(
        (w) => w?.cwd === worktree || w?.worktree?.checkout_path === worktree,
      );
    if (existing?.workspace_id) return String(existing.workspace_id);
    const created = await conn.herdr("workspace.create", {
      cwd: worktree,
      label: workspaceLabel(project),
      focus: false,
    });
    const id = created?.workspace?.workspace_id;
    if (typeof id !== "string" || !id)
      throw new MrReviewsError(
        "Herdr did not create the review workspace",
        "herdr",
      );
    placing = { workspaceId: id, label: workspaceLabel(project) };
    return id;
  }

  /** The project's review worktree and workspace, made when missing. */
  async function projectOf(entry: MrItem): Promise<{
    conn: MrConnection;
    record: MrProjectRecord;
  } | null> {
    const clone = await cloneOf(entry);
    if (!clone) return null;
    const conn = connection(clone.connectionId);
    const key = mrProjectKey(entry);
    const worktree = reviewWorktreePath(clone.path);
    const start = clone.remote
      ? `${clone.remote}/${entry.targetBranch}`
      : "HEAD";
    const made = await conn.run(
      ensureWorktreeScript(clone.path, worktree, start),
      120_000,
    );
    if (made.code !== 0)
      throw new MrReviewsError(
        `cannot make the review worktree: ${(made.stderr || made.stdout).trim().slice(-300)}`,
        "worktree",
      );
    const previous = deps.store.get().projects[key];
    const workspaceId = await workspaceFor(
      conn,
      worktree,
      entry.project,
      previous?.workspaceId,
    );
    // A new one goes where the project's reviews go in the tree; one
    // the user placed is never moved.
    const fresh = placing as { workspaceId: string; label: string } | null;
    placing = null;
    if (fresh?.workspaceId === workspaceId && deps.placeWorkspace)
      await deps
        .placeWorkspace({
          projectKey: key,
          connectionId: conn.id,
          workspaceId,
          label: fresh.label,
          worktree,
          clone: clone.path,
        })
        .catch((error) =>
          logger.info("review workspace not placed", {
            project: key,
            error: String(error),
          }),
        );
    const record: MrProjectRecord = {
      ...previous,
      connectionId: conn.id,
      clone: clone.path,
      worktree,
      workspaceId,
      ...(clone.remote ? { remote: clone.remote } : {}),
    };
    deps.store.update((state) => {
      state.projects[key] = record;
    });
    return { conn, record };
  }

  function sourceOf(entry: MrItem, record: MrProjectRecord): string {
    return record.remote || projectUrl(entry.host, entry.project);
  }

  function want(entry: MrItem): FetchWant {
    return {
      number: entry.number,
      headSha: entry.headSha,
      ...(entry.baseSha
        ? { baseSha: entry.baseSha, targetBranch: entry.targetBranch }
        : {}),
    };
  }

  async function fetchOne(
    conn: MrConnection,
    entry: MrItem,
    record: MrProjectRecord,
  ) {
    if (!entry.headSha) return;
    const result = await conn.run(
      fetchScript(record.clone, sourceOf(entry, record), entry.provider, [
        want(entry),
      ]),
      180_000,
    );
    const parsed = parseFetch(result.stdout);
    if (parsed.missing.includes(entry.number))
      logger.info("request head not fetched", {
        mr: entry.key,
        error: result.stderr.trim().slice(-200),
      });
  }

  async function checkout(
    conn: MrConnection,
    entry: MrItem,
    record: MrProjectRecord,
    local: LocalChanges,
  ): Promise<MrCheckoutState> {
    const key = mrProjectKey(entry);
    return locked(key, async () => {
      // Labelled by the request the worktree was on, when known.
      const current = record.checkedOut
        ? deps.inbox.item(record.checkedOut)
        : undefined;
      const label = current ? `${current.number}` : "wip";
      let result: CheckoutResult = parseCheckout(
        await conn.run(
          checkoutScript(record.worktree, entry.headSha, local, label),
          120_000,
        ),
      );
      if (result.state === "missing") {
        await fetchOne(conn, entry, record);
        result = parseCheckout(
          await conn.run(
            checkoutScript(record.worktree, entry.headSha, local, label),
            120_000,
          ),
        );
      }
      if (result.state === "dirty") {
        const status = parseStatus(
          (await conn.run(statusScript(record.worktree), 30_000)).stdout,
        );
        return { state: "dirty", changes: status.changes.slice(0, 50) };
      }
      if (result.state === "done")
        deps.store.update((state) => {
          const project = state.projects[key];
          if (project) project.checkedOut = entry.key;
        });
      return result;
    });
  }

  return {
    async open(
      key: string,
      options: { checkout?: "now" | "later" } = {},
    ): Promise<MrOpenResult> {
      const entry = item(key);
      if (!entry.headSha)
        throw new MrReviewsError(
          "the forge gave no head for this request",
          "invalid",
        );
      const project = await locked(mrProjectKey(entry), () => projectOf(entry));
      if (!project)
        return {
          needClone: {
            host: entry.host,
            project: entry.project,
            connections: deps
              .connections()
              .map((c) => ({ id: c.id, label: c.label })),
          },
        };
      const { conn, record } = project;
      // The review diffs the request's commits: they are fetched first
      // (a prefetched one is already there: no network).
      await fetchOne(conn, entry, record).catch((error) =>
        logger.info("request head not fetched", {
          mr: key,
          error: String(error),
        }),
      );
      const snapshot = deps.openReview({
        connectionId: conn.id,
        workspaceId: record.workspaceId!,
        root: record.worktree,
        url: entry.url,
        title: `${forgeRefLabel(entry)} ${entry.title}`.slice(0, 300),
      });
      deps.store.update((state) => {
        state.reviews[key] = {
          ...state.reviews[key],
          connectionId: conn.id,
          workspaceId: record.workspaceId,
          sessionId: snapshot.session.id,
        };
      });
      deps.inbox.markSeen(key);
      const settings = await deps.settings();
      const now =
        options.checkout === "now" ||
        (options.checkout !== "later" && settings.checkout === "immediately");
      const state: MrCheckoutState = now
        ? record.checkedOut === key
          ? { state: "done", head: entry.headSha }
          : await checkout(conn, entry, record, "refuse")
        : { state: "deferred" };
      return {
        connectionId: conn.id,
        workspaceId: record.workspaceId!,
        sessionId: snapshot.session.id,
        snapshot,
        worktree: record.worktree,
        checkout: state,
      };
    },

    /** The user's answer to local changes, or the on-demand checkout. */
    async checkout(key: string, local: LocalChanges): Promise<MrCheckoutState> {
      const entry = item(key);
      const record = deps.store.get().projects[mrProjectKey(entry)];
      if (!record)
        throw new MrReviewsError("open the request first", "invalid");
      return checkout(connection(record.connectionId), entry, record, local);
    },

    /** The clone the user picked for a project. */
    async setClone(params: {
      host: string;
      project: string;
      provider: "gitlab" | "github";
      connectionId: string;
      path: string;
    }) {
      const conn = connection(params.connectionId);
      const result = await conn.run(
        `cd ${shQuote(params.path)} 2>/dev/null && git rev-parse --show-toplevel`,
        30_000,
      );
      if (result.code !== 0)
        throw new MrReviewsError(
          `${params.path} is not a Git checkout there`,
          "invalid",
        );
      const found = await deps.clones.check(conn, params.path, params);
      await deps.saveClone(mrProjectKey(params), {
        connectionId: conn.id,
        path: found?.path ?? result.stdout.trim(),
      });
      deps.clones.forget(conn.id);
      return { ok: true, remote: found?.remote ?? null };
    },

    /**
     * Fetches the heads of the inbox's open requests whose project has a
     * review worktree, one fetch per project; nothing for the others.
     */
    async prefetch(items: MrItem[]) {
      // Only what the user is likely to open: their requests and the
      // suggestions picked (or asked for), and only a head not fetched yet.
      const known = deps.store.get();
      const wanted = new Set(
        known.feedback
          .filter((entry) => entry.verdict === "more_like_this")
          .map((entry) => entry.key),
      );
      const byProject = new Map<string, MrItem[]>();
      for (const entry of items)
        if (
          entry.state === "open" &&
          entry.headSha &&
          (entry.reasons.length > 0 ||
            known.ranked[entry.key]?.pick ||
            wanted.has(entry.key)) &&
          known.prefetched[entry.key] !== entry.headSha
        ) {
          const key = mrProjectKey(entry);
          byProject.set(key, [...(byProject.get(key) ?? []), entry]);
        }
      for (const [key, entries] of byProject) {
        const record = deps.store.get().projects[key];
        if (!record) continue;
        const conn = deps
          .connections()
          .find((c) => c.id === record.connectionId);
        if (!conn) continue;
        const first = entries[0]!;
        try {
          const result = await conn.run(
            fetchScript(
              record.clone,
              sourceOf(first, record),
              first.provider,
              entries.map(want),
            ),
            300_000,
          );
          const parsed = parseFetch(result.stdout);
          const done = new Set([...parsed.have, ...parsed.fetched]);
          deps.store.update((state) => {
            for (const entry of entries)
              if (done.has(entry.number))
                state.prefetched[entry.key] = entry.headSha;
          });
          if (parsed.fetched.length || parsed.missing.length)
            logger.info("request heads prefetched", {
              project: key,
              fetched: parsed.fetched.length,
              missing: parsed.missing.length,
            });
        } catch (error) {
          logger.info("prefetch failed", {
            project: key,
            error: String(error),
          });
        }
      }
    },
  };
}

export type MrOpener = ReturnType<typeof createMrOpener>;
