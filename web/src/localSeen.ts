import type { Pane } from "./types";

/**
 * The looks at agents this page just told the server about
 * (`agent_seen.mark`), shown in its lists at once rather than when the server
 * lists the agents again: a finished agent looked at is no longer Done, and
 * every agent looked at was seen now. Kept for a while after the server
 * answers, so a list read before the mark landed does not bring Done back.
 */
type Look = { seq?: number; at: number };

/** Long past a mark's round trip and the next read of the lists. */
const KEEP_MS = 30_000;
/** Plenty for the agents of a few workspaces looked at in a row. */
const MAX_LOOKS = 500;

const looks = new Map<string, Look>();

const keyOf = (connectionId: string, paneId: string, terminalId: string) =>
  `${connectionId}\u0000${paneId}\u0000${terminalId}`;

/**
 * Records a look at an agent at `at`, in its finished state `seq` when
 * given (see `watchAgentsSeen`).
 */
export function recordLocalSeen(
  connectionId: string,
  paneId: string,
  terminalId: string,
  seq: number | undefined,
  at: number,
) {
  const key = keyOf(connectionId, paneId, terminalId);
  const previous = looks.get(key);
  looks.delete(key);
  looks.set(key, {
    // A later look without a state keeps the finished state seen before.
    ...(seq !== undefined
      ? { seq }
      : previous?.seq !== undefined
        ? { seq: previous.seq }
        : {}),
    at,
  });
  for (const oldest of looks.keys()) {
    if (looks.size <= MAX_LOOKS) break;
    looks.delete(oldest);
  }
}

/**
 * `panes` of a connection with this page's recent looks applied: seen when
 * last looked at, and no longer Done in a finished state that was seen. The
 * same array when nothing changes.
 */
export function withLocalSeen(
  connectionId: string,
  panes: Pane[],
  now = Date.now(),
): Pane[] {
  if (looks.size === 0) return panes;
  let changed = false;
  const result = panes.map((pane) => {
    const key = keyOf(connectionId, pane.pane_id, pane.terminal_id);
    const look = looks.get(key);
    if (!look) return pane;
    if (now - look.at > KEEP_MS) {
      looks.delete(key);
      return pane;
    }
    const seenAt = Math.max(pane.seen_at ?? -1, look.at);
    const done =
      pane.agent_status === "done" &&
      look.seq !== undefined &&
      (pane.state_change_seq ?? look.seq) <= look.seq;
    if (seenAt === pane.seen_at && !done) return pane;
    changed = true;
    return {
      ...pane,
      seen_at: seenAt,
      ...(done ? { agent_status: "idle" } : {}),
    };
  });
  return changed ? result : panes;
}

/** Forgets every look (tests). */
export function clearLocalSeen() {
  looks.clear();
}
