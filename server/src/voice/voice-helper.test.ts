import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceRoutes, VOICE_REQUEST_HEADER } from "../http/voice";
import { createVoiceSocket } from "../http/voice-socket";
import {
  encodeFrame,
  FRAME_AUDIO,
  FRAME_JSON,
  type Frame,
  FrameReader,
  helperTtsModels,
  nativeSpeechRate,
  readVoiceConfig,
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
 * `exit()`; it keeps every frame it is sent.
 */
function fakeHelper(
  answer: (request: Record<string, unknown>) => object[] = () => [],
) {
  const spawned: {
    frames: Frame[];
    say: (m: object) => void;
    exit: () => void;
  }[] = [];
  const spawn = (): VoiceHelperProcess => {
    const queue: Frame[] = [];
    let wake: (() => void) | null = null;
    let done = false;
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
    const say = (message: object) => {
      queue.push(...new FrameReader().push(json(message)));
      wake?.();
    };
    spawned.push({ frames, say, exit });
    async function* out() {
      while (!done) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
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
      kill: exit,
    };
  };
  return { spawn, spawned };
}

const requests = (frames: Frame[]) =>
  frames
    .filter((frame) => frame.kind === FRAME_JSON)
    .map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)));

describe("voice helper", () => {
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

  test("a helper that stops tells every session, and starts again", async () => {
    const fake = fakeHelper();
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const heard: object[] = [];
    helper.listen((event) => heard.push(event));
    fake.spawned[0]!.exit();
    await Bun.sleep(1);
    expect(heard).toEqual([
      { event: "error", error: "The voice helper stopped" },
    ]);
    helper.listen(() => {});
    expect(fake.spawned).toHaveLength(2);
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
