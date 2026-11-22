import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  isSpeechRate,
  playbackRateFor,
  speechRateOr,
} from "../../../shared/speechRate";
import { dataRoot } from "../config/data-paths";
import { serverLogger } from "../utils/logger";
import {
  parseVoiceTag,
  SpeakerTracker,
  type VoiceTag,
  withoutPrints,
} from "./voice-speakers";
import {
  cannotReadNotice,
  KOKORO_VOICES,
  kokoroCannotRead,
} from "./voice-kokoro-language";
import type { CompanionMcpConfig } from "./voice-tools";

/**
 * Voice chat runs on a helper process (voice/helper) that keeps the speech
 * models loaded: whispertranscriber for speech to text, kokorosynthesizer
 * for text to speech. `voice.json` in Roamgate's data directory says where
 * it and its models are; without it, voice is unavailable. Parakeet, when
 * set, transcribes in place of Whisper.
 */

/** The voice's timing lines for speech. */
const speechLog = serverLogger.child("voice");
const now = () => performance.now();

/** When a sentence was asked for, started, and its first audio came. */
type SpeakTimes = { sentAt: number; startedAt?: number; audioAt?: number };

export type VoiceConfig = {
  /** The roamgate-voice binary. */
  helper: string;
  /**
   * Arguments put before the helper's command: a program that runs it on
   * its own terms (elsewhere, with resources it frees for it), passing its
   * standard input and output through. Empty: the helper runs directly.
   */
  helper_wrapper?: string[];
  /**
   * Minutes with no call, listening or speech after which the helper
   * stops, giving back what its models hold; the next voice request starts
   * it again. Unset or 0: it runs until the server stops.
   */
  helper_idle_exit_minutes?: number;
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
  /**
   * Kokoro's ONNX model and voices; needed without `tts_models`. With them,
   * a sentence only Kokoro reads (its entries alone, such as a sentence
   * said again after another model failed) is read by this one: its
   * phonemes are espeak-ng's, where any-tts's Kokoro mangles French.
   */
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
  /**
   * Speaker embeddings (WeSpeaker ResNet34 ONNX): the voices heard on a
   * call are told apart, each utterance told to the companion with whose
   * voice it is (voice-speakers.ts).
   */
  speaker_model?: string;
  /**
   * With speaker_model, for noisy places: only the first voice of a voice
   * chat counts, other voices dropped before they are transcribed.
   */
  drop_other_voices?: boolean;
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
   * The Claude model that cleans dictated text before it is typed
   * (voice-dictation.ts): "opus" (at low effort) by default, "off" to type
   * the words as heard.
   */
  dictation_model?: string;
  /** The Claude Code command for `dictation_model`; `claude_command` by default. */
  dictation_command?: string;
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
   * The MCP tools the voice companion may use (voice-tools.ts): Claude
   * Code's own MCP servers and claude.ai connectors. `allow` lists those
   * it runs, `confirm` those it runs only once the user said yes to the
   * exact call (and any tool whose name says it sends, writes or deletes
   * is one of those); `model` runs the jobs. Off without it.
   */
  companion_mcp?: CompanionMcpConfig;
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
  /**
   * What plays under a voice call (voice/helper/src/call.rs): a gst-launch
   * description of a source, such as `osxprocesstapsrc
   * bundle-id=com.spotify.client` (what the Spotify app plays on the Mac).
   * The helper mixes it with the replies and the page hears one stream.
   * Off when empty.
   */
  call_background?: string;
  /** The music's level when nobody talks, 0 to 1; 0.6 by default. */
  call_background_volume?: number;
  /** The factor applied while someone talks, 0 to 1; 0.15 by default. */
  call_background_ducked?: number;
  /** Quiet time before the music comes back up, in ms; 3000 by default. */
  call_background_release_ms?: number;
  /** Whether a call starts with its music on; off, it waits to be asked. */
  call_music_at_start?: boolean;
  /**
   * The Spotify Connect device whose sound call_background records here
   * ("amd-desktop" for the desktop's Spotify app): the companion's tools
   * play the music asked for on a call there. Unset, they use the
   * connector's default device.
   */
  call_music_device?: string;
  /**
   * Whether the companion also sets call_music_device's volume to 100
   * when it starts, resumes or moves music there (true by default): the
   * call sets the music's level, so the device's own volume stays full.
   */
  call_music_full_volume?: boolean;
  /**
   * Whether the companion's tools may play YouTube videos as a call's
   * music, in the helper (voice-youtube.ts): true by default, with
   * call_background; false takes YouTube from them.
   */
  youtube?: boolean;
  /** yt-dlp's command, a program first; ["yt-dlp"] by default. */
  yt_dlp?: string[];
  /**
   * The loudness a call's replies are brought to, in LUFS, -40 to -6
   * (-16 by default), their peaks kept under -1 dBTP; false leaves them as
   * the models make them (-20 to -24 LUFS). A phone's own loudspeaker
   * plays a call on the voice call stream, quieter than media.
   */
  call_reply_loudness?: number | false;
  /**
   * The IPv4 address phones reach this machine at for a call's audio
   * (WebRTC): its Tailscale address when tailscaled runs in userspace
   * networking, which forwards UDP sent there to 127.0.0.1. The helper's
   * loopback ICE candidates are given to the page with it.
   */
  call_ice_address?: string;
  /**
   * Not in voice.json: set by the low-GPU profile (voice-low-gpu.ts) on
   * the configuration the helper starts with, its models swapped for the
   * profile's; says who asked for it ("gaming", "GameMode"...). Such a
   * helper reads every sentence with its own voice, a voice chosen in
   * Voices (a Qwen3-TTS one) left for when the profile ends.
   */
  low_gpu?: string;
};

