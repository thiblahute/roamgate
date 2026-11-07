import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, replaceDataFile } from "../config/data-paths";

/** What is kept of a session a usage limit paused (by session id). */
export type LimitSessionRecord = {
  /**
   * The reset (epoch ms) of a pause seen before its resume time: it is
   * resumed even when that time passes while the server is down.
   */
  seen?: number;
  /** The reset a resume was sent for: one resume per reset. */
  resumed?: number;
  /** When that resume was sent (ISO time). */
  resumed_at?: string;
  /** The user's "Don't resume" for this session. */
  skip?: true;
  /** Last change (ISO time), to drop the oldest first. */
  at: string;
};

const MAX_SESSIONS = 2000;

/**
 * The sessions a usage limit paused, across restarts: which reset each was
 * seen paused by, the reset it was resumed for, and "Don't resume".
 */
export function createLimitResumeStore(
  options: { file?: string | null; now?: () => number } = {},
) {
  const file =
    options.file === undefined
      ? join(dataRoot(), "limit-resume.json")
      : options.file;
  const now = options.now ?? Date.now;
  let sessions: Map<string, LimitSessionRecord> | null = null;

  function load(): Map<string, LimitSessionRecord> {
    if (sessions) return sessions;
    sessions = new Map();
    if (!file) return sessions;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        sessions?: Record<string, LimitSessionRecord>;
      };
      for (const [id, record] of Object.entries(parsed.sessions ?? {}))
        if (record && typeof record === "object") sessions.set(id, record);
    } catch {
      // None yet.
    }
    return sessions;
  }

  function save() {
    if (!file) return;
    const all = load();
    while (all.size > MAX_SESSIONS) all.delete(all.keys().next().value!);
    replaceDataFile(
      file,
      `${JSON.stringify({ version: 1, sessions: Object.fromEntries(all) }, null, 2)}\n`,
    );
  }

  function change(
    sessionId: string,
    update: (record: LimitSessionRecord) => LimitSessionRecord,
  ) {
    const all = load();
    const current = all.get(sessionId) ?? { at: "" };
    const next = update({ ...current });
    next.at = new Date(now()).toISOString();
    // Most recent last, so the oldest go first past MAX_SESSIONS.
    all.delete(sessionId);
    const empty =
      next.seen === undefined && next.resumed === undefined && !next.skip;
    if (!empty) all.set(sessionId, next);
    save();
  }

  return {
    get(sessionId: string): LimitSessionRecord | null {
      return load().get(sessionId) ?? null;
    },
    /** A pause by the limit resetting at `resetsAt`, seen in time. */
    seen(sessionId: string, resetsAt: number) {
      if (load().get(sessionId)?.seen === resetsAt) return;
      change(sessionId, (record) => ({ ...record, seen: resetsAt }));
    },
    /** A resume was sent for the limit resetting at `resetsAt`. */
    resumed(sessionId: string, resetsAt: number) {
      change(sessionId, (record) => ({
        ...record,
        resumed: resetsAt,
        resumed_at: new Date(now()).toISOString(),
      }));
    },
    /** "Don't resume" for a session (true), or resumed again (false). */
    setSkip(sessionId: string, skip: boolean) {
      if (!!load().get(sessionId)?.skip === skip) return;
      change(sessionId, (record) => {
        const next = { ...record };
        if (skip) next.skip = true;
        else delete next.skip;
        return next;
      });
    },
  };
}

export type LimitResumeStore = ReturnType<typeof createLimitResumeStore>;

let shared: LimitResumeStore | null = null;
/** The server's store (tests make their own). */
export function limitResumeStore(): LimitResumeStore {
  shared ??= createLimitResumeStore();
  return shared;
}
