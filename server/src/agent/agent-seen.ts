import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DataFileWriter,
  dataFileWriter,
  dataRoot,
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
 *
 * Herdr numbers state changes per server process, so a mark only holds for
 * the Herdr server it was made on: its boot id (`<pid>-<start ns>`, from the
 * endpoint snapshot) is kept with it when known, and a state number below
 * the marked one also means the server restarted (agents that live through
 * a handoff keep their terminal ids but start counting again).
 */
export type AgentSeenStore = {
  /**
   * The state an agent was last seen finished in (-1 when it was only seen
   * working), or null if Roamgate never saw it.
   */
  seen(connectionId: string, paneId: string, terminalId: string): number | null;
  /**
   * Records a look at the agent, now: in this finished state when `seq` is
   * given. True when it was not yet seen in that state. `boot` is the Herdr
   * server's boot id, when known: a mark from another boot is replaced.
   */
  mark(
    connectionId: string,
    paneId: string,
    terminalId: string,
    seq?: number,
    boot?: string | null,
  ): boolean;
  /**
   * Roamgate itself (a Ranger task) prompted the agent, in this state: the
   * turn this starts does not make it Done. An agent already Done stays so.
   */
  quietTurn(
    connectionId: string,
    paneId: string,
    terminalId: string,
    seq: number,
    status: string,
  ): void;
  /**
   * An agent saying the user needs to act: shown with it until the user
   * next looks at it.
   */
  note(
    connectionId: string,
    paneId: string,
    note: { text: string; title?: string },
  ): void;
  /**
   * Herdr's agent list with each finished agent's own Done: `seen_done` is
   * true when it changed state since it was last seen in Roamgate, false
   * when it has not. Agents Roamgate never saw keep Herdr's. `seen_at` is
   * when the user last looked at the agent, if ever. Marks made on another
   * Herdr boot, or above the agent's state number, count as never seen.
   * `attention_note` is what the agent said the user needs to do, until the
   * user looked at it.
   */
  annotate(
    connectionId: string,
    result: unknown,
    boot?: string | null,
  ): unknown;
  /**
   * Writes pending marks now (they are otherwise batched for a moment);
   * resolves once they are written.
   */
  flush(): Promise<void>;
};

type Entry = {
  seq: number;
  at: number;
  boot?: string;
  /**
   * Prompted by Roamgate itself (Ranger) from this state: the turn it starts
   * is not the user's to see, so its end is not Done.
   */
  quiet?: number;
};
type Note = { text: string; title?: string; at: number };
type Saved = {
  version: 1;
  connections: Record<string, Record<string, Entry>>;
  /** By connection, then pane. */
  notes?: Record<string, Record<string, Note>>;
};

/** Seen marks kept per connection, the oldest dropped beyond it. */
const MAX_PER_CONNECTION = 2000;
/** Connections kept, the one looked at longest ago dropped beyond it. */
const MAX_CONNECTIONS = 64;
/** Marks come in bursts as panes come and go: one write per burst. */
const SAVE_DELAY_MS = 1_000;

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
          kept[key] = {
            seq: entry.seq as number,
            at: entry.at as number,
            ...(typeof entry.boot === "string" && entry.boot
              ? { boot: entry.boot }
              : {}),
            ...(Number.isSafeInteger(entry.quiet)
              ? { quiet: entry.quiet as number }
              : {}),
          };
      connections[connection] = kept;
    }
    const notes: NonNullable<Saved["notes"]> = {};
    if (isRecord(value.notes))
      for (const [connection, panes] of Object.entries(value.notes)) {
        if (!isRecord(panes)) continue;
        const kept: Record<string, Note> = {};
        for (const [pane, note] of Object.entries(panes))
          if (
            isRecord(note) &&
            typeof note.text === "string" &&
            Number.isFinite(note.at)
          )
            kept[pane] = {
              text: note.text,
              at: note.at as number,
              ...(typeof note.title === "string" ? { title: note.title } : {}),
            };
        notes[connection] = kept;
      }
    return { version: 1, connections, notes };
  } catch {
    // A damaged file only forgets what was seen: Herdr's Done comes back.
    return { version: 1, connections: {} };
  }
}

