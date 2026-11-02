import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  guardPlayback,
  mediaControlPause,
  mediaControlPlay,
  noteOwnPlay,
  RETRY_MS,
  readingPlays,
  resetMediaControls,
} from "./playbackGuard";

/** An audio element the test pauses, and whose play() it answers. */
function fakePlayer(duration = 6) {
  const listeners = new Map<string, (() => void)[]>();
  const player = {
    ended: false,
    paused: false,
    duration,
    currentTime: 0,
    plays: 0,
    refuse: false,
    play() {
      player.plays += 1;
      if (player.refuse) return Promise.reject(new Error("NotAllowedError"));
      player.paused = false;
      player.fire("playing");
      return Promise.resolve();
    },
    pause() {
      if (player.paused) return;
      player.paused = true;
      player.fire("pause");
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
  return player;
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** Each test's guards, released after it. */
const guards: { release: () => void }[] = [];
const guarded = (...args: Parameters<typeof guardPlayback>) => {
  const guard = guardPlayback(...args);
  guards.push(guard);
  return guard;
};

// Another file's media may have played just before.
beforeEach(() => resetMediaControls());

afterEach(() => {
  for (const guard of guards.splice(0)) guard.release();
  resetMediaControls();
  jest.useRealTimers();
});

describe("playback guard", () => {
  test("a pause from outside the page plays on", () => {
    jest.useFakeTimers();
    const trace: string[] = [];
    const player = fakePlayer();
    guarded(player, { trace: (l) => trace.push(l), onGiveUp() {} });
    player.currentTime = 0.04;
    player.pause();
    expect(player.plays).toBe(0);
    jest.advanceTimersByTime(RETRY_MS[0]!);
    expect(player.plays).toBe(1);
    expect(player.paused).toBe(false);
    // Played on from where it was.
    expect(player.currentTime).toBe(0.04);
    expect(trace.join("\n")).toContain("paused from outside the page");
    expect(trace.join("\n")).toContain("playing again");
  });

  test("refused, it is tried again from the sentence's start, then skipped", async () => {
    jest.useFakeTimers();
    const trace: string[] = [];
    const player = fakePlayer();
    let gaveUp = false;
    guarded(player, {
      trace: (l) => trace.push(l),
      onGiveUp: () => {
        gaveUp = true;
      },
    });
    player.refuse = true;
    player.currentTime = 2;
    player.pause();
    for (const delay of RETRY_MS) {
      jest.advanceTimersByTime(delay);
      await flush();
    }
    expect(player.plays).toBe(RETRY_MS.length);
    expect(player.currentTime).toBe(0);
    expect(gaveUp).toBe(true);
    expect(trace.join("\n")).toContain("again from its start");
    expect(trace.join("\n")).toContain("skipped");
  });

  test("a pause that keeps coming back has the sentence's tries, then skips it", async () => {
    jest.useFakeTimers();
    const trace: string[] = [];
    const player = fakePlayer();
    let gaveUp = 0;
    guarded(player, {
      trace: (l) => trace.push(l),
      onGiveUp: () => {
        gaveUp += 1;
      },
    });
    // Each try plays a moment, then the focus is taken again.
    for (let pause = 0; pause < 20; pause += 1) {
      player.pause();
      jest.advanceTimersByTime(10_000);
      await flush();
    }
    expect(player.plays).toBe(RETRY_MS.length);
    expect(gaveUp).toBe(1);
    expect(trace.join("\n")).toContain("skipped after 4 tries");
    // Given up, it is no reading any more.
    expect(readingPlays()).toBe(false);
  });

  test("a pause just after the page's own media plays is not from outside", () => {
    jest.useFakeTimers();
    const trace: string[] = [];
    const player = fakePlayer();
    guarded(player, { trace: (l) => trace.push(l), onGiveUp() {} });
    expect(readingPlays()).toBe(true);
    let yielded = 0;
    noteOwnPlay({}, () => {
      yielded += 1;
    });
    player.pause();
    expect(yielded).toBe(1);
    expect(trace.join("\n")).toContain("not an outside pause");
    expect(trace.join("\n")).not.toContain("paused from outside the page");
    jest.advanceTimersByTime(RETRY_MS[0]!);
    expect(player.paused).toBe(false);
  });

  test("a pause from the car's controls is honoured until play", () => {
    jest.useFakeTimers();
    const trace: string[] = [];
    const player = fakePlayer();
    guarded(player, { trace: (l) => trace.push(l), onGiveUp() {} });
    mediaControlPause((l) => trace.push(l));
    expect(player.paused).toBe(true);
    jest.advanceTimersByTime(20_000);
    expect(player.plays).toBe(0);
    mediaControlPlay((l) => trace.push(l));
    expect(player.plays).toBe(1);
    expect(player.paused).toBe(false);
    expect(trace.join("\n")).toContain("waits for play");
  });

  test("the page's own pause (stop, barge-in, the end) is left alone", () => {
    jest.useFakeTimers();
    const player = fakePlayer();
    const guard = guarded(player, { trace() {}, onGiveUp() {} });
    guard.release();
    player.pause();
    jest.advanceTimersByTime(20_000);
    expect(player.plays).toBe(0);

    const ending = fakePlayer(2);
    guarded(ending, { trace() {}, onGiveUp() {} });
    ending.currentTime = 2;
    ending.ended = true;
    ending.pause();
    jest.advanceTimersByTime(20_000);
    expect(ending.plays).toBe(0);
  });
});
