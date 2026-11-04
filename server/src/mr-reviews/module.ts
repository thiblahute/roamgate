import type { MrReviewsSettings } from "../../../shared/mrReviews";
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
import { createMrClaude } from "./claude";
import { createMrOpener } from "./open";
import {
  handleMrReviewsRpc,
  MrReviewsError,
  type MrReviewsRpcDeps,
} from "./rpc";
import { mrReviewsSettings, storedMrReviews } from "./settings";
import { type MrStore, openMrStore } from "./store";

/**
 * The reviews module of the bridge: the inbox and its settings, wired to
 * settings.json and the user's glab and gh logins.
 */

const HOSTS_TTL_MS = 5 * 60_000;

export function createMrReviews(options: {
  run: GlabContext["runProcessWithCodeTimeout"];
  fetchers?: InboxFetchers;
  store?: MrStore;
  readSettings?: () => Promise<GuiSettings>;
  discoverHosts?: () => ForgeHost[];
  /** The ready connections, the local one first. */
  connections?: () => MrConnection[];
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
  /** Drops a request's review (lifecycle). */
  removeReview?: (sessionId: string) => void;
  more?: MrReviewsRpcDeps["more"];
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

  const clones = createCloneFinder();
  let opener: ReturnType<typeof createMrOpener> | null = null;
  const inbox = createMrInbox({
    fetchers: options.fetchers ?? createInboxFetchers(options.run),
    settings,
    store,
    logger,
    afterRefresh: (items) => {
      void opener?.prefetch(items);
      void lifecycle();
    },
  });
  opener = createMrOpener({
    inbox,
    store,
    settings,
    connections: options.connections ?? (() => []),
    clones,
    logger,
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

  const more = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const key = () => {
      if (typeof params.key !== "string" || !params.key)
        throw new MrReviewsError("key is required");
      return params.key;
    };
    switch (method) {
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

  return {
    inbox,
    store,
    settings,
    opener,
    claude,
    lifecycle,
    handle(method: string, params: Record<string, unknown>) {
      return handleMrReviewsRpc(
        {
          inbox,
          settings: async () => {
            // The settings page shows what is saved, and the hosts found.
            const value = await saved();
            return {
              ...value,
              discoveredHosts: value.hosts.length
                ? []
                : (await settings()).hosts,
            };
          },
          saveSettings: async (next) => {
            const written = await updateGuiSettings((current) => ({
              ...current,
              mr_reviews: storedMrReviews(next),
            }));
            discovered = null;
            return mrReviewsSettings(written.mr_reviews);
          },
          more,
        },
        method,
        params,
      );
    },
    start: () => inbox.start(),
    stop: () => inbox.stop(),
  };
}

export type MrReviews = ReturnType<typeof createMrReviews>;
