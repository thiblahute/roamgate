import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentChatLease } from "../../../shared/agentChat";
import {
  type DataFileWriter,
  dataFileWriter,
  dataRoot,
} from "../config/data-paths";

export function defaultLeaseFile(): string {
  return join(dataRoot(), "conversation-leases.json");
}

function validLease(value: unknown): value is AgentChatLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Record<string, unknown>;
  return (
    typeof lease.connection_id === "string" &&
    typeof lease.pane_id === "string" &&
    typeof lease.session_id === "string" &&
    typeof lease.cwd === "string" &&
    (lease.owner === "terminal" || lease.owner === "conversation") &&
    (lease.phase === "terminal" ||
      lease.phase === "to_conversation" ||
      lease.phase === "conversation" ||
      lease.phase === "to_terminal")
  );
}

function readLeaseFile(file: string): AgentChatLease[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      leases?: unknown;
    };
    return Array.isArray(parsed.leases) ? parsed.leases.filter(validLease) : [];
  } catch {
    return [];
  }
}

/**
 * A lease file as this process knows it: read once, then every
 * connection's store changes it here and it is written behind them
 * (dataFileWriter). Holders save their read offsets every second or so,
 * many panes at once: each change rewriting (and syncing) the file on the
 * event loop stalled every call for as long as the disk took.
 */
type LeaseFile = {
  byConnection: Map<string, Map<string, AgentChatLease>>;
  writer: DataFileWriter;
};
const leaseFiles = new Map<string, LeaseFile>();

function leaseFile(path: string): LeaseFile {
  let known = leaseFiles.get(path);
  if (!known) {
    const byConnection = new Map<string, Map<string, AgentChatLease>>();
    for (const lease of readLeaseFile(path)) {
      let leases = byConnection.get(lease.connection_id);
      if (!leases) {
        leases = new Map();
        byConnection.set(lease.connection_id, leases);
      }
      leases.set(lease.pane_id, lease);
    }
    // The next change tries again; the leases stay in memory.
    known = { byConnection, writer: dataFileWriter(path) };
    leaseFiles.set(path, known);
  }
  return known;
}

function leaseContents(file: LeaseFile): string {
  const leases = [...file.byConnection.values()].flatMap((each) => [
    ...each.values(),
  ]);
  return `${JSON.stringify({ version: 1, leases })}\n`;
}

/** Every lease file written as it is now (tests, shutdown). */
export async function flushLeaseFiles(): Promise<void> {
  for (const file of leaseFiles.values()) await file.writer.flush();
}

/** Forget what this process knows of lease files: the next store reads them. */
export function forgetLeaseFiles(): void {
  leaseFiles.clear();
}

/**
 * Who owns each conversation-mode session, kept on disk so a Roamgate
 * restart finds the sessions its headless processes owned (their holders
 * stay in the panes). One file for every connection; each store changes
 * only its own connection's entries. No entry means the terminal owns the
 * pane's session.
 */
export function createLeaseStore(options: {
  connectionId: string;
  /** null keeps leases in memory only. */
  file?: string | null;
  now?: () => number;
}) {
  const file = options.file === undefined ? defaultLeaseFile() : options.file;
  const now = options.now ?? Date.now;
  let memory: Map<string, AgentChatLease> | null = null;

  function load(): Map<string, AgentChatLease> {
    if (!file) return (memory ??= new Map());
    const shared = leaseFile(file);
    let leases = shared.byConnection.get(options.connectionId);
    if (!leases) {
      leases = new Map();
      shared.byConnection.set(options.connectionId, leases);
    }
    return leases;
  }

  function save() {
    if (!file) return;
    const shared = leaseFile(file);
    shared.writer.write(() => leaseContents(shared));
  }

  return {
    get: (paneId: string): AgentChatLease | null => load().get(paneId) ?? null,
    all: (): AgentChatLease[] => [...load().values()],
    /** The lease of the pane holding this session, if any. */
    bySession: (sessionId: string): AgentChatLease | null =>
      [...load().values()].find((lease) => lease.session_id === sessionId) ??
      null,
    set(
      lease: Omit<AgentChatLease, "connection_id" | "updated_at" | "owner">,
    ): AgentChatLease {
      const next: AgentChatLease = {
        ...lease,
        connection_id: options.connectionId,
        owner:
          lease.phase === "conversation" || lease.phase === "to_terminal"
            ? "conversation"
            : "terminal",
        updated_at: new Date(now()).toISOString(),
      };
      load().set(lease.pane_id, next);
      save();
      return next;
    },
    /** The terminal owns the pane's session again. */
    delete(paneId: string) {
      if (!load().delete(paneId)) return;
      save();
    },
  };
}

export type LeaseStore = ReturnType<typeof createLeaseStore>;
