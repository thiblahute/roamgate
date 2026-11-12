/**
 * Pages of a rendered review (an HTML file of a checkout, or a site) are
 * served by Roamgate under `/rendered/<token>/...` in an opaque-origin
 * sandbox. A small script Roamgate injects in each page tells the parent
 * what the user points at; this is that conversation and the list of
 * sites the user works on (which run with their scripts).
 */

/** Where pages are served from: `/rendered/<token>/<path>`. */
export const RENDERED_PREFIX = "/rendered/";

/** A token: 32 hex digits. */
export const RENDERED_TOKEN = /^[0-9a-f]{32}$/;

/**
 * static: the page's own scripts are blocked (only Roamgate's runs) and it
 * reaches nothing but its own files. site: a site the user listed, its
 * scripts and forms on, still in an opaque origin.
 */
export type RenderedMode = "static" | "site";

/**
 * Where a page's root-absolute URLs go (RenderedFrameMessage ready), and
 * `home`: the directory of the file or URL the frame was opened on, as a
 * path under the token ("" or ending in `/`).
 */
export type RenderedRootMap = { base: string; to: string; home?: string };

/** A home: a relative directory path, "" or ending in `/`, no dot parts. */
export function validHome(home: string): boolean {
  if (home === "") return true;
  if (!home.endsWith("/") || home.length > 1024 || /[?#\\]/.test(home))
    return false;
  return home
    .slice(0, -1)
    .split("/")
    .every((part) => !!part && !/^(\.|%2e){1,2}$/i.test(part));
}

function splitPage(url: string): { path: string; tail: string } {
  const at = url.search(/[?#]/);
  return at < 0
    ? { path: url, tail: "" }
    : { path: url.slice(0, at), tail: url.slice(at) };
}

/**
 * A page under a token (its path and query, as the frame says it) as a
 * path from the frame's home: the same page whatever directory the token
 * serves (another token may serve one above it), so it is found again.
 */
export function pageFromHome(url: string, home: string): string {
  const { path, tail } = splitPage(url);
  const homeParts = home.split("/").slice(0, -1);
  const parts = path.split("/");
  let common = 0;
  while (
    common < homeParts.length &&
    common < parts.length - 1 &&
    parts[common] === homeParts[common]
  )
    common++;
  return `${"../".repeat(homeParts.length - common)}${parts.slice(common).join("/")}${tail}`;
}

/**
 * A page kept from its home (pageFromHome) as a path under a token whose
 * home is `home`; null when it is above what the token serves.
 */
export function pageUnderHome(page: string, home: string): string | null {
  const { path, tail } = splitPage(page);
  const parts = home.split("/").slice(0, -1);
  const rest = path.split("/");
  while (rest[0] === "..") {
    if (!parts.length) return null;
    parts.pop();
    rest.shift();
  }
  if (rest.some((part) => /^(\.|%2e){1,2}$/i.test(part))) return null;
  return `${[...parts, ...rest].join("/")}${tail}`;
}

const ROOT_TO = /^\/rendered\/[0-9a-f]{32}\/(\.roamgate-root\/)?$/;

/**
 * Where a root-absolute `url` (path and query) of a page goes under its
 * token, by its root map; null when it is off the page's site or would
 * leave the token (a `..`, an encoded slash, a backslash).
 */
export function strayTarget(url: string, root: RenderedRootMap): string | null {
  if (!url.startsWith(root.base) || !ROOT_TO.test(root.to)) return null;
  const rest = url.slice(root.base.length);
  const path = rest.split(/[?#]/)[0]!;
  if (
    path
      .split("/")
      .some((part) => /^(\.|%2e){1,2}$/i.test(part) || /%2f|%5c|\\/i.test(part))
  )
    return null;
  return root.to + rest;
}

/** The frame's script to the parent. */
export type RenderedFrameMessage =
  | {
      roamgate: "rendered";
      type: "ready";
      /** The page shown: its path and query under the token. */
      url: string;
      title: string;
      /**
       * Where its root-absolute URLs go: a path under `base` is written
       * under `to`, a `/rendered/<token>/` path (rendered-pages.ts rootMap).
       */
      root?: RenderedRootMap;
    }
  /**
   * The frame left its token for one of Roamgate's paths (a script's
   * navigation): Roamgate's page saying so, with that path and query.
   */
  | { roamgate: "rendered"; type: "stray"; url: string }
  | {
      roamgate: "rendered";
      type: "select";
      url: string;
      quote: string;
      selector: string;
      /** The selection's box in the frame's viewport, in CSS pixels. */
      rect: { x: number; y: number; w: number; h: number };
    }
  | {
      roamgate: "rendered";
      type: "point";
      url: string;
      selector: string;
      /** The element pointed at: an SVG element's id, else its text. */
      element?: string;
      /** In fractions of the element's box (the graphic). */
      region: { x: number; y: number; w: number; h: number };
      rect: { x: number; y: number; w: number; h: number };
      /** Where its animations were when they were paused: "2.4 s". */
      moment?: string;
      /** A PNG of the region as the page drew it, when it could be made. */
      snapshot?: string;
    }
  | { roamgate: "rendered"; type: "clear" }
  /** A key of the threads pressed in the page (RENDERED_THREAD_KEYS). */
  | { roamgate: "rendered"; type: "key"; key: string }
  /** Back (-1) or Forward (1) pressed in the page: Alt+arrows, Cmd+[ / ]. */
  | { roamgate: "rendered"; type: "history"; step: -1 | 1 }
  /** How far down the page is scrolled, as it is read. */
  | { roamgate: "rendered"; type: "scroll"; y: number }
  /** The page's script went to `url` without loading a page (pushState). */
  | { roamgate: "rendered"; type: "location"; url: string }
  /** How tall the page's content is, for a frame sized to it. */
  | { roamgate: "rendered"; type: "size"; height: number }
  /** A write of a listed site's page to its localStorage (see below). */
  | ({ roamgate: "rendered"; type: "storage" } & RenderedStorageWrite);

/**
 * What a listed site's pages keep in `localStorage`: their sandbox has no
 * storage of its own (an opaque origin), so the helper holds it in memory,
 * seeded by the server with what the site stored, and hands every write to
 * the parent, which sends it to the server. Bounded like a real Storage:
 * a write over it is refused as a QuotaExceededError.
 */
export const RENDERED_STORAGE_MAX_CHARS = 256 * 1024;
export const RENDERED_STORAGE_MAX_KEYS = 200;

export type RenderedStorageWrite =
  | { op: "set"; key: string; value: string }
  | { op: "remove"; key: string }
  | { op: "clear" };

/** The characters a Storage holds: its keys and values, together. */
export function storageChars(items: Record<string, string>): number {
  let chars = 0;
  for (const [key, value] of Object.entries(items))
    chars += key.length + value.length;
  return chars;
}

/** A write checked, or null when it is not exactly one of the shapes. */
export function parseStorageWrite(raw: unknown): RenderedStorageWrite | null {
  if (!raw || typeof raw !== "object") return null;
  const write = raw as Record<string, unknown>;
  if (write.op === "clear") return { op: "clear" };
  const key = write.key;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > RENDERED_STORAGE_MAX_CHARS
  )
    return null;
  if (write.op === "remove") return { op: "remove", key };
  if (write.op !== "set") return null;
  const value = write.value;
  if (
    typeof value !== "string" ||
    key.length + value.length > RENDERED_STORAGE_MAX_CHARS
  )
    return null;
  return { op: "set", key, value };
}

/**
 * The keys of the threads drawn in the Files preview (useThreadKeys: j / k,
 * n / N, gg / G, gn / gN / gH, g;, za, zz / zt / zb, c, R, r, dd, T) and its
 * `o` and Esc, and `:` for the view's command line: a page's frame has
 * them while it has the focus, so its script hands these, and only these,
 * to Roamgate. Typing in the page's fields keeps them, and so does a key
 * the page itself handled, but for `:`, which always opens the prompt.
 */
export const RENDERED_THREAD_KEYS: readonly string[] = [
  "j",
  "k",
  "n",
  "N",
  "g",
  "G",
  "H",
  "z",
  "a",
  "t",
  "b",
  "c",
  "R",
  "r",
  "d",
  "T",
  ";",
  "o",
  "Escape",
  ":",
];

/** The parent to the frame's script. */
export type RenderedParentMessage =
  | {
      roamgate: "rendered";
      /** Scroll to a thread's place and flash it. */
      type: "show";
      selector?: string;
      quote?: string;
    }
  | {
      roamgate: "rendered";
      /** A click (or drag) points at a graphic instead of following it. */
      type: "pointMode";
      on: boolean;
    }
  | {
      roamgate: "rendered";
      /** The comment is written or dropped: the graphic moves again. */
      type: "resume";
    }
  | {
      roamgate: "rendered";
      /** Back or Forward to this page: where it was left. */
      type: "scrollTo";
      y: number;
    };

/** The largest snapshot a page may send: a PNG data URL. */
export const FRAME_SNAPSHOT_MAX = 4 * 1024 * 1024;

const MAX_TEXT = 4000;

function shortText(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function box(
  value: unknown,
  fraction: boolean,
): { x: number; y: number; w: number; h: number } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out = { x: 0, y: 0, w: 0, h: 0 };
  for (const key of ["x", "y", "w", "h"] as const) {
    const number = raw[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    if (fraction && (number < 0 || number > 1)) return null;
    if (!fraction && Math.abs(number) > 1e6) return null;
    out[key] = number;
  }
  return out;
}

/**
 * A message from a page's frame, checked: the page is untrusted, so
 * anything that is not exactly one of these shapes, in bounds, is null.
 */
export function parseFrameMessage(data: unknown): RenderedFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (raw.roamgate !== "rendered") return null;
  if (raw.type === "clear") return { roamgate: "rendered", type: "clear" };
  if (raw.type === "storage") {
    const write = parseStorageWrite(raw);
    return write ? { roamgate: "rendered", type: "storage", ...write } : null;
  }
  if (raw.type === "key")
    return typeof raw.key === "string" && RENDERED_THREAD_KEYS.includes(raw.key)
      ? { roamgate: "rendered", type: "key", key: raw.key }
      : null;
  if (raw.type === "history")
    return raw.step === -1 || raw.step === 1
      ? { roamgate: "rendered", type: "history", step: raw.step }
      : null;
  if (raw.type === "scroll") {
    const { y } = raw;
    if (typeof y !== "number" || !Number.isFinite(y)) return null;
    return {
      roamgate: "rendered",
      type: "scroll",
      y: Math.min(1e7, Math.max(0, Math.round(y))),
    };
  }
  if (raw.type === "size") {
    const { height } = raw;
    if (typeof height !== "number" || !Number.isFinite(height)) return null;
    return {
      roamgate: "rendered",
      type: "size",
      height: Math.min(4000, Math.max(16, Math.round(height))),
    };
  }
  const url = shortText(raw.url, 2048);
  if (url === null) return null;
  if (raw.type === "ready") {
    const title = shortText(raw.title, 300) ?? "";
    const root = raw.root as Record<string, unknown> | null | undefined;
    const base = shortText(root?.base, 1024);
    const to = shortText(root?.to, 100);
    const home = shortText(root?.home, 1024);
    return {
      roamgate: "rendered",
      type: "ready",
      url,
      title,
      ...(base !== null &&
      to !== null &&
      /^\/([^?#]*\/)?$/.test(base) &&
      ROOT_TO.test(to)
        ? {
            root: {
              base,
              to,
              ...(home && validHome(home) ? { home } : {}),
            },
          }
        : {}),
    };
  }
  if (raw.type === "location")
    return { roamgate: "rendered", type: "location", url };
  if (raw.type === "stray")
    return url.startsWith("/") && !url.startsWith("//")
      ? { roamgate: "rendered", type: "stray", url }
      : null;
  const selector = shortText(raw.selector, 1000);
  const rect = box(raw.rect, false);
  if (selector === null || !rect) return null;
  if (raw.type === "select") {
    const quote = shortText(raw.quote)?.trim();
    if (!quote) return null;
    return { roamgate: "rendered", type: "select", url, quote, selector, rect };
  }
  if (raw.type === "point") {
    const region = box(raw.region, true);
    if (!region) return null;
    const element = shortText(raw.element, 200) ?? undefined;
    const moment = shortText(raw.moment, 40) ?? undefined;
    const snapshot = shortText(raw.snapshot, FRAME_SNAPSHOT_MAX) ?? undefined;
    return {
      roamgate: "rendered",
      type: "point",
      url,
      selector,
      region,
      rect,
      ...(element ? { element } : {}),
      ...(moment ? { moment } : {}),
      ...(snapshot && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(snapshot)
        ? { snapshot }
        : {}),
    };
  }
  return null;
}

/**
 * The sites the user works on, as kept: http(s) URL prefixes ending in
 * `/`, without credentials, query or fragment. Anything else is dropped.
 */
export function normalizeSiteList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const sites = new Set<string>();
  for (const entry of value.slice(0, 100)) {
    const site = normalizeSite(entry);
    if (site) sites.add(site);
  }
  return [...sites];
}

export function normalizeSite(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const trimmed = value.trim();
  // A directory of the checkouts' host: its HTML files run their scripts.
  if (trimmed.startsWith("/")) {
    if (
      trimmed.includes("\0") ||
      trimmed.split("/").some((part) => part === ".." || part === ".")
    )
      return null;
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const path = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname.replace(/[^/]*$/, "")}`;
  return `${url.origin}${path}`;
}

/**
 * The roots set for listed sites, as kept: for each listed site (a key of
 * `sites`), a site or directory (normalizeSite) that contains it, where its
 * pages' root-absolute links (`/docs/x.html`) start. Anything else is dropped.
 */
export function normalizeSiteRoots(
  value: unknown,
  sites: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [site, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!sites.includes(site)) continue;
    const root = normalizeSite(raw);
    if (root && site.startsWith(root)) out[site] = root;
  }
  return out;
}

/** The listed directory an absolute file path is under, if any. */
export function listedDirectory(
  sites: readonly string[],
  path: string,
): string | null {
  if (!path.startsWith("/")) return null;
  return (
    sites.find((site) => site.startsWith("/") && path.startsWith(site)) ?? null
  );
}

/** The listed site a URL is under, if any. */
export function listedSite(
  sites: readonly string[],
  url: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const href = `${parsed.origin}${parsed.pathname}`;
  return sites.find((site) => href.startsWith(site)) ?? null;
}

/** An http(s) URL a review may open, cleaned of credentials and fragment. */
export function parseSiteUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return url.href;
}
