import type { HistoryEntry } from "./components/agentHistory";
import { roamgateLocalStorage } from "./browserStorage";
import {
  DEFAULT_SPEECH_RATE,
  isSpeechRate,
  playbackRateFor,
} from "../../shared/speechRate";
import { marked, type Token, type Tokens } from "marked";
import { markdownToSpeech } from "./markdownToSpeech";
import { highlightReading } from "./readingHighlight";
import { speechPlayback } from "./speechPlayback";

/** Sent with voice requests; the server refuses them without it. */
const VOICE_HEADERS = { "x-roamgate-voice": "1" };

export type VoiceAvailability = {
  available: boolean;
  detail?: string;
  /** The server logs what pages report of their reading (voiceTrace). */
  debug?: boolean;
  /** How fast replies are read (shared/speechRate.ts). */
  speech_rate?: number;
  /** The server decides who each thing said is for (voiceRoute.ts). */
  route?: boolean;
};

let tracing = false;
let routing = false;

/** Whether what is said goes through the server's router first. */
export function voiceRouting() {
  return routing;
}
const traceStart = performance.now();

/** With the server's voice debugging on, a step of reading aloud, logged. */
export function voiceTrace(line: string) {
  if (!tracing) return;
  const at = ((performance.now() - traceStart) / 1000).toFixed(2);
  void fetch("/api/voice/trace", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ line: `${at}s ${line}` }),
  }).catch(() => {});
}

export async function fetchVoiceAvailability(): Promise<VoiceAvailability> {
  try {
    const response = await fetch("/api/voice");
    if (!response.ok) return { available: false, detail: response.statusText };
    const availability = (await response.json()) as VoiceAvailability;
    tracing = availability.debug === true;
    if (isSpeechRate(availability.speech_rate))
      setSpeechRate(availability.speech_rate);
    routing = availability.route === true;
    return availability;
  } catch (error) {
    return { available: false, detail: (error as Error).message };
  }
}

/** This much quiet after speech ends the message: room to think. */
const END_SILENCE_MS = 2500;
/** The level follows the sound over about this long, for the eye. */
const LEVEL_SMOOTHING_MS = 50;
/** What the voice helper listens at. */
const STREAM_RATE = 16_000;
/** Audio is sent in pieces this long. */
const CHUNK_MS = 40;

// Hands the microphone's samples to the page, block by block.
const TAP_WORKLET = `
class RoamgateTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("roamgate-tap", RoamgateTap);
`;
let tapUrl: string | null = null;

/** The band the 16 kHz stream keeps: speech up to here, short of 8 kHz. */
const PASS_HZ = 7_000;
/** How far the low-pass reaches on each side, in 16 kHz samples. */
const REACH = 16;
/** Fractional positions it is made for, for rates not a multiple of 16 kHz. */
const PHASES = 64;

/**
 * Turns the microphone's rate into 16 kHz 16-bit samples, as it streams,
 * through a windowed-sinc low-pass: what is above 8 kHz cannot be kept at
 * 16 kHz, and left in it comes back as noise in the speech band (averaging
 * three samples at 48 kHz, as before, let a 10 kHz "s" through at 6 kHz,
 * only 6 dB down). The output is late by the filter's reach (1 ms).
 */
export class Downsampler {
  private readonly step: number;
  /** Input samples the filter reaches on each side. */
  private readonly reach: number;
  /** The filter for each fractional position, summing to 1. */
  private readonly filters: Float32Array[];
  /** Input not used up yet, from input sample `start` on. */
  private kept = new Float32Array(0);
  private start = 0;
  /** Output samples made so far. */
  private made = 0;

  constructor(rate: number) {
    this.step = rate / STREAM_RATE;
    this.reach = Math.max(1, Math.ceil(REACH * this.step));
    // In cycles per input sample.
    const cutoff = Math.min(PASS_HZ, rate / 2) / rate;
    const width = this.reach + 1;
    this.filters = Array.from({ length: PHASES }, (_, phase) => {
      const filter = new Float32Array(2 * this.reach + 1);
      let sum = 0;
      for (let k = 0; k < filter.length; k += 1) {
        const t = k - this.reach - phase / PHASES;
        const x = 2 * cutoff * t;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const blackman =
          0.42 +
          0.5 * Math.cos((Math.PI * t) / width) +
          0.08 * Math.cos((2 * Math.PI * t) / width);
        filter[k] = sinc * blackman;
        sum += filter[k]!;
      }
      for (let k = 0; k < filter.length; k += 1) filter[k]! /= sum;
      return filter;
    });
  }

