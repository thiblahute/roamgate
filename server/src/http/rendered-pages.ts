import { createHash, randomBytes } from "node:crypto";
import {
  listedDirectory,
  listedSite,
  parseSiteUrl,
  RENDERED_PREFIX,
  RENDERED_TOKEN,
  type RenderedMode,
  type RenderedRootMap,
} from "../../../shared/renderedPage";
import { renderedHelperSource } from "./rendered-helper";

/**
 * Pages of rendered reviews, served under `/rendered/<token>/<path>`: an
 * HTML file of a checkout with the files around it, or a site fetched by
 * this server. Requests come from an opaque-origin sandbox (CSP `sandbox`
 * without `allow-same-origin`, on every response), so they carry no
 * Roamgate cookie: the token is the credential, and they run before the
 * authentication gate. A page can never reach Roamgate's origin: its
 * requests there are cross-site and refused like any other site's.
 */

export type RenderedSource =
  /**
   * Files under `root`, an absolute directory on the connection's host.
   * `site`: the listed directory the pages are of. `walk`: `root` is that
   * directory as listed, which may not be where the site's root-absolute
   * links (`/docs/x.html`) start: one that is not found there looks for
   * the site's root in the directories above it (findRoot).
   */
  | { kind: "files"; root: string; site?: string; walk?: boolean }
  /** A site: pages under `base` (an http(s) URL ending in `/`). */
  | { kind: "url"; base: string }
  /** One page held here, whole: an SVG drawn by renderedSvgPage. */
  | { kind: "inline"; body: string };

export type RenderedEntry = {
  connectionId: string;
  mode: RenderedMode;
  source: RenderedSource;
  expiresAt: number;
};

/** A file read for a page: its bytes and size (a FileDownloadResult). */
export type RenderedFile = {
  body: BodyInit;
  size: number;
  contentType: string;
};

export const RENDERED_TTL_MS = 12 * 60 * 60 * 1000;
export const RENDERED_MAX_TOKENS = 500;
/**
 * The most a page reads of one file or response, a safety net against a
 * runaway file rather than a size guess: an HTML page or style sheet is
 * read whole to rewrite it, any other response of a site streams, and a
 * file read over SSH comes whole (a 3D model, a video). Larger ones are
 * refused before they are read. Local files other than pages and style
 * sheets stream, unbounded. The Files preview frames every HTML file and
 * leaves this limit to decide, not its text preview's.
 */
export const RENDERED_BODY_MAX_BYTES = 512 * 1024 * 1024;
const MIB = 1024 * 1024;
const TOO_LARGE_PAGE = `This page is too large to render here (${RENDERED_BODY_MAX_BYTES / MIB} MiB maximum). Use Source or Download from the file menu.`;
export const RENDERED_FETCH_TIMEOUT_MS = 30_000;
/**
 * A root-absolute URL of a page whose site's root is still to be found is
 * written under this segment, so its request says it is one.
 */
export const RENDERED_ROOT_MARK = ".roamgate-root";
/** How many directories above a listed one its site's root is looked for. */
export const SITE_ROOT_MAX_LEVELS = 8;
/** How long a root-absolute path found nowhere above is not looked for again. */
export const SITE_ROOT_MISS_MS = 30_000;
const REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xhtml: "application/xhtml+xml",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** The most an inline SVG page holds. */
export const RENDERED_SVG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * An SVG as a page of its own, unsanitized: the static policy (only the
 * helper's script runs, nothing is fetched) is what keeps it inert, and the
 * helper can pause it and draw it. `color` is the theme's text color, for
 * drawings in currentColor.
 */
export function renderedSvgPage(svg: string, color?: string): string {
  const text = /^(#[0-9a-f]{3,8}|rgba?\([0-9., %]+\))$/i.test(color ?? "")
    ? `color:${color};`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;${text}}svg{display:block;max-width:100%;height:auto}</style></head><body>${svg}</body></html>`;
}

export function renderedMime(path: string): string {
  const extension = path.toLowerCase().split("/").pop()?.split(".");
  if (!extension || extension.length < 2) return "application/octet-stream";
  return MIME[extension.pop()!] ?? "application/octet-stream";
}

/**
 * The page's policy. Never `allow-same-origin`: the page's origin is
 * opaque, whatever frames it or opens it. Static: only Roamgate's script
 * (its nonce) runs, and the page reaches nothing but its own files. Site:
 * the page's scripts and forms run, and it reaches its own site (through
 * here) and https resources.
 */
export function renderedCsp(mode: RenderedMode, nonce: string): string {
  if (mode === "static")
    return [
      "sandbox allow-scripts",
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline' data:",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self'",
      "connect-src 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-src 'self'",
      "worker-src 'none'",
      "frame-ancestors 'self'",
    ].join("; ");
  return [
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    "default-src 'self' https: data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
    "style-src 'self' 'unsafe-inline' https: data:",
    "img-src 'self' https: data: blob:",
    "font-src 'self' https: data:",
    "connect-src 'self' https:",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

function baseHeaders(mode: RenderedMode, nonce: string): Headers {
  return new Headers({
    "content-security-policy": renderedCsp(mode, nonce),
    "x-content-type-options": "nosniff",
    // A sandboxed page sends no Referer anyway; never leak its token.
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    // The page's origin is opaque: its fonts, modules and fetches to its
    // own files are cross-origin. The token in the path is the credential.
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  });
}

function plain(
  status: number,
  text: string,
  mode: RenderedMode = "static",
): Response {
  const headers = baseHeaders(mode, "none");
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(text, { status, headers });
}

/** The helper's tag, right after `<head>` (or `<html>`, or first). */
export function injectHelper(
  html: string,
  nonce: string,
  prefix: string,
  rootMap?: RenderedRootMap,
): string {
  const tag = `<script nonce="${nonce}">${renderedHelperSource(prefix, rootMap)}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) +
      tag +
      html.slice(head.index + head[0].length)
    );
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root)
    return (
      html.slice(0, root.index + root[0].length) +
      tag +
      html.slice(root.index + root[0].length)
    );
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length);
  return tag + html;
}

