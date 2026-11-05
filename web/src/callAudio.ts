/**
 * A voice call's audio as one stream (voice.json's `call_background`,
 * server/src/http/voice-socket.ts): the voice helper mixes the replies and
 * the music, and sends the mix as Opus packets on the voice socket. They
 * are decoded here with WebCodecs and played by an AudioWorklet in the
 * call's AudioContext (48 kHz, voiceOutput.ts), so the phone's echo
 * cancellation hears the music as it hears the replies.
 *
 * The worklet keeps a jitter buffer (CallJitter): 200 ms before it plays,
 * up to 2 s while it plays, so the network's bursts are absorbed rather
 * than cut. The difference between the Mac's clock and the phone's, or a
 * level left off its target by a stall, is made up by playing up to 1%
 * faster or slower, changed smoothly (a sixth of a semitone at most); the
 * stream is converted to the context's rate when the phone does not run
 * at 48 kHz. Only past 2 s of backlog do whole 10 ms blocks go, the
 * quietest near the head. An underrun plays silence and buffers again.
 *
 * Replies asked for during such a call go into the mix (POST
 * /api/voice/speak with `call`) and come back as where they are in the
 * stream (`start_ms`, `duration_ms`): a sentence "plays" until the stream
 * gets past its end, and stopping it drops what the helper still had to
 * send of it (`call_hush`).
 */

import type { ChannelEvent } from "./voiceChannel";

/** The stream's rate, the call's context's too. */
export const CALL_RATE = 48_000;
/** A block: what is dropped or repeated, 10 ms. */
export const BLOCK_FRAMES = 480;

type Block = { samples: Float32Array; ptsMs: number; energy: number };

/**
 * The jitter buffer, as a plain class: the worklet gets its source
 * (CALL_WORKLET), the tests use it directly. Samples are interleaved stereo
 * at `rate`; `pull` plays them at the context's rate.
 *
 * Bursts are absorbed by the buffer (up to `maxMs`): nothing is thrown away
 * for them. The difference between the Mac's clock and the phone's, or a
 * level that stays off its target after a stall, is made up by playing up
 * to 1% faster or slower, smoothly, never by cutting: only past `maxMs`
 * (seconds of backlog) do whole blocks go.
 */
export class CallJitter {
  // Assigned in the constructor, never as class fields: the worklet gets
  // this class's source, which must need no helper of the build's.
  declare blocks: Block[];
  /** Where in the head block it plays, in frames (fractional). */
  declare offset: number;
  declare playing: boolean;
  declare dropped: number;
  declare repeated: number;
  declare underruns: number;
  declare targetMs: number;
  declare minMs: number;
  declare maxMs: number;
  declare rate: number;
  /** The buffer's level over the last seconds (ms): what drift shows in. */
  declare averageMs: number;
  /** The pace now: 1 plays as made. */
  declare pace: number;
  /** How far from its target the level may be before the pace adjusts. */
  declare deadbandMs: number;
  /** The most the pace changes: 1%, a sixth of a semitone at most. */
  declare maxPace: number;

  constructor(targetMs = 200, minMs = 60, maxMs = 2000, rate = 48_000) {
    this.averageMs = targetMs;
    this.pace = 1;
    this.deadbandMs = 60;
    this.maxPace = 0.01;
    this.blocks = [];
    this.offset = 0;
    this.playing = false;
    this.dropped = 0;
    this.repeated = 0;
    this.underruns = 0;
    this.targetMs = targetMs;
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.rate = rate;
  }

  bufferedMs(): number {
    let frames = -this.offset;
    for (const block of this.blocks) frames += block.samples.length / 2;
    return (frames * 1000) / this.rate;
  }

  /** Where the stream is heard now, in its own time (ms); null before. */
  positionMs(): number | null {
    const head = this.blocks[0];
    if (!head || !this.playing) return null;
    return head.ptsMs + (this.offset * 1000) / this.rate;
  }

  reset() {
    this.blocks = [];
    this.offset = 0;
    this.playing = false;
    this.pace = 1;
  }

