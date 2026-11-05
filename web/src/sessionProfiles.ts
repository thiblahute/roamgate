import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UsageLimit } from "../../shared/agentProfiles";
import type { ConnectionClient } from "./api";

/** One offered profile, as the server lists it (agent_profile.get). */
export type OfferedProfile = {
  name: string;
  agent: string;
  /** The model it runs ("GLM 5p3"), else its name. */
  label: string;
  default: boolean;
};

/** A pane session's profile (agent_profile.get). */
export type SessionProfile = {
  session_id: string | null;
  owner?: "terminal" | "conversation";
  profile?: string;
  label?: string;
  default: string;
  profiles: OfferedProfile[];
  limit?: UsageLimit | null;
  returns_at?: number;
  returns_to?: string;
};

type Entry = {
  data: SessionProfile | null;
  switching: string | null;
  error: string | null;
  /** When the user last retried after a limit: older limits are done. */
  retriedAt: number | null;
};

const EMPTY: Entry = {
  data: null,
  switching: null,
  error: null,
  retriedAt: null,
};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function keyOf(connectionId: string, paneId: string) {
  return `${connectionId}\n${paneId}`;
}

function update(key: string, change: Partial<Entry>) {
  entries.set(key, { ...(entries.get(key) ?? EMPTY), ...change });
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What is known of a pane's session profile (the command menu reads it). */
export function sessionProfileOf(connectionId: string, paneId: string): Entry {
  return entries.get(keyOf(connectionId, paneId)) ?? EMPTY;
}

export function useSessionProfileEntry(
  connectionId: string,
  paneId: string | null,
): Entry {
  return useSyncExternalStore(subscribe, () =>
    paneId ? sessionProfileOf(connectionId, paneId) : EMPTY,
  );
}

export function parseSessionProfile(value: unknown): SessionProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.profiles) || typeof raw.default !== "string")
    return null;
  return raw as unknown as SessionProfile;
}

/** Asks the server again for a pane's session profile. */
export async function refreshSessionProfile(
  client: ConnectionClient,
  paneId: string,
): Promise<void> {
  const key = keyOf(client.connectionId, paneId);
  try {
    const data = parseSessionProfile(
      await client.call("agent_profile.get", { pane_id: paneId }),
    );
    if (!client.isCurrent()) return;
    update(key, { data, error: null });
  } catch (error) {
    if (!client.isCurrent()) return;
    update(key, { error: (error as Error).message });
  }
}

/**
 * Runs the pane's session with another profile: the same session resumes
 * with it (the terminal's TUI exits and comes back; conversation mode
 * restarts its process). After a usage limit, `resetsAt` sends it back to
 * the default once the limit resets (when the setting says so).
 */
export async function switchSessionProfile(
  client: ConnectionClient,
  paneId: string,
  profile: string,
  resetsAt?: number | null,
): Promise<{ ok: boolean; reason?: string }> {
  const key = keyOf(client.connectionId, paneId);
  const current = sessionProfileOf(client.connectionId, paneId);
  if (current.switching) return { ok: false, reason: "A switch is running" };
  update(key, { switching: profile, error: null });
  try {
    const result = (await client.call("agent_profile.switch", {
      pane_id: paneId,
      profile,
      ...(current.data?.session_id
        ? { session_id: current.data.session_id }
        : {}),
      ...(resetsAt ? { resets_at: resetsAt } : {}),
    })) as { ok?: boolean; reason?: string };
    const ok = result?.ok === true;
    await refreshSessionProfile(client, paneId);
    update(key, {
      switching: null,
      error: ok ? null : (result?.reason ?? "The switch was refused"),
    });
    return ok ? { ok } : { ok, reason: result?.reason };
  } catch (error) {
    update(key, { switching: null, error: (error as Error).message });
    return { ok: false, reason: (error as Error).message };
  }
}

/**
 * Keeps a pane's session profile known while the pane shows a Claude:
 * asked when it appears, when its status changes (a turn ended on a usage
 * limit), and every minute meanwhile.
 */
export function useSessionProfile(
  client: ConnectionClient,
  paneId: string,
  enabled: boolean,
  agentStatus: string | undefined,
  everyMs = 60_000,
) {
  const entry = useSessionProfileEntry(client.connectionId, paneId);
  useEffect(() => {
    if (!enabled) return;
    void refreshSessionProfile(client, paneId);
    const timer = setInterval(
      () => void refreshSessionProfile(client, paneId),
      everyMs,
    );
    return () => clearInterval(timer);
  }, [client, paneId, enabled, agentStatus, everyMs]);
  const switchTo = useCallback(
    (profile: string, resetsAt?: number | null) =>
      switchSessionProfile(client, paneId, profile, resetsAt),
    [client, paneId],
  );
  return { ...entry, switchTo };
}

/** This browser's time zone. */
function localZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * When a limit resets, in this browser's time ("5:20 PM", "Nov 9, 8:00
 * AM"), with the message's zone only when it is not this one; the
 * message's own words when it gave no time.
 */
export function resetTime(
  limit: UsageLimit,
  now = Date.now(),
  zone = localZone(),
): string {
  if (limit.resets_at) {
    const at = new Date(limit.resets_at);
    const sameDay = at.toDateString() === new Date(now).toDateString();
    const time = at.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    const day = sameDay
      ? ""
      : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, `;
    const other = limit.zone && zone && limit.zone !== zone ? limit.zone : "";
    return `${day}${time}${other ? ` (${other.split("/").pop()!.replace(/_/g, " ")} time)` : ""}`;
  }
  return limit.resets ?? "";
}

/** The limit still in the way: not retried since, not past its reset. */
export function activeLimit(
  entry: Pick<Entry, "data" | "retriedAt">,
  now = Date.now(),
): UsageLimit | null {
  const limit = entry.data?.limit ?? null;
  if (!limit) return null;
  if (limit.resets_at !== null && limit.resets_at <= now) return null;
  if (
    entry.retriedAt !== null &&
    (limit.at === undefined || limit.at <= entry.retriedAt)
  )
    return null;
  return limit;
}

/**
 * Tries the session again on its profile (a limit may be over, or the
 * account changed): "continue" goes to it. The limit shown is put away
 * until the agent reports a new one.
 */
export async function retrySession(
  client: ConnectionClient,
  paneId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const key = keyOf(client.connectionId, paneId);
  try {
    const result = (await client.call("agent_profile.retry", {
      pane_id: paneId,
    })) as { ok?: boolean; reason?: string };
    if (result?.ok !== true)
      return { ok: false, reason: result?.reason ?? "The retry was refused" };
    update(key, { retriedAt: Date.now(), error: null });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
