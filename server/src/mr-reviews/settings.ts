import type { ForgeProvider, ForgeRef } from "../../../shared/forge";
import { forgeRefKey, validHost, validProject } from "../../../shared/forge";
import { MAX_ORDER } from "../../../shared/mrReviewsOrder";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrOverride,
  type MrReviewsSettings,
  type MrUnsent,
  mrProjectKey,
} from "../../../shared/mrReviews";
import {
  parseWorkspaceRef,
  type WorkspaceRef,
  workspaceRefKey,
} from "../../../shared/workspaceTree";
import { normalizeOverride, type StoredMrOverride } from "./overrides";
import {
  MAX_MERGE_PATTERNS,
  MAX_MERGE_SCOPES,
  MR_MERGE_RULE_KEYS,
  MR_MERGE_STORED_KEYS,
  type MrMergeRules,
  type MrMergeSettings,
  mrBotName,
  mrMergePattern,
  mrMergeScope,
} from "../../../shared/mrReviewsMerge";

/** The reviews settings, as settings.json keeps them (`mr_reviews`). */
export type StoredMrReviewsSettings = {
  hosts?: { host: string; provider: ForgeProvider }[];
  followed?: { host: string; provider: ForgeProvider; project: string }[];
  checkout?: "immediately" | "on_demand";
  retention_days?: number;
  curation?: boolean;
  inference?: boolean;
  inference_hours?: number;
  /** The inference's model (empty or absent: automatic). */
  inference_model?: string;
  suggest_days?: number;
  hints?: string;
  tree_groups?: Record<string, string[]>;
  clones?: Record<string, { connection_id: string; path: string }>;
  order?: string[];
  order_version?: number;
  pinned?: ForgeRef[];
  hidden?: { key: string; marker: string }[];
  overrides?: Record<string, StoredMrOverride>;
  stale_days?: number;
  views?: { name: string; query: string }[];
  upstream_groups?: string[];
  upstream_skip?: WorkspaceRef[];
  unsent?: MrUnsent[];
  efforts?: StoredMrEffort[];
  merge?: StoredMrMerge;
  /** The panel's search and filter, on every device. */
  panel?: { search: string; filter: string; at: string };
  /** The first prompt of a request's home agent (empty: the default). */
  home_prompt?: string;
};

/** The lists of `mr_reviews.merge` (and of each scope), as stored. */
export type StoredMrMergeLists = {
  after_labels?: string[];
  bots?: string[];
  bot_failures?: string[];
  queue_labels?: string[];
};

/** `mr_reviews.merge` (section 15): lists, and scopes replacing them. */
export type StoredMrMerge = StoredMrMergeLists & {
  scopes?: Record<string, StoredMrMergeLists>;
};

function mergeLists(raw: unknown): StoredMrMergeLists {
  const out: StoredMrMergeLists = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const value = raw as Record<string, unknown>;
  for (const key of MR_MERGE_RULE_KEYS) {
    const stored = MR_MERGE_STORED_KEYS[key] as keyof StoredMrMergeLists;
    const list = value[stored];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    out[stored] = list
      .flatMap((each) => {
        const checked =
          key === "bots"
            ? typeof each === "string" &&
              /^@?[\w.-]{1,100}(\[bot\])?$/i.test(each.trim())
              ? mrBotName(each)
              : null
            : mrMergePattern(each);
        if (!checked || seen.has(checked)) return [];
        seen.add(checked);
        return [checked];
      })
      .slice(0, MAX_MERGE_PATTERNS);
  }
  return out;
}

/** `mr_reviews.merge` checked: patterns that compile, known scope keys. */
export function normalizeStoredMerge(raw: unknown): StoredMrMerge | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: StoredMrMerge = mergeLists(raw);
  const scopes = (raw as Record<string, unknown>).scopes;
  if (scopes && typeof scopes === "object" && !Array.isArray(scopes)) {
    const kept: Record<string, StoredMrMergeLists> = {};
    for (const [key, lists] of Object.entries(scopes).slice(
      0,
      MAX_MERGE_SCOPES,
    )) {
      const scope = mrMergeScope(key);
      if (!scope) continue;
      const checked = mergeLists(lists);
      if (Object.keys(checked).length) kept[scope] = checked;
    }
    if (Object.keys(kept).length) out.scopes = kept;
  }
  return out;
}

