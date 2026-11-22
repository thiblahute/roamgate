import type { HistoryEntry } from "./components/agentHistory";
import { parseVoiceMessage } from "../../shared/voiceMessage";
import { roamgateWrite } from "../../shared/toolSummary";
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
import { setVoiceFronting, voiceFronting } from "./voiceFrontFlag";
import { noteCompanionEpoch } from "./companionMemory";
import {
  activeCall,
  activeMicrophoneConstraints,
  type CallOptions,
  callInApp,
  isQueuedSpeech,
  type QueuedSpeech,
  WebRtcCall,
} from "./webrtcCall";
import { VoiceChannel } from "./voiceChannel";
import {
  guardPlayback,
  mediaControlPause,
  mediaControlPlay,
  noteOwnPlay,
  readingPlays,
  resetMediaControls,
  subscribeReadings,
} from "./playbackGuard";
import {
  holdVoiceContext,
  playInContext,
  tapsLoaded,
  voiceContext,
  voiceContextHeld,
  voiceOutputLatency,
  voiceOutputMode,
} from "./voiceOutput";

export { parseVoiceMessage, voiceMessage } from "../../shared/voiceMessage";

/** Sent with voice requests; the server refuses them without it. */
const VOICE_HEADERS = { "x-roamgate-voice": "1" };

export type VoiceAvailability = {
  available: boolean;
  detail?: string;
  /**
   * The server did not answer (a network error, or an error status such as
   * a 502 while it restarts): `available` says nothing of its voice engine.
   */
  unreachable?: true;
  /** The server logs what pages report of their reading (voiceTrace). */
  debug?: boolean;
  /** How fast replies are read (shared/speechRate.ts). */
  speech_rate?: number;
  /**
   * The longest pause, in ms, before a turn that sounded finished ends
   * (server/src/http/voice-socket.ts).
   */
  max_pause_ms?: number;
  /** The server decides who each thing said is for (voiceRoute.ts). */
  route?: boolean;
  /** A front answers what is said first, in that decision (voiceFront.ts). */
  front?: boolean;
  /**
   * With a front, what it does with the agents' answers (voiceCompanion.ts):
   * tells them ("companion") or has them read whole ("relay").
   */
  front_mode?: "companion" | "relay";
  /** Bumped by each reset of the companion's memory. */
  companion_epoch?: number;
  /**
   * Whether each reply is read by one of the voices at random; absent
   * without a voice library.
   */
  surprise?: boolean;
};

let tracing = false;
let routing = false;
let frontModeSetting: "companion" | "relay" = "companion";
const frontModeListeners = new Set<() => void>();

/** Whether what is said goes through the server's router first. */
export function voiceRouting() {
  return routing;
}

/** Whether a front answers what is said first (voiceFront.ts). */
export { voiceFronting };

/** What the front does with answers (voiceCompanion.ts); null without one. */
export function voiceFrontMode(): "companion" | "relay" | null {
  return voiceFronting() ? frontModeSetting : null;
}

export function subscribeFrontMode(listener: () => void): () => void {
  frontModeListeners.add(listener);
  return () => {
    frontModeListeners.delete(listener);
  };
}

function setFrontMode(mode: "companion" | "relay") {
  frontModeSetting = mode;
  for (const listener of [...frontModeListeners]) listener();
}

/** Keeps what the front does with answers in voice.json. */
export async function saveFrontMode(mode: "companion" | "relay") {
  const response = await fetch("/api/voice/settings", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ front_mode: mode }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? response.statusText);
  }
  setFrontMode(mode);
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

/**
 * A turn's times on the page, for the server's log (debug): from the
 * route asked to its first words heard (`how`: the front's words written
 * early, its reply, a canned ack, or only routed), always sent.
 */
export function voiceTiming(fields: Record<string, string | number>) {
  void fetch("/api/voice/timing", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(fields),
  }).catch(() => {});
}

export async function fetchVoiceAvailability(): Promise<VoiceAvailability> {
  try {
    const response = await fetch("/api/voice");
    if (!response.ok)
      return {
        available: false,
        detail: response.statusText,
        unreachable: true,
      };
    const availability = (await response.json()) as VoiceAvailability;
    tracing = availability.debug === true;
    if (isSpeechRate(availability.speech_rate))
      setSpeechRate(availability.speech_rate);
    if (typeof availability.max_pause_ms === "number")
      setMaxPause(availability.max_pause_ms);
    routing = availability.route === true;
    setVoiceFronting(availability.front === true);
    noteCompanionEpoch(availability.companion_epoch);
    if (
      availability.front_mode === "companion" ||
      availability.front_mode === "relay"
    )
      setFrontMode(availability.front_mode);
    if (typeof availability.surprise === "boolean")
      setVoiceSurprise(availability.surprise, true);
    return availability;
  } catch (error) {
    return {
      available: false,
      detail: (error as Error).message,
      unreachable: true,
    };
  }
}

/** This much quiet after speech ends the message: room to think. */
const END_SILENCE_MS = 2500;
/** The level follows the sound over about this long, for the eye. */
const LEVEL_SMOOTHING_MS = 50;
/** What the voice helper listens at. */
export const STREAM_RATE = 16_000;
/** Audio is sent in pieces this long. */
const CHUNK_MS = 40;

