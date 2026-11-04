import type { MrReviewsSettings } from "../../../shared/mrReviews";
import {
  type GuiSettings,
  readGuiSettings,
  updateGuiSettings,
} from "../config/gui-settings";
import type { GlabContext } from "../review/gitlab";
import { serverLogger } from "../utils/logger";
import { createInboxFetchers, type InboxFetchers } from "./fetchers";
import { discoverForgeHosts, type ForgeHost } from "./hosts";
import { createMrInbox } from "./inbox";
import { handleMrReviewsRpc, type MrReviewsRpcDeps } from "./rpc";
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

  const inbox = createMrInbox({
    fetchers: options.fetchers ?? createInboxFetchers(options.run),
    settings,
    store,
    logger,
  });

  return {
    inbox,
    store,
    settings,
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
          ...(options.more ? { more: options.more } : {}),
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
