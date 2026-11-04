import type {
  MrCurationState,
  MrHostState,
  MrInbox,
  MrInboxEntry,
  MrItem,
  MrReviewsSettings,
  MrVerdict,
} from "../../../shared/mrReviews";
import { mrProjectKey, mrUnread } from "../../../shared/mrReviews";
import { type Logger, serverLogger } from "../utils/logger";
import {
  ForgeToolMissingError,
  type InboxFetchers,
  NotSignedInError,
} from "./fetchers";
import {
  type HostAnswer,
  githubInboxQuery,
  gitlabInboxQuery,
  parseGithubInbox,
  parseGitlabInbox,
} from "./queries";
import type { MrStore } from "./store";

/**
 * The reviews inbox: the user's merge and pull requests on each forge host
 * (review requested, assigned, mentioned) and the open ones of the
 * followed projects, read in one GraphQL query per host and refresh,
 * remembered across restarts. Only reads.
 */

/** Refresh period while someone looks at the inbox. */
export const WATCHED_REFRESH_MS = 5 * 60_000;
/** Refresh period otherwise (prefetch and lifecycle need it). */
export const IDLE_REFRESH_MS = 15 * 60_000;
/** A viewer is someone who asked within this. */
const VIEWER_MS = 2 * 60_000;
/** A refresh asked for is not made again sooner than this. */
export const FRESH_MIN_MS = 60_000;
/** A GitLab draft count is read again after this. */
export const DRAFTS_TTL_MS = 10 * 60_000;
/** Draft counts read per refresh, at most. */
const DRAFTS_PER_REFRESH = 10;

export type MrInboxDeps = {
  fetchers: InboxFetchers;
  settings: () => Promise<MrReviewsSettings>;
  store: MrStore;
  now?: () => number;
  logger?: Logger;
  /** The inbox changed: browsers may ask again. */
  onChange?: () => void;
  /** After each refresh: prefetch, lifecycle, curation. */
  afterRefresh?: (items: MrItem[]) => void;
  /** Curation's state, shown in the inbox. */
  curation?: () => MrCurationState;
};

type HostResult = { state: MrHostState; answer?: HostAnswer };