  /** Decoded audio from `ptsMs` on. */
  push(samples: Float32Array, ptsMs: number) {
    const block = 2 * 480;
    for (let at = 0; at < samples.length; at += block) {
      const part = samples.slice(at, Math.min(samples.length, at + block));
      let energy = 0;
      for (let i = 0; i < part.length; i += 1) energy += part[i]! * part[i]!;
      this.blocks.push({
        samples: part,
        ptsMs: ptsMs + (at / 2 / this.rate) * 1000,
        energy: energy / part.length,
      });
    }
    // Seconds behind: the quietest block near the head goes.
    while (this.bufferedMs() > this.maxMs && this.blocks.length > 2) {
      this.blocks.splice(this.quietest(), 1);
      this.dropped += 1;
    }
  }

  /** The quietest block of those soon to play, past the head. */
  quietest(): number {
    let best = 1;
    const last = Math.min(this.blocks.length - 1, 25);
    for (let i = 2; i <= last; i += 1)
      if (this.blocks[i]!.energy < this.blocks[best]!.energy) best = i;
    return best;
  }

  /** Frames available from the head on, the one played now included. */
  available(): number {
    let frames = -Math.floor(this.offset);
    for (const block of this.blocks) frames += block.samples.length / 2;
    return frames;
  }

  /**
   * `frames` frames to play at `outRate`, interleaved: silence while
   * buffering. Played at the stream's own pace, but for the 1% at most
   * that keeps the buffer near its target.
   */
  pull(frames: number, outRate = this.rate): Float32Array {
    const out = new Float32Array(frames * 2);
    if (!this.playing) {
      if (this.bufferedMs() < this.targetMs) return out;
      this.playing = true;
      this.averageMs = this.bufferedMs();
    }
    // Over about 2 s: a network hiccup is not drift.
    this.averageMs +=
      ((this.bufferedMs() - this.averageMs) * frames) / (2 * outRate);
    const off = this.averageMs - this.targetMs;
    const wanted =
      Math.abs(off) <= this.deadbandMs
        ? 1
        : 1 +
          Math.max(
            -this.maxPace,
            Math.min(
              this.maxPace,
              (off - Math.sign(off) * this.deadbandMs) / 20_000,
            ),
          );
    // Smoothly: the pace moves a little each render quantum.
    this.pace += (wanted - this.pace) * 0.05;
    if (Math.abs(this.pace - 1) < 1e-5 && wanted === 1) this.pace = 1;
    const step = (this.rate / outRate) * this.pace;
    for (let i = 0; i < frames; i += 1) {
      let head = this.blocks[0];
      // Past the head block: on to the next.
      while (head && this.offset >= head.samples.length / 2) {
        this.offset -= head.samples.length / 2;
        this.blocks.shift();
        head = this.blocks[0];
      }
      const whole = Math.floor(this.offset);
      const t = this.offset - whole;
      if (!head || (t > 0 && this.available() < 2)) {
        // Ran dry: silence, and buffer again.
        this.underruns += 1;
        this.playing = false;
        this.offset = 0;
        return out;
      }
      const length = head.samples.length / 2;
      const left0 = head.samples[whole * 2]!;
      const right0 = head.samples[whole * 2 + 1]!;
      if (t === 0) {
        out[i * 2] = left0;
        out[i * 2 + 1] = right0;
      } else {
        const next = whole + 1 < length ? head : this.blocks[1]!;
        const at = whole + 1 < length ? whole + 1 : 0;
        out[i * 2] = left0 + (next.samples[at * 2]! - left0) * t;
        out[i * 2 + 1] = right0 + (next.samples[at * 2 + 1]! - right0) * t;
      }
      this.offset += step;
    }
    // The head played out exactly: on to the next.
    const head = this.blocks[0];
    if (head && this.offset >= head.samples.length / 2) {
      this.offset -= head.samples.length / 2;
      this.blocks.shift();
    }
    return out;
  }
}