  push(block: Float32Array): Int16Array {
    const input = new Float32Array(this.kept.length + block.length);
    input.set(this.kept);
    input.set(block, this.kept.length);
    const end = this.start + input.length;
    const out: number[] = [];
    // Output n is centred `reach` input samples before n * step: it only
    // needs input up to there.
    while (this.made * this.step < end) {
      const centre = this.made * this.step - this.reach;
      let base = Math.floor(centre);
      let phase = Math.round((centre - base) * PHASES);
      if (phase === PHASES) {
        base += 1;
        phase = 0;
      }
      const filter = this.filters[phase]!;
      let sum = 0;
      for (let k = 0; k < filter.length; k += 1) {
        const at = base - this.reach + k - this.start;
        // Before the first sample: silence.
        if (at >= 0) sum += (input[at] ?? 0) * filter[k]!;
      }
      const sample = Math.max(-1, Math.min(1, sum));
      out.push(Math.round(sample * 0x7fff));
      this.made += 1;
    }
    // What the next output needs.
    const next = Math.floor(this.made * this.step - this.reach) - this.reach;
    const from = Math.max(this.start, next);
    this.kept = input.slice(from - this.start);
    this.start = from;
    return Int16Array.from(out);
  }
}

/**
 * What was said. With the server's cleaner, `text` is cleaned, `raw` the
 * words as heard, and `forAgent` false when they were said to someone else.
 */
export type Heard = {
  text: string;
  speechMs: number;
  raw?: string;
  forAgent?: boolean;
};

type VoiceEvent = {
  event: string;
  session?: number;
  text?: string;
  speech_ms?: number;
  error?: string;
  raw?: string;
  for_agent?: boolean;
  /** On a session's error: the helper stopped under it, nothing else. */
  recoverable?: boolean;
};

/**
 * The voice socket of a voice chat: the microphone streams to the voice
 * helper, which says when speech starts and what was said.
 */
