import type { ForgeRef } from "../../../shared/forge";
import { forgeRefKey } from "../../../shared/forge";
import type {
  MrCurationState,
  MrHiddenEntry,
  MrHostState,
  MrInbox,
  MrInboxEntry,
  MrItem,
  MrReviewsSettings,
  MrVerdict,
} from "../../../shared/mrReviews";
import {
  mrActivityMarker,
  mrProjectKey,
  mrSeenOf,
  mrUnread,
} from "../../../shared/mrReviews";
import { type Logger, serverLogger } from "../utils/logger";
import {
  githubRequestQuery,
  gitlabRequestQuery,
  parseRequest,
} from "./agent-search";
import {
  type FetchCall,
  ForgeToolMissingError,
  type InboxFetchers,
  NotSignedInError,
} from "./fetchers";
import {
  type HostAnswer,
  OWN_DETAILS_BATCH,
  OWN_MAX_PAGES,
  type OwnDetails,
  type OwnFields,
  githubInboxQuery,
  githubOwnListQuery,
  gitlabInboxQuery,
  gitlabOwnListQuery,
  ownDetailsQuery,
  parseGithubInbox,
  parseGitlabInbox,
  parseOwnDetails,
  parseOwnList,
  unknownFieldError,
  withOwnDetails,
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
/**
 * A GitLab draft count is read again after this, or sooner when the
 * request changed; only for requests reviewed in Roamgate (their review
 * reads them anyway while open).
 */
export const DRAFTS_TTL_MS = 60 * 60_000;
/** Draft counts read per refresh, at most. */
const DRAFTS_PER_REFRESH = 10;
/** Pinned requests no list has, read per refresh at most (a call each). */
const PINS_PER_REFRESH = 20;
/** A pinned request that closed is read again after this. */
const PIN_TTL_MS = 60 * 60_000;
const PIN_CALL: FetchCall = { feature: "inbox", kind: "pinned" };
const OWN_CALL: FetchCall = { feature: "inbox", kind: "own" };
const OWN_DETAILS_CALL: FetchCall = { feature: "inbox", kind: "own-details" };
/**
 * An open own request's details are read again after this even when it
 * did not change: what moves without touching it (its target branch, so
 * its conflicts) shows within it.
 */
export const OWN_DETAILS_TTL_MS = 60 * 60_000;
/** Unchanged own requests read again for their age per refresh, at most. */
const OWN_AGED_PER_REFRESH = 10;
/** Own requests whose details are read per refresh and host, at most. */
const OWN_DETAILS_PER_REFRESH = 200;

/** The page a request has on its forge, for a pin not read. */
function requestUrl(ref: ForgeRef): string {
  return ref.provider === "gitlab"
    ? `https://${ref.host}/${ref.project}/-/merge_requests/${ref.number}`
    : `https://${ref.host}/${ref.project}/pull/${ref.number}`;
}

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

type HostResult = {
  state: MrHostState;
  answer?: HostAnswer;
  /** The user's own requests; absent when they could not be read. */
  own?: MrItem[];
};

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
  /** The own-requests fields each GitLab host takes. */
  const ownFields = new Map<string, OwnFields>();

  /**
   * Every request known: the forges' lists, then those the reviews agent
   * found (once in a list, the list's copy wins).
   */
  function items(): MrItem[] {
    const state = deps.store.get();
    const listed = new Set(state.items.map((item) => item.key));
    const extra: MrItem[] = [];
    for (const item of [
      ...Object.values(state.found).map((entry) => entry.item),
      ...Object.values(state.pins).flatMap((pin) =>
        pin.item ? [pin.item] : [],
      ),
    ]) {
      if (listed.has(item.key)) continue;
      listed.add(item.key);
      extra.push(item);
    }
    return extra.length ? [...state.items, ...extra] : state.items;
  }

  /** One pinned request, read from the forge and kept. */
  async function readPin(ref: ForgeRef): Promise<void> {
    const key = forgeRefKey(ref);
    const previous = deps.store.get().pins[key];
    try {
      const answer =
        ref.provider === "gitlab"
          ? await deps.fetchers.gitlab(
              ref.host,
              gitlabRequestQuery(ref),
              PIN_CALL,
            )
          : await deps.fetchers.github(
              ref.host,
              githubRequestQuery(ref),
              PIN_CALL,
            );
      const found = parseRequest(ref, answer);
      deps.store.update((state) => {
        state.pins[key] = found
          ? { item: found.item, at: iso() }
          : { error: "Not found, or you have no access to it", at: iso() };
      });
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 300);
      logger.debug("pinned request not read", { mr: key, error: message });
      // A hiccup keeps what was known; it is read again next refresh.
      if (previous?.item) return;
      deps.store.update((state) => {
        state.pins[key] = { error: message, at: iso() };
      });
    }
  }

  /** The pinned requests no list has: read when new, failed, open or old. */
  async function readPins(settings: MrReviewsSettings, listed: Set<string>) {
    const wanted = new Set(settings.pinned.map(forgeRefKey));
    const stale = Object.keys(deps.store.get().pins).filter(
      (key) => !wanted.has(key) || listed.has(key),
    );
    if (stale.length)
      deps.store.update((state) => {
        for (const key of stale) delete state.pins[key];
      });
    const due = settings.pinned
      .filter((ref) => {
        const key = forgeRefKey(ref);
        if (listed.has(key)) return false;
        const known = deps.store.get().pins[key];
        if (!known?.item) return true;
        return (
          known.item.state === "open" ||
          now() - Date.parse(known.at) >= PIN_TTL_MS
        );
      })
      .slice(0, PINS_PER_REFRESH);
    for (const ref of due) await readPin(ref);
  }

  type Host = { host: string; provider: "gitlab" | "github" };

  /**
   * The light list of the user's own requests on a host: every open one,
   * paged to the end (OWN_MAX_PAGES at most), and the latest settled.
   */
  async function listOwn(host: Host): Promise<MrItem[]> {
    const items = new Map<string, MrItem>();
    let after: string | undefined;
    for (let page = 0; page < OWN_MAX_PAGES; page++) {
      const answer =
        host.provider === "gitlab"
          ? await deps.fetchers.gitlab(
              host.host,
              gitlabOwnListQuery(after),
              OWN_CALL,
            )
          : await deps.fetchers.github(
              host.host,
              githubOwnListQuery(after),
              OWN_CALL,
            );
      const read = parseOwnList(host.provider, host.host, answer);
      for (const item of read.items)
        if (!items.has(item.key)) items.set(item.key, item);
      if (!read.next) return [...items.values()];
      after = read.next;
    }
    logger.warn("own open requests cut at the page cap", {
      host: host.host,
      pages: OWN_MAX_PAGES,
      read: items.size,
    });
    return [...items.values()];
  }

  /** Details of some own requests, in batches; a host refusing fields gets the basic ones. */
  async function readOwnDetails(
    host: Host,
    due: MrItem[],
  ): Promise<Map<string, OwnDetails>> {
    const found = new Map<string, OwnDetails>();
    const sorted = [...due].sort((a, b) => a.project.localeCompare(b.project));
    for (let index = 0; index < sorted.length; index += OWN_DETAILS_BATCH) {
      const batch = sorted.slice(index, index + OWN_DETAILS_BATCH);
      for (const [key, details] of await readOwnBatch(host, batch))
        found.set(key, details);
    }
    return found;
  }

  async function readOwnBatch(
    host: Host,
    batch: MrItem[],
  ): Promise<Map<string, OwnDetails>> {
    if (host.provider === "github")
      return parseOwnDetails(
        "github",
        host.host,
        await deps.fetchers.github(
          host.host,
          ownDetailsQuery("github", batch),
          OWN_DETAILS_CALL,
        ),
      );
    const fields = ownFields.get(host.host) ?? "full";
    const fallBack = () => {
      ownFields.set(host.host, "basic");
      logger.info("own requests read with the basic fields", {
        host: host.host,
      });
      return readOwnBatch(host, batch);
    };
    let answer: unknown;
    try {
      answer = await deps.fetchers.gitlab(
        host.host,
        ownDetailsQuery("gitlab", batch, fields),
        OWN_DETAILS_CALL,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (fields === "full" && /field/i.test(message)) return fallBack();
      throw error;
    }
    if (fields === "full" && unknownFieldError(answer)) return fallBack();
    return parseOwnDetails("gitlab", host.host, answer);
  }

  /**
   * The user's own requests on a host: open, or settled since
   * `settledSince`. Their details are read only when new, changed since
   * last read, still settling, or (a few per refresh) old; the others keep
   * the details known.
   */
  async function readOwn(host: Host, settledSince: string): Promise<MrItem[]> {
    const listed = (await listOwn(host)).filter(
      (item) => item.state === "open" || item.updatedAt >= settledSince,
    );
    const known = deps.store.get().ownDetails;
    const changed: MrItem[] = [];
    const aged: MrItem[] = [];
    for (const item of listed) {
      const details = known[item.key];
      if (
        !details ||
        item.updatedAt > details.updatedAt ||
        item.headSha !== details.headSha ||
        (item.state === "open" && details.settling)
      )
        changed.push(item);
      else if (
        item.state === "open" &&
        now() - Date.parse(details.at) >= OWN_DETAILS_TTL_MS
      )
        aged.push(item);
    }
    aged.sort((a, b) =>
      (known[a.key]?.at ?? "").localeCompare(known[b.key]?.at ?? ""),
    );
    const due = [...changed, ...aged.slice(0, OWN_AGED_PER_REFRESH)].slice(
      0,
      OWN_DETAILS_PER_REFRESH,
    );
    let fresh = new Map<string, OwnDetails>();
    if (due.length)
      try {
        fresh = await readOwnDetails(host, due);
      } catch (error) {
        // The list stands; the details known stay, read again next time.
        logger.debug("own request details not read", {
          host: host.host,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    // Kept for the requests listed; the others (gone, settled long ago) go.
    const keys = new Set(listed.map((item) => item.key));
    const prefix = `${host.provider}:${host.host.toLowerCase()}/`;
    const gone = Object.keys(known).filter(
      (key) => key.startsWith(prefix) && !keys.has(key),
    );
    if (fresh.size || gone.length) {
      const at = iso();
      deps.store.update((state) => {
        for (const [key, details] of fresh)
          if (keys.has(key)) state.ownDetails[key] = { ...details, at };
        for (const key of gone) delete state.ownDetails[key];
      });
    }
    const details = deps.store.get().ownDetails;
    return listed.map((item) => withOwnDetails(item, details[item.key]));
  }

  async function readHost(
    host: { host: string; provider: "gitlab" | "github" },
    followed: string[],
    settledSince: string,
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
      // Its own query: a failure there keeps what was known of them.
      let own: MrItem[] | undefined;
      try {
        own = await readOwn(host, settledSince);
      } catch (error) {
        logger.debug("own requests not read", {
          host: host.host,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        ...(own ? { own } : {}),
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
      .filter((item) => {
        if (item.provider !== "gitlab" || !state.reviews[item.key])
          return false;
        const known = state.drafts[item.key];
        if (!known) return true;
        return (
          item.updatedAt > known.at ||
          now() - Date.parse(known.at) >= DRAFTS_TTL_MS
        );
      })
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
    // Hosts without a followed project nor a login cost two calls each
    // (the inbox, the user's own requests).
    const settledSince = new Date(
      now() - settings.retentionDays * 24 * 60 * 60_000,
    ).toISOString();
    const results = await Promise.all(
      settings.hosts.map((host) =>
        readHost(host, followedOf(host.host), settledSince),
      ),
    );
    hosts.clear();
    for (const result of results) hosts.set(result.state.host, result);
    // A host that failed keeps what it had: the list does not empty on a
    // hiccup.
    const previous = deps.store.get().items;
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
      // The user's own: what they were read with, else what was known.
      const own =
        result.own ??
        previous.filter(
          (item) =>
            item.host === result.state.host &&
            item.reasons.includes("authored"),
        );
      for (const item of own) {
        const known = merged.get(item.key);
        merged.set(item.key, {
          ...item,
          reasons: [...new Set([...(known?.reasons ?? []), ...item.reasons])],
          ...(known?.files ? { files: known.files } : {}),
        });
      }
    }
    const list = [...merged.values()];
    deps.store.update((state) => {
      state.items = list;
      // The user saw a request close: its review state ages from now.
      // A host's first answer is the baseline: everything in it counts as
      // seen as it is, so "new" and unread mean since then, not "all".
      for (const result of results) {
        if (!result.answer || state.baselined[result.state.host]) continue;
        state.baselined[result.state.host] = iso();
        for (const item of list)
          if (item.host === result.state.host && !state.seen[item.key])
            state.seen[item.key] = mrSeenOf(item, iso());
      }
      // The user's own requests are never "new" to them: what changes on
      // them from the first sight on is what shows.
      for (const item of list)
        if (item.reasons.includes("authored") && !state.seen[item.key])
          state.seen[item.key] = mrSeenOf(item, iso());
      for (const item of list) {
        const review = state.reviews[item.key];
        if (review && item.state !== "open" && !review.closedAt)
          review.closedAt = iso();
      }
    });
    await readPins(settings, new Set(list.map((item) => item.key)));
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

  function entries(settings: MrReviewsSettings): {
    entries: MrInboxEntry[];
    hidden: MrHiddenEntry[];
  } {
    const state = deps.store.get();
    const pinned = new Map(
      settings.pinned.map((ref) => [forgeRefKey(ref), ref]),
    );
    const hiddenAt = new Map(
      settings.hidden.map((entry) => [entry.key, entry.marker]),
    );
    const hidden: MrHiddenEntry[] = [];
    const verdicts = new Map(
      state.feedback.map((entry) => [entry.key, entry.verdict]),
    );
    const out: MrInboxEntry[] = [];
    const listed = new Set<string>();
    for (const item of items()) {
      listed.add(item.key);
      const section = pinned.has(item.key)
        ? "pinned"
        : item.reasons.includes("authored")
          ? "authored"
          : item.reasons.length
            ? "mine"
            : "suggested";
      const ranked = state.ranked[item.key];
      const verdict = verdicts.get(item.key);
      if (section === "suggested") {
        if (item.state !== "open") continue;
        // Shown once Claude picked it (or the user asked for more like
        // it); never after "not interested".
        if (verdict === "not_interested") continue;
        if (!ranked?.pick && verdict !== "more_like_this") continue;
      }
      // Removed by the user, and quiet since: out of the view, listed apart.
      if (
        section !== "pinned" &&
        hiddenAt.get(item.key) === mrActivityMarker(item)
      ) {
        hidden.push({
          key: item.key,
          provider: item.provider,
          host: item.host,
          project: item.project,
          number: item.number,
          url: item.url,
          title: item.title,
        });
        continue;
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
    // A pinned request the forge did not give: a row saying so.
    for (const [key, ref] of pinned) {
      if (listed.has(key)) continue;
      out.push({
        ...ref,
        key,
        url: requestUrl(ref),
        title: `${ref.project}${ref.provider === "gitlab" ? "!" : "#"}${ref.number}`,
        author: "",
        draft: false,
        state: "open",
        updatedAt: "",
        headSha: "",
        sourceBranch: "",
        targetBranch: "",
        pipeline: null,
        notes: 0,
        reasons: [],
        section: "pinned",
        unread: null,
        isNew: false,
        unavailable: state.pins[key]?.error ?? "Not read yet",
      });
    }
    const rank = { pinned: 0, mine: 1, authored: 2, suggested: 3 } as const;
    const unreadFirst = (entry: MrInboxEntry) =>
      entry.isNew || entry.unread?.changed ? 0 : 1;
    const score = (entry: MrInboxEntry) => state.ranked[entry.key]?.score ?? 0;
    out.sort(
      (a, b) =>
        rank[a.section] - rank[b.section] ||
        (a.section === "suggested" ? score(b) - score(a) : 0) ||
        unreadFirst(a) - unreadFirst(b) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    return { entries: out, hidden };
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
      const { entries: shown, hidden } = entries(settings);
      return {
        entries: shown,
        hidden,
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
        ...(settings.order.length ? { order: settings.order } : {}),
        orderVersion: settings.orderVersion ?? 0,
      };
    },
    refresh,
    /** The forge hosts in effect (those set, or those signed in to). */
    async hosts() {
      return (await deps.settings()).hosts;
    },
    /** The settings changed what the inbox shows: browsers may ask again. */
    changed() {
      deps.onChange?.();
    },
    /** A request just pinned: read at once, so its row has its state. */
    async readPin(ref: ForgeRef) {
      await readPin(ref);
      deps.onChange?.();
    },
    /** The user looked at a request: its activity is read. */
    markSeen(key: string) {
      const item = items().find((entry) => entry.key === key);
      if (!item) return false;
      deps.store.update((state) => {
        state.seen[key] = mrSeenOf(item, iso());
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
    /** The user's name on each host read (their own requests are theirs). */
    users(): Map<string, string> {
      const users = new Map<string, string>();
      for (const [host, result] of hosts)
        if (result.state.user) users.set(host, result.state.user.toLowerCase());
      return users;
    },
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
