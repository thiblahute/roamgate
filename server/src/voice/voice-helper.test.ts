import { describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceRoutes, VOICE_REQUEST_HEADER } from "../http/voice";
import { near, person } from "./testdata/prints";
import { VoiceProfiles } from "./voice-profiles";
import { createVoiceSocket, DETACHED_MS, KEPT_MS } from "../http/voice-socket";
import {
  encodeFrame,
  escapeBytes,
  FRAME_AUDIO,
  FRAME_JSON,
  type Frame,
  FrameError,
  FrameReader,
  frontMode,
  MAX_FRAME,
  helperCommand,
  helperTtsModels,
  nativeSpeechRate,
  readVoiceConfig,
  spawnVoiceHelper,
  speakerFailed,
  transcriberArgs,
  type VoiceConfig,
  VoiceHelper,
  type VoiceHelperProcess,
  WRAPPED_EXIT_MS,
  writeFrontMode,
  writeMaxPause,
  writeSpeechRate,
} from "./voice-helper";

const CONFIG: VoiceConfig = {
  helper: "/bin/roamgate-voice",
  whisper_model: "whisper.bin",
  kokoro_model: "kokoro.onnx",
  kokoro_voices: "voices.bin",
};

const json = (message: object) =>
  encodeFrame(FRAME_JSON, new TextEncoder().encode(JSON.stringify(message)));

/**
 * A helper that answers each JSON request with `answer`'s replies, until
 * `exit()`; it keeps every frame it is sent. `raw` writes bytes on its
 * output as they are, frames or not.
 */
function fakeHelper(
  answer: (request: Record<string, unknown>) => object[] = () => [],
) {
  const spawned: {
    frames: Frame[];
    say: (m: object) => void;
    raw: (bytes: Uint8Array) => void;
    exit: () => void;
    killed: () => boolean;
  }[] = [];
  const spawn = (): VoiceHelperProcess => {
    const queue: Frame[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let killed = false;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => {
      exit = () => {
        done = true;
        wake?.();
        resolve();
      };
    });
    const frames: Frame[] = [];
    const reader = new FrameReader();
    const output = new FrameReader();
    const raw = (bytes: Uint8Array) => {
      queue.push(...output.push(bytes));
      wake?.();
    };
    const say = (message: object) => raw(json(message));
    spawned.push({ frames, say, raw, exit, killed: () => killed });
    async function* out() {
      while (!done) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (output.error) throw output.error;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
    return {
      write: (bytes) => {
        for (const frame of reader.push(bytes)) {
          frames.push(frame);
          if (frame.kind !== FRAME_JSON) continue;
          const request = JSON.parse(new TextDecoder().decode(frame.payload));
          for (const reply of answer(request)) say(reply);
        }
      },
      frames: out(),
      exited,
      kill: () => {
        killed = true;
        exit();
      },
    };
  };
  return { spawn, spawned };
}

const requests = (frames: Frame[]) =>
  frames
    .filter((frame) => frame.kind === FRAME_JSON)
    .map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)));

