import { relativePathWithinCheckout } from "./workspaceResource";
import { resolveWorkspaceMarkdownPath } from "./workspaceFileUrl";

/**
 * The files a review comment names, as links Roamgate opens in Files: a
 * Markdown link to a path of the review's repository (relative to it, or to
 * the commented file with `./` and `../`), to an absolute path (in a
 * checkout Roamgate knows, else anywhere on the host), to `~/` (the host's
 * home), or a `file://` URL; plain `path:line` references, and plain
 * absolute or `~/` paths to a file.
 */

/** Where a comment's file links lead from: its review and the checkouts around it. */
export type FileLinkScope = {
  /** The review's repository root: a relative path is in it. */
  root?: string;
  /**
   * Checkouts a file may be named in by its absolute path: the root, the
   * workspace's checkout, the repository of the file shown.
   */
  checkouts?: readonly string[];
  /** The file commented on, in the root: `./a` and `../a` are beside it. */
  documentPath?: string;
};

/**
 * A file a comment names, as Files opens it: its repository and path there.
 * A file outside every checkout has the filesystem's root (`/`, `C:/`) or
 * the host's home (`~`) for root.
 */
export type FileLink = {
  root: string;
  path: string;
  line?: number;
  endLine?: number;
  /** A heading of the file (`#heading`). */
  fragment?: string;
};

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
/** `path:line`, `path:line-end`, `path:line:column` (the column dropped). */
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:-(\d+))?(?::\d+)?)?$/;

