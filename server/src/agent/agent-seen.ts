import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSafeDataPath,
  dataRoot,
  replaceDataFile,
} from "../config/data-paths";
import { roamgateEnv } from "../config/environment";
import { isRecord } from "./session-utils";

/**
 * Which turns of each agent the user has seen in Roamgate, wherever Herdr
 * is focused. Herdr counts an agent finishing in its focused Space as seen
 * at once, and has one focus for every client: an agent there never shows
 * Done, even to a user who is looking at something else on another device.
 * The browser marks an agent seen when it is on screen; an agent is Done
 * when it finished a turn (its state changed) since.
 */
export type AgentSeenStore = {
  /**
   * The state an agent was last seen finished in (-1 when it was only seen
   * working), or null if Roamgate never saw it.
   */
  seen(connectionId: string, paneId: string, terminalId: string): number | null;
  /**
   * Records a look at the agent, now: in this finished state when `seq` is
   * given. True when it was not yet seen in that state.
   */
  mark(
    connectionId: string,
    paneId: string,
    terminalId: string,
    seq?: number,
  ): boolean;
  /**
   * Herdr's agent list with each finished agent's own Done: `seen_done` is
   * true when it changed state since it was last seen in Roamgate, false
   * when it has not. Agents Roamgate never saw keep Herdr's. `seen_at` is
   * when the user last looked at the agent, if ever.
   */
  annotate(connectionId: string, result: unknown): unknown;
};

type Entry = { seq: number; at: number };
type Saved = {
  version: 1;
  connections: Record<string, Record<string, Entry>>;
};

/** Seen marks kept per connection, the oldest dropped beyond it. */
const MAX_PER_CONNECTION = 2000;

export function agentSeenPath(
  environment: Record<string, string | undefined> = process.env,
  root = dataRoot(),
): string {
  return (
    roamgateEnv("AGENT_SEEN_PATH", environment) ?? join(root, "agent-seen.json")
  );
}

function load(path: string): Saved {
  try {
    if (!existsSync(path)) return { version: 1, connections: {} };
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.connections))
      return { version: 1, connections: {} };
    const connections: Saved["connections"] = {};
    for (const [connection, entries] of Object.entries(value.connections)) {
      if (!isRecord(entries)) continue;
      const kept: Record<string, Entry> = {};
      for (const [key, entry] of Object.entries(entries))
        if (
          isRecord(entry) &&
          Number.isSafeInteger(entry.seq) &&
          Number.isFinite(entry.at)
        )
          kept[key] = { seq: entry.seq as number, at: entry.at as number };
      connections[connection] = kept;
    }
    return { version: 1, connections };
  } catch {
    // A damaged file only forgets what was seen: Herdr's Done comes back.
    return { version: 1, connections: {} };
  }
}

const keyOf = (paneId: string, terminalId: string) =>
  `${paneId}\u0000${terminalId}`;

export function createAgentSeenStore(
  path = agentSeenPath(),
  now: () => number = Date.now,
): AgentSeenStore {
  const saved = load(path);
  const save = () => {
    try {
      assertSafeDataPath(path);
      replaceDataFile(path, `${JSON.stringify(saved)}\n`);
    } catch {
      // Kept in memory: lost only with a restart.
    }
  };
  const seen = (connectionId: string, paneId: string, terminalId: string) =>
    saved.connections[connectionId]?.[keyOf(paneId, terminalId)]?.seq ?? null;
  return {
    seen,
    mark(connectionId, paneId, terminalId, seq) {
      if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0))
        return false;
      const entries = (saved.connections[connectionId] ??= {});
      const key = keyOf(paneId, terminalId);
      const before = entries[key]?.seq ?? -1;
      const advanced = seq !== undefined && seq > before;
      entries[key] = { seq: advanced ? seq : before, at: now() };
      const keys = Object.keys(entries);
      if (keys.length > MAX_PER_CONNECTION)
        for (const old of keys
          .sort((a, b) => entries[a]!.at - entries[b]!.at)
          .slice(0, keys.length - MAX_PER_CONNECTION))
          delete entries[old];
      save();
      return advanced;
    },
    annotate(connectionId, result) {
      if (!isRecord(result) || !Array.isArray(result.agents)) return result;
      return {
        ...result,
        agents: result.agents.map((agent: unknown) => {
          if (
            !isRecord(agent) ||
            typeof agent.pane_id !== "string" ||
            typeof agent.terminal_id !== "string"
          )
            return agent;
          const entry =
            saved.connections[connectionId]?.[
              keyOf(agent.pane_id, agent.terminal_id)
            ];
          if (!entry) return agent;
          const finished =
            (agent.agent_status === "idle" || agent.agent_status === "done") &&
            Number.isSafeInteger(agent.state_change_seq);
          return {
            ...agent,
            seen_at: entry.at,
            ...(finished
              ? { seen_done: (agent.state_change_seq as number) > entry.seq }
              : {}),
          };
        }),
      };
    },
  };
}
