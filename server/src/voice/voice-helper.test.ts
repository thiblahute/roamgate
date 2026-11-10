import { describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceRoutes, VOICE_REQUEST_HEADER } from "../http/voice";
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
    expect(
      helperCommand({
        ...CONFIG,
        helper_wrapper: ["/opt/bin/gpu-lease", "--name=voice", "--"],
      }),
    ).toEqual(["/opt/bin/gpu-lease", "--name=voice", "--", ...own]);
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
