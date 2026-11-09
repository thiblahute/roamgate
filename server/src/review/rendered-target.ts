import { posix } from "node:path";
import type { ReviewTarget } from "../../../shared/review";
import { ReviewError } from "./service";

/**
 * A file to show rendered: its checkout's root (or, outside any, its
 * directory) and its path relative to that. `file` is absolute, or
 * relative to `cwd`; paths are the connection host's (POSIX).
 */
export async function renderedFileTarget(
  readRoot: (directory: string) => Promise<string>,
  file: string,
  cwd = "",
): Promise<{ root: string; target: ReviewTarget }> {
  const path = posix.normalize(
    file.startsWith("/") || !cwd.startsWith("/") ? file : posix.join(cwd, file),
  );
  if (!path.startsWith("/") || path.includes("\0"))
    throw new ReviewError("the file must be absolute");
  let root: string;
  try {
    root = await readRoot(posix.dirname(path));
  } catch {
    root = posix.dirname(path);
  }
  let relative = posix.relative(root, path);
  // The checkout's root as Git resolved it (links followed) may not
  // prefix the path as given: the file's directory is the root then.
  if (!relative || relative === ".." || relative.startsWith("../")) {
    root = posix.dirname(path);
    relative = posix.basename(path);
  }
  if (!relative || relative === "." || path.endsWith("/"))
    throw new ReviewError("give a file, not a directory");
  return { root, target: { kind: "rendered", path: relative } };
}
