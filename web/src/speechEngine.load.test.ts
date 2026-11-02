import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  __resetSpeechEngineForTests,
  canListen,
  listenOrSayWhy,
  loadSpeechEngine,
  SPEECH_ENGINE_RETRY_MS,
  subscribeSpeechEngine,
} from "./speechEngine";
import { store } from "./store";

/** What GET /api/voice does next: answer, fail with a status, or throw. */
let replies: (boolean | number | "network")[] = [];
let asked = 0;
let savedFetch: typeof fetch;

beforeEach(() => {
  __resetSpeechEngineForTests();
  store.clearNotice();
  replies = [];
  asked = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/voice") throw new Error(`unexpected ${input}`);
    asked += 1;
    const reply = replies.shift() ?? true;
    if (reply === "network") throw new TypeError("Failed to fetch");
    if (typeof reply === "number")
      return new Response("Bad Gateway", {
        status: reply,
        statusText: "Bad Gateway",
      });
    return Response.json({ available: reply });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  __resetSpeechEngineForTests();
  store.clearNotice();
});

test("a failure to ask the server is not kept: the next call asks again", async () => {
  replies = [502, "network", true];
  expect(await loadSpeechEngine()).toBe(false);
  expect(canListen()).toBe(false);
  expect(await loadSpeechEngine()).toBe(false);
  expect(await loadSpeechEngine()).toBe(true);
  expect(canListen()).toBe(true);
  // The answer is kept.
  expect(await loadSpeechEngine()).toBe(true);
  expect(asked).toBe(3);
});

test("a real no from the server stays", async () => {
  replies = [false, true];
  expect(await loadSpeechEngine()).toBe(false);
  expect(await loadSpeechEngine()).toBe(false);
  expect(asked).toBe(1);
});

/** Something showing voice chat: what keeps the retries going. */
const watch = () => subscribeSpeechEngine(() => {});

test("a failure is retried with a backoff while voice chat shows, then a success listens", async () => {
  jest.useFakeTimers();
  const stop = watch();
  try {
    replies = [502, 502, "network", true];
    await loadSpeechEngine();
    expect(asked).toBe(1);
    jest.advanceTimersByTime(SPEECH_ENGINE_RETRY_MS[0]!);
    await flush();
    expect(asked).toBe(2);
    await flush();
    jest.advanceTimersByTime(SPEECH_ENGINE_RETRY_MS[1]!);
    await flush();
    expect(asked).toBe(3);
    jest.advanceTimersByTime(SPEECH_ENGINE_RETRY_MS[2]!);
    await flush();
    expect(asked).toBe(4);
    expect(canListen()).toBe(true);
    // Answered: no more asking.
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(asked).toBe(4);
  } finally {
    stop();
    jest.useRealTimers();
  }
});

test("the backoff stops after its last step", async () => {
  jest.useFakeTimers();
  const stop = watch();
  try {
    replies = Array(10).fill(502);
    await loadSpeechEngine();
    for (const delay of SPEECH_ENGINE_RETRY_MS) {
      jest.advanceTimersByTime(delay);
      await flush();
    }
    expect(asked).toBe(1 + SPEECH_ENGINE_RETRY_MS.length);
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(asked).toBe(1 + SPEECH_ENGINE_RETRY_MS.length);
  } finally {
    stop();
    jest.useRealTimers();
  }
});

test("a tap while voice chat cannot listen asks again, and starts if it now can", async () => {
  replies = [502, true];
  await loadSpeechEngine();
  let started = 0;
  await listenOrSayWhy(() => {
    started += 1;
  });
  expect(asked).toBe(2);
  expect(started).toBe(1);
  expect(store.get().notice).toBeNull();
});

test("a tap says voice chat cannot listen only when the server still says no", async () => {
  replies = [false];
  await loadSpeechEngine();
  let started = 0;
  await listenOrSayWhy(() => {
    started += 1;
  });
  expect(started).toBe(0);
  expect(store.get().notice?.message).toBe("Voice chat cannot listen here");
});

/** Lets the fake server's answer reach the engine. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
