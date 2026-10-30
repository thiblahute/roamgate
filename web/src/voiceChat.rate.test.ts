import { expect, test } from "bun:test";
import {
  getSpeechRate,
  readingId,
  saveSpeechRate,
  serverVoice,
  setSpeechRate,
  subscribeReading,
  toggleReading,
} from "./voiceChat";

/**
 * An audio element that plays for a few ms and says at which rate it ended
 * (the rate set while it plays counts, as in a browser).
 */
function fakeAudio(ended: number[]) {
  return class {
    playbackRate = 1;
    defaultPlaybackRate = 1;
    preservesPitch = false;
    currentTime = 0;
    duration = 1;
    paused = true;
    ended = false;
    error = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private listeners = new Map<string, (() => void)[]>();
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    removeEventListener() {}
    pause() {
      this.paused = true;
    }
    play() {
      this.paused = false;
      for (const listener of this.listeners.get("playing") ?? []) listener();
      setTimeout(() => {
        this.ended = true;
        ended.push(this.playbackRate);
        this.onended?.();
      }, 5);
      return Promise.resolve();
    }
  };
}

async function withServer(
  speechRate: () => number,
  run: (ended: number[]) => Promise<void>,
) {
  const ended: number[] = [];
  const fetch = globalThis.fetch;
  const audio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/voice")
      return Response.json({ available: true, speech_rate: speechRate() });
    if (url === "/api/voice/speak")
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "x-voice-native-rate": "1" },
      });
    if (url === "/api/voice/settings") return new Response(null);
    throw new Error(`unexpected ${url}`);
  }) as typeof globalThis.fetch;
  Object.defineProperty(globalThis, "Audio", {
    value: fakeAudio(ended),
    configurable: true,
    writable: true,
  });
  try {
    await run(ended);
  } finally {
    globalThis.fetch = fetch;
    if (audio) Object.defineProperty(globalThis, "Audio", audio);
    else Reflect.deleteProperty(globalThis, "Audio");
  }
}

/** Reads `text` from a message's button with the server's voice, to the end. */
function readMessage(text: string): Promise<string[]> {
  const errors: string[] = [];
  return new Promise((resolve) => {
    toggleReading("m1", text, (error) => errors.push(error), serverVoice);
    const stop = subscribeReading(() => {
      if (readingId() !== null) return;
      stop();
      resolve(errors);
    });
  });
}

test("a message read aloud plays at the speed chosen on another device", async () => {
  // This page asked the server when the speed was 1; it was set to 1.5
  // elsewhere since.
  setSpeechRate(1);
  await withServer(
    () => 1.5,
    async (ended) => {
      expect(await readMessage("First sentence. Second one.")).toEqual([]);
      expect(ended).toEqual([1.5, 1.5]);
      expect(getSpeechRate()).toBe(1.5);
    },
  );
});

test("a speed chosen here is not undone by the server's older answer", async () => {
  setSpeechRate(1);
  let serverRate = 1;
  await withServer(
    () => serverRate,
    async (ended) => {
      const reading = readMessage("Only one sentence.");
      // Chosen while the reading asks the server, which still says 1.
      await saveSpeechRate(1.3);
      serverRate = 1.3;
      expect(await reading).toEqual([]);
      expect(ended).toEqual([1.3]);
      expect(getSpeechRate()).toBe(1.3);
    },
  );
});