/** A dotted IPv4 address, each part 0 to 255. */
export function isIPv4(address: string): boolean {
  const parts = address.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** A call's background as the helper's call_start takes it. */
export type CallBackground = {
  background: string;
  volume: number;
  ducked: number;
  release_ms: number;
  /** The music off until asked for: its source is only made then. */
  muted: boolean;
  /** The replies' loudness in LUFS; null leaves them as made. */
  reply_loudness: number | null;
};

/** call_reply_loudness's default: broadcast speech's level. */
export const CALL_REPLY_LOUDNESS = -16;

export function callBackground(config: VoiceConfig): CallBackground {
  return {
    background: config.call_background?.trim() ?? "",
    volume: config.call_background_volume ?? 0.6,
    ducked: config.call_background_ducked ?? 0.15,
    release_ms: config.call_background_release_ms ?? 3000,
    muted: config.call_music_at_start !== true,
    reply_loudness:
      config.call_reply_loudness === false
        ? null
        : (config.call_reply_loudness ?? CALL_REPLY_LOUDNESS),
  };
}

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
    "dictation_model",
    "dictation_command",
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
  if (
    config.drop_other_voices !== undefined &&
    typeof config.drop_other_voices !== "boolean"
  )
    return { error: `${path}: drop_other_voices must be true or false` };
  if (
    config.call_background !== undefined &&
    typeof config.call_background !== "string"
  )
    return { error: `${path}: call_background must be a string` };
  for (const key of ["call_background_volume", "call_background_ducked"])
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "number" ||
        !(config[key] >= 0 && config[key] <= 1))
    )
      return { error: `${path}: ${key} must be a number from 0 to 1` };
  if (
    config.call_background_release_ms !== undefined &&
    (typeof config.call_background_release_ms !== "number" ||
      !(
        config.call_background_release_ms >= 0 &&
        config.call_background_release_ms <= 60_000
      ))
  )
    return {
      error: `${path}: call_background_release_ms must be 0 to 60000`,
    };
  if (
    config.call_music_at_start !== undefined &&
    typeof config.call_music_at_start !== "boolean"
  )
    return { error: `${path}: call_music_at_start must be true or false` };
  if (
    config.call_music_device !== undefined &&
    typeof config.call_music_device !== "string"
  )
    return { error: `${path}: call_music_device must be a string` };
  if (
    config.call_music_full_volume !== undefined &&
    typeof config.call_music_full_volume !== "boolean"
  )
    return { error: `${path}: call_music_full_volume must be true or false` };
  if (
    config.call_reply_loudness !== undefined &&
    config.call_reply_loudness !== false &&
    !(
      typeof config.call_reply_loudness === "number" &&
      config.call_reply_loudness >= -40 &&
      config.call_reply_loudness <= -6
    )
  )
    return {
      error: `${path}: call_reply_loudness must be -40 to -6 (LUFS), or false`,
    };
  if (
    config.call_ice_address !== undefined &&
    !(
      typeof config.call_ice_address === "string" &&
      isIPv4(config.call_ice_address)
    )
  )
    return { error: `${path}: call_ice_address must be an IPv4 address` };
  if (
    config.helper_wrapper !== undefined &&
    !(
      Array.isArray(config.helper_wrapper) &&
      config.helper_wrapper.every((arg) => typeof arg === "string") &&
      (config.helper_wrapper.length === 0 || config.helper_wrapper[0])
    )
  )
    return {
      error: `${path}: helper_wrapper must be a list of arguments, a program first`,
    };
  if (
    config.yt_dlp !== undefined &&
    !(
      Array.isArray(config.yt_dlp) &&
      config.yt_dlp.every((arg) => typeof arg === "string") &&
      config.yt_dlp[0]
    )
  )
    return {
      error: `${path}: yt_dlp must be a list of arguments, a program first`,
    };
  if (config.youtube !== undefined && typeof config.youtube !== "boolean")
    return { error: `${path}: youtube must be true or false` };
  if (
    config.helper_idle_exit_minutes !== undefined &&
    !(
      typeof config.helper_idle_exit_minutes === "number" &&
      Number.isFinite(config.helper_idle_exit_minutes) &&
      config.helper_idle_exit_minutes >= 0
    )
  )
    return {
      error: `${path}: helper_idle_exit_minutes must be a number of minutes, 0 for never`,
    };
  if (config.companion_mcp !== undefined) {
    const mcp = config.companion_mcp as Record<string, unknown> | null;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp))
      return { error: `${path}: companion_mcp must be an object` };
    for (const key of ["allow", "confirm"])
      if (
        mcp[key] !== undefined &&
        !(
          Array.isArray(mcp[key]) &&
          (mcp[key] as unknown[]).every(
            (tool) => typeof tool === "string" && tool.trim(),
          )
        )
      )
        return {
          error: `${path}: companion_mcp.${key} must be a list of tool names`,
        };
    if (
      mcp.model !== undefined &&
      (typeof mcp.model !== "string" || !mcp.model)
    )
      return { error: `${path}: companion_mcp.model must be a string` };
  }
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
  updateVoiceConfig({ [key]: value }, path);
}

/**
 * Keeps `patch` in the voice.json at `path` (made when missing), its other
 * settings untouched; a key whose value is undefined is removed. Replaced
 * whole, so a reader never sees half of it.
 */
export function updateVoiceConfig(
  patch: Record<string, unknown>,
  path = voiceConfigPath(),
) {
  const config = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(patch))
    if (value === undefined) delete config[key];
    else config[key] = value;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

/** What the helper says of a call: its background or microphone failed. */
export type CallEvent =
  | { event: "call_error"; call: number; error: string }
  /**
   * The helper restarted: the call was made again, from time 0, with a
   * new signalling server; the page's WebRTC sessions start again on it.
   */
  | { event: "call_restarted"; call: number }
  /**
   * The call is over in the helper: it could not be made again after a
   * restart, or the helper was stopped on purpose.
   */
  | { event: "call_ended"; call: number; error: string }
  /**
   * The call's music waits, silent, while the helper learns a new
   * speaker's voice (true), or may play again (false): told at the call's
   * start and on each change.
   */
  | { event: "call_music"; call: number; waiting: boolean };

