import { chunkSpeech } from "./markdownToSpeech";
import type { SpeechPreferences } from "./speechPreferences";

export type SpeechRuntime = {
  synthesis: Pick<SpeechSynthesis, "speak" | "cancel" | "getVoices">;
  utterance: (text: string) => SpeechSynthesisUtterance;
};
export function browserSpeechRuntime(): SpeechRuntime | null {
  if (
    typeof window === "undefined" ||
    !window.speechSynthesis ||
    typeof window.SpeechSynthesisUtterance !== "function"
  )
    return null;
  return {
    synthesis: window.speechSynthesis,
    utterance: (text) => new window.SpeechSynthesisUtterance(text),
  };
}
export type SpeechState = {
  owner: symbol | null;
  messageId: string | null;
  status: "idle" | "speaking" | "stopped" | "completed" | "failed";
  error: string;
};
const idle: SpeechState = {
  owner: null,
  messageId: null,
  status: "idle",
  error: "",
};

/** One controller per tab: a new request invalidates all callbacks from the old one. */
export class SpeechPlayback {
  private state = idle;
  private listeners = new Set<() => void>();
  private generation = 0;
  private runtime: SpeechRuntime | null = null;
  // Keep a strong reference: some browsers otherwise lose utterance callbacks.
  private current: SpeechSynthesisUtterance | null = null;
  constructor(private getRuntime = browserSpeechRuntime) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: SpeechState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  stop(owner?: symbol) {
    if (owner !== undefined && this.state.owner !== owner) return;
    ++this.generation;
    const wasSpeaking = this.state.status === "speaking";
    const runtime = this.runtime;
    this.runtime = null;
    if (this.current) {
      this.current.onend = null;
      this.current.onerror = null;
    }
    this.current = null;
    try {
      runtime?.synthesis.cancel();
    } catch {
      /* Cancellation is best effort. */
    }
    if (wasSpeaking)
      this.publish({ ...this.state, status: "stopped", error: "" });
  }
  start(
    owner: symbol,
    messageId: string,
    text: string,
    preferences: SpeechPreferences,
  ) {
    this.stop();
    const generation = this.generation;
    const base = { owner, messageId, error: "" };
    const fail = (
      error = "Speech playback failed. Try another voice or try again.",
    ) => {
      if (generation !== this.generation) return;
      this.stop();
      this.publish({ ...base, status: "failed", error });
    };
    this.runtime = this.getRuntime();
    const runtime = this.runtime;
    if (!runtime) {
      fail("Speech is not supported by this browser.");
      return;
    }
    const chunks = chunkSpeech(text);
    if (!chunks.length) {
      fail("This message has no readable text.");
      return;
    }
    this.publish({ ...base, status: "speaking" });
    let index = 0;
    const next = () => {
      if (generation !== this.generation) return;
      if (index === chunks.length) {
        this.current = null;
        this.runtime = null;
        this.publish({ ...base, status: "completed" });
        return;
      }
      try {
        const utterance = runtime.utterance(chunks[index++]!);
        this.current = utterance;
        utterance.rate = preferences.rate;
        const voice = runtime.synthesis
          .getVoices()
          .find((item) => item.voiceURI === preferences.voiceURI);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        // Only the current utterance may advance the queue, including duplicate events.
        utterance.onend = () => {
          if (this.current !== utterance || generation !== this.generation)
            return;
          this.current = null;
          next();
        };
        utterance.onerror = () => {
          if (this.current === utterance) fail();
        };
        runtime.synthesis.speak(utterance);
      } catch {
        fail();
      }
    };
    // The first speak() stays on the user's click stack (important on iOS).
    next();
  }
}
export const speechPlayback = new SpeechPlayback();

/**
 * Speaks `text` with the browser's speech synthesis and `preferences`, in
 * bounded chunks; resolves when it is over or `signal` aborts. Without a
 * chosen voice, or when the chosen one does not speak `language`, a voice
 * of `language` reads it. Voice chat reads a sentence at a time with it.
 */
export function speakWithBrowser(
  text: string,
  signal: AbortSignal,
  preferences: SpeechPreferences,
  language?: string,
  getRuntime = browserSpeechRuntime,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const runtime = getRuntime();
    if (!runtime)
      return reject(new Error("Speech is not supported by this browser."));
    const chunks = chunkSpeech(text);
    const voices = runtime.synthesis.getVoices();
    const chosen = voices.find(
      (item) => item.voiceURI === preferences.voiceURI,
    );
    const speaks = (voice: SpeechSynthesisVoice) =>
      !language || voice.lang.toLowerCase().startsWith(language.toLowerCase());
    const voice =
      chosen && speaks(chosen)
        ? chosen
        : language
          ? voices.find(speaks)
          : undefined;
    let current: SpeechSynthesisUtterance | null = null;
    let index = 0;
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", stop);
      if (current) {
        current.onend = null;
        current.onerror = null;
      }
      current = null;
      if (error) reject(error);
      else resolve();
    };
    const stop = () => {
      finish();
      try {
        runtime.synthesis.cancel();
      } catch {
        /* Cancellation is best effort. */
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    const next = () => {
      if (signal.aborted) return;
      if (index === chunks.length) return finish();
      try {
        const utterance = runtime.utterance(chunks[index++]!);
        // Kept: some browsers otherwise lose utterance callbacks.
        current = utterance;
        utterance.rate = preferences.rate;
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        } else if (language) utterance.lang = language;
        utterance.onend = () => {
          if (current === utterance) next();
        };
        utterance.onerror = (event) => {
          if (current !== utterance) return;
          // Cancelled by another reading: over, not failed.
          const reason = (event as SpeechSynthesisErrorEvent | undefined)
            ?.error;
          if (reason === "interrupted" || reason === "canceled") finish();
          else finish(new Error("Speech playback failed."));
        };
        runtime.synthesis.speak(utterance);
      } catch {
        finish(new Error("Speech playback failed."));
      }
    };
    next();
  });
}

/**
 * Lets the browser speak later: some (iOS Safari) only speak after a first
 * utterance started from a tap, such as the one starting voice chat.
 */
export function unlockBrowserSpeech(getRuntime = browserSpeechRuntime) {
  const runtime = getRuntime();
  if (!runtime) return;
  try {
    const utterance = runtime.utterance("");
    utterance.volume = 0;
    runtime.synthesis.speak(utterance);
  } catch {
    /* Best effort. */
  }
}