const keyOf = (paneId: string, terminalId: string) =>
  `${paneId}\u0000${terminalId}`;

/** Whether two boot ids, when both are known, name different servers. */
const otherBoot = (entry: Entry, boot: string | null | undefined) =>
  !!boot && !!entry.boot && entry.boot !== boot;

export function createAgentSeenStore(
  path = agentSeenPath(),
  now: () => number = Date.now,
  saveDelayMs = SAVE_DELAY_MS,
): AgentSeenStore {
  const saved = load(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Written off the event loop (dataFileWriter): a sync on a busy disk
  // stalled every call for seconds. A failed write keeps the marks in
  // memory, lost only with a restart.
  let writer: DataFileWriter | null = null;
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      writer ??= dataFileWriter(path);
      writer.write(() => `${JSON.stringify(saved)}\n`);
    }
    await writer?.flush();
  };
  const save = () => {
    if (timer) return;
    timer = setTimeout(flush, saveDelayMs);
    timer.unref?.();
  };
  const latest = (entries: Record<string, Entry>) => {
    let at = -Infinity;
    for (const entry of Object.values(entries)) at = Math.max(at, entry.at);
    return at;
  };
  const seen = (connectionId: string, paneId: string, terminalId: string) =>
    saved.connections[connectionId]?.[keyOf(paneId, terminalId)]?.seq ?? null;
  return {
    seen,
    mark(connectionId, paneId, terminalId, seq, boot) {
      if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0))
        return false;
      const added = !saved.connections[connectionId];
      const entries = (saved.connections[connectionId] ??= {});
      if (added) {
        const connections = Object.keys(saved.connections);
        if (connections.length > MAX_CONNECTIONS)
          for (const old of connections
            .filter((each) => each !== connectionId)
            .sort(
              (a, b) =>
                latest(saved.connections[a]!) - latest(saved.connections[b]!),
            )
            .slice(0, connections.length - MAX_CONNECTIONS))
            delete saved.connections[old];
      }
      const key = keyOf(paneId, terminalId);
      const old = entries[key];
      // A mark from an earlier Herdr server says nothing about this one. On
      // the same known boot a lower number is a late report, not a restart.
      const sameBoot = !!boot && !!old?.boot && old.boot === boot;
      const reset =
        !!old &&
        (otherBoot(old, boot) ||
          (!sameBoot && seq !== undefined && seq < old.seq));
      const before = old && !reset ? old.seq : -1;
      const advanced = seq !== undefined && seq > before;
      const kept = boot || (reset ? undefined : old?.boot);
      // A look settles any quiet turn: what it shows is seen.
      entries[key] = {
        seq: advanced ? seq : before,
        at: now(),
        ...(kept ? { boot: kept } : {}),
      };
      const keys = Object.keys(entries);
      if (keys.length > MAX_PER_CONNECTION)
        for (const old of keys
          .sort((a, b) => entries[a]!.at - entries[b]!.at)
          .slice(0, keys.length - MAX_PER_CONNECTION))
          delete entries[old];
      save();
      return advanced;
    },
    flush,
    quietTurn(connectionId, paneId, terminalId, seq, status) {
      if (!Number.isSafeInteger(seq)) return;
      const entries = (saved.connections[connectionId] ??= {});
      const key = keyOf(paneId, terminalId);
      const entry = entries[key];
      const finished = status === "idle" || status === "done";
      // Finished and not seen since: real work waits there, it stays Done.
      if (finished && (entry ? seq > entry.seq : status === "done")) return;
      entries[key] = {
        seq: entry?.seq ?? seq,
        at: entry?.at ?? 0,
        quiet: seq,
        ...(entry?.boot ? { boot: entry.boot } : {}),
      };
      save();
    },
    note(connectionId, paneId, note) {
      const notes = (saved.notes ??= {});
      (notes[connectionId] ??= {})[paneId] = { ...note, at: now() };
      save();
    },
    annotate(connectionId, result, boot) {
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
          const note = saved.notes?.[connectionId]?.[agent.pane_id];
          // Said since the user last looked at it.
          const unread =
            note && note.at > (entry?.at ?? 0)
              ? {
                  attention_note: note.title
                    ? `${note.title}: ${note.text}`
                    : note.text,
                }
              : {};
          if (!entry || otherBoot(entry, boot)) return { ...agent, ...unread };
          const seq = Number.isSafeInteger(agent.state_change_seq)
            ? (agent.state_change_seq as number)
            : undefined;
          // Herdr counted past the mark only on an earlier server.
          if (seq !== undefined && seq < entry.seq)
            return { ...agent, ...unread };
          const finished =
            (agent.agent_status === "idle" || agent.agent_status === "done") &&
            seq !== undefined;
          // The end of a turn Roamgate started: seen, as nothing was asked.
          if (
            finished &&
            entry.quiet !== undefined &&
            (seq as number) > entry.quiet
          ) {
            entry.seq = Math.max(entry.seq, seq as number);
            delete entry.quiet;
            save();
          }
          return {
            ...agent,
            ...unread,
            // Never looked at: only Roamgate's own prompt made the entry.
            ...(entry.at > 0 ? { seen_at: entry.at } : {}),
            ...(finished
              ? {
                  seen_done:
                    entry.quiet === undefined && (seq as number) > entry.seq,
                }
              : {}),
          };
        }),
      };
    },
  };
}