// Hands the microphone's samples to the page, block by block.
export const TAP_WORKLET = `
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
  /**
   * Whose voice it was (the helper's voices, as the server checks them):
   * passed on with the words to the route, which labels them.
   */
  voice?: unknown;
  /** That voice's label ("you 0.58", "voice B, 0.07 like you"). */
  voiceLabel?: string;
};

/** What a listening tells its owner, as it goes. */
export type ListenHooks = {
  onLevel?: (level: number) => void;
  holding?: () => boolean;
  onSpeech?: () => void;
  /** The helper heard the pause: the text comes next. */
  onSpeechEnd?: () => void;
  /** What was heard so far, while it is said. */
  onHeard?: (text: string) => void;
};

/** Whoever waits for a listening's result now. */
type ListenOwner = {
  resolve: (heard: Heard | null) => void;
  reject: (error: unknown) => void;
};

/** A listening in progress: the microphone streaming, what it heard. */
type Live = {
  hooks: ListenHooks;
  owner: ListenOwner | null;
  heard: HeardSoFar;
  ended: boolean;
  /** Its speech started and its end is not heard yet: the user talks. */
  talking: boolean;
  result: Promise<Heard | null>;
  /** Drops it: nothing is sent. */
  stop: () => void;
};

/** A parked listening not taken by then is dropped (voice chat ended). */
const PARK_MS = 10_000;

/**
 * The voice socket of a voice chat: the voice helper says when speech
 * starts and what was said. In a call (webrtcCall.ts) the microphone goes
 * to the helper by WebRTC; without one, it streams on the socket. Its
 * socket comes back by itself after a network change (voiceChannel.ts),
 * the session going on; and a listening in progress can be parked when the
 * chat showing it is rebuilt (a reconnect of the page's own connection
 * does it) and adopted by the one built next, the microphone never
 * stopping (parkVoiceLink).
 */
export class VoiceLink {
  // The first listening of a voice chat picks whose voice is kept.
  private listened = false;
  private live: Live | null = null;
  private parked = false;
  /**
   * Told whenever speech starts, whoever listens: speaking up stops the
   * front's voice (voiceFront.ts) as it stops a reply.
   */
  onAnySpeech: (() => void) | null = null;
  /** Something else plays (the front's voice): only a louder voice counts. */
  alsoHolding: () => boolean = () => false;
  /** Who waits for the utterance under way to end (untilTurnEnds). */
  private turnWaiters = new Set<() => void>();
  /** The microphone and outputs were traced (traceAudioRoute). */
  private routeTraced = false;
  /** The socket came back after it was lost. */
  onReconnected: ((resumed: boolean) => void) | null = null;

  /** The WebRTC call (webrtcCall.ts), when the server makes one. */
  private call: Promise<WebRtcCall | null> | null = null;
  /** Whether that call is made (or failed) already. */
  private callSettled = false;
  /** Whether that call goes to the Roamgate app, this page in its WebView. */
  private callInApp = false;

  private constructor(private readonly channel: VoiceChannel) {}

  /**
   * In a voice chat, a WebRTC call: the replies (mixed with voice.json's
   * `call_background`) come from it, and the microphone goes by it. Without
   * one, replies play as before and the microphone streams on the socket.
   */
  private startCall(options: CallOptions) {
    if (!voiceContextHeld()) return;
    // A chat rebuilt: the call goes on, controlled from this new link.
    const going = activeCall();
    this.call = (
      going
        ? going.adopt(this.channel).then((moved) => (moved ? going : null))
        : Promise.resolve(null)
    )
      .then(
        (moved) =>
          moved ??
          WebRtcCall.start(this.channel, {
            trace: voiceTrace,
            outputLatency: voiceOutputLatency,
            ...options,
          }),
      )
      .catch((error) => {
        voiceTrace(`call failed: ${error}`);
        return null;
      });
    this.callSettled = false;
    this.callInApp = callInApp(options);
    const call = this.call;
    void call.then(() => {
      if (this.call === call) this.callSettled = true;
    });
  }

  /**
   * Let go: stopped unless a rebuilt chat's link takes it (adopt). `done`
   * once it stopped (its end sent on this link's socket) or moved.
   */
  private stopCall(done: () => void) {
    const call = this.call;
    this.call = null;
    if (!call) return done();
    void call.then((started) =>
      started ? started.release(this.channel, done) : done(),
    );
  }

  /** Opens a voice chat's link; `call` stands in for WebRTC in tests. */
  static async open({
    call = {},
  }: {
    call?: CallOptions;
  } = {}): Promise<VoiceLink> {
    const url = new URL("/api/voice/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const holder: { link: VoiceLink | null } = { link: null };
    const channel = await VoiceChannel.open({
      connect: () => new WebSocket(url),
      onReconnected: (resumed) => holder.link?.onReconnected?.(resumed),
      trace: voiceTrace,
    });
    holder.link = new VoiceLink(channel);
    holder.link.startCall(call);
    return holder.link;
  }

  /** Whether a listening is in progress. */
  get listening() {
    return this.live !== null;
  }

  /**
   * Whether the user is in the middle of an utterance: the helper said its
   * speech started (the speaker check passed) and not yet that it ended.
   * Nothing is said over it: a reply waits (untilTurnEnds).
   */
  get talking(): boolean {
    return this.live?.talking === true;
  }

  /**
   * Resolves once no utterance is under way (at once when none is), or
   * when `signal` aborts.
   */
  untilTurnEnds(signal: AbortSignal): Promise<void> {
    if (!this.talking || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.turnWaiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.turnWaiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** An utterance ended, or its listening: whoever waited for it goes on. */
  private turnMoved() {
    if (this.talking) return;
    for (const done of [...this.turnWaiters]) done();
  }

  close() {
    // Parked: whoever adopts it closes it.
    if (this.parked) return;
    // The socket closes once the call let go is over (its end reaching the
    // server) or taken by a rebuilt chat's link.
    this.stopCall(() => this.channel.close());
  }

  /**
   * The listening in progress goes on with no owner: its owner's wait ends
   * with null, and aborting its signal no longer stops it. False when none
   * is in progress.
   */
  park(): boolean {
    const live = this.live;
    if (!live) return false;
    this.parked = true;
    const owner = live.owner;
    live.owner = null;
    live.hooks = {};
    owner?.resolve(null);
    return true;
  }

  /**
   * Takes over the parked listening, if any: resolves as `listen` does.
   * What it heard meanwhile is told to `onHeard` at once.
   */
  adopt(
    signal: AbortSignal,
    hooks: ListenHooks & { finish?: AbortSignal },
  ): Promise<Heard | null> | null {
    this.parked = false;
    const live = this.live;
    if (!live) return null;
    live.hooks = hooks;
    if (live.heard.text) hooks.onHeard?.(live.heard.text);
    if (live.ended) hooks.onSpeechEnd?.();
    return this.own(live, signal, hooks.finish);
  }

  /** Stops a parked listening nobody took, and the socket. */
  dispose() {
    this.parked = false;
    this.live?.stop();
    this.stopCall(() => this.channel.close());
  }

  /** `live`'s result for a new owner, ended by `signal` and `finish`. */
  private own(
    live: Live,
    signal: AbortSignal,
    finish?: AbortSignal,
  ): Promise<Heard | null> {
    return new Promise<Heard | null>((resolve, reject) => {
      const owner: ListenOwner = { resolve, reject };
      live.owner = owner;
      live.result.then(
        (heard) => {
          if (live.owner === owner) resolve(heard);
        },
        (error) => {
          if (live.owner === owner) reject(error);
        },
      );
      const stop = () => {
        if (live.owner === owner) live.stop();
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      finish?.addEventListener(
        "abort",
        () => {
          if (live.owner === owner) this.channel.send({ op: "finish" });
        },
        { once: true },
      );
    });
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
      language,
      conversation,
      ...hooks
    }: ListenHooks & {
      finish?: AbortSignal;
      language?: string | null;
      /** The conversation's end, for cleaning what is said. */
      conversation?: string;
    } = {},
  ): Promise<Heard | null> {
    if (this.channel.closed) throw this.channel.closed;
    // A new listening replaces one left over.
    this.live?.stop();
    const live: Live = {
      hooks,
      owner: null,
      heard: { text: "", whole: false },
      ended: false,
      talking: false,
      result: Promise.resolve(null),
      stop: () => {},
    };
    live.result = this.run(live, { language, conversation });
    this.live = live;
    this.turnMoved();
    void live.result
      .catch(() => null)
      .finally(() => {
        live.talking = false;
        if (this.live === live) this.live = null;
        this.turnMoved();
      });
    return this.own(live, signal, finish);
  }

  private async run(
    live: Live,
    {
      language,
      conversation,
    }: { language?: string | null; conversation?: string },
  ): Promise<Heard | null> {
    let stopped = false;
    let resolveStopped: (() => void) | null = null;
    live.stop = () => {
      if (stopped) return;
      stopped = true;
      this.channel.send({ op: "stop" });
      resolveStopped?.();
    };
    // In a call carrying the microphone, it goes by WebRTC: here only its
    // level is shown, and nothing goes on the socket.
    // A call still being made is not waited for (its answer took 3.4 s
    // once): the user may be talking already, and this listening goes on
    // the socket; the next ones take the call. In the Roamgate app's
    // WebView it is waited for: the app's microphone is the call's, and a
    // capture here meanwhile would be a second recorder on the phone.
    const waits = this.callSettled || (this.call !== null && this.callInApp);
    if (this.call && !waits)
      voiceTrace("listening on the socket while the call starts");
    const started = waits ? await this.call : null;
    const call = started?.carriesMicrophone() ? started : null;
    if (started && !call)
      started.traceFallback(
        "listening on the socket: the call carries no microphone",
      );
    // In a call, its microphone is open already, its echo canceller and
    // gain settled: the socket's audio comes from it too. A capture opened
    // for each listening starts late and unsettled, its first words lost.
    // A call over, or whose capture went, has nothing left to hear: a
    // capture of its own then.
    const callMicrophone = started?.liveMicrophone() ?? null;
    // The Android app carries the microphone: the helper hears the app's,
    // and the page opens no capture at all, its level not shown. One opened
    // for each listening started and stopped a second recorder on the
    // phone, a Bluetooth headset saying "microphone muted" at each turn's
    // end.
    const appMicrophone = call?.microphoneInApp() === true;
    const stream = appMicrophone
      ? null
      : (callMicrophone ??
        // In a call, as the call's own: in its loudspeaker mode, an echo
        // canceller here would put the phone on its earpiece.
        (await navigator.mediaDevices.getUserMedia({
          audio: activeMicrophoneConstraints(),
        })));
    // The call's context: the replies play through it too (voiceOutput.ts).
    const context = stream ? voiceContext() : null;
    if (stream && context && !this.routeTraced) {
      this.routeTraced = true;
      void traceAudioRoute(stream, context);
    }
    let unlisten: (() => void) | null = null;
    let holdCheck: ReturnType<typeof setInterval> | null = null;
    const nodes: AudioNode[] = [];
    try {
      if (stopped) return null;
      let tap: AudioWorkletNode | null = null;
      if (stream && context) {
        // A context made after the tap's await may start suspended,
        // hearing nothing.
        await context.resume();
        tapUrl ??= URL.createObjectURL(
          new Blob([TAP_WORKLET], { type: "text/javascript" }),
        );
        if (!tapsLoaded.has(context)) {
          await context.audioWorklet.addModule(tapUrl);
          tapsLoaded.add(context);
        }
        if (stopped) return null;
        tap = new AudioWorkletNode(context, "roamgate-tap");
        const mute = context.createGain();
        mute.gain.value = 0;
        const microphone = context.createMediaStreamSource(stream);
        nodes.push(microphone, tap, mute);
        microphone.connect(tap);
        tap.connect(mute).connect(context.destination);
      }

      const holds = () =>
        (live.hooks.holding?.() ?? false) || this.alsoHolding();
      let held = holds();
      const checkHold = () => {
        if (held && !holds()) {
          held = false;
          this.channel.send({ op: "release" });
        }
      };
      let session: number | null = null;
      let heard = false;
      let level = 0;
      const downsampler = context ? new Downsampler(context.sampleRate) : null;
      let chunk: number[] = [];
      const chunkSamples = (STREAM_RATE * CHUNK_MS) / 1000;

      const result = new Promise<Heard | null>((resolve, reject) => {
        resolveStopped = () => resolve(null);
        unlisten = this.channel.listen((event) => {
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
              const text = live.heard.text.trim();
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
          if (event.event === "stalled") {
            // The call's microphone stopped coming. Without its leg, the
            // utterance ends with what was heard, and the next listening
            // goes on the socket; with it, it may come back (the server
            // ends the utterance if it does not).
            const going = call?.carriesMicrophone() === true;
            call?.traceFallback(
              going
                ? "the microphone stopped coming: waiting for it"
                : "the microphone stopped coming, its leg is down: the utterance ends",
            );
            if (!going) this.channel.send({ op: "finish" });
            return;
          }
          if (event.event === "speech_start") {
            heard = true;
            live.talking = true;
            this.onAnySpeech?.();
            live.hooks.onSpeech?.();
          } else if (
            event.event === "speech_end" ||
            event.event === "speech_cancelled"
          ) {
            // Cancelled (too short to be speech), it ends with no final.
            live.talking = false;
            this.turnMoved();
            if (event.event === "speech_cancelled") return;
            live.ended = true;
            live.hooks.onSpeechEnd?.();
          } else if (event.event === "partial" || event.event === "text") {
            live.heard = nextHeard(live.heard, event.event, event.text ?? "");
            live.hooks.onHeard?.(live.heard.text);
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
                    ...(event.voice ? { voice: event.voice } : {}),
                    ...(event.voice_label
                      ? { voiceLabel: event.voice_label }
                      : {}),
                  }
                : null,
            );
          }
        });
        // Without a capture here, nothing comes to notice the hold's end:
        // it is looked at as often as audio would come.
        if (!tap || !context || !downsampler) {
          holdCheck = setInterval(checkHold, CHUNK_MS);
          return;
        }
        tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
          const block = event.data;
          let sum = 0;
          for (const sample of block) sum += sample * sample;
          const weight = Math.min(
            1,
            ((block.length / context.sampleRate) * 1000) / LEVEL_SMOOTHING_MS,
          );
          level += (Math.sqrt(sum / block.length) - level) * weight;
          if (!call) {
            for (const sample of downsampler.push(block)) chunk.push(sample);
            if (chunk.length >= chunkSamples) {
              this.channel.audio(Int16Array.from(chunk));
              chunk = [];
            }
          }
          checkHold();
        };
      });
      call?.listening(true);
      if (call)
        voiceTrace(
          appMicrophone
            ? `listening to the app's microphone (call ${call.id}): no capture here`
            : `listening to the call's microphone (call ${call.id})`,
        );
      this.channel.send({
        op: "listen",
        new_speaker: !this.listened,
        hold: held,
        end_silence_ms: END_SILENCE_MS,
        ...(language ? { language } : {}),
        ...(conversation !== undefined ? { context: conversation } : {}),
        ...(call ? { call: call.id } : {}),
      });
      this.listened = true;
      // The level is for the eye: once a frame is plenty. Without a
      // capture here, there is none to show.
      let shown = tap !== null;
      const show = () => {
        if (!shown) return;
        live.hooks.onLevel?.(level);
        requestAnimationFrame(show);
      };
      show();
      try {
        return await result;
      } finally {
        shown = false;
        if (tap) tap.port.onmessage = null;
      }
    } finally {
      (unlisten as (() => void) | null)?.();
      if (holdCheck) clearInterval(holdCheck);
      // The call's microphone stays open for the call; only its sending
      // stops.
      if (call) call.listening(false);
      if (stream && stream !== callMicrophone)
        for (const track of stream.getTracks()) track.stop();
      for (const node of nodes) node.disconnect();
    }
  }
}

