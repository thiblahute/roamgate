/**
 * The history repo's status (server/src/history), for Settings' "History
 * and backup" section and `roamgate history status`.
 */

export type HistoryCommitInfo = {
  sha: string;
  subject: string;
  /** Its author date (ISO 8601). */
  at: string;
  author: string;
};

/** A secret found in a file: the file stays out of the commit. */
export type HistoryBlocked = {
  file: string;
  line: number;
  /** What was found, never the secret itself ("glpat-... token"). */
  kind: string;
};

export type HistoryError = {
  area?: string;
  message: string;
  at: string;
};

export type HistoryStatus = {
  /** Local history is on (it is by default). */
  enabled: boolean;
  /** Where the repo is. */
  location: string;
  /** Where it is when Settings set none. */
  defaultLocation: string;
  /** The repo exists there. */
  exists: boolean;
  lastCommit: HistoryCommitInfo | null;
  commits: number;
  /** The repo's size on disk, its .git included. */
  sizeBytes: number;
  /** Tracked files by area (top-level directory or file). */
  files: Record<string, number>;
  /** The last pass: when, how long, how many commits. */
  lastPass: { at: string; ms: number; commits: number } | null;
  blocked: HistoryBlocked[];
  errors: HistoryError[];
  /** Areas changed and waiting for the next pass (the server only). */
  pending: string[];
  /** A pass is running now (the server only). */
  running: boolean;
  /** Why the heavy work waits ("a game is running"), when it does. */
  deferred: string | null;
};

/** The history setting in settings.json. */
export type HistorySettings = {
  /** False turns local history off (on by default). */
  enabled?: boolean;
  /** The repo's directory (absent: `<data>/history`). */
  location?: string;
};

export function normalizeHistorySettings(
  raw: unknown,
): HistorySettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const out: HistorySettings = {};
  if (typeof value.enabled === "boolean") out.enabled = value.enabled;
  if (typeof value.location === "string" && value.location.trim())
    out.location = value.location.trim();
  return Object.keys(out).length ? out : undefined;
}