function sameRoot(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The checkout `absolute` is in (the scope's root first) and its path there. */
function inCheckouts(
  absolute: string,
  scope: FileLinkScope,
): { root: string; path: string } | null {
  const roots = [scope.root, ...(scope.checkouts ?? [])].filter(
    (root): root is string => !!root,
  );
  for (const root of roots) {
    const path = relativePathWithinCheckout(root, absolute);
    if (path) return { root, path };
  }
  return null;
}

/** `/a/b`, its empty and `.` parts dropped; null with a `..` part. */
function normalAbsolute(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) return null;
  return `/${parts.join("/")}`;
}

/**
 * The file a link's target names, or null when it is not a file here: a
 * web address, a path outside every checkout, a heading of the comment.
 */
export function resolveFileLink(
  target: string,
  scope: FileLinkScope,
): FileLink | null {
  let text = target.trim();
  if (!text || text.startsWith("#") || text.startsWith("//")) return null;
  if (text.includes("\0")) return null;
  // file:///path, on this host.
  if (/^file:/i.test(text)) {
    try {
      const url = new URL(text);
      if (url.hostname && url.hostname !== "localhost") return null;
      text = decoded(url.pathname) + url.hash;
      if (!text.startsWith("/")) return null;
    } catch {
      return null;
    }
  }
  const hash = text.indexOf("#");
  const fragment = hash < 0 ? "" : decoded(text.slice(hash + 1));
  const located = (hash < 0 ? text : text.slice(0, hash)).split("?", 1)[0]!;
  const match = LINE_SUFFIX.exec(located);
  if (!match) return null;
  const [, pathPart, lineText, endText] = match;
  if (!pathPart) return null;
  if (SCHEME.test(pathPart) && !WINDOWS_DRIVE.test(pathPart)) return null;
  const line = lineText ? Number(lineText) : undefined;
  const endLine = endText ? Number(endText) : undefined;
  const at = {
    ...(line ? { line } : {}),
    ...(line && endLine && endLine > line ? { endLine } : {}),
    ...(fragment ? { fragment } : {}),
  };
  const path = decoded(pathPart).replace(/\\/g, "/");
  if (path === "~" || path.startsWith("~/")) {
    const inHome = normalAbsolute(path.slice(1));
    return inHome && inHome !== "/"
      ? { root: "~", path: inHome.slice(1), ...at }
      : null;
  }
  if (path.startsWith("/") || WINDOWS_DRIVE.test(path)) {
    const found = inCheckouts(path, scope);
    if (found) return { ...found, ...at };
    // A checkout itself is no file to show.
    if (
      [scope.root, ...(scope.checkouts ?? [])].some(
        (each) => each && sameRoot(each, path),
      )
    )
      return null;
    // Anywhere else on the host: Files reads it by its absolute path.
    const drive = WINDOWS_DRIVE.test(path) ? path.slice(0, 2) : "";
    const absolute = normalAbsolute(path.slice(drive.length));
    if (!absolute || absolute === "/") return null;
    return { root: `${drive}/`, path: absolute.slice(1), ...at };
  }
  if (!scope.root) return null;
  // `./a` and `../a` are beside the commented file; any other path is in
  // the repository.
  const beside = /^\.\.?\//.test(path) && scope.documentPath;
  const resolved = resolveWorkspaceMarkdownPath(
    path,
    beside ? scope.documentPath! : "",
  );
  if (!resolved || /^(?:\/|[a-z]:\/)/i.test(resolved)) return null;
  return { root: scope.root, path: resolved, ...at };
}

/**
 * How Files opens a linked file: at its line, in the source, else rendered
 * (a Markdown file as a page); in a tab of its own for a middle or Ctrl
 * click.
 */
export function fileLinkAt(
  link: FileLink,
  how: { newTab: boolean },
): { root: string; line?: number; rendered?: boolean; newTab?: boolean } {
  return {
    root: link.root,
    ...(link.line !== undefined ? { line: link.line } : { rendered: true }),
    ...(how.newTab ? { newTab: true } : {}),
  };
}

/** `path:line-end`, the path review-relative when the file is in the review. */
export function fileLinkLabel(link: FileLink, scope: FileLinkScope): string {
  const path =
    scope.root && sameRoot(link.root, scope.root)
      ? link.path
      : `${link.root.replace(/[\\/]+$/, "")}/${link.path}`;
  return path + lineSuffix(link);
}

/** The file's absolute path with its lines: what a hover says. */
export function fileLinkTitle(link: FileLink): string {
  return `${link.root.replace(/[\\/]+$/, "")}/${link.path}${lineSuffix(link)}`;
}

function lineSuffix(link: FileLink): string {
  return link.line
    ? `:${link.line}${link.endLine ? `-${link.endLine}` : ""}`
    : "";
}

/**
 * A plain `path:line` reference in text (`web/src/a.ts:12`, `a.md:3-5`,
 * `/abs/a.ts:7:3`): a path with a directory or an extension, then its
 * line. Not inside a word, a URL or another reference.
 */
const REFERENCE =
  /(?<![\w/.:@~-])((?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*):(\d+)(?:-(\d+))?(?::\d+)?(?![\w/])/g;

export type FileReference = { start: number; end: number; text: string };

/**
 * Whether `text` is one `name:line` reference whole, the name a bare file
 * name (`Makefile:3`): a file when set apart in backticks.
 */
export function bareFileReference(text: string): boolean {
  return /^(?:\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*:\d+(?:-\d+)?(?::\d+)?$/.test(
    text.trim(),
  );
}

/**
 * An absolute or `~/` path written plainly (`/tmp/out/a.wav`,
 * `~/notes.md:3`), its line optional; not ending in the sentence's
 * punctuation.
 */
const PATH_REFERENCE =
  /(?<![\w/.:@~-])((?:~|[A-Za-z]:)?\/(?:[\w.@+%=,-]+\/)*[\w@+%=-](?:[\w.@+%=,-]*[\w@+%=-])?)(?::(\d+)(?:-(\d+))?(?::\d+)?)?(?![\w/])/g;

/**
 * The `path:line` references written plainly in `text`, and the absolute
 * and `~/` paths to a file (a name with an extension, or anything in `~/`)
 * without a line.
 */
export function findFileReferences(text: string): FileReference[] {
  const found: FileReference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const path = match[1]!;
    if (!path.includes("/") && !/\.[A-Za-z0-9]+$/.test(path)) continue;
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  for (const match of text.matchAll(PATH_REFERENCE)) {
    const path = match[1]!;
    const start = match.index;
    const end = start + match[0].length;
    if (
      !match[2] &&
      !path.startsWith("~/") &&
      !/[^/]\.[A-Za-z0-9]+$/.test(path)
    )
      continue;
    if (found.some((each) => start < each.end && end > each.start)) continue;
    found.push({ start, end, text: match[0] });
  }
  return found.sort((a, b) => a.start - b.start);
}
