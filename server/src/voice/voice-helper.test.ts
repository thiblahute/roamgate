import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceRoutes, VOICE_REQUEST_HEADER } from "../http/voice";
import { createVoiceSocket } from "../http/voice-socket";
import {
  encodeFrame,
  escapeBytes,
  FRAME_AUDIO,
  FRAME_JSON,
  type Frame,
  FrameError,
  FrameReader,
  MAX_FRAME,
  readVoiceConfig,
  transcriberArgs,
  type VoiceConfig,
  VoiceHelper,
  type VoiceHelperProcess,
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

describe("voice socket", () => {
  test("streams a browser's microphone and forwards what was heard", async () => {
    const fake = fakeHelper();
    const socket = createVoiceSocket(new VoiceHelper(() => CONFIG, fake.spawn));
    const sent: Record<string, unknown>[] = [];
    const ws = { send: (m: string) => sent.push(JSON.parse(m)) };
    socket.message(ws, JSON.stringify({ op: "listen", end_silence_ms: 800 }));
    const id = sent[0]!.session as number;
    expect(sent[0]).toEqual({ event: "listening", session: id });
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
    // A new session ends the one before; closing ends the last.
    socket.message(ws, JSON.stringify({ op: "listen" }));
    socket.close(ws);
    expect(
      requests(child.frames).filter((r) => r.op === "listen_stop"),
    ).toHaveLength(2);
  });

  test("a helper exit ends each listening on its own session and keeps the link", async () => {
    const fake = fakeHelper();
    const socket = createVoiceSocket(new VoiceHelper(() => CONFIG, fake.spawn));
    const sent: Record<string, unknown>[] = [];
    const ws = { send: (m: string) => sent.push(JSON.parse(m)) };
    socket.message(ws, JSON.stringify({ op: "listen" }));
    const id = sent[0]!.session as number;
    fake.spawned[0]!.exit();
    await Bun.sleep(1);
    expect(sent.at(-1)).toEqual({
      event: "error",
      session: id,
      error: "The voice helper stopped",
      recoverable: true,
    });
    // Over: the page's finish sends nothing, to the dead helper or a new one.
    socket.message(ws, JSON.stringify({ op: "finish" }));
    expect(fake.spawned).toHaveLength(1);
    expect(
      requests(fake.spawned[0]!.frames).filter((r) => r.op === "listen_finish"),
    ).toEqual([]);
    // The socket listens again, in a new helper.
    socket.message(ws, JSON.stringify({ op: "listen" }));
    expect(fake.spawned).toHaveLength(2);
    expect(sent.at(-1)).toMatchObject({ event: "listening" });
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