function fromStoredLists(lists: StoredMrMergeLists): Partial<MrMergeRules> {
  const out: Partial<MrMergeRules> = {};
  for (const key of MR_MERGE_RULE_KEYS) {
    const list = lists[MR_MERGE_STORED_KEYS[key] as keyof StoredMrMergeLists];
    if (list) out[key] = list;
  }
  return out;
}

function toStoredLists(lists: Partial<MrMergeRules>): StoredMrMergeLists {
  const out: StoredMrMergeLists = {};
  for (const key of MR_MERGE_RULE_KEYS)
    if (lists[key])
      out[MR_MERGE_STORED_KEYS[key] as keyof StoredMrMergeLists] = lists[key];
  return out;
}

/** The merge settings in effect, from what settings.json holds. */
export function mergeSettingsOf(
  stored: StoredMrMerge | undefined,
): MrMergeSettings {
  return {
    ...fromStoredLists(stored ?? {}),
    scopes: Object.fromEntries(
      Object.entries(stored?.scopes ?? {}).map(([scope, lists]) => [
        scope,
        fromStoredLists(lists),
      ]),
    ),
  };
}

/** The merge settings as settings.json keeps them; undefined when all default. */
export function storedMergeOf(
  merge: MrMergeSettings | undefined,
): StoredMrMerge | undefined {
  if (!merge) return undefined;
  const out: StoredMrMerge = toStoredLists(merge);
  const scopes = Object.entries(merge.scopes ?? {}).filter(
    ([, lists]) => Object.keys(toStoredLists(lists)).length,
  );
  if (scopes.length)
    out.scopes = Object.fromEntries(
      scopes.map(([scope, lists]) => [scope, toStoredLists(lists)]),
    );
  return Object.keys(out).length ? out : undefined;
}

/** As settings.json keeps an effort. */
export type StoredMrEffort = {
  id: string;
  group: string;
  name: string;
  clone: { connection_id: string; path: string };
  source: string;
  target: { remote: string; branch: string };
  feeders?: string[];
  head?: { connection_id: string; path: string; workspace_id?: string };
};

export const MAX_EFFORTS = 30;
const REF_RE = /^refs\/(heads|remotes)\/[\w./-]{1,240}$/;
const NAME_RE = /^[\w.-]{1,100}$/;

export function normalizeEffort(raw: unknown): StoredMrEffort | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, any>;
  const id =
    typeof value.id === "string" && /^[\w-]{1,64}$/.test(value.id)
      ? value.id
      : "";
  const group =
    typeof value.group === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.group)
      ? value.group
      : "";
  const name =
    typeof value.name === "string"
      ? value.name.replace(/\s+/g, " ").trim().slice(0, 80)
      : "";
  const connection = String(value.clone?.connection_id ?? "");
  const path = String(value.clone?.path ?? "");
  const source = String(value.source ?? "");
  const remote = String(value.target?.remote ?? "");
  const branch = String(value.target?.branch ?? "");
  if (
    !id ||
    !group ||
    !name ||
    !connection ||
    !path.startsWith("/") ||
    !REF_RE.test(source) ||
    !NAME_RE.test(remote) ||
    !/^[\w./-]{1,200}$/.test(branch)
  )
    return null;
  const feeders = Array.isArray(value.feeders)
    ? [
        ...new Set(
          value.feeders.filter(
            (ref: unknown): ref is string =>
              typeof ref === "string" && REF_RE.test(ref) && ref !== source,
          ),
        ),
      ].slice(0, 20)
    : [];
  const head =
    value.head &&
    typeof value.head.connection_id === "string" &&
    typeof value.head.path === "string" &&
    value.head.path.startsWith("/")
      ? {
          connection_id: value.head.connection_id,
          path: value.head.path,
          ...(typeof value.head.workspace_id === "string"
            ? { workspace_id: value.head.workspace_id }
            : {}),
        }
      : undefined;
  return {
    id,
    group,
    name,
    clone: { connection_id: connection, path },
    source,
    target: { remote, branch },
    ...(feeders.length ? { feeders } : {}),
    ...(head ? { head } : {}),
  };
}

