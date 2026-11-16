import type {
  MrPushKind,
  MrReviewsPush,
  MrReviewsSettings,
} from "../../../shared/mrReviews";
import {
  type GuiSettings,
  readGuiSettings,
  updateGuiSettings,
} from "../config/gui-settings";
import type { GlabContext } from "../review/gitlab";
import { serverLogger } from "../utils/logger";
import type { ReviewSnapshot } from "../../../shared/review";
import { createCloneFinder, type MrConnection } from "./clones";
import { createInboxFetchers, type InboxFetchers } from "./fetchers";
import { discoverForgeHosts, type ForgeHost } from "./hosts";
import { createMrInbox } from "./inbox";
import { createWorkspaceLinker } from "./links";
import { Value } from "typebox/value";
import { AssistantUserError } from "../assistant/errors";
import { createMrAgent, type MrAgent } from "./agent";
import {
  BOARD_DESCRIPTIONS,
  BOARD_WRITING,
  type BoardToolName,
  boardToolSchemas,
  createBoardTools,
} from "./board-tools";
import { createMrClaude } from "./claude";
import { createMrCuration, type RunModel } from "./curation";
import { createMrOpener } from "./open";
import { reviewPlacementOps } from "./tree";
import type {
  WorkspaceTree,
  WorkspaceTreeOp,
} from "../../../shared/workspaceTree";
import {
  handleMrReviewsRpc,
  MrReviewsError,
  type MrReviewsRpcDeps,
} from "./rpc";
import { type MrChangeMeta, createMrOrder } from "./order";
import { mrReviewsSettings, storedMrReviews } from "./settings";
import { FOUND_KEPT_DAYS, type MrStore, openMrStore } from "./store";

/**
 * The reviews module of the bridge: the inbox and its settings, wired to
 * settings.json and the user's glab and gh logins.
 */

const HOSTS_TTL_MS = 5 * 60_000;

/**
 * The fields the user authors in the inbox: a change of one bumps the
 * inbox version and is pushed to every page (with Undo for an agent's).
 */
const PUSHED_FIELDS: [keyof MrReviewsSettings, MrPushKind][] = [
  ["order", "order"],
  ["pinned", "pinned"],
  ["hidden", "hidden"],
  ["overrides", "overrides"],
  ["views", "views"],
];

