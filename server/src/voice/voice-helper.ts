import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSpeechRate, speechRateOr } from "../../../shared/speechRate";
import { dataRoot } from "../config/data-paths";

/**
 * Voice chat runs on a helper process (voice/helper) that keeps the speech
 * models loaded: whispertranscriber for speech to text, kokorosynthesizer
 * for text to speech. `voice.json` in Roamgate's data directory says where
 * it and its models are; without it, voice is unavailable. Parakeet, when
 * set, transcribes in place of Whisper.
 */
export type VoiceConfig = {
  /** The roamgate-voice binary. */
  helper: string;
  /** The GStreamer prefix holding the whisper and kokoro plugins. */
  gst_prefix?: string;
  /** whisper.cpp's model; needed without `parakeet_model`. */
  whisper_model?: string;
  /** The Parakeet TDT ONNX directory (voice/helper/src/parakeet.rs). */
  parakeet_model?: string;
  kokoro_model: string;
  kokoro_voices: string;
  /** Speaker embeddings: only the first voice of a voice chat counts. */
  speaker_model?: string;
  /** Smart Turn v3: a pause ends speech only when it sounds finished. */
  turn_model?: string;
  /** Qwen3 0.6B ONNX: with Parakeet, unfinished words keep a turn open. */
  text_turn_model?: string;
  /**
   * A Claude model ("haiku") that cleans what was said and tells whether
   * it was said to the agent (voice-cleaner.ts), through Claude Code.
   */
  clean_model?: string;
  /**
   * A Claude model ("haiku") that decides who each thing said is for: the
   * agent on screen, another session, or nobody (voice-router.ts).
   */
  route_model?: string;
  /**
   * The folder of the agent session that general questions and errands go
   * to (a tasks repository), when the router has one.
   */
  errand_folder?: string;
  /** The Claude Code command for those models; `claude` by default. */
  claude_command?: string;
  /**
   * How fast replies are read, as a multiple of the voice's own pace, from
   * 0.5 to 2 (shared/speechRate.ts); 1.2 by default. The voice card's speed
   * button changes it.
   */
  speech_rate?: number;
};

export type VoiceStatus =
  | { available: true }
  | { available: false; detail: string };

const REQUIRED = ["helper", "kokoro_model", "kokoro_voices"] as const;

export function voiceConfigPath(root = dataRoot()): string {
  return join(root, "voice.json");
}