export const MAX_HOSTS = 10;
export const MAX_FOLLOWED = 30;
export { MAX_ORDER };
/** Requests the user added by URL. */
export const MAX_PINNED = 100;
/** Requests the user removed from the view (the oldest forgotten first). */
export const MAX_HIDDEN = 300;
/** Requests with something set by hand (the oldest set forgotten first). */
export const MAX_OVERRIDES = 500;
/** Saved searches. */
export const MAX_VIEWS = 20;
export const VIEW_NAME_MAX = 40;
export const VIEW_QUERY_MAX = 500;
/** The panel's kept search, at most. */
export const PANEL_SEARCH_MAX = 500;
/** A home prompt, at most. */
export const HOME_PROMPT_MAX = 4000;
/** A model name, as `claude --model` takes it. */
export const INFERENCE_MODEL_MAX = 200;
export const MAX_UPSTREAM_GROUPS = 50;
export const MAX_UPSTREAM_SKIP = 200;
export const MAX_UNSENT = 200;

/** A view's name: a few words, no colon (`:view NAME` reads it). */
export function viewName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, VIEW_NAME_MAX);
  return name && !/[:"]/.test(name) ? name : null;
}

function provider(value: unknown): ForgeProvider | null {
  return value === "gitlab" || value === "github" ? value : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object",
      )
    : [];
}

