import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { noteOwnPlay, RETRY_MS, resetMediaControls } from "./playbackGuard";
import {
  fetchVoiceAvailability,
  HOLDER_RESUME_MS,
  holdAudioFocus,
  readingId,
  serverVoice,
  setSpeechRate,
  toggleReading,
} from "./voiceChat";
import { setVoiceOutputMode, voiceContext } from "./voiceOutput";

/**
 * Android's audio focus, as far as the page sees it: one media element has
 * it, and one that starts playing takes it, pausing the one that had it.
 */
const focus = {
  holder: null as FocusAudio | null,
  made: 0,
  /** Each element paused by another taking the focus: [paused, taker]. */
  taken: [] as [FocusAudio, FocusAudio][],
};

class FocusAudio {
  loop = false;
  paused = true;
  ended = false;
  currentTime = 0;
  /** A sentence's 0.4 s; the silent loop never ends. */
  duration = 0.4;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  error = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (() => void)[]>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor() {
    focus.made += 1;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener() {}
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  play() {
    const had = focus.holder;
    if (had && had !== this && !had.paused) {
      focus.taken.push([had, this]);
      had.stop();
    }
    focus.holder = this;
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    this.fire("playing");
    this.ticker = setInterval(() => {
      this.currentTime += 0.01 * this.playbackRate;
      if (this.loop || this.currentTime < this.duration) return;
      this.ended = true;
      this.stop();
      this.fire("ended");
      this.onended?.();
    }, 10);
    return Promise.resolve();
  }
  pause() {
    this.stop();
  }
  private stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }
  get isHolder() {
    return this.loop;
  }
}

/** The call's AudioContext: buffers that play 0.4 s, counted. */
const context = { played: 0, rates: [] as number[] };
class FakeContext {
  state = "running";
  destination = {};
  onstatechange: (() => void) | null = null;
  resume = async () => {};
  close = async () => {
    this.state = "closed";
  };
  async decodeAudioData() {
    return { duration: 0.4 };
  }
  createBufferSource() {
    const source = {
      buffer: null as unknown,
      playbackRate: { value: 1 },
      onended: null as (() => void) | null,
      connect() {},
      disconnect() {},
      start() {
        context.played += 1;
        context.rates.push(source.playbackRate.value);
        setTimeout(() => source.onended?.(), 400);
      },
      stop() {},
    };
    return source;
  }
}

const traces: string[] = [];
const saved = {
  fetch: globalThis.fetch,
  Audio: Object.getOwnPropertyDescriptor(globalThis, "Audio"),
  AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
};
const define = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });

beforeEach(async () => {
  focus.holder = null;
  focus.made = 0;
  focus.taken = [];
  context.played = 0;
  context.rates = [];
  traces.length = 0;
  define("Audio", FocusAudio);
  define("AudioContext", FakeContext);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/voice")
      return Response.json({ available: true, debug: true, speech_rate: 1.5 });
    if (url === "/api/voice/trace") {
      traces.push(JSON.parse(String(init?.body)).line);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/voice/speak") {
      const asked = JSON.parse(String(init?.body)) as { rate?: number };
      // The server makes it at the rate asked.
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "x-voice-native-rate": String(asked.rate ?? 1) },
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof globalThis.fetch;
  await fetchVoiceAvailability();
  setSpeechRate(1.5);
  // Another file's context may still be kept: this one's fake from now on.
  const kept = voiceContext();
  if (!(kept instanceof FakeContext)) await kept.close();
});

afterEach(() => {
  jest.useRealTimers();
  resetMediaControls();
  setVoiceOutputMode("context");
  globalThis.fetch = saved.fetch;
  for (const name of ["Audio", "AudioContext"] as const) {
    const descriptor = saved[name];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** Lets fake time pass, `ms` at a time, with the promises it settles. */
async function pass(ms: number) {
  for (let at = 0; at < ms; at += 10) {
    jest.advanceTimersByTime(10);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }
}

const TEXT = "First sentence here. Second sentence here. Third and last one.";

describe("one audio focus", () => {
  test("in a call, replies at 1.5x play in the call's context, with no media element", async () => {
    jest.useFakeTimers();
    setVoiceOutputMode("context");
    const call = new AbortController();
    holdAudioFocus(call.signal);
    const errors: string[] = [];
    toggleReading("m1", TEXT, (error) => errors.push(error), serverVoice);
    await pass(3000);
    expect(readingId()).toBeNull();
    expect(errors).toEqual([]);
    // No silent holder, no sentence element: nothing to compete.
    expect(focus.made).toBe(0);
    expect(context.played).toBe(3);
    // Made at 1.5 by the server: played as it is.
    expect(context.rates).toEqual([1, 1, 1]);
    call.abort();
  });

  test("as media, the focus holder stays quiet while a 1.5x reply plays", async () => {
    jest.useFakeTimers();
    setVoiceOutputMode("element");
    const call = new AbortController();
    holdAudioFocus(call.signal);
    await pass(50);
    const holder = focus.holder;
    expect(holder?.isHolder).toBe(true);
    expect(holder?.paused).toBe(false);
    const errors: string[] = [];
    toggleReading("m1", TEXT, (error) => errors.push(error), serverVoice);
    await pass(4000);
    expect(readingId()).toBeNull();
    expect(errors).toEqual([]);
    // No sentence lost the focus to the holder, nor the holder while it
    // was meant to play: they never took turns.
    expect(focus.taken).toEqual([]);
    const log = traces.join("\n");
    expect(log).not.toContain("paused from outside the page");
    expect(log).toContain("goes quiet while a sentence plays");
    // The reading is over: the holder holds the focus again.
    await pass(HOLDER_RESUME_MS + 100);
    expect(focus.holder).toBe(holder);
    expect(holder?.paused).toBe(false);
    call.abort();
    expect(holder?.paused).toBe(true);
  });

  test("a sentence paused by the holder makes it yield, and never loops", async () => {
    jest.useFakeTimers();
    setVoiceOutputMode("element");
    const call = new AbortController();
    holdAudioFocus(call.signal);
    await pass(50);
    const holder = focus.holder!;
    toggleReading("m1", "Only one sentence here.", () => {}, serverVoice);
    await pass(100);
    // The holder plays over the sentence (as its old restart did).
    noteOwnPlay(holder, () => holder.pause());
    void holder.play();
    await pass(3000);
    expect(readingId()).toBeNull();
    const log = traces.join("\n");
    expect(log).toContain("not an outside pause");
    // At most a try per pause of the sentence, and far fewer than a loop.
    const tries = log.split("\n").filter((line) => line.includes("(try "));
    expect(tries.length).toBeLessThanOrEqual(RETRY_MS.length);
    call.abort();
  });
});
