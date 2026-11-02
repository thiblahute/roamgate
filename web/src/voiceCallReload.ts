/**
 * A page in a voice call and a newer build (frontendFreshness.ts): the
 * reload waits for a moment between turns (listening, nothing heard yet),
 * and the call is picked up again once the new build shows the pane.
 */

export type VoiceCallPane = { connectionId: string; paneId: string };

/** "safe": a reload now cuts nothing; "busy": someone speaks or is read. */
export type VoiceCallPhase = "safe" | "busy";

let call: { pane: VoiceCallPane; phase: VoiceCallPhase } | null = null;

/** The voice chat of `pane` is in `phase`; null: it has no call. */
export function setVoiceCallPhase(
  pane: VoiceCallPane,
  phase: VoiceCallPhase | null,
) {
  if (phase) call = { pane, phase };
  else if (
    call?.pane.connectionId === pane.connectionId &&
    call.pane.paneId === pane.paneId
  )
    call = null;
}

export function voiceCallReloadState(): "none" | VoiceCallPhase {
  return call?.phase ?? "none";
}

const KEY = "roamgate.voiceCallReload";
/** A reload that took longer than this does not start a call by itself. */
const PICKUP_MS = 60_000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Notes the call, for the reloaded page to go on with it. */
export function rememberCallForReload(
  storage = sessionStore(),
  now = Date.now(),
) {
  if (!call || !storage) return;
  try {
    storage.setItem(KEY, JSON.stringify({ ...call.pane, at: now }));
  } catch {
    // The call is not picked up again: started again by hand.
  }
}

/** The call the page had before it reloaded, once. */
export function takeCallAfterReload(
  storage = sessionStore(),
  now = Date.now(),
): VoiceCallPane | null {
  if (!storage) return null;
  let kept: unknown;
  try {
    kept = JSON.parse(storage.getItem(KEY) ?? "null");
    storage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!kept || typeof kept !== "object") return null;
  const { connectionId, paneId, at } = kept as Record<string, unknown>;
  if (
    typeof connectionId !== "string" ||
    typeof paneId !== "string" ||
    typeof at !== "number" ||
    now - at > PICKUP_MS
  )
    return null;
  return { connectionId, paneId };
}