/**
 * A path under a token, as a relative path of its source: decoded per
 * segment, no `..`, `.`, empty inner segments or NULs. A directory (empty,
 * or ending in `/`) names its index.html. Null when refused.
 */
export function pagePath(rest: string): string | null {
  const segments = rest.split("/");
  const out: string[] = [];
  for (const [index, raw] of segments.entries()) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" && index === segments.length - 1) {
      out.push("index.html");
      continue;
    }
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    )
      return null;
    out.push(segment);
  }
  return out.join("/");
}

function isCss(contentType: string): boolean {
  return contentType.split(";")[0]!.trim().toLowerCase() === "text/css";
}

function isHtml(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/** A page's or style sheet's text, as UTF-8. */
function decoded(body: Uint8Array | string): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

/** A body cut off (with an error) past `max` bytes. */
function capped(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("response too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Root-absolute URLs (`/assets/app.js`) of a page under a token would reach
 * Roamgate's root, and a sandboxed page sends no Referer to tell whose
 * they are: they are written under the token instead, in the page's
 * attributes and styles (`map` gives the new path, or null to leave one).
 * URLs a script builds are not seen; a site built with its base URL
 * (hotdoc, Hugo's baseURL) needs none of this.
 */
export function rewriteRootUrls(
  text: string,
  kind: "html" | "css",
  map: (path: string) => string | null,
): string {
  const one = (url: string) =>
    url.startsWith("/") && !url.startsWith("//") ? (map(url) ?? url) : url;
  const css = (value: string) =>
    value
      .replace(
        /url\(\s*(["']?)(\/(?!\/)[^"')\s]*)\1\s*\)/gi,
        (_all, quote: string, url: string) =>
          `url(${quote}${one(url)}${quote})`,
      )
      .replace(
        /@import\s+(["'])(\/(?!\/)[^"']*)\1/gi,
        (_all, quote: string, url: string) =>
          `@import ${quote}${one(url)}${quote}`,
      );
  if (kind === "css") return css(text);
  return css(
    text
      .replace(
        /(\s(?:src|href|action|poster|data|formaction)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi,
        (_all, lead: string, quote: string, url: string) =>
          `${lead}${quote}${one(url)}${quote}`,
      )
      .replace(
        /(\s(?:src|href|action|poster|data|formaction)\s*=\s*)(\/(?!\/)[^\s>"']*)/gi,
        (_all, lead: string, url: string) => `${lead}"${one(url)}"`,
      )
      .replace(
        /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi,
        (_all, lead: string, quote: string, set: string) =>
          `${lead}${quote}${set
            .split(",")
            .map((part) =>
              part.replace(
                /^(\s*)(\S+)/,
                (_m, space: string, url: string) => `${space}${one(url)}`,
              ),
            )
            .join(",")}${quote}`,
      ),
  );
}

/** Whether a URL's host is the machine's own: localhost, 127.x, [::1]. */
function isLoopbackOrigin(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * A page built by a dev server (Hugo's `baseURL = http://localhost:1315/`)
 * links to itself by that origin, which would take its frame to the live
 * server. The page names its own origin in `rel=canonical` or `og:url`;
 * only when that is a loopback address, the URLs under it are written as
 * root-absolute paths, which `rewriteRootUrls` then puts under the token.
 * Other origins, and other loopback ports, are left alone.
 */
export function localizeLoopbackOrigin(
  html: string,
  map: (path: string) => string | null = () => null,
): string {
  let origin: string | null = null;
  for (const tag of html.match(/<(?:link|meta)\b[^>]*>/gi) ?? []) {
    const named =
      /\brel\s*=\s*["']?canonical\b/i.test(tag) ||
      /\bproperty\s*=\s*["']?og:url\b/i.test(tag);
    if (!named) continue;
    const value =
      /\b(?:href|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = value?.[1] ?? value?.[2] ?? value?.[3];
    if (!raw) continue;
    try {
      const url = new URL(raw.replace(/&amp;/gi, "&"));
      if (!isLoopbackOrigin(url)) continue;
      origin = url.origin;
      break;
    } catch {
      // not a URL: try the next one
    }
  }
  if (!origin) return html;
  const prefix = origin;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const under = (url: string) =>
    url.startsWith(`${prefix}/`)
      ? url.slice(prefix.length)
      : url === prefix
        ? "/"
        : url;
  const attrs =
    "src|href|action|poster|data|formaction|data-src|data-href|data-url|data-poster";
  return html
    .replace(
      new RegExp(
        `(\\s(?:${attrs})\\s*=\\s*)(["'])(${escaped}(?:/[^"']*)?)\\2`,
        "gi",
      ),
      (_all, lead: string, quote: string, url: string) =>
        `${lead}${quote}${under(url)}${quote}`,
    )
    .replace(
      new RegExp(
        `(\\s(?:${attrs})\\s*=\\s*)(${escaped}(?:/[^\\s>"']*)?)(?=[\\s>])`,
        "gi",
      ),
      (_all, lead: string, url: string) => `${lead}"${under(url)}"`,
    )
    .replace(
      /(\s(?:srcset|data-srcset)\s*=\s*)(["'])([^"']*)\2/gi,
      (_all, lead: string, quote: string, set: string) =>
        `${lead}${quote}${set
          .split(",")
          .map((part) =>
            part.replace(
              /^(\s*)(\S+)/,
              (_m, space: string, url: string) => `${space}${under(url)}`,
            ),
          )
          .join(",")}${quote}`,
    )
    .replace(/<meta\b[^>]*>/gi, (tag) =>
      /\b(?:property|name)\s*=\s*["']?(?:og|twitter):/i.test(tag)
        ? tag.replace(
            /(\scontent\s*=\s*)(["'])([^"']*)\2/i,
            (_all, lead: string, quote: string, url: string) => {
              const path = under(url);
              return `${lead}${quote}${path === url ? path : (map(path) ?? path)}${quote}`;
            },
          )
        : tag,
    )
    .replace(
      new RegExp(`url\\(\\s*(["']?)(${escaped}/[^"')\\s]*)\\1\\s*\\)`, "gi"),
      (_all, quote: string, url: string) =>
        `url(${quote}${under(url)}${quote})`,
    );
}

/** Request headers passed to a site; never cookies, credentials, origin. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  "if-range",
];
/** Response headers passed back from a site; never Set-Cookie. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "content-language",
];

export type RenderedPages = ReturnType<typeof createRenderedPages>;

export function createRenderedPages(args: {
  /** Reads a file of `root` on the connection's host, confined to it. */
  readFile: (
    connectionId: string,
    root: string,
    path: string,
  ) => Promise<RenderedFile>;
  /**
   * The nearest directory above `from` (siteRootCandidates) holding `path`,
   * on the connection's host; null when none does.
   */
  findRoot?: (
    connectionId: string,
    from: string,
    path: string,
  ) => Promise<string | null>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  ttlMs?: number;
  maxTokens?: number;
  fetchTimeoutMs?: number;
}) {
  const now = args.now ?? Date.now;
  const ttl = args.ttlMs ?? RENDERED_TTL_MS;
  const maxTokens = args.maxTokens ?? RENDERED_MAX_TOKENS;
  const fetchSite = args.fetch ?? ((url, init) => fetch(url, init));
  const entries = new Map<string, RenderedEntry>();
  /** The root found for a listed directory, per connection: [id, site]. */
  const siteRoots = new Map<string, string>();
  const rootMisses = new Map<string, number>();

  function prune() {
    const at = now();
    for (const [token, entry] of entries)
      if (entry.expiresAt <= at) entries.delete(token);
  }

  function keyOf(
    connectionId: string,
    mode: RenderedMode,
    source: RenderedSource,
  ) {
    return JSON.stringify([
      connectionId,
      mode,
      source.kind,
      source.kind === "files"
        ? [source.root, source.site ?? null, source.walk === true]
        : source.kind === "url"
          ? source.base
          : createHash("sha256").update(source.body).digest("hex"),
    ]);
  }

  /** A token for these pages: the same one while it lives, renewed. */
  function mint(params: {
    connectionId: string;
    mode: RenderedMode;
    source: RenderedSource;
  }): string {
    const { connectionId, mode, source } = params;
    if (source.kind === "files" && !source.root.startsWith("/"))
      throw new Error("pages are served from an absolute directory");
    if (source.kind === "url") {
      const base = new URL(source.base);
      if (
        (base.protocol !== "http:" && base.protocol !== "https:") ||
        base.username ||
        base.password ||
        !source.base.endsWith("/")
      )
        throw new Error("a site is an http(s) URL prefix");
    }
    prune();
    const key = keyOf(connectionId, mode, source);
    for (const [token, entry] of entries)
      if (keyOf(entry.connectionId, entry.mode, entry.source) === key) {
        entry.expiresAt = now() + ttl;
        return token;
      }
    // Oldest out first once full.
    while (entries.size >= maxTokens) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const token = randomBytes(16).toString("hex");
    entries.set(token, {
      connectionId,
      mode,
      source: { ...source },
      expiresAt: now() + ttl,
    });
    return token;
  }

  function entry(token: string): RenderedEntry | null {
    if (!RENDERED_TOKEN.test(token)) return null;
    const found = entries.get(token);
    if (!found) return null;
    if (found.expiresAt <= now()) {
      entries.delete(token);
      return null;
    }
    return found;
  }

  function revoke(token: string) {
    entries.delete(token);
  }

  /** `/rendered/<token>/<rest>` split; null for any other path. */
  function split(pathname: string): { token: string; rest: string } | null {
    if (!pathname.startsWith(RENDERED_PREFIX)) return null;
    const after = pathname.slice(RENDERED_PREFIX.length);
    const slash = after.indexOf("/");
    if (slash < 0) return { token: after, rest: "" };
    return { token: after.slice(0, slash), rest: after.slice(slash + 1) };
  }

  /**
   * Where the root-absolute URLs of a page under `token` go: a site's
   * base path onto the token, a listed folder still looking for its root
   * under the root mark, other files onto the token.
   */
  function rootMap(token: string, found: RenderedEntry): RenderedRootMap {
    const prefix = `${RENDERED_PREFIX}${token}/`;
    if (found.source.kind === "url")
      return { base: new URL(found.source.base).pathname, to: prefix };
    if (found.source.kind === "files" && found.source.walk)
      return { base: "/", to: `${prefix}${RENDERED_ROOT_MARK}/` };
    return { base: "/", to: prefix };
  }

  /** A root-absolute path of a page under `token`, as a path there. */
  function rootPath(token: string, path: string): string | null {
    const found = entry(token);
    if (!found) return null;
    const map = rootMap(token, found);
    return path.startsWith(map.base)
      ? `${map.to}${path.slice(map.base.length)}`
      : null;
  }

  /** The root found for a listed directory's site on the connection. */
  function siteRoot(connectionId: string, site: string): string | undefined {
    return siteRoots.get(JSON.stringify([connectionId, site]));
  }

  /**
   * The site's root for a root-absolute `path` not found in `found`'s
   * directory: the nearest directory above holding it, remembered for the
   * site, and a token for the pages from there. Null when none holds it.
   */
  async function findSiteRoot(
    found: RenderedEntry & { source: { kind: "files" } },
    path: string,
  ): Promise<string | null> {
    const { site, root } = found.source;
    if (!site) return null;
    const from = root.replace(/\/+$/, "");
    const known = siteRoot(found.connectionId, site);
    // Found already by another of the site's links: its pages go there.
    if (known && siteRootCandidates(from, "").includes(known))
      return mint({
        connectionId: found.connectionId,
        mode: found.mode,
        source: { kind: "files", root: known, site },
      });
    if (!args.findRoot) return null;
    const missKey = JSON.stringify([found.connectionId, root, path]);
    const missed = rootMisses.get(missKey);
    if (missed !== undefined && missed > now()) return null;
    const above = await args
      .findRoot(found.connectionId, root, path)
      .catch(() => null);
    // Only a directory above this one, never the one itself or elsewhere.
    if (
      !above ||
      !above.startsWith("/") ||
      above.includes("\0") ||
      above.split("/").some((part) => part === "." || part === "..") ||
      !siteRootCandidates(from, "").includes(above.replace(/\/+$/, ""))
    ) {
      for (const [key, until] of rootMisses)
        if (until <= now()) rootMisses.delete(key);
      rootMisses.set(missKey, now() + SITE_ROOT_MISS_MS);
      return null;
    }
    const top = above.replace(/\/+$/, "") || "/";
    siteRoots.set(JSON.stringify([found.connectionId, site]), top);
    return mint({
      connectionId: found.connectionId,
      mode: found.mode,
      source: { kind: "files", root: top, site },
    });
  }

  async function finishCss(
    body: Uint8Array | string,
    status: number,
    headers: Headers,
    token: string,
  ): Promise<Response> {
    headers.delete("content-length");
    headers.delete("content-range");
    headers.delete("accept-ranges");
    return new Response(
      rewriteRootUrls(decoded(body), "css", (path) => rootPath(token, path)),
      { status, headers },
    );
  }

  async function finishHtml(
    body: Uint8Array | string,
    status: number,
    headers: Headers,
    nonce: string,
    token: string,
  ): Promise<Response> {
    const found = entry(token);
    const text = decoded(body);
    const html = rewriteRootUrls(
      found?.source.kind === "files"
        ? localizeLoopbackOrigin(text, (path) => rootPath(token, path))
        : text,
      "html",
      (path) => rootPath(token, path),
    );
    headers.set("content-type", "text/html; charset=utf-8");
    headers.delete("content-length");
    headers.delete("content-range");
    headers.delete("accept-ranges");
    return new Response(
      injectHelper(
        html,
        nonce,
        `${RENDERED_PREFIX}${token}/`,
        found ? rootMap(token, found) : undefined,
      ),
      { status, headers },
    );
  }

  async function serveFile(
    found: RenderedEntry & { source: { kind: "files" } },
    token: string,
    rawRest: string,
    search: string,
    req: Request,
  ): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD")
      return plain(405, "method not allowed", found.mode);
    // A root-absolute URL of the page: relative to the site's root.
    const rooted = rawRest.startsWith(`${RENDERED_ROOT_MARK}/`);
    const rest = rooted
      ? rawRest.slice(RENDERED_ROOT_MARK.length + 1)
      : rawRest;
    const path = pagePath(rest);
    if (path === null) return plain(400, "invalid path", found.mode);
    const redirect = (location: string) => {
      const headers = baseHeaders(found.mode, "none");
      headers.set("location", location);
      return new Response(null, { status: 307, headers });
    };
    let file: RenderedFile;
    try {
      file = await args.readFile(found.connectionId, found.source.root, path);
    } catch (error) {
      if (
        rooted &&
        found.source.walk &&
        (error as { status?: unknown } | null)?.status !== 413
      ) {
        const next = await findSiteRoot(found, path);
        if (next) {
          // A page needs the new token for its relative links; anything
          // else is served from the site's root at once, as a redirect
          // would break a stylesheet loaded with CORS and an integrity
          // hash from the sandboxed page's opaque origin.
          const nextEntry = isHtml(renderedMime(path)) ? null : entry(next);
          if (nextEntry && nextEntry.source.kind === "files")
            return serveFile(
              nextEntry as RenderedEntry & { source: { kind: "files" } },
              next,
              rest,
              search,
              req,
            );
          return redirect(`${RENDERED_PREFIX}${next}/${rest}${search}`);
        }
      }
      // A file read over SSH and over its limit.
      if ((error as { status?: unknown } | null)?.status === 413)
        return plain(
          413,
          `${path} is too large to read here (${RENDERED_BODY_MAX_BYTES / MIB} MiB maximum).`,
          found.mode,
        );
      // Which file was tried, and why, so the frame says it.
      const reason = error instanceof Error ? error.message.split("\n")[0] : "";
      return plain(
        404,
        `not found: ${found.source.root.replace(/\/+$/, "")}/${path}${reason ? `\n${reason}` : ""}`,
        found.mode,
      );
    }
    // A directory reads as an archive: its index instead.
    if (file.contentType === "application/gzip" && !/\.t?gz$/i.test(path)) {
      const location = `${RENDERED_PREFIX}${token}/${rest.replace(/\/?$/, "/")}`;
      const headers = baseHeaders(found.mode, "none");
      headers.set("location", location);
      return new Response(null, { status: 308, headers });
    }
    const type = renderedMime(path);
    // A page reached by a root-absolute link found here: at its own
    // address, so its relative links and what it reports stay plain.
    if (rooted && isHtml(type)) {
      await new Response(file.body).body?.cancel().catch(() => undefined);
      return redirect(`${RENDERED_PREFIX}${token}/${rest}${search}`);
    }
    const nonce = randomBytes(16).toString("base64");
    const headers = baseHeaders(found.mode, nonce);
    headers.set("content-type", type);
    if (isHtml(type)) {
      if (file.size > RENDERED_BODY_MAX_BYTES)
        return plain(413, TOO_LARGE_PAGE, found.mode);
      if (req.method === "HEAD") {
        await new Response(file.body).body?.cancel().catch(() => undefined);
        return new Response(null, { status: 200, headers });
      }
      // Decoded as it is read: no copy of its bytes kept beside the text.
      const text = await new Response(file.body).text();
      return finishHtml(text, 200, headers, nonce, token);
    }
    if (isCss(type) && req.method !== "HEAD") {
      if (file.size > RENDERED_BODY_MAX_BYTES)
        return plain(
          413,
          `${path} is too large a style sheet (${RENDERED_BODY_MAX_BYTES / MIB} MiB maximum).`,
          found.mode,
        );
      const text = await new Response(file.body).text();
      return finishCss(text, 200, headers, token);
    }
    headers.set("content-length", String(file.size));
    return new Response(req.method === "HEAD" ? null : file.body, {
      status: 200,
      headers,
    });
  }

  async function serveInline(
    found: RenderedEntry & { source: { kind: "inline" } },
    token: string,
    rest: string,
    req: Request,
  ): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD")
      return plain(405, "method not allowed", found.mode);
    if (rest !== "" && rest !== "index.html")
      return plain(404, "not found", found.mode);
    const nonce = randomBytes(16).toString("base64");
    const headers = baseHeaders(found.mode, nonce);
    headers.set("content-type", "text/html; charset=utf-8");
    if (req.method === "HEAD")
      return new Response(null, { status: 200, headers });
    return finishHtml(
      new TextEncoder().encode(found.source.body),
      200,
      headers,
      nonce,
      token,
    );
  }

  /** A site URL as the path under its token; null when off the site. */
  function underBase(base: string, url: string): string | null {
    return url.startsWith(base) ? url.slice(base.length) : null;
  }

  async function serveSite(
    found: RenderedEntry & { source: { kind: "url" } },
    token: string,
    rest: string,
    search: string,
    req: Request,
  ): Promise<Response> {
    const { base } = found.source;
    const allowed =
      found.mode === "site"
        ? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
        : ["GET", "HEAD"];
    if (!allowed.includes(req.method))
      return plain(405, "method not allowed", found.mode);
    let target: string;
    try {
      target = new URL(rest + search, base).href;
    } catch {
      return plain(400, "invalid path", found.mode);
    }
    if (underBase(base, target) === null)
      return plain(404, "outside the site", found.mode);
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const read = await readCapped(req.body, REQUEST_BODY_MAX_BYTES);
      if (read === null) return plain(413, "request too large", found.mode);
      body = read;
    }
    let response: Response | null = null;
    let current = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      try {
        response = await fetchSite(current, {
          method: req.method,
          headers,
          ...(body ? { body } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(
            args.fetchTimeoutMs ?? RENDERED_FETCH_TIMEOUT_MS,
          ),
        });
      } catch {
        return plain(502, "the site did not answer", found.mode);
      }
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) break;
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        return plain(502, "the site redirected nowhere", found.mode);
      }
      const inside = underBase(base, next);
      if (inside === null)
        return plain(
          502,
          `the site redirected off itself: ${next.slice(0, 300)}`,
          found.mode,
        );
      // A navigation follows in the frame, so its address stays true;
      // anything else is followed here.
      if (
        req.headers.get("sec-fetch-dest") === "iframe" ||
        req.headers.get("sec-fetch-mode") === "navigate"
      ) {
        const out = baseHeaders(found.mode, "none");
        out.set("location", `${RENDERED_PREFIX}${token}/${inside}`);
        await response.body?.cancel().catch(() => undefined);
        return new Response(null, { status: response.status, headers: out });
      }
      await response.body?.cancel().catch(() => undefined);
      current = next;
      response = null;
    }
    if (!response) return plain(502, "too many redirects", found.mode);
    const nonce = randomBytes(16).toString("base64");
    const out = baseHeaders(found.mode, nonce);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    const type =
      response.headers.get("content-type") ??
      renderedMime(new URL(current).pathname);
    out.set("content-type", type);
    if (isHtml(type) && req.method !== "HEAD") {
      const bytes = await readCapped(response.body, RENDERED_BODY_MAX_BYTES);
      if (bytes === null) return plain(413, "page too large", found.mode);
      return finishHtml(bytes, response.status, out, nonce, token);
    }
    if (isCss(type) && req.method !== "HEAD") {
      const bytes = await readCapped(response.body, RENDERED_BODY_MAX_BYTES);
      if (bytes === null)
        return plain(413, "style sheet too large", found.mode);
      return finishCss(bytes, response.status, out, token);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > RENDERED_BODY_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return plain(413, "response too large", found.mode);
    }
    if (length !== null) out.set("content-length", length);
    return new Response(
      req.method === "HEAD" || !response.body
        ? null
        : capped(response.body, RENDERED_BODY_MAX_BYTES),
      { status: response.status, headers: out },
    );
  }

  /** The response for a `/rendered/` path; null for any other path. */
  function handle(req: Request, url: URL): Promise<Response> | null {
    const parts = split(url.pathname);
    if (!parts) return null;
    const found = entry(parts.token);
    if (!found)
      return Promise.resolve(
        plain(404, "this page expired: open it again from Roamgate"),
      );
    if (found.source.kind === "inline")
      return serveInline(
        found as RenderedEntry & { source: { kind: "inline" } },
        parts.token,
        parts.rest,
        req,
      );
    if (found.source.kind === "files")
      return serveFile(
        found as RenderedEntry & { source: { kind: "files" } },
        parts.token,
        parts.rest,
        url.search,
        req,
      );
    return serveSite(
      found as RenderedEntry & { source: { kind: "url" } },
      parts.token,
      parts.rest,
      url.search,
      req,
    );
  }

  return { mint, entry, revoke, handle, siteRoot };
}

const NOT_PART = "not part of this site";

/**
 * A request a page's frame made off its token, for a path of Roamgate's:
 * a navigation a page's script built (`location.href = "/docs/x.html"`) or
 * a fetch the helper could not write under its token. The frame's opaque
 * origin makes it cross-site and cookieless, and it sends no Referer to
 * tell whose it is: Roamgate's login page (or any route behind the gate)
 * is never what it gets. A frame's navigation gets a page saying so, whose
 * script hands the path to the parent, which knows the token (RenderedFrame
 * sends it back under it); anything else from an opaque origin a 404.
 * Null for any other request: the authentication gate decides those.
 */
export function renderedStray(req: Request, url: URL): Response | null {
  if (url.pathname.startsWith(RENDERED_PREFIX)) return null;
  if (req.headers.get("sec-fetch-site") !== "cross-site") return null;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest !== "iframe" && dest !== "frame") {
    if (req.headers.get("origin") === "null")
      return plain(404, `${NOT_PART}: ${url.pathname.slice(0, 300)}`);
    return null;
  }
  const nonce = randomBytes(16).toString("base64");
  const headers = baseHeaders("static", nonce);
  headers.set("content-type", "text/html; charset=utf-8");
  const path = (url.pathname + url.search)
    .slice(0, 300)
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const script = `try{parent.postMessage({roamgate:"rendered",type:"stray",url:(location.pathname+location.search).slice(0,2048)},"*")}catch(e){}`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Not part of this site</title><style>body{font:14px system-ui,sans-serif;margin:2em;color:#555}code{word-break:break-all}</style></head><body><p>This address is ${NOT_PART}: <code>${path}</code></p><script nonce="${nonce}">${script}</script></body></html>`,
    { status: 404, headers },
  );
}

/**
 * The directories a listed directory's site root may be, nearest first:
 * those above `from`, at most SITE_ROOT_MAX_LEVELS, never `/`, nor `home`
 * or a directory above it (whose files a page must not reach).
 */
export function siteRootCandidates(from: string, home: string): string[] {
  const out: string[] = [];
  const homeDir = home.replace(/\/+$/, "");
  let at = from.replace(/\/+$/, "");
  while (out.length < SITE_ROOT_MAX_LEVELS) {
    at = at.slice(0, at.lastIndexOf("/"));
    if (!at) break;
    if (homeDir && `${homeDir}/`.startsWith(`${at}/`)) break;
    out.push(at);
  }
  return out;
}

/**
 * The shell script finding a site's root on a host over SSH: the first of
 * siteRootCandidates(from, $HOME) holding `path`, printed; exit 44 if none.
 */
export function siteRootScript(
  from: string,
  path: string,
  shQuote: (value: string) => string,
): string {
  return `set -u
d=${shQuote(from.replace(/\/+$/, ""))}
rel=${shQuote(path)}
home="\${HOME:-}"; home="\${home%/}"
n=0
while [ "$n" -lt ${SITE_ROOT_MAX_LEVELS} ]; do
  d="\${d%/*}"
  [ -n "$d" ] || exit 44
  if [ -n "$home" ]; then case "$home/" in "$d"/*) exit 44 ;; esac; fi
  if [ -e "$d/$rel" ]; then printf '%s\\n' "$d"; exit 0; fi
  n=$((n+1))
done
exit 44
`;
}

/** How long a file read over SSH is kept for the pages that follow. */
export const RENDERED_REMOTE_CACHE_MS = 15_000;
/**
 * What all kept files may weigh together; a file larger than this is read
 * each time, never kept. Kept files go once their time is up, read or not.
 */
export const RENDERED_REMOTE_CACHE_BYTES = 1024 * 1024 * 1024;

/**
 * The pages' file reader for every connection: files of this host read
 * here, a connection over SSH's read on its host, as the Files view reads
 * them (the same download helpers). `path` is always relative to `root`
 * and confined to it (links followed), so a page reaches the files of its
 * directory and nothing above.
 *
 * A read over SSH is a process on the far host, and a site's pages share
 * their style sheets, scripts and images: a remote file is kept for a few
 * seconds (within a total), keyed by connection, root and
 * path, so moving through a site does not read them again each page.
 */
export function connectionFileReader(deps: {
  /** The connection's SSH destination; none for this host. */
  sshHost: (connectionId: string) => string | null | undefined;
  readLocal: (root: string, path: string) => Promise<RenderedFile>;
  readRemote: (
    host: string,
    root: string,
    path: string,
  ) => Promise<RenderedFile>;
  now?: () => number;
  cacheMs?: number;
  cacheFileBytes?: number;
  cacheBytes?: number;
}) {
  const now = deps.now ?? Date.now;
  const cacheMs = deps.cacheMs ?? RENDERED_REMOTE_CACHE_MS;
  const totalMax = deps.cacheBytes ?? RENDERED_REMOTE_CACHE_BYTES;
  const fileMax = Math.min(deps.cacheFileBytes ?? totalMax, totalMax);
  const kept = new Map<
    string,
    { bytes: Uint8Array; contentType: string; until: number }
  >();
  let keptBytes = 0;
  function drop(key: string) {
    const found = kept.get(key);
    if (!found) return;
    keptBytes -= found.bytes.byteLength;
    kept.delete(key);
  }
  function copy(bytes: Uint8Array, contentType: string): RenderedFile {
    return { body: bytes.slice(), size: bytes.byteLength, contentType };
  }
  // Kept files go once their time is up, even when nothing reads again.
  let sweeping: ReturnType<typeof setTimeout> | null = null;
  function sweep() {
    sweeping = null;
    const at = now();
    for (const [old, entry] of kept) if (entry.until <= at) drop(old);
    if (kept.size) {
      sweeping = setTimeout(sweep, cacheMs);
      sweeping.unref?.();
    }
  }
  return async (
    connectionId: string,
    root: string,
    path: string,
  ): Promise<RenderedFile> => {
    // pagePath already refuses these; never hand the helpers an absolute
    // path (they read those anywhere) or a step up.
    if (
      !root.startsWith("/") ||
      !path ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === "." || !part)
    )
      throw new Error("invalid path");
    const host = deps.sshHost(connectionId);
    if (!host) return deps.readLocal(root, path);
    const key = JSON.stringify([connectionId, root, path]);
    const at = now();
    const hit = kept.get(key);
    if (hit && hit.until > at) {
      // Most recently used last: the oldest go first.
      kept.delete(key);
      kept.set(key, hit);
      return copy(hit.bytes, hit.contentType);
    }
    drop(key);
    const file = await deps.readRemote(host, root, path);
    // A directory reads as an archive (served as a redirect to its
    // index): never kept, whatever size it says.
    if (
      file.size > fileMax ||
      cacheMs <= 0 ||
      file.contentType === "application/gzip"
    )
      return file;
    // Its bytes as read (a Buffer over SSH), not a copy of them.
    const bytes =
      file.body instanceof Uint8Array
        ? file.body
        : new Uint8Array(await new Response(file.body).arrayBuffer());
    for (const [old, entry] of kept) if (entry.until <= at) drop(old);
    while (keptBytes + bytes.byteLength > totalMax && kept.size) {
      const oldest = kept.keys().next().value;
      if (oldest === undefined) break;
      drop(oldest);
    }
    if (keptBytes + bytes.byteLength <= totalMax) {
      kept.set(key, {
        bytes,
        contentType: file.contentType,
        until: at + cacheMs,
      });
      keptBytes += bytes.byteLength;
      if (!sweeping) {
        sweeping = setTimeout(sweep, cacheMs);
        sweeping.unref?.();
      }
    }
    return copy(bytes, file.contentType);
  };
}

/**
 * The pages' site root finder (createRenderedPages' findRoot) for every
 * connection: the directories above a listed one are tried here for this
 * host, or by one command (siteRootScript) on a connection's host over SSH.
 */
export function connectionRootFinder(deps: {
  sshHost: (connectionId: string) => string | null | undefined;
  /** This host's home directory. */
  home: string;
  exists: (path: string) => Promise<boolean>;
  /** Runs a shell script on the host: its exit code and output. */
  runRemote: (
    host: string,
    script: string,
  ) => Promise<{ code: number; stdout: string }>;
  shQuote: (value: string) => string;
}) {
  return async (
    connectionId: string,
    from: string,
    path: string,
  ): Promise<string | null> => {
    if (
      !from.startsWith("/") ||
      pagePath(path) !== path ||
      path.split("/").some((part) => part === "." || part === "..")
    )
      return null;
    const host = deps.sshHost(connectionId);
    if (!host) {
      for (const candidate of siteRootCandidates(from, deps.home))
        if (await deps.exists(`${candidate}/${path}`)) return candidate;
      return null;
    }
    const result = await deps.runRemote(
      host,
      siteRootScript(from, path, deps.shQuote),
    );
    const found = result.stdout.trim();
    return result.code === 0 && found.startsWith("/") ? found : null;
  };
}

/** The http(s) URL's directory: its origin and path up to the last `/`. */
export function urlDirectory(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/[^/]*$/, "")}`;
}

/**
 * What a rendered review's page is served from, and the path under its
 * token: an HTML file of the checkout (with the files of its directory),
 * or a site's URL. Listed sites and directories (the user's) run their
 * scripts; anything else is static. Throws when there is no page to serve.
 */
export function renderedAddress(params: {
  target: { path?: string; url?: string };
  root: string;
  sites: readonly string[];
  page?: string;
  /** The user turned scripts on for this file or site, listed or not. */
  scripts?: boolean;
  /**
   * A listed site's root, when not the listed entry itself: the root set
   * for it in Settings (`explicit`), or the one found for its directory.
   * Root-absolute links start there, and nothing above it is served.
   */
  rootOf?: (site: string) => { root: string; explicit: boolean } | undefined;
}): {
  mode: RenderedMode;
  source: RenderedSource;
  rest: string;
  site?: string;
} {
  const { target, root, sites, page, scripts, rootOf } = params;
  /** The listed site's root, if one is set and contains it. */
  const siteRootOf = (site: string | null) => {
    if (!site) return undefined;
    const found = rootOf?.(site);
    if (!found) return undefined;
    const top = found.root.endsWith("/") ? found.root : `${found.root}/`;
    return site.startsWith(top) &&
      !top.split("/").some((part) => part === "." || part === "..")
      ? { ...found, root: top }
      : undefined;
  };
  if (target.path !== undefined) {
    const path = target.path;
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === ".." || part === "." || !part)
    )
      throw new Error("invalid path");
    if (!/\.x?html?$/i.test(path))
      throw new Error("only HTML files are shown as pages");
    const absolute = `${root.replace(/\/+$/, "")}/${path}`;
    // Served from the listed folder, or else the checkout: a page's
    // relative links reach their siblings and parents, nothing above.
    const site = listedDirectory(sites, absolute);
    const siteRoot = siteRootOf(site);
    // Scripts on for this one file: only its own folder is served.
    const directory = site
      ? (siteRoot?.root ?? site).replace(/\/+$/, "") || "/"
      : scripts
        ? absolute.slice(0, absolute.lastIndexOf("/")) || "/"
        : root;
    const inside = absolute.slice(directory.replace(/\/+$/, "").length + 1);
    let rest = inside.split("/").map(encodeURIComponent).join("/");
    if (page !== undefined) {
      // As the helper reports it: a path under the directory, its query.
      const query = page.indexOf("?");
      const pathPart = query < 0 ? page : page.slice(0, query);
      if (pagePath(pathPart) === null) throw new Error("invalid page");
      rest = page;
    }
    return {
      mode: site || scripts ? "site" : "static",
      source: site
        ? {
            kind: "files",
            root: directory,
            site,
            // Its root is looked for above it until found or set.
            ...(siteRoot ? {} : { walk: true }),
          }
        : { kind: "files", root: directory },
      rest,
      ...(site ? { site } : {}),
    };
  }
  const url = parseSiteUrl(target.url);
  if (!url) throw new Error("a rendered review shows a file or an http(s) URL");
  const site = listedSite(sites, url);
  // A site's root set in Settings: its root-absolute links start there.
  const explicit = siteRootOf(site);
  const base = (explicit?.explicit ? explicit.root : site) ?? urlDirectory(url);
  let at = url;
  if (page !== undefined) {
    let next: string;
    try {
      next = new URL(page, base).href;
    } catch {
      throw new Error("invalid page");
    }
    if (!next.startsWith(base)) throw new Error("the page is off the site");
    at = next;
  }
  return {
    mode: site || scripts ? "site" : "static",
    source: { kind: "url", base },
    rest: at.slice(base.length),
    ...(site ? { site } : {}),
  };
}
