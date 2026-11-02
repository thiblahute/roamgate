import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";

/**
 * How a voice call's replies reach the speaker, per device (Speech
 * settings), and the call's one AudioContext.
 *
 * "context" (the default): each sentence is decoded and played by the
 * AudioContext the microphone streams through. No media element plays, so
 * Android's media session sees nothing to pause and the car's media
 * (AVRCP) controls nothing to control: in a car, a reply's audio element
 * was paused a few hundredths of a second into most sentences. Echo
 * cancellation is the platform's, on the microphone, and hears what the
 * phone plays, so speaking over a reply still interrupts it. Any speed
 * plays this way: the server makes the speech at the reading speed,
 * keeping the pitch, so nothing is sped up here. No silent focus holder
 * plays either: nothing of the page competes for the audio focus.
 *
 * "element": each sentence is an audio element, as before, with a silent
 * loop holding the audio focus between them; kept to compare in the car.
 *
 * "call" (an experiment): the element's sound goes through a WebRTC
 * connection of the page to itself, and the received track plays: WebRTC
 * playout is call audio on Android (the voice-call stream, beside the open
 * microphone, outside the media session).
 *
 * docs/DEPLOYMENT.md, "Voice calls on the move", says what to try where.
 */

export type VoiceOutputMode = "context" | "element" | "call";

const KEY = "voiceOutput";
const MODES: VoiceOutputMode[] = ["context", "element", "call"];

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
 * The call's AudioContext: the microphone and the replies go through it.
 * Made on first use (from the tap starting the call), kept while a voice
 * chat holds it (holdVoiceContext).
 */
export function voiceContext(): AudioContext {
  if (!shared || shared.state === "closed") {
    const context = new AudioContext();
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
        closeCallAudio();
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

type Loop = {
  input: MediaStreamAudioDestinationNode;
  sender: RTCPeerConnection;
  receiver: RTCPeerConnection;
  output: HTMLAudioElement;
};

let loop: Promise<Loop> | null = null;

/** The page's call to itself, made once a call and kept. */
async function openLoop(): Promise<Loop> {
  const input = voiceContext().createMediaStreamDestination();
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  sender.onicecandidate = (event) => {
    if (event.candidate) void receiver.addIceCandidate(event.candidate);
  };
  receiver.onicecandidate = (event) => {
    if (event.candidate) void sender.addIceCandidate(event.candidate);
  };
  const received = new Promise<MediaStream>((resolve) => {
    receiver.ontrack = (event) =>
      resolve(event.streams[0] ?? new MediaStream([event.track]));
  });
  for (const track of input.stream.getAudioTracks())
    sender.addTrack(track, input.stream);
  const offer = await sender.createOffer();
  await sender.setLocalDescription(offer);
  await receiver.setRemoteDescription(offer);
  const answer = await receiver.createAnswer();
  await receiver.setLocalDescription(answer);
  await sender.setRemoteDescription(answer);
  // Chrome plays a received track only from a media element.
  const output = new Audio();
  output.srcObject = await received;
  await output.play();
  return { input, sender, receiver, output };
}

/** Ends the page's call to itself (voice chat is over). */
export function closeCallAudio() {
  const ending = loop;
  loop = null;
  void ending
    ?.then(({ sender, receiver, output }) => {
      output.pause();
      output.srcObject = null;
      sender.close();
      receiver.close();
    })
    .catch(() => {});
}

/**
 * Sends `player`'s sound through the page's call to itself instead of the
 * speaker; null when that cannot be done (it then plays as media). Play it
 * once `ready`; `release` when the sentence is over.
 */
export function routeThroughCall(
  player: HTMLAudioElement,
): { ready: Promise<void>; release: () => void } | null {
  if (typeof RTCPeerConnection !== "function") return null;
  loop ??= openLoop();
  const opening = loop;
  let source: MediaElementAudioSourceNode | null = null;
  let released = false;
  const ready = opening
    .then(({ input }) => {
      if (released) return;
      source = voiceContext().createMediaElementSource(player);
      source.connect(input);
    })
    .catch(() => {
      // No call: as media, as without the mode.
      if (loop === opening) loop = null;
    });
  return {
    ready,
    release: () => {
      released = true;
      source?.disconnect();
      source = null;
    },
  };
}
