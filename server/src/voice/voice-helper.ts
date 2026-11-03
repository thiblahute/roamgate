import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSpeechRate,
  playbackRateFor,
  speechRateOr,
} from "../../../shared/speechRate";
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
  /**
   * whisper.cpp's model; needed without `parakeet_model`. With it, Whisper
   * reads again what Parakeet writes in English while the conversation is
   * in another language.
   */
  whisper_model?: string;
  /** The Parakeet TDT ONNX directory (voice/helper/src/parakeet.rs). */
  parakeet_model?: string;
  /** Kokoro's ONNX model and voices; needed without `tts_models`. */
  kokoro_model?: string;
  kokoro_voices?: string;
  /**
   * any-tts models (anyttssynthesizer) reading replies in place of Kokoro,
   * in order of preference: each sentence goes to the first one speaking its
   * language. `model` names it ("qwen3-tts", "kokoro", ...), the other fields
   * are the element's for it (path, voice, voice_embedding, speed, ...).
   * A Qwen3-TTS CustomVoice entry names its stock speaker ("ryan") with
   * `speaker` or the element's `voice`; a Base entry clones the voice of
   * its `voice_embedding`.
   */
  tts_models?: Array<{ model: string } & Record<string, string | number>>;
  /** Speaker embeddings: only the first voice of a voice chat counts. */
  speaker_model?: string;
  /**
   * Recordings of the user's voice (any audio file, a few seconds each,
   * say one per language they speak): with speaker_model, the voice kept
   * is taken from them, rather than from the first sound heard.
   */
  speaker_reference?: string[];
  /** Smart Turn v3: a pause ends speech only when it sounds finished. */
  turn_model?: string;
  /** Qwen3 0.6B ONNX: with Parakeet, unfinished words keep a turn open. */
  text_turn_model?: string;
  /**
   * With Parakeet and the turn models, the longest pause, in ms, before a
   * turn whose voice sounded finished ends, when its words do not read
   * finished (voice-socket.ts): MAX_PAUSE_MS by default, MIN_PAUSE_MS to
   * LONGEST_PAUSE_MS. A pause that does not sound finished, or that follows
   * "euh", goes to LONGEST_PAUSE_MS. Speech settings change it.
   */
  max_pause_ms?: number;
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
   * A Claude model ("opus", "haiku") that hears each thing said first and
   * answers at once, aloud (voice-front.ts): it routes as `route_model`
   * does, in its place, and says what it does with the words or answers
   * what Roamgate's state answers. Off without it.
   */
  front_model?: string;
  /**
   * What a front does with the agents' answers on a call (voice-front.ts):
   * "companion" (the default with `front_model`) tells them as the
   * conversation goes, in its own words or theirs, and reads one whole when
   * asked; "relay" reads every answer aloud, as without a front.
   */
  front_mode?: FrontMode;
  /**
   * The Claude model a front's web searches run on (voice-research.ts):
   * "opus" (at low effort) by default.
   */
  research_model?: string;
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
  /**
   * Where voices recorded from the page are kept (voice-library.ts);
   * ~/.local/share/roamgate/voices by default.
   */
  voices_dir?: string;
  /**
   * The Qwen3-TTS Base model voices are cloned for; the first Qwen3-TTS
   * model of `tts_models` that is a Base model by default.
   */
  clone_model?: string;
  /**
   * The Qwen3-TTS CustomVoice model whose stock speakers (Ryan, Vivian...)
   * can read replies (voice-stock.ts); by default the first CustomVoice
   * model of `tts_models`, or one next to the Base model.
   */
  stock_model?: string;
  /**
   * Surprise: each reply is read by one of the voices at random
   * (voice-surprise.ts), from the Voice tab or the voice card.
   */
  voice_surprise?: boolean;
};

/**
 * A pause this long, in audio, ends the utterance when the voice sounded
 * finished (voice-socket.ts's TURN_SOUNDS_FINISHED) and only the words kept the turn open;
 * voice.json's `max_pause_ms` changes it, from MIN_PAUSE_MS to
 * LONGEST_PAUSE_MS (voice-socket.ts). Well past speechgate's own checks (1.5 to 3.5 s), so it
 * only matters when the words model keeps vetoing a finished sentence.
 */
export const MAX_PAUSE_MS = 8_000;
export const MIN_PAUSE_MS = 2_000;
/**
 * Any pause this long ends the utterance: the voice did not sound finished,
 * or the speaker said "euh" before it. speechgate gives up at the same
 * length (`--turn-give-up-ms`).
 */