export function createMrReviews(options: {
  run: GlabContext["runProcessWithCodeTimeout"];
  fetchers?: InboxFetchers;
  store?: MrStore;
  readSettings?: () => Promise<GuiSettings>;
  discoverHosts?: () => ForgeHost[];
  /** The ready connections, the default one first. */
  connections?: () => MrConnection[];
  /** The default connection, ready or not. */
  defaultConnection?: () => {
    id: string;
    label: string;
    ready: boolean;
  } | null;
  /** The review pane: opens a request's review in its workspace. */
  openReview?: (params: {
    connectionId: string;
    workspaceId: string;
    root: string;
    url: string;
    title: string;
  }) => ReviewSnapshot;
  /** The review pane's "review with the agent" for a request's review. */
  requestReview?: (params: {
    sessionId: string;
    paneId: string;
    focus?: string;
  }) => Promise<unknown>;
  /** The Workspaces tree (settings `workspace_tree`). */
  tree?: {
    read: () => Promise<WorkspaceTree>;
    apply: (ops: WorkspaceTreeOp[]) => Promise<unknown>;
  };
  /** The model runner (tests). */
  runModel?: RunModel;
  /** Drops a request's review (lifecycle). */
  removeReview?: (sessionId: string) => void;
  /** The reviews agent (tests: one on a fake driver). */
  agent?: (deps: Parameters<typeof createMrAgent>[0]) => MrAgent;
  more?: MrReviewsRpcDeps["more"];
  /** Tells every page the order, pins or removals changed. */
  publish?: (push: MrReviewsPush) => void;
}) {
  const logger = serverLogger.child("mr-reviews");
  const store = options.store ?? openMrStore();
  const readSettings = options.readSettings ?? readGuiSettings;
  const discover = options.discoverHosts ?? (() => discoverForgeHosts());
  let discovered: { at: number; hosts: ForgeHost[] } | null = null;

  /** The settings as saved: an empty hosts list means the logins'. */
  async function saved(): Promise<MrReviewsSettings> {
    return mrReviewsSettings((await readSettings()).mr_reviews);
  }

  /** The settings in effect: hosts from the logins when none are set. */
  async function settings(): Promise<MrReviewsSettings> {
    const value = await saved();
    if (value.hosts.length) return value;
    if (!discovered || Date.now() - discovered.at > HOSTS_TTL_MS)
      discovered = { at: Date.now(), hosts: discover() };
    return { ...value, hosts: discovered.hosts };
  }

  /**
   * Saves the settings. A change of the order, the pins or the removals
   * takes the next version (in the same write) and is pushed to every page.
   */
  async function saveSettings(
    next: MrReviewsSettings,
    meta: MrChangeMeta = { by: "user" },
  ): Promise<MrReviewsSettings> {
    let changed: MrReviewsPush["changed"] = [];
    let previous: MrReviewsSettings | null = null;
    const written = await updateGuiSettings((current) => {
      const before = mrReviewsSettings(current.mr_reviews);
      previous = before;
      const same = (a: unknown, b: unknown) =>
        JSON.stringify(a) === JSON.stringify(b);
      changed = PUSHED_FIELDS.filter(
        ([field]) => !same(before[field], next[field]),
      ).map(([, kind]) => kind);
      return {
        ...current,
        mr_reviews: storedMrReviews({
          ...next,
          orderVersion: (before.orderVersion ?? 0) + (changed.length ? 1 : 0),
        }),
      };
    });
    discovered = null;
    const saved = mrReviewsSettings(written.mr_reviews);
    if (changed.length) {
      // Undo needs what the change started from.
      if (previous) order.seed(previous);
      order.remember(saved);
      options.publish?.({
        version: saved.orderVersion ?? 0,
        order: saved.order,
        changed,
        by: meta.by,
        ...(meta.summary ? { summary: meta.summary } : {}),
        ...(meta.undoable ? { undo: saved.orderVersion ?? 0 } : {}),
      });
    }
    return saved;
  }

  const clones = createCloneFinder();
  const linker = createWorkspaceLinker({
    connections: options.connections ?? (() => []),
  });
  let opener: ReturnType<typeof createMrOpener> | null = null;
  const curation = createMrCuration({
    store,
    settings,
    connections: options.connections ?? (() => []),
    clones: async () => {
      const value = await settings();
      const found = [];
      for (const project of value.followed)
        found.push(
          ...(await clones.find(options.connections?.() ?? [], project)),
        );
      return found;
    },
    ...(options.runModel ? { run: options.runModel } : {}),
    users: () => inbox.users(),
    logger,
  });
  const fetchers = options.fetchers ?? createInboxFetchers(options.run);
  const inbox = createMrInbox({
    fetchers,
    settings,
    store,
    logger,
    afterRefresh: (items) => {
      void opener?.prefetch(items);
      void lifecycle();
      void curation.maybeRun(items);
    },
    curation: () => curation.state(),
  });
  const order = createMrOrder({ inbox, settings: saved, save: saveSettings });
  opener = createMrOpener({
    inbox,
    store,
    settings,
    connections: options.connections ?? (() => []),
    ...(options.defaultConnection
      ? { defaultConnection: options.defaultConnection }
      : {}),
    clones,
    logger,
    ...(options.tree
      ? {
          placeWorkspace: async (place: {
            projectKey: string;
            connectionId: string;
            workspaceId: string;
            label: string;
            worktree: string;
            clone: string;
          }) => {
            const tree = options.tree!;
            const path = (await settings()).treeGroups[place.projectKey];
            await tree.apply(
              reviewPlacementOps(await tree.read(), {
                ref: {
                  connection_id: place.connectionId,
                  path: place.worktree,
                  label: place.label,
                  workspace_id: place.workspaceId,
                },
                connectionId: place.connectionId,
                clonePath: place.clone,
                ...(path ? { path } : {}),
              }),
            );
          },
        }
      : {}),
    openReview: (params) => {
      if (!options.openReview)
        throw new MrReviewsError("reviews are not available", "unavailable");
      return options.openReview(params);
    },
    saveClone: async (key, clone) => {
      await updateGuiSettings((current) => {
        const value = mrReviewsSettings(current.mr_reviews);
        return {
          ...current,
          mr_reviews: storedMrReviews({
            ...value,
            clones: { ...value.clones, [key]: clone },
          }),
        };
      });
    },
  });

  const claude = createMrClaude({
    inbox,
    startMode: async () =>
      (await readSettings()).claude_start_mode === "conversation"
        ? "conversation"
        : "terminal",
    store,
    connections: options.connections ?? (() => []),
    requestReview: async (params) => {
      if (!options.requestReview)
        throw new MrReviewsError("reviews are not available", "unavailable");
      return options.requestReview(params);
    },
  });

  /**
   * A request merged or closed this many days ago loses its review state
   * here: its review, what was seen and picked. The project's review
   * worktree stays.
   */
  async function lifecycle() {
    // What the reviews agent found ages out once it is not touched.
    const foundCutoff = Date.now() - FOUND_KEPT_DAYS * 24 * 60 * 60_000;
    const stale = Object.entries(store.get().found).filter(
      ([, entry]) => Date.parse(entry.at) <= foundCutoff,
    );
    if (stale.length)
      store.update((state) => {
        for (const [key] of stale) delete state.found[key];
      });
    const days = (await settings()).retentionDays;
    const cutoff = Date.now() - days * 24 * 60 * 60_000;
    const gone = Object.entries(store.get().reviews).filter(
      ([, review]) => review.closedAt && Date.parse(review.closedAt) <= cutoff,
    );
    if (!gone.length) return;
    for (const [, review] of gone) {
      try {
        options.removeReview?.(review.sessionId);
      } catch {}
    }
    store.update((state) => {
      for (const [key] of gone) {
        delete state.reviews[key];
        delete state.seen[key];
        delete state.ranked[key];
        delete state.drafts[key];
      }
    });
    logger.info("closed requests' reviews dropped", { count: gone.length });
  }

  /** The reviews agent's chat, made on first use. */
  let agent: MrAgent | null = null;
  const reviewsAgent = (): MrAgent => {
    agent ??= (options.agent ?? createMrAgent)({
      fetchers,
      settings,
      inbox,
      store,
      signals: () => curation.signals(inbox.items()),
      order,
      rpc: (method, params) => rpc(method, params),
      saveHints: async (hints) => {
        await updateGuiSettings((current) => ({
          ...current,
          mr_reviews: storedMrReviews({
            ...mrReviewsSettings(current.mr_reviews),
            hints,
          }),
        }));
        discovered = null;
      },
      logger,
    });
    return agent;
  };

  const more = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const key = () => {
      // A request's review names it by its review session too.
      if (typeof params.session_id === "string" && !params.key) {
        const found = Object.entries(store.get().reviews).find(
          ([, review]) => review.sessionId === params.session_id,
        );
        if (!found)
          throw new MrReviewsError(
            "this review is not one of Reviews'",
            "not_found",
          );
        return found[0];
      }
      if (typeof params.key !== "string" || !params.key)
        throw new MrReviewsError("key is required");
      return params.key;
    };
    switch (method) {
      case "bridge.mr_reviews.agent.get":
        return reviewsAgent().snapshot();
      case "bridge.mr_reviews.agent.send": {
        if (typeof params.text !== "string" || !params.text.trim())
          throw new MrReviewsError("text is required");
        const requestId =
          typeof params.request_id === "string" &&
          /^[\w-]{1,80}$/.test(params.request_id)
            ? params.request_id
            : undefined;
        let sent: { queued: boolean };
        try {
          sent = reviewsAgent().send(params.text, {
            ...(requestId ? { requestId } : {}),
            ...(params.when_busy === "queue"
              ? { whenBusy: "queue" as const }
              : {}),
          });
        } catch (error) {
          throw new MrReviewsError(
            error instanceof Error ? error.message : String(error),
            "busy",
          );
        }
        return { ...sent, snapshot: reviewsAgent().snapshot() };
      }
      case "bridge.mr_reviews.agent.unqueue":
        return {
          removed:
            typeof params.id === "string" && reviewsAgent().unqueue(params.id),
        };
      case "bridge.mr_reviews.agent.stop":
        await reviewsAgent().stop();
        return reviewsAgent().snapshot();
      case "bridge.mr_reviews.agent.reset":
        await reviewsAgent().reset();
        return reviewsAgent().snapshot();
      case "bridge.mr_reviews.open": {
        const result = await opener!.open(key(), {
          ...(params.checkout === "now" || params.checkout === "later"
            ? { checkout: params.checkout }
            : {}),
        });
        if ("needClone" in result || result.checkout.state !== "done")
          return result;
        // After the checkout: the request's own Claude session, if it has
        // one; a busy Claude of another request is only reported.
        const state = await claude
          .ensure(key(), { start: false, wait: false })
          .catch((error) => ({
            state: "error" as const,
            message: error instanceof Error ? error.message : String(error),
          }));
        return { ...result, claude: state };
      }
      case "bridge.mr_reviews.workspaces": {
        // The review workspaces, for the sidebar: whose they are and the
        // request each is checked out on. No forge call.
        const state = store.get();
        return {
          workspaces: Object.entries(state.projects).flatMap(
            ([project, record]) => {
              if (!record.workspaceId) return [];
              const current = record.checkedOut
                ? state.items.find((item) => item.key === record.checkedOut)
                : undefined;
              return [
                {
                  connectionId: record.connectionId,
                  workspaceId: record.workspaceId,
                  project,
                  ...(current
                    ? {
                        current: {
                          key: current.key,
                          label: `${current.provider === "github" ? "#" : "!"}${current.number} ${current.title}`,
                          url: current.url,
                        },
                      }
                    : {}),
                },
              ];
            },
          ),
        };
      }
      case "bridge.mr_reviews.links": {
        // The workspaces that are each request's, on every connection: no
        // forge call. `keys` narrows it to those requests.
        const wanted = Array.isArray(params.keys)
          ? new Set(
              params.keys
                .filter((each): each is string => typeof each === "string")
                .slice(0, 200),
            )
          : null;
        const items = inbox
          .items()
          .filter((item) => !wanted || wanted.has(item.key));
        // Its review workspace: where its review is, or the project's
        // review worktree while it is checked out on it.
        const state = store.get();
        const reviews: Record<
          string,
          { connectionId: string; workspaceId?: string }
        > = { ...state.reviews };
        for (const record of Object.values(state.projects))
          if (record.workspaceId && record.checkedOut)
            reviews[record.checkedOut] ??= {
              connectionId: record.connectionId,
              workspaceId: record.workspaceId,
            };
        return { links: await linker.links(items, reviews) };
      }
      case "bridge.mr_reviews.forget_worktree": {
        // The project's next review makes its worktree anew (on the
        // default connection first). The old worktree and its workspace
        // stay where they are, for the user to remove; reviews, Claude
        // sessions and drafts (on the forge) are kept.
        const project =
          typeof params.project === "string"
            ? params.project.toLowerCase()
            : "";
        const record = store.get().projects[project];
        if (!record)
          throw new MrReviewsError(
            "no review worktree for that project",
            "not_found",
          );
        store.update((state) => {
          delete state.projects[project];
          for (const key of Object.keys(state.prefetched))
            if (key.toLowerCase().includes(`:${project}#`))
              delete state.prefetched[key];
        });
        logger.info("review worktree forgotten", {
          project,
          connection: record.connectionId,
          worktree: record.worktree,
        });
        return { forgotten: record };
      }
      case "bridge.mr_reviews.claude": {
        const action = params.action;
        if (action === "status") return claude.status(key());
        if (action === "switch")
          return claude.ensure(key(), { start: false, wait: true });
        if (action === "start")
          return claude.ensure(key(), {
            start: true,
            wait: params.wait === true,
          });
        if (action === "review")
          return claude.review(
            key(),
            typeof params.focus === "string"
              ? params.focus.slice(0, 500)
              : undefined,
          );
        throw new MrReviewsError(
          "action must be status, switch, start or review",
        );
      }
      case "bridge.mr_reviews.checkout": {
        const local = params.local ?? "refuse";
        if (local !== "refuse" && local !== "wip" && local !== "discard")
          throw new MrReviewsError("local must be refuse, wip or discard");
        return opener!.checkout(key(), local);
      }
      case "bridge.mr_reviews.clone": {
        const provider = params.provider;
        if (
          typeof params.host !== "string" ||
          typeof params.project !== "string" ||
          typeof params.connection_id !== "string" ||
          typeof params.path !== "string" ||
          !params.path.startsWith("/") ||
          (provider !== "gitlab" && provider !== "github")
        )
          throw new MrReviewsError(
            "host, project, provider, connection_id and an absolute path are required",
          );
        return opener!.setClone({
          host: params.host,
          project: params.project,
          provider,
          connectionId: params.connection_id,
          path: params.path,
        });
      }
      default:
        if (options.more) return options.more(method, params);
        throw new MrReviewsError(`unknown method: ${method}`, "unknown");
    }
  };

  const rpc = (method: string, params: Record<string, unknown>) =>
    handleMrReviewsRpc(
      {
        inbox,
        settings: async () => {
          // The settings page shows what is saved, and the hosts found.
          const value = await saved();
          return {
            ...value,
            discoveredHosts: value.hosts.length ? [] : (await settings()).hosts,
            reviewWorktrees: Object.entries(store.get().projects).map(
              ([project, record]) => ({
                project,
                connectionId: record.connectionId,
                path: record.worktree,
              }),
            ),
          };
        },
        saveSettings,
        order,
        more,
      },
      method,
      params,
    );

  /**
   * One of the board's tools for an agent session (the review socket's
   * `reviews` command): `caller` names it in what the user is told.
   */
  async function boardTool(
    tool: string,
    params: unknown,
    caller: string,
  ): Promise<string> {
    // What a generic caller (one MCP tool for all) needs to call them.
    if (tool === "help")
      return JSON.stringify({
        tools: Object.entries(boardToolSchemas).map(([name, schema]) => ({
          name,
          description: BOARD_DESCRIPTIONS[name as BoardToolName],
          writes: BOARD_WRITING.includes(name as BoardToolName),
          params: JSON.parse(JSON.stringify(schema)),
        })),
      });
    if (!Object.hasOwn(boardToolSchemas, tool))
      throw new MrReviewsError(
        `unknown tool ${tool.slice(0, 60)}: ${Object.keys(boardToolSchemas).join(", ")} (help: each one's parameters)`,
        "not_found",
      );
    const name = tool as BoardToolName;
    const schema = boardToolSchemas[name];
    if (!Value.Check(schema, params)) {
      const first = [...Value.Errors(schema, params)][0];
      throw new MrReviewsError(
        `invalid ${name} parameters${first ? `: ${first.instancePath || "/"} ${first.message}` : ""}`,
      );
    }
    try {
      return await createBoardTools(
        { settings, inbox, store, order, rpc: (method, p) => rpc(method, p) },
        caller,
      )[name](params);
    } catch (error) {
      if (error instanceof AssistantUserError)
        throw new MrReviewsError(error.message);
      throw error;
    }
  }

  return {
    inbox,
    store,
    settings,
    boardTool,
    opener,
    claude,
    curation,
    lifecycle,
    handle: rpc,
    order,
    agent: reviewsAgent,
    start: () => inbox.start(),
    stop: () => {
      inbox.stop();
      void agent?.dispose();
    },
  };
}

export type MrReviews = ReturnType<typeof createMrReviews>;
