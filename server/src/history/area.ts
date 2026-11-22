import { homedir } from "node:os";
import { join } from "node:path";
import { dataRoot, defaultDataFile } from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import type { ReviewSession, ReviewThread } from "../../../shared/review";
import { voiceDataDir } from "../voice/voice-models";

/**
 * An area of the history repo: one store's authored data, written as files
 * under its own directory (the allowlist: a store without an area is never
 * written). Its render is the whole truth for the paths it owns: a file
 * there that the render does not give is removed.
 */
export type HistoryArea = {
  name: string;
  /**
   * Source files (or directories, whose entries count) whose changes mark
   * the area changed, by their size and modification time: hand edits
   * count too.
   */
  watch?: () => string[];
  /**
   * The area's files, every one (`ids` null), or those of the ids changed
   * (an area that takes ids; others render whole either way).
   */
  render(ids: ReadonlySet<string> | null): AreaRender | Promise<AreaRender>;
  /** A short summary of changed paths for the commit message. */
  describe?: (paths: readonly string[]) => string;
};

export type AreaRender = {
  /** Repo-relative path to its content. */
  files: Map<string, string | Uint8Array>;
  /**
   * Paths this render speaks for: a file, or a directory ending in `/`.
   * Files under them that are not in `files` are removed.
   */
  owns: string[];
};

/** Where the stores are: the server's paths, or a CLI's for a service. */
export type HistoryPaths = {
  data: string;
  settings: string;
  connections: string;
  reviews: string;
  work: string;
  /** The voice's shared data directory (`low-gpu.json`). */
  voiceData: string;
};

export function historyPaths(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
  platform: string = process.platform,
  appDataDir: string | undefined = process.env.APPDATA,
): HistoryPaths {
  const data = dataRoot(home, platform, appDataDir);
  return {
    data,
    settings:
      roamgateEnv("SETTINGS_PATH", environment) ??
      defaultDataFile("settings.json", home, platform, appDataDir),
    connections:
      roamgateEnv("CONNECTIONS_PATH", environment) ??
      defaultDataFile("connections.json", home, platform, appDataDir),
    reviews: roamgateEnv("REVIEW_DIR", environment) ?? join(data, "reviews"),
    work: roamgateEnv("WORK_DIR", environment) ?? join(data, "work"),
    voiceData: voiceDataDir(home, platform, appDataDir),
  };
}

/** The review store as the history reads it. */
export type ReviewSource = {
  loadSessions(): ReviewSession[];
  loadThreads(sessionId: string): ReviewThread[];
};

/** "3 files", "1 file". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
