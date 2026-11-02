import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  BROWSER_START_MS,
  browserCallBlock,
  decideCallEngine,
  engineVoice,
  loadSpeechEngine,
  retryBrowserVoiceInCalls,
  setReadWith,
} from "./speechEngine";
import { updateSpeechPreferences } from "./speechPreferences";
import { store } from "./store";
import { createFrontVoice } from "./voiceFront";
import { ackSpeech } from "./speechEngine";
import { claimSpeaker } from "./voiceChat";
import { holdVoiceContext } from "./voiceOutput";

const DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

type Utterance = {
  text: string;
  rate: number;
  lang: string;
  voice: unknown;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

/** How the fake speech engine treats each utterance. */
let engine: "plays" | "silent" | "cut" = "plays";
const spoken: Utterance[] = [];
let cancels = 0;
/** Sentences Roamgate's voice was asked for, and played in the context. */
const served: string[] = [];
let contextPlays = 0;
let userAgent = DESKTOP;
const contexts: { state: string }[] = [];

const saved = new Map<string, PropertyDescriptor | undefined>();
function define(name: string, value: unknown) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

beforeAll(() => {
  const items = new Map<string, string>();
  if (!("localStorage" in globalThis))
    define("localStorage", {
      get length() {
        return items.size;
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
      clear: () => items.clear(),
    });
  const synthesis = {
    speak(utterance: Utterance) {
      spoken.push(utterance);
      if (!utterance.text || engine === "silent") return;
      setTimeout(() => {
        utterance.onstart?.();
        setTimeout(() => {
          if (engine === "cut") utterance.onerror?.({ error: "interrupted" });
          else utterance.onend?.();
        }, 5);
      }, 1);
    },
    cancel() {
      cancels += 1;
    },
    getVoices: () => [],
  };
  define("window", globalThis);
  define("speechSynthesis", synthesis);
  define(
    "SpeechSynthesisUtterance",
    class {
      rate = 1;
      lang = "";
      voice = null;
      volume = 1;
      onstart = null;
      onend = null;
      onerror = null;
      constructor(public text: string) {}
    },
  );
  define(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      constructor() {
        contexts.push(this);
      }
      onstatechange = null;
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      decodeAudioData() {
        return Promise.resolve({});
      }
      createBufferSource() {
        return {
          buffer: null,
          onended: null as (() => void) | null,
          connect() {},
          disconnect() {},
          stop() {},
          start() {
            contextPlays += 1;
            setTimeout(() => this.onended?.(), 2);
          },
        };
      }
    },
  );
  saved.set(
    "navigator",
    Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  );
  Object.defineProperty(globalThis, "navigator", {
    value: {
      get userAgent() {
        return userAgent;
      },
    },
    configurable: true,
    writable: true,
  });
  define("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/voice") return Response.json({ available: true });
    if (url === "/api/voice/speak") {
      served.push(JSON.parse(String(init?.body)).text);
      return new Response(new Uint8Array([1, 2, 3]));
    }
    if (url.startsWith("/api/voice/")) return Response.json({});
    throw new Error(`unexpected ${url}`);
  });
});

