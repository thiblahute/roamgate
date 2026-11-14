import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** The archive directory's name under the data root. */
export const ARCHIVE_DIR_NAME = "archive";
/** What the default directory was called before it was renamed. */
export const LEGACY_ARCHIVE_DIR_NAME = "claude-archive";

/**
 * The archive directory: an explicit one (flag, env, setting) as given, else
 * `<data root>/archive`. A default directory that does not exist yet while the
 * legacy one does is renamed in place once (same parent, so atomic).
 */
export function resolveArchiveDir(
  explicit: string | undefined,
  dataRoot: string,
  log: (message: string) => void = () => {},
): string {
  const given = explicit?.trim();
  if (given) return given;
  const dir = join(dataRoot, ARCHIVE_DIR_NAME);
  const legacy = join(dataRoot, LEGACY_ARCHIVE_DIR_NAME);
  if (!existsSync(dir) && existsSync(legacy)) {
    try {
      renameSync(legacy, dir);
      log(`archive: renamed ${legacy} to ${dir}`);
    } catch (error) {
      log(
        `archive: could not rename ${legacy} to ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }; using the old directory`,
      );
      return legacy;
    }
  }
  return dir;
}

/** A warning when both the default directory and the legacy one exist. */
export function legacyArchiveWarning(archiveDir: string): string | null {
  if (!archiveDir.endsWith(`/${ARCHIVE_DIR_NAME}`)) return null;
  const legacy = join(dirname(archiveDir), LEGACY_ARCHIVE_DIR_NAME);
  return existsSync(legacy)
    ? `${legacy} still exists next to ${archiveDir}; ${archiveDir} is used, merge or remove the old one`
    : null;
}