/**
 * Where a voice chat's sound comes from and goes, traced once: the
 * microphone, whether the browser cancels the echo on it, and the outputs
 * it knows. Whether replies come back as the user's words depends on them
 * (a phone playing to a Bluetooth speaker, its own loudspeaker).
 */
async function traceAudioRoute(stream: MediaStream, context: AudioContext) {
  try {
    const track = stream.getAudioTracks?.()[0];
    const settings: MediaTrackSettings = track?.getSettings?.() ?? {};
    const devices =
      (await navigator.mediaDevices.enumerateDevices?.().catch(() => [])) ?? [];
    const outputs = devices
      .filter((device) => device.kind === "audiooutput")
      .map((device) => device.label || device.deviceId || "unnamed");
    const sink = "sinkId" in context ? context.sinkId : "";
    const flag = (value: boolean | string | undefined) =>
      value === undefined
        ? "unknown"
        : typeof value === "string"
          ? value
          : value
            ? "on"
            : "off";
    voiceTrace(
      `microphone: ${track?.label || "unnamed"}, echo cancellation ${flag(settings.echoCancellation)}, noise suppression ${flag(settings.noiseSuppression)}, auto gain ${flag(settings.autoGainControl)}; plays to ${typeof sink === "string" && sink ? sink : "the default output"} of: ${outputs.join(", ") || "none listed"}`,
    );
  } catch (error) {
    voiceTrace(`microphone: not described (${error})`);
  }
}