afterAll(() => {
  // voiceOutput.ts keeps the call's context: the next test files make theirs.
  for (const context of contexts) context.state = "closed";
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

beforeEach(async () => {
  engine = "plays";
  userAgent = DESKTOP;
  spoken.length = 0;
  served.length = 0;
  cancels = 0;
  contextPlays = 0;
  store.clearNotice();
  retryBrowserVoiceInCalls();
  await loadSpeechEngine();
  setReadWith("browser");
  updateSpeechPreferences({ rate: 1.5 });
});

/** A voice call: its context held until the returned stop. */
function call() {
  const ended = new AbortController();
  holdVoiceContext(ended.signal, () => {});
  return ended;
}

/** What the front says in a call, and where its reading view is. */
async function sayInCall(text: string, signal = new AbortController().signal) {
  const ended = call();
  const sentences: (number | null)[] = [];
  const front = createFrontVoice(ackSpeech, claimSpeaker);
  try {
    await front.say(text, signal, {
      onSentence: (index) => sentences.push(index),
    });
  } finally {
    ended.abort();
  }
  return sentences;
}

const said = (list: Utterance[]) =>
  list.filter((item) => item.text).map((item) => item.text);

test("a call reads with speechSynthesis itself, at the browser's rate, a sentence at a time", async () => {
  const sentences = await sayInCall("First one here. Second one there.");
  expect(said(spoken)).toEqual(["First one here.", "Second one there."]);
  expect(spoken.filter((item) => item.text).map((item) => item.rate)).toEqual([
    1.5, 1.5,
  ]);
  // The reading view hears each sentence start, then the end.
  expect(sentences).toEqual([0, 1, null]);
  expect(served).toEqual([]);
  expect(contextPlays).toBe(0);
  expect(store.get().notice).toBeNull();
});

test("speaking up stops the browser's voice in a call", async () => {
  engine = "silent";
  const ended = call();
  const front = createFrontVoice(ackSpeech, claimSpeaker);
  const saying = front.say("A long reply.", new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(said(spoken)).toEqual(["A long reply."]);
  front.hush();
  await saying;
  ended.abort();
  expect(cancels).toBeGreaterThan(0);
  expect(served).toEqual([]);
  expect(browserCallBlock(DESKTOP)).toBeNull();
});

test("on Android, a call reads with Roamgate's voice and says so once", async () => {
  userAgent = ANDROID;
  const ended = call();
  const front = createFrontVoice(ackSpeech, claimSpeaker);
  const sentences: (number | null)[] = [];
  await front.say("First one here. Second one there.", ended.signal, {
    onSentence: (index) => sentences.push(index),
  });
  const notice = store.get().notice;
  store.clearNotice();
  await front.say("Third.", ended.signal);
  ended.abort();
  expect(said(spoken)).toEqual([]);
  expect(served).toEqual(["First one here.", "Second one there.", "Third."]);
  expect(contextPlays).toBe(3);
  expect(sentences).toEqual([0, 1, null]);
  expect(notice?.message).toBe(
    "The browser voice can't play during calls on this device; using Roamgate's voice engine",
  );
  // Once a call.
  expect(store.get().notice).toBeNull();
});

test("outside calls, Android reads with the browser's voice", async () => {
  userAgent = ANDROID;
  await engineVoice.play(
    await engineVoice.prepare("Hello there.", new AbortController().signal),
    new AbortController().signal,
  );
  expect(said(spoken)).toEqual(["Hello there."]);
  expect(served).toEqual([]);
});

test("a sentence cut by something else falls back to Roamgate's voice for good here", async () => {
  engine = "cut";
  const sentences = await sayInCall("First one here. Second one there.");
  // The first was tried, cut, and said again by Roamgate's voice; the
  // second went straight to it.
  expect(said(spoken)).toEqual(["First one here."]);
  expect(served).toEqual(["First one here.", "Second one there."]);
  expect(sentences).toEqual([0, 1, null]);
  expect(browserCallBlock(DESKTOP)).toBe("failed");
  expect(store.get().notice?.message).toContain("can't play during calls");
  // Speech settings let it try again.
  retryBrowserVoiceInCalls();
  expect(browserCallBlock(DESKTOP)).toBeNull();
});

test("a browser voice that never starts in a call gives way after a while", async () => {
  engine = "silent";
  const realTimeout = globalThis.setTimeout;
  // Its deadline, shortened: only that timer is.
  define("setTimeout", ((handler: () => void, ms?: number) =>
    realTimeout(
      handler,
      ms === BROWSER_START_MS ? 10 : ms,
    )) as typeof setTimeout);
  try {
    await sayInCall("Nothing comes.");
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  expect(said(spoken)).toEqual(["Nothing comes."]);
  expect(served).toEqual(["Nothing comes."]);
  expect(browserCallBlock(DESKTOP)).toBe("failed");
});

test("the call engine is Roamgate's only when the browser's is blocked in calls", () => {
  expect(decideCallEngine("browser", true, null)).toBe("browser");
  expect(decideCallEngine("browser", true, "android")).toBe("server");
  expect(decideCallEngine("browser", true, "failed")).toBe("server");
  expect(decideCallEngine("server", true, "android")).toBe("server");
  // Without Roamgate's voice, nothing else could read.
  expect(decideCallEngine("browser", false, "android")).toBe("browser");
});