/** The worklet: CallJitter fed from the page, played as stereo. */
export const CALL_WORKLET = `
const CallJitter = ${CallJitter.toString()};
class RoamgateCallOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jitter = new CallJitter();
    this.reported = 0;
    this.pulled = 0;
    this.pushed = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.reset) this.jitter.reset();
      else {
        this.pushed += data.samples.length / 2;
        this.jitter.push(data.samples, data.ptsMs);
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;
    const samples = this.jitter.pull(frames, sampleRate);
    const left = output[0];
    const right = output[1] || output[0];
    for (let i = 0; i < frames; i += 1) {
      left[i] = samples[2 * i];
      right[i] = samples[2 * i + 1];
    }
    this.reported += frames;
    this.pulled += frames;
    if (this.reported >= 2400) {
      this.reported = 0;
      this.port.postMessage({
        positionMs: this.jitter.positionMs(),
        bufferedMs: this.jitter.bufferedMs(),
        dropped: this.jitter.dropped,
        repeated: this.jitter.repeated,
        underruns: this.jitter.underruns,
        pulled: this.pulled,
        pushed: this.pushed,
        rate: sampleRate,
      });
    }
    return true;
  }
}
registerProcessor("roamgate-call-output", RoamgateCallOutput);
`;

/** A sentence put into the call's mix (POST /api/voice/speak). */
export type QueuedSpeech = {
  queued: true;
  call: number;
  start_ms: number;
  duration_ms: number;
  native_rate?: number;
  language?: string;
};

export function isQueuedSpeech(value: unknown): value is QueuedSpeech {
  const speech = value as QueuedSpeech | null;
  return (
    !!speech &&
    speech.queued === true &&
    typeof speech.call === "number" &&
    typeof speech.start_ms === "number" &&
    typeof speech.duration_ms === "number"
  );
}

/** A header and an Opus packet, as the voice socket sends them. */
export function parseCallPacket(
  data: ArrayBuffer,
): { seq: number; ptsUs: number; packet: Uint8Array } | null {
  if (data.byteLength < 13) return null;
  const view = new DataView(data);
  return {
    seq: view.getUint32(0, true),
    ptsUs: Number(view.getBigUint64(4, true)),
    packet: new Uint8Array(data, 12),
  };
}

/** What CallAudio needs of the voice channel (voiceChannel.ts). */
export type CallChannel = {
  send(message: object): void;
  listen(listener: (event: ChannelEvent) => void): () => unknown;
  binary(listener: (data: ArrayBuffer) => void): () => unknown;
};

/** What the worklet reports, about every 50 ms. */
type JitterReport = {
  positionMs: number | null;
  bufferedMs: number;
  dropped: number;
  repeated: number;
  underruns: number;
  /** Frames the worklet played and was given, at its context's rate. */
  pulled: number;
  pushed: number;
  rate: number;
};

/** The stream heard now: the worklet's last report, moved on since. */
type Position = { positionMs: number | null; at: number };

/** How long a call's audio may take to start before the page goes on. */
const START_MS = 5000;
/** How long a call let go by its link waits for a rebuilt chat's link. */
export const RELEASE_MS = 5000;
/** Past a queued sentence's end with no stream, it is taken as over. */
const STALLED_MS = 3000;

let active: CallAudio | null = null;

/** The call audio playing now, if any: replies go into its mix. */
export function activeCallAudio(): CallAudio | null {
  return active;
}

/**
 * The call's stream on `channel`, played in `context`: null when the
 * server or this browser cannot (no background set, an older helper, no
 * WebCodecs Opus), and the page plays each sentence itself as before.
 */
