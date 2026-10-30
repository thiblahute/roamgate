import type { HistoryEntry } from "./components/agentHistory";
import { roamgateLocalStorage } from "./browserStorage";
import {
  DEFAULT_SPEECH_RATE,
  isSpeechRate,
  playbackRateFor,
} from "../../shared/speechRate";
import { highlightReading } from "./readingHighlight";

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

/** Turns the microphone's rate into 16 kHz 16-bit samples, as it streams. */
export class Downsampler {
  private carried: number[] = [];
  private position = 0;

  constructor(private readonly rate: number) {}

  push(block: Float32Array): Int16Array {
    const step = this.rate / STREAM_RATE;
    const input = this.carried.length
      ? Float32Array.from([...this.carried, ...block])
      : block;
    const out: number[] = [];
    // Each output sample averages the input ones it covers.
    while (Math.floor(this.position + step) <= input.length) {
      const from = Math.floor(this.position);
      const to = Math.max(from + 1, Math.floor(this.position + step));
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += input[i] ?? 0;
      const sample = Math.max(-1, Math.min(1, sum / (to - from)));
      out.push(Math.round(sample * 0x7fff));
      this.position += step;
    }
    const used = Math.floor(this.position);
    this.carried = Array.from(input.subarray(used));
    this.position -= used;
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

/**
 * What of an agent's markdown reply is worth hearing: prose, without code
 * blocks, tables, links' addresses or markup.
 */
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

export function speakableText(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/^\s*\|.*\|\s*$/gm, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      .replace(/(\*\*|\*|~~)(?=\S)([^*~]+?)\1/g, "$2")
      // Underscores mark emphasis only around words, not inside names such
      // as forwards_upstream.
      .replace(
        /(?<![\p{L}\p{N}_])(__|_)(?=\S)([^_]+?)\1(?![\p{L}\p{N}_])/gu,
        "$2",
      )
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

/** Splits text into sentences, the pieces spoken one after another. */
export function sentences(text: string): string[] {
  return (
    text
      // A mark after a space ends nothing: "src ! sink" is one sentence.
      .split(/(?<=\S[.!?…])\s+|\n+/)
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

/** Reads at `rate` now, and keeps it on the server for every page. */
export async function saveSpeechRate(rate: number): Promise<void> {
  setSpeechRate(rate);
  const response = await fetch("/api/voice/settings", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ speech_rate: rate }),
  });
  if (!response.ok) throw new Error(response.statusText);
}

async function fetchSpeech(text: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ text }),
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
 * Reads text aloud a sentence at a time, the next one prepared while the
 * current one plays; `onSentence` hears each as it starts, then null.
 * Stops when `signal` aborts.
 */
export async function speak(
  text: string,
  signal: AbortSignal,
  onSentence?: (sentence: string | null) => void,
): Promise<void> {
  const parts = sentences(speakableText(text));
  let next = parts.length ? fetchSpeech(parts[0]!, signal) : null;
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
    const audio = await next;
    voiceTrace(
      `sentence ${index + 1} ready after ${Math.round(performance.now() - asked)} ms, ${audio.size} bytes: ${parts[index]}`,
    );
    next =
      index + 1 < parts.length ? fetchSpeech(parts[index + 1]!, signal) : null;
    // A failed fetch ahead must not go unhandled while this one plays.
    next?.catch(() => {});
    if (signal.aborted) break;
    onSentence?.(parts[index]!);
    await play(audio, signal);
    voiceTrace(`sentence ${index + 1} done`);
  }
  voiceTrace("reading over");
  onSentence?.(null);
}

/** Markers a sentence cut out of its markdown may keep: not read out. */
function strayMarkup(sentence: string): string {
  return sentence
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|\s)[*_](?=\S)/g, "$1")
    .replace(/(\S)[*_](?=\s|$)/g, "$1")
    .trim();
}

/**
 * Markdown as it is written, a piece at a time, in sentences worth hearing:
 * a sentence is given once it has ended, never twice. A code block is held
 * until it closes (then left out, as speakableText does), and a table row
 * until its line ends.
 */
export class SpeakableStream {
  private pending = "";

  /** The sentences that `chunk` completes. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const cut = this.safeCut();
    if (cut <= 0) return [];
    const head = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return speakableSentences(head);
  }

  /** What is left, at the end of a block or of the turn. */
  flush(): string[] {
    const rest = this.pending;
    this.pending = "";
    return speakableSentences(rest);
  }

  /** Where the text may be cut now: after a sentence or line that ended. */
  private safeCut(): number {
    let text = this.pending;
    // An open code fence: everything from it waits for its end.
    const fences = [...text.matchAll(/^\s{0,3}```/gm)];
    if (fences.length % 2 === 1)
      text = text.slice(0, fences[fences.length - 1]!.index);
    let cut = 0;
    const lineEnd = text.lastIndexOf("\n");
    if (lineEnd >= 0) cut = lineEnd + 1;
    // In the last line, after its last ended sentence, unless the line is a
    // table row: that is cut at its end only.
    const line = text.slice(cut);
    if (!/^\s*\|/.test(line)) {
      let end = -1;
      for (const match of line.matchAll(/\S[.!?…]["')\]]*\s+/g))
        end = match.index + match[0].length;
      if (end > 0) cut += end;
    }
    return cut;
  }
}

function speakableSentences(markdown: string): string[] {
  return sentences(speakableText(markdown))
    .map(strayMarkup)
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
}

/**
 * Reads text that is still being written: each sentence as soon as it ends,
 * the next ones fetched while one plays. `source` gives the text in pieces
 * and ends with the reply; `onSentence` hears each as it starts, then null.
 * Stops when `signal` aborts.
 */
export async function speakStream(
  source: AsyncIterable<string>,
  signal: AbortSignal,
  onSentence?: (sentence: string | null) => void,
  options: {
    prefetch?: number;
    fetchAudio?: (text: string, signal: AbortSignal) => Promise<Blob>;
    playAudio?: (audio: Blob, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<void> {
  const prefetch = Math.max(1, options.prefetch ?? 2);
  const fetchAudio = options.fetchAudio ?? fetchSpeech;
  const playAudio = options.playAudio ?? play;
  const splitter = new SpeakableStream();
  const queue: { text: string; audio: Promise<Blob> }[] = [];
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
      const audio = fetchAudio(text, signal);
      // Failed ahead: reported when its turn comes.
      audio.catch(() => {});
      queue.push({ text, audio });
    }
  };
  const take = (list: string[]) => {
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
      await playAudio(audio, signal);
    }
  } finally {
    onSentence?.(null);
  }
  if (!signal.aborted) await reading;
}

// One voice at a time: whatever reads aloud claims the speaker, which stops
// the reading before it, from a message's button or voice chat.
let speakerOwner: AbortController | null = null;

export function claimSpeaker(owner: AbortController) {
  if (speakerOwner !== owner && speakerOwner && !speakerOwner.signal.aborted)
    voiceTrace("the speaker goes to another reading");
  if (speakerOwner !== owner) speakerOwner?.abort();
  speakerOwner = owner;
}

/** Silences whatever is reading aloud. */
export function stopSpeaker() {
  if (speakerOwner && !speakerOwner.signal.aborted)
    voiceTrace("the speaker is silenced");
  speakerOwner?.abort();
  speakerOwner = null;
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

/** Reads a message aloud, or stops it when it is the one being read. */
export function toggleReading(
  id: string,
  text: string,
  onError: (message: string) => void,
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
  mine.done = speak(text, controller.signal, (sentence) => {
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