export function createMrInbox(deps: MrInboxDeps) {
  const now = deps.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const logger = deps.logger ?? serverLogger.child("mr-reviews");
  const hosts = new Map<string, HostResult>();
  let refreshing: Promise<void> | null = null;
  let lastRefresh = 0;
  let lastViewer = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;

  /** Every request known, the user's first, by key. */
  function items(): MrItem[] {
    const known = deps.store.get().items;
    return known;
  }

  async function readHost(
    host: { host: string; provider: "gitlab" | "github" },
    followed: string[],
  ): Promise<HostResult> {
    const base = { host: host.host, provider: host.provider };
    try {
      const answer =
        host.provider === "gitlab"
          ? parseGitlabInbox(
              host.host,
              followed,
              await deps.fetchers.gitlab(host.host, gitlabInboxQuery(followed)),
            )
          : parseGithubInbox(
              host.host,
              followed,
              await deps.fetchers.github(host.host, githubInboxQuery(followed)),
            );
      return {
        state: {
          ...base,
          state: "ok",
          user: answer.user,
          fetchedAt: iso(),
          ...(answer.missing.length
            ? { message: `Cannot see ${answer.missing.join(", ")}` }
            : {}),
        },
        answer,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state: MrHostState["state"] =
        error instanceof NotSignedInError
          ? "not_signed_in"
          : error instanceof ForgeToolMissingError
            ? "unavailable"
            : "error";
      if (state === "error")
        logger.warn("inbox host not read", { host: host.host, error: message });
      return {
        state: { ...base, state, message: message.slice(0, 300) },
      };
    }
  }

  async function readDrafts(list: MrItem[]) {
    const state = deps.store.get();
    const due = list
      .filter(
        (item) =>
          item.provider === "gitlab" &&
          item.reasons.length > 0 &&
          now() - Date.parse(state.drafts[item.key]?.at ?? "1970-01-01") >=
            DRAFTS_TTL_MS,
      )
      .slice(0, DRAFTS_PER_REFRESH);
    const counts: [string, number][] = [];
    for (const item of due) {
      try {
        counts.push([item.key, await deps.fetchers.gitlabDrafts(item)]);
      } catch (error) {
        logger.debug("draft count not read", {
          mr: item.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (counts.length)
      deps.store.update((state) => {
        for (const [key, count] of counts)
          state.drafts[key] = { count, at: iso() };
      });
  }

  async function run() {
    const settings = await deps.settings();
    const followedOf = (host: string) =>
      settings.followed
        .filter((entry) => entry.host === host)
        .map((entry) => entry.project);
    // Hosts without a followed project nor a login cost one call each.
    const results = await Promise.all(
      settings.hosts.map((host) => readHost(host, followedOf(host.host))),
    );
    hosts.clear();
    for (const result of results) hosts.set(result.state.host, result);
    // A host that failed keeps what it had: the list does not empty on a
    // hiccup.
    const previous = items();
    const merged = new Map<string, MrItem>();
    for (const result of results) {
      if (!result.answer) {
        for (const item of previous)
          if (item.host === result.state.host) merged.set(item.key, item);
        continue;
      }
      for (const item of result.answer.followed) merged.set(item.key, item);
      for (const item of result.answer.mine) {
        const followed = merged.get(item.key);
        merged.set(item.key, {
          ...item,
          ...(followed?.files ? { files: followed.files } : {}),
        });
      }
    }
    const list = [...merged.values()];
    deps.store.update((state) => {
      state.items = list;
      // The user saw a request close: its review state ages from now.
      for (const item of list) {
        const review = state.reviews[item.key];
        if (review && item.state !== "open" && !review.closedAt)
          review.closedAt = iso();
      }
    });
    lastRefresh = now();
    deps.onChange?.();
    await readDrafts(list);
    deps.onChange?.();
    deps.afterRefresh?.(list);
  }

  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = run()
      .catch((error) => {
        logger.warn("inbox refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        refreshing = null;
        schedule();
      });
    deps.onChange?.();
    return refreshing;
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const watched = now() - lastViewer < VIEWER_MS;
    const period = watched ? WATCHED_REFRESH_MS : IDLE_REFRESH_MS;
    const wait = Math.max(1_000, lastRefresh + period - now());
    timer = setTimeout(() => void refresh(), wait);
    (timer as { unref?: () => void }).unref?.();
  }

  function entries(): MrInboxEntry[] {
    const state = deps.store.get();
    const verdicts = new Map(
      state.feedback.map((entry) => [entry.key, entry.verdict]),
    );
    const out: MrInboxEntry[] = [];
    for (const item of items()) {
      const section = item.reasons.length ? "mine" : "suggested";
      const ranked = state.ranked[item.key];
      const verdict = verdicts.get(item.key);
      if (section === "suggested") {
        if (item.state !== "open") continue;
        // Shown once Claude picked it (or the user asked for more like
        // it); never after "not interested".
        if (verdict === "not_interested") continue;
        if (!ranked?.pick && verdict !== "more_like_this") continue;
      }
      const seen = state.seen[item.key];
      const review = state.reviews[item.key];
      const drafts =
        item.drafts ??
        (item.provider === "gitlab" ? state.drafts[item.key]?.count : 0);
      out.push({
        ...item,
        ...(drafts === undefined ? {} : { drafts }),
        section,
        unread: mrUnread(item, seen),
        isNew: !seen,
        ...(section === "suggested" && ranked?.reason
          ? { reason: ranked.reason }
          : {}),
        ...(verdict ? { feedback: verdict } : {}),
        ...(review
          ? {
              review: {
                connectionId: review.connectionId,
                ...(review.workspaceId
                  ? { workspaceId: review.workspaceId }
                  : {}),
                sessionId: review.sessionId,
              },
            }
          : {}),
      });
    }
    const unreadFirst = (entry: MrInboxEntry) =>
      entry.isNew || entry.unread?.changed ? 0 : 1;
    const score = (entry: MrInboxEntry) => state.ranked[entry.key]?.score ?? 0;
    return out.sort(
      (a, b) =>
        (a.section === b.section ? 0 : a.section === "mine" ? -1 : 1) ||
        (a.section === "suggested" ? score(b) - score(a) : 0) ||
        unreadFirst(a) - unreadFirst(b) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  return {
    /** The inbox as known, without waiting; asks a refresh when stale. */
    async get(options: { fresh?: boolean; viewer?: boolean } = {}) {
      if (options.viewer !== false) {
        const wasWatched = now() - lastViewer < VIEWER_MS;
        lastViewer = now();
        if (!wasWatched) schedule();
      }
      const settings = await deps.settings();
      const stale =
        now() - lastRefresh >=
        (options.fresh ? FRESH_MIN_MS : WATCHED_REFRESH_MS);
      if (stale && !refreshing) void refresh();
      return this.snapshot(settings);
    },
    snapshot(settings: MrReviewsSettings): MrInbox {
      return {
        entries: entries(),
        hosts: settings.hosts.map(
          (host) =>
            hosts.get(host.host)?.state ?? {
              host: host.host,
              provider: host.provider,
              state: "pending",
            },
        ),
        curation: deps.curation?.() ?? { state: "off" },
        ...(lastRefresh
          ? { refreshedAt: new Date(lastRefresh).toISOString() }
          : {}),
        refreshing: refreshing !== null,
      };
    },
    refresh,
    /** The user looked at a request: its activity is read. */
    markSeen(key: string) {
      const item = items().find((entry) => entry.key === key);
      if (!item) return false;
      deps.store.update((state) => {
        state.seen[key] = {
          at: iso(),
          updatedAt: item.updatedAt,
          headSha: item.headSha,
          notes: item.notes,
        };
      });
      deps.onChange?.();
      return true;
    },
    /** The user's word on a request (null takes it back). */
    feedback(key: string, verdict: MrVerdict | null) {
      const item = items().find((entry) => entry.key === key);
      if (!item) return false;
      deps.store.setFeedback(item, verdict, iso());
      deps.onChange?.();
      return true;
    },
    item(key: string): MrItem | undefined {
      return items().find((entry) => entry.key === key);
    },
    items,
    /** The projects of the inbox's requests, by mrProjectKey. */
    projects(): Map<string, MrItem[]> {
      const projects = new Map<string, MrItem[]>();
      for (const item of items()) {
        const key = mrProjectKey(item);
        projects.set(key, [...(projects.get(key) ?? []), item]);
      }
      return projects;
    },
    start() {
      stopped = false;
      // The first refresh waits a little: the bridge has more urgent work
      // when it starts.
      lastRefresh = now() - IDLE_REFRESH_MS + 30_000;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type MrInboxService = ReturnType<typeof createMrInbox>;
