import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeCallAudio,
  CALL_WORKLET,
  CallAudio,
  type CallChannel,
  CallJitter,
  isQueuedSpeech,
  parseCallPacket,
  RELEASE_MS,
} from "./callAudio";
import type { ChannelEvent } from "./voiceChannel";

/** `ms` of interleaved stereo at 48 kHz, every sample `value`. */
const audio = (ms: number, value = 0.5) =>
  new Float32Array((ms * 48 * 2) | 0).fill(value);

describe("call jitter buffer", () => {
  test("waits for 200 ms before it plays", () => {
    const jitter = new CallJitter();
    jitter.push(audio(180), 0);
    expect(jitter.pull(128).every((s) => s === 0)).toBe(true);
    expect(jitter.positionMs()).toBeNull();
    jitter.push(audio(20), 180);
    const out = jitter.pull(128);
    expect(out.every((s) => s === 0.5)).toBe(true);
    expect(jitter.positionMs()).toBeCloseTo((128 / 48_000) * 1000, 5);
  });

  test("plays silence when it runs dry, then buffers again", () => {
    const jitter = new CallJitter();
    jitter.push(audio(200), 0);
    // 200 ms, then more than there is.
    jitter.pull(9600);
    const out = jitter.pull(480);
    expect(out.every((s) => s === 0)).toBe(true);
    expect(jitter.underruns).toBe(1);
    expect(jitter.playing).toBe(false);
    jitter.push(audio(60), 200);
    expect(jitter.pull(128).every((s) => s === 0)).toBe(true);
  });

  test("absorbs a burst without cutting anything", () => {
    const jitter = new CallJitter();
    jitter.push(audio(200), 0);
    jitter.pull(128);
    // A second of audio at once, after the network held it.
    for (let i = 0; i < 100; i += 1) jitter.push(audio(10), 200 + i * 10);
    expect(jitter.dropped).toBe(0);
  });

  test("drops the quietest whole block only past its most", () => {
    const jitter = new CallJitter(120, 60, 400);
    const loud = audio(400, 0.5);
    // One quiet 10 ms block, 50 ms in.
    loud.fill(0.01, 50 * 96, 60 * 96);
    jitter.push(loud, 0);
    expect(jitter.dropped).toBe(0);
    jitter.push(audio(10, 0.5), 400);
    expect(jitter.dropped).toBe(1);
    expect(jitter.bufferedMs()).toBeCloseTo(400, 5);
    expect(jitter.blocks.every((block) => block.samples[0] === 0.5)).toBe(true);
  });

  test("makes up drift by at most 1% of pace, without drops or underruns", () => {
    for (const phoneFaster of [true, false]) {
      const jitter = new CallJitter();
      jitter.push(audio(200), 0);
      let pts = 200;
      // The phone's clock 0.3% off the Mac's, for ten minutes.
      const outRate = 48_000 * (phoneFaster ? 1.003 : 0.997);
      let owed = 0;
      for (let i = 0; i < 60_000; i += 1) {
        jitter.push(audio(10), pts);
        pts += 10;
        // 10 ms of the phone's time, in its frames.
        owed += outRate / 100;
        const frames = Math.floor(owed);
        owed -= frames;
        jitter.pull(frames, 48_000);
        expect(Math.abs(jitter.pace - 1)).toBeLessThanOrEqual(0.01 + 1e-9);
      }
      expect(jitter.underruns).toBe(0);
      expect(jitter.dropped).toBe(0);
      expect(Math.abs(jitter.bufferedMs() - 200)).toBeLessThan(200);
    }
  });

  test("plays 48 kHz audio in a 44.1 kHz context at its own pace", () => {
    const jitter = new CallJitter();
    // A 1 kHz sine, 2 s.
    const sine = new Float32Array(96_000 * 2);
    for (let i = 0; i < sine.length / 2; i += 1) {
      const v = Math.sin((2 * Math.PI * 1000 * i) / 48_000);
      sine[2 * i] = v;
      sine[2 * i + 1] = v;
    }
    jitter.push(sine, 0);
    const out = jitter.pull(44_100, 44_100);
    // Upward zero crossings over a second: 1000, not 1088.
    let ups = 0;
    for (let i = 1; i < 44_100; i += 1)
      if (out[2 * (i - 1)]! < 0 && out[2 * i]! >= 0) ups += 1;
    expect(Math.abs(ups - 1000)).toBeLessThanOrEqual(25);
  });

  test("near its target, what comes out is what went in", () => {
    const jitter = new CallJitter();
    const ramp = new Float32Array(48 * 230 * 2);
    for (let i = 0; i < ramp.length; i += 1) ramp[i] = (i >> 1) / 1e6;
    jitter.push(ramp, 0);
    const out = jitter.pull(48 * 100);
    for (let i = 0; i < out.length; i += 1) expect(out[i]).toBe(ramp[i]!);
  });
});