export class VoiceLink {
  private listeners = new Set<(event: VoiceEvent) => void>();
  private closed: Error | null = null;
  // The first listening of a voice chat picks whose voice is kept.
  private listened = false;

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      let event: VoiceEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      for (const listener of [...this.listeners]) listener(event);
    };
    socket.onclose = () => {
      this.closed = new Error("The voice connection closed");
      for (const listener of [...this.listeners])
        listener({ event: "error", error: this.closed.message });
    };
  }

  static open(): Promise<VoiceLink> {
    const url = new URL("/api/voice/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.onopen = () => resolve(new VoiceLink(socket));
      socket.onerror = () => reject(new Error("The voice connection failed"));
    });
  }

  close() {
    this.socket.onclose = null;
    this.socket.close();
  }

  private send(message: object | Int16Array<ArrayBuffer>) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      message instanceof Int16Array ? message : JSON.stringify(message),
    );
  }

  /**
   * Listens, for as long as it takes, until the helper says the speaker
   * stopped (a pause of END_SILENCE_MS), or `finish` aborts. While
   * `holding()` is true (a reply playing), only a louder voice counts;
   * `onSpeech` says when it starts. Resolves with what was said, or null
   * when nothing was or `signal` aborted.
   */
  async listen(
    signal: AbortSignal,
    {
      finish,
      onLevel,
      holding,
      onSpeech,
      onSpeechEnd,
      onHeard,
      language,
      conversation,
    }: {
      finish?: AbortSignal;
      onLevel?: (level: number) => void;
      holding?: () => boolean;
      onSpeech?: () => void;
      /** The helper heard the pause: the text comes next. */
      onSpeechEnd?: () => void;
      /** What was heard so far, while it is said. */
      onHeard?: (text: string) => void;
      language?: string | null;
      /** The conversation's end, for cleaning what is said. */
      conversation?: string;
    } = {},
  ): Promise<Heard | null> {
    if (this.closed) throw this.closed;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const context = new AudioContext();
    let listener: ((event: VoiceEvent) => void) | null = null;
    try {
      // A context made after the tap's await may start suspended, hearing
      // nothing.
      await context.resume();
      tapUrl ??= URL.createObjectURL(
        new Blob([TAP_WORKLET], { type: "text/javascript" }),
      );
      await context.audioWorklet.addModule(tapUrl);
      const tap = new AudioWorkletNode(context, "roamgate-tap");
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(stream).connect(tap);
      tap.connect(mute).connect(context.destination);

      let held = holding?.() ?? false;
      let session: number | null = null;
      let heard = false;
      let heardSoFar: HeardSoFar = { text: "", whole: false };
      let level = 0;
      const downsampler = new Downsampler(context.sampleRate);
      let chunk: number[] = [];
      const chunkSamples = (STREAM_RATE * CHUNK_MS) / 1000;

      const result = new Promise<Heard | null>((resolve, reject) => {
        listener = (event) => {
          if (event.event === "listening") {
            session = event.session ?? null;
            return;
          }
          if (event.event === "error") {
            // Another listening's: not this one's.
            if (event.session !== undefined && event.session !== session)
              return;
            // The helper stopped under it, and starts again: it ends with
            // what was heard, and the link goes on.
            if (event.recoverable === true) {
              const text = heardSoFar.text.trim();
              voiceTrace(
                `the voice helper stopped: the utterance ends${text ? ` with what was heard: ${text}` : ""}`,
              );
              resolve(text ? { text, speechMs: 0 } : null);
              return;
            }
            reject(new Error(event.error ?? "Voice failed"));
            return;
          }
          if (session === null || event.session !== session) return;
          if (event.event === "speech_start") {
            heard = true;
            onSpeech?.();
          } else if (event.event === "speech_end") {
            onSpeechEnd?.();
          } else if (event.event === "partial" || event.event === "text") {
            heardSoFar = nextHeard(heardSoFar, event.event, event.text ?? "");
            onHeard?.(heardSoFar.text);
          } else if (event.event === "final") {
            // Speech that came to no text is still speech; no speech is null.
            const text = (event.text ?? "").trim();
            const raw = event.raw?.trim();
            resolve(
              heard || text || raw
                ? {
                    text,
                    speechMs: event.speech_ms ?? 0,
                    ...(raw !== undefined ? { raw } : {}),
                    ...(event.for_agent === false ? { forAgent: false } : {}),
                  }
                : null,
            );
          }
        };
        this.listeners.add(listener);
        const stop = () => {
          this.send({ op: "stop" });
          resolve(null);
        };
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        finish?.addEventListener("abort", () => this.send({ op: "finish" }), {
          once: true,
        });
        tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
          const block = event.data;
          let sum = 0;
          for (const sample of block) sum += sample * sample;
          const weight = Math.min(
            1,
            ((block.length / context.sampleRate) * 1000) / LEVEL_SMOOTHING_MS,
          );
          level += (Math.sqrt(sum / block.length) - level) * weight;
          for (const sample of downsampler.push(block)) chunk.push(sample);
          if (chunk.length >= chunkSamples) {
            this.send(Int16Array.from(chunk));
            chunk = [];
          }
          if (held && !(holding?.() ?? false)) {
            held = false;
            this.send({ op: "release" });
          }
        };
      });
      this.send({
        op: "listen",
        new_speaker: !this.listened,
        hold: held,
        end_silence_ms: END_SILENCE_MS,
        ...(language ? { language } : {}),
        ...(conversation !== undefined ? { context: conversation } : {}),
      });
      this.listened = true;
      // The level is for the eye: once a frame is plenty.
      let shown = true;
      const show = () => {
        if (!shown) return;
        onLevel?.(level);
        requestAnimationFrame(show);
      };
      show();
      try {
        return await result;
      } finally {
        shown = false;
        tap.port.onmessage = null;
      }
    } finally {
      if (listener) this.listeners.delete(listener);
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    }
  }
}

/** What has been heard of an utterance, and whether a partial came. */
export type HeardSoFar = { text: string; whole: boolean };

/**
 * The words heard so far, after a `partial` or `text` event. Parakeet's
 * partials read the whole utterance again each time, and its finished
 * transcription comes as a `text` too: once there was a partial, a text
 * replaces what was heard. Whisper sends no partials, each piece once in a
 * text: those add up.
 */
export function nextHeard(
  soFar: HeardSoFar,
  kind: "partial" | "text",
  text: string,
): HeardSoFar {
  const words = text.trim();
  if (kind === "partial") return { text: words, whole: true };
  if (soFar.whole) return { text: words || soFar.text, whole: true };
  return { text: `${soFar.text} ${words}`.trim(), whole: false };
}

/**
 * Splits text made for speech (markdownToSpeech) into sentences, the pieces
 * spoken one after another.
 */