/**
 * A call the helper runs (VoiceHelper.startCall): a WebRTC call with the
 * page, signalled through the helper's signalling server
 * (voice/helper/src/call.rs).
 */
export type CallHandle = {
  id: number;
  /** Where the call's signalling server listens, on 127.0.0.1, now. */
  signallingPort: () => number;
  /**
   * Listens to the page's microphone: its producer's peer id in the
   * signalling. Again with the same id after the page published it anew.
   * `echo` "here" has the helper cancel the replies' echo in it (the page
   * plays them without its own echo canceller).
   */
  microphone: (peer: string, echo?: "here" | "page") => Promise<void>;
  /** Whether the call has a background (call_background), on or off. */
  music: boolean;
  /**
   * Whether that background is on now: off at the start without
   * call_music_at_start, then as call_music last left it.
   */
  musicOn: () => boolean;
  /**
   * Whether it waits, silent, for the helper to learn the speaker's voice
   * (call_music events): on, yet nothing plays.
   */
  musicWaiting: () => boolean;
  /** The voice queued in the mix goes (the user talks over it). */
  hush: () => void;
  /** The music's level and whether it is off; answers what it is now. */
  music_level: (change: {
    volume?: number;
    muted?: boolean;
  }) => Promise<{ volume: number; muted: boolean }>;
  stop: () => void;
};

/** A sentence put into a call's mix: where it is in the mix's time. */
export type QueuedSpeech = {
  queued: true;
  startMs: number;
  durationMs: number;
  /** Where the mix was when it was all made. */
  nowMs: number;
  language: string;
  nativeRate: number;
};

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
  /** Its process, sampled before a stuck one is stopped. */
  pid?: number;
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

/** helper_idle_exit_minutes in milliseconds: 0 for never. */
export function idleExitMs(
  config: Pick<VoiceConfig, "helper_idle_exit_minutes">,
): number {
  return Math.max(0, (config.helper_idle_exit_minutes ?? 0) * 60_000);
}

/**
 * The helper's command line: `helper_wrapper`'s arguments, when set, then
 * the helper and what it is given.
 */
export function helperCommand(config: VoiceConfig): string[] {
  return [
    ...(config.helper_wrapper ?? []),
    config.helper,
    ...transcriberArgs(config),
    ...(config.tts_models
      ? ["--tts-models", JSON.stringify(helperTtsModels(config))]
      : []),
    // Beside tts_models, it reads the sentences only Kokoro reads.
    ...(!config.tts_models ||
    (config.kokoro_model !== undefined && config.kokoro_voices !== undefined)
      ? [
          "--kokoro-model",
          config.kokoro_model ?? "",
          "--kokoro-voices",
          config.kokoro_voices ?? "",
        ]
      : []),
    ...(config.speaker_model ? ["--speaker-model", config.speaker_model] : []),
    ...(config.speaker_model && config.drop_other_voices === true
      ? ["--drop-other-voices"]
      : []),
    ...(config.speaker_model &&
    config.drop_other_voices === true &&
    config.speaker_reference?.length
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
  ];
}

/**
 * How long a wrapped helper has to end once its input closed before its
 * wrapper is signalled: the helper's own limit (EXIT_GRACE, 10 s) and a
 * little more.
 */
export const WRAPPED_EXIT_MS = 15_000;

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
  const wrapped = (config.helper_wrapper?.length ?? 0) > 0;
  const child = Bun.spawn(helperCommand(config), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env,
  });
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
    // A wrapper may run the helper where signals sent to the wrapper do
    // not reach (the wrapper ends, the helper goes on): the helper ends at
    // the end of its input, and the wrapper is signalled only if it still
    // runs WRAPPED_EXIT_MS later.
    kill: wrapped
      ? () => {
          try {
            child.stdin.end();
          } catch {
            // Already closed: the helper is ending.
          }
          const late = setTimeout(() => child.kill(), WRAPPED_EXIT_MS);
          void child.exited.then(() => clearTimeout(late));
        }
      : () => child.kill(),
    // A wrapper's process is not the helper's: nothing to sample.
    pid: wrapped ? undefined : child.pid,
  };
}

/** What the helper says about a listening session. */
export type VoiceEvent = {
  event:
    | "speech_start"
    | "speech_end"
    | "text"
    | "partial"
    | "final"
    | "error"
    /** A call's microphone came for the session: `bytes` of it. */
    | "audio"
    /**
     * The session waits for the listening models to load (a helper just
     * started), its audio heard once they are: `listen_ready`.
     */
    | "listen_loading"
    | "listen_ready";
  session?: number;
  /** On `audio`: how much came, as 16 kHz mono S16LE. */
  bytes?: number;
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
  /** On a final, with a speaker model: whose voice (voice-speakers.ts). */
  voice?: VoiceTag;
  /** On a final relayed to a page: the voice's label for the companion. */
  voice_label?: string;
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
  /** The call whose microphone (WebRTC) is heard, not `audio()`'s. */
  call?: number;
};

/** A call the helper runs, with where its events go. */
type RunningCall = {
  event: (event: CallEvent) => void;
  /** What it was started with: made again by a restarted helper. */
  background: CallBackground;
  /** Its signalling server's port, in the helper running now. */
  port: number;
  /** The helper answered its call_start: a restarted helper makes it again. */
  started: boolean;
  /** Its music waits for a voice (call_start's answer, then its events). */
  waiting: boolean;
  /** A call_music event came: newer than call_start's answer. */
  told: boolean;
  /** How many times its voice was hushed: a sentence hushed is silent. */
  hushes: number;
};

