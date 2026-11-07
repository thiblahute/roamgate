import { useEffect, useSyncExternalStore } from "react";
import {
  LIMIT_PAUSES_EVENT,
  type LimitPause,
  limitKindLabel,
  parseLimitPauses,
} from "../../shared/limitResume";
import { bridge, type ConnectionClient, type HerdrEventMsg } from "./api";
import { useStoreSelector } from "./store";

/**
 * The sessions a usage limit paused, per connection: asked of each ready
 * connection (limit_resume.list), then kept current by the server's push.
 */
const byConnection = new Map<string, LimitPause[]>();
const listeners = new Set<() => void>();
let unlisten: (() => void) | null = null;
/** The connection runtimes asked already ("id\ngeneration"). */
const asked = new Set<string>();

function publish(connectionId: string, pauses: LimitPause[]) {
  if (pauses.length) byConnection.set(connectionId, pauses);
  else byConnection.delete(connectionId);
  for (const listener of [...listeners]) listener();
}

function handleEvent(message: HerdrEventMsg) {
  if (message.event !== LIMIT_PAUSES_EVENT) return;
  publish(message.connection_id, parseLimitPauses(message.data));
}

function listen() {
  // A test's stand-in bridge may have no events.
  if (!unlisten && typeof bridge.onEvent === "function")
    unlisten = bridge.onEvent(handleEvent);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks a connection for its paused sessions. */
export async function loadLimitPauses(client: ConnectionClient) {
  listen();
  try {
    const result = await client.call("limit_resume.list", {}, null, {
      lane: "background",
    });
    if (client.isCurrent())
      publish(client.connectionId, parseLimitPauses(result));
  } catch {
    // An older server, or not ready: the next push says.
  }
}

/** Keeps every ready connection's paused sessions known (App mounts it). */
export function useLimitPausesSync() {
  const connections = useStoreSelector((state) => state.connections);
  useEffect(() => {
    listen();
    for (const connection of connections) {
      if (connection.state !== "ready" || connection.remote_platform) continue;
      const key = `${connection.id}\n${connection.generation}`;
      if (asked.has(key)) continue;
      asked.add(key);
      void loadLimitPauses(
        bridge.connection(connection.id, connection.generation),
      );
    }
  }, [connections]);
}

export function limitPauseOf(
  connectionId: string | null | undefined,
  paneId: string | null | undefined,
): LimitPause | null {
  if (!connectionId || !paneId) return null;
  return (
    byConnection.get(connectionId)?.find((pause) => pause.pane_id === paneId) ??
    null
  );
}

/** The pane's pause, kept current; null when it is not paused. */
export function useLimitPause(
  connectionId: string | null | undefined,
  paneId: string | null | undefined,
): LimitPause | null {
  const read = () => limitPauseOf(connectionId, paneId);
  // The same on a server render (tests render rows to strings).
  return useSyncExternalStore(subscribe, read, read);
}

/** Test seam: what a push would set. */
export function setLimitPausesForTest(
  connectionId: string,
  pauses: LimitPause[],
) {
  publish(connectionId, pauses);
}

type Answer = { ok: boolean; reason?: string };

async function act(
  client: ConnectionClient,
  method: string,
  params: Record<string, unknown>,
): Promise<Answer> {
  try {
    const result = (await client.call(method, params)) as Answer | null;
    return result && typeof result.ok === "boolean"
      ? result
      : { ok: false, reason: "No answer" };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** "Resume now": the resume message goes to the session at once. */
export function resumeLimitPause(client: ConnectionClient, paneId: string) {
  return act(client, "limit_resume.resume_now", { pane_id: paneId });
}

/** "Don't resume" (true) for the pane's session, or undone (false). */
export function skipLimitPause(
  client: ConnectionClient,
  paneId: string,
  skip: boolean,
) {
  return act(client, "limit_resume.skip", { pane_id: paneId, skip });
}

/** A time in this browser's zone ("1:41 AM", "Nov 9, 8:01 AM"). */
export function pauseTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * What a pause is said as: `short` for a chip ("Paused · 1:41 AM"),
 * `text` for a sentence ("Paused by the usage limit, resumes at 1:41
 * AM"), `status` for a menu's header line ("Resumes at 1:41 AM"),
 * `detail` for its title (which limit, when it resets).
 */
export function limitPauseWords(
  pause: LimitPause,
  now = Date.now(),
): { short: string; text: string; status: string; detail: string } {
  const resets = pauseTime(pause.resets_at, now);
  const kind = limitKindLabel(pause.kind);
  const detail = `${kind === "usage" ? "Usage" : `The ${kind}`} limit ${pause.resets_at > now ? "resets" : "reset"} at ${resets}.`;
  const resumes =
    pause.resume_at === null ? "" : pauseTime(pause.resume_at, now);
  switch (pause.state) {
    case "scheduled":
      return {
        short: `Paused · ${resumes}`,
        text: `Paused by the usage limit, resumes at ${resumes}`,
        status: `Resumes at ${resumes}`,
        detail,
      };
    case "resuming":
      return {
        short: "Resuming...",
        text: "Resuming after the usage limit...",
        status: "Resuming...",
        detail,
      };
    case "skipped":
      return {
        short: "Paused · not resumed",
        text: "Paused by the usage limit; it will not be resumed",
        status: "Will not be resumed",
        detail,
      };
    case "off":
      return {
        short: `Paused · ${resets}`,
        text: `Paused by the usage limit until ${resets}; resuming is off in Configuration`,
        status: "Resuming is off in Configuration",
        detail,
      };
    case "resumed": {
      const at = pause.resumed_at
        ? ` at ${pauseTime(pause.resumed_at, now)}`
        : "";
      return {
        short: "Limit again",
        text: `Resumed${at}, and the usage limit stopped it again`,
        status: `Resumed${at}, stopped again`,
        detail,
      };
    }
    case "failed":
      return {
        short: "Resume failed",
        text: `Paused by the usage limit; it could not be resumed${pause.reason ? ` (${pause.reason})` : ""}${resumes ? `, trying again at ${resumes}` : ""}`,
        status: resumes
          ? `Not resumed, trying again at ${resumes}`
          : "Could not resume it",
        detail,
      };
    default:
      return {
        short:
          pause.resets_at > now ? `Paused · ${resets}` : "Paused · limit reset",
        text:
          pause.resets_at > now
            ? `Paused by the usage limit until ${resets}`
            : `Paused by the usage limit, which reset at ${resets}`,
        status:
          pause.resets_at > now
            ? `Until ${resets}`
            : `The limit reset at ${resets}`,
        detail,
      };
  }
}