export class CallAudio {
  private position: Position = { positionMs: null, at: 0 };
  private waiters = new Set<() => void>();
  private stopped = false;
  private unlisten: (() => unknown)[] = [];
  /** Let go by its link: stopped unless another one takes it meanwhile. */
  private releasing: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    readonly id: number,
    readonly music: boolean,
    /** The link it comes on; a rebuilt chat's new link takes it over. */
    private channel: CallChannel,
    /** What the server asks to resume the call on another socket. */
    private readonly resume: string,
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly decoder: AudioDecoder,
    private readonly trace: (line: string) => void,
  ) {}

  static async start(
    channel: CallChannel,
    context: AudioContext,
    trace: (line: string) => void = () => {},
  ): Promise<CallAudio | null> {
    if (typeof AudioDecoder !== "function") {
      trace("call audio: no WebCodecs here, each sentence plays by itself");
      return null;
    }
    const supported = await AudioDecoder.isConfigSupported({
      codec: "opus",
      sampleRate: CALL_RATE,
      numberOfChannels: 2,
    }).catch(() => null);
    if (!supported?.supported) {
      trace("call audio: no Opus decoder here");
      return null;
    }
    const answer = await new Promise<ChannelEvent | null>((resolve) => {
      const timer = setTimeout(() => done(null), START_MS);
      const stop = channel.listen((event) => {
        if (event.event === "call_audio" && !event.resumed) done(event);
      });
      const done = (event: ChannelEvent | null) => {
        clearTimeout(timer);
        stop();
        resolve(event);
      };
      channel.send({ op: "call_audio", on: true });
    });
    if (!answer || typeof answer.call !== "number") {
      trace(
        `call audio: not used (${answer ? String(answer.error) : "no answer"}), each sentence plays by itself`,
      );
      return null;
    }
    const url = URL.createObjectURL(
      new Blob([CALL_WORKLET], { type: "text/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(context, "roamgate-call-output", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(context.destination);
    const holder: { audio: CallAudio | null } = { audio: null };
    const decoder = new AudioDecoder({
      output: (data) => holder.audio?.decoded(data),
      error: (error) => trace(`call audio: decoding failed: ${error}`),
    });
    decoder.configure({
      codec: "opus",
      sampleRate: CALL_RATE,
      numberOfChannels: 2,
    });
    const audio = new CallAudio(
      answer.call,
      answer.music === true,
      channel,
      String(answer.resume ?? ""),
      context,
      node,
      decoder,
      trace,
    );
    holder.audio = audio;
    audio.listen();
    active = audio;
    trace(
      `call audio: ${audio.music ? "music and replies" : "replies"} as one stream (call ${audio.id})`,
    );
    return audio;
  }

  private listen() {
    this.node.port.onmessage = (event) => {
      const report = event.data as JitterReport;
      this.position = { positionMs: report.positionMs, at: performance.now() };
      this.reportJitter(report);
      for (const waiter of [...this.waiters]) waiter();
    };
    this.unlisten.push(
      this.channel.binary((data) => {
        const packet = parseCallPacket(data);
        if (!packet || this.stopped || this.decoder.state !== "configured")
          return;
        this.decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: packet.ptsUs,
            data: packet.packet,
          }),
        );
      }),
      this.channel.listen((event) => {
        if (event.event === "call_audio" && event.resumed === true) {
          // Back after a lost socket: what was missed is gone, the
          // buffer starts again.
          this.node.port.postMessage({ reset: true });
          this.trace("call audio: back after the connection came back");
        } else if (event.event === "call_error")
          this.trace(`call audio: ${String(event.error)}`);
        else if (
          event.event === "call_audio" &&
          event.error &&
          event.call === this.id
        ) {
          this.trace(`call audio ended: ${String(event.error)}`);
          this.stop();
        }
      }),
    );
  }

  /**
   * Underruns (gaps), drops and repeats (clicks) are what a listener hears
   * of the network and the clocks: traced as they happen, at most every 5 s.
   */
  private reportJitter(report: JitterReport) {
    const seen = this.jitterSeen;
    const now = performance.now();
    if (
      report.underruns === seen.underruns &&
      report.dropped === seen.dropped &&
      report.repeated === seen.repeated
    )
      return;
    if (now - seen.at < 5000) return;
    // Played and received per second: the context's rate, and the Mac's,
    // unless the audio thread or the network stalls.
    const seconds = (now - seen.at) / 1000;
    const per = (frames: number) =>
      seen.at ? `${Math.round(frames / seconds)}/s` : "?";
    this.trace(
      `call audio: ${report.underruns - seen.underruns} underruns, ${report.dropped - seen.dropped} blocks dropped, ${report.repeated - seen.repeated} repeated, ${Math.round(report.bufferedMs)} ms buffered; context ${report.rate} Hz, played ${per(report.pulled - seen.pulled)}, received ${per(report.pushed - seen.pushed)}`,
    );
    this.jitterSeen = { ...report, at: now };
  }

  private jitterSeen = {
    underruns: 0,
    dropped: 0,
    repeated: 0,
    pulled: 0,
    pushed: 0,
    at: 0,
  };

  private decoded(data: AudioData) {
    const frames = data.numberOfFrames;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    data.copyTo(left, { planeIndex: 0, format: "f32-planar" });
    if (data.numberOfChannels > 1)
      data.copyTo(right, { planeIndex: 1, format: "f32-planar" });
    else right.set(left);
    const samples = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      samples[2 * i] = left[i]!;
      samples[2 * i + 1] = right[i]!;
    }
    const ptsMs = data.timestamp / 1000;
    data.close();
    this.node.port.postMessage({ samples, ptsMs }, [samples.buffer]);
  }

  /** Where the stream is heard now, in its time (ms); null before. */
  positionMs(): number | null {
    const { positionMs, at } = this.position;
    return positionMs === null ? null : positionMs + (performance.now() - at);
  }

  /** The voice the helper still had to send goes (the user talks). */
  hush() {
    if (!this.stopped) this.channel.send({ op: "call_hush" });
  }

  /**
   * Plays a queued sentence: resolves once the stream got past its end,
   * or `signal` aborts (the voice still queued is then dropped).
   */
  playQueued(speech: QueuedSpeech, signal: AbortSignal): Promise<void> {
    const end = speech.start_ms + speech.duration_ms;
    const askedAt = performance.now();
    const startedAt = this.positionMs();
    this.trace(
      `call audio: sentence at ${Math.round(speech.start_ms)} ms for ${Math.round(speech.duration_ms)} ms, the stream is at ${startedAt === null ? "nothing yet" : `${Math.round(startedAt)} ms`}`,
    );
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.waiters.delete(check);
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const check = () => {
        const now = this.positionMs();
        if (this.stopped || (now !== null && now >= end)) return finish();
        // No stream: over by the time it would have been.
        const due = end - (startedAt ?? speech.start_ms) + STALLED_MS;
        if (performance.now() - askedAt > due) {
          this.trace("call audio: no stream, the sentence is taken as heard");
          finish();
        }
      };
      const abort = () => {
        const now = this.positionMs();
        if (now === null || now < end) this.hush();
        finish();
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.add(check);
      const timer = setInterval(check, 100);
      check();
    });
  }

  /**
   * A chat rebuilt opens a new link (VoiceLink): the call goes on on it
   * (`call_resume`), with no new call and no gap but what the switch takes.
   * False when it cannot (another context, the call over): a new call then.
   */
  async adopt(channel: CallChannel, context: AudioContext): Promise<boolean> {
    if (this.stopped || context !== this.context || !this.resume) return false;
    if (this.releasing) clearTimeout(this.releasing);
    this.releasing = null;
    if (channel === this.channel) return true;
    const answer = await new Promise<ChannelEvent | null>((resolve) => {
      const timer = setTimeout(() => done(null), START_MS);
      const stop = channel.listen((event) => {
        if (event.event === "call_audio" && event.call === this.id) done(event);
      });
      const done = (event: ChannelEvent | null) => {
        clearTimeout(timer);
        stop();
        resolve(event);
      };
      channel.send({ op: "call_resume", call: this.id, resume: this.resume });
    });
    if (this.stopped) return false;
    if (answer?.resumed !== true) {
      this.trace(
        `call audio: not moved to the new link (${answer ? String(answer.error) : "no answer"})`,
      );
      this.stop();
      return false;
    }
    for (const stop of this.unlisten.splice(0)) stop();
    this.channel = channel;
    this.listen();
    this.trace(
      `call audio: call ${this.id} goes on on the rebuilt chat's link`,
    );
    return true;
  }

  /**
   * Its link closes: stopped after RELEASE_MS unless a new link took it
   * (adopt), as a chat being rebuilt does.
   */
  release(channel: CallChannel) {
    if (this.stopped || channel !== this.channel || this.releasing) return;
    this.releasing = setTimeout(() => {
      this.releasing = null;
      this.stop();
    }, RELEASE_MS);
  }

  stop() {
    if (this.releasing) clearTimeout(this.releasing);
    this.releasing = null;
    if (this.stopped) return;
    this.stopped = true;
    if (active === this) active = null;
    for (const stop of this.unlisten.splice(0)) stop();
    for (const waiter of [...this.waiters]) waiter();
    this.channel.send({ op: "call_audio", on: false });
    try {
      this.decoder.close();
    } catch {
      // Closed already.
    }
    this.node.port.onmessage = null;
    this.node.disconnect();
  }
}
