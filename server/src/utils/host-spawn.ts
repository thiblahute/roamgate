/**
 * host-spawn, which runs a command on the host from a toolbox: the one that
 * runs. PATH may hold a broken one before the real one (an empty, root-owned
 * 0700 ~/.local/bin/host-spawn was found before /usr/bin's on the desktop),
 * and Bun.spawn and Bun.which take the first file of that name, executable
 * or not, so a bare "host-spawn" failed with EACCES.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Where the toolbox packages install host-spawn: tried before PATH. */
export const HOST_SPAWN_PATHS = [
  "/usr/bin/host-spawn",
  "/usr/local/bin/host-spawn",
];

/** Whether path is a non-empty file this process may execute. */
export function runnable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host-spawn to run: the first runnable one of the known paths, then of
 * PATH's directories; null when none runs.
 */
export function hostSpawnPath(
  path = process.env.PATH ?? "",
  known = HOST_SPAWN_PATHS,
): string | null {
  for (const candidate of known) if (runnable(candidate)) return candidate;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "host-spawn");
    if (runnable(candidate)) return candidate;
  }
  return null;
}
