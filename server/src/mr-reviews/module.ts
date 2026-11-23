import {
  type MrInboxEntry,
  type MrPushKind,
  type MrReviewsPush,
  type MrReviewsSettings,
  parseBranchKey,
  upstreamWorkspaceHome,
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
  branchEntry,
  partBases,
  createUpstreamScanner,
  requestOfBranch,
  type UpstreamMember,
} from "./upstream";
import { renameOverrideKeys } from "./overrides";
import { join } from "node:path";
import { dataRoot } from "../config/data-paths";
import { createEffortService, handleEffortRpc } from "./effort-service";
import { emptyWorkspaceTree } from "../../../shared/workspaceTree";
import {
  BOARD_DESCRIPTIONS,
  BOARD_WRITING,
  type BoardToolName,
  boardToolSchemas,
  createBoardTools,
} from "./board-tools";
import { createMrClaude } from "./claude";
import { createMrCuration, type RunModel } from "./curation";
import { createMrInference, defaultProfileInferenceModels } from "./inference";
import { createMrHomes } from "./home";
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
import { type MrChangeMeta, createMrOrder, editSettings } from "./order";
import {
  mrReviewsSettings,
  normalizeStoredMrReviews,
  storedMrReviews,
} from "./settings";
import {
  applyLedgers,
  exportReviews,
  importChanges,
  importedMrReviews,
  parseReviewsExport,
} from "../history/mr-reviews";
import { stableJson } from "../history/format";
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
  ["unsent", "unsent"],
  ["upstreamGroups", "upstream"],
  ["upstreamSkip", "upstream"],
  ["upstreamWorkspaces", "upstream"],
  ["efforts", "efforts"],
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
    /** The agent pane it goes to (a home's Claude). */
    paneId?: string;
  }) => ReviewSnapshot | Promise<ReviewSnapshot>;
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
    /** Called with the tree after each change. */
    onChanged?: (listener: (tree: WorkspaceTree) => void) => () => void;
  };
  /** The model runner (tests). */
  runModel?: RunModel;
  /**
   * The inference's models: the automatic one (the setting empty) and
   * the names the settings suggest. Default: from the default agent
   * profile (Sonnet on Claude itself, a gateway's own model).
   */
  inferenceModels?: {
    automatic: () => string;
    list: () => Promise<string[]>;
  };
  /** Drops a request's review (lifecycle); may answer once it did. */
  removeReview?: (sessionId: string) => unknown;
  /** The reviews agent (tests: one on a fake driver). */
  agent?: (deps: Parameters<typeof createMrAgent>[0]) => MrAgent;
  more?: MrReviewsRpcDeps["more"];
  /** Tells every page the order, pins or removals changed. */
  publish?: (push: MrReviewsPush) => void;
  /** Where efforts' ledgers live (tests); else <data>/mr-reviews/efforts. */
  effortsDir?: string;
  /**
   * A worktree workspace through the user's worktree path (efforts' parts),
   * from the repository's parent workspace or its main checkout's path.
   */
  createWorktree?: NonNullable<
    Parameters<typeof handleEffortRpc>[0]["createWorktree"]
  >;
  /**
   * A Roamgate review of a range (an effort's commit, `d`; two versions
   * of one compared tree to tree), with its snapshot for the page to show.
   */
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
  /** The review of an effort's view (`effort.threads`). */
  effortReview?: NonNullable<
    Parameters<typeof handleEffortRpc>[0]["effortReview"]
  >;
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
      changed = [
        ...new Set(
          PUSHED_FIELDS.filter(
            ([field]) => !same(before[field], next[field]),
          ).map(([, kind]) => kind),
        ),
      ];
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
  // Branches headed upstream, read from the marked groups' workspaces.
  const upstream = createUpstreamScanner({
    connections: options.connections ?? (() => []),
    tree: options.tree?.read ?? (async () => emptyWorkspaceTree()),
    settings,
    items: () => inbox.items(),
    // Read when the scan runs, after the efforts are made below.
    parts: (value) => effortParts(value),
  });
  function effortParts(value: MrReviewsSettings): UpstreamMember[] {
    try {
      return partMembers(value);
    } catch {
      // Not made yet, or a ledger not readable: only the marked ones.
      return [];
    }
  }
  function partMembers(value: MrReviewsSettings): UpstreamMember[] {
    return value.efforts.flatMap((effort) => {
      const plans = efforts.store.ledger(effort.id).plans;
      return plans.flatMap((plan) => {
        if (!plan.part) return [];
        const bases = partBases(plan, plans);
        return [
          {
            connectionId: plan.part.connectionId,
            workspaceId: plan.part.workspaceId ?? "",
            label: plan.part.branch,
            path: plan.part.path,
            group: effort.group,
            plan: plan.name,
            ...(bases.length ? { bases } : {}),
          },
        ];
      });
    });
  }
  function upstreamRows(value: MrReviewsSettings) {
    const items = inbox.items();
    const users = inbox.users();
    const ids = upstream.patchIds();
    const rows: MrInboxEntry[] = [];
    const covered = new Map<
      string,
      Pick<MrInboxEntry, "fromBranch" | "local" | "effort">
    >();
    for (const branch of upstream.branches()) {
      const request = requestOfBranch(branch, items, ids);
      if (request) {
        const effort = value.efforts.find(
          (each) => each.group === branch.member.group,
        );
        covered.set(request.key, {
          ...(effort ? { effort: effort.name } : {}),
          fromBranch: branch.branch,
          ...(branch.dirty || branch.unpushed
            ? {
                local: {
                  unpushed: branch.unpushed ?? 0,
                  dirty: branch.dirty,
                  workspace: branch.member.label,
                },
              }
            : {}),
        });
        continue;
      }
      const effort = value.efforts.find(
        (each) => each.group === branch.member.group,
      );
      // The effort's own source checkout is its card, not a row.
      if (
        effort &&
        branch.member.path === effort.clone.path &&
        effort.source.endsWith(`/${branch.branch}`)
      )
        continue;
      rows.push({
        ...branchEntry(
          branch,
          value,
          users.get(branch.host) ?? "",
          upstream.branches(),
        ),
        ...(effort ? { effort: effort.name } : {}),
      });
    }
    return { rows, covered };
  }
  const effortsRoot =
    options.effortsDir ?? join(dataRoot(), "mr-reviews", "efforts");
  const efforts = createEffortService({
    root: effortsRoot,
    settings: saved,
    connections: options.connections ?? (() => []),
    items: () => inbox.items(),
    upstream,
    ...(options.publish ? { publish: options.publish } : {}),
    current: async () => {
      const value = await saved();
      return { version: value.orderVersion ?? 0, order: value.order };
    },
  });
  // Whose move it is, inferred (section 7): twice a day and on meaningful events.
  const inferenceModels =
    options.inferenceModels ?? defaultProfileInferenceModels();
  const inference = createMrInference({
    store,
    settings,
    rows: async () => inbox.snapshot(await settings()).entries,
    users: () => inbox.users(),
    patchIds: () => upstream.patchIds(),
    ...(options.runModel ? { run: options.runModel } : {}),
    automaticModel: inferenceModels.automatic,
    logger,
    onChange: () => inbox.changed(),
  });
  const inbox = createMrInbox({
    fetchers,
    settings,
    store,
    logger,
    upstream: upstreamRows,
    efforts: (value) => efforts.summaries(value),
    onViewer: () => {
      void upstream.refresh().then(() => efforts.refresh());
    },
    afterRefresh: (items) => {
      void upstream
        .refresh()
        .then(() => rekeyBranches())
        .then(() => Promise.all([efforts.refresh(), inference.maybeRun()]));
      void opener?.prefetch(items);
      void lifecycle();
      void curation.maybeRun(items);
    },
    curation: () => curation.state(),
    inference: () => inference.state(),
    onMergeTime: () => void inference.maybeRun(),
  });
  const order = createMrOrder({ inbox, settings: saved, save: saveSettings });
  /**
   * A new review workspace (the project's, or a request's home) goes where
   * the project's reviews go in the Workspaces tree.
   */
  const placeReviewWorkspace = options.tree
    ? async (place: {
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
      }
    : undefined;
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
    ...(placeReviewWorkspace ? { placeWorkspace: placeReviewWorkspace } : {}),
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

  // Requests' homes: their review shown there, made with an agent (D27).
  const homes = createMrHomes({
    item: (key) => {
      const found = inbox.item(key);
      if (!found)
        throw new MrReviewsError("no such request in the inbox", "not_found");
      return found;
    },
    store,
    connections: options.connections ?? (() => []),
    settings: saved,
    project: (item) => opener!.project(item),
    ...(options.createWorktree
      ? { createWorktree: options.createWorktree }
      : {}),
    ...(placeReviewWorkspace ? { placeWorkspace: placeReviewWorkspace } : {}),
    openReview: (params) => {
      if (!options.openReview)
        throw new MrReviewsError("reviews are not available", "unavailable");
      return options.openReview(params);
    },
    markSeen: (key) => inbox.markSeen(key),
    startMode: async () =>
      (await readSettings()).claude_start_mode === "conversation"
        ? "conversation"
        : "terminal",
    logger,
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
        // The Rust core's review service answers later.
        void Promise.resolve(options.removeReview?.(review.sessionId)).catch(
          () => {},
        );
      } catch {}
    }
    store.update((state) => {
      for (const [key] of gone) {
        delete state.reviews[key];
        delete state.seen[key];
        delete state.ranked[key];
        delete state.drafts[key];
        if (state.homes) delete state.homes[key];
      }
    });
    logger.info("closed requests' reviews dropped", { count: gone.length });
  }

  /**
   * A branch headed upstream whose request opened takes the request's key
   * everywhere the user's state names it (order, what was set by hand,
   * dependencies), in one settings write; its "not proposed yet" goes
   * (D6).
   */
  async function rekeyBranches() {
    const items = inbox.items();
    await editSettings(async () => {
      const current = await saved();
      const named = new Set([
        ...current.order,
        ...current.unsent.map((each) => each.key),
        ...Object.keys(current.overrides),
        ...Object.values(current.overrides).flatMap(
          (each) => each.dependsOn ?? [],
        ),
      ]);
      const renames = new Map<string, string>();
      for (const key of named) {
        const branch = parseBranchKey(key);
        if (!branch) continue;
        const request = items.find(
          (item) =>
            item.reasons.includes("authored") &&
            item.state !== "closed" &&
            item.provider === branch.provider &&
            item.host.toLowerCase() === branch.host &&
            item.project.toLowerCase() === branch.project &&
            item.sourceBranch === branch.branch,
        );
        if (request) renames.set(key, request.key);
      }
      if (!renames.size) return;
      let overrides = current.overrides;
      for (const [from, to] of renames)
        overrides = renameOverrideKeys(overrides, from, to);
      const order: string[] = [];
      for (const key of current.order) {
        const next = renames.get(key) ?? key;
        if (!order.includes(next)) order.push(next);
      }
      await saveSettings({
        ...current,
        order,
        overrides,
        unsent: current.unsent.filter((each) => !renames.has(each.key)),
      });
      logger.info("branches took their requests' keys", {
        count: renames.size,
      });
    });
  }

  // A group deleted from the tree is no longer headed upstream (D5).
  const offTree = options.tree?.onChanged?.((tree) => {
    void editSettings(async () => {
      const current = await saved();
      const groups = new Set(
        tree.nodes.flatMap((node) => (node.kind === "group" ? [node.id] : [])),
      );
      const kept = current.upstreamGroups.filter((id) => groups.has(id));
      if (kept.length !== current.upstreamGroups.length)
        await saveSettings({ ...current, upstreamGroups: kept });
    }).then(() => upstream.refresh(true));
  });

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
    if (
      method.startsWith("bridge.mr_reviews.effort.") ||
      method.startsWith("bridge.mr_reviews.ledger.")
    ) {
      const answer = await handleEffortRpc(
        {
          service: efforts,
          settings: saved,
          edit: editSettings,
          save: saveSettings,
          upstream,
          entries: async () => inbox.snapshot(await settings()).entries,
          groupLabel: async (group) => {
            const node = (await options.tree?.read())?.nodes.find(
              (each) => each.id === group,
            );
            if (node?.kind === "group") return node.label;
            // A workspace headed upstream by itself: its name.
            const ref = (await saved()).upstreamWorkspaces.find(
              (each) => upstreamWorkspaceHome(each) === group,
            );
            return ref ? (ref.label ?? ref.path ?? null) : null;
          },
          ...(options.createWorktree
            ? { createWorktree: options.createWorktree }
            : {}),
          ...(options.openRange ? { openRange: options.openRange } : {}),
          ...(options.effortReview
            ? { effortReview: options.effortReview }
            : {}),
          ...(options.tree
            ? {
                place: async ({
                  connectionId,
                  path,
                  workspaceId,
                  group,
                  under,
                }) => {
                  await options.tree!.apply([
                    {
                      op: "move",
                      subject: {
                        workspace: {
                          connection_id: connectionId,
                          path,
                          ...(workspaceId ? { workspace_id: workspaceId } : {}),
                        },
                      },
                      parent: under
                        ? {
                            workspace: {
                              connection_id: under.connectionId,
                              path: under.path,
                              ...(under.workspaceId
                                ? { workspace_id: under.workspaceId }
                                : {}),
                            },
                          }
                        : { node: group },
                    },
                  ]);
                },
              }
            : {}),
        },
        method,
        params,
      );
      if (answer !== undefined) return answer;
    }
    switch (method) {
      case "bridge.mr_reviews.export": {
        // What the Reviews authored, as the CLI's `roamgate reviews export`.
        const value = exportReviews({
          stored: storedMrReviews(await saved()) as Record<string, unknown>,
          effortsRoot,
        });
        return { text: stableJson(value) };
      }
      case "bridge.mr_reviews.import": {
        // What an export would change; applied only when asked (never silent).
        if (typeof params.text !== "string" || params.text.length > 50_000_000)
          throw new MrReviewsError("text: an export's JSON");
        let incoming: ReturnType<typeof parseReviewsExport>;
        try {
          incoming = parseReviewsExport(params.text);
        } catch (error) {
          throw new MrReviewsError(
            error instanceof Error ? error.message : String(error),
          );
        }
        const local = exportReviews({
          stored: storedMrReviews(await saved()) as Record<string, unknown>,
          effortsRoot,
        });
        const changes = importChanges(local, incoming);
        if (params.apply !== true) return { applied: false, changes };
        await editSettings(async () => {
          const current = storedMrReviews(await saved()) as Record<
            string,
            unknown
          >;
          const next = normalizeStoredMrReviews(
            importedMrReviews(current, incoming),
          );
          return saveSettings(mrReviewsSettings(next), { by: "user" });
        });
        const ledgers = applyLedgers(incoming, effortsRoot);
        void efforts.refresh(true);
        inbox.changed();
        return { applied: true, changes, ledgers };
      }
      case "bridge.mr_reviews.inference_models": {
        // The settings' suggestions: the automatic model and the names to offer.
        const automatic = inferenceModels.automatic();
        const models = await inferenceModels.list().catch(() => []);
        return { automatic, models };
      }
      case "bridge.mr_reviews.infer": {
        // One row now (`:infer`, reviews_refresh), whatever the schedule.
        const target = key();
        await inference.infer(target);
        const row = inbox
          .snapshot(await settings())
          .entries.find((entry) => entry.key === target);
        if (!row) throw new MrReviewsError("not on the board", "not_found");
        return {
          ok: true,
          state: inference.state(),
          ...(row.inferred ? { inferred: row.inferred } : {}),
          lane: row.lane ?? null,
          next: row.next ?? null,
        };
      }
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
        // In one of its homes: its review shown there (D27).
        const home = params.home as
          | { connection_id?: unknown; workspace_id?: unknown }
          | undefined;
        if (home && typeof home === "object") {
          if (
            typeof home.connection_id !== "string" ||
            typeof home.workspace_id !== "string"
          )
            throw new MrReviewsError(
              "home: connection_id and workspace_id are required",
            );
          return homes.openIn(key(), {
            connectionId: home.connection_id,
            workspaceId: home.workspace_id,
          });
        }
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
      case "bridge.mr_reviews.home": {
        // "Start a review with a home": a workspace of its own with an agent.
        const started = await homes.start(key());
        linker.forget();
        return started;
      }
      case "bridge.mr_reviews.panel": {
        // The panel's search and filter, kept for every device: pushed
        // apart from the authored state (no version, no Undo).
        const search =
          typeof params.search === "string"
            ? params.search.slice(0, 500)
            : undefined;
        const filter =
          typeof params.filter === "string" ? params.filter : undefined;
        if (search === undefined && filter === undefined)
          throw new MrReviewsError("search or filter is required");
        const panel = await editSettings(async () => {
          const current = await saved();
          const stored = normalizeStoredMrReviews({
            ...storedMrReviews(current),
            panel: {
              search: search ?? current.panel.search,
              filter: filter ?? current.panel.filter,
              // Strictly after the last write: a page orders by it.
              at: new Date(
                Math.max(Date.now(), Date.parse(current.panel.at || "0") + 1),
              ).toISOString(),
            },
          });
          const next = mrReviewsSettings(stored);
          await saveSettings(next);
          return next.panel;
        });
        const now = await saved();
        options.publish?.({
          version: now.orderVersion ?? 0,
          order: now.order,
          changed: ["panel"],
          by: "user",
        });
        return { panel };
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
        const links = await linker.links(items, reviews, state.homes ?? {});
        // A branch headed upstream: its own workspace.
        const rows = upstreamRows(await settings()).rows;
        for (const row of rows)
          if (row.branch && (!wanted || wanted.has(row.key)))
            links[row.key] = [
              {
                connectionId: row.branch.connectionId,
                connectionLabel: row.branch.connectionLabel,
                workspaceId: row.branch.workspaceId,
                label: row.branch.workspaceLabel,
                why: ["branch"],
              },
            ];
        return { links };
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
        upstreamChanged: () => upstream.refresh(true),
        ...(options.tree ? { tree: options.tree.read } : {}),
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
        {
          settings,
          inbox,
          store,
          order,
          rpc: (method, p) => rpc(method, p),
          ...(options.tree ? { tree: options.tree.read } : {}),
          workspaces: () => upstream.live(),
        },
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
    upstream,
    rekeyBranches,
    efforts,
    opener,
    homes,
    claude,
    curation,
    lifecycle,
    handle: rpc,
    order,
    agent: reviewsAgent,
    start: () => inbox.start(),
    stop: () => {
      offTree?.();
      inbox.stop();
      void agent?.dispose();
    },
  };
}

export type MrReviews = ReturnType<typeof createMrReviews>;