export function readVoiceConfig(
  path = voiceConfigPath(),
): VoiceConfig | { error: string } {
  if (!existsSync(path)) return { error: `No voice configuration (${path})` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: `${path}: ${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object")
    return { error: `${path}: not an object` };
  const config = parsed as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (typeof config[key] !== "string" || !config[key])
      return { error: `${path}: ${key} is required` };
    if (!existsSync(config[key] as string))
      return { error: `${key} not found: ${config[key]}` };
  }
  for (const key of [
    "clean_model",
    "route_model",
    "errand_folder",
    "claude_command",
  ])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || !config[key])
    )
      return { error: `${path}: ${key} must be a string` };
  if (config.speech_rate !== undefined && !isSpeechRate(config.speech_rate))
    return { error: `${path}: speech_rate must be a number from 0.5 to 2` };
  if (config.whisper_model === undefined && config.parakeet_model === undefined)
    return { error: `${path}: whisper_model or parakeet_model is required` };
  for (const key of [
    "whisper_model",
    "parakeet_model",
    "speaker_model",
    "turn_model",
    "text_turn_model",
  ])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || !existsSync(config[key]))
    )
      return { error: `${key} not found: ${config[key]}` };
  return config as VoiceConfig;
}

/**
 * Keeps `rate` as `speech_rate` in the voice.json at `path`, its other
 * settings untouched; replaced whole, so a reader never sees half of it.
 */
export function writeSpeechRate(rate: number, path = voiceConfigPath()) {
  if (!isSpeechRate(rate)) throw new Error("speech_rate must be 0.5 to 2");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  config.speech_rate = rate;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path);
}

type Pending = {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

// Messages to and from the helper: the little-endian u32 length of what
// follows, a kind byte, then the payload (voice/helper/src/frames.rs).
export const FRAME_JSON = 0;
/** A listening session's audio: its u32 id, then 16 kHz mono S16LE. */
export const FRAME_AUDIO = 1;

export type Frame = { kind: number; payload: Uint8Array };

export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, true);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
}

/** Splits a byte stream into frames, however it arrives. */
export class FrameReader {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.buffered.length + chunk.length);
    joined.set(this.buffered);
    joined.set(chunk, this.buffered.length);
    const frames: Frame[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(
        joined.buffer,
        joined.byteOffset + at,
      ).getUint32(0, true);
      if (joined.length - at - 4 < length) break;
      frames.push({
        kind: joined[at + 4]!,
        payload: joined.slice(at + 5, at + 4 + length),
      });
      at += 4 + length;
    }
    this.buffered = joined.slice(at);
    return frames;
  }
}

export type VoiceHelperProcess = {
  write: (frame: Uint8Array) => void;
  /** Frames the helper writes. */
  frames: AsyncIterable<Frame>;
  exited: Promise<unknown>;
  kill: () => void;
};

export function spawnVoiceHelper(config: VoiceConfig): VoiceHelperProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.gst_prefix) {
    env.GST_PLUGIN_SYSTEM_PATH = join(
      config.gst_prefix,
      "lib",
      "gstreamer-1.0",
    );
    env.GST_REGISTRY = join(dataRoot(), "voice-gst-registry.bin");
  }
  const child = Bun.spawn(
    [
      config.helper,
      ...(config.parakeet_model
        ? ["--parakeet-model", config.parakeet_model]
        : ["--whisper-model", config.whisper_model ?? ""]),
      "--kokoro-model",
      config.kokoro_model,
      "--kokoro-voices",
      config.kokoro_voices,
      ...(config.speaker_model
        ? ["--speaker-model", config.speaker_model]
        : []),
      ...(config.turn_model ? ["--turn-model", config.turn_model] : []),
      ...(config.text_turn_model
        ? ["--text-turn-model", config.text_turn_model]
        : []),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit", env },
  );
  async function* frames() {
    const reader = new FrameReader();
    for await (const chunk of child.stdout) yield* reader.push(chunk);
  }
  return {
    write: (frame) => {
      child.stdin.write(frame);
      child.stdin.flush();
    },
    frames: frames(),
    exited: child.exited,
    kill: () => child.kill(),
  };
}

/** What the helper says about a listening session. */
export type VoiceEvent = {
  event: "speech_start" | "speech_end" | "text" | "partial" | "final" | "error";
  session?: number;
  text?: string;
  speech_ms?: number;
  error?: string;
  /** On a partial: the words at a pause, which may end the utterance. */
  pause?: boolean;
  /** On a cleaned final: the words as heard, and whether to the agent. */
  raw?: string;
  for_agent?: boolean;
};

/** One listening session: the microphone streams in until it ends. */
export type VoiceSession = {
  id: number;
  /** 16 kHz mono S16LE samples. */
  audio: (samples: Uint8Array) => void;
  /** The reply stopped playing: any voice counts again. */
  release: () => void;
  /** End the utterance now. */
  finish: () => void;
  stop: () => void;
};

export type ListenOptions = {
  /** A reply is playing: only a louder voice interrupts it. */
  hold?: boolean;
  /** ISO 639-1, for short speech. */
  language?: string;
  endSilenceMs?: number;
  /** Forget the speaker kept so far: the next one to speak is kept. */
  newSpeaker?: boolean;
};

/**
 * Starts the helper on first use and passes requests to it; a helper that
 * died is started again by the next request.
 */
export class VoiceHelper {
  private process: VoiceHelperProcess | null = null;
  private pending = new Map<number, Pending>();
  private listeners = new Map<number, (event: VoiceEvent) => void>();
  private nextId = 1;
  private nextSession = 1;
  /**
   * The rate the running helper's voice speaks at by itself, which the
   * browser's playback makes up the rest of: kokorosynthesizer is given no
   * speed.
   */
  private nativeRate = 1;

  constructor(
    private readonly config: () => VoiceConfig | { error: string },
    private readonly spawn: (
      config: VoiceConfig,
    ) => VoiceHelperProcess = spawnVoiceHelper,
    private readonly saveSpeechRate: (rate: number) => void = (rate) =>
      writeSpeechRate(rate),
  ) {}

  /** How fast replies are read (`speech_rate`). */
  speechRate(): number {
    const config = this.config();
    return speechRateOr("error" in config ? undefined : config.speech_rate);
  }

  /**
   * Keeps a new reading speed. The running helper keeps the native rate it
   * started with: speech says what it was made at, the browser does the rest.
   */
  setSpeechRate(rate: number) {
    this.saveSpeechRate(rate);
  }

  status(): VoiceStatus {
    const config = this.config();
    return "error" in config
      ? { available: false, detail: config.error }
      : { available: true };
  }

  private start(): VoiceHelperProcess {
    if (this.process) return this.process;
    const config = this.config();
    if ("error" in config) throw new Error(config.error);
    const helper = this.spawn(config);
    this.process = helper;
    void (async () => {
      for await (const frame of helper.frames) {
        if (frame.kind !== FRAME_JSON) continue;
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(new TextDecoder().decode(frame.payload));
        } catch {
          continue;
        }
        if (typeof reply.event === "string") {
          this.dispatch(reply as VoiceEvent);
          continue;
        }
        const pending =
          typeof reply.id === "number" ? this.pending.get(reply.id) : undefined;
        if (!pending) continue;
        this.pending.delete(reply.id as number);
        if (typeof reply.error === "string")
          pending.reject(new Error(reply.error));
        else pending.resolve(reply);
      }
    })();
    void helper.exited.then(() => {
      if (this.process === helper) this.process = null;
      for (const pending of this.pending.values())
        pending.reject(new Error("The voice helper stopped"));
      this.pending.clear();
      this.dispatch({ event: "error", error: "The voice helper stopped" });
    });
    return helper;
  }

  /** An event goes to its session; one without (the helper failing) to all. */
  private dispatch(event: VoiceEvent) {
    if (typeof event.session === "number") {
      this.listeners.get(event.session)?.(event);
      return;
    }
    for (const listener of [...this.listeners.values()]) listener(event);
  }

  private send(message: Record<string, unknown>) {
    this.start().write(
      encodeFrame(
        FRAME_JSON,
        new TextEncoder().encode(JSON.stringify(message)),
      ),
    );
  }

  private request(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const helper = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      helper.write(
        encodeFrame(
          FRAME_JSON,
          new TextEncoder().encode(JSON.stringify({ ...message, id })),
        ),
      );
    });
  }

  /**
   * Listens until `stop()`: speech starts and ends are the helper's call,
   * reported to `onEvent` with what was said. Starting a session ends the
   * one before, as the helper listens to one at a time.
   */
  listen(
    onEvent: (event: VoiceEvent) => void,
    options: ListenOptions = {},
  ): VoiceSession {
    const id = this.nextSession++;
    this.listeners.set(id, onEvent);
    this.send({
      op: "listen_start",
      session: id,
      hold: options.hold ?? false,
      ...(options.language ? { language: options.language } : {}),
      ...(options.endSilenceMs ? { end_silence_ms: options.endSilenceMs } : {}),
      ...(options.newSpeaker ? { new_speaker: true } : {}),
    });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, id, true);
    return {
      id,
      audio: (samples) => {
        if (!this.listeners.has(id) || !this.process) return;
        const payload = new Uint8Array(4 + samples.length);
        payload.set(header);
        payload.set(samples, 4);
        this.process.write(encodeFrame(FRAME_AUDIO, payload));
      },
      release: () => this.send({ op: "listen_release", session: id }),
      finish: () => this.send({ op: "listen_finish", session: id }),
      stop: () => {
        if (!this.listeners.delete(id)) return;
        if (this.process) this.send({ op: "listen_stop", session: id });
      },
    };
  }

  async speak(
    text: string,
    language?: string,
  ): Promise<{
    audio: Uint8Array<ArrayBuffer>;
    language: string;
    /** The rate it was made at: 1 for the voice's own pace. */
    nativeRate: number;
  }> {
    // Started first: its rate is the one this speech is made at.
    this.start();
    const nativeRate = this.nativeRate;
    const reply = await this.request({
      op: "speak",
      text,
      ...(language ? { language } : {}),
    });
    return {
      audio: Buffer.from(String(reply.audio ?? ""), "base64"),
      language: String(reply.language ?? ""),
      nativeRate,
    };
  }

  stop() {
    this.process?.kill();
    this.process = null;
  }
}