/** What settings.json holds, checked; absent fields stay absent. */
export function normalizeStoredMrReviews(
  raw: unknown,
): StoredMrReviewsSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const out: StoredMrReviewsSettings = {};
  if (Array.isArray(value.hosts)) {
    const seen = new Set<string>();
    out.hosts = list(value.hosts)
      .flatMap((entry) => {
        const host = String(entry.host ?? "").toLowerCase();
        const kind = provider(entry.provider);
        if (!kind || !validHost(host) || seen.has(host)) return [];
        seen.add(host);
        return [{ host, provider: kind }];
      })
      .slice(0, MAX_HOSTS);
  }
  if (Array.isArray(value.followed)) {
    const seen = new Set<string>();
    out.followed = list(value.followed)
      .flatMap((entry) => {
        const host = String(entry.host ?? "").toLowerCase();
        const project = String(entry.project ?? "").replace(/^\/+|\/+$/g, "");
        const kind = provider(entry.provider);
        const key = mrProjectKey({ host, project });
        if (
          !kind ||
          !validHost(host) ||
          !validProject(project) ||
          seen.has(key)
        )
          return [];
        seen.add(key);
        return [{ host, provider: kind, project }];
      })
      .slice(0, MAX_FOLLOWED);
  }
  if (value.checkout === "immediately" || value.checkout === "on_demand")
    out.checkout = value.checkout;
  const days = Number(value.retention_days);
  if (Number.isInteger(days) && days >= 0 && days <= 365)
    out.retention_days = days;
  if (typeof value.curation === "boolean") out.curation = value.curation;
  if (typeof value.inference === "boolean") out.inference = value.inference;
  const hours = Number(value.inference_hours);
  if (Number.isInteger(hours) && hours >= 1 && hours <= 168)
    out.inference_hours = hours;
  if (typeof value.inference_model === "string") {
    const model = value.inference_model.trim().slice(0, INFERENCE_MODEL_MAX);
    if (model && !/\s/.test(model)) out.inference_model = model;
  }
  const suggest = Number(value.suggest_days);
  if (Number.isInteger(suggest) && suggest >= 1 && suggest <= 365)
    out.suggest_days = suggest;
  if (typeof value.hints === "string") out.hints = value.hints.slice(0, 2000);
  if (typeof value.home_prompt === "string")
    out.home_prompt = value.home_prompt.slice(0, HOME_PROMPT_MAX);
  if (
    value.panel &&
    typeof value.panel === "object" &&
    !Array.isArray(value.panel)
  ) {
    const panel = value.panel as Record<string, unknown>;
    const filter = typeof panel.filter === "string" ? panel.filter : "all";
    out.panel = {
      search:
        typeof panel.search === "string"
          ? panel.search.slice(0, PANEL_SEARCH_MAX)
          : "",
      filter:
        /^(all|review|mine)$/.test(filter) ||
        (filter.startsWith("view:") && filter.length <= 80)
          ? filter
          : "all",
      at: typeof panel.at === "string" ? panel.at.slice(0, 40) : "",
    };
  }
  if (
    value.tree_groups &&
    typeof value.tree_groups === "object" &&
    !Array.isArray(value.tree_groups)
  ) {
    out.tree_groups = {};
    for (const [key, path] of Object.entries(
      value.tree_groups as Record<string, unknown>,
    )) {
      if (!key.includes("/") || !Array.isArray(path)) continue;
      const names = path
        .filter((part): part is string => typeof part === "string")
        .map((part) => part.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 6);
      if (names.length) out.tree_groups[key.toLowerCase()] = names;
    }
  }
  if (
    value.clones &&
    typeof value.clones === "object" &&
    !Array.isArray(value.clones)
  ) {
    out.clones = {};
    for (const [key, entry] of Object.entries(
      value.clones as Record<string, unknown>,
    )) {
      const clone = entry as Record<string, unknown> | null;
      const path = String(clone?.path ?? "");
      const connection = String(clone?.connection_id ?? "");
      if (path.startsWith("/") && connection && key.includes("/"))
        out.clones[key.toLowerCase()] = { connection_id: connection, path };
    }
  }
  if (Array.isArray(value.order)) {
    const seen = new Set<string>();
    out.order = value.order
      .filter(
        (key): key is string =>
          typeof key === "string" && !!key && key.length <= 600,
      )
      .filter((key) => !seen.has(key) && !!seen.add(key))
      .slice(0, MAX_ORDER);
  }
  const version = Number(value.order_version);
  if (Number.isSafeInteger(version) && version > 0) out.order_version = version;
  if (Array.isArray(value.pinned)) {
    const seen = new Set<string>();
    out.pinned = list(value.pinned)
      .flatMap((entry) => {
        const host = String(entry.host ?? "").toLowerCase();
        const project = String(entry.project ?? "").replace(/^\/+|\/+$/g, "");
        const kind = provider(entry.provider);
        const number = Number(entry.number);
        if (
          !kind ||
          !validHost(host) ||
          !validProject(project) ||
          !Number.isSafeInteger(number) ||
          number <= 0
        )
          return [];
        const ref: ForgeRef = { provider: kind, host, project, number };
        const key = forgeRefKey(ref);
        if (seen.has(key)) return [];
        seen.add(key);
        return [ref];
      })
      .slice(0, MAX_PINNED);
  }
  if (Array.isArray(value.hidden)) {
    const seen = new Set<string>();
    out.hidden = list(value.hidden)
      .flatMap((entry) => {
        const key = entry.key;
        const marker = entry.marker;
        if (
          typeof key !== "string" ||
          !key ||
          key.length > 600 ||
          typeof marker !== "string" ||
          marker.length > 200 ||
          seen.has(key)
        )
          return [];
        seen.add(key);
        return [{ key, marker }];
      })
      .slice(-MAX_HIDDEN);
  }
  if (
    value.overrides &&
    typeof value.overrides === "object" &&
    !Array.isArray(value.overrides)
  ) {
    const kept = Object.entries(value.overrides as Record<string, unknown>)
      .flatMap(([key, raw]) => {
        if (!key || key.length > 600) return [];
        const override = normalizeOverride(raw);
        return override ? [[key, override] as const] : [];
      })
      .sort(([, a], [, b]) => a.at.localeCompare(b.at))
      .slice(-MAX_OVERRIDES);
    out.overrides = Object.fromEntries(kept);
  }
  if (Array.isArray(value.views)) {
    const seen = new Set<string>();
    out.views = list(value.views)
      .flatMap((entry) => {
        const name = viewName(entry.name);
        const query =
          typeof entry.query === "string"
            ? entry.query.trim().slice(0, VIEW_QUERY_MAX)
            : "";
        if (!name || !query || seen.has(name.toLowerCase())) return [];
        seen.add(name.toLowerCase());
        return [{ name, query }];
      })
      .slice(0, MAX_VIEWS);
  }
  if (Array.isArray(value.upstream_groups))
    out.upstream_groups = [
      ...new Set(
        value.upstream_groups.filter(
          (id): id is string =>
            typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id),
        ),
      ),
    ].slice(0, MAX_UPSTREAM_GROUPS);
  if (Array.isArray(value.upstream_skip)) {
    const seen = new Set<string>();
    out.upstream_skip = value.upstream_skip
      .flatMap((raw) => {
        const ref = parseWorkspaceRef(raw);
        if (!ref || seen.has(workspaceRefKey(ref))) return [];
        seen.add(workspaceRefKey(ref));
        return [ref];
      })
      .slice(0, MAX_UPSTREAM_SKIP);
  }
  if (Array.isArray(value.unsent)) {
    const seen = new Set<string>();
    out.unsent = list(value.unsent)
      .flatMap((entry) => {
        const key = entry.key;
        if (
          typeof key !== "string" ||
          !key.startsWith("branch:") ||
          key.length > 600 ||
          seen.has(key)
        )
          return [];
        seen.add(key);
        const title =
          typeof entry.title === "string"
            ? entry.title.replace(/\s+/g, " ").trim().slice(0, 300)
            : "";
        const target =
          typeof entry.target === "string"
            ? entry.target.trim().slice(0, 200)
            : "";
        return [
          {
            key,
            ...(title ? { title } : {}),
            ...(target ? { target } : {}),
            at: typeof entry.at === "string" ? entry.at.slice(0, 40) : "",
          },
        ];
      })
      .slice(0, MAX_UNSENT);
  }
  if (Array.isArray(value.efforts)) {
    const seen = new Set<string>();
    out.efforts = value.efforts
      .flatMap((raw) => {
        const effort = normalizeEffort(raw);
        if (!effort || seen.has(effort.id)) return [];
        seen.add(effort.id);
        return [effort];
      })
      .slice(0, MAX_EFFORTS);
  }
  const stale = Number(value.stale_days);
  if (Number.isInteger(stale) && stale >= 1 && stale <= 3650)
    out.stale_days = stale;
  const merge = normalizeStoredMerge(value.merge);
  if (merge && Object.keys(merge).length) out.merge = merge;
  return out;
}

