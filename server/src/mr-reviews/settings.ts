import type { ForgeProvider } from "../../../shared/forge";
import { validHost, validProject } from "../../../shared/forge";
import {
  DEFAULT_MR_REVIEWS_SETTINGS,
  type MrReviewsSettings,
  mrProjectKey,
} from "../../../shared/mrReviews";

/** The reviews settings, as settings.json keeps them (`mr_reviews`). */
export type StoredMrReviewsSettings = {
  hosts?: { host: string; provider: ForgeProvider }[];
  followed?: { host: string; provider: ForgeProvider; project: string }[];
  checkout?: "immediately" | "on_demand";
  retention_days?: number;
  curation?: boolean;
  suggest_days?: number;
  hints?: string;
  tree_groups?: Record<string, string[]>;
  clones?: Record<string, { connection_id: string; path: string }>;
  order?: string[];
};

export const MAX_HOSTS = 10;
export const MAX_FOLLOWED = 30;
/** Requests kept in the user's order. */
export const MAX_ORDER = 500;

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
  const suggest = Number(value.suggest_days);
  if (Number.isInteger(suggest) && suggest >= 1 && suggest <= 365)
    out.suggest_days = suggest;
  if (typeof value.hints === "string") out.hints = value.hints.slice(0, 2000);
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
  return out;
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
  };
}
