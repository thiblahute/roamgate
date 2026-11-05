import { useEffect, useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
import {
  type BrowserSpeechEvents,
  browserSpeechRuntime,
  speakWithBrowser,
  unlockBrowserSpeech,
} from "./speechPlayback";
import { getSpeechPreferences } from "./speechPreferences";
import { store } from "./store";
import type { AckSpeech } from "./voiceAck";
import {
  fetchVoiceAvailability,
  type SentenceVoice,
  serverVoice,
  speakWith,
  voiceTrace,
} from "./voiceChat";
import { activeCallAudio } from "./callAudio";
import { voiceCallNumber, voiceContextHeld } from "./voiceOutput";

/**
 * What reads aloud: Roamgate's voice engine on the server (the voice
 * helper, with the voices and speed set up there), or the browser's speech
 * synthesis (with the voice and rate chosen in Speech settings). Listening
 * is the server engine's only: without it, voice chat cannot hear.
 */
export type SpeechEngine = "server" | "browser";

/** Which engine reads when both can: the server's unless set otherwise. */
export type ReadWith = SpeechEngine;
const READ_WITH_KEY = "speechEngine";
const SILENT_IN_CALLS_KEY = "browserVoiceSilentInCalls";

/**
 * Why this browser's voice is not heard during a voice call here, or null.
 *
 * "android": Chrome on Android opens a call's microphone (with echo
 * cancellation) as a phone call, the audio routed as one (Bluetooth
 * hands-free in a car). The browser's speech is the system's speech engine,
 * another app beside the call, outside the call's audio and its echo
 * cancellation: on the user's phone (2026-11-05) a reply in it was first
 * not heard at all, then cut after the start of each sentence while the
 * reading view showed the whole sentence, when Roamgate's voice, played in
 * the call's AudioContext, read whole. No page can route that engine's
 * sound into the call (speechSynthesis gives no audio to play elsewhere).
 *
 * "failed": in a call on this device, a sentence of the browser's voice
 * failed, was cut by something else than the call (an "interrupted" or
 * "canceled" error with no stop asked), or did not start (BROWSER_START_MS);
 * kept until Speech settings try it again (retryBrowserVoiceInCalls).
 */
export type BrowserCallBlock = "android" | "failed";

/** How long a sentence of the browser's voice may take to start in a call. */
export const BROWSER_START_MS = 4000;

export function browserCallBlock(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): BrowserCallBlock | null {
  if (/\bAndroid\b/i.test(userAgent)) return "android";
  try {
    if (roamgateLocalStorage.getItem(SILENT_IN_CALLS_KEY)) return "failed";
  } catch {
    // Storage blocked: only this page's failure counts.
  }
  return failedHere ? "failed" : null;
}
let failedHere = false;

export type SpeechEngineState = {
  /** What reads aloud now; null when nothing can. */
  engine: SpeechEngine | null;
  /** Whether voice chat can listen: the server engine is there. */
  listen: boolean;
  /** Whether the server has its voice engine; null until it said. */
  server: boolean | null;
  /**
   * The last time it was asked, the server did not answer (a restart, the
   * network): asked again (loadSpeechEngine) rather than taken as a no.
   */
  unreachable: boolean;
  /** Whether the browser can speak. */
  browser: boolean;
  readWith: ReadWith;
  /**
   * What reads during a voice call: the engine, but Roamgate's when the
   * browser's voice is not heard in calls here (`callBlock`).
   */
  callEngine: SpeechEngine | null;
  callBlock: BrowserCallBlock | null;
};

let server: boolean | null = null;
let unreachable = false;
// The server's answer, or the question in flight; never a failure to ask.
let status: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Which engine this browser was set to read with. */
export function readWithNow(): ReadWith {
  try {
    return roamgateLocalStorage.getItem(READ_WITH_KEY) === "browser"
      ? "browser"
      : "server";
  } catch {
    return "server";
  }
}

/**
 * The one place the engine is decided. The server's when it has one, unless
 * this browser was set to read with its own voices (and has some); the
 * browser's otherwise; none when neither can.
 */
export function decideSpeechEngine(
  serverEngine: boolean | null,
  browser: boolean,
  readWith: ReadWith,
): SpeechEngine | null {
  if (serverEngine === true && (readWith === "server" || !browser))
    return "server";
  return browser ? "browser" : null;
}

/**
 * What reads during a voice call: the browser's voice when it is heard in
 * calls here, Roamgate's otherwise (a call always has it: it listens).
 */
export function decideCallEngine(
  engine: SpeechEngine | null,
  serverEngine: boolean | null,
  block: BrowserCallBlock | null,
): SpeechEngine | null {
  return engine === "browser" && block && serverEngine === true
    ? "server"
    : engine;
}

let snapshot: SpeechEngineState | null = null;
function current(): SpeechEngineState {
  const browser = browserSpeechRuntime() !== null;
  const readWith = readWithNow();
  const engine = decideSpeechEngine(server, browser, readWith);
  const listen = server === true;
  const callBlock = browserCallBlock();
  const callEngine = decideCallEngine(engine, server, callBlock);
  if (
    snapshot?.engine === engine &&
    snapshot.listen === listen &&
    snapshot.server === server &&
    snapshot.unreachable === unreachable &&
    snapshot.browser === browser &&
    snapshot.readWith === readWith &&
    snapshot.callEngine === callEngine &&
    snapshot.callBlock === callBlock
  )
    return snapshot;
  snapshot = {
    engine,
    listen,
    server,
    unreachable,
    browser,
    readWith,
    callEngine,
    callBlock,
  };
  return snapshot;
}

/** What reads aloud now (see decideSpeechEngine). */
export function speechEngine(): SpeechEngine | null {
  return current().engine;
}

/** Whether voice chat can listen: only the server engine hears. */
export function canListen(): boolean {
  return server === true;
}

/**
 * How long to wait before asking again a server that did not answer, while
 * something shows voice chat; then only a tap, the page shown again or the
 * network back asks.
 */
export const SPEECH_ENGINE_RETRY_MS = [1000, 2000, 5000, 10_000];
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Asks the server whether it has its voice engine, once per page when it
 * answers. A failure to ask (a 502 while it restarts, the network) is not
 * an answer: kept, it once left a phone unable to listen until reloaded.
 * The next call asks again, and so does a short backoff meanwhile.
 */
export function loadSpeechEngine(): Promise<boolean> {
  if (status) return status;
  // Asked anew (a tap, the page shown again): a full backoff again.
  retries = 0;
  return ask();
}

function ask(): Promise<boolean> {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  const asking: Promise<boolean> = fetchVoiceAvailability().then(
    (availability) => {
      if (availability.unreachable) {
        if (status === asking) status = null;
        if (!unreachable) {
          unreachable = true;
          notify();
        }
        retryLater();
        return server === true;
      }
      retries = 0;
      unreachable = false;
      server = availability.available;
      notify();
      return server;
    },
  );
  status = asking;
  return asking;
}

/** Asks again after the next backoff step, while something waits for it. */
function retryLater() {
  if (retryTimer !== null || status || listeners.size === 0) return;
  const delay = SPEECH_ENGINE_RETRY_MS[retries];
  if (delay === undefined) return;
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!status && listeners.size > 0) void ask();
  }, delay);
}