function fromStoredOverride(stored: StoredMrOverride): MrOverride {
  return {
    ...(stored.whose !== undefined ? { whose: stored.whose } : {}),
    ...(stored.next !== undefined ? { next: stored.next } : {}),
    ...(stored.depends_on ? { dependsOn: stored.depends_on } : {}),
    ...(stored.labels ? { labels: stored.labels } : {}),
    ...(stored.link !== undefined ? { link: stored.link } : {}),
    ...(stored.stale !== undefined ? { stale: stored.stale } : {}),
    at: stored.at,
    by: stored.by,
    marker: stored.marker,
  };
}

function toStoredOverride(override: MrOverride): StoredMrOverride {
  return {
    ...(override.whose !== undefined ? { whose: override.whose } : {}),
    ...(override.next !== undefined ? { next: override.next } : {}),
    ...(override.dependsOn ? { depends_on: override.dependsOn } : {}),
    ...(override.labels ? { labels: override.labels } : {}),
    ...(override.link !== undefined ? { link: override.link } : {}),
    ...(override.stale !== undefined ? { stale: override.stale } : {}),
    at: override.at,
    by: override.by,
    marker: override.marker,
  };
}

/** The settings in effect, defaults filled in. */
export function mrReviewsSettings(
  stored: StoredMrReviewsSettings | undefined,
): MrReviewsSettings {
  const base = DEFAULT_MR_REVIEWS_SETTINGS;
  return {
    hosts: stored?.hosts ?? base.hosts,
    followed: stored?.followed ?? base.followed,
    checkout: stored?.checkout ?? base.checkout,
    retentionDays: stored?.retention_days ?? base.retentionDays,
    curation: stored?.curation ?? base.curation,
    inference: stored?.inference ?? base.inference,
    inferenceHours: stored?.inference_hours ?? base.inferenceHours,
    inferenceModel: stored?.inference_model ?? base.inferenceModel,
    suggestDays: stored?.suggest_days ?? base.suggestDays,
    hints: stored?.hints ?? base.hints,
    treeGroups: stored?.tree_groups ?? base.treeGroups,
    clones: Object.fromEntries(
      Object.entries(stored?.clones ?? {}).map(([key, clone]) => [
        key,
        { connectionId: clone.connection_id, path: clone.path },
      ]),
    ),
    order: stored?.order ?? base.order,
    orderVersion: stored?.order_version ?? 0,
    pinned: stored?.pinned ?? base.pinned,
    hidden: stored?.hidden ?? base.hidden,
    overrides: Object.fromEntries(
      Object.entries(stored?.overrides ?? {}).map(([key, value]) => [
        key,
        fromStoredOverride(value),
      ]),
    ),
    staleDays: stored?.stale_days ?? base.staleDays,
    views: stored?.views ?? base.views,
    upstreamGroups: stored?.upstream_groups ?? base.upstreamGroups,
    upstreamSkip: stored?.upstream_skip ?? base.upstreamSkip,
    unsent: stored?.unsent ?? base.unsent,
    merge: mergeSettingsOf(stored?.merge),
    panel: stored?.panel ?? base.panel,
    homePrompt: stored?.home_prompt ?? base.homePrompt,
    efforts: (stored?.efforts ?? []).map((effort) => ({
      id: effort.id,
      group: effort.group,
      name: effort.name,
      clone: {
        connectionId: effort.clone.connection_id,
        path: effort.clone.path,
      },
      source: effort.source,
      target: effort.target,
      feeders: effort.feeders ?? [],
      ...(effort.head
        ? {
            head: {
              connectionId: effort.head.connection_id,
              path: effort.head.path,
              ...(effort.head.workspace_id
                ? { workspaceId: effort.head.workspace_id }
                : {}),
            },
          }
        : {}),
    })),
  };
}

