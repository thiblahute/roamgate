/**
 * The page side of the opt-in live voice tests
 * (server/src/voice/voice-call.live.test.ts), bundled by the test and never
 * by the app: a voice chat's link (VoiceLink) listening in a loop, on the
 * voice socket or in a WebRTC call, as a voice chat does, while headless
 * Chrome's fake microphone plays what is to be heard. It can also read
 * replies aloud in the call, as a voice chat does, follow the call's legs
 * and what they carry, and let the microphone hear what the call plays.
 */
import {
  fetchVoiceAvailability,
  serverVoice,
  speakWith,
  VoiceLink,
} from "./voiceChat";
import { holdVoiceContext, voiceContext } from "./voiceOutput";
import { activeCall } from "./webrtcCall";

export type HarnessRun = {
  /** On the voice socket, or with a WebRTC call carrying the microphone. */
  mode: "socket" | "webrtc";
  /** How long to listen, from the microphone's start, in seconds. */
  seconds: number;
  /**
   * When each thing said is over and paused after, from the microphone's
   * start: the listening is finished then, as a speaker done talking.
   */
  finishAt: number[];
  /** Replies read aloud at these times, from the microphone's start. */
  replies?: { at: number; text: string }[];
  /** Whether to follow the call's legs (four times a second) and RTP. */
  watch?: boolean;
  /**
   * The microphone hears what the call plays (replies and music) this far
   * below it (dB), as from a loudspeaker, after the browser's echo
   * cancellation: none of it is taken away.
   */
  echoDb?: number;
  /** The replies leg's decoded level over each [from, to] (seconds). */
  levels?: [number, number][];
};

export type HarnessHeard = {
  /** Seconds from the microphone's start. */
  at: number;
  speechAt?: number;
  text: string | null;
  error?: string;
};

export type HarnessReply = {
  /** Seconds from the microphone's start. */
  at: number;
  text: string;
  /** Whether the call carried the replies when it was read. */
  inCall: boolean;
  /**
   * The replies leg's decoded level while it was read, and over the two
   * seconds before (dBFS): null without a replies leg.
   */
  level: number | null;
  quiet: number | null;
  error?: string;
};

export type HarnessLegs = {
  /** When a leg was down, once the call carried both. */
  down: { at: number; replies: boolean; microphone: boolean }[];
  /**
   * RTP bytes received on the replies leg and sent on the microphone leg,
   * over each ten seconds that ends `at`.
   */
  windows: { at: number; received: number; sent: number }[];
};

export type HarnessResult = {
  /** When the call carried the microphone, from the microphone's start. */
  callAt: number | null;
  heard: HarnessHeard[];
  replies: HarnessReply[];
  legs: HarnessLegs | null;
  /** The levels asked for (dBFS): null without a replies leg. */
  levels: (number | null)[];
};

/** The page's peer connections: the call's legs, as it makes them. */
const connections: RTCPeerConnection[] = [];

function trackConnections() {
  const Native = globalThis.RTCPeerConnection;
  if (typeof Native !== "function" || connections.length) return;
  globalThis.RTCPeerConnection = class extends Native {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      connections.push(this);
    }
  };
}

type Counter = {
  energy: number;
  seconds: number;
  received: number;
  sent: number;
};

/** The audio RTP counters of each live leg, by connection and stream. */
async function counters(): Promise<Map<string, Counter>> {
  const out = new Map<string, Counter>();
  await Promise.all(
    connections.map(async (connection, index) => {
      if (connection.connectionState === "closed") return;
      const report = await connection.getStats().catch(() => null);
      report?.forEach((entry) => {
        if (entry.kind !== "audio") return;
        if (entry.type === "inbound-rtp")
          out.set(`${index}:${entry.id}`, {
            energy: entry.totalAudioEnergy ?? 0,
            seconds: entry.totalSamplesDuration ?? 0,
            received: entry.bytesReceived ?? 0,
            sent: 0,
          });
        else if (entry.type === "outbound-rtp")
          out.set(`${index}:${entry.id}`, {
            energy: 0,
            seconds: 0,
            received: 0,
            sent: entry.bytesSent ?? 0,
          });
      });
    }),
  );
  return out;
}

const NONE: Counter = { energy: 0, seconds: 0, received: 0, sent: 0 };

/** What the legs carried between two times; one made meanwhile from 0. */
function between(from: Map<string, Counter>, to: Map<string, Counter>) {
  let energy = 0;
  let seconds = 0;
  let received = 0;
  let sent = 0;
  for (const [key, end] of to) {
    const start = from.get(key) ?? NONE;
    energy += end.energy - start.energy;
    seconds += end.seconds - start.seconds;
    received += end.received - start.received;
    sent += end.sent - start.sent;
  }
  const level =
    seconds > 0 ? 10 * Math.log10(Math.max(energy / seconds, 1e-10)) : null;
  return { level, received, sent };
}

/**
 * Makes each microphone the page opens hear the call's incoming audio,
 * `db` below it; answers what takes in the legs made since, called as
 * they come.
 */