export function sentences(text: string): string[] {
  return (
    text
      // A mark after a space ends nothing: "src ! sink" is one sentence;
      // an ordered list's "2." and a task's "Completed." start their item's.
      .split(
        /(?<=\S[.!?…])(?<!(?:^|\n)\s*(?:\d{1,3}|Completed|Not completed)\.)\s+|\n+/,
      )
      .map((sentence) => sentence.trim())
      .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
  );
}

/**
 * The agent's answer to the message sent: its messages after the last
 * user message, once it has some.
 */
export function replyEntriesAfter(
  entries: readonly HistoryEntry[],
  sentText: string,
): HistoryEntry[] {
  let start = -1;
  const sent = sentText.trim();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (
      entry.role === "user" &&
      entry.kind === "message" &&
      !entry.queued &&
      // A subagent's report or a task ending is not what was said.
      !entry.injected
    ) {
      if (entry.text.trim().includes(sent) || sent.includes(entry.text.trim()))
        start = index;
      break;
    }
  }
  if (start < 0) return [];
  return entries
    .slice(start + 1)
    .filter(
      (entry) =>
        entry.role === "assistant" &&
        entry.kind === "message" &&
        entry.text.trim(),
    );
}

export function replyAfter(
  entries: readonly HistoryEntry[],
  sentText: string,
): string | null {
  const reply = replyEntriesAfter(entries, sentText)
    .map((entry) => entry.text)
    .join("\n\n")
    .trim();
  return reply || null;
}

let speechRate = DEFAULT_SPEECH_RATE;
const speechRateListeners = new Set<() => void>();
/** What plays now, with the rate each was made at. */
const playing = new Map<HTMLAudioElement, number>();
/** The rate each fetched speech was made at, when not 1. */
const nativeRates = new WeakMap<Blob, number>();

/** How fast replies are read here: the server's, until changed. */
export function getSpeechRate(): number {
  return speechRate;
}

export function subscribeSpeechRate(listener: () => void): () => void {
  speechRateListeners.add(listener);
  return () => speechRateListeners.delete(listener);
}

/** Reads at `rate` from now on, the sentence playing included. */
export function setSpeechRate(rate: number) {
  if (!isSpeechRate(rate) || rate === speechRate) return;
  speechRate = rate;
  for (const [player, native] of playing)
    player.playbackRate = playbackRateFor(rate, native);
  for (const listener of speechRateListeners) listener();
}

// Rates chosen on this page: a server answer from before one is stale.
let rateChoices = 0;
let rateAsked: Promise<void> | null = null;

/**
 * The server's `speech_rate` again, for a reading starting: a speed chosen
 * on another page or device applies here too, the sentence playing
 * included, without reloading.
 */
export function refreshSpeechRate(): Promise<void> {
  rateAsked ??= (async () => {
    const choices = rateChoices;
    try {
      const response = await fetch("/api/voice");
      if (!response.ok) return;
      const { speech_rate: rate } = (await response.json()) as {
        speech_rate?: unknown;
      };
      if (choices === rateChoices && isSpeechRate(rate)) setSpeechRate(rate);
    } catch {
      // Kept as it was.
    } finally {
      rateAsked = null;
    }
  })();
  return rateAsked;
}

/** Reads at `rate` now, and keeps it on the server for every page. */
export async function saveSpeechRate(rate: number): Promise<void> {
  rateChoices += 1;
  setSpeechRate(rate);
  const response = await fetch("/api/voice/settings", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ speech_rate: rate }),
  });
  if (!response.ok) throw new Error(response.statusText);
}

export async function fetchSpeech(
  text: string,
  signal: AbortSignal,
  language?: string,
): Promise<Blob> {
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(language ? { text, language } : { text }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? response.statusText);
  }
  const audio = await response.blob();
  const native = Number(response.headers.get("x-voice-native-rate"));
  if (native > 0 && native !== 1) nativeRates.set(audio, native);
  return audio;
}

/** Seconds of the silence that holds the audio focus. */
const FOCUS_SECONDS = 30;

/**
 * Pauses other apps' audio (music, podcasts) until `signal` aborts: phones
 * give the audio focus to the page while its media plays, and for good
 * only to media longer than 5 seconds that is announced as playing, so
 * near silence loops the whole time: an offset of one in 8 bits, which
 * Chrome measures as sound (all zeros may count as nothing playing) but a
 * steady level makes no click, and speakers do not play it. Must start from
 * a tap.
 */
