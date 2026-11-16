import type {
  MrOverride,
  MrOverrideField,
  MrWhose,
} from "../../../shared/mrReviews";
import { MR_OVERRIDE_FIELDS } from "../../../shared/mrReviews";

/**
 * What the user (or an agent session) sets by hand on one of their
 * requests: whose move it is, the next step, what it waits for, labels, a
 * link, stale. Kept in settings.json (`mr_reviews.overrides`), so every
 * device and the export have them. Each field set wins over what Roamgate
 * infers; whose-move and the next step show as outdated once the request
 * moved on since they were set (its activity marker), the others never age.
 */

/** As settings.json keeps an override. */
export type StoredMrOverride = {
  whose?: MrWhose;
  next?: string;
  depends_on?: string[];
  labels?: string[];
  link?: string;
  stale?: boolean;
  at: string;
  by: "user" | "agent";
  marker: string;
};

export const NEXT_MAX = 200;
export const LABELS_MAX = 10;
export const LABEL_MAX = 40;
export const LINK_MAX = 1000;
export const DEPENDS_MAX = 20;

function whoseOf(value: unknown): MrWhose | undefined {
  if (value === "me" || value === "reviewer" || value === "external")
    return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const person = (value as { person?: unknown }).person;
    if (
      typeof person === "string" &&
      /^[\w.-]{1,80}$/.test(person.replace(/^@/, ""))
    )
      return { person: person.replace(/^@/, "") };
  }
  return undefined;
}

function textOf(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, max);
  return text || undefined;
}

export function labelsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const labels = value
    .filter((each): each is string => typeof each === "string")
    .map((each) => each.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX))
    .filter((each) => {
      const key = each.toLowerCase();
      if (!each || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, LABELS_MAX);
  return labels.length ? labels : undefined;
}

function keysOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = [
    ...new Set(
      value.filter(
        (each): each is string =>
          typeof each === "string" && !!each && each.length <= 600,
      ),
    ),
  ].slice(0, DEPENDS_MAX);
  return keys.length ? keys : undefined;
}

/** An override as settings.json holds it, checked; null when nothing is left. */
export function normalizeOverride(raw: unknown): StoredMrOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const at = typeof value.at === "string" ? value.at.slice(0, 40) : "";
  const marker =
    typeof value.marker === "string" ? value.marker.slice(0, 200) : "";
  const whose = whoseOf(value.whose);
  const next = textOf(value.next, NEXT_MAX);
  const depends = keysOf(value.depends_on);
  const labels = labelsOf(value.labels);
  const link = textOf(value.link, LINK_MAX);
  const stale = typeof value.stale === "boolean" ? value.stale : undefined;
  const out: StoredMrOverride = {
    ...(whose ? { whose } : {}),
    ...(next ? { next } : {}),
    ...(depends ? { depends_on: depends } : {}),
    ...(labels ? { labels } : {}),
    ...(link ? { link } : {}),
    ...(stale !== undefined ? { stale } : {}),
    at: at || new Date(0).toISOString(),
    by: value.by === "agent" ? "agent" : "user",
    marker,
  };
  return hasField(out) ? out : null;
}

function hasField(value: object): boolean {
  return (
    MR_OVERRIDE_FIELDS.some(
      (field) => (value as Record<string, unknown>)[field] !== undefined,
    ) || (value as StoredMrOverride).depends_on !== undefined
  );
}

/** A change of an override: fields set, fields cleared. */
export type MrOverrideChange = {
  set?: Partial<Omit<MrOverride, "at" | "by" | "marker">>;
  clear?: MrOverrideField[] | "all";
};

/**
 * The override after a change, checked and capped; null when no field is
 * left (the row shows the inference again). Setting whose-move or the
 * next step anchors them to the request's activity now (`marker`).
 */
export function applyOverride(
  current: MrOverride | undefined,
  change: MrOverrideChange,
  meta: { by: "user" | "agent"; at: string; marker: string },
): MrOverride | null {
  const next: MrOverride = {
    ...(current ?? { at: meta.at, by: meta.by, marker: meta.marker }),
  };
  const clear = change.clear === "all" ? MR_OVERRIDE_FIELDS : change.clear;
  for (const field of clear ?? []) delete next[field];
  const set = change.set ?? {};
  if ("whose" in set) {
    const whose = whoseOf(set.whose);
    if (whose) next.whose = whose;
    else delete next.whose;
  }
  if ("next" in set) {
    const text = textOf(set.next, NEXT_MAX);
    if (text) next.next = text;
    else delete next.next;
  }
  if ("dependsOn" in set) {
    const keys = keysOf(set.dependsOn);
    if (keys) next.dependsOn = keys;
    else delete next.dependsOn;
  }
  if ("labels" in set) {
    const labels = labelsOf(set.labels);
    if (labels) next.labels = labels;
    else delete next.labels;
  }
  if ("link" in set) {
    const link = textOf(set.link, LINK_MAX);
    if (link) next.link = link;
    else delete next.link;
  }
  if ("stale" in set) {
    if (typeof set.stale === "boolean") next.stale = set.stale;
    else delete next.stale;
  }
  if (!MR_OVERRIDE_FIELDS.some((field) => next[field] !== undefined))
    return null;
  next.at = meta.at;
  next.by = meta.by;
  if ("whose" in set || "next" in set || "stale" in set || !current)
    next.marker = meta.marker;
  return next;
}

/** Whose-move and the next step were set before the request moved on. */
export function overrideOutdated(
  override: MrOverride,
  marker: string,
): boolean {
  return (
    (override.whose !== undefined ||
      override.next !== undefined ||
      override.stale !== undefined) &&
    !!override.marker &&
    override.marker !== marker
  );
}

/** Two overrides hold the same fields (the time and author aside). */
export function sameOverride(
  a: MrOverride | undefined,
  b: MrOverride | undefined,
): boolean {
  const strip = (value: MrOverride | undefined) =>
    value
      ? JSON.stringify(MR_OVERRIDE_FIELDS.map((field) => value[field] ?? null))
      : "";
  return strip(a) === strip(b);
}

/** Every key an override names: its own, and those it waits for. */
export function renameOverrideKeys(
  overrides: Record<string, MrOverride>,
  from: string,
  to: string,
): Record<string, MrOverride> {
  const out: Record<string, MrOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const renamed = value.dependsOn?.includes(from)
      ? {
          ...value,
          dependsOn: [
            ...new Set(
              value.dependsOn.map((each) => (each === from ? to : each)),
            ),
          ],
        }
      : value;
    out[key === from ? to : key] = renamed;
  }
  return out;
}
