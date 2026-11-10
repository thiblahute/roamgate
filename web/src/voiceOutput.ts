import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/**
 * How a voice call's replies reach the speaker when the call has no WebRTC
 * audio (webrtcCall.ts: an older server or helper), per device (Speech
 * settings), and the call's one AudioContext.
 *
 * "context" (the default): each sentence is decoded and played by the
 * AudioContext the microphone streams through. No media element plays, so
 * Android's media session sees nothing to pause and the car's media
 * (AVRCP) controls nothing to control: in a car, a reply's audio element
 * was paused a few hundredths of a second into most sentences. Echo
 * cancellation is the platform's, on the microphone. Any speed plays this
 * way: the server makes the speech at the reading speed, keeping the
 * pitch, so nothing is sped up here. No silent focus holder plays either:
 * nothing of the page competes for the audio focus.
 *
 * "element": each sentence is an audio element, as before, with a silent
 * loop holding the audio focus between them; kept to compare in the car.
 *
 * docs/DEPLOYMENT.md, "Voice calls on the move", says what to try where.
 */

export type VoiceOutputMode = "context" | "element";

const KEY = "voiceOutput";
// A device left on the removed "call" mode reads as the default.
const MODES: VoiceOutputMode[] = ["context", "element"];

/** Chosen on this page, when storage keeps nothing. */
let chosen: VoiceOutputMode | null = null;

export function voiceOutputMode(): VoiceOutputMode {
  let value: string | null = null;
  try {
    value = roamgateLocalStorage.getItem(KEY);
  } catch {
    // Storage blocked.
  }
  if (MODES.includes(value as VoiceOutputMode)) return value as VoiceOutputMode;
  return chosen ?? "context";
}

const listeners = new Set<() => void>();

export function setVoiceOutputMode(mode: VoiceOutputMode) {
  chosen = mode;
  try {
    roamgateLocalStorage.setItem(KEY, mode);
  } catch {
    // Kept for this page only.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeVoiceOutputMode(listener: () => void) {
  listeners.add(listener);
  const stop = subscribeLocalStorage((key) => {
    if (key === KEY || key === null) listener();
  });
  return () => {
    listeners.delete(listener);
    stop();
  };
}

let shared: AudioContext | null = null;
let users = 0;
let closing: ReturnType<typeof setTimeout> | null = null;
let traceOutput: (line: string) => void = () => {};

/** Contexts that have the microphone's tap loaded. */
export const tapsLoaded = new WeakSet<AudioContext>();

/**
 * How late the call's context plays what it is given, in seconds
 * (outputLatency: a Bluetooth headset adds much); 0 without one.
 */
export function voiceOutputLatency(): number {
  if (!shared || shared.state === "closed") return 0;
  const latency = shared.outputLatency;
  return typeof latency === "number" && Number.isFinite(latency) ? latency : 0;
}

/**
 * The call's AudioContext: the microphone and the replies go through it.
 * Made on first use (from the tap starting the call), kept while a voice
 * chat holds it (holdVoiceContext).
 */
export function voiceContext(): AudioContext {
  if (!shared || shared.state === "closed") {
    // 48 kHz: the microphone and the replies at the rate WebRTC runs at.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: 48_000 });
    } catch {
      context = new AudioContext();
    }
    shared = context;
    // Suspended by the system (a call, the focus taken): it runs again.
    context.onstatechange = () => {
      if (context !== shared || users === 0) return;
      if (context.state !== "running" && context.state !== "closed") {
        traceOutput(
          `the voice audio was ${context.state} from outside: resuming`,
        );
        void context.resume().catch(() => {});
      }
    };
  }
  if (shared.state === "suspended") void shared.resume().catch(() => {});
  return shared;
}

/** Whether a voice call holds the context: replies then play through it. */
export function voiceContextHeld() {
  return users > 0;
}

let calls = 0;
/** Which call holds the context: a new one each time it starts being held. */
export function voiceCallNumber() {
  return calls;
}

/**
 * Holds the call's context until `signal` aborts; let go by every holder,
 * it closes a little later (a chat rebuilt takes it again meanwhile).
 */
export function holdVoiceContext(
  signal: AbortSignal,
  trace: (line: string) => void,
) {
  traceOutput = trace;
  if (users === 0) calls += 1;
  users += 1;
  if (closing) clearTimeout(closing);
  closing = null;
  signal.addEventListener(
    "abort",
    () => {
      users -= 1;
      if (users > 0) return;
      closing = setTimeout(() => {
        closing = null;
        if (users > 0) return;
        const context = shared;
        shared = null;
        void context?.close().catch(() => {});
      }, 3000);
    },
    { once: true },
  );
}

/**
 * Plays `audio` (an encoded sentence) through the call's context; resolves
 * when it is over or `signal` aborts.
 */
export async function playInContext(
  audio: Blob,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const context = voiceContext();
  const buffer = await context.decodeAudioData(await audio.arrayBuffer());
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const done = () => {
      signal.removeEventListener("abort", stop);
      source.onended = null;
      source.disconnect();
      resolve();
    };
    const stop = () => {
      try {
        source.stop();
      } catch {
        // Not started, or over.
      }
      done();
    };
    source.onended = done;
    signal.addEventListener("abort", stop, { once: true });
    source.start();
  });
}