let parked: {
  key: string;
  link: VoiceLink;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/**
 * Keeps `link`'s listening going for the voice chat of `key` (a pane) to
 * adopt once it is built again (takeParkedVoiceLink). False when it was
 * not listening: nothing to keep.
 */
export function parkVoiceLink(key: string, link: VoiceLink): boolean {
  if (!link.park()) return false;
  if (parked) {
    clearTimeout(parked.timer);
    parked.link.dispose();
  }
  const timer = setTimeout(() => {
    if (parked?.link !== link) return;
    parked = null;
    voiceTrace("the listening kept over a rebuild was not taken: stopped");
    link.dispose();
  }, PARK_MS);
  parked = { key, link, timer };
  voiceTrace("listening kept while the chat is rebuilt");
  return true;
}

/** The link parked for `key`, once. */
export function takeParkedVoiceLink(key: string): VoiceLink | null {
  if (!parked || parked.key !== key) return null;
  clearTimeout(parked.timer);
  const { link } = parked;
  parked = null;
  return link;
}

/**
 * Two short rising notes, quiet: the voice connection had to come back
 * and the call goes on. Tones, not words: the person may be speaking, and
 * the gate takes no tone for a voice.
 */
export function playReconnectCue() {
  voiceTrace("reconnected: the cue plays");
  try {
    const context = new AudioContext();
    const gain = context.createGain();
    gain.connect(context.destination);
    const start = context.currentTime + 0.02;
    for (const [index, frequency] of [660, 990].entries()) {
      const tone = context.createOscillator();
      tone.type = "sine";
      tone.frequency.value = frequency;
      const at = start + index * 0.14;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.02);
      gain.gain.linearRampToValueAtTime(0, at + 0.11);
      tone.connect(gain);
      tone.start(at);
      tone.stop(at + 0.12);
    }
    setTimeout(() => void context.close(), 800);
  } catch {
    // No sound: the call goes on anyway.
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
 * Where the agent's answer to the message sent starts: the index of that
 * message, the last the user sent, or -1 when the last is another.
 */
function turnStart(entries: readonly HistoryEntry[], sentText: string) {
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
      return entry.text.trim().includes(sent) ||
        sent.includes(entry.text.trim())
        ? index
        : -1;
    }
  }
  return -1;
}