/** How long a connection's Herdr boot id is trusted before it is read again. */
const BOOT_TTL_MS = 60_000;

/**
 * Each connection's Herdr boot id, read through a passive endpoint handshake
 * at most once a minute (or again once invalidated). Null when the server
 * has no endpoint (legacy or Windows Herdr) or could not be read.
 */
export function createHerdrBootCache(
  now: () => number = Date.now,
  ttlMs = BOOT_TTL_MS,
) {
  const boots = new Map<string, { at: number; boot: Promise<string | null> }>();
  return {
    get(
      connectionId: string,
      read: () => Promise<string | null>,
    ): Promise<string | null> {
      const cached = boots.get(connectionId);
      if (cached && now() - cached.at < ttlMs) return cached.boot;
      const boot = read().then(
        (value) => (typeof value === "string" && value ? value : null),
        () => null,
      );
      boots.set(connectionId, { at: now(), boot });
      return boot;
    },
    invalidate(connectionId: string) {
      boots.delete(connectionId);
    },
  };
}

/**
 * The `agent_seen.mark` RPC: records that the user looks at an agent
 * terminal (`pane_id`, `terminal_id`), in finished state `seq` if given, on
 * the connection's current Herdr boot. Throws on malformed parameters.
 */
export async function markAgentSeen(
  store: AgentSeenStore,
  boots: ReturnType<typeof createHerdrBootCache>,
  connectionId: string,
  params: unknown,
  readBoot: () => Promise<string | null>,
): Promise<{ marked: boolean }> {
  const pane = isRecord(params) ? params.pane_id : undefined;
  const terminal = isRecord(params) ? params.terminal_id : undefined;
  const seq = isRecord(params) ? params.seq : undefined;
  if (
    typeof pane !== "string" ||
    !pane ||
    pane.length > 200 ||
    typeof terminal !== "string" ||
    !terminal ||
    terminal.length > 200 ||
    (seq !== undefined && typeof seq !== "number")
  )
    throw new Error("invalid agent_seen.mark");
  // A state number below the one marked may mean Herdr restarted: read its
  // boot id again rather than trust the cached one.
  if (
    Number.isSafeInteger(seq) &&
    (seq as number) >= 0 &&
    (seq as number) < (store.seen(connectionId, pane, terminal) ?? -1)
  )
    boots.invalidate(connectionId);
  const boot = await boots.get(connectionId, readBoot);
  return { marked: store.mark(connectionId, pane, terminal, seq, boot) };
}