export function holdAudioFocus(signal: AbortSignal): void {
  if (signal.aborted) return;
  // An 8 kHz, 8-bit mono WAV of silence (128 is the 8-bit zero).
  const rate = 8000;
  const samples = rate * FOCUS_SECONDS;
  const wav = new DataView(new ArrayBuffer(44 + samples));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1)
      wav.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  wav.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate, true);
  wav.setUint16(32, 1, true);
  wav.setUint16(34, 8, true);
  text(36, "data");
  wav.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) wav.setUint8(44 + i, 129);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const silence = new Audio(url);
  silence.loop = true;
  silence.play().catch(() => {});
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Voice chat",
      artist: "Roamgate",
    });
    navigator.mediaSession.playbackState = "playing";
  }
  signal.addEventListener(
    "abort",
    () => {
      silence.pause();
      URL.revokeObjectURL(url);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
    },
    { once: true },
  );
}

function play(audio: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Stopped while it downloaded: an abort listener added now never runs.
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(audio);
    const player = new Audio(url);
    // Faster without sounding higher; set after the load starts, which
    // resets playbackRate to defaultPlaybackRate.
    const native = nativeRates.get(audio) ?? 1;
    player.preservesPitch = true;
    player.defaultPlaybackRate = playbackRateFor(speechRate, native);
    player.playbackRate = player.defaultPlaybackRate;
    playing.set(player, native);
    for (const event of ["playing", "pause", "stalled", "waiting", "ended"])
      player.addEventListener(event, () =>
        voiceTrace(
          `${event} at ${player.currentTime.toFixed(2)}/${player.duration.toFixed(2)}`,
        ),
      );
    const done = () => {
      signal.removeEventListener("abort", stop);
      playing.delete(player);
      player.pause();
      URL.revokeObjectURL(url);
      resolve();
    };
    const stop = () => done();
    signal.addEventListener("abort", stop, { once: true });
    player.onended = done;
    player.onerror = () => {
      voiceTrace(`error ${player.error?.code}: ${player.error?.message}`);
      done();
      reject(new Error("The speech could not be played"));
    };
    player.play().catch((error) => {
      voiceTrace(`play refused: ${error}`);
      done();
      reject(error);
    });
  });
}

/**
 * How sentences become speech: the server's voices (serverVoice) or the
 * browser's (speechEngine.ts). `prepare` makes a sentence's speech while
 * the one before plays; `play` resolves when it is over or `signal` aborts.
 */
export type SentenceVoice<Speech = unknown> = {
  prepare(
    text: string,
    signal: AbortSignal,
    options?: { language?: string },
  ): Promise<Speech>;
  play(speech: Speech, signal: AbortSignal): Promise<void>;
  /** A reading starts (speakWith, speakStream). */
  begin?(): void;
};

/** The server's voice engine: Ogg Opus from /api/voice/speak. */
export const serverVoice: SentenceVoice<Blob> = {
  prepare: (text, signal, options) =>
    fetchSpeech(text, signal, options?.language),
  play,
  // The speed may have changed elsewhere since this page asked.
  begin: () => void refreshSpeechRate(),
};

/**
 * Reads Markdown aloud with `voice`, a sentence at a time, the next one
 * prepared while the current one plays; `onSentence` hears each as it
 * starts, then null. Stops when `signal` aborts. `skip` leaves out its
 * first sentences: a reading going on from where it was cut.
 */
export async function speakWith(
  voice: SentenceVoice,
  text: string,
  signal: AbortSignal,
  onSentence?: (sentence: string | null) => void,
  { skip = 0 }: { skip?: number } = {},
): Promise<void> {
  const parts = sentences(markdownToSpeech(text)).slice(skip);
  if (parts.length) voice.begin?.();
  let next = parts.length ? voice.prepare(parts[0]!, signal) : null;
  voiceTrace(`reading ${parts.length} sentences`);
  signal.addEventListener("abort", () => voiceTrace("reading stopped"), {
    once: true,
  });
  for (
    let index = 0;
    index < parts.length && next && !signal.aborted;
    index += 1
  ) {
    const asked = performance.now();
    const speech = await next;
    voiceTrace(
      `sentence ${index + 1} ready after ${Math.round(performance.now() - asked)} ms: ${parts[index]}`,
    );
    next =
      index + 1 < parts.length
        ? voice.prepare(parts[index + 1]!, signal)
        : null;
    // A failed fetch ahead must not go unhandled while this one plays.
    next?.catch(() => {});
    if (signal.aborted) break;
    onSentence?.(parts[index]!);
    await voice.play(speech, signal);
    voiceTrace(`sentence ${index + 1} done`);
  }
  voiceTrace("reading over");
  onSentence?.(null);
}

