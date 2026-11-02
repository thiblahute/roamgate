/**
 * What happened lately that a voice chat's front may tell (voiceFront.ts):
 * an agent done or waiting for input, a Ranger task run. Fed by the same
 * notifications Roamgate raises (store.ts), whatever the notification
 * preferences say: voice chat decides on its own what is worth saying.
 */

export type VoiceEvent = {
  /** What happened, in a few words. */
  text: string;
  /** When it happened (Date.now()). */
  at: number;
  /** The session it is about, when it is one. */
  connectionId?: string;
  paneId?: string;
};

/** Events kept for the front's state, at most. */
const KEPT = 12;
/** Older than this, an event is no longer "lately". */
export const VOICE_EVENT_KEPT_MS = 30 * 60_000;

let events: VoiceEvent[] = [];
const listeners = new Set<(event: VoiceEvent) => void>();

export function noteVoiceEvent(
  event: Omit<VoiceEvent, "at"> & { at?: number },
) {
  const noted: VoiceEvent = { ...event, at: event.at ?? Date.now() };
  // The same thing said twice in a row (a notification relayed by Herdr
  // and seen in the panes) is one event.
  const last = events[events.length - 1];
  if (
    last &&
    last.text === noted.text &&
    last.paneId === noted.paneId &&
    noted.at - last.at < 60_000
  )
    return;
  events = [...events, noted].slice(-KEPT);
  for (const listener of [...listeners]) listener(noted);
}

/** Events of the last VOICE_EVENT_KEPT_MS, oldest first. */
export function recentVoiceEvents(now = Date.now()): VoiceEvent[] {
  return events.filter((event) => now - event.at <= VOICE_EVENT_KEPT_MS);
}

export function onVoiceEvent(listener: (event: VoiceEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetVoiceEventsForTests() {
  events = [];
  listeners.clear();
}
