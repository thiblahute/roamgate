import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentChatLease } from "../../../shared/agentChat";
import { dataRoot, replaceDataFile } from "../config/data-paths";

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

/**
 * Who owns each conversation-mode session, kept on disk so a Roamgate
 * restart finds the sessions its headless processes owned (their holders
 * stay in the panes). One file for every connection; each store reads and
 * writes only its own connection's entries. No entry means the terminal
 * owns the pane's session.
 */
export function createLeaseStore(options: {
  connectionId: string;
  /** null keeps leases in memory only. */
  file?: string | null;
  now?: () => number;
}) {
  const file = options.file === undefined ? defaultLeaseFile() : options.file;
  const now = options.now ?? Date.now;
  let leases: Map<string, AgentChatLease> | null = null;

  function readAll(): AgentChatLease[] {
    if (!file) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        leases?: unknown;
      };
      return Array.isArray(parsed.leases)
        ? parsed.leases.filter(validLease)
        : [];
    } catch {
      return [];
    }
  }

  function load(): Map<string, AgentChatLease> {
    leases ??= new Map(
      readAll()
        .filter((lease) => lease.connection_id === options.connectionId)
        .map((lease) => [lease.pane_id, lease]),
    );
    return leases;
  }

  function save() {
    if (!file) return;
    const others = readAll().filter(
      (lease) => lease.connection_id !== options.connectionId,
    );
    replaceDataFile(
      file,
      `${JSON.stringify({ version: 1, leases: [...others, ...load().values()] }, null, 2)}\n`,
    );
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