/** The page shown again, or the network back: asks if the last ask failed. */
function recheckIfUnreachable() {
  if (!unreachable || status) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden")
    return;
  void loadSpeechEngine();
}

/**
 * A tap on voice chat while it cannot listen: asks the server again first
 * (its last answer may have been a failure to ask), then starts with
 * `start` if it now listens, or says why it cannot.
 */
export async function listenOrSayWhy(start: () => void): Promise<void> {
  if (await loadSpeechEngine()) {
    start();
    return;
  }
  store.notify({
    kind: "info",
    message: "Voice chat cannot listen here",
    detail: unreachable
      ? "Roamgate's server did not answer whether it has its voice engine. Try again in a moment."
      : "Listening needs Roamgate's voice engine on the server (docs/DEPLOYMENT.md, Voice chat). Speak still reads replies aloud with this browser's voice.",
  });
}

/** Forgets what the server said, for tests. */
export function __resetSpeechEngineForTests() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  retries = 0;
  server = null;
  unreachable = false;
  status = null;
  snapshot = null;
}

let storageWatched = false;
/** Follows the engine's state (useSpeechEngine), and keeps a failed ask retried. */
export function subscribeSpeechEngine(listener: () => void) {
  if (!storageWatched) {
    storageWatched = true;
    subscribeLocalStorage((key) => {
      if (key === READ_WITH_KEY || key === SILENT_IN_CALLS_KEY || key === null)
        notify();
    });
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", recheckIfUnreachable);
    if (typeof window !== "undefined")
      window.addEventListener("online", recheckIfUnreachable);
  }
  listeners.add(listener);
  // Something shows voice chat again: a failed ask is retried.
  if (unreachable) retryLater();
  return () => {
    listeners.delete(listener);
  };
}