/**
 * Whether a paragraph cut at `prefix` leaves no inline markup open (code,
 * emphasis, a link): its sentences then read as they will in the whole.
 */
function closedInline(prefix: string): boolean {
  const count = (pattern: RegExp) => (prefix.match(pattern) ?? []).length;
  return (
    count(/`/g) % 2 === 0 &&
    count(/\*\*/g) % 2 === 0 &&
    count(/~~/g) % 2 === 0 &&
    count(/(?<!\*)\*(?!\*)/g) % 2 === 0 &&
    // Underscores mark emphasis only around words, not inside names such
    // as forwards_upstream.
    count(/(?<![\p{L}\p{N}_])_|_(?![\p{L}\p{N}_])/gu) % 2 === 0 &&
    count(/\[/g) === count(/\]/g) &&
    count(/\(/g) === count(/\)/g)
  );
}

/** Whether a fenced code block's text has its closing fence. */
function closedFence(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) return false;
  const lines = raw.replace(/\n$/, "").split("\n");
  if (lines.length < 2) return false;
  const fence = open[1]!;
  return new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(
    lines[lines.length - 1]!,
  );
}

/**
 * How much of `raw`, the last block of the text so far, is complete: all
 * of it once nothing can be added to it (followed by a blank line, a heading's
 * line ended, a code block's fence closed), a list's items but the last,
 * and a paragraph's sentences that ended; 0 for a table or code block still
 * being written.
 */
function completeLength(token: Token, raw: string, blankAfter: boolean) {
  if (token.type === "code")
    return closedFence(raw) || (blankAfter && !/^ {0,3}(`|~){3}/.test(raw))
      ? raw.length
      : 0;
  if (blankAfter) return raw.length;
  switch (token.type) {
    case "heading":
    case "hr":
      return raw.endsWith("\n") ? raw.length : 0;
    case "list": {
      const items = (token as Tokens.List).items;
      return items
        .slice(0, -1)
        .reduce((length, item) => length + item.raw.length, 0);
    }
    case "paragraph": {
      // A line starting with "|" may be a table's: it is not cut into.
      const table = /^\s*\|/m.exec(raw);
      const text = table ? raw.slice(0, table.index) : raw;
      let end = 0;
      for (const match of text.matchAll(/\S[.!?…]["')\]]*\s+/g)) {
        const at = match.index + match[0].length;
        if (closedInline(text.slice(0, at))) end = at;
      }
      return end;
    }
    default:
      return 0;
  }
}

/**
 * Markdown as it is written, a piece at a time, in sentences worth hearing,
 * cleaned as a whole reply is (markdownToSpeech): each block once it is
 * complete (a paragraph or list item that ended, a code block once its
 * fence closes, announced then, a table once something follows it), and in
 * a paragraph still being written, the sentences that ended. A sentence is
 * given once, never twice.
 */
export class SpeakableStream {
  private pending = "";

  /** The sentences that `chunk` completes. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const cut = this.completeEnd();
    if (cut <= 0) return [];
    const head = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return speakableSentences(head);
  }

  /** What is left, at the end of the turn. */
  flush(): string[] {
    const rest = this.pending;
    this.pending = "";
    return speakableSentences(rest);
  }

  /** Where the text so far is complete: what follows may still change. */
  private completeEnd(): number {
    const tokens = marked.lexer(this.pending, { gfm: true, breaks: true });
    let last = tokens.length - 1;
    while (last >= 0 && tokens[last]!.type === "space") last -= 1;
    if (last < 0) return 0;
    let offset = 0;
    for (let index = 0; index < last; index += 1)
      offset += tokens[index]!.raw.length;
    const token = tokens[last]!;
    return offset + completeLength(token, token.raw, last < tokens.length - 1);
  }
}

function speakableSentences(markdown: string): string[] {
  return sentences(markdownToSpeech(markdown));
}

/**
 * Reads text that is still being written: each sentence as soon as it ends,
 * the next ones fetched while one plays. `source` gives the text in pieces
 * and ends with the reply; `onSentence` hears each as it starts, then null.
 * Stops when `signal` aborts. `skip` leaves out its first sentences: a
 * reading going on from where it was cut.
 */
export async function speakStream(
  source: AsyncIterable<string>,
  signal: AbortSignal,
  onSentence: ((sentence: string | null) => void) | undefined,
  options: {
    prefetch?: number;
    skip?: number;
    /** What makes each sentence speech and plays it (speechEngine.ts). */
    voice: SentenceVoice;
  },
): Promise<void> {
  const prefetch = Math.max(1, options.prefetch ?? 2);
  const { voice } = options;
  voice.begin?.();
  const splitter = new SpeakableStream();
  const queue: { text: string; audio: Promise<unknown> }[] = [];
  const waiting: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  // Fetches ahead: up to `prefetch` sentences beyond the one playing.
  const fill = () => {
    while (waiting.length && queue.length < prefetch && !signal.aborted) {
      const text = waiting.shift()!;
      const audio = voice.prepare(text, signal);
      // Failed ahead: reported when its turn comes.
      audio.catch(() => {});
      queue.push({ text, audio });
    }
  };
  let skip = Math.max(0, options.skip ?? 0);
  const take = (given: string[]) => {
    const list = given.slice(skip);
    skip -= given.length - list.length;
    if (!list.length) return;
    waiting.push(...list);
    fill();
    poke();
  };
  const reading = (async () => {
    try {
      for await (const chunk of source) {
        if (signal.aborted) break;
        take(splitter.push(chunk));
      }
      take(splitter.flush());
    } finally {
      ended = true;
      poke();
    }
  })();
  reading.catch(() => {});
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  try {
    while (!signal.aborted) {
      const next = queue.shift();
      if (!next) {
        if (ended && !waiting.length) break;
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          aborted,
        ]);
        fill();
        continue;
      }
      fill();
      const audio = await next.audio;
      if (signal.aborted) break;
      voiceTrace(`streamed sentence: ${next.text}`);
      onSentence?.(next.text);
      await voice.play(audio, signal);
    }
  } finally {
    onSentence?.(null);
  }
  if (!signal.aborted) await reading;
}

