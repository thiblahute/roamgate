import { useEffect, useSyncExternalStore } from "react";
import { roamgateLocalStorage, subscribeLocalStorage } from "./browserStorage";
import {
  browserSpeechRuntime,
  speakWithBrowser,
  unlockBrowserSpeech,
} from "./speechPlayback";
import { getSpeechPreferences } from "./speechPreferences";
import type { AckSpeech } from "./voiceAck";
import {
  fetchVoiceAvailability,
  type SentenceVoice,
  serverVoice,
  speakWith,
} from "./voiceChat";

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

export type SpeechEngineState = {
  /** What reads aloud now; null when nothing can. */
  engine: SpeechEngine | null;
  /** Whether voice chat can listen: the server engine is there. */
  listen: boolean;
  /** Whether the server has its voice engine; null until it said. */
  server: boolean | null;
  /** Whether the browser can speak. */
  browser: boolean;
  readWith: ReadWith;
};

let server: boolean | null = null;
let status: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

function readWithNow(): ReadWith {
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

let snapshot: SpeechEngineState | null = null;
function current(): SpeechEngineState {
  const browser = browserSpeechRuntime() !== null;
  const readWith = readWithNow();
  const engine = decideSpeechEngine(server, browser, readWith);
  const listen = server === true;
  if (
    snapshot?.engine === engine &&
    snapshot.listen === listen &&
    snapshot.server === server &&
    snapshot.browser === browser &&
    snapshot.readWith === readWith
  )
    return snapshot;
  snapshot = { engine, listen, server, browser, readWith };
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

/** Asks the server once per page whether it has its voice engine. */
export function loadSpeechEngine(): Promise<boolean> {
  status ??= fetchVoiceAvailability().then((availability) => {
    server = availability.available;
    notify();
    return server;
  });
  return status;
}

let storageWatched = false;
function subscribe(listener: () => void) {
  if (!storageWatched) {
    storageWatched = true;
    subscribeLocalStorage((key) => {
      if (key === READ_WITH_KEY || key === null) notify();
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSpeechEngine(): SpeechEngineState {
  useEffect(() => {
    void loadSpeechEngine();
  }, []);
  return useSyncExternalStore(subscribe, current, current);
}

/** Reads with the server's engine, or this browser's voices, from now on. */
export function setReadWith(readWith: ReadWith) {
  try {
    roamgateLocalStorage.setItem(READ_WITH_KEY, readWith);
  } catch {
    // Without storage, the server's engine reads.
  }
  notify();
}

/** The browser's speech synthesis, a sentence at a time. */
export const browserVoice: SentenceVoice<{ text: string; language?: string }> =
  {
    prepare: async (text, _signal, options) => ({
      text,
      ...(options?.language ? { language: options.language } : {}),
    }),
    play: (speech, signal) =>
      speakWithBrowser(
        speech.text,
        signal,
        getSpeechPreferences(),
        speech.language,
      ),
  };

type Prepared = { voice: SentenceVoice; speech: unknown };

/**
 * The engine in use, decided as each sentence is prepared: it plays with
 * the voice that made it, even if the engine changed meanwhile.
 */
export const engineVoice: SentenceVoice<Prepared> = {
  async prepare(text, signal, options) {
    const voice = speechEngine() === "browser" ? browserVoice : serverVoice;
    return { voice, speech: await voice.prepare(text, signal, options) };
  },
  play: ({ voice, speech }, signal) => voice.play(speech, signal),
  begin: () => {
    if (speechEngine() === "server") serverVoice.begin?.();
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
  if (speechEngine() === "browser") unlockBrowserSpeech();
}