export const LONGEST_PAUSE_MS = 15_000;
/** `max_pause_ms` as voice.json may give it: MAX_PAUSE_MS when unusable. */
export function maxPauseMs(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PAUSE_MS &&
    value <= LONGEST_PAUSE_MS
    ? Math.round(value)
    : MAX_PAUSE_MS;
}

export type FrontMode = "companion" | "relay";

export function isFrontMode(value: unknown): value is FrontMode {
  return value === "companion" || value === "relay";
}

/** What the front does with the answers; null without a front. */
export function frontMode(config: VoiceConfig): FrontMode | null {
  if (!config.front_model) return null;
  return config.front_mode ?? "companion";
}

export type VoiceStatus =
  | { available: true }
  | { available: false; detail: string };

const REQUIRED = ["helper"] as const;

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
    "front_model",
    "research_model",
    "errand_folder",
    "claude_command",
    "voices_dir",
    "clone_model",
    "stock_model",
  ])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || !config[key])
    )
      return { error: `${path}: ${key} must be a string` };
  if (
    config.voice_surprise !== undefined &&
    typeof config.voice_surprise !== "boolean"
  )
    return { error: `${path}: voice_surprise must be true or false` };
  if (config.front_mode !== undefined && !isFrontMode(config.front_mode))
    return { error: `${path}: front_mode must be "companion" or "relay"` };
  if (config.speech_rate !== undefined && !isSpeechRate(config.speech_rate))
    return { error: `${path}: speech_rate must be a number from 0.5 to 2` };
  if (config.whisper_model === undefined && config.parakeet_model === undefined)
    return { error: `${path}: whisper_model or parakeet_model is required` };
  if (config.tts_models !== undefined) {
    const models = config.tts_models;
    if (
      !Array.isArray(models) ||
      models.length === 0 ||
      !models.every(
        (model) =>
          model &&
          typeof model === "object" &&
          typeof (model as { model?: unknown }).model === "string",
      )
    )
      return {
        error: `${path}: tts_models must be a list of objects with a model name`,
      };
    for (const model of models as Record<string, unknown>[])
      if (
        model.speaker !== undefined &&
        (typeof model.speaker !== "string" || !model.speaker)
      )
        return {
          error: `${path}: the speaker of a ${String(model.model)} model must be a name`,
        };
  } else if (
    config.kokoro_model === undefined ||
    config.kokoro_voices === undefined
  )
    return {
      error: `${path}: kokoro_model and kokoro_voices, or tts_models, are required`,
    };
  for (const key of [
    "kokoro_model",
    "kokoro_voices",
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
  if (config.speaker_reference !== undefined) {
    const paths = config.speaker_reference;
    if (
      !Array.isArray(paths) ||
      !paths.every((file) => typeof file === "string" && file)
    )
      return { error: `${path}: speaker_reference must be a list of files` };
    for (const file of paths as string[])
      if (!existsSync(file))
        return { error: `speaker_reference not found: ${file}` };
  }
  return config as VoiceConfig;
}

/**
 * Keeps `rate` as `speech_rate` in the voice.json at `path`, its other
 * settings untouched; replaced whole, so a reader never sees half of it.
 */
export function writeSpeechRate(rate: number, path = voiceConfigPath()) {
  if (!isSpeechRate(rate)) throw new Error("speech_rate must be 0.5 to 2");
  writeVoiceSetting("speech_rate", rate, path);
}

/** Keeps `ms` as `max_pause_ms` in voice.json, as writeSpeechRate does. */
export function writeMaxPause(ms: number, path = voiceConfigPath()) {
  if (maxPauseMs(ms) !== ms)
    throw new Error(
      `max_pause_ms must be ${MIN_PAUSE_MS} to ${LONGEST_PAUSE_MS} ms`,
    );
  writeVoiceSetting("max_pause_ms", ms, path);
}

/** Keeps `mode` as `front_mode` in voice.json, as writeSpeechRate does. */
export function writeFrontMode(mode: FrontMode, path = voiceConfigPath()) {
  if (!isFrontMode(mode))
    throw new Error('front_mode must be "companion" or "relay"');
  writeVoiceSetting("front_mode", mode, path);
}

function writeVoiceSetting(key: string, value: unknown, path: string) {
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  config[key] = value;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * The rate the helper's voice model speaks at by itself; the helper's
 * tempo (speak's `rate`) makes up the rest. Only Kokoro takes a speed (Qwen3-TTS and
 * the other any-tts models refuse one), and which model reads a sentence is
 * the element's choice: `speech_rate` goes to the models only when all of
 * them are Kokoro and none sets its own `speed`, else they speak at their
 * own pace (1) and the tempo does it all.
 */
export function nativeSpeechRate(config: VoiceConfig): number {
  const models = config.tts_models;
  return models?.length &&
    models.every((model) => model.model === "kokoro" && !("speed" in model))
    ? speechRateOr(config.speech_rate)
    : 1;
}

/**
 * `tts_models` as the helper gets them: a stock `speaker` as the element's
 * `voice`, and with the native rate's speed.
 */
export function helperTtsModels(
  config: VoiceConfig,
): VoiceConfig["tts_models"] {
  const rate = nativeSpeechRate(config);
  return config.tts_models?.map((entry) => {
    const { speaker, ...model } = entry;
    return {
      ...model,
      ...(speaker !== undefined && model.voice === undefined
        ? { voice: speaker }
        : {}),
      ...(rate === 1 ? {} : { speed: rate }),
    };
  });
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
/** The kinds of frame the helper writes. */
const FRAME_KINDS: ReadonlySet<number> = new Set([FRAME_JSON, FRAME_AUDIO]);
/** The largest frame the helper writes or reads (frames.rs's MAX_FRAME). */
export const MAX_FRAME = 16 * 1024 * 1024;

export type Frame = { kind: number; payload: Uint8Array };

export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, true);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
}

/**
 * What came from the helper is not a frame: something else wrote on its
 * frames (a library printing on its stdout). `bytes` are the first of
 * what came there, escaped, to tell what wrote it.
 */
export class FrameError extends Error {
  constructor(readonly bytes: string) {
    super(`not a frame: ${bytes}`);
  }
}

/** The first `count` of `bytes` as text: other bytes as \xNN. */
export function escapeBytes(bytes: Uint8Array, count = 200): string {
  let text = "";
  for (const byte of bytes.subarray(0, count))
    text +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`;
  return bytes.length > count ? `${text}...` : text;
}

/**
 * Splits a byte stream into frames, however it arrives. What cannot be a
 * frame (a length of 0 or past MAX_FRAME, a kind the helper does not
 * write) breaks the stream for good: `error` says what came, and nothing
 * after it is read.
 */
export class FrameReader {
  private buffer = new Uint8Array(0);
  /** What is not read yet: buffer[start, end). */
  private start = 0;
  private end = 0;
  error: FrameError | null = null;

  constructor(private readonly kinds: ReadonlySet<number> = FRAME_KINDS) {}

  /** The frames `chunk` completes, up to what is not a frame, if any. */
  push(chunk: Uint8Array): Frame[] {
    if (this.error) return [];
    this.append(chunk);
    const frames: Frame[] = [];
    while (this.end - this.start >= 4) {
      const at = this.start;
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + at,
      ).getUint32(0, true);
      if (
        length === 0 ||
        length > MAX_FRAME ||
        (this.end - at > 4 && !this.kinds.has(this.buffer[at + 4]!))
      ) {
        this.error = new FrameError(
          escapeBytes(this.buffer.subarray(at, this.end)),
        );
        this.buffer = new Uint8Array(0);
        this.start = this.end = 0;
        break;
      }
      if (this.end - at - 4 < length) break;
      frames.push({
        kind: this.buffer[at + 4]!,
        payload: this.buffer.slice(at + 5, at + 4 + length),
      });
      this.start = at + 4 + length;
    }
    if (this.start === this.end) this.start = this.end = 0;
    return frames;
  }

  /** Keeps `chunk` after what is not read, copying that only to grow. */
  private append(chunk: Uint8Array) {
    if (this.end + chunk.length > this.buffer.length) {
      const kept = this.end - this.start;
      const needed = kept + chunk.length;
      if (needed <= this.buffer.length)
        this.buffer.copyWithin(0, this.start, this.end);
      else {
        const grown = new Uint8Array(
          Math.max(needed, this.buffer.length * 2, 64 * 1024),
        );
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      }
      this.start = 0;
      this.end = kept;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }
}

export type VoiceHelperProcess = {
  write: (frame: Uint8Array) => void;
  /** Frames the helper writes; a FrameError at what is not one. */
  frames: AsyncIterable<Frame>;
  exited: Promise<unknown>;
  kill: () => void;
};

/**
 * The speech to text models the helper is given: Parakeet, with Whisper's
 * model too when there is one, to read again what Parakeet writes in English
 * while the conversation is in another language (reread.rs); or Whisper.
 */
export function transcriberArgs(
  config: Pick<VoiceConfig, "parakeet_model" | "whisper_model">,
): string[] {
  if (!config.parakeet_model)
    return ["--whisper-model", config.whisper_model ?? ""];
  return [
    "--parakeet-model",
    config.parakeet_model,
    ...(config.whisper_model ? ["--whisper-model", config.whisper_model] : []),
  ];
}

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
      ...transcriberArgs(config),
      ...(config.tts_models
        ? ["--tts-models", JSON.stringify(helperTtsModels(config))]
        : [
            "--kokoro-model",
            config.kokoro_model ?? "",
            "--kokoro-voices",
            config.kokoro_voices ?? "",
          ]),
      ...(config.speaker_model
        ? ["--speaker-model", config.speaker_model]
        : []),
      ...(config.speaker_model && config.speaker_reference?.length
        ? ["--speaker-reference", JSON.stringify(config.speaker_reference)]
        : []),
      ...(config.turn_model ? ["--turn-model", config.turn_model] : []),
      ...(config.text_turn_model
        ? ["--text-turn-model", config.text_turn_model]
        : []),
      // The page's cap (voice-socket.ts) ends finished-sounding pauses
      // sooner; speechgate's own 5 s would cut a search for a word short.
      ...(config.text_turn_model && config.parakeet_model
        ? ["--turn-give-up-ms", String(LONGEST_PAUSE_MS)]
        : []),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit", env },
  );
  async function* frames() {
    const reader = new FrameReader();
    for await (const chunk of child.stdout) {
      yield* reader.push(chunk);
      if (reader.error) throw reader.error;
    }
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
  /**
   * On a partial at a pause: how far into it the words were read, whether
   * the speaker sounds to be thinking ("euh"), and at speechgate's checks,
   * how finished the voice (`turn`) and the words (`words`) sound, 0 to 1.
   */
  pause_ms?: number;
  thinking?: boolean;
  turn?: number;
  words?: number;
  /** On a cleaned final: the words as heard, and whether to the agent. */
  raw?: string;
  for_agent?: boolean;
  /**
   * On a session's `error`: the helper stopped under it, and runs again
   * from the next request. The session is over, nothing else is.
   */
  recoverable?: boolean;
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
  /** The listening sessions, each with the helper process it runs in. */
  private listeners = new Map<
    number,
    { helper: VoiceHelperProcess; onEvent: (event: VoiceEvent) => void }
  >();
  private nextId = 1;
  private nextSession = 1;
  /** The rate the running helper's voice speaks at by itself. */
  private nativeRate = 1;

  constructor(
    private readonly config: () => VoiceConfig | { error: string },
    private readonly spawn: (
      config: VoiceConfig,
    ) => VoiceHelperProcess = spawnVoiceHelper,
    private readonly saveSpeechRate: (rate: number) => void = (rate) =>
      writeSpeechRate(rate),
    private readonly saveMaxPause: (ms: number) => void = (ms) =>
      writeMaxPause(ms),
  ) {}

  /**
   * The longest pause before a turn that sounded finished ends
   * (`max_pause_ms`), read by each listening session as it starts.
   */
  maxPauseMs(): number {
    const config = this.config();
    return maxPauseMs("error" in config ? undefined : config.max_pause_ms);
  }

  setMaxPauseMs(ms: number) {
    this.saveMaxPause(ms);
  }

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
    this.nativeRate = nativeSpeechRate(config);
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
    })().catch((error) => {
      // Something else wrote on its frames: nothing it says can be read
      // from there on. Restarted at once, saying what came.
      console.error(
        `[voice] the helper's output is not frames, restarting it: ${error instanceof FrameError ? error.bytes : String(error)}`,
      );
      if (this.process === helper) helper.kill();
    });
    void helper.exited.then(() => {
      if (this.process === helper) this.process = null;
      for (const pending of this.pending.values())
        pending.reject(new Error("The voice helper stopped"));
      this.pending.clear();
      // Its listenings end with it, each told on its own session: the
      // page listens again, in the next helper, on the same link.
      for (const [session, listener] of [...this.listeners]) {
        if (listener.helper !== helper) continue;
        this.listeners.delete(session);
        listener.onEvent({
          event: "error",
          session,
          error: "The voice helper stopped",
          recoverable: true,
        });
      }
    });
    return helper;
  }

  /** An event goes to its session; one without (the helper failing) to all. */
  private dispatch(event: VoiceEvent) {
    if (typeof event.session === "number") {
      this.listeners.get(event.session)?.onEvent(event);
      return;
    }
    for (const listener of [...this.listeners.values()])
      listener.onEvent(event);
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
    this.listeners.set(id, { helper: this.start(), onEvent });
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
    // Only to the helper it runs in: one that stopped took it along.
    const running = () => {
      const helper = this.listeners.get(id)?.helper;
      return helper && helper === this.process ? helper : null;
    };
    return {
      id,
      audio: (samples) => {
        const helper = running();
        if (!helper) return;
        const payload = new Uint8Array(4 + samples.length);
        payload.set(header);
        payload.set(samples, 4);
        helper.write(encodeFrame(FRAME_AUDIO, payload));
      },
      release: () => {
        if (running()) this.send({ op: "listen_release", session: id });
      },
      finish: () => {
        if (running()) this.send({ op: "listen_finish", session: id });
      },
      stop: () => {
        if (!this.listeners.delete(id)) return;
        if (this.process) this.send({ op: "listen_stop", session: id });
      },
    };
  }

  /**
   * Speaks `text`, with `models` (`tts_models`) for this once when given,
   * such as a voice to hear before choosing it. With a `rate`, the helper
   * makes it that fast (soundtouch, keeping the pitch) beyond what the
   * voice's model does itself; `nativeRate` says what it came out at (a
   * helper without soundtouch leaves it at the model's).
   */
  async speak(
    text: string,
    language?: string,
    models?: VoiceConfig["tts_models"],
    rate?: number,
  ): Promise<{
    audio: Uint8Array<ArrayBuffer>;
    language: string;
    /** The rate it was made at: 1 for the voice's own pace. */
    nativeRate: number;
  }> {
    // Started first: its rate is the one this speech is made at.
    this.start();
    let nativeRate = this.nativeRate;
    let override: VoiceConfig["tts_models"];
    if (models) {
      const config = this.config();
      const own = {
        ...("error" in config ? { helper: "" } : config),
        tts_models: models,
      };
      nativeRate = nativeSpeechRate(own);
      override = helperTtsModels(own);
    }
    // What the model does not do, the helper's tempo does.
    const tempo = rate === undefined ? 1 : playbackRateFor(rate, nativeRate);
    const reply = await this.request({
      op: "speak",
      text,
      ...(language ? { language } : {}),
      ...(override ? { tts_models: JSON.stringify(override) } : {}),
      ...(tempo === 1 ? {} : { rate: tempo }),
    });
    const made =
      typeof reply.rate === "number" && reply.rate > 0 ? reply.rate : 1;
    return {
      audio: Buffer.from(String(reply.audio ?? ""), "base64"),
      language: String(reply.language ?? ""),
      nativeRate: Math.round(nativeRate * made * 1000) / 1000,
    };
  }

  /**
   * The running helper reads with voice.json's `tts_models` from the next
   * sentence on, loading only what changed; one not running reads them when
   * it starts.
   */
  async applyTtsModels() {
    if (!this.process) return;
    const config = this.config();
    if ("error" in config || !config.tts_models) return;
    await this.request({
      op: "set_tts_models",
      tts_models: JSON.stringify(helperTtsModels(config)),
    });
    this.nativeRate = nativeSpeechRate(config);
  }

  /**
   * A voice from a recording (voice/helper/src/clone.rs): its x-vector and
   * codec codes, and what the speech to text model heard in it.
   */
  async cloneVoice(request: {
    audio: string;
    model: string;
    reference: string;
    language: string;
  }): Promise<{
    embedding: number[];
    codes: number[][];
    heard: string;
    seconds: number;
  }> {
    const reply = await this.request({ op: "clone_voice", ...request });
    if (!Array.isArray(reply.embedding) || !Array.isArray(reply.codes))
      throw new Error("The voice helper sent no voice");
    return {
      embedding: reply.embedding as number[],
      codes: reply.codes as number[][],
      heard: typeof reply.heard === "string" ? reply.heard : "",
      seconds: typeof reply.seconds === "number" ? reply.seconds : 0,
    };
  }

  stop() {
    this.process?.kill();
    this.process = null;
  }
}