export function useSpeechEngine(): SpeechEngineState {
  useEffect(() => {
    void loadSpeechEngine();
  }, []);
  return useSyncExternalStore(subscribeSpeechEngine, current, current);
}

/**
 * Reads with the server's engine, or this browser's voices, from now on.
 * Chosen with a tap: the browser's voices may speak later, in a call
 * already going (prepareReading).
 */
export function setReadWith(readWith: ReadWith) {
  try {
    roamgateLocalStorage.setItem(READ_WITH_KEY, readWith);
  } catch {
    // Without storage, the server's engine reads.
  }
  notify();
  if (readWith === "browser") unlockBrowserSpeech();
}

/** Lets the browser's voice try calls again (Speech settings). */
export function retryBrowserVoiceInCalls() {
  failedHere = false;
  try {
    roamgateLocalStorage.removeItem(SILENT_IN_CALLS_KEY);
  } catch {
    // Storage blocked.
  }
  notify();
}

/** The browser's voice failed in a call here: Roamgate's reads in calls. */
function browserVoiceFailedInCall(reason: string) {
  voiceTrace(`the browser's voice failed in the call (${reason})`);
  failedHere = true;
  try {
    roamgateLocalStorage.setItem(SILENT_IN_CALLS_KEY, reason);
  } catch {
    // Kept for this page.
  }
  notify();
}

// The last call told that Roamgate's voice reads instead.
let toldCall = 0;

/** Says once a call that Roamgate's voice reads instead of the browser's. */
function tellCallFallback(block: BrowserCallBlock) {
  const call = voiceCallNumber();
  if (toldCall === call) return;
  toldCall = call;
  voiceTrace(
    `the browser's voice is not heard in calls here (${block}): Roamgate's voice engine reads`,
  );
  store.notify({
    kind: "info",
    message:
      "The browser voice can't play during calls on this device; using Roamgate's voice engine",
    detail:
      block === "android"
        ? "Android opens the microphone as a phone call, and the browser's speech is cut off or not heard beside it. Outside calls, the browser voice reads."
        : "It did not play in a call here. Speech settings can let it try again.",
  });
}

/** Traces what the browser's voice does in a voice call. */
const tracedEvents: BrowserSpeechEvents = {
  start: (text) => voiceTrace(`browser voice playing: ${text}`),
  end: (text) => voiceTrace(`browser voice ended: ${text}`),
  error: (text, reason) => voiceTrace(`browser voice error ${reason}: ${text}`),
};

type BrowserSpeech = { text: string; language?: string };

/**
 * A sentence of the browser's voice in a voice call: played by
 * speechSynthesis itself (its sound cannot go through the call's
 * AudioContext), stopped as any reading is when the speaker talks over it.
 * Failed, or not started after BROWSER_START_MS, the browser's voice is
 * done with calls here, and Roamgate's says the sentence.
 */
