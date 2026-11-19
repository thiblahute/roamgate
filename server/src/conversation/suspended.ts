import { readFileSync } from "node:fs";
import { replaceDataFile } from "../config/data-paths";
import type { PaneProcess } from "./herdr";

/**
 * A conversation stopped as a shell job (the chat's Ctrl+Z): its holder
 * waits stopped in the pane's shell, and `fg` there brings it back. The
 * holder keeps what the session needs; this is what the browsers are
 * shown of it (the terminal's banner, its fg button).
 */
export type SuspendedConversation = {
  pane_id: string;
  session_id: string;
  /** The conversation's title when it was stopped. */
  title?: string;
  /** The agent conversation mode drove; absent: claude. */
  agent?: string;
  suspended_at: string;
  /** The stopped holder's pid on the pane's host: gone, the job is too. */
  holder_pid?: number;
  /**
   * The session id the holder was started with, which its job's command
   * line shows (the conversation's may have changed since: /clear).
   */
  job?: string;
};

function valid(value: unknown): value is SuspendedConversation & {
  connection_id: string;
} {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.connection_id === "string" &&
    typeof entry.pane_id === "string" &&
    typeof entry.session_id === "string" &&
    typeof entry.suspended_at === "string"
  );
}

function readAll(file: string) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      suspended?: unknown;
    };
    return Array.isArray(parsed.suspended)
      ? parsed.suspended.filter(valid)
      : [];
  } catch {
    return [];
  }
}

/**
 * The conversations stopped as shell jobs, per pane of one connection,
 * kept on disk (when given a file) so a Roamgate restart still shows them.
 * Other connections' entries in the file are kept as they are.
 */
export function createSuspendedStore(options: {
  connectionId: string;
  /** null keeps them in memory only. */
  file?: string | null;
}) {
  const file = options.file ?? null;
  const entries = new Map<string, SuspendedConversation>();
  if (file)
    for (const entry of readAll(file)) {
      if (entry.connection_id !== options.connectionId) continue;
      const rest: SuspendedConversation & { connection_id?: string } = {
        ...entry,
      };
      delete rest.connection_id;
      entries.set(rest.pane_id, rest);
    }

  function save() {
    if (!file) return;
    const others = readAll(file).filter(
      (entry) => entry.connection_id !== options.connectionId,
    );
    const mine = [...entries.values()].map((entry) => ({
      connection_id: options.connectionId,
      ...entry,
    }));
    try {
      replaceDataFile(
        file,
        `${JSON.stringify({ version: 1, suspended: [...others, ...mine] })}\n`,
      );
    } catch {
      // Kept in memory; the next change writes it again.
    }
  }

  return {
    get: (paneId: string): SuspendedConversation | null =>
      entries.get(paneId) ?? null,
    all: (): SuspendedConversation[] => [...entries.values()],
    set(entry: SuspendedConversation) {
      entries.set(entry.pane_id, entry);
      save();
    },
    /** True when there was one. */
    delete(paneId: string): boolean {
      if (!entries.delete(paneId)) return false;
      save();
      return true;
    },
  };
}

export type SuspendedStore = ReturnType<typeof createSuspendedStore>;

/** The shell's program name ("bash", "zsh", "fish"), from Herdr's listing. */
export function shellName(process: PaneProcess | undefined): string {
  const word =
    process?.argv0 ?? process?.argv?.[0] ?? process?.cmdline?.split(" ")[0];
  return (word ?? "").replace(/^-/, "").split("/").pop() ?? "";
}

/**
 * What is typed into the pane's shell to bring a stopped conversation's
 * job back: that job by name, never the shell's current one (another job
 * the user stopped since). fish names jobs by pid; the others by a word of
 * their command line, the session id the holder was started with. Quoted:
 * zsh would read `?` as a pattern.
 */
export function foregroundCommand(
  entry: Pick<SuspendedConversation, "session_id" | "holder_pid" | "job">,
  shell: string,
): string {
  if (shell === "fish" && entry.holder_pid) return ` fg ${entry.holder_pid}\r`;
  const word = entry.job ?? entry.session_id;
  if (!/^[0-9a-f-]{8,64}$/i.test(word)) throw new Error("invalid session id");
  return ` fg '%?${word}'\r`;
}

const SESSION_ID = /^[0-9a-f-]{8,64}$/i;

/** What a holder's request says of itself and its shell; null: nothing. */
export function parseHolderShell(form: URLSearchParams): {
  jobControl: boolean;
  pid?: number;
  job?: string;
} | null {
  const jobControl = form.get("job_control");
  if (jobControl === null) return null;
  const pid = Number(form.get("holder_pid"));
  const job = form.get("job") ?? "";
  return {
    jobControl: jobControl === "1",
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(SESSION_ID.test(job) ? { job } : {}),
  };
}

/**
 * What a stopped holder brought back with `fg` kept of its session; null
 * when it is not one (an invalid session id or directory, say).
 */
export function parseSuspendedSpec(form: URLSearchParams): {
  session_id: string;
  cwd: string;
  terminal_args?: string[];
} | null {
  const sessionId = form.get("session") ?? "";
  const cwd = form.get("cwd") ?? "";
  if (!SESSION_ID.test(sessionId) || !cwd.startsWith("/")) return null;
  let args: unknown;
  try {
    args = JSON.parse(form.get("terminal_args") ?? "[]");
  } catch {
    return null;
  }
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every((each) => typeof each === "string" && each.length < 4096)
  )
    return null;
  return {
    session_id: sessionId,
    cwd,
    ...(args.length ? { terminal_args: args as string[] } : {}),
  };
}