function echoing(db: number): () => void {
  const context = new AudioContext({ sampleRate: 48_000 });
  const echo = context.createGain();
  echo.gain.value = 10 ** (db / 20);
  const devices = navigator.mediaDevices;
  const capture = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints) => {
    const stream = await capture(constraints);
    if (!constraints?.audio) return stream;
    const mixed = context.createMediaStreamDestination();
    context.createMediaStreamSource(stream).connect(mixed);
    echo.connect(mixed);
    return mixed.stream;
  };
  const taken = new Set<MediaStreamTrack>();
  return () => {
    for (const connection of connections)
      for (const { track } of connection.getReceivers()) {
        if (track.kind !== "audio" || taken.has(track)) continue;
        taken.add(track);
        context.createMediaStreamSource(new MediaStream([track])).connect(echo);
      }
  };
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function listenFor({
  mode,
  seconds,
  finishAt,
  replies = [],
  watch = false,
  echoDb,
  levels: levelsAt = [],
}: HarnessRun): Promise<HarnessResult> {
  trackConnections();
  await fetchVoiceAvailability();
  // Keeps the fake microphone open from the start: each listening's own
  // capture then goes on in its file instead of starting it again.
  const kept = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const opened = performance.now();
  // The test times what it does to the bridge (a helper killed) from here.
  console.log("harness: microphone opened");
  const now = () => (performance.now() - opened) / 1000;
  const until = (at: number) => sleep((at - now()) * 1000);
  const hearLegs = echoDb === undefined ? null : echoing(echoDb);
  const hearing = (async () => {
    while (hearLegs && now() < seconds) {
      hearLegs();
      await sleep(250);
    }
  })();
  const held = new AbortController();
  if (mode === "webrtc") {
    holdVoiceContext(held.signal, (line) => console.log(line));
    voiceContext();
  }
  const link = await VoiceLink.open();
  let callAt: number | null = null;
  if (mode === "webrtc")
    while (now() < 30) {
      if (activeCall()?.carriesMicrophone()) {
        callAt = now();
        break;
      }
      await sleep(100);
    }
  // Replies read as a voice chat reads them: into the call's mix while it
  // carries replies, measured as decoded on the replies leg.
  const read: HarnessReply[] = [];
  const reading = (async () => {
    for (const { at, text } of replies) {
      await until(at - 2);
      const before = await counters();
      await until(at);
      const start = await counters();
      const inCall = activeCall()?.carriesReplies() ?? false;
      try {
        await speakWith(serverVoice, text, AbortSignal.timeout(30_000));
        const played = between(start, await counters());
        read.push({
          at,
          text,
          inCall,
          level: played.level,
          quiet: between(before, start).level,
        });
      } catch (error) {
        read.push({
          at,
          text,
          inCall,
          level: null,
          quiet: null,
          error: String(error),
        });
      }
    }
  })();
  const levels: (number | null)[] = [];
  const measuring = (async () => {
    for (const [from, to] of levelsAt) {
      await until(from);
      const start = await counters();
      await until(to);
      levels.push(between(start, await counters()).level);
    }
  })();
  const legs: HarnessLegs | null =
    watch && callAt !== null ? { down: [], windows: [] } : null;
  const watching = (async () => {
    if (!legs) return;
    let from = await counters();
    let fromAt = now();
    while (now() < seconds - 1) {
      await sleep(250);
      const call = activeCall();
      const replies = call?.carriesReplies() ?? false;
      const microphone = call?.carriesMicrophone() ?? false;
      if (!replies || !microphone)
        legs.down.push({ at: now(), replies, microphone });
      if (now() - fromAt >= 10) {
        const to = await counters();
        const { received, sent } = between(from, to);
        legs.windows.push({ at: now(), received, sent });
        from = to;
        fromAt = now();
      }
    }
  })();
  const heard: HarnessHeard[] = [];
  while (now() < seconds) {
    const stop = new AbortController();
    const finish = new AbortController();
    const timers = [
      setTimeout(() => stop.abort(), Math.max(0, (seconds - now()) * 1000)),
    ];
    const due = finishAt.find((end) => end > now() + 0.5);
    if (due !== undefined)
      timers.push(setTimeout(() => finish.abort(), (due - now()) * 1000));
    const at = now();
    let speechAt: number | undefined;
    try {
      const result = await link.listen(stop.signal, {
        finish: finish.signal,
        onSpeech: () => {
          speechAt ??= now();
        },
      });
      heard.push({ at, speechAt, text: result?.text ?? null });
    } catch (error) {
      heard.push({ at, text: null, error: String(error) });
      await sleep(500);
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  }
  await Promise.all([reading, watching, measuring, hearing]);
  link.close();
  held.abort();
  for (const track of kept.getTracks()) track.stop();
  return { callAt, heard, replies: read, legs, levels };
}

(
  globalThis as unknown as {
    voiceHarness: (run: HarnessRun) => Promise<HarnessResult>;
  }
).voiceHarness = listenFor;