/** The settings in effect, as settings.json keeps them. */
export function storedMrReviews(
  settings: MrReviewsSettings,
): StoredMrReviewsSettings {
  return {
    hosts: settings.hosts,
    followed: settings.followed,
    checkout: settings.checkout,
    retention_days: settings.retentionDays,
    curation: settings.curation,
    ...(settings.inference !== DEFAULT_MR_REVIEWS_SETTINGS.inference
      ? { inference: settings.inference }
      : {}),
    ...(settings.inferenceHours !== DEFAULT_MR_REVIEWS_SETTINGS.inferenceHours
      ? { inference_hours: settings.inferenceHours }
      : {}),
    ...(settings.inferenceModel
      ? { inference_model: settings.inferenceModel }
      : {}),
    suggest_days: settings.suggestDays,
    hints: settings.hints,
    tree_groups: settings.treeGroups,
    clones: Object.fromEntries(
      Object.entries(settings.clones).map(([key, clone]) => [
        key,
        { connection_id: clone.connectionId, path: clone.path },
      ]),
    ),
    ...(settings.order.length ? { order: settings.order } : {}),
    ...(settings.orderVersion ? { order_version: settings.orderVersion } : {}),
    ...(settings.pinned.length ? { pinned: settings.pinned } : {}),
    ...(settings.hidden.length ? { hidden: settings.hidden } : {}),
    ...(Object.keys(settings.overrides).length
      ? {
          overrides: Object.fromEntries(
            Object.entries(settings.overrides).map(([key, value]) => [
              key,
              toStoredOverride(value),
            ]),
          ),
        }
      : {}),
    ...(settings.views.length ? { views: settings.views } : {}),
    ...(settings.upstreamGroups.length
      ? { upstream_groups: settings.upstreamGroups }
      : {}),
    ...(settings.upstreamSkip.length
      ? { upstream_skip: settings.upstreamSkip }
      : {}),
    ...(settings.unsent.length ? { unsent: settings.unsent } : {}),
    ...(settings.efforts.length
      ? {
          efforts: settings.efforts.map((effort) => ({
            id: effort.id,
            group: effort.group,
            name: effort.name,
            clone: {
              connection_id: effort.clone.connectionId,
              path: effort.clone.path,
            },
            source: effort.source,
            target: effort.target,
            ...(effort.feeders.length ? { feeders: effort.feeders } : {}),
            ...(effort.head
              ? {
                  head: {
                    connection_id: effort.head.connectionId,
                    path: effort.head.path,
                    ...(effort.head.workspaceId
                      ? { workspace_id: effort.head.workspaceId }
                      : {}),
                  },
                }
              : {}),
          })),
        }
      : {}),
    ...(settings.staleDays !== DEFAULT_MR_REVIEWS_SETTINGS.staleDays
      ? { stale_days: settings.staleDays }
      : {}),
    ...(storedMergeOf(settings.merge)
      ? { merge: storedMergeOf(settings.merge) }
      : {}),
    ...(settings.panel.at ? { panel: settings.panel } : {}),
    ...(settings.homePrompt ? { home_prompt: settings.homePrompt } : {}),
  };
}