describe("call audio", () => {
  test("the worklet's source runs on its own", () => {
    const registered: string[] = [];
    // AudioWorkletGlobalScope, as far as the worklet uses it.
    new Function("AudioWorkletProcessor", "registerProcessor", CALL_WORKLET)(
      class {
        port = { postMessage() {}, onmessage: null };
      },
      (name: string) => registered.push(name),
    );
    expect(registered).toEqual(["roamgate-call-output"]);
  });

  test("nothing in the call's output changes the speed beyond 1%", () => {
    const source = readFileSync(join(import.meta.dir, "callAudio.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toContain("playbackRate");
    expect(code).not.toContain("detune");
    expect(code).toContain("this.maxPace = 0.01;");
  });

  test("reads a packet's header", () => {
    const message = new Uint8Array(15);
    const view = new DataView(message.buffer);
    view.setUint32(0, 7, true);
    view.setBigUint64(4, 123_456n, true);
    message.set([1, 2, 3], 12);
    const packet = parseCallPacket(message.buffer);
    expect(packet?.seq).toBe(7);
    expect(packet?.ptsUs).toBe(123_456);
    expect([...(packet?.packet ?? [])]).toEqual([1, 2, 3]);
    expect(parseCallPacket(new ArrayBuffer(12))).toBeNull();
  });

  test("knows a queued sentence", () => {
    expect(
      isQueuedSpeech({ queued: true, call: 1, start_ms: 10, duration_ms: 900 }),
    ).toBe(true);
    expect(isQueuedSpeech({ audio: "x" })).toBe(false);
  });
});

describe("a call's stream across a rebuilt chat", () => {
  type Listener = (event: ChannelEvent) => void;
  /** A link the server answers: `call_audio` starts call 1, `call_resume` moves it. */
  const link = (answers = true) => {
    const sent: Record<string, unknown>[] = [];
    const listeners = new Set<Listener>();
    const binaries = new Set<(data: ArrayBuffer) => void>();
    const emit = (event: ChannelEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    const channel: CallChannel = {
      send(message) {
        sent.push(message as Record<string, unknown>);
        const op = (message as { op?: string }).op;
        if (!answers) return;
        if (op === "call_audio" && (message as { on?: boolean }).on)
          queueMicrotask(() =>
            emit({
              event: "call_audio",
              call: 1,
              resume: "token",
              music: true,
            }),
          );
        if (op === "call_resume")
          queueMicrotask(() =>
            emit({
              event: "call_audio",
              call: 1,
              resumed: true,
            } as ChannelEvent),
          );
      },
      listen(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      binary(listener) {
        binaries.add(listener);
        return () => binaries.delete(listener);
      },
    };
    return { channel, sent, listeners, binaries };
  };

  const decoded: unknown[] = [];
  const saved = {
    AudioDecoder: (globalThis as Record<string, unknown>).AudioDecoder,
    AudioWorkletNode: (globalThis as Record<string, unknown>).AudioWorkletNode,
    EncodedAudioChunk: (globalThis as Record<string, unknown>)
      .EncodedAudioChunk,
  };
  class FakeDecoder {
    state = "configured";
    static async isConfigSupported(): Promise<{ supported: boolean }> {
      return { supported: true };
    }
    configure() {}
    decode(chunk: unknown) {
      decoded.push(chunk);
    }
    close() {}
  }
  beforeAll(() => {
    Object.assign(globalThis, {
      AudioDecoder: FakeDecoder,
      AudioWorkletNode: class {
        port = { postMessage() {}, onmessage: null };
        connect() {}
        disconnect() {}
      },
      EncodedAudioChunk: class {
        constructor(readonly init: unknown) {}
      },
    });
  });
  afterAll(() => {
    Object.assign(globalThis, saved);
  });
  const context = {
    audioWorklet: { addModule: async () => {} },
    destination: {},
  } as unknown as AudioContext;
  const packet = () => {
    const message = new Uint8Array(14);
    new DataView(message.buffer).setUint32(0, 1, true);
    return message.buffer;
  };

  test("the new link takes the call over: no new call, no stop", async () => {
    const old = link();
    const audio = (await CallAudio.start(old.channel, context))!;
    expect(audio.id).toBe(1);
    const next = link();
    expect(await audio.adopt(next.channel, context)).toBe(true);
    expect(next.sent).toEqual([
      { op: "call_resume", call: 1, resume: "token" },
    ]);
    // The old link lets go: nothing stops.
    audio.release(old.channel);
    expect(old.sent.some((m) => m.on === false)).toBe(false);
    // Packets now come on the new link only.
    expect(old.binaries.size).toBe(0);
    decoded.length = 0;
    for (const listener of next.binaries) listener(packet());
    expect(decoded.length).toBe(1);
    expect(activeCallAudio()).toBe(audio);
    audio.stop();
  });

  test("let go and not taken over, it stops after RELEASE_MS", async () => {
    jest.useFakeTimers();
    try {
      const old = link();
      const started = CallAudio.start(old.channel, context);
      await Promise.resolve();
      jest.advanceTimersByTime(0);
      const audio = (await started)!;
      audio.release(old.channel);
      jest.advanceTimersByTime(RELEASE_MS - 1);
      expect(activeCallAudio()).toBe(audio);
      jest.advanceTimersByTime(1);
      expect(activeCallAudio()).toBeNull();
      expect(old.sent[old.sent.length - 1]).toEqual({
        op: "call_audio",
        on: false,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a call the server no longer has is not taken over", async () => {
    const old = link();
    const audio = (await CallAudio.start(old.channel, context))!;
    const next = link(false);
    jest.useFakeTimers();
    try {
      const moved = audio.adopt(next.channel, context);
      jest.advanceTimersByTime(5000);
      expect(await moved).toBe(false);
      expect(activeCallAudio()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