/**
 * The agent's answer to the message sent: its messages after the last
 * user message, once it has some.
 */
export function replyEntriesAfter(
  entries: readonly HistoryEntry[],
  sentText: string,
): HistoryEntry[] {
  const start = turnStart(entries, sentText);
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

/**
 * What the agent wrote in Roamgate's threads in answer to the message
 * sent, in a few words ("Answered 2 threads."): the chat shows each as a
 * row of its own, and the agent does not repeat them in the chat. Null
 * when it wrote in none.
 */
export function threadWritesSaid(
  entries: readonly HistoryEntry[],
  sentText: string,
): string | null {
  const start = turnStart(entries, sentText);
  if (start < 0) return null;
  const count = entries
    .slice(start + 1)
    .filter(
      (entry) =>
        entry.kind === "tool_call" &&
        (entry.roamgate_write ??
          (entry.text && entry.tool_name
            ? roamgateWrite(entry.tool_name, entry.text)
            : undefined)),
    ).length;
  if (!count) return null;
  return count === 1 ? "Answered a thread." : `Answered ${count} threads.`;
}

/**
 * The answer read aloud: the agent's messages; a turn that only wrote in
 * threads says how many ("Answered 2 threads."), its rows not read.
 */
export function replyAfter(
  entries: readonly HistoryEntry[],
  sentText: string,
): string | null {
  const reply = replyEntriesAfter(entries, sentText)
    .map((entry) => entry.text)
    .join("\n\n")
    .trim();
  return reply || threadWritesSaid(entries, sentText);
}

let speechRate = DEFAULT_SPEECH_RATE;
const speechRateListeners = new Set<() => void>();
/** What plays now, with the rate each was made at. */
const playing = new Map<HTMLAudioElement, number>();
/** The rate each fetched speech was made at, when not 1. */
const nativeRates = new WeakMap<object, number>();

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

/** The pauses Speech settings offer before a turn ends, in ms. */
export const MAX_PAUSE_STEPS = [4000, 6000, 8000, 10_000, 12_000, 15_000];
let maxPause = 8000;
const maxPauseListeners = new Set<() => void>();

/** The longest pause before a turn that sounded finished ends, in ms. */
export function getMaxPause(): number {
  return maxPause;
}

export function subscribeMaxPause(listener: () => void): () => void {
  maxPauseListeners.add(listener);
  return () => maxPauseListeners.delete(listener);
}

function setMaxPause(ms: number) {
  if (ms === maxPause) return;
  maxPause = ms;
  for (const listener of [...maxPauseListeners]) listener();
}

/** Keeps the longest pause in voice.json, for the next listening session. */
export async function saveMaxPause(ms: number): Promise<void> {
  const before = maxPause;
  setMaxPause(ms);
  const response = await fetch("/api/voice/settings", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ max_pause_ms: ms }),
  });
  if (!response.ok) {
    setMaxPause(before);
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? response.statusText);
  }
}