// One voice at a time: whatever reads aloud claims the speaker, which stops
// the reading before it, from a message's button or voice chat, and the
// browser's own reading of a message (speechPlayback).
let speakerOwner: AbortController | null = null;

export function claimSpeaker(owner: AbortController) {
  if (speakerOwner !== owner && speakerOwner && !speakerOwner.signal.aborted)
    voiceTrace("the speaker goes to another reading");
  if (speakerOwner !== owner) {
    speakerOwner?.abort();
    speechPlayback.stop();
  }
  speakerOwner = owner;
}

/** Silences whatever is reading aloud. */
export function stopSpeaker() {
  if (speakerOwner && !speakerOwner.signal.aborted)
    voiceTrace("the speaker is silenced");
  speakerOwner?.abort();
  speakerOwner = null;
  speechPlayback.stop();
}

// Rewinds made from this browser, counted: an answer awaited from before
// one is not read (its turn may be rewound away).
let rewinds = 0;

/** How many rewinds this browser made: see noteRewind. */
export function rewindCount(): number {
  return rewinds;
}

/**
 * A rewind takes messages out of the conversation: nothing goes on reading
 * them (a message's button, voice chat's reading, the highlight), and an
 * answer voice chat awaits from before it is not read.
 */
export function noteRewind() {
  rewinds += 1;
  voiceTrace("a rewind silences the speaker");
  stopReading();
  stopSpeaker();
  highlightReading([], null);
}

// One message read aloud at a time, from its read button.
type Reading = {
  id: string;
  controller: AbortController;
  sentence: string | null;
  done: Promise<void>;
};
let reading: Reading | null = null;
const readingListeners = new Set<() => void>();
const notifyReading = () => {
  for (const listener of readingListeners) listener();
};

export function subscribeReading(listener: () => void): () => void {
  readingListeners.add(listener);
  return () => readingListeners.delete(listener);
}

/** The message being read aloud, if any. */
export function readingId(): string | null {
  return reading?.id ?? null;
}

/**
 * The message reading aloud from its read button, for voice chat to listen
 * over rather than silence: speaking up stops it.
 */
export function ongoingReading(): {
  stop: () => void;
  sentence: () => string | null;
  done: Promise<void>;
} | null {
  const current = reading;
  if (!current || current.controller.signal.aborted) return null;
  return {
    stop: () => current.controller.abort(),
    sentence: () => current.sentence,
    done: current.done,
  };
}

/** Stops the message read aloud from its button: `id`'s, or any. */
export function stopReading(id?: string) {
  if (!reading || (id !== undefined && reading.id !== id)) return;
  reading.controller.abort();
}

/**
 * Reads a message aloud with `voice`, or stops it when it is the one being
 * read.
 */