/** How long a ping may take before the helper's output is taken as unread. */
export const PING_MS = 2000;

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
  /** Each sentence being made: when it was asked, started, first heard. */
  private speakTimes = new Map<number, SpeakTimes>();
  private nextId = 1;
  private nextSession = 1;
  private nextCall = 1;
  /** The calls the helper runs. */
  private calls = new Map<number, RunningCall>();
  /** The calls being made again after the helper restarted. */
  private callsBack: Promise<void> = Promise.resolve();
  /** Stopped on purpose (stop()): its calls end with it. */
  private stopping = false;
  /** The rate the running helper's voice speaks at by itself. */
  private nativeRate = 1;
  /** Speak requests the helper has not answered yet. */
  private speaking = 0;
  /** Fires when the helper made no speech for SPEAK_STUCK_MS. */
  private speakWatch: ReturnType<typeof setTimeout> | null = null;
  /** What the running helper said of its speaker (speakProgress). */
  private progress = { reports: false, ready: false, loading: false };
  /** Whether a stuck helper is sampled before it stops (off in tests). */
  sampleHangs = true;
  /** Which voice is the user's on the call, learnt as it goes. */
  readonly speakers = new SpeakerTracker();
  /** What the running helper has spoken with (voice and call): warm. */
  private warm = new Set<string>();
  /** The speak requests waiting, in order: the helper reads one at a time. */
  private speakQueue: string[] = [];
  /**
   * Until when (Date.now()) Kokoro reads: after a stuck speaker was
   * restarted, or a sentence its speaker failed.
   */
  private kokoroUntil = 0;
  /** Restarts of the helper by this side so far, and why the last one. */
  private restarts = 0;
  private restartedFor: "stuck" | "unreadable" | "models" = "stuck";
  /** Arms of the speak watch: a ping's answer acts on its own arm only. */
  private watchArms = 0;
  /** The running helper's helper_idle_exit_minutes, in ms: 0 for never. */
  private idleMs = 0;
  /** Stops the helper once idleMs passed with nothing to or from it. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The running helper's low_gpu (voice-low-gpu.ts): null for its full set. */
  private lowGpu: string | null = null;
  /** Whether only Kokoro reads in the running helper (no other model). */
  private kokoroOnly = false;
  /**
   * Awaited as a call starts, before the helper is asked for it: the
   * low-GPU profile (voice-low-gpu.ts) checks GameMode there, and has a
   * helper loaded with the other set stopped first.
   */
  beforeCall: (() => Promise<void>) | null = null;
  /** Who hears the call_youtube events (voice-youtube.ts). */
  private youtubeListeners = new Set<
    (event: Record<string, unknown>) => void
  >();

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
    this.idleMs = idleExitMs(config);
    this.lowGpu = config.low_gpu ?? null;
    this.kokoroOnly = !config.tts_models || onlyKokoro(config.tts_models);
    this.touch(helper);
    void (async () => {
      for await (const frame of helper.frames) {
        this.touch(helper);
        if (frame.kind !== FRAME_JSON) continue;
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(new TextDecoder().decode(frame.payload));
        } catch {
          continue;
        }
        if (reply.event === "speak_progress") {
          const timed =
            typeof reply.id === "number"
              ? this.speakTimes.get(reply.id)
              : undefined;
          if (timed && reply.stage === "started") timed.startedAt ??= now();
          if (timed && reply.stage === "audio") timed.audioAt ??= now();
          this.speakProgress(helper, String(reply.stage ?? ""));
          continue;
        }
        if (typeof reply.event === "string") {
          // A video's events go to the YouTube player, not to the call's
          // page (voice-youtube.ts).
          if (reply.event === "call_youtube") {
            for (const listener of this.youtubeListeners) listener(reply);
            continue;
          }
          if (typeof reply.call === "number") {
            const call = this.calls.get(reply.call);
            if (call && reply.event === "call_music") {
              call.waiting = reply.waiting === true;
              call.told = true;
            }
            call?.event(reply as CallEvent);
            continue;
          }
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
      this.restart(helper, "unreadable");
    });
    void helper.exited.then(() => {
      if (this.process === helper) {
        this.process = null;
        this.clearIdle();
      }
      this.warm.clear();
      this.progress = { reports: false, ready: false, loading: false };
      // A call goes on: its mix is made again, under the same number,
      // before the sentences that waited are said again (speakRequest).
      // One whose start was not answered fails with it, never made again.
      const stopping = this.stopping;
      this.stopping = false;
      const calls = [...this.calls];
      const waiting = [...this.pending.values()];
      this.pending.clear();
      const going = calls.filter(([, call]) => call.started);
      if (!stopping && going.length) this.callsBack = this.restartCalls(going);
      for (const pending of waiting)
        pending.reject(new Error("The voice helper stopped"));
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
      if (stopping)
        for (const [id, call] of calls) {
          this.calls.delete(id);
          call.event({
            event: "call_ended",
            call: id,
            error: "The voice helper stopped",
          });
        }
    });
    return helper;
  }

  /**
   * Restarts `helper`, if it is still the one running: killed, it starts
   * again with what goes on (restartCalls), and the sentences it had not
   * said are said again (speakRequest).
   */
  private restart(
    helper: VoiceHelperProcess,
    why: "stuck" | "unreadable" | "models",
  ) {
    if (this.process !== helper) return;
    this.restarts += 1;
    this.restartedFor = why;
    if (why === "stuck") {
      this.kokoroUntil = Date.now() + KOKORO_AFTER_STUCK_MS;
      void this.sampleStuck(helper).finally(() => helper.kill());
    } else helper.kill();
  }

  /** An event goes to its session; one without (the helper failing) to all. */
  private dispatch(event: VoiceEvent) {
    if (event.event === "final" && event.voice !== undefined) {
      const voice = parseVoiceTag(event.voice);
      this.speakers.observe(voice);
      // The prints stay here: the page gets the rest, and sends it back.
      if (voice) event.voice = withoutPrints(voice);
      else delete event.voice;
    }
    if (typeof event.session === "number") {
      this.listeners.get(event.session)?.onEvent(event);
      return;
    }
    for (const listener of [...this.listeners.values()])
      listener.onEvent(event);
  }

  /**
   * Whether `helper` answers a ping within `ms`: its output is read. True
   * too when it exits meanwhile (nothing left to tell).
   */
  private answers(helper: VoiceHelperProcess, ms: number): Promise<boolean> {
    if (this.process !== helper) return Promise.resolve(true);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.pending.set(id, { resolve: done, reject: done });
      helper.write(
        encodeFrame(
          FRAME_JSON,
          new TextEncoder().encode(JSON.stringify({ op: "ping", id })),
        ),
      );
    });
  }

  private send(message: Record<string, unknown>) {
    const helper = this.start();
    helper.write(
      encodeFrame(
        FRAME_JSON,
        new TextEncoder().encode(JSON.stringify(message)),
      ),
    );
    this.touch(helper);
  }

  private request(
    message: Record<string, unknown>,
    onId?: (id: number) => void,
  ): Promise<Record<string, unknown>> {
    const helper = this.start();
    const id = this.nextId++;
    onId?.(id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      helper.write(
        encodeFrame(
          FRAME_JSON,
          new TextEncoder().encode(JSON.stringify({ ...message, id })),
        ),
      );
      this.touch(helper);
    });
  }

  /**
   * Something went to or came from `helper`: its idle time
   * (helper_idle_exit_minutes) starts again.
   */
  private touch(helper: VoiceHelperProcess) {
    if (!this.idleMs || this.process !== helper) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idleExit(helper), this.idleMs);
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Nothing went to or came from `helper` for helper_idle_exit_minutes: it
   * stops, giving back what its models hold, unless a call, a listening or
   * a request still needs it. The next voice request starts it again.
   */
  private idleExit(helper: VoiceHelperProcess) {
    this.idleTimer = null;
    if (this.process !== helper) return;
    if (
      this.calls.size ||
      this.listeners.size ||
      this.speaking ||
      this.pending.size
    ) {
      this.touch(helper);
      return;
    }
    console.error(
      `[voice] nothing for the voice helper in ${this.idleMs / 60_000} min: stopping it until the next voice request`,
    );
    this.stop();
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
    // A new call knows the user by the prints kept of them only.
    const user = options.newSpeaker
      ? this.speakers.keptUser()
      : this.speakers.user();
    this.send({
      op: "listen_start",
      session: id,
      hold: options.hold ?? false,
      ...(options.language ? { language: options.language } : {}),
      ...(options.endSilenceMs ? { end_silence_ms: options.endSilenceMs } : {}),
      ...(options.newSpeaker ? { new_speaker: true } : {}),
      ...(options.call !== undefined ? { call: options.call } : {}),
      // So another voice does not cut a reply (voice-speakers.ts).
      ...(user ? { user_voice: user } : {}),
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
    const reply = await this.speakRequest(text, language, models, rate);
    return {
      audio: Buffer.from(String(reply.audio ?? ""), "base64"),
      language: String(reply.language ?? ""),
      nativeRate: reply.nativeRate,
    };
  }

  /**
   * Speaks `text` into call `call`'s mix (startCall) instead of a file:
   * answers where it is in the call's mix once it is all made.
   */
  async speakInCall(
    call: number,
    text: string,
    language?: string,
    models?: VoiceConfig["tts_models"],
    rate?: number,
  ): Promise<QueuedSpeech> {
    const reply = await this.speakRequest(text, language, models, rate, call);
    if (reply.queued !== true) throw new Error("The voice helper sent a file");
    return {
      queued: true,
      startMs: Number(reply.start_ms ?? 0),
      durationMs: Number(reply.duration_ms ?? 0),
      nowMs: Number(reply.now_ms ?? 0),
      language: String(reply.language ?? ""),
      nativeRate: reply.nativeRate,
    };
  }

  /**
   * Starts a call in the helper: its replies (speakInCall) mixed with
   * `background` (call.rs), sent to the page by WebRTC, and the page's
   * microphone heard by WebRTC. Rejects when the helper cannot (an older
   * one makes no WebRTC call): the page then plays each sentence itself and
   * streams its microphone on the voice socket. A new call ends the one
   * before.
   */
  async startCall(
    background: CallBackground,
    onEvent: (event: CallEvent) => void,
  ): Promise<CallHandle> {
    const id = this.nextCall++;
    for (const [other, call] of [...this.calls]) {
      this.calls.delete(other);
      call.event({ event: "call_error", call: other, error: "Replaced" });
    }
    try {
      await this.beforeCall?.();
    } catch (error) {
      console.error(
        `[voice] before call ${id}: ${(error as Error).message}, the call starts as it is`,
      );
    }
    const entry: RunningCall = {
      event: onEvent,
      background,
      port: 0,
      started: false,
      waiting: false,
      told: false,
      hushes: 0,
    };
    this.calls.set(id, entry);
    let reply: Record<string, unknown>;
    try {
      reply = await this.request({ op: "call_start", call: id, ...background });
    } catch (error) {
      if (this.calls.get(id) === entry) this.calls.delete(id);
      throw error;
    }
    if (typeof reply.signalling_port !== "number") {
      this.calls.delete(id);
      if (this.process) this.send({ op: "call_stop", call: id });
      throw new Error("This voice helper makes no WebRTC call");
    }
    entry.port = reply.signalling_port;
    entry.started = true;
    if (!entry.told) entry.waiting = reply.waiting === true;
    const music = reply.music === true;
    return {
      id,
      signallingPort: () => this.calls.get(id)?.port ?? 0,
      microphone: async (peer, echo = "page") => {
        if (!this.calls.has(id)) throw new Error(`no call ${id}`);
        await this.request({
          op: "call_microphone",
          call: id,
          peer,
          ...(echo === "here" ? { echo } : {}),
        });
      },
      music,
      // A helper restarted makes the call again as call_music left it.
      musicOn: () =>
        music &&
        (this.calls.get(id)?.background.muted ?? background.muted) !== true,
      musicWaiting: () =>
        music &&
        this.calls.get(id)?.waiting === true &&
        this.calls.get(id)?.background.muted !== true,
      hush: () => {
        const call = this.calls.get(id);
        if (call) call.hushes += 1;
        if (call && this.process) this.send({ op: "call_hush", call: id });
      },
      music_level: async (change) => {
        const answer = await this.request({
          op: "call_music",
          call: id,
          ...change,
        });
        const now = {
          volume: Number(answer.volume ?? 0),
          muted: answer.muted === true,
        };
        // A helper restarted makes the call again as it is now.
        const call = this.calls.get(id);
        if (call) call.background = { ...call.background, ...now };
        return now;
      },
      stop: () => {
        if (!this.calls.delete(id)) return;
        if (this.process) this.send({ op: "call_stop", call: id });
      },
    };
  }

  /** The call the helper runs now, started: the one YouTube plays in. */
  private runningCall(): number | undefined {
    let running: number | undefined;
    for (const [id, call] of this.calls) if (call.started) running = id;
    return running;
  }

  /** Whether a call runs: YouTube plays only in one. */
  inCall(): boolean {
    return this.runningCall() !== undefined;
  }

  /**
   * A call_youtube request (voice-youtube.ts) to the call running, its
   * music put on first with `musicOn` (a video asked for is to be heard).
   * Rejects with "no call" without one, and with the helper's "unknown op
   * call_youtube" when it is older than YouTube.
   */
  async callYoutube(
    command: Record<string, unknown>,
    musicOn = false,
  ): Promise<Record<string, unknown>> {
    const id = this.runningCall();
    if (id === undefined) throw new Error("no call");
    const call = this.calls.get(id)!;
    if (musicOn && call.background.muted) {
      const answer = await this.request({
        op: "call_music",
        call: id,
        muted: false,
      });
      // A helper restarted makes the call again as it is now.
      call.background = {
        ...call.background,
        volume: Number(answer.volume ?? call.background.volume),
        muted: answer.muted === true,
      };
    }
    return this.request({ ...command, op: "call_youtube", call: id });
  }

  /** Listens to the helper's call_youtube events; answers how to stop. */
  onYoutube(listener: (event: Record<string, unknown>) => void): () => void {
    this.youtubeListeners.add(listener);
    return () => this.youtubeListeners.delete(listener);
  }

  private async speakRequest(
    text: string,
    language?: string,
    models?: VoiceConfig["tts_models"],
    rate?: number,
    call?: number,
    retried = false,
  ): Promise<Record<string, unknown> & { nativeRate: number }> {
    // Started first: its rate is the one this speech is made at.
    const helper = this.start();
    // A speaker got stuck or failed lately: Kokoro reads meanwhile, for a
    // reader's voice too (the GPU's speaker is what fails).
    const kokoro = this.kokoroModels(language);
    if (kokoro && !onlyKokoro(models) && Date.now() < this.kokoroUntil)
      models = kokoro;
    // A low-GPU helper reads with its own voice only: a voice chosen in
    // Voices would load its model (Qwen3-TTS) on the GPU.
    if (models && this.lowGpu !== null) models = undefined;
    // Kokoro reads a language with that language's voice: one it has none
    // for would be read with another's accent, so a notice says so.
    if (!retried && (models ? onlyKokoro(models) : this.kokoroOnly)) {
      const missing = kokoroCannotRead(text, language);
      if (missing) {
        console.error(
          `[voice] no Kokoro voice reads ${missing}: a notice is read in place of a sentence (${text.length} chars)`,
        );
        text = cannotReadNotice(missing);
        language = "en";
      }
    }
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
    // What makes a sentence cold: its voice, and a call's mix, not used
    // yet by this helper.
    const key = `${override ? JSON.stringify(override) : "default"}|${call ?? "file"}`;
    this.speakQueue.push(key);
    this.speaking += 1;
    if (this.speaking === 1) this.watchSpeaking();
    // Once: a sentence said again is queued again under its own key.
    let queued = true;
    const dequeue = () => {
      if (queued) this.dequeue(key);
      queued = false;
    };
    const restarts = this.restarts;
    const hushes = call === undefined ? 0 : this.calls.get(call)?.hushes;
    // Its speaker failed: Kokoro says it, and the next ones for a short
    // while, the speaker tried again after it (GPU memory comes back).
    const byKokoro = (why: string) => {
      if (retried || this.restarts !== restarts || !kokoro) return null;
      if (onlyKokoro(models)) return null;
      const where = call === undefined ? "" : ` in call ${call}`;
      console.error(
        `[voice] a sentence ${why}${where}: Kokoro says it again now, and the next ones for ${KOKORO_AFTER_FAILURE_MS / 1000} s`,
      );
      this.kokoroUntil = Math.max(
        this.kokoroUntil,
        Date.now() + KOKORO_AFTER_FAILURE_MS,
      );
      dequeue();
      return this.speakRequest(text, language, kokoro, rate, call, true);
    };
    let reply: Record<string, unknown>;
    let silent = false;
    const timed: SpeakTimes = { sentAt: now() };
    let timedId: number | null = null;
    try {
      reply = await this.request(
        {
          op: "speak",
          text,
          ...(language ? { language } : {}),
          ...(override ? { tts_models: JSON.stringify(override) } : {}),
          ...(tempo === 1 ? {} : { rate: tempo }),
          ...(call === undefined ? {} : { call }),
        },
        (id) => {
          timedId = id;
          this.speakTimes.set(id, timed);
        },
      );
      if (this.process === helper) this.warm.add(key);
      // Each sentence's times (debug): how long its first audio took.
      const doneAt = now();
      speechLog.debug("voice sentence spoken", {
        in_call: call !== undefined,
        chars: text.length,
        queued_ms:
          timed.startedAt === undefined
            ? undefined
            : Math.round(timed.startedAt - timed.sentAt),
        first_audio_ms:
          timed.audioAt === undefined
            ? undefined
            : Math.round(timed.audioAt - timed.sentAt),
        total_ms: Math.round(doneAt - timed.sentAt),
        duration_ms:
          typeof reply.duration_ms === "number"
            ? Math.round(reply.duration_ms)
            : undefined,
      });
      // Queued but with no audio, not hushed: its speaker failed without
      // saying so (an older helper answers Qwen3-TTS out of GPU memory
      // so), and the call hears nothing of it.
      silent =
        reply.queued === true &&
        reply.duration_ms === 0 &&
        call !== undefined &&
        this.calls.get(call)?.hushes === hushes;
    } catch (error) {
      // The helper was restarted under it: said again by the new one, in
      // order, into the call's mix once it is made again. With Kokoro when
      // its speaker got stuck; as it was when its output was unreadable.
      const stuck = this.restartedFor === "stuck";
      if (!retried && this.restarts !== restarts && (!stuck || kokoro)) {
        dequeue();
        await this.callsBack;
        return this.speakRequest(
          text,
          language,
          stuck ? kokoro : models,
          rate,
          call,
          true,
        );
      }
      const message = (error as Error).message;
      const where = call === undefined ? "" : ` in call ${call}`;
      // Its speaker failed (Qwen3-TTS out of GPU memory once, every reply
      // of a call unsaid).
      const again = speakerFailed(message)
        ? byKokoro(`failed (${message})`)
        : null;
      if (again) return await again;
      console.error(`[voice] a sentence was not said${where}: ${message}`);
      throw error;
    } finally {
      dequeue();
      if (timedId !== null) this.speakTimes.delete(timedId);
    }
    if (silent) {
      const again = byKokoro(`came out silent (${text.length} chars)`);
      if (again) return again;
      console.error(
        `[voice] call ${call}: a sentence came out silent (${text.length} chars)`,
      );
    }
    const made =
      typeof reply.rate === "number" && reply.rate > 0 ? reply.rate : 1;
    return {
      ...reply,
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

  /**
   * voice.json's models changed (voice-setup.ts): a helper doing nothing
   * stops now, so the next voice request starts one with them. One still
   * needed (a call, a listening, speech) is left to finish: "after-call".
   */
  reloadModels(): "now" | "after-call" | "not-running" {
    if (!this.process) return "not-running";
    if (
      this.calls.size ||
      this.listeners.size ||
      this.speaking ||
      this.pending.size
    )
      return "after-call";
    this.stop();
    return "now";
  }

  /**
   * reloadModels, and the helper it stopped waited for (WRAPPED_EXIT_MS at
   * most): a new one started before the old one ended would have its
   * requests and calls ended with the old one.
   */
  async reloadModelsAndWait(): Promise<"now" | "after-call" | "not-running"> {
    const old = this.process;
    const result = this.reloadModels();
    if (result === "now" && old) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        old.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, WRAPPED_EXIT_MS + 1000);
        }),
      ]);
      clearTimeout(timer);
    }
    return result;
  }

  /**
   * Restarts the helper now, a call or a listening going on: it starts
   * again with voice.json's models as they are now, its calls made again
   * (restartCalls), its sentences said again. False when none runs.
   */
  restartModels(): boolean {
    if (!this.process) return false;
    this.restart(this.process, "models");
    return true;
  }

  /**
   * The running helper's models: "low-gpu" (voice-low-gpu.ts) or "full",
   * null when none runs.
   */
  runningProfile(): "low-gpu" | "full" | null {
    if (!this.process) return null;
    return this.lowGpu === null ? "full" : "low-gpu";
  }

  /** Who asked for the running helper's low-GPU set, null without one. */
  lowGpuReason(): string | null {
    return this.process ? this.lowGpu : null;
  }

  /** The call running now, started, if any. */
  currentCallId(): number | undefined {
    return this.runningCall();
  }

  stop() {
    if (this.process) this.stopping = true;
    this.clearIdle();
    this.process?.kill();
    this.process = null;
  }

  /** A speak request answered (or failed): the watch goes on with the next. */
  private dequeue(key: string) {
    const at = this.speakQueue.indexOf(key);
    if (at < 0) return;
    this.speakQueue.splice(at, 1);
    this.speaking = Math.max(0, this.speaking - 1);
    this.watchSpeaking();
  }

  /**
   * The calls of a helper that stopped, made again in a new one under
   * their numbers, each with its new signalling server: the page's WebRTC
   * sessions start again on it (told `call_restarted`), with the music,
   * the replies said there.
   */
  private async restartCalls(calls: [number, RunningCall][]) {
    for (const [id, call] of calls) {
      if (this.calls.get(id) !== call) continue;
      let port = 0;
      let failed = "it gives no signalling";
      try {
        const reply = await this.request({
          op: "call_start",
          call: id,
          ...call.background,
        });
        if (typeof reply.signalling_port === "number")
          port = reply.signalling_port;
      } catch (error) {
        failed = (error as Error).message;
      }
      if (this.calls.get(id) !== call) {
        // Stopped while it was made again: not left running in the helper.
        if (port && this.process) this.send({ op: "call_stop", call: id });
        continue;
      }
      if (!port) {
        // Not made again: over, not left as a call nobody can reach.
        this.calls.delete(id);
        console.error(`[voice] call ${id}: not made again: ${failed}`);
        call.event({
          event: "call_ended",
          call: id,
          error: `The voice helper stopped: ${failed}`,
        });
        continue;
      }
      call.port = port;
      console.error(`[voice] call ${id}: made again in the restarted helper`);
      call.event({ event: "call_restarted", call: id });
    }
  }

  /**
   * voice.json's Kokoro entries of `tts_models`, if any, each with the
   * voice of `language` when it names none.
   */
  private kokoroModels(language?: string): VoiceConfig["tts_models"] {
    const config = this.config();
    if ("error" in config) return undefined;
    const kokoro = config.tts_models?.filter(
      (entry) => entry.model === "kokoro",
    );
    if (!kokoro?.length || kokoro.length === config.tts_models?.length)
      return undefined;
    // No Kokoro voice for the language: nothing to fall back on.
    if (language && kokoroCannotRead("", language)) return undefined;
    const voice = language ? KOKORO_VOICES[language] : undefined;
    if (!voice) return kokoro;
    return kokoro.map((entry) =>
      entry.voice === undefined && entry.speaker === undefined
        ? { ...entry, voice }
        : entry,
    );
  }

  /**
   * The helper reads one sentence at a time: while some wait, an answer
   * must come within SPEAK_STUCK_MS of the last one (SPEAK_COLD_MS before
   * its first, which loads the model). Past it, a ping tells why. Answered
   * within PING_MS, its speaker is stuck (a hung Qwen3-TTS pipeline once
   * silenced a whole call): the helper is restarted, the waiting sentences
   * are said again with Kokoro, which reads for KOKORO_AFTER_STUCK_MS. Not
   * answered, it is its output that is not read (its answers were lost):
   * restarted, the sentences are said again as they were.
   */
  /**
   * The helper's speaker moves on (voice/helper/src/main.rs): ready (its
   * models loaded), a request started, a voice loading, its first audio.
   * The watch starts again from each, as an answer.
   */
  private speakProgress(helper: VoiceHelperProcess, stage: string) {
    if (this.process !== helper) return;
    this.progress = {
      reports: true,
      ready: this.progress.ready || stage === "ready",
      loading: stage === "loading",
    };
    this.watchSpeaking();
  }

  /**
   * How long the sentence being made may go without progress: SPEAK_COLD_MS
   * while a model loads (a helper that reports progress says when; one that
   * does not, the first sentence with a voice or into a call), SPEAK_STUCK_MS
   * otherwise.
   */
  private speakWait(): number {
    const { reports, ready, loading } = this.progress;
    if (reports) return ready && !loading ? SPEAK_STUCK_MS : SPEAK_COLD_MS;
    const head = this.speakQueue[0];
    return head && this.warm.has(head) ? SPEAK_STUCK_MS : SPEAK_COLD_MS;
  }

  private watchSpeaking() {
    if (this.speakWatch) clearTimeout(this.speakWatch);
    this.speakWatch = null;
    const arm = ++this.watchArms;
    if (this.speaking === 0) return;
    const helper = this.process;
    const wait = this.speakWait();
    this.speakWatch = setTimeout(() => {
      this.speakWatch = null;
      if (this.speaking === 0 || !helper || this.process !== helper) return;
      void this.answers(helper, PING_MS).then((answered) => {
        // Progress or an answer came meanwhile: the watch went on.
        if (this.watchArms !== arm || this.speaking === 0) return;
        if (this.process !== helper) return;
        if (answered)
          console.error(
            `[voice] the voice helper made no speech in ${wait / 1000} s: restarting it, Kokoro reads meanwhile`,
          );
        else
          console.error(
            `[voice] the voice helper answered no ping in ${PING_MS / 1000} s while a sentence waited ${wait / 1000} s: its output is unreadable, restarting it`,
          );
        this.restart(helper, answered ? "stuck" : "unreadable");
      });
    }, wait);
  }

  /**
   * What a stuck helper's threads do, kept before it is stopped (macOS's
   * `sample`, 3 s): voice-hang-<time>.txt in VOICE_HANG_DIR. Not elsewhere.
   */
  private async sampleStuck(helper: VoiceHelperProcess) {
    if (process.platform !== "darwin" || !helper.pid || !this.sampleHangs)
      return;
    try {
      const dir = voiceHangDir();
      mkdirSync(dir, { recursive: true });
      const file = join(
        dir,
        `voice-hang-${new Date().toISOString().replaceAll(":", "-")}.txt`,
      );
      const sample = Bun.spawn(
        ["/usr/bin/sample", String(helper.pid), "3", "-file", file],
        { stdout: "ignore", stderr: "ignore" },
      );
      await Promise.race([
        sample.exited,
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      console.error(`[voice] the stuck helper's threads: ${file}`);
    } catch (error) {
      console.error(
        `[voice] sampling the stuck helper failed: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Where a stuck voice helper's samples go: ROAMGATE_VOICE_HANG_DIR, or
 * ~/Library/Logs/roamgate-voice.
 */
export function voiceHangDir(): string {
  return (
    process.env.ROAMGATE_VOICE_HANG_DIR ||
    join(homedir(), "Library", "Logs", "roamgate-voice")
  );
}

/**
 * The longest a sentence may take to be made before the helper is taken as
 * stuck (Qwen3-TTS makes speech about twice as fast as it plays).
 */
export const SPEAK_STUCK_MS = 15_000;
/**
 * The same for the first sentence with a voice, or into a call's mix, in a
 * helper: its model's loading included (Qwen3-TTS: 15 to 20 s).
 */
export const SPEAK_COLD_MS = 45_000;
/** How long Kokoro reads after a stuck speaker was restarted. */
export const KOKORO_AFTER_STUCK_MS = 5 * 60_000;
/**
 * How long Kokoro reads after a sentence its speaker failed (Qwen3-TTS out
 * of GPU memory): short, the user's own voice back once memory is.
 */
export const KOKORO_AFTER_FAILURE_MS = 30_000;

export { KOKORO_VOICES } from "./voice-kokoro-language";

/**
 * Whether a sentence's error is its speaker's (a model failing to make it),
 * not a call over, nothing to say, or the helper gone.
 */
export function speakerFailed(message: string): boolean {
  return !/^(no call|nothing to say|The voice helper stopped)/.test(message);
}

/** Whether `models` are Kokoro's only (none: the configured ones). */
function onlyKokoro(models: VoiceConfig["tts_models"]): boolean {
  return models?.every((entry) => entry.model === "kokoro") === true;
}