describe("voice helper", () => {
  test("FrameReader rejects what is not a frame and still parses split frames", () => {
    // A valid frame, a byte at a time.
    const valid = json({ ok: true });
    const pieces = new FrameReader();
    const parsed = [...valid].flatMap((byte) =>
      pieces.push(new Uint8Array([byte])),
    );
    expect(parsed.map((frame) => frame.kind)).toEqual([FRAME_JSON]);
    expect(pieces.error).toBeNull();
    // A log line on the helper's stdout, after a frame: the frame is read,
    // the line is not, and says what it was.
    const line = new TextEncoder().encode(
      "\x1b[2m2026-11-07T03:53:24Z\x1b[0m WARN any_tts::models::kokoro::style_encoder: Style encoder weights not found\n",
    );
    const reader = new FrameReader();
    const frames = reader.push(new Uint8Array([...valid, ...line]));
    expect(frames).toHaveLength(1);
    expect(reader.error).toBeInstanceOf(FrameError);
    expect(reader.error!.bytes).toStartWith("\\x1b[2m2026-11-07T03:53:24Z");
    expect(reader.error!.bytes).toContain("any_tts::models::kokoro");
    // Broken for good: nothing more is read, nor kept.
    expect(reader.push(valid)).toEqual([]);
    // A length past MAX_FRAME, a length of 0, a kind the helper never writes.
    const length = (value: number, kind: number) => {
      const bytes = new Uint8Array(6);
      new DataView(bytes.buffer).setUint32(0, value, true);
      bytes[4] = kind;
      return bytes;
    };
    for (const bad of [
      length(MAX_FRAME + 1, FRAME_JSON),
      length(0, FRAME_JSON),
      length(2, 9),
    ]) {
      const broken = new FrameReader();
      expect(broken.push(bad)).toEqual([]);
      expect(broken.error).toBeInstanceOf(FrameError);
    }
    expect(escapeBytes(new Uint8Array([0x41, 0x0a, 0x5c]))).toBe("A\\x0a\\x5c");
    expect(escapeBytes(new Uint8Array(300).fill(0x41))).toBe(
      `${"A".repeat(200)}...`,
    );
  });

  test("a large frame in many chunks is read once whole", () => {
    const payload = new Uint8Array(1024 * 1024).fill(7);
    const frame = encodeFrame(FRAME_AUDIO, payload);
    const reader = new FrameReader();
    const read: Frame[] = [];
    for (let at = 0; at < frame.length; at += 4096)
      read.push(...reader.push(frame.subarray(at, at + 4096)));
    expect(read).toHaveLength(1);
    expect(read[0]!.payload.length).toBe(payload.length);
    expect(read[0]!.payload.every((byte) => byte === 7)).toBe(true);
  });

  test("frames survive arriving in pieces", () => {
    const stream = new Uint8Array([
      ...json({ a: 1 }),
      ...encodeFrame(FRAME_AUDIO, new Uint8Array([1, 2, 3])),
    ]);
    const reader = new FrameReader();
    const frames = [
      ...reader.push(stream.slice(0, 3)),
      ...reader.push(stream.slice(3, 15)),
      ...reader.push(stream.slice(15)),
    ];
    expect(frames.map((f) => f.kind)).toEqual([FRAME_JSON, FRAME_AUDIO]);
    expect([...frames[1]!.payload]).toEqual([1, 2, 3]);
  });

  test("speaks, and starts the helper once", async () => {
    const fake = fakeHelper((request) =>
      request.op === "speak"
        ? [
            {
              id: request.id,
              audio: Buffer.from("ogg").toString("base64"),
              language: "fr",
            },
          ]
        : [],
    );
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const speech = await helper.speak("Bonjour.");
    expect(Buffer.from(speech.audio).toString()).toBe("ogg");
    expect(speech.language).toBe("fr");
    // kokorosynthesizer speaks at its own pace: the page speeds it up.
    expect(speech.nativeRate).toBe(1);
    await helper.speak("Encore.");
    expect(fake.spawned).toHaveLength(1);
  });

  test("asks the helper's tempo for the rate the model does not make", async () => {
    const fake = fakeHelper((request) =>
      request.op === "speak"
        ? [
            {
              id: request.id,
              audio: Buffer.from("ogg").toString("base64"),
              language: "en",
              // An old helper, from before rates, answers no rate.
              ...(request.text === "Old." ? {} : { rate: request.rate ?? 1 }),
            },
          ]
        : [],
    );
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    expect((await helper.speak("Fast.", "en", undefined, 1.5)).nativeRate).toBe(
      1.5,
    );
    expect((await helper.speak("Plain.", "en", undefined, 1)).nativeRate).toBe(
      1,
    );
    expect((await helper.speak("Old.", "en", undefined, 1.5)).nativeRate).toBe(
      1,
    );
    const asked = requests(fake.spawned[0]!.frames);
    expect(asked.map((request) => request.rate)).toEqual([1.5, undefined, 1.5]);
    // Kokoro made at the rate already: nothing left for the tempo.
    const kokoro = new VoiceHelper(
      () => ({
        ...CONFIG,
        speech_rate: 1.5,
        tts_models: [{ model: "kokoro", path: "/k" }],
      }),
      fake.spawn,
    );
    expect((await kokoro.speak("Hi.", "en", undefined, 1.5)).nativeRate).toBe(
      1.5,
    );
    expect(requests(fake.spawned[1]!.frames)[0]).not.toHaveProperty("rate");
  });

  test("a session's audio and events stay its own", async () => {
    const fake = fakeHelper();
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const heard: object[] = [];
    const session = helper.listen((event) => heard.push(event), {
      hold: true,
      language: "es",
    });
    session.audio(new Uint8Array([9, 9]));
    const child = fake.spawned[0]!;
    expect(requests(child.frames)[0]).toEqual({
      op: "listen_start",
      session: session.id,
      hold: true,
      language: "es",
    });
    const audio = child.frames.find((f) => f.kind === FRAME_AUDIO)!;
    expect(new DataView(audio.payload.buffer).getUint32(0, true)).toBe(
      session.id,
    );
    expect([...audio.payload.slice(4)]).toEqual([9, 9]);
    child.say({ event: "final", session: session.id, text: "hola" });
    child.say({ event: "final", session: session.id + 1, text: "other" });
    await Bun.sleep(1);
    expect(heard).toEqual([
      { event: "final", session: session.id, text: "hola" },
    ]);
    session.stop();
    expect(requests(child.frames).at(-1)).toEqual({
      op: "listen_stop",
      session: session.id,
    });
  });

  test("finals say whose voice they are, and the helper is told the user's", async () => {
    const fake = fakeHelper();
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const heard: Record<string, unknown>[] = [];
    const first = helper.listen((event) => heard.push(event), {
      newSpeaker: true,
    });
    const child = fake.spawned[0]!;
    const voice = {
      voices: 1763550000000,
      id: "B",
      share: 0.9,
      mixed: false,
      mix: [{ id: "B", share: 0.9 }],
      similarity: { A: 0.05, B: 0.61, "<b>": 9 },
      seconds: 2.2,
    };
    child.say({ event: "final", session: first.id, text: "Salut", voice });
    child.say({ event: "final", session: first.id, text: "?", voice: "B" });
    await Bun.sleep(1);
    // Checked on the way: only names and numbers.
    expect(heard[0]!.voice).toEqual({
      voices: 1763550000000,
      id: "B",
      share: 0.9,
      mixed: false,
      mix: [{ id: "B", share: 0.9 }],
      similarity: { A: 0.05, B: 0.61 },
      seconds: 2.2,
    });
    expect(heard[1]).not.toHaveProperty("voice");
    expect(helper.speakers.label(heard[0]!.voice as never)).toBe("voice B");
    // The companion took B's words up: B is the user's voice, told to the
    // helper with the next start of the same call, not with a new call's.
    helper.speakers.learn(heard[0]!.voice as never, "self");
    const next = helper.listen(() => {});
    expect(requests(child.frames).at(-1)).toEqual({
      op: "listen_start",
      session: next.id,
      hold: false,
      user_voice: { voices: 1763550000000, id: "B" },
    });
    const call = helper.listen(() => {}, { newSpeaker: true });
    expect(requests(child.frames).at(-1)).toEqual({
      op: "listen_start",
      session: call.id,
      hold: false,
      new_speaker: true,
    });
  });

  test("finals' prints stay on the server; a new call is told the user's kept prints", async () => {
    const root = mkdtempSync(join(tmpdir(), "roamgate-helper-voices-"));
    try {
      const library = new VoiceProfiles(join(root, "voice-profiles"));
      const me = library.create("Thibault", "user");
      library.learn(me, 1, person(0), 30);
      const fake = fakeHelper();
      const helper = new VoiceHelper(() => CONFIG, fake.spawn);
      helper.speakers.useLibrary(library);
      const heard: Record<string, unknown>[] = [];
      const call = helper.listen((event) => heard.push(event), {
        newSpeaker: true,
      });
      const child = fake.spawned[0]!;
      // The user's prints go with the new call's start, before any word.
      const start = requests(child.frames).at(-1) as {
        user_voice?: { prints?: number[][]; id?: string };
      };
      expect(start.user_voice?.id).toBeUndefined();
      expect(start.user_voice?.prints?.length).toBe(1);
      const print = near(person(0), 0.02, 1);
      child.say({
        event: "final",
        session: call.id,
        text: "Salut",
        voice: {
          voices: 9,
          id: "A",
          share: 1,
          mixed: false,
          mix: [{ id: "A", share: 1 }],
          similarity: { A: 0.7 },
          seconds: 4,
          print,
          prints: { A: print },
        },
      });
      await Bun.sleep(1);
      const voice = heard[0]!.voice as Record<string, unknown>;
      expect(voice).not.toHaveProperty("print");
      expect(voice).not.toHaveProperty("prints");
      expect(voice.utterance).toBe(1);
      expect(helper.speakers.label(voice as never)).toBe("Thibault (you) 0.70");
      // Known from the first utterance: told with the next start.
      const next = helper.listen(() => {});
      expect(requests(child.frames).at(-1)).toMatchObject({
        session: next.id,
        user_voice: { voices: 9, id: "A", prints: expect.any(Array) },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a helper that stops ends each session on its own, and starts again", async () => {
    const fake = fakeHelper();
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const first: object[] = [];
    const second: object[] = [];
    const one = helper.listen((event) => first.push(event));
    const two = helper.listen((event) => second.push(event));
    fake.spawned[0]!.exit();
    await Bun.sleep(1);
    expect(first).toEqual([
      {
        event: "error",
        session: one.id,
        error: "The voice helper stopped",
        recoverable: true,
      },
    ]);
    expect(second).toEqual([
      {
        event: "error",
        session: two.id,
        error: "The voice helper stopped",
        recoverable: true,
      },
    ]);
    // Its sessions went with it: nothing is asked of a helper for them,
    // and none is started for them.
    one.finish();
    one.release();
    one.audio(new Uint8Array([1, 2]));
    one.stop();
    expect(fake.spawned).toHaveLength(1);
    const three = helper.listen(() => {});
    expect(fake.spawned).toHaveLength(2);
    expect(requests(fake.spawned[1]!.frames)).toEqual([
      { op: "listen_start", session: three.id, hold: false },
    ]);
  });

  test("a helper writing something not a frame is stopped, saying what it wrote", async () => {
    const errors: string[] = [];
    const saved = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const fake = fakeHelper();
      const helper = new VoiceHelper(() => CONFIG, fake.spawn);
      const heard: Record<string, unknown>[] = [];
      const session = helper.listen((event) => heard.push(event));
      const child = fake.spawned[0]!;
      child.say({ event: "speech_start", session: session.id });
      child.raw(
        new TextEncoder().encode(
          "\x1b[2m2026-11-07T03:44:05Z\x1b[0m WARN any_tts::models::kokoro::style_encoder: Style encoder weights not found\n",
        ),
      );
      await Bun.sleep(1);
      expect(child.killed()).toBe(true);
      expect(errors.join("\n")).toContain("not frames");
      expect(errors.join("\n")).toContain("any_tts::models::kokoro");
      expect(heard).toEqual([
        { event: "speech_start", session: session.id },
        {
          event: "error",
          session: session.id,
          error: "The voice helper stopped",
          recoverable: true,
        },
      ]);
    } finally {
      console.error = saved;
    }
  });

  test("a sentence read with its own models, and models changed live", async () => {
    const fake = fakeHelper((request) =>
      request.op === "speak"
        ? [{ id: request.id, audio: "", language: "en" }]
        : [{ id: request.id, ok: true }],
    );
    const qwen = {
      model: "qwen3-tts",
      path: "/base",
      voice_embedding: "/v/lea.json",
    };
    let config: VoiceConfig = {
      ...CONFIG,
      speech_rate: 1.3,
      tts_models: [qwen, { model: "kokoro", path: "/k" }],
    };
    const helper = new VoiceHelper(() => config, fake.spawn);
    // Not running: nothing to tell, it reads voice.json when it starts.
    await helper.applyTtsModels();
    expect(fake.spawned).toHaveLength(0);
    // Kokoro alone, to hear it: at the rate, as Kokoro reads.
    const kokoro = await helper.speak("Hi.", "en", [
      { model: "kokoro", path: "/k" },
    ]);
    expect(kokoro.nativeRate).toBe(1.3);
    const child = fake.spawned[0]!;
    expect(requests(child.frames)[0]).toEqual({
      op: "speak",
      text: "Hi.",
      language: "en",
      tts_models: JSON.stringify([{ model: "kokoro", path: "/k", speed: 1.3 }]),
      id: 1,
    });
    const own = await helper.speak("Hi.");
    expect(own.nativeRate).toBe(1);
    expect(requests(child.frames)[1]).not.toHaveProperty("tts_models");
    config = { ...config, tts_models: [{ model: "kokoro", path: "/k" }] };
    await helper.applyTtsModels();
    expect(requests(child.frames)[2]).toEqual({
      op: "set_tts_models",
      tts_models: JSON.stringify([{ model: "kokoro", path: "/k", speed: 1.3 }]),
      id: 3,
    });
    expect((await helper.speak("Hi.")).nativeRate).toBe(1.3);
  });

  const OOM =
    'Qwen3Tts speaking "Oui." failed: Compute error: DriverError(CUDA_ERROR_OUT_OF_MEMORY, "out of memory")';
  const QWEN_AND_KOKORO: VoiceConfig = {
    ...CONFIG,
    tts_models: [
      { model: "qwen3-tts", path: "/base" },
      { model: "kokoro", path: "/k" },
    ],
  };
  /** Kokoro's French voice, as the helper is asked for it. */
  const KOKORO_FR = JSON.stringify([
    { model: "kokoro", path: "/k", voice: "ff_siwis", speed: 1.2 },
  ]);
  const CALL_BACKGROUND = {
    background: "",
    volume: 0.6,
    ducked: 0.15,
    release_ms: 3000,
    muted: true,
    reply_loudness: -16,
  };
  const quietErrors = () => {
    const errors: string[] = [];
    const saved = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    return { errors, restore: () => (console.error = saved) };
  };

  test("a sentence its speaker failed is said by Kokoro in its language, and the next ones", async () => {
    const fake = fakeHelper((request) =>
      request.op !== "speak"
        ? []
        : request.tts_models
          ? [{ id: request.id, audio: "", language: "fr" }]
          : [{ id: request.id, error: OOM }],
    );
    const helper = new VoiceHelper(() => QWEN_AND_KOKORO, fake.spawn);
    const log = quietErrors();
    try {
      await helper.speak("Oui.", "fr");
      await helper.speak("Non.", "fr");
      const sent = requests(fake.spawned[0]!.frames);
      expect(sent.map((request) => request.tts_models ?? "own")).toEqual([
        "own",
        KOKORO_FR,
        KOKORO_FR,
      ]);
      expect(log.errors.join("\n")).toContain(
        "a sentence failed (Qwen3Tts speaking",
      );
      expect(log.errors.join("\n")).toContain(
        "Kokoro says it again now, and the next ones for 30 s",
      );
    } finally {
      log.restore();
    }
  });

  test("in a call, a sentence failed or silent is said again by Kokoro into the call", async () => {
    // An older helper answers a failed sentence as said, with no audio; a
    // newer one with its error.
    for (const failure of ["silent", "error"] as const) {
      const fake = fakeHelper((request) =>
        request.op === "call_start"
          ? [{ id: request.id, signalling_port: 4242 }]
          : request.op !== "speak"
            ? []
            : request.tts_models
              ? [
                  {
                    id: request.id,
                    queued: true,
                    start_ms: 100,
                    duration_ms: 900,
                    now_ms: 50,
                    language: "fr",
                  },
                ]
              : failure === "error"
                ? [{ id: request.id, error: OOM }]
                : [
                    {
                      id: request.id,
                      queued: true,
                      start_ms: 50,
                      duration_ms: 0,
                      now_ms: 50,
                      language: "fr",
                    },
                  ],
      );
      const helper = new VoiceHelper(() => QWEN_AND_KOKORO, fake.spawn);
      const log = quietErrors();
      try {
        const call = await helper.startCall(CALL_BACKGROUND, () => {});
        const said = await helper.speakInCall(call.id, "Oui.", "fr");
        expect(said.durationMs).toBe(900);
        await helper.speakInCall(call.id, "Non.", "fr");
        const sent = requests(fake.spawned[0]!.frames).filter(
          (request) => request.op === "speak",
        );
        expect(sent.map((request) => request.call)).toEqual([
          call.id,
          call.id,
          call.id,
        ]);
        expect(sent.map((request) => request.tts_models ?? "own")).toEqual([
          "own",
          KOKORO_FR,
          KOKORO_FR,
        ]);
        expect(log.errors.join("\n")).toContain(
          failure === "silent"
            ? `a sentence came out silent (4 chars) in call ${call.id}: Kokoro says it again now`
            : `in call ${call.id}: Kokoro says it again now`,
        );
      } finally {
        log.restore();
      }
    }
  });

  test("Kokoro reads a short while after a failure, then the speaker is tried again", async () => {
    let fail = true;
    const fake = fakeHelper((request) =>
      request.op !== "speak"
        ? []
        : request.tts_models || !fail
          ? [{ id: request.id, audio: "", language: "fr" }]
          : [{ id: request.id, error: OOM }],
    );
    const helper = new VoiceHelper(() => QWEN_AND_KOKORO, fake.spawn);
    const log = quietErrors();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await helper.speak("Oui.", "fr");
      clock += 29_000;
      await helper.speak("Encore.", "fr");
      fail = false;
      clock += 2_000;
      await helper.speak("Revenu.", "fr");
      const sent = requests(fake.spawned[0]!.frames);
      expect(sent.map((request) => request.tts_models ?? "own")).toEqual([
        "own",
        KOKORO_FR,
        KOKORO_FR,
        "own",
      ]);
    } finally {
      Date.now = realNow;
      log.restore();
    }
  });

  test("in a call, a sentence hushed is not said again", async () => {
    const fake = fakeHelper((request) =>
      request.op === "call_start"
        ? [{ id: request.id, signalling_port: 4242 }]
        : request.op === "speak"
          ? [
              {
                id: request.id,
                queued: true,
                start_ms: 50,
                duration_ms: 0,
                now_ms: 50,
                language: "fr",
              },
            ]
          : [],
    );
    const helper = new VoiceHelper(() => QWEN_AND_KOKORO, fake.spawn);
    const log = quietErrors();
    try {
      const call = await helper.startCall(CALL_BACKGROUND, () => {});
      const said = helper.speakInCall(call.id, "Oui.", "fr");
      call.hush();
      await said;
      const sent = requests(fake.spawned[0]!.frames).filter(
        (request) => request.op === "speak",
      );
      expect(sent).toHaveLength(1);
      expect(log.errors.join("\n")).not.toContain("Kokoro");
    } finally {
      log.restore();
    }
  });

  test("YouTube goes to the call running, its events to the player only", async () => {
    const fake = fakeHelper((request) =>
      request.op === "call_start"
        ? [{ id: request.id, signalling_port: 4242, music: true }]
        : request.op === "call_music"
          ? [{ id: request.id, ok: true, volume: 0.6, muted: false }]
          : request.op === "call_youtube"
            ? [{ id: request.id, state: "playing", position: 0.1 }]
            : [],
    );
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    expect(helper.inCall()).toBe(false);
    await expect(helper.callYoutube({ action: "status" })).rejects.toThrow(
      "no call",
    );
    const told: unknown[] = [];
    const call = await helper.startCall(
      { ...CALL_BACKGROUND, muted: true },
      (event) => told.push(event),
    );
    expect(helper.inCall()).toBe(true);
    expect(call.musicOn()).toBe(false);
    const heard: Record<string, unknown>[] = [];
    const stop = helper.onYoutube((event) => heard.push(event));
    // A start puts the call's music on first: a video asked for is heard.
    expect(
      await helper.callYoutube({ action: "play", url: "https://x" }, true),
    ).toMatchObject({ state: "playing" });
    const sent = requests(fake.spawned[0]!.frames).slice(1);
    expect(sent.map((request) => request.op)).toEqual([
      "call_music",
      "call_youtube",
    ]);
    expect(sent[0]).toMatchObject({ call: call.id, muted: false });
    expect(sent[1]).toMatchObject({
      op: "call_youtube",
      call: call.id,
      action: "play",
      url: "https://x",
    });
    expect(call.musicOn()).toBe(true);
    fake.spawned[0]!.say({
      event: "call_youtube",
      call: call.id,
      state: "stopped",
      why: "ended",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual([
      { event: "call_youtube", call: call.id, state: "stopped", why: "ended" },
    ]);
    // The call's page hears nothing of it.
    expect(told).toEqual([]);
    stop();
    call.stop();
    expect(helper.inCall()).toBe(false);
  });

  test("an older helper's unknown call_youtube is its error", async () => {
    const fake = fakeHelper((request) =>
      request.op === "call_start"
        ? [{ id: request.id, signalling_port: 4242 }]
        : request.op === "call_youtube"
          ? [{ id: request.id, error: `unknown op ${request.op}` }]
          : [],
    );
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    await helper.startCall(CALL_BACKGROUND, () => {});
    await expect(helper.callYoutube({ action: "status" })).rejects.toThrow(
      "unknown op call_youtube",
    );
  });

  test("only a speaker's own failure has Kokoro say a sentence", () => {
    expect(speakerFailed("Qwen3Tts speaking failed: Compute error")).toBe(true);
    expect(speakerFailed("no call 3")).toBe(false);
    expect(speakerFailed("nothing to say")).toBe(false);
    expect(speakerFailed("The voice helper stopped: exit 1")).toBe(false);
  });

  test("clones a voice from a recording", async () => {
    const fake = fakeHelper((request) =>
      request.op === "clone_voice"
        ? [
            {
              id: request.id,
              embedding: [0.5],
              codes: [[1, 2]],
              heard: "hello",
              seconds: 9.5,
            },
          ]
        : [],
    );
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const request = {
      audio: "/tmp/rec.wav",
      model: "/base",
      reference: "/voices/lea.wav",
      language: "fr",
    };
    expect(await helper.cloneVoice(request)).toEqual({
      embedding: [0.5],
      codes: [[1, 2]],
      heard: "hello",
      seconds: 9.5,
    });
    expect(requests(fake.spawned[0]!.frames)[0]).toEqual({
      op: "clone_voice",
      ...request,
      id: 1,
    });
    const failing = new VoiceHelper(
      () => CONFIG,
      fakeHelper((r) => [{ id: r.id, error: "No speech in the recording" }])
        .spawn,
    );
    expect(failing.cloneVoice(request)).rejects.toThrow("No speech");
  });

  test("without a configuration, voice is unavailable", async () => {
    const helper = new VoiceHelper(() => ({ error: "No voice configuration" }));
    expect(helper.status()).toEqual({
      available: false,
      detail: "No voice configuration",
    });
    expect(helper.speak("hi")).rejects.toThrow("No voice configuration");
  });
});

describe("speech rate", () => {
  const configFile = (config: object) => {
    const path = join(mkdtempSync(join(tmpdir(), "voice-rate-")), "voice.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  };
  // Paths that exist, for the checks of readVoiceConfig.
  const real = {
    helper: "/bin/sh",
    whisper_model: "/bin/sh",
    kokoro_model: "/bin/sh",
    kokoro_voices: "/bin/sh",
  };

  test("is 1.2 by default, and what voice.json says", () => {
    expect(new VoiceHelper(() => CONFIG).speechRate()).toBe(1.2);
    expect(
      new VoiceHelper(() => ({ ...CONFIG, speech_rate: 1.5 })).speechRate(),
    ).toBe(1.5);
    expect(new VoiceHelper(() => ({ error: "none" })).speechRate()).toBe(1.2);
  });

  test("voice.json refuses a rate out of range", () => {
    expect(readVoiceConfig(configFile({ ...real, speech_rate: 1.3 }))).toEqual({
      ...real,
      speech_rate: 1.3,
    });
    expect(
      readVoiceConfig(configFile({ ...real, speech_rate: 3 })),
    ).toHaveProperty("error");
    expect(
      readVoiceConfig(configFile({ ...real, speech_rate: "fast" })),
    ).toHaveProperty("error");
  });

  test("Parakeet is given Whisper's model too, to read again what it writes in English", () => {
    expect(
      transcriberArgs({ parakeet_model: "/p", whisper_model: "/w.bin" }),
    ).toEqual(["--parakeet-model", "/p", "--whisper-model", "/w.bin"]);
    expect(transcriberArgs({ parakeet_model: "/p" })).toEqual([
      "--parakeet-model",
      "/p",
    ]);
    expect(transcriberArgs({ whisper_model: "/w.bin" })).toEqual([
      "--whisper-model",
      "/w.bin",
    ]);
  });

  test("voice.json's drop_other_voices is true or false", () => {
    expect(
      readVoiceConfig(configFile({ ...real, drop_other_voices: true })),
    ).toEqual({ ...real, drop_other_voices: true });
    expect(
      readVoiceConfig(configFile({ ...real, drop_other_voices: "yes" })),
    ).toHaveProperty("error");
  });

  test("voice.json takes the speaker's reference recordings as a list of files", () => {
    const listed = { ...real, speaker_reference: ["/bin/sh", "/bin/ls"] };
    expect(readVoiceConfig(configFile(listed))).toEqual(listed);
    for (const speaker_reference of ["/bin/sh", [""], [3]])
      expect(
        readVoiceConfig(configFile({ ...real, speaker_reference })),
      ).toHaveProperty("error");
    expect(
      readVoiceConfig(
        configFile({ ...real, speaker_reference: ["/no/such/voice.wav"] }),
      ),
    ).toEqual({ error: "speaker_reference not found: /no/such/voice.wav" });
  });

  test("is kept in voice.json with the rest untouched", () => {
    const path = configFile({ ...real, route_model: "opus" });
    writeSpeechRate(1.3, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...real,
      route_model: "opus",
      speech_rate: 1.3,
    });
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
    expect(() => writeSpeechRate(9, path)).toThrow();
  });
});

describe("longest pause", () => {
  test("is 8 s by default, what voice.json says, and kept there", () => {
    expect(new VoiceHelper(() => CONFIG).maxPauseMs()).toBe(8000);
    expect(
      new VoiceHelper(() => ({ ...CONFIG, max_pause_ms: 12_000 })).maxPauseMs(),
    ).toBe(12_000);
    // Out of range: the default.
    expect(
      new VoiceHelper(() => ({ ...CONFIG, max_pause_ms: 500 })).maxPauseMs(),
    ).toBe(8000);
    const path = join(
      mkdtempSync(join(tmpdir(), "voice-pause-")),
      "voice.json",
    );
    writeFileSync(path, JSON.stringify({ helper: "/bin/sh" }));
    writeMaxPause(10_000, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      helper: "/bin/sh",
      max_pause_ms: 10_000,
    });
    expect(() => writeMaxPause(60_000, path)).toThrow();
  });
});

describe("voice socket", () => {
  test("streams a browser's microphone and forwards what was heard", async () => {
    const fake = fakeHelper();
    const socket = createVoiceSocket(new VoiceHelper(() => CONFIG, fake.spawn));
    const sent: Record<string, unknown>[] = [];
    const ws = { send: (m: string) => sent.push(JSON.parse(m)) };
    socket.message(ws, JSON.stringify({ op: "listen", end_silence_ms: 800 }));
    const id = sent[0]!.session as number;
    expect(sent[0]).toEqual({
      event: "listening",
      session: id,
      resume: expect.any(String),
    });
    socket.message(ws, new Uint8Array([1, 0]));
    socket.message(ws, JSON.stringify({ op: "finish" }));
    const child = fake.spawned[0]!;
    expect(requests(child.frames)).toEqual([
      { op: "listen_start", session: id, hold: false, end_silence_ms: 800 },
      { op: "listen_finish", session: id },
    ]);
    child.say({ event: "final", session: id, text: "done" });
    await Bun.sleep(1);
    expect(sent.at(-1)).toEqual({ event: "final", session: id, text: "done" });
    // A new session ends the one before; closing keeps the last for a
    // resume (voice-socket.ts).
    socket.message(ws, JSON.stringify({ op: "listen" }));
    socket.close(ws);
    expect(
      requests(child.frames).filter((r) => r.op === "listen_stop"),
    ).toHaveLength(1);
  });

  test("a helper exit ends each listening on its own session and keeps the link", async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeHelper();
      const socket = createVoiceSocket(
        new VoiceHelper(() => CONFIG, fake.spawn),
      );
      const sent: Record<string, unknown>[] = [];
      const ws = { send: (m: string) => sent.push(JSON.parse(m)) };
      socket.message(ws, JSON.stringify({ op: "listen" }));
      const id = sent[0]!.session as number;
      const resume = sent[0]!.resume;
      fake.spawned[0]!.exit();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(sent.at(-1)).toEqual({
        event: "error",
        session: id,
        error: "The voice helper stopped",
        recoverable: true,
      });
      // Over: neither the page's finish nor time sends a finish for it,
      // to the dead helper or a new one.
      socket.message(ws, JSON.stringify({ op: "finish" }));
      jest.advanceTimersByTime(DETACHED_MS + KEPT_MS);
      expect(fake.spawned).toHaveLength(1);
      expect(
        requests(fake.spawned[0]!.frames).filter(
          (r) => r.op === "listen_finish",
        ),
      ).toEqual([]);
      // Nothing to resume; the socket listens again, in a new helper.
      const other = { send: (m: string) => sent.push(JSON.parse(m)) };
      socket.message(
        other,
        JSON.stringify({ op: "resume", session: id, resume }),
      );
      expect(sent.at(-1)).toEqual({ event: "resume_failed", session: id });
      socket.message(ws, JSON.stringify({ op: "listen" }));
      expect(fake.spawned).toHaveLength(2);
      expect(sent.at(-1)).toMatchObject({ event: "listening" });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("helper launch", () => {
  test("the helper's command comes after its wrapper's arguments", () => {
    const own = [
      "/bin/roamgate-voice",
      "--whisper-model",
      "whisper.bin",
      "--kokoro-model",
      "kokoro.onnx",
      "--kokoro-voices",
      "voices.bin",
    ];
    expect(helperCommand(CONFIG)).toEqual(own);
    expect(helperCommand({ ...CONFIG, helper_wrapper: [] })).toEqual(own);
    // Other voices are told apart, dropped only when voice.json asks for
    // it (with the reference recordings, then only).
    const speakers = {
      ...CONFIG,
      speaker_model: "s.onnx",
      speaker_reference: ["me.wav"],
    };
    expect(helperCommand(speakers)).toEqual([
      ...own,
      "--speaker-model",
      "s.onnx",
    ]);
    expect(helperCommand({ ...speakers, drop_other_voices: true })).toEqual([
      ...own,
      "--speaker-model",
      "s.onnx",
      "--drop-other-voices",
      "--speaker-reference",
      '["me.wav"]',
    ]);
    expect(
      helperCommand({
        ...CONFIG,
        helper_wrapper: ["/opt/bin/gpu-lease", "--name=voice", "--"],
      }),
    ).toEqual(["/opt/bin/gpu-lease", "--name=voice", "--", ...own]);
  });

  test("Kokoro's ONNX model comes beside tts_models, for Kokoro's sentences", () => {
    const models = [
      { model: "qwen3-tts", path: "q" },
      { model: "kokoro", path: "k" },
    ];
    const tts = ["--tts-models", JSON.stringify(models)];
    const onnx = [
      "--kokoro-model",
      "kokoro.onnx",
      "--kokoro-voices",
      "voices.bin",
    ];
    const args = (config: VoiceConfig) => helperCommand(config).slice(3);
    expect(args({ ...CONFIG, tts_models: models })).toEqual([...tts, ...onnx]);
    // Without its voices, only any-tts reads.
    expect(
      args({ ...CONFIG, tts_models: models, kokoro_voices: undefined }),
    ).toEqual(tts);
  });

  test.skipIf(process.platform === "win32")(
    "frames go through a wrapper, which ends with the helper's input",
    async () => {
      // The wrapper leaves out the helper's arguments and ignores the
      // signals it is sent: cat gives each frame back, and ends only at
      // the end of its input.
      const child = spawnVoiceHelper({
        ...CONFIG,
        helper: "/bin/cat",
        helper_wrapper: ["/bin/sh", "-c", "trap '' TERM; exec cat", "wrap"],
      });
      expect(child.pid).toBeUndefined();
      child.write(json({ op: "ping", id: 1 }));
      child.write(encodeFrame(FRAME_AUDIO, new Uint8Array([1, 2, 3, 4])));
      const frames = child.frames[Symbol.asyncIterator]();
      const ping = (await frames.next()).value as Frame;
      expect(JSON.parse(new TextDecoder().decode(ping.payload))).toEqual({
        op: "ping",
        id: 1,
      });
      const audio = (await frames.next()).value as Frame;
      expect(audio.kind).toBe(FRAME_AUDIO);
      expect([...audio.payload]).toEqual([1, 2, 3, 4]);
      const stopping = Date.now();
      child.kill();
      await child.exited;
      expect(Date.now() - stopping).toBeLessThan(WRAPPED_EXIT_MS);
    },
  );

  const answers = (request: Record<string, unknown>) =>
    request.op === "speak"
      ? [{ id: request.id, audio: "", language: "en" }]
      : request.op === "call_start"
        ? [{ id: request.id, signalling_port: 4242 }]
        : [];
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  test("the helper stops after helper_idle_exit_minutes with nothing to do", async () => {
    jest.useFakeTimers();
    const errors: string[] = [];
    const saved = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const fake = fakeHelper(answers);
      const helper = new VoiceHelper(
        () => ({ ...CONFIG, helper_idle_exit_minutes: 10 }),
        fake.spawn,
      );
      await helper.speak("Hello.");
      jest.advanceTimersByTime(10 * 60_000 - 1);
      expect(fake.spawned[0]!.killed()).toBe(false);
      // A sentence starts the count again.
      await helper.speak("Again.");
      jest.advanceTimersByTime(10 * 60_000 - 1);
      expect(fake.spawned[0]!.killed()).toBe(false);
      jest.advanceTimersByTime(1);
      expect(fake.spawned[0]!.killed()).toBe(true);
      expect(errors.join("\n")).toContain(
        "nothing for the voice helper in 10 min",
      );
      await settle();
      // The next request starts it again.
      await helper.speak("Back.");
      expect(fake.spawned).toHaveLength(2);
    } finally {
      console.error = saved;
      jest.useRealTimers();
    }
  });

  test("a call or a listening keeps the helper, however quiet", async () => {
    jest.useFakeTimers();
    const saved = console.error;
    console.error = () => {};
    try {
      const fake = fakeHelper(answers);
      const helper = new VoiceHelper(
        () => ({ ...CONFIG, helper_idle_exit_minutes: 10 }),
        fake.spawn,
      );
      const session = helper.listen(() => {});
      jest.advanceTimersByTime(60 * 60_000);
      expect(fake.spawned[0]!.killed()).toBe(false);
      session.stop();
      const call = await helper.startCall(
        {
          background: "",
          volume: 0.6,
          ducked: 0.15,
          release_ms: 3000,
          muted: true,
          reply_loudness: -16,
        },
        () => {},
      );
      jest.advanceTimersByTime(60 * 60_000);
      expect(fake.spawned[0]!.killed()).toBe(false);
      call.stop();
      jest.advanceTimersByTime(10 * 60_000);
      expect(fake.spawned[0]!.killed()).toBe(true);
    } finally {
      console.error = saved;
      jest.useRealTimers();
    }
  });

  test("without helper_idle_exit_minutes, the helper runs until stopped", async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeHelper(answers);
      const helper = new VoiceHelper(() => CONFIG, fake.spawn);
      await helper.speak("Hello.");
      jest.advanceTimersByTime(24 * 60 * 60_000);
      expect(fake.spawned[0]!.killed()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("voice routes", () => {
  const fake = fakeHelper((request) =>
    request.op === "speak"
      ? [
          {
            id: request.id,
            audio: Buffer.from("ogg").toString("base64"),
            language: "es",
          },
        ]
      : [],
  );
  let config: VoiceConfig = { ...CONFIG };
  const routes = createVoiceRoutes(
    new VoiceHelper(
      () => config,
      fake.spawn,
      (rate) => {
        config = { ...config, speech_rate: rate };
      },
    ),
  );
  const post = (path: string, body: BodyInit, header = true) =>
    routes(
      new Request(`http://roamgate${path}`, {
        method: "POST",
        body,
        headers: header ? { [VOICE_REQUEST_HEADER]: "1" } : {},
      }),
      path,
    );

  test("report whether voice is set up", async () => {
    const response = await routes(
      new Request("http://roamgate/api/voice"),
      "/api/voice",
    );
    expect(await response!.json()).toEqual({
      available: true,
      speech_rate: 1.2,
      max_pause_ms: 8000,
    });
  });

  test("keep a new reading speed, with their header only", async () => {
    const body = JSON.stringify({ speech_rate: 1.5 });
    expect((await post("/api/voice/settings", body, false))!.status).toBe(403);
    expect(
      (await post("/api/voice/settings", JSON.stringify({ speech_rate: 4 })))!
        .status,
    ).toBe(400);
    const saved = await post("/api/voice/settings", body);
    expect(await saved!.json()).toEqual({ speech_rate: 1.5 });
    const status = await routes(
      new Request("http://roamgate/api/voice"),
      "/api/voice",
    );
    expect(await status!.json()).toEqual({
      available: true,
      speech_rate: 1.5,
      max_pause_ms: 8000,
    });
    config = { ...CONFIG };
  });

  test("speak text, with their header only", async () => {
    expect(
      (await post(
        "/api/voice/speak",
        JSON.stringify({ text: "Hola." }),
        false,
      ))!.status,
    ).toBe(403);
    const spoken = await post(
      "/api/voice/speak",
      JSON.stringify({ text: "Hola." }),
    );
    expect(spoken!.headers.get("content-type")).toBe("audio/ogg");
    expect(spoken!.headers.get("x-voice-language")).toBe("es");
    expect(spoken!.headers.get("x-voice-native-rate")).toBe("1");
    expect(await spoken!.text()).toBe("ogg");
    expect(
      (await post("/api/voice/speak", JSON.stringify({ text: " " })))!.status,
    ).toBe(400);
  });

  test("leave other paths alone", async () => {
    expect(
      await routes(new Request("http://roamgate/api/other"), "/api/other"),
    ).toBeNull();
  });
});

describe("front mode", () => {
  const configFile = (config: object) => {
    const path = join(mkdtempSync(join(tmpdir(), "voice-mode-")), "voice.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  };
  const real = {
    helper: "/bin/sh",
    whisper_model: "/bin/sh",
    kokoro_model: "/bin/sh",
    kokoro_voices: "/bin/sh",
  };

  test("a front is a companion unless voice.json says relay", () => {
    expect(frontMode(CONFIG)).toBeNull();
    expect(frontMode({ ...CONFIG, front_model: "opus" })).toBe("companion");
    expect(
      frontMode({ ...CONFIG, front_model: "opus", front_mode: "relay" }),
    ).toBe("relay");
    // Without a front, answers are read whatever it says.
    expect(frontMode({ ...CONFIG, front_mode: "companion" })).toBeNull();
  });

  test("voice.json refuses another mode, and keeps one with the rest", () => {
    expect(
      readVoiceConfig(configFile({ ...real, front_mode: "relay" })),
    ).toEqual({ ...real, front_mode: "relay" });
    expect(
      readVoiceConfig(configFile({ ...real, front_mode: "loud" })),
    ).toHaveProperty("error");
    const path = configFile({ ...real, front_model: "opus" });
    writeFrontMode("relay", path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...real,
      front_model: "opus",
      front_mode: "relay",
    });
    expect(() => writeFrontMode("loud" as "relay", path)).toThrow();
  });
});

describe("readVoiceConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-voice-config-"));
  const file = join(dir, "voice.json");
  writeFileSync(join(dir, "helper"), "");
  writeFileSync(join(dir, "kokoro.onnx"), "");
  writeFileSync(join(dir, "whisper.bin"), "");
  const read = (config: object) => {
    writeFileSync(file, JSON.stringify(config));
    return readVoiceConfig(file);
  };
  const base = {
    helper: join(dir, "helper"),
    whisper_model: join(dir, "whisper.bin"),
  };
  const readable = { ...base, tts_models: [{ model: "kokoro" }] };

  test("helper_wrapper is a list of arguments, a program first", () => {
    const base = { ...readable };
    for (const helper_wrapper of [[], ["/opt/bin/gpu-lease", "--"]])
      expect("error" in read({ ...base, helper_wrapper })).toBe(false);
    for (const helper_wrapper of ["/opt/bin/gpu-lease --", [1], [""]])
      expect(read({ ...base, helper_wrapper })).toEqual({
        error: `${file}: helper_wrapper must be a list of arguments, a program first`,
      });
  });

  test("helper_idle_exit_minutes is a number of minutes, 0 for never", () => {
    const base = { ...readable };
    for (const helper_idle_exit_minutes of [0, 10, 0.5])
      expect("error" in read({ ...base, helper_idle_exit_minutes })).toBe(
        false,
      );
    for (const helper_idle_exit_minutes of [-1, "10", null])
      expect(read({ ...base, helper_idle_exit_minutes })).toEqual({
        error: `${file}: helper_idle_exit_minutes must be a number of minutes, 0 for never`,
      });
  });

  test("any-tts models read in place of Kokoro", () => {
    const config = read({
      ...base,
      tts_models: [
        {
          model: "qwen3-tts",
          path: "/models/qwen3",
          voice_embedding: "me.json",
        },
        { model: "kokoro" },
      ],
    });
    expect("error" in config).toBe(false);
  });

  test("a Qwen3-TTS model can name a stock speaker", () => {
    const stock = {
      ...base,
      stock_model: "/models/Qwen3-TTS-CustomVoice",
      tts_models: [
        { model: "qwen3-tts", path: "/models/cv", speaker: "ryan" },
        { model: "qwen3-tts", path: "/models/cv", voice: "vivian" },
      ],
    };
    expect("error" in read(stock)).toBe(false);
    expect(
      read({
        ...base,
        tts_models: [{ model: "qwen3-tts", path: "/models/cv", speaker: "" }],
      }),
    ).toEqual({
      error: `${file}: the speaker of a qwen3-tts model must be a name`,
    });
    expect(read({ ...stock, stock_model: 3 })).toEqual({
      error: `${file}: stock_model must be a string`,
    });
  });

  test("companion_mcp lists tool names, and may name a model", () => {
    const tts = {
      ...base,
      tts_models: [{ model: "qwen3-tts", path: "/models/cv" }],
    };
    expect(
      "error" in
        read({
          ...tts,
          companion_mcp: {
            allow: ["mcp__spotify"],
            confirm: ["mcp__claude_ai_WhatsApp__send_message"],
            model: "sonnet",
          },
        }),
    ).toBe(false);
    expect(read({ ...tts, companion_mcp: ["mcp__spotify"] })).toEqual({
      error: `${file}: companion_mcp must be an object`,
    });
    expect(read({ ...tts, companion_mcp: { allow: "mcp__spotify" } })).toEqual({
      error: `${file}: companion_mcp.allow must be a list of tool names`,
    });
    expect(read({ ...tts, companion_mcp: { confirm: [""] } })).toEqual({
      error: `${file}: companion_mcp.confirm must be a list of tool names`,
    });
    expect(read({ ...tts, companion_mcp: { model: 1 } })).toEqual({
      error: `${file}: companion_mcp.model must be a string`,
    });
  });

  test("Kokoro's files are needed without them", () => {
    expect(read(base)).toEqual({
      error: `${file}: kokoro_model and kokoro_voices, or tts_models, are required`,
    });
    expect(
      read({
        ...base,
        kokoro_model: join(dir, "kokoro.onnx"),
        kokoro_voices: join(dir, "missing.bin"),
      }),
    ).toEqual({
      error: `kokoro_voices not found: ${join(dir, "missing.bin")}`,
    });
  });

  test("each any-tts model is named", () => {
    expect(read({ ...base, tts_models: [{ path: "/models/qwen3" }] })).toEqual({
      error: `${file}: tts_models must be a list of objects with a model name`,
    });
    expect(read({ ...base, tts_models: [] })).toEqual({
      error: `${file}: tts_models must be a list of objects with a model name`,
    });
  });
});

describe("native speech rate", () => {
  const kokoro = { model: "kokoro", path: "/models/kokoro" };
  const qwen = { model: "qwen3-tts", path: "/models/qwen3" };

  test("Kokoro alone is made at the reading speed", () => {
    const config = { ...CONFIG, speech_rate: 1.3, tts_models: [kokoro] };
    expect(nativeSpeechRate(config)).toBe(1.3);
    expect(helperTtsModels(config)).toEqual([{ ...kokoro, speed: 1.3 }]);
    expect(nativeSpeechRate({ ...config, speech_rate: undefined })).toBe(1.2);
  });

  test("other models, or a speed of its own, leave it to the browser", () => {
    const mixed = { ...CONFIG, tts_models: [qwen, kokoro] };
    expect(nativeSpeechRate(mixed)).toBe(1);
    expect(helperTtsModels(mixed)).toEqual([qwen, kokoro]);
    const own = { ...CONFIG, tts_models: [{ ...kokoro, speed: 1.1 }] };
    expect(nativeSpeechRate(own)).toBe(1);
    // kokorosynthesizer is given no speed.
    expect(nativeSpeechRate(CONFIG)).toBe(1);
  });

  test("a stock speaker goes to the helper as the element's voice", async () => {
    const stock = { model: "qwen3-tts", path: "/models/cv", speaker: "ryan" };
    const config = { ...CONFIG, tts_models: [stock, kokoro] };
    expect(helperTtsModels(config)).toEqual([
      { model: "qwen3-tts", path: "/models/cv", voice: "ryan" },
      kokoro,
    ]);
    // The element's own name wins.
    expect(
      helperTtsModels({
        ...CONFIG,
        tts_models: [{ ...stock, voice: "aiden" }],
      }),
    ).toEqual([{ model: "qwen3-tts", path: "/models/cv", voice: "aiden" }]);
    const fake = fakeHelper((request) =>
      request.op === "speak"
        ? [{ id: request.id, audio: "", language: "fr" }]
        : [],
    );
    const helper = new VoiceHelper(() => config, fake.spawn);
    await helper.speak("Bonjour.", "fr", [
      { model: "qwen3-tts", path: "/models/cv", speaker: "serena" },
    ]);
    const speak = requests(fake.spawned[0]!.frames).find(
      (request) => request.op === "speak",
    );
    expect(JSON.parse(speak.tts_models)).toEqual([
      { model: "qwen3-tts", path: "/models/cv", voice: "serena" },
    ]);
  });

  test("speech says the rate the running helper makes it at", async () => {
    const fake = fakeHelper((request) =>
      request.op === "speak"
        ? [{ id: request.id, audio: "", language: "en" }]
        : [],
    );
    let config: VoiceConfig = {
      ...CONFIG,
      speech_rate: 1.3,
      tts_models: [kokoro],
    };
    const helper = new VoiceHelper(() => config, fake.spawn);
    expect((await helper.speak("Hi.")).nativeRate).toBe(1.3);
    // A new rate is the browser's to make up until the helper restarts.
    config = { ...config, speech_rate: 1.5 };
    expect((await helper.speak("Hi.")).nativeRate).toBe(1.3);
  });
});

describe("voice helper: Kokoro's languages and the low-GPU set", () => {
  const SAID = (request: Record<string, unknown>) =>
    request.op === "speak"
      ? [
          {
            id: request.id,
            audio: Buffer.from("ogg").toString("base64"),
            language: request.language ?? "fr",
          },
        ]
      : request.op === "call_start"
        ? [{ id: request.id, signalling_port: 4242 }]
        : [];
  const quiet = () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    return { errors, restore: () => (console.error = original) };
  };
  const speaks = (frames: Frame[]) =>
    requests(frames).filter((request) => request.op === "speak");

  test("Kokoro reads French and English as they are, in their language", async () => {
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    await helper.speak("Bonjour, je lance la partie.", "fr");
    await helper.speak("The build passed.");
    await helper.speak("J'ai relancé le pipeline GitLab CI.");
    expect(
      speaks(fake.spawned[0]!.frames).map((request) => [
        request.text,
        request.language ?? "detected",
      ]),
    ).toEqual([
      ["Bonjour, je lance la partie.", "fr"],
      ["The build passed.", "detected"],
      ["J'ai relancé le pipeline GitLab CI.", "detected"],
    ]);
  });

  test("a language Kokoro has no voice for is said to be one, not read with another's accent", async () => {
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const log = quiet();
    try {
      await helper.speak(
        "Ich habe den Build gestartet und er ist jetzt fertig.",
      );
      await helper.speak("Guten Tag.", "de");
    } finally {
      log.restore();
    }
    expect(
      speaks(fake.spawned[0]!.frames).map((request) => [
        request.text,
        request.language,
      ]),
    ).toEqual([
      ["This reply is in German, which this voice cannot read.", "en"],
      ["This reply is in German, which this voice cannot read.", "en"],
    ]);
    expect(log.errors.join("\n")).toContain("no Kokoro voice reads de");
  });

  test("Qwen3-TTS reads what Kokoro cannot: no notice", async () => {
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(
      () => ({ ...CONFIG, tts_models: [{ model: "qwen3-tts", path: "/b" }] }),
      fake.spawn,
    );
    await helper.speak("Guten Tag.", "de");
    expect(speaks(fake.spawned[0]!.frames)[0]?.text).toBe("Guten Tag.");
  });

  test("a low-GPU helper reads with its own voice, a chosen one left aside", async () => {
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(
      () => ({ ...CONFIG, low_gpu: "gaming" }),
      fake.spawn,
    );
    await helper.speak("Bonjour.", "fr", [
      { model: "qwen3-tts", path: "/base", voice_embedding: "/me.json" },
    ]);
    expect(speaks(fake.spawned[0]!.frames)[0]?.tts_models).toBeUndefined();
    expect(helper.runningProfile()).toBe("low-gpu");
    expect(helper.lowGpuReason()).toBe("gaming");
  });

  test("a call waits for beforeCall, then starts", async () => {
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const order: string[] = [];
    helper.beforeCall = async () => {
      order.push(`before, ${fake.spawned.length} helpers`);
    };
    await helper.startCall(
      {
        background: "",
        volume: 0.6,
        ducked: 0.15,
        release_ms: 3000,
        muted: true,
        reply_loudness: -16,
      },
      () => {},
    );
    expect(order).toEqual(["before, 0 helpers"]);
    expect(requests(fake.spawned[0]!.frames)[0]?.op).toBe("call_start");
  });

  test("restartModels makes the call again in a helper with the new models", async () => {
    let config: VoiceConfig = CONFIG;
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(() => config, fake.spawn);
    const events: string[] = [];
    const call = await helper.startCall(
      {
        background: "",
        volume: 0.6,
        ducked: 0.15,
        release_ms: 3000,
        muted: true,
        reply_loudness: -16,
      },
      (event) => events.push(event.event),
    );
    expect(helper.runningProfile()).toBe("full");
    config = { ...CONFIG, low_gpu: "gaming" };
    const log = quiet();
    try {
      expect(helper.restartModels()).toBe(true);
      for (let i = 0; i < 20 && !events.includes("call_restarted"); i++)
        await Bun.sleep(1);
    } finally {
      log.restore();
    }
    expect(fake.spawned).toHaveLength(2);
    expect(requests(fake.spawned[1]!.frames)[0]).toMatchObject({
      op: "call_start",
      call: call.id,
    });
    expect(events).toContain("call_restarted");
    expect(helper.runningProfile()).toBe("low-gpu");
  });

  test("reloadModelsAndWait stops a free helper and waits for it to end", async () => {
    const fake = fakeHelper(SAID);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    expect(await helper.reloadModelsAndWait()).toBe("not-running");
    await helper.speak("Oui.", "fr");
    expect(await helper.reloadModelsAndWait()).toBe("now");
    expect(fake.spawned[0]!.killed()).toBe(true);
    expect(helper.runningProfile()).toBeNull();
  });
});