export function toggleReading(
  id: string,
  text: string,
  onError: (message: string) => void,
  voice: SentenceVoice,
) {
  const current = reading;
  current?.controller.abort();
  reading = null;
  notifyReading();
  if (current?.id === id) return;
  const controller = new AbortController();
  claimSpeaker(controller);
  const mine: Reading = {
    id,
    controller,
    sentence: null,
    done: Promise.resolve(),
  };
  reading = mine;
  notifyReading();
  mine.done = speakWith(voice, text, controller.signal, (sentence) => {
    mine.sentence = sentence ?? mine.sentence;
    if (reading === mine) highlightReading([id], sentence);
  })
    .catch((error) => {
      if (!controller.signal.aborted)
        onError(error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (reading === mine) {
        highlightReading([], null);
        reading = null;
        notifyReading();
      }
    });
}

// A message sent by voice says so, and where the reading was cut short, so
// the agent knows it talks live and what was heard: `[Voice] text`, or
// `[Voice, interrupted you at: "sentence"] text`.
const VOICE_NOTE = /^\[Voice(?:, interrupted you at: ("(?:[^"\\]|\\.)*"))?\] /;

export function voiceMessage(
  text: string,
  interruptedAt?: string | null,
): string {
  return interruptedAt
    ? `[Voice, interrupted you at: ${JSON.stringify(interruptedAt)}] ${text}`
    : `[Voice] ${text}`;
}

/** How much of the conversation's end goes with what is said. */
const CONTEXT_CHARS = 3000;

/** The conversation's last messages, as the voice cleaner reads them. */
export function conversationContext(entries: readonly HistoryEntry[]): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "message" || !entry.text.trim() || entry.injected)
      continue;
    const text =
      entry.role === "user" ? parseVoiceMessage(entry.text).text : entry.text;
    const line = `${entry.role === "user" ? "User" : "Agent"}: ${text.trim()}`;
    lines.unshift(line);
    length += line.length;
    if (length >= CONTEXT_CHARS) break;
  }
  return lines.join("\n\n").slice(-CONTEXT_CHARS);
}

const HEARD_AS_KEY = "roamgate.voice.heardAs";
const HEARD_AS_KEPT = 200;

/** Keeps the words as heard of a cleaned message, to show them later. */
export function rememberHeardAs(text: string, raw: string) {
  if (!raw || raw === text) return;
  try {
    const kept = JSON.parse(
      roamgateLocalStorage.getItem(HEARD_AS_KEY) ?? "[]",
    ) as [string, string][];
    kept.push([text, raw]);
    roamgateLocalStorage.setItem(
      HEARD_AS_KEY,
      JSON.stringify(kept.slice(-HEARD_AS_KEPT)),
    );
  } catch {
    // Without storage, the words as heard are not kept.
  }
}

/** The words as heard of a cleaned message, if this browser kept them. */
export function heardAs(text: string): string | null {
  try {
    const kept = JSON.parse(
      roamgateLocalStorage.getItem(HEARD_AS_KEY) ?? "[]",
    ) as [string, string][];
    const wanted = text.trim();
    for (let index = kept.length - 1; index >= 0; index -= 1)
      if (kept[index]![0].trim() === wanted) return kept[index]![1];
    return null;
  } catch {
    return null;
  }
}

/** A message's text without its voice note, and what the note said. */
export function parseVoiceMessage(text: string): {
  text: string;
  voice: boolean;
  interruptedAt: string | null;
} {
  const match = VOICE_NOTE.exec(text);
  if (!match) return { text, voice: false, interruptedAt: null };
  let interruptedAt: string | null;
  try {
    interruptedAt = match[1] ? (JSON.parse(match[1]) as string) : null;
  } catch {
    interruptedAt = null;
  }
  return { text: text.slice(match[0].length), voice: true, interruptedAt };
}

// Saying only this ends voice chat, as its button does.
const STOP_WORDS = new Set([
  "stop",
  "stop listening",
  "stop voice",
  "stop voice mode",
  "stop voice chat",
  "arrête",
  "arrete",
  "arrête toi",
  "arrête d'écouter",
  "stop écoute",
  "para",
  "basta",
  "detente",
  "deja de escuchar",
]);
const STOP_BEFORE = /^(?:ok(?:ay)?|bon|vale|alright|right)\s+/;
const STOP_AFTER = /\s+(?:please|s'il te plaît|s'il te plait|por favor)$/;

/** Whether what was said is only a request to end voice chat. */
export function isStopCommand(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}'\s-]/gu, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(STOP_BEFORE, "")
    .replace(STOP_AFTER, "");
  return STOP_WORDS.has(words);
}