async function playBrowserInCall(speech: BrowserSpeech, signal: AbortSignal) {
  if (
    current().callEngine === "server" ||
    (activeCallAudio() && current().server === true)
  )
    return playWithServer(speech, signal);
  const watch = new AbortController();
  let started = false;
  let failure: string | null = null;
  const timer = setTimeout(() => {
    if (started) return;
    failure = `it did not start in ${BROWSER_START_MS / 1000} s`;
    watch.abort();
  }, BROWSER_START_MS);
  try {
    await speakWithBrowser(
      speech.text,
      AbortSignal.any([signal, watch.signal]),
      getSpeechPreferences(),
      speech.language,
      browserSpeechRuntime,
      {
        ...tracedEvents,
        start: (text) => {
          started = true;
          tracedEvents.start?.(text);
        },
        error: (text, reason) => {
          tracedEvents.error?.(text, reason);
          // Cut by something else than a stop: the sentence went unsaid.
          if (!signal.aborted && !watch.signal.aborted)
            failure ??= `it was cut (${reason})`;
        },
      },
    );
  } catch (error) {
    failure ??= (error as Error).message;
  } finally {
    clearTimeout(timer);
  }
  if (failure === null || signal.aborted) return;
  browserVoiceFailedInCall(failure);
  if (current().callEngine === "server") await playWithServer(speech, signal);
}

async function playWithServer(speech: BrowserSpeech, signal: AbortSignal) {
  const block = current().callBlock;
  if (block) tellCallFallback(block);
  const audio = await serverVoice.prepare(
    speech.text,
    signal,
    speech.language ? { language: speech.language } : undefined,
  );
  if (!signal.aborted) await serverVoice.play(audio, signal);
}

/** The browser's speech synthesis, a sentence at a time. */
export const browserVoice: SentenceVoice<BrowserSpeech> = {
  prepare: async (text, _signal, options) => ({
    text,
    ...(options?.language ? { language: options.language } : {}),
  }),
  play: (speech, signal) =>
    voiceContextHeld()
      ? playBrowserInCall(speech, signal)
      : speakWithBrowser(
          speech.text,
          signal,
          getSpeechPreferences(),
          speech.language,
        ),
};

type Prepared = { voice: SentenceVoice; speech: unknown };

/**
 * The voice that reads now: the engine in use, but during a voice call
 * (its context held) the one that reads in calls (decideCallEngine), said
 * once a call when that is not the browser's chosen voice.
 */
function readingVoice(): SentenceVoice {
  const state = current();
  if (!voiceContextHeld())
    return state.engine === "browser" ? browserVoice : serverVoice;
  // The call's audio is one stream mixed on the Mac: only Roamgate's voice
  // gets into it, whatever this browser reads with.
  if (activeCallAudio() && state.server === true) return serverVoice;
  if (
    state.engine === "browser" &&
    state.callBlock &&
    state.callEngine === "server"
  )
    tellCallFallback(state.callBlock);
  return state.callEngine === "browser" ? browserVoice : serverVoice;
}

/**
 * The engine in use, decided as each sentence is prepared: it plays with
 * the voice that made it, even if the engine changed meanwhile.
 */
export const engineVoice: SentenceVoice<Prepared> = {
  async prepare(text, signal, options) {
    const voice = readingVoice();
    return { voice, speech: await voice.prepare(text, signal, options) };
  },
  play: ({ voice, speech }, signal) => voice.play(speech, signal),
  begin: () => {
    const voice = voiceContextHeld() ? current().callEngine : current().engine;
    if (voice === "server") serverVoice.begin?.();
  },
};

/** Reads Markdown aloud with the engine in use (speakWith). */
export function speak(
  text: string,
  signal: AbortSignal,
  onSentence?: (sentence: string | null) => void,
  options?: { skip?: number },
): Promise<void> {
  return speakWith(engineVoice, text, signal, onSentence, options);
}

/** Voice chat's acks, spoken as replies are: same engine, voice and speed. */
export const ackSpeech: AckSpeech<Prepared> = {
  fetchAudio: (text, language, signal) =>
    engineVoice.prepare(text, signal, { language }),
  playAudio: (speech, signal) => engineVoice.play(speech, signal),
};

/**
 * Starting voice chat with a tap: the browser's voices, when they read,
 * may speak later (iOS Safari only speaks after a tap's first utterance).
 */
export function prepareReading() {
  if (current().callEngine === "browser") unlockBrowserSpeech();
}