/**
 * Surprise (each reply read by one of the voices at random), as the server
 * keeps it; null until the server says it has voices to pick from.
 */
let voiceSurprise: boolean | null = null;
const surpriseListeners = new Set<() => void>();

export function getVoiceSurprise(): boolean | null {
  return voiceSurprise;
}

export function subscribeVoiceSurprise(listener: () => void): () => void {
  surpriseListeners.add(listener);
  return () => surpriseListeners.delete(listener);
}

/**
 * Surprise as the server has it now, such as after choosing a voice turned
 * it off; only once the server said it has voices, unless `known`.
 */
export function setVoiceSurprise(on: boolean, known = false) {
  if ((voiceSurprise === null && !known) || voiceSurprise === on) return;
  voiceSurprise = on;
  for (const listener of surpriseListeners) listener();
}

/** Turns Surprise on or off, for every page. */
export async function saveVoiceSurprise(on: boolean): Promise<void> {
  const response = await fetch("/api/voice/voices/surprise", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ on }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? response.statusText);
  }
  const state = (await response.json()) as { surprise?: boolean };
  setVoiceSurprise(state.surprise === true, true);
}

/** Who reads the sentence playing, when the server said (Surprise). */
let reader: string | null = null;
const readerListeners = new Set<() => void>();
/** Who reads each fetched speech, when the server said. */
const readers = new WeakMap<object, string>();

export function getVoiceReader(): string | null {
  return reader;
}

export function subscribeVoiceReader(listener: () => void): () => void {
  readerListeners.add(listener);
  return () => readerListeners.delete(listener);
}

function setVoiceReader(name: string | null) {
  if (name === reader) return;
  reader = name;
  for (const listener of readerListeners) listener();
}

/** A name for one reply read aloud: its sentences keep one voice. */
function newReading(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A sentence's speech, made at this page's reading speed (the server keeps
 * the pitch): played as it comes, nothing to speed up here.
 */
let callSpeech: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` once every task given before it ended: a call's sentences go
 * into its mix as soon as they are made, so they must be asked for one
 * after the other, in reading order. Asked together, the next sentence
 * (made ahead) could overtake the one before and play first in the stream.
 */
export function inCallOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = callSpeech.then(task, task);
  callSpeech = run.catch(() => {});
  return run;
}

/** When each queued sentence's answer came (performance.now()). */
const answered = new WeakMap<QueuedSpeech, number>();

export async function fetchSpeech(
  text: string,
  signal: AbortSignal,
  options: { language?: string; reading?: string } = {},
): Promise<Speech> {
  // In a call whose replies are heard, the sentence goes into its mix, in
  // reading order; otherwise it plays here, as without a call.
  const call = activeCall();
  if (call?.carriesReplies())
    return inCallOrder(() => {
      signal.throwIfAborted();
      return fetchOneSpeech(text, signal, options, call);
    });
  call?.traceFallback("a reply plays here: the call carries no replies");
  return fetchOneSpeech(text, signal, options, null);
}

async function fetchOneSpeech(
  text: string,
  signal: AbortSignal,
  { language, reading }: { language?: string; reading?: string },
  call: WebRtcCall | null,
): Promise<Speech> {
  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { ...VOICE_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      ...(language ? { language } : {}),
      ...(reading ? { reading } : {}),
      rate: speechRate,
      ...(call ? { call: call.id } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? response.statusText);
  }
  if (response.headers.get("content-type")?.includes("application/json")) {
    const queued: unknown = await response.json();
    if (!isQueuedSpeech(queued)) throw new Error("No speech came");
    const at = performance.now();
    answered.set(queued, at);
    // Stopped before it played: what the mix still had of it goes.
    signal.addEventListener(
      "abort",
      () => {
        if (call && !call.over(queued, at)) call.hush();
      },
      { once: true },
    );
    const name = response.headers.get("x-voice-name");
    if (name) {
      try {
        readers.set(queued, decodeURIComponent(name));
      } catch {
        // Not a name.
      }
    }
    return queued;
  }
  const audio = await response.blob();
  const native = Number(response.headers.get("x-voice-native-rate"));
  if (native > 0 && native !== 1) nativeRates.set(audio, native);
  const name = response.headers.get("x-voice-name");
  if (name) {
    try {
      readers.set(audio, decodeURIComponent(name));
    } catch {
      // Not a name.
    }
  }
  return audio;
}

/** Seconds of the silence that holds the audio focus. */
const FOCUS_SECONDS = 30;

/** How long the focus holder waits after a reading before it plays again. */
export const HOLDER_RESUME_MS = 1500;

/**
 * The voice call's media session and output until `signal` aborts.
 *
 * Replies come from the WebRTC call (webrtcCall.ts); without one, they play
 * through the call's AudioContext (the "context" default, at any speed:
 * the server makes the speech at the reading speed): no media element
 * plays, so Android's audio focus and the car see nothing to pause, and
 * nothing else of the page's competes with it.
 *
 * Only with replies "As media" (voiceOutput.ts "element"), a silent loop
 * holds the audio focus between replies, pausing other apps' audio (music,
 * podcasts): phones give the focus to the page while its media plays, and
 * for good only to media longer than 5 seconds that is announced as
 * playing, so near silence loops: an offset of one in 8 bits, which Chrome
 * measures as sound (all zeros may count as nothing playing) but a steady
 * level makes no click, and speakers do not play it. It never plays with a
 * reply's element: Android gives the focus to whichever played last and
 * pauses the other, so the two took turns every few hundred ms. It goes
 * quiet as a sentence starts, and plays again HOLDER_RESUME_MS after the
 * last one. Must start from a tap.
 */
export function holdAudioFocus(signal: AbortSignal): void {
  if (signal.aborted) return;
  const mode = voiceOutputMode();
  if (mode === "element") focusHolder(signal);
  resetMediaControls();
  const session = "mediaSession" in navigator ? navigator.mediaSession : null;
  // The media controls (the car's, a headset's, the lock screen's) reach
  // the page through these: without them Chrome pauses the page's media
  // itself, and a pause from them looks like any other.
  // Played by the WebRTC call or through the call's context, nothing is
  // media for them to pause: each is told and left. As elements, a pause
  // from them is honoured until play.
  const told = (action: string) => () =>
    voiceTrace(
      `media control "${action}" (car or headset): ignored, ${mode} output`,
    );
  const actions: [MediaSessionAction, () => void][] =
    mode === "element"
      ? [
          ["pause", () => mediaControlPause(voiceTrace)],
          ["stop", () => mediaControlPause(voiceTrace)],
          ["play", () => mediaControlPlay(voiceTrace)],
          ["nexttrack", told("nexttrack")],
          ["previoustrack", told("previoustrack")],
        ]
      : (["pause", "stop", "play", "nexttrack", "previoustrack"] as const).map(
          (action) => [action, told(action)],
        );
  holdVoiceContext(signal, voiceTrace);
  voiceTrace(`voice output: ${mode}`);
  if (session) {
    session.metadata = new MediaMetadata({
      title: "Voice chat",
      artist: "Roamgate",
    });
    session.playbackState = "playing";
    for (const [action, handler] of actions) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not supported here.
      }
    }
  }
  signal.addEventListener(
    "abort",
    () => {
      resetMediaControls();
      if (session) {
        session.metadata = null;
        session.playbackState = "none";
        for (const [action] of actions) {
          try {
            session.setActionHandler(action, null);
          } catch {
            // Not supported here.
          }
        }
      }
    },
    { once: true },
  );
}

/**
 * The silent loop holding the audio focus ("element" output) until
 * `signal` aborts, quiet while a sentence plays as an element
 * (holdAudioFocus).
 */
function focusHolder(signal: AbortSignal): void {
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
  // Paused by the page itself: not a pause to undo.
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const start = (why: string) => {
    clear();
    if (signal.aborted || readingPlays() || !silence.paused) return;
    quiet = false;
    noteOwnPlay(silence, hush);
    silence
      .play()
      .then(() => voiceTrace(`the focus holder plays ${why}`))
      .catch((error) => voiceTrace(`the focus holder: ${error}`));
  };
  // A sentence plays: the holder must not take the focus from it.
  const hush = () => {
    clear();
    if (quiet && silence.paused) return;
    quiet = true;
    if (!silence.paused) {
      voiceTrace("the focus holder goes quiet while a sentence plays");
      silence.pause();
    }
  };
  const readingsChange = () => {
    if (signal.aborted) return;
    if (readingPlays()) hush();
    else {
      clear();
      timer = setTimeout(
        () => start("again after the reading"),
        HOLDER_RESUME_MS,
      );
    }
  };
  const stopListening = subscribeReadings(readingsChange);
  if (readingPlays()) quiet = true;
  else start("to hold the audio focus");
  // Paused by the system (the focus taken away): it holds nothing then,
  // so it plays again once it can, unless a sentence plays.
  silence.addEventListener("pause", () => {
    if (signal.aborted || quiet) return;
    voiceTrace("the focus holder was paused from outside the page");
    clear();
    timer = setTimeout(() => start("again"), 1000);
  });
  signal.addEventListener(
    "abort",
    () => {
      clear();
      stopListening();
      quiet = true;
      silence.pause();
      URL.revokeObjectURL(url);
    },
    { once: true },
  );
}

/** A sentence's speech: a file, or where it is in the call's stream. */
export type Speech = Blob | QueuedSpeech;

function play(audio: Speech, signal: AbortSignal): Promise<void> {
  if (!(audio instanceof Blob)) {
    setVoiceReader(readers.get(audio) ?? null);
    const call = activeCall();
    if (call && call.id === audio.call)
      return call.playQueued(
        audio,
        answered.get(audio) ?? performance.now(),
        signal,
      );
    // Its call is over: nothing left of it to hear.
    return Promise.resolve();
  }
  const mode = voiceOutputMode();
  // In a call, always through its context, at any speed: the server made
  // it at the reading speed, keeping the pitch. A speed changed since it
  // was fetched applies from the next sentence: no media element, ever,
  // for Android to pause or to compete with.
  if (mode === "context" && voiceContextHeld()) {
    setVoiceReader(readers.get(audio) ?? null);
    return playInContext(audio, signal).catch((error) => {
      voiceTrace(`the sentence could not play in the voice context: ${error}`);
      throw new Error("The speech could not be played");
    });
  }
  return playElement(audio, signal);
}

function playElement(audio: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Stopped while it downloaded: an abort listener added now never runs.
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(audio);
    const player = new Audio(url);
    // Faster without sounding higher; set after the load starts, which
    // resets playbackRate to defaultPlaybackRate.
    const native = nativeRates.get(audio) ?? 1;
    setVoiceReader(readers.get(audio) ?? null);
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
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      guard.release();
      signal.removeEventListener("abort", stop);
      playing.delete(player);
      player.pause();
      URL.revokeObjectURL(url);
      resolve();
    };
    // Paused from outside the page (the audio focus, the car): played on.
    const guard = guardPlayback(player, {
      trace: voiceTrace,
      onGiveUp: () => done(),
    });
    const stop = () => done();
    signal.addEventListener("abort", stop, { once: true });
    player.onended = done;
    player.onerror = () => {
      voiceTrace(`error ${player.error?.code}: ${player.error?.message}`);
      done();
      reject(new Error("The speech could not be played"));
    };
    noteOwnPlay(player);
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
 * the one before plays (`reading` names the reply it is from, so its
 * sentences keep one voice); `play` resolves when it is over or `signal`
 * aborts.
 */
export type SentenceVoice<Speech = unknown> = {
  prepare(
    text: string,
    signal: AbortSignal,
    options?: { language?: string; reading?: string },
  ): Promise<Speech>;
  play(speech: Speech, signal: AbortSignal): Promise<void>;
  /** A reading starts (speakWith, speakStream). */
  begin?(): void;
};

/** The server's voice engine: Ogg Opus from /api/voice/speak. */
export const serverVoice: SentenceVoice<Speech> = {
  prepare: (text, signal, options) => fetchSpeech(text, signal, options),
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
  const reading = newReading();
  if (parts.length) voice.begin?.();
  let next = parts.length
    ? voice.prepare(parts[0]!, signal, { reading })
    : null;
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
        ? voice.prepare(parts[index + 1]!, signal, { reading })
        : null;
    // A failed fetch ahead must not go unhandled while this one plays.
    next?.catch(() => {});
    if (signal.aborted) break;
    onSentence?.(parts[index]!);
    await voice.play(speech, signal);
    voiceTrace(`sentence ${index + 1} done`);
  }
  voiceTrace("reading over");
  setVoiceReader(null);
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
  // One reply: its sentences keep one voice.
  const reply = newReading();
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
      const audio = voice.prepare(text, signal, { reading: reply });
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
    setVoiceReader(null);
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
