/**
 * A voice call as a WebRTC call with the voice helper
 * (voice/helper/src/call.rs, server/src/http/voice-socket.ts): the helper's
 * webrtcsink sends the replies mixed with the music, and its webrtcsrc
 * receives this page's microphone. The page signals with gstwebrtc-api
 * (GStreamer's WebRTC signalling protocol) on
 * /api/voice/call/signalling, which the bridge fronts to the helper's
 * signalling server for this call only (its `call_token`).
 *
 * The replies play from the received track, the normal WebRTC way (an
 * audio element). A call has a mode (`CallMode`, chooseCallMode):
 *
 * - "call": the microphone opens with the browser's echo cancellation,
 *   which knows what plays and takes it out of the microphone. On Android
 *   that puts the phone in communication mode (Chromium's
 *   AudioManagerAndroid, for an input stream with the platform echo
 *   canceller): the voice-call stream, its hardware echo canceller,
 *   Bluetooth as a call headset, and without a headset the earpiece.
 * - "speaker": the microphone opens with no echo cancellation, noise
 *   suppression or gain control. Chrome then leaves Android in its normal
 *   mode, and the replies play as media, on the loudspeaker. The helper
 *   cancels their echo itself, knowing what it sent (call_microphone's
 *   `echo: "here"`; voice/helper/src/echo.rs).
 *
 * A phone without a headset starts in "speaker", one with a headset (and
 * every other browser) in "call". Moving from one to the other (useOutput)
 * closes the microphone, lets the replies' output go, waits
 * OUTPUT_CLOSE_MS (Chrome keeps an idle output stream that long and would
 * take it again, in the mode it was made in), and opens both again.
 *
 * Pairing: the helper's producer carries `{"call": <id>, "role":
 * "replies"}`, and only that producer is consumed. The microphone is
 * published as this page's producer (meta `{"call": <id>, "role":
 * "microphone"}`), and its peer id is told on the voice socket
 * (`call_microphone`): the helper listens to that id, never to whichever
 * producer came first. The published track is a clone of the microphone,
 * enabled only while listening (`listening`): nothing leaves the phone
 * otherwise, and the echo canceller keeps running on the open microphone.
 *
 * A network change breaks the ICE path: a leg whose ICE connection fails,
 * or stays disconnected RECOVER_MS, is negotiated again (a new session on
 * the same signalling), at once FAST_RETRIES times in a row, then after
 * BACKOFF_MS: a path that keeps failing (no address of the helper's
 * reachable from this network) is not tried every few seconds for the
 * whole call, the replies playing here and the microphone going on the
 * socket meanwhile. A network change (the browser's `online`, or its
 * connection's `change`) tries a leg waiting for its next try at once.
 * Each leg's path, and each failure with its candidates and what each
 * pair sent and got back, is told to the server (`call_ice`), which logs
 * it always: a call that fails on the road says why afterwards. A lost
 * signalling socket (its WebRTC sessions go with it) is opened again, and
 * both legs with it, for as long as the call lasts. Audio sent meanwhile is lost: nothing is filled in afterwards. A
 * signalling that never opened (refused, or nothing there) is tried
 * NEVER_OPENED_TRIES times, NEVER_OPENED_MS at most: the call then ends and
 * says so, and the chat goes on without it. The microphone's leg ended by
 * the helper (its session closed, or `call_error` saying the microphone
 * failed) is published again, MICROPHONE_TRIES times in a row at most. A
 * helper that restarted while the page was on another socket is learnt
 * from the resume's answer (`restarts`): the signalling opens again then.
 *
 * A call answered after START_MS is ended at once (`call_audio` off with
 * its number): the page went on without it. A call let go by its link
 * (release) keeps that link's socket open until it stops or a rebuilt
 * chat's link takes it, so that its end reaches the server.
 *
 * Replies asked for during the call go into the mix (POST /api/voice/speak
 * with `call`) and come back as where they are in the mix (`start_ms`,
 * `duration_ms`) and where the mix was then (`now_ms`): a sentence "plays"
 * until its end is heard here (that much later than the answer, with the
 * playout's delay, the output's latency and RELEASE_MARGIN_MS), and
 * stopping it drops what the helper still had to send of it (`call_hush`).
 *
 * The phone's screen: Chrome on Android gives a page silence from its
 * microphone once the screen is off or another app is in front, its track
 * still live and unmuted (Android lets only the app in front, or one with
 * a microphone foreground service, capture; Chrome starts that service
 * only behind its AndroidEnableBackgroundMediaCapturing feature, off by
 * default). So the call holds a screen wake lock while it lasts, taken
 * again each time the page shows (the browser lets it go when hidden),
 * and the screen does not turn off by itself. Pressing the power button
 * still turns it off: the microphone is then watched. Its track muted or
 * ended, or its capture exactly silent SILENT_MS while listening (a real
 * microphone never is), the call says it is paused by the phone (trace,
 * notice, `microphonePaused`); once the page shows, a microphone still
 * paused REOPEN_MS later is opened again and replaces the old one, the
 * call going on.
 *
 * The Roamgate Android app keeps the microphone with the screen off: on a
 * phone that has it (androidApp.ts), the call is handed to it once set up
 * (handOff): the page asks the server for a single-use token
 * (`call_handoff`) and opens the app with it (an intent URL), or, in the
 * app's own WebView, gives it to the app's bridge (`RoamgateApp.handOff`,
 * no intent URL and no button; a bridge that throws leaves the call
 * here); the app
 * joins the call with the legs it carries, and the page, told so
 * (`call_carrier`), lets those legs go: no microphone of its own, no
 * replies played when the app plays them (its outputs, `call_output_state`,
 * shown and chosen here through `call_output`). The page still runs the
 * conversation: its listenings hear the app's microphone through the call.
 * The app giving the call back (`"state": "left"`) gives the legs back to
 * the page. An app that does not join within HANDOFF_WAIT_MS leaves the
 * call here, as without it.
 */

import {
  androidAppKnown,
  appBridge,
  androidAppMissedCall,
  androidAppTookCall,
  handoffIntentUrl,
} from "./androidApp";
import type { ChannelEvent } from "./voiceChannel";

/** What of the voice channel (voiceChannel.ts) the call uses. */
export type CallChannel = {
  send(message: object): void;
  listen(listener: (event: ChannelEvent) => void): () => unknown;
  /** The call is controlled on it: resumed on its new sockets. */
  holdCall?(call: number, resume: string): void;
};

/** A peer in the signalling: its id, and its meta. */
export type SignallingPeer = {
  readonly id: string;
  readonly meta: Record<string, unknown>;
};

/** A gstwebrtc-api session (consumer, or a producer's client). */
export type RtcSession = EventTarget & {
  readonly rtcPeerConnection: RTCPeerConnection | null;
  close(): void;
};

export type ConsumerSession = RtcSession & {
  mungeStereoHack: boolean;
  readonly streams: MediaStream[];
  connect(): boolean;
};

export type ProducerSession = EventTarget & {
  readonly state: number;
  start(): boolean;
  close(): void;
};

/** What of gstwebrtc-api's GstWebRTCAPI the call uses. */
export type SignallingApi = {
  registerConnectionListener(listener: {
    connected(clientId: string): void;
    disconnected(): void;
  }): boolean;
  registerPeerListener(listener: {
    producerAdded?(producer: SignallingPeer): void;
    producerRemoved?(producer: SignallingPeer): void;
  }): boolean;
  createProducerSession(stream: MediaStream): ProducerSession | null;
  createConsumerSession(producerId: string): ConsumerSession | null;
  getAvailableProducers(): SignallingPeer[];
};

export type SignallingConfig = {
  meta: Record<string, unknown>;
  signalingServerUrl: string;
  reconnectionTimeout: number;
  webrtcConfig: RTCConfiguration;
};

/** gstwebrtc-api's SessionState.streaming. */
const STREAMING = 2;

/** gstwebrtc-api, loaded when a call starts. */
async function gstWebRtcApi(config: SignallingConfig): Promise<SignallingApi> {
  const { default: GstWebRTCAPI } = await import("gstwebrtc-api");
  return new GstWebRTCAPI(config) as unknown as SignallingApi;
}

/** Closes what gstwebrtc-api has no public way to close: its socket. */
function closeApi(api: SignallingApi) {
  (api as { _channel?: { close(): void } | null })._channel?.close();
}

/** A sentence put into the call's mix (POST /api/voice/speak). */
export type QueuedSpeech = {
  queued: true;
  call: number;
  start_ms: number;
  duration_ms: number;
  /** Where the mix was when the answer was made. */
  now_ms?: number;
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

/** How long a call takes to start before the page goes on without it. */
export const START_MS = 5000;
/** How long after START_MS a late call's answer is still ended. */
export const LATE_MS = 60_000;
/** How long a call let go by its link waits for a rebuilt chat's link. */
export const RELEASE_MS = 5000;
/** An ICE connection disconnected this long is negotiated again. */
export const RECOVER_MS = 4000;
/** Waits between tries to open the signalling again. */
const RETRY_MS = [250, 500, 1000, 2000, 3000];
/** Tries of a signalling that never opened before the call ends. */
export const NEVER_OPENED_TRIES = 6;
/** How long a signalling that never opened is tried, at most. */
export const NEVER_OPENED_MS = 15_000;
/** What a reply takes from the mix to the ear, beside the jitter buffer. */
const PLAYOUT_MS = 120;
/**
 * Beside the output's latency (a Bluetooth headset's), what a reply's end
 * may come later than reckoned: hold is released only past it.
 */
export const RELEASE_MARGIN_MS = 300;
/** A failed leg is negotiated again at once this many times in a row. */
export const FAST_RETRIES = 2;
/** Then after these waits, the last one repeated, until it connects. */
export const BACKOFF_MS = [5000, 15_000, 30_000, 60_000];
/** Times in a row the microphone's leg is published again after failing. */
export const MICROPHONE_TRIES = 5;
/** How often the microphone's echo statistics are traced. */
const ECHO_TRACE_MS = 15_000;
/** How often the microphone's capture is checked while listening. */
export const MICROPHONE_CHECK_MS = 1000;
/** Its capture exactly silent this long, listening: paused by the phone. */
export const SILENT_MS = 3000;
/** Shown again, a microphone still paused this long is opened again. */
export const REOPEN_MS = 1500;
/** What the call says while the phone keeps the microphone from it. */
export const MICROPHONE_PAUSED = "Microphone paused by the phone";
/** How long the Android app has to join a call handed to it. */
export const HANDOFF_WAIT_MS = 15_000;
/** What of a call the Android app carries. */
export type CarriedLeg = "microphone" | "replies";
/** An output of the Android app's, as it tells them. */
export type AppOutput = { id: string; kind: CallOutputKind; label: string };

let active: WebRtcCall | null = null;
const callListeners = new Set<() => void>();

/** The call going on now, if any: replies go into its mix. */
export function activeCall(): WebRtcCall | null {
  return active;
}

/** Calls `listener` when a call starts or ends, or changes its output. */
export function subscribeActiveCall(listener: () => void): () => void {
  callListeners.add(listener);
  return () => callListeners.delete(listener);
}

function callChanged() {
  for (const listener of [...callListeners]) listener();
}

/**
 * Where a call plays on a phone. Chrome on Android lists no audio output
 * but the default (setSinkId has nothing to choose from, and there is no
 * selectAudioOutput), and lists the phone's communication devices as
 * microphones, by these names (Chromium's CommunicationDeviceSelector):
 * opening one of them in "call" mode routes every communication stream,
 * the call's replies included, to that device. The loudspeaker is the
 * "speaker" mode instead (media, not a communication stream), never the
 * "Speakerphone" device. Elsewhere none of these names is listed, and
 * there is nothing to choose.
 */
const CALL_OUTPUT_NAMES: Record<string, CallOutputKind> = {
  Speakerphone: "speaker",
  "Headset earpiece": "earpiece",
  "Bluetooth headset": "bluetooth",
  "Wired headset": "wired",
  "USB audio": "usb",
};
export type CallOutputKind =
  | "speaker"
  | "earpiece"
  | "bluetooth"
  | "wired"
  | "usb";
/**
 * How a call plays: "call", with the browser's echo cancellation (on
 * Android, communication mode: the earpiece or a headset); "speaker", with
 * none (on Android, media on the loudspeaker), the echo cancelled by the
 * helper.
 */
export type CallMode = "speaker" | "call";
/** An output: its mode, and in "call" mode the device opened for it. */
export type CallOutput = {
  kind: CallOutputKind;
  mode: CallMode;
  deviceId?: string;
};
export type CallOutputs = {
  /** What the call can be moved to; empty when there is no choice. */
  choices: CallOutput[];
  current: CallOutputKind | null;
};
/**
 * The headsets a call plays on in "call" mode on the default device, as
 * Chromium picks it (selectDefaultDevice); without one, the phone (the
 * earpiece, in communication mode).
 */
const HEADSETS: CallOutputKind[] = ["wired", "usb", "bluetooth"];
const OUTPUT_WORDS: Record<CallOutputKind, string> = {
  speaker: "loudspeaker",
  earpiece: "earpiece",
  bluetooth: "Bluetooth headset",
  wired: "wired headset",
  usb: "USB headset",
};

/** The phone's communication devices `devices` name, by kind. */
function communicationDevices(
  devices: readonly Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">[],
): CallOutput[] {
  const found: CallOutput[] = [];
  for (const device of devices) {
    const kind =
      device.kind === "audioinput" ? CALL_OUTPUT_NAMES[device.label] : null;
    if (kind && device.deviceId && !found.some((c) => c.kind === kind))
      found.push({ kind, mode: "call", deviceId: device.deviceId });
  }
  return found;
}

/**
 * The mode a call starts in, and why: "call" on a phone with a headset (it
 * plays the call, with the phone's own echo canceller) and off Android;
 * "speaker" on a phone without one, which would otherwise play the call
 * on its earpiece.
 */
export function chooseCallMode(
  devices: readonly Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">[],
  userAgent: string,
): { mode: CallMode; why: string } {
  const named = communicationDevices(devices);
  const headset = HEADSETS.find((kind) => named.some((c) => c.kind === kind));
  if (headset)
    return {
      mode: "call",
      why: `a ${OUTPUT_WORDS[headset]} is connected: it plays the call, the phone cancelling the echo`,
    };
  if (named.length)
    return {
      mode: "speaker",
      why: "no headset connected: the replies play as media on the loudspeaker, their echo cancelled on the server",
    };
  if (/Android/i.test(userAgent))
    return {
      mode: "speaker",
      why: "Android, its audio devices not named yet: the replies play as media on the loudspeaker, their echo cancelled on the server",
    };
  return {
    mode: "call",
    why: "the browser cancels the echo itself, on its default output",
  };
}

/** The microphone's constraints in `mode`, on `deviceId` if given. */
export function microphoneConstraints(
  mode: CallMode,
  deviceId?: string,
): MediaTrackConstraints {
  // Any of the browser's processing would change the echo the helper
  // cancels, and its echo canceller is what puts Android in communication
  // mode: none at all in "speaker", the helper does them.
  const processing = mode === "call";
  return {
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/**
 * The microphone's constraints for a capture of its own while a call goes
 * on (a listening the call does not carry): the call's, which must not
 * change the phone's mode under it.
 */
export function activeMicrophoneConstraints(): MediaTrackConstraints {
  return microphoneConstraints(active?.mode ?? "call");
}

/**
 * How long Chrome keeps an output stream once nothing plays on it
 * (AudioManagerBase's kStreamCloseDelaySeconds is 5 s), plus a margin:
 * the replies must not take the old one again in the mode it was made in.
 */
export const OUTPUT_CLOSE_MS = 5500;
/** The order a tap goes through them. */
const OUTPUT_ORDER: CallOutputKind[] = [
  "speaker",
  "earpiece",
  "bluetooth",
  "wired",
  "usb",
];

/**
 * The outputs `devices` offer, and the one the call plays on: in `mode`,
 * its microphone `using` that device. Only a phone offers any: the
 * loudspeaker ("speaker" mode), and its other communication devices.
 */
export function callOutputs(
  devices: readonly Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">[],
  using: string | undefined,
  mode: CallMode = "call",
): CallOutputs {
  const named = communicationDevices(devices);
  if (!named.length) return { choices: [], current: null };
  const choices: CallOutput[] = [
    { kind: "speaker", mode: "speaker" },
    ...named.filter((c) => c.kind !== "speaker"),
  ];
  choices.sort(
    (a, b) => OUTPUT_ORDER.indexOf(a.kind) - OUTPUT_ORDER.indexOf(b.kind),
  );
  if (choices.length < 2) return { choices: [], current: null };
  if (mode === "speaker") return { choices, current: "speaker" };
  const current =
    named.find((c) => c.deviceId === using && c.kind !== "speaker")?.kind ??
    HEADSETS.find((kind) => named.some((c) => c.kind === kind)) ??
    "earpiece";
  return { choices, current };
}

/** The output a tap moves the call to: the next one, round. */
export function nextCallOutput(outputs: CallOutputs): CallOutput | null {
  const { choices, current } = outputs;
  if (!choices.length) return null;
  const at = choices.findIndex((choice) => choice.kind === current);
  return choices[(at + 1) % choices.length] ?? null;
}

export type CallOptions = {
  trace?: (line: string) => void;
  /** gstwebrtc-api, or a fake. */
  api?: (config: SignallingConfig) => Promise<SignallingApi>;
  /** Opens the microphone in a mode: the default one, or the device given. */
  microphone?: (request: {
    mode: CallMode;
    deviceId?: string;
  }) => Promise<MediaStream>;
  /** The mode the call starts in; chosen from the devices otherwise. */
  mode?: CallMode;
  /** The browser's user agent (navigator.userAgent). */
  userAgent?: string;
  /** The browser's media devices (enumerateDevices). */
  devices?: () => Promise<
    Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">[]
  >;
  /** Plays the replies' stream. */
  player?: () => HTMLAudioElement;
  /** Tells the user something of the call: it could not connect. */
  notice?: (text: string) => void;
  /** The output's latency, in seconds (AudioContext.outputLatency). */
  outputLatency?: () => number;
  /**
   * Calls `changed` when the network may have changed (the browser's
   * `online`, its connection's `change`); gives what stops that.
   */
  networkChanges?: (changed: () => void) => () => void;
  /** The page's visibility and the screen wake lock (the browser's). */
  screen?: CallScreen;
  /**
   * Told when the phone pauses the call's microphone (true) and when it
   * is back (false): with the screen off, only a spoken word reaches.
   */
  microphonePaused?: (paused: boolean) => void;
  /** The Roamgate Android app on this phone (androidApp.ts), or a fake. */
  app?: AndroidApp;
};

/** What the call knows of the Android app, and how it opens it. */
export type AndroidApp = {
  /** Whether it is on this phone, as far as the page knows. */
  known(): boolean;
  /**
   * Whether this page runs in the app's own WebView: the call goes to its
   * bridge (handOff), never through an intent URL or a button.
   */
  embedded(): boolean;
  /** Opens it on `url` (an intent URL). */
  open(url: string): void;
  /** Gives call `callId` to the app's bridge with `token`; may throw. */
  handOff(callId: string, token: string): void;
  /** It took a call handed to it. */
  took(): void;
  /** It did not; true when it is forgotten now. */
  missed(): boolean;
};

const browserApp: AndroidApp = {
  known: () => appBridge() !== null || androidAppKnown(),
  embedded: () => appBridge() !== null,
  open: (url) => {
    globalThis.location.href = url;
  },
  handOff: (callId, token) => {
    const bridge = appBridge();
    if (!bridge) throw new Error("no Roamgate app bridge");
    bridge.handOff(callId, token);
  },
  took: () => androidAppTookCall(),
  missed: () => androidAppMissedCall(),
};

/**
 * Whether a call made with `options` goes to the Roamgate app at once:
 * this page runs in its WebView.
 */
export function callInApp(options: CallOptions = {}): boolean {
  return (options.app ?? browserApp).embedded();
}

/** A held screen wake lock (WakeLockSentinel). */
export type ScreenLock = {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
};

/** What of the page's visibility and screen the call uses. */
export type CallScreen = {
  /** Whether the page is hidden (screen off, another app in front). */
  hidden(): boolean;
  /** Calls `changed` when the page is hidden or shown; gives what stops it. */
  visibility(changed: () => void): () => void;
  /** Keeps the screen on (the Screen Wake Lock API); null where there is none. */
  wakeLock: (() => Promise<ScreenLock>) | null;
};

/** The browser's document and navigator.wakeLock. */
function browserScreen(): CallScreen {
  const doc = (globalThis as { document?: Document }).document;
  const wakeLock = (
    globalThis as {
      navigator?: {
        wakeLock?: { request(type: "screen"): Promise<ScreenLock> };
      };
    }
  ).navigator?.wakeLock;
  return {
    hidden: () => doc?.visibilityState === "hidden",
    visibility: (changed) => {
      doc?.addEventListener("visibilitychange", changed);
      return () => doc?.removeEventListener("visibilitychange", changed);
    },
    wakeLock: wakeLock ? () => wakeLock.request("screen") : null,
  };
}

/** The browser's word that its network changed. */
function browserNetworkChanges(changed: () => void): () => void {
  const target = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  const connection = (
    globalThis as {
      navigator?: { connection?: EventTarget };
    }
  ).navigator?.connection;
  target.addEventListener?.("online", changed);
  connection?.addEventListener?.("change", changed);
  return () => {
    target.removeEventListener?.("online", changed);
    connection?.removeEventListener?.("change", changed);
  };
}

/**
 * The page went on without a call (no answer within START_MS): one
 * answered within LATE_MS more is ended at once, never left running with
 * nobody on it.
 */
function endLate(channel: CallChannel, trace: (line: string) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = channel.listen((event) => {
    if (event.event !== "call_audio" || event.resumed) return;
    done();
    if (typeof event.call !== "number") return;
    trace(`call ${event.call}: answered too late, the page went on: ended`);
    channel.send({ op: "call_audio", on: false, call: event.call });
  });
  const done = () => {
    if (timer) clearTimeout(timer);
    stop();
  };
  timer = setTimeout(done, LATE_MS);
}

const defaultMicrophone = ({
  mode,
  deviceId,
}: {
  mode: CallMode;
  deviceId?: string;
}) =>
  navigator.mediaDevices.getUserMedia({
    audio: microphoneConstraints(mode, deviceId),
  });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const browserDevices = async (): Promise<MediaDeviceInfo[]> =>
  (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];

/** A leg of the call: its session, and what watches its connection. */
type Leg = {
  session: RtcSession | null;
  connection: RTCPeerConnection | null;
  recover: ReturnType<typeof setTimeout> | null;
  traced: boolean;
  /** Times its ICE failed in a row, since it last connected. */
  failures: number;
  /** Its next negotiation, waited for (BACKOFF_MS). */
  again: ReturnType<typeof setTimeout> | null;
};

const newLeg = (): Leg => ({
  session: null,
  connection: null,
  recover: null,
  traced: false,
  failures: 0,
  again: null,
});

export class WebRtcCall {
  private stopped = false;
  private unlisten: (() => unknown)[] = [];
  private releasing: ReturnType<typeof setTimeout> | null = null;
  /** Told once the call stopped or moved: the released link may close. */
  private released: (() => void)[] = [];
  /** Times a restarted helper made the call again, as the server said. */
  private restarts = 0;
  /** The microphone's leg failed this many times lately, and last when. */
  private microphoneFailures = 0;
  private microphoneFailedAt = 0;
  private republishing: ReturnType<typeof setTimeout> | null = null;
  private api: SignallingApi | null = null;
  private clientId: string | null = null;
  /** Tries to open the signalling since it last worked. */
  private retries = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** The signalling opened once: lost, it is opened again, always. */
  private opened = false;
  /** Tries to open the signalling while it never opened, since when. */
  private tries = 0;
  private triedSince = 0;
  /** The replies' leg connected once (said in the trace). */
  private repliesTold = false;
  /** What goes without the call, traced since a leg last connected. */
  private fallbacks = new Set<string>();
  private producer: ProducerSession | null = null;
  /** The microphone's clone published, enabled while listening. */
  private sending: MediaStreamTrack | null = null;
  private listeningNow = false;
  /** The helper listens to this page's microphone producer now. */
  private microphoneHeard = false;
  private replies = newLeg();
  private microphoneLeg = newLeg();
  private repliesProducer: string | null = null;
  /** The jitter buffer's delay of the replies, in ms, lately. */
  private jitterMs = 40;
  private echoTimer: ReturnType<typeof setInterval> | null = null;
  private echoTold = false;
  /** The music waits, silent, while the Mac learns the speaker's voice. */
  private musicWaiting = false;
  /** The replies' stream, played unless the call is moving to a mode. */
  private repliesStream: MediaStream | null = null;
  /** Moving to another mode: the microphone and the replies are off. */
  private switching = false;
  /** The screen wake lock held, and whether one is being asked for. */
  private screenLock: ScreenLock | null = null;
  private locking = false;
  private screenTold = false;
  /** Why the phone keeps the microphone from the call now, if it does. */
  private microphonePause: string | null = null;
  /** The microphone's running energy at its last check, while listening. */
  private captured: { energy: number; seconds: number } | null = null;
  /** Checks in a row its capture was exactly silent. */
  private silentChecks = 0;
  private microphoneTimer: ReturnType<typeof setInterval> | null = null;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private reopening = false;
  /** The page's microphone being opened (takeMicrophoneBack). */
  private takingBack = false;
  /** Tries to open the paused microphone again, since it was paused. */
  private reopenTries = 0;
  /** Stops watching the microphone's track (mute, unmute, ended). */
  private unwatchTrack: (() => void) | null = null;
  /** The Android app carrying some of the call's legs, if it does. */
  private carrier: {
    legs: Set<CarriedLeg>;
    heard: boolean;
    outputs: { current: string | null; outputs: AppOutput[] } | null;
  } | null = null;
  /** A handoff offered to the app, waited for. */
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** The app's bridge threw: the call stays here, not handed again. */
  private bridgeFailed = false;

  private constructor(
    readonly id: number,
    readonly music: boolean,
    /** The link it is controlled on; a rebuilt chat's new link takes it. */
    private channel: CallChannel,
    /** What the server asks to move the call to another socket. */
    private readonly token: string,
    /** The microphone, for the level shown; null when it could not open. */
    readonly microphone: MediaStream | null,
    /** How it plays now (CallMode). */
    public mode: CallMode,
    private readonly player: HTMLAudioElement,
    private readonly options: Required<
      Pick<
        CallOptions,
        | "trace"
        | "api"
        | "notice"
        | "outputLatency"
        | "networkChanges"
        | "microphone"
        | "devices"
        | "screen"
        | "microphonePaused"
        | "app"
      >
    >,
  ) {}

  /**
   * Starts a call on `channel`: null when the server or this browser
   * cannot (an older helper, no WebRTC), and the page plays each sentence
   * itself and streams its microphone on the voice socket as before.
   */
  static async start(
    channel: CallChannel,
    options: CallOptions = {},
  ): Promise<WebRtcCall | null> {
    const trace = options.trace ?? (() => {});
    if (!options.api && typeof RTCPeerConnection !== "function") {
      trace("call: no WebRTC here, each sentence plays by itself");
      return null;
    }
    // What the helper says of a call's music until the call is set up.
    const waits = new Map<unknown, boolean>();
    const early = channel.listen((event) => {
      if (event.event === "call_music")
        waits.set(event.call, event.waiting === true);
    });
    const answer = await new Promise<ChannelEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        done(null);
        endLate(channel, trace);
      }, START_MS);
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
    if (!answer || typeof answer.call !== "number" || answer.webrtc !== true) {
      early();
      trace(
        `call: no WebRTC call (${answer ? String(answer.error ?? "an older server") : "no answer"}), each sentence plays by itself`,
      );
      if (answer && typeof answer.call === "number")
        channel.send({ op: "call_audio", on: false, call: answer.call });
      return null;
    }
    const openMicrophone = options.microphone ?? defaultMicrophone;
    const devices = options.devices ?? browserDevices;
    const chosen = options.mode
      ? { mode: options.mode, why: "as asked" }
      : chooseCallMode(
          await devices().catch(() => []),
          options.userAgent ?? globalThis.navigator?.userAgent ?? "",
        );
    trace(
      `call ${answer.call}: ${chosen.mode === "speaker" ? "loudspeaker mode" : "call mode"}: ${chosen.why}`,
    );
    // In the Roamgate app's WebView, the app takes the call at once, its
    // microphone the call's: the page opens none. A second recorder,
    // started and stopped next to the app's, had the phone silence the
    // app's (heard at -120 dBFS) and a headset say "microphone muted". It
    // opens only if the call stays here (takeMicrophoneBack).
    const inApp = (options.app ?? browserApp).embedded();
    const microphone = inApp
      ? (early(), new MediaStream([]))
      : await openMicrophone({ mode: chosen.mode })
          .catch((error) => {
            trace(`call ${answer.call}: no microphone for the call (${error})`);
            return null;
          })
          .finally(early);
    // Whether its music waits for a voice: the answer says it, and the
    // helper may say it again around the answer, while this call is set up.
    const musicWaiting = waits.get(answer.call) ?? answer.waiting === true;
    const player = (options.player ?? (() => new Audio()))();
    player.autoplay = true;
    const call = new WebRtcCall(
      answer.call,
      answer.music === true,
      channel,
      String(answer.resume ?? ""),
      microphone,
      chosen.mode,
      player,
      {
        trace,
        api: options.api ?? gstWebRtcApi,
        notice: options.notice ?? (() => {}),
        outputLatency: options.outputLatency ?? (() => 0),
        networkChanges: options.networkChanges ?? browserNetworkChanges,
        microphone: openMicrophone,
        devices,
        screen: options.screen ?? browserScreen(),
        microphonePaused: options.microphonePaused ?? (() => {}),
        app: options.app ?? browserApp,
      },
    );
    channel.holdCall?.(call.id, call.token);
    active = call;
    callChanged();
    void call.traceOutputs();
    call.listen();
    call.musicWaits(musicWaiting);
    void call.holdScreen();
    call.watchMicrophone();
    trace(`call ${call.id}: started, its signalling opens`);
    if (inApp)
      call.trace(
        "in the Roamgate app: the app's microphone is the call's, none opened here",
      );
    await call.connect();
    // The Android app keeps the microphone with the screen off: it takes
    // the call on a phone that has it.
    if (call.canHandOff()) call.handOff();
    else void call.takeMicrophoneBack();
    return call;
  }

  private trace(line: string) {
    this.options.trace(`call ${this.id}: ${line}`);
  }

  /** Its music waits for a voice, or plays: traced when that changes. */
  private musicWaits(waiting: boolean) {
    if (waiting === this.musicWaiting) return;
    this.musicWaiting = waiting;
    this.trace(
      waiting
        ? "the music waits for a voice"
        : "a voice was taken: the music plays",
    );
  }

  private listen() {
    this.unlisten.push(
      this.options.networkChanges(() => this.networkChanged()),
    );
    this.unlisten.push(
      this.options.screen.visibility(() => this.visibilityChanged()),
    );
    this.unlisten.push(
      this.channel.listen((event) => {
        if (event.event === "call_microphone" && event.call === this.id) {
          this.microphoneHeard = event.ok === true;
          this.trace(
            event.ok === true
              ? "the Mac listens to the microphone"
              : `the Mac does not hear the microphone: ${String(event.error)}`,
          );
        } else if (event.event === "call_error") {
          this.trace(String(event.error));
          // The helper's microphone failed (call.rs): not heard any more.
          if (String(event.error).startsWith("the microphone")) {
            this.microphoneHeard = false;
            this.microphoneLost("the helper's microphone failed", true);
          }
        } else if (event.event === "call_music" && event.call === this.id) {
          this.musicWaits(event.waiting === true);
        } else if (event.event === "call_restarted" && event.call === this.id) {
          // Its signalling server is new: the socket closing brings the
          // legs back on it.
          if (typeof event.restarts === "number")
            this.restarts = event.restarts;
          this.microphoneHeard = false;
          this.trace("the voice helper restarted: the call starts again");
        } else if (
          event.event === "call_audio" &&
          event.error &&
          event.call === this.id
        ) {
          this.trace(`ended: ${String(event.error)}`);
          this.stop();
        } else if (event.event === "call_handoff" && event.call === this.id) {
          this.handoffAnswered(event);
        } else if (event.event === "call_carrier" && event.call === this.id) {
          if (event.state === "joined") this.carriedBy(event);
          else if (event.state === "left")
            this.carrierLeft(String(event.why ?? "it left"));
        } else if (
          event.event === "call_output_state" &&
          event.call === this.id
        ) {
          this.appOutputs(event);
        }
      }),
    );
  }

  /**
   * The page was hidden or shown: traced (what the phone did, for the
   * log); shown, the screen is held again and a paused microphone opened
   * again if it does not come back by itself.
   */
  private visibilityChanged() {
    if (this.stopped) return;
    if (this.options.screen.hidden()) {
      this.trace(
        "the page is hidden (the screen off, or another app in front)",
      );
      return;
    }
    this.trace("the page shows again");
    void this.holdScreen();
    if (this.microphonePause) this.reopenLater();
  }

  /**
   * Keeps the screen on while the call lasts, when the page shows (a
   * hidden page gets no wake lock, and loses the one it had).
   */
  async holdScreen() {
    const request = this.options.screen.wakeLock;
    if (
      !request ||
      this.stopped ||
      this.carrier ||
      this.screenLock ||
      this.locking ||
      this.options.screen.hidden()
    )
      return;
    this.locking = true;
    try {
      const lock = await request();
      if (this.stopped) {
        void lock.release().catch(() => {});
        return;
      }
      this.screenLock = lock;
      lock.addEventListener("release", () => {
        if (this.screenLock === lock) this.screenLock = null;
      });
      if (!this.screenTold) {
        this.screenTold = true;
        this.trace("the screen stays on during the call (a wake lock)");
      }
    } catch (error) {
      this.trace(`the screen may turn off: no wake lock (${error})`);
    } finally {
      this.locking = false;
    }
  }

  /** Whether the call holds a screen wake lock now. */
  holdsScreen(): boolean {
    return this.screenLock !== null;
  }

  /** Watches the microphone: its track, and its capture while listening. */
  watchMicrophone() {
    this.watchTrack();
    if (this.microphoneTimer) clearInterval(this.microphoneTimer);
    this.microphoneTimer = setInterval(
      () => void this.checkMicrophone(),
      MICROPHONE_CHECK_MS,
    );
  }

  /** The microphone's track now: muted, unmuted or ended, the call says it. */
  private watchTrack() {
    this.unwatchTrack?.();
    this.unwatchTrack = null;
    const track = this.microphone?.getAudioTracks()[0] as
      | (MediaStreamTrack & Partial<EventTarget>)
      | undefined;
    if (!track?.addEventListener) return;
    const current = () =>
      !this.stopped && this.microphone?.getAudioTracks()[0] === track;
    const muted = () => {
      if (current()) this.pauseMicrophone("its track muted");
    };
    const unmuted = () => {
      if (current() && this.microphonePause === "its track muted")
        this.microphoneBack("its track unmuted");
    };
    const ended = () => {
      if (current()) this.pauseMicrophone("its track ended");
    };
    track.addEventListener("mute", muted);
    track.addEventListener("unmute", unmuted);
    track.addEventListener("ended", ended);
    this.unwatchTrack = () => {
      track.removeEventListener?.("mute", muted);
      track.removeEventListener?.("unmute", unmuted);
      track.removeEventListener?.("ended", ended);
    };
    if (track.muted) this.pauseMicrophone("its track muted");
  }

  /**
   * While listening, whether the microphone's capture is exactly silent
   * (its running energy as sent does not grow): SILENT_MS of it, the
   * phone gives the page silence; growing again, the microphone is back.
   */
  private async checkMicrophone() {
    const connection = this.microphoneLeg.connection;
    if (
      this.stopped ||
      this.switching ||
      !connection ||
      !this.listeningNow ||
      !this.sending?.enabled
    ) {
      this.captured = null;
      this.silentChecks = 0;
      return;
    }
    let now: { energy: number; seconds: number } | null;
    try {
      now = microphoneEnergy(await connection.getStats());
    } catch {
      return;
    }
    if (this.stopped || this.microphoneLeg.connection !== connection) return;
    const before = this.captured;
    this.captured = now;
    if (!now || !before) return;
    if (now.energy > before.energy) {
      this.silentChecks = 0;
      if (this.microphonePause === "its capture went silent")
        this.microphoneBack("its capture has sound again");
      return;
    }
    this.silentChecks += 1;
    if (this.silentChecks * MICROPHONE_CHECK_MS >= SILENT_MS)
      this.pauseMicrophone("its capture went silent");
  }

  /** Why the phone keeps the microphone from the call, or null. */
  microphonePausedByPhone(): string | null {
    return this.microphonePause;
  }

  /**
   * The phone keeps the microphone from the call: said (trace, notice,
   * `microphonePaused`), never silently dropped; opened again once the
   * page shows.
   */
  private pauseMicrophone(why: string) {
    if (this.stopped || this.microphonePause || this.microphoneInApp()) return;
    // The Roamgate app keeps the microphone with the screen off: in its
    // WebView, "turn the screen on" is never said.
    if (this.options.app.embedded()) {
      this.trace(`the page's microphone is silenced by the phone: ${why}`);
      return;
    }
    this.microphonePause = why;
    this.reopenTries = 0;
    const hidden = this.options.screen.hidden();
    this.trace(
      `the microphone is paused by the phone: ${why}${hidden ? ", the page hidden" : ""}`,
    );
    this.options.notice(
      hidden ? `${MICROPHONE_PAUSED}: turn the screen on.` : MICROPHONE_PAUSED,
    );
    this.options.microphonePaused(true);
    callChanged();
    if (!hidden) this.reopenLater();
  }

  /** The microphone reaches the call again. */
  private microphoneBack(how: string) {
    if (!this.microphonePause) return;
    this.microphonePause = null;
    this.silentChecks = 0;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.trace(`the microphone is back: ${how}`);
    this.options.microphonePaused(false);
    callChanged();
  }

  /** A paused microphone, still paused REOPEN_MS later, opened again. */
  private reopenLater() {
    if (this.reopenTimer || this.stopped) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      void this.reopenMicrophone();
    }, REOPEN_MS);
  }

  /**
   * Opens the paused microphone again, in the call's mode and on its
   * device, replacing the old one on the microphone's leg: the call goes
   * on. Tried MICROPHONE_TRIES times at most while it stays paused.
   */
  private async reopenMicrophone() {
    const stream = this.microphone;
    if (
      !stream ||
      this.appCarries("microphone") ||
      !this.microphonePause ||
      this.stopped ||
      this.switching ||
      this.reopening ||
      this.options.screen.hidden()
    )
      return;
    this.reopening = true;
    this.reopenTries += 1;
    const deviceId = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
    try {
      const opened = await this.options.microphone({
        mode: this.mode,
        ...(deviceId ? { deviceId } : {}),
      });
      const track = opened.getAudioTracks()[0];
      if (!track || this.stopped || this.switching) {
        for (const each of opened.getTracks()) each.stop();
        return;
      }
      await this.replaceMicrophone(stream, track);
      this.microphoneBack("opened again");
    } catch (error) {
      this.trace(`the microphone did not open again: ${error}`);
      if (this.reopenTries < MICROPHONE_TRIES) this.reopenLater();
    } finally {
      this.reopening = false;
    }
  }

  /**
   * `track` replaces the microphone's in its stream and on its leg (or
   * the leg is published again from it); the old one stops.
   */
  private async replaceMicrophone(
    stream: MediaStream,
    track: MediaStreamTrack,
  ) {
    const old = stream.getAudioTracks();
    stream.addTrack(track);
    for (const each of old) {
      stream.removeTrack(each);
      each.stop();
    }
    this.watchTrack();
    this.captured = null;
    this.silentChecks = 0;
    const sending = track.clone();
    sending.enabled = this.listeningNow;
    const sender = this.microphoneLeg.connection
      ?.getSenders?.()
      .find((each) => each.track?.kind === "audio");
    const replaced = sender
      ? await sender.replaceTrack(sending).then(
          () => true,
          () => false,
        )
      : false;
    if (replaced && !this.stopped) {
      this.sending?.stop();
      this.sending = sending;
    } else {
      sending.stop();
      // Published again from the new track.
      if (!this.stopped) this.publish();
    }
  }

  /**
   * The signalling's URL, for this call and its owner only. Its token is
   * `call_token`: a `token` parameter is the generated login token's.
   */
  private signallingUrl(): string {
    const url = new URL("/api/voice/call/signalling", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("call", String(this.id));
    url.searchParams.set("call_token", this.token);
    return url.toString();
  }

  /** Opens the signalling; both legs follow once it is connected. */
  private async connect() {
    if (this.stopped) return;
    if (!this.opened) {
      if (this.tries === 0) this.triedSince = Date.now();
      this.tries += 1;
    }
    let api: SignallingApi;
    try {
      api = await this.options.api({
        meta: { call: this.id, role: "microphone" },
        signalingServerUrl: this.signallingUrl(),
        // Opened again here, with both legs.
        reconnectionTimeout: 0,
        // The helper gives its own addresses: nothing to ask on the web.
        webrtcConfig: { iceServers: [], bundlePolicy: "max-bundle" },
      });
    } catch (error) {
      this.trace(`the signalling did not open: ${error}`);
      this.notOpened();
      return;
    }
    if (this.stopped) {
      closeApi(api);
      return;
    }
    this.api = api;
    // This socket opened: closed, it dropped; otherwise it was refused.
    let up = false;
    api.registerConnectionListener({
      connected: (clientId) => {
        if (this.api !== api) return;
        up = true;
        this.trace(
          this.opened ? "the signalling opened again" : "the signalling opened",
        );
        this.opened = true;
        this.retries = 0;
        this.clientId = clientId;
        this.publish();
        for (const producer of api.getAvailableProducers())
          this.producerAdded(producer);
      },
      disconnected: () => {
        if (this.api !== api) return;
        this.api = null;
        this.clientId = null;
        this.producer = null;
        this.microphoneHeard = false;
        this.dropLeg(this.replies);
        this.dropLeg(this.microphoneLeg);
        this.repliesProducer = null;
        if (this.stopped) return;
        if (!up) return this.notOpened();
        this.trace("the signalling closed: opening it again");
        this.reconnect();
      },
    });
    api.registerPeerListener({
      producerAdded: (producer) => {
        if (this.api === api) this.producerAdded(producer);
      },
      producerRemoved: (producer) => {
        if (this.api !== api || producer.id !== this.repliesProducer) return;
        this.trace("the replies' producer went");
        this.repliesProducer = null;
        this.dropLeg(this.replies);
      },
    });
  }

  /**
   * A signalling socket closed before it opened (refused, or nothing
   * there): tried again; but in a call whose signalling never opened, only
   * NEVER_OPENED_TRIES times or NEVER_OPENED_MS, then the call ends.
   */
  private notOpened() {
    if (this.opened) {
      this.trace("the signalling did not open again: trying again");
      this.reconnect();
      return;
    }
    const took = Date.now() - this.triedSince;
    if (this.tries < NEVER_OPENED_TRIES && took < NEVER_OPENED_MS) {
      this.trace(`the signalling did not open (try ${this.tries})`);
      this.reconnect();
      return;
    }
    this.trace(
      `the signalling never opened (${this.tries} tries in ${(took / 1000).toFixed(1)} s): the call ends, replies play here and the microphone goes on the socket`,
    );
    this.options.notice(
      "The call could not connect: replies play here, and the microphone goes on the voice link.",
    );
    this.stop();
  }

  private reconnect() {
    if (this.stopped || this.retry) return;
    const wait = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)]!;
    this.retries += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, wait);
  }

  /** The helper's producer for this call: consumed; any other is not. */
  private producerAdded(producer: SignallingPeer) {
    if (producer.meta.call !== this.id || producer.meta.role !== "replies")
      return;
    if (this.repliesProducer === producer.id && this.replies.session) return;
    this.repliesProducer = producer.id;
    this.consume();
  }

  /** The replies' leg: a consumer session of the helper's producer. */
  private consume() {
    const api = this.api;
    const producer = this.repliesProducer;
    if (!api || !producer || this.stopped || this.appCarries("replies")) return;
    this.dropLeg(this.replies);
    const session = api.createConsumerSession(producer);
    if (!session) return;
    // The music is stereo: Chrome plays Opus in stereo only when asked.
    session.mungeStereoHack = true;
    const leg = this.replies;
    leg.session = session;
    session.addEventListener("streamsChanged", () => {
      const stream = session.streams[0];
      if (!stream || leg.session !== session) return;
      this.repliesStream = stream;
      // Moving to another mode: played once it opened again.
      if (!this.switching) this.playReplies();
    });
    session.addEventListener("rtcPeerConnectionChanged", () =>
      this.watch(leg, session, "replies"),
    );
    session.addEventListener("closed", () => {
      if (leg.session !== session || this.stopped) return;
      // Ended from the other side (the helper's session went): again,
      // waiting as after a failure when it failed lately.
      leg.session = null;
      if (leg.failures > FAST_RETRIES) {
        this.later(leg, "replies", "the replies' session ended");
        return;
      }
      this.trace("the replies' session ended: negotiating it again");
      setTimeout(() => this.consume(), RETRY_MS[0]);
    });
    this.watch(leg, session, "replies");
    session.connect();
  }

  private playReplies() {
    if (!this.repliesStream || this.stopped || this.appCarries("replies"))
      return;
    this.player.srcObject = this.repliesStream;
    this.player.play().catch((error) => {
      this.trace(`the replies did not start playing: ${error}`);
    });
  }

  /**
   * Who cancels the echo, as call_microphone tells the helper: "here" (the
   * helper) in "speaker" mode, "page" otherwise.
   */
  private echoBy(): "here" | "page" {
    return this.mode === "speaker" ? "here" : "page";
  }

  /** The microphone's leg: this page's producer, told to the helper. */
  private publish() {
    if (this.republishing) clearTimeout(this.republishing);
    this.republishing = null;
    const api = this.api;
    const track = this.microphone?.getAudioTracks()[0];
    if (!api || !track || this.stopped || this.appCarries("microphone")) return;
    // Let go before it is closed: gstwebrtc-api says "closed" at once, and
    // its own listener would take that for the signalling ending it.
    const old = this.producer;
    this.producer = null;
    old?.close();
    this.sending?.stop();
    this.dropLeg(this.microphoneLeg);
    this.microphoneHeard = false;
    const sending = track.clone();
    sending.enabled = this.listeningNow;
    this.sending = sending;
    const producer = api.createProducerSession(new MediaStream([sending]));
    if (!producer) return;
    this.producer = producer;
    const leg = this.microphoneLeg;
    let told = false;
    producer.addEventListener("stateChanged", () => {
      if (this.producer !== producer || told || producer.state !== STREAMING)
        return;
      told = true;
      // Registered: the helper may ask for it now.
      this.channel.send({
        op: "call_microphone",
        peer: this.clientId,
        echo: this.echoBy(),
      });
    });
    producer.addEventListener("clientConsumerAdded", (event) => {
      const session = (event as CustomEvent<RtcSession>).detail;
      if (this.producer !== producer) return;
      // The session before, let go first: its "closed" is not taken for
      // the helper ending it.
      this.dropLeg(leg);
      leg.session = session;
      session.addEventListener("rtcPeerConnectionChanged", () =>
        this.watch(leg, session, "microphone"),
      );
      session.addEventListener("closed", () => {
        if (this.producer !== producer || leg.session !== session) return;
        if (this.stopped) return;
        // The helper ended its session: unless it makes another (it
        // listens to it again), published again.
        this.dropLeg(leg);
        this.microphoneLost("the helper ended the microphone's session", false);
      });
      this.watch(leg, session, "microphone");
    });
    producer.addEventListener("closed", () => {
      if (this.producer !== producer || this.stopped) return;
      this.producer = null;
      this.trace("the microphone's producer closed: publishing it again");
      setTimeout(() => this.publish(), RETRY_MS[0]);
    });
    producer.start();
  }

  /**
   * The helper does not hear the microphone's leg any more: its session
   * ended, or (`failed`) its microphone failed. Published again a little
   * later, unless the helper made a new session meanwhile; at most
   * MICROPHONE_TRIES times within a minute of each other, listening going
   * on the socket after that.
   */
  private microphoneLost(why: string, failed: boolean) {
    if (this.stopped || this.republishing) return;
    this.republishing = setTimeout(
      () => {
        this.republishing = null;
        if (this.stopped || (!failed && this.microphoneLeg.session)) return;
        const now = Date.now();
        if (now - this.microphoneFailedAt > 60_000) this.microphoneFailures = 0;
        this.microphoneFailedAt = now;
        this.microphoneFailures += 1;
        if (this.microphoneFailures > MICROPHONE_TRIES) {
          if (this.microphoneFailures === MICROPHONE_TRIES + 1)
            this.trace(
              `${why} ${MICROPHONE_TRIES} times lately: listening goes on the socket`,
            );
          return;
        }
        this.trace(`${why}: publishing the microphone again`);
        this.publish();
      },
      Math.min(1000 * (this.microphoneFailures + 1), 3000),
    );
  }

  /** Watches `session`'s connection: traced, and negotiated again. */
  private watch(leg: Leg, session: RtcSession, name: "replies" | "microphone") {
    const connection = session.rtcPeerConnection;
    if (!connection || leg.connection === connection) return;
    leg.connection = connection;
    leg.traced = false;
    const check = () => {
      if (leg.connection !== connection || this.stopped) return;
      const state = connection.iceConnectionState;
      if (state === "connected" || state === "completed") {
        if (leg.recover) clearTimeout(leg.recover);
        leg.recover = null;
        leg.failures = 0;
        // Going without the call again would be said again.
        this.fallbacks.clear();
        if (name === "replies" && !this.repliesTold) {
          this.repliesTold = true;
          this.trace(
            `WebRTC, ${this.music && !this.musicWaiting ? "music and replies" : "replies"} from the Mac`,
          );
        }
        if (!leg.traced) {
          leg.traced = true;
          void this.tracePath(connection, name);
          if (name === "microphone") this.watchEcho(connection);
        }
      } else if (state === "failed")
        this.failed(leg, connection, name, "failed");
      else if (state === "disconnected" && !leg.recover)
        leg.recover = setTimeout(() => {
          leg.recover = null;
          if (
            leg.connection === connection &&
            connection.iceConnectionState !== "connected" &&
            connection.iceConnectionState !== "completed"
          )
            this.failed(
              leg,
              connection,
              name,
              `disconnected for ${RECOVER_MS / 1000} s`,
            );
        }, RECOVER_MS);
    };
    connection.addEventListener("iceconnectionstatechange", check);
    check();
  }

  /**
   * A leg's ICE path broke (a network change), or never worked: what it
   * tried is told to the server, and it is negotiated again, at once or
   * after BACKOFF_MS when it failed FAST_RETRIES times in a row.
   */
  private failed(
    leg: Leg,
    connection: RTCPeerConnection,
    name: "replies" | "microphone",
    why: string,
  ) {
    if (this.stopped) return;
    leg.failures += 1;
    const failures = leg.failures;
    // Read before the leg goes: its connection closes with it.
    void connection
      .getStats()
      .then((stats) => describeFailure(stats))
      .catch(() => null)
      .then((tried) =>
        this.tellIce(
          `${name}: ICE ${why} (${failures} in a row)${tried ? `: ${tried}` : ""}`,
        ),
      );
    if (failures > FAST_RETRIES)
      this.later(leg, name, `the ${name}' ICE ${why}`);
    else this.renegotiate(name, why);
  }

  /** Negotiates a leg that keeps failing again after a wait (BACKOFF_MS). */
  private later(leg: Leg, name: "replies" | "microphone", what: string) {
    if (this.stopped || leg.again) return;
    const wait =
      BACKOFF_MS[
        Math.min(
          Math.max(0, leg.failures - FAST_RETRIES - 1),
          BACKOFF_MS.length - 1,
        )
      ]!;
    this.trace(
      `${what} ${leg.failures} times in a row: negotiating it again in ${wait / 1000} s, ${name === "replies" ? "replies play here" : "the microphone goes on the socket"} meanwhile`,
    );
    leg.again = setTimeout(() => {
      leg.again = null;
      this.renegotiate(name, "kept failing");
    }, wait);
  }

  /** The network may have changed: a leg waiting for its next try, now. */
  private networkChanged() {
    if (this.stopped) return;
    for (const [leg, name] of [
      [this.replies, "replies"],
      [this.microphoneLeg, "microphone"],
    ] as const) {
      if (!leg.again) continue;
      clearTimeout(leg.again);
      leg.again = null;
      // A new network: its tries start again.
      leg.failures = 0;
      this.renegotiate(name, "may have a path on the new network");
    }
  }

  /** A line on the call's ICE, for the server's log and the trace. */
  private tellIce(line: string) {
    if (this.stopped) return;
    this.trace(line);
    this.channel.send({ op: "call_ice", call: this.id, line });
  }

  /** A leg's ICE path broke (a network change): a new session for it. */
  private renegotiate(name: "replies" | "microphone", why: string) {
    if (this.stopped) return;
    this.trace(`the ${name}' ICE connection ${why}: negotiating it again`);
    if (name === "replies") this.consume();
    else this.publish();
  }

  private dropLeg(leg: Leg) {
    if (leg.recover) clearTimeout(leg.recover);
    leg.recover = null;
    if (leg.again) clearTimeout(leg.again);
    leg.again = null;
    leg.connection = null;
    const session = leg.session;
    leg.session = null;
    session?.close();
  }

  /**
   * Traces the ICE path a leg took: candidate types, UDP or TCP, relayed
   * or not, and the addresses.
   */
  private async tracePath(connection: RTCPeerConnection, name: string) {
    // The pair is selected once nominated, which may follow "connected".
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const path = describePath(await connection.getStats());
        if (path) {
          this.tellIce(`${name}: ICE ${path}`);
          return;
        }
      } catch (error) {
        this.trace(`${name}: ICE path not read (${error})`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.stopped) return;
    }
    this.trace(`${name}: ICE path not reported`);
  }

  /**
   * The microphone's echo statistics as the browser reports them, every
   * ECHO_TRACE_MS, and the replies' jitter buffer, for their timing.
   */
  private watchEcho(connection: RTCPeerConnection) {
    if (this.echoTimer) clearInterval(this.echoTimer);
    const read = async () => {
      if (this.stopped || this.microphoneLeg.connection !== connection) return;
      try {
        const echo = describeEcho(await connection.getStats());
        if (echo) this.trace(`microphone: ${echo}`);
        else if (!this.echoTold)
          this.trace("microphone: the browser reports no echo return loss");
        this.echoTold = true;
      } catch {
        // Closed meanwhile.
      }
      const replies = this.replies.connection;
      if (replies) {
        const jitter = jitterMs(await replies.getStats().catch(() => null));
        if (jitter !== null) this.jitterMs = jitter;
      }
    };
    void read();
    this.echoTimer = setInterval(() => void read(), ECHO_TRACE_MS);
  }

  /**
   * The call's microphone while the call goes on and its capture is
   * live; null once the call stopped (its tracks stopped with it) or the
   * capture went (a device unplugged), when a listening opens its own.
   */
  liveMicrophone(): MediaStream | null {
    if (this.switching) return null;
    if (this.stopped) return null;
    const track = this.microphone?.getAudioTracks()[0];
    return track && track.readyState !== "ended" ? this.microphone : null;
  }

  /**
   * Whether the helper hears this page's microphone by WebRTC now: a
   * listening then asks for it (`listen` with `call`) and sends nothing on
   * the socket.
   */
  carriesMicrophone(): boolean {
    // The app's microphone: listenings ask for it, the page opens none.
    if (this.microphoneInApp()) return true;
    const state = this.microphoneLeg.connection?.iceConnectionState;
    return (
      !this.stopped &&
      this.microphoneHeard &&
      (state === "connected" || state === "completed")
    );
  }

  /**
   * Whether the replies are heard by WebRTC now: sentences then go into
   * the call's mix; otherwise they play here, as without a call.
   */
  carriesReplies(): boolean {
    if (this.appCarries("replies")) return !this.stopped;
    const state = this.replies.connection?.iceConnectionState;
    // Moving to another mode, the replies go on in the mix, unheard for
    // a few seconds: never played here meanwhile.
    return (
      !this.stopped &&
      (!!this.player.srcObject || this.switching) &&
      (state === "connected" || state === "completed")
    );
  }

  /**
   * Says in the call's trace what goes without it: the page listens on the
   * socket, or plays a reply itself, while the call carries no such leg.
   * Each once, until a leg connects again.
   */
  traceFallback(line: string) {
    if (this.stopped || this.fallbacks.has(line)) return;
    this.fallbacks.add(line);
    this.trace(line);
  }

  /** Where the call can play, and where it plays now. */
  async outputs(): Promise<CallOutputs> {
    if (this.appCarries("replies")) return this.appCallOutputs();
    const devices = await this.options.devices().catch(() => []);
    const using = this.microphone
      ?.getAudioTracks()[0]
      ?.getSettings?.().deviceId;
    return callOutputs(devices, using, this.mode);
  }

  /** Whether the call is moving to another mode now. */
  isSwitching(): boolean {
    return this.switching;
  }

  /** Says once where the call plays, and what else it could. */
  async traceOutputs() {
    const { choices, current } = await this.outputs();
    if (this.stopped) return;
    this.trace(
      choices.length
        ? `plays on the ${current ?? "default output"} (${this.mode} mode); can move to ${choices
            .map((choice) => choice.kind)
            .join(", ")}`
        : `plays on the default output (${this.mode} mode), no other offered`,
    );
  }

  /**
   * Moves the call to `output`: the microphone is opened again on that
   * device, which on Android routes the replies there too, and its new
   * track replaces the old in the stream and on the microphone's leg.
   * False when it could not (the old microphone goes on).
   */
  async useOutput(output: CallOutput): Promise<boolean> {
    if (this.appCarries("replies")) {
      // The app plays the call: it moves it, and tells where it went.
      if (this.stopped || !output.deviceId) return false;
      this.trace(`asking the Roamgate app to play on the ${output.kind}`);
      this.channel.send({
        op: "call_output",
        call: this.id,
        output: output.deviceId,
      });
      return true;
    }
    const stream = this.microphone;
    if (!stream || this.stopped || this.switching) return false;
    if (output.mode !== this.mode) return this.switchMode(output, stream);
    let opened: MediaStream;
    try {
      opened = await this.options.microphone({
        mode: output.mode,
        deviceId: output.deviceId,
      });
    } catch (error) {
      this.trace(`could not move to the ${output.kind}: ${error}`);
      return false;
    }
    const track = opened.getAudioTracks()[0];
    if (!track || this.stopped) {
      for (const each of opened.getTracks()) each.stop();
      return false;
    }
    await this.replaceMicrophone(stream, track);
    this.microphoneBack("opened again on another output");
    this.trace(`moved to the ${output.kind}`);
    callChanged();
    return true;
  }

  /**
   * Moves the call to `output` in its other mode: every capture of the
   * microphone stops (Android leaves communication mode with the last
   * one, and enters it with the first one opened with echo cancellation),
   * the replies stop playing, OUTPUT_CLOSE_MS pass for Chrome to close
   * their output, then the microphone opens in the new mode, the replies
   * play on an output made in it, and the microphone is published again,
   * telling the helper who cancels the echo now.
   */
  private async switchMode(
    output: CallOutput,
    stream: MediaStream,
  ): Promise<boolean> {
    const from = this.mode;
    this.switching = true;
    this.mode = output.mode;
    callChanged();
    this.trace(
      `moving to the ${output.kind}: ${output.mode === "speaker" ? "loudspeaker mode, the echo cancelled on the server" : "call mode, the phone cancelling the echo"}; the replies pause ${OUTPUT_CLOSE_MS / 1000} s`,
    );
    for (const track of stream.getAudioTracks()) {
      stream.removeTrack(track);
      track.stop();
    }
    this.sending?.stop();
    this.player.pause();
    this.player.srcObject = null;
    await sleep(OUTPUT_CLOSE_MS);
    let opened: MediaStream | null = null;
    if (!this.stopped) {
      try {
        opened = await this.options.microphone({
          mode: output.mode,
          deviceId: output.deviceId,
        });
      } catch (error) {
        this.trace(`could not move to the ${output.kind}: ${error}`);
        this.mode = from;
        opened = await this.options
          .microphone({ mode: from })
          .catch(() => null);
      }
    }
    this.switching = false;
    const track = opened?.getAudioTracks()[0];
    if (this.stopped || !track) {
      for (const each of opened?.getTracks() ?? []) each.stop();
      if (!this.stopped) this.trace("no microphone after the move");
      callChanged();
      return false;
    }
    stream.addTrack(track);
    this.watchTrack();
    this.microphoneBack("opened again on another output");
    this.playReplies();
    // Published again: call_microphone tells the helper the new mode.
    this.publish();
    if (this.mode === output.mode) this.trace(`moved to the ${output.kind}`);
    callChanged();
    return this.mode === output.mode;
  }

  /** Lets the microphone out while listening, and only then. */
  listening(on: boolean) {
    if (on !== this.listeningNow) {
      // Its capture is measured from the next check on.
      this.captured = null;
      this.silentChecks = 0;
    }
    this.listeningNow = on;
    if (this.sending) this.sending.enabled = on;
  }

  /**
   * When `speech` ends, heard here (performance.now() time): its end in the
   * mix, the playout's delay and jitter buffer, the output's latency, and
   * RELEASE_MARGIN_MS for what is not reported.
   */
  private heardEnd(speech: QueuedSpeech, receivedAt: number): number {
    const now = speech.now_ms ?? speech.start_ms;
    const latency = this.options.outputLatency();
    return (
      receivedAt +
      speech.start_ms +
      speech.duration_ms -
      now +
      PLAYOUT_MS +
      this.jitterMs +
      (Number.isFinite(latency) && latency > 0 ? latency * 1000 : 0) +
      RELEASE_MARGIN_MS
    );
  }

  /** Whether `speech`, answered at `receivedAt`, is over by now. */
  over(speech: QueuedSpeech, receivedAt: number): boolean {
    return performance.now() >= this.heardEnd(speech, receivedAt);
  }

  /** The voice the helper still had to send goes (the user talks). */
  hush() {
    if (!this.stopped) this.channel.send({ op: "call_hush" });
  }

  /**
   * Plays a queued sentence, answered at `receivedAt`: resolves once its
   * end is heard, or `signal` aborts (the voice still queued is dropped).
   */
  playQueued(
    speech: QueuedSpeech,
    receivedAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        if (!this.over(speech, receivedAt)) this.hush();
        finish();
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      // How much of the reply the microphone heard back, measured over it.
      const before = this.echoLevels();
      const wait = () => {
        const left = this.heardEnd(speech, receivedAt) - performance.now();
        if (this.stopped || left <= 0) {
          if (!signal.aborted) void this.traceReplyEcho(before);
          return finish();
        }
        timer = setTimeout(wait, Math.min(left, 250));
      };
      wait();
    });
  }

  /** The echo statistics now, when both legs carry. */
  private async echoLevels(): Promise<EchoLevels | null> {
    const microphone = this.microphoneLeg.connection;
    const replies = this.replies.connection;
    if (!microphone || !replies) return null;
    try {
      const [heard, played] = await Promise.all([
        microphone.getStats(),
        replies.getStats(),
      ]);
      return echoLevels(heard, played);
    } catch {
      return null;
    }
  }

  /**
   * Says how loud a reply came, how loud the microphone was meanwhile, and
   * the browser's echo return loss: whether the echo canceller kept the
   * reply out of what the Mac hears.
   */
  private async traceReplyEcho(before: Promise<EchoLevels | null>) {
    const [from, to] = await Promise.all([before, this.echoLevels()]);
    if (!from || !to || this.stopped) return;
    const echo = describeReplyEcho(from, to);
    if (echo) this.trace(`reply heard: ${echo}`);
  }

  /**
   * A chat rebuilt opens a new link (VoiceLink): the call is controlled
   * from it (`call_resume`); its WebRTC legs go on untouched. False when it
   * cannot (the call over): a new call then.
   */
  async adopt(channel: CallChannel): Promise<boolean> {
    if (this.stopped || !this.token) return false;
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
      channel.send({ op: "call_resume", call: this.id, resume: this.token });
    });
    if (this.stopped) return false;
    if (answer?.resumed !== true) {
      this.trace(
        `not moved to the new link (${answer ? String(answer.error) : "no answer"})`,
      );
      this.stop();
      return false;
    }
    for (const stop of this.unlisten.splice(0)) stop();
    this.channel = channel;
    this.listen();
    // Told while no link heard it.
    if (typeof answer.waiting === "boolean") this.musicWaits(answer.waiting);
    // The link it left may close now.
    for (const done of this.released.splice(0)) done();
    this.trace("goes on on the rebuilt chat's link");
    if (
      typeof answer.restarts === "number" &&
      answer.restarts !== this.restarts
    ) {
      // The helper restarted while no link heard it: its signalling server
      // is new, and the legs follow the signalling opened again.
      this.restarts = answer.restarts;
      this.microphoneHeard = false;
      this.trace("the voice helper restarted meanwhile: the call starts again");
      const api = this.api;
      if (api) closeApi(api);
    } else if (this.clientId && this.producer?.state === STREAMING)
      // The helper may have to hear the microphone again from this link.
      channel.send({
        op: "call_microphone",
        peer: this.clientId,
        echo: this.echoBy(),
      });
    return true;
  }

  /**
   * Its link closes: stopped after RELEASE_MS unless a new link took it
   * (adopt), as a chat being rebuilt does. `done` is told once it stopped
   * (its end sent on `channel`) or moved: the link's socket closes then.
   */
  release(channel: CallChannel, done: () => void = () => {}) {
    if (this.stopped || channel !== this.channel) return done();
    this.released.push(done);
    if (this.releasing) return;
    this.releasing = setTimeout(() => {
      this.releasing = null;
      this.stop();
    }, RELEASE_MS);
  }

  /**
   * Whether the call's microphone is the Android app's: it carries it, or
   * this page in its WebView, with no microphone of its own, hands it the
   * call. The page opens no capture meanwhile.
   */
  microphoneInApp(): boolean {
    if (this.stopped) return false;
    if (this.appCarries("microphone")) return true;
    return (
      this.options.app.embedded() &&
      this.handingOff() &&
      !this.microphone?.getAudioTracks().length
    );
  }

  /** Whether the Android app carries `leg` of the call now. */
  appCarries(leg: CarriedLeg): boolean {
    return this.carrier?.legs.has(leg) === true;
  }

  /** Whether the Android app carries any of the call now. */
  inApp(): boolean {
    return this.carrier !== null;
  }

  /** Whether the call may be handed to the Android app on this phone. */
  canHandOff(): boolean {
    return (
      !this.stopped &&
      !this.carrier &&
      !this.handoffTimer &&
      !this.bridgeFailed &&
      this.options.app.known()
    );
  }

  /**
   * Hands the call to the Android app: a token asked for, then the app
   * opened with it (handoffAnswered). It joins within HANDOFF_WAIT_MS, or
   * the call goes on here.
   */
  handOff() {
    if (this.stopped || this.carrier) return;
    this.trace("handing the call to the Roamgate app");
    this.channel.send({ op: "call_handoff", call: this.id });
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      if (this.stopped || this.carrier) return;
      const forgotten = this.options.app.missed();
      this.trace(
        `the Roamgate app did not take the call: it goes on here${forgotten ? " (the app is taken for gone)" : ""}`,
      );
      this.options.notice(
        "The Roamgate app did not take the call: it goes on here.",
      );
      void this.takeMicrophoneBack();
      callChanged();
    }, HANDOFF_WAIT_MS);
    callChanged();
  }

  /** The server's token for the handoff: the app opens with it. */
  private handoffAnswered(event: ChannelEvent) {
    const handoff = event.handoff;
    if (typeof handoff !== "string" || !handoff) {
      this.trace(`no handoff to the Roamgate app: ${String(event.error)}`);
      if (this.options.app.embedded()) {
        // The call goes on here, with the page's microphone.
        if (this.handoffTimer) clearTimeout(this.handoffTimer);
        this.handoffTimer = null;
        void this.takeMicrophoneBack();
        callChanged();
      }
      return;
    }
    if (this.stopped || this.carrier) return;
    if (!this.options.app.embedded()) {
      this.options.app.open(handoffIntentUrl(location.href, this.id, handoff));
      return;
    }
    try {
      this.options.app.handOff(String(this.id), handoff);
    } catch (error) {
      if (this.handoffTimer) clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
      this.bridgeFailed = true;
      this.trace(
        `the Roamgate app could not take the call (${String(error)}): it goes on here`,
      );
      this.options.notice(
        "The Roamgate app could not take the call: it goes on here.",
      );
      void this.takeMicrophoneBack();
      callChanged();
    }
  }

  /**
   * Whether this page runs in the app's own WebView, which takes the call
   * by itself: no button hands it there.
   */
  inAppWebView(): boolean {
    return this.options.app.embedded();
  }

  /** Whether a handoff to the app is being waited for. */
  handingOff(): boolean {
    return this.handoffTimer !== null;
  }

  /**
   * The app carries `legs` of the call: the page lets them go (its
   * microphone closed, the replies not played here) and the screen may
   * turn off; told again when the helper hears its microphone (`heard`).
   */
  private carriedBy(event: ChannelEvent) {
    if (this.stopped) return;
    const told = event.legs;
    const legs = new Set<CarriedLeg>(
      Array.isArray(told)
        ? told.filter(
            (leg): leg is CarriedLeg =>
              leg === "microphone" || leg === "replies",
          )
        : [],
    );
    if (!legs.size) return;
    const before = this.carrier;
    this.carrier = {
      legs,
      heard: event.heard === true,
      outputs: before?.outputs ?? null,
    };
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
    if (!before) {
      this.options.app.took();
      this.trace(`the Roamgate app carries the ${[...legs].join(" and ")}`);
      const lock = this.screenLock;
      this.screenLock = null;
      void lock?.release().catch(() => {});
    }
    if (legs.has("microphone") && !before?.legs.has("microphone"))
      this.letMicrophoneGo();
    if (legs.has("replies") && !before?.legs.has("replies")) {
      this.dropLeg(this.replies);
      this.player.pause();
      this.player.srcObject = null;
    }
    callChanged();
  }

  /** The app has the microphone: the page's is closed, its leg dropped. */
  private letMicrophoneGo() {
    if (this.republishing) clearTimeout(this.republishing);
    this.republishing = null;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    const old = this.producer;
    this.producer = null;
    old?.close();
    this.sending?.stop();
    this.sending = null;
    this.dropLeg(this.microphoneLeg);
    this.microphoneHeard = false;
    this.unwatchTrack?.();
    this.unwatchTrack = null;
    const stream = this.microphone;
    for (const track of stream?.getAudioTracks() ?? []) {
      stream?.removeTrack(track);
      track.stop();
    }
    if (this.microphonePause) {
      this.microphonePause = null;
      this.options.microphonePaused(false);
    }
  }

  /** The app gave the call back: the page takes its legs again. */
  private carrierLeft(why: string) {
    const carrier = this.carrier;
    if (!carrier || this.stopped) return;
    this.carrier = null;
    this.trace(`the Roamgate app gave the call back (${why}): it goes on here`);
    if (carrier.legs.has("replies")) {
      this.consume();
      this.playReplies();
    }
    if (carrier.legs.has("microphone")) void this.takeMicrophoneBack();
    void this.holdScreen();
    callChanged();
  }

  /**
   * Opens the page's microphone (again), and publishes it: the app gave
   * the call back, or never took it. Nothing when it is open already.
   */
  private async takeMicrophoneBack() {
    const stream = this.microphone;
    if (
      !stream ||
      this.stopped ||
      this.takingBack ||
      this.appCarries("microphone") ||
      stream.getAudioTracks().some((track) => track.readyState !== "ended")
    )
      return;
    this.takingBack = true;
    try {
      const opened = await this.options.microphone({ mode: this.mode });
      const track = opened.getAudioTracks()[0];
      if (!track || this.stopped || this.appCarries("microphone")) {
        for (const each of opened.getTracks()) each.stop();
        return;
      }
      stream.addTrack(track);
      this.watchTrack();
      this.publish();
    } catch (error) {
      this.trace(`the microphone did not open again: ${error}`);
    } finally {
      this.takingBack = false;
    }
  }

  /** Where the app plays the call, as it says. */
  private appOutputs(event: ChannelEvent) {
    if (!this.carrier) return;
    const { current, outputs } = event;
    this.carrier.outputs = {
      current: typeof current === "string" ? current : null,
      outputs: Array.isArray(outputs)
        ? outputs.filter(
            (each): each is AppOutput =>
              !!each &&
              typeof each.id === "string" &&
              OUTPUT_ORDER.includes(each.kind),
          )
        : [],
    };
    callChanged();
  }

  /** The app's outputs as the page's (their id as the device). */
  private appCallOutputs(): CallOutputs {
    const told = this.carrier?.outputs;
    if (!told || told.outputs.length < 2) return { choices: [], current: null };
    return {
      choices: told.outputs.map((each) => ({
        kind: each.kind,
        mode: this.mode,
        deviceId: each.id,
      })),
      current:
        told.outputs.find((each) => each.id === told.current)?.kind ?? null,
    };
  }

  stop() {
    if (this.releasing) clearTimeout(this.releasing);
    this.releasing = null;
    if (this.stopped) return;
    this.stopped = true;
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
    if (active === this) {
      active = null;
      callChanged();
    }
    if (this.retry) clearTimeout(this.retry);
    if (this.republishing) clearTimeout(this.republishing);
    if (this.echoTimer) clearInterval(this.echoTimer);
    if (this.microphoneTimer) clearInterval(this.microphoneTimer);
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.unwatchTrack?.();
    this.unwatchTrack = null;
    // The screen may turn off again at hang-up.
    const lock = this.screenLock;
    this.screenLock = null;
    void lock?.release().catch(() => {});
    if (this.microphonePause) {
      this.microphonePause = null;
      this.options.microphonePaused(false);
    }
    for (const stop of this.unlisten.splice(0)) stop();
    this.channel.send({ op: "call_audio", on: false, call: this.id });
    // Its end sent: a link let go may close its socket.
    for (const done of this.released.splice(0)) done();
    this.dropLeg(this.replies);
    this.dropLeg(this.microphoneLeg);
    this.producer?.close();
    this.producer = null;
    this.sending?.stop();
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    const api = this.api;
    this.api = null;
    if (api) closeApi(api);
    this.player.pause();
    this.player.srcObject = null;
    this.trace("over");
  }
}

type Stats = Map<string, Record<string, unknown>> | RTCStatsReport;

function entries(stats: Stats): Record<string, unknown>[] {
  const all: Record<string, unknown>[] = [];
  stats.forEach((entry) => all.push(entry as Record<string, unknown>));
  return all;
}

/**
 * The selected candidate pair of `stats`, said: "host udp 100.76.190.105:
 * 50123 (vpn) -> host 100.71.231.65:40012, not relayed".
 */
export function describePath(stats: Stats): string | null {
  const all = entries(stats);
  const byId = new Map(all.map((entry) => [String(entry.id), entry]));
  const transport = all.find(
    (entry) => entry.type === "transport" && entry.selectedCandidatePairId,
  );
  const pair =
    (transport && byId.get(String(transport.selectedCandidatePairId))) ??
    all.find(
      (entry) =>
        entry.type === "candidate-pair" &&
        entry.state === "succeeded" &&
        (entry.nominated === true || entry.selected === true),
    );
  if (!pair) return null;
  const local = byId.get(String(pair.localCandidateId));
  const remote = byId.get(String(pair.remoteCandidateId));
  if (!local || !remote) return null;
  // Browsers may keep their own address to themselves: its port then.
  const where = (candidate: Record<string, unknown>) => {
    const address = candidate.address ?? candidate.ip;
    return address
      ? `${String(address)}:${String(candidate.port ?? "?")}`
      : `port ${String(candidate.port ?? "?")}`;
  };
  const relay =
    local.candidateType === "relay" || remote.candidateType === "relay";
  const network =
    local.networkType && local.networkType !== "unknown"
      ? ` (${String(local.networkType)})`
      : "";
  const over = local.relayProtocol
    ? ` over ${String(local.relayProtocol)}`
    : "";
  return `${String(local.candidateType)} ${String(local.protocol)} ${where(local)}${network} -> ${String(remote.candidateType)} ${String(remote.protocol ?? local.protocol)} ${where(remote)}, ${relay ? `relayed${over}` : "not relayed"}`;
}

/** A candidate, said: "host udp 100.76.190.105:50123 (vpn)". */
function describeCandidate(candidate: Record<string, unknown>): string {
  const address = candidate.address ?? candidate.ip;
  const where = address
    ? `${String(address)}:${String(candidate.port ?? "?")}`
    : `port ${String(candidate.port ?? "?")}`;
  const network =
    candidate.networkType && candidate.networkType !== "unknown"
      ? ` (${String(candidate.networkType)})`
      : "";
  const tcp = candidate.tcpType ? ` ${String(candidate.tcpType)}` : "";
  return `${String(candidate.candidateType)} ${String(candidate.protocol)}${tcp} ${where}${network}`;
}

/** The candidate pairs said at most, the busiest first. */
const FAILURE_PAIRS = 8;

/**
 * What a failed leg tried, from its `stats`: its own candidates, the
 * helper's, and each pair with what it sent and got back ("sent 9, got
 * 0 back, heard 0"), the busiest first. A pair that sent and got nothing
 * back never reached the helper's address, or the answers never came.
 */
export function describeFailure(stats: Stats): string | null {
  const all = entries(stats);
  const byId = new Map(all.map((entry) => [String(entry.id), entry]));
  const local = all.filter((entry) => entry.type === "local-candidate");
  const remote = all.filter((entry) => entry.type === "remote-candidate");
  const pairs = all
    .filter((entry) => entry.type === "candidate-pair")
    .sort((a, b) => Number(b.requestsSent ?? 0) - Number(a.requestsSent ?? 0));
  if (!local.length && !remote.length && !pairs.length) return null;
  const said = pairs.slice(0, FAILURE_PAIRS).map((pair) => {
    const from = byId.get(String(pair.localCandidateId));
    const to = byId.get(String(pair.remoteCandidateId));
    return `${from ? describeCandidate(from) : "?"} -> ${to ? describeCandidate(to) : "?"} ${String(pair.state)}, sent ${Number(pair.requestsSent ?? 0)}, got ${Number(pair.responsesReceived ?? 0)} back, heard ${Number(pair.requestsReceived ?? 0)}`;
  });
  return [
    `here: ${local.map(describeCandidate).join(", ") || "none"}`,
    `helper: ${remote.map(describeCandidate).join(", ") || "none"}`,
    `pairs: ${said.join("; ") || "none"}${pairs.length > FAILURE_PAIRS ? ` (and ${pairs.length - FAILURE_PAIRS} more)` : ""}`,
  ].join("; ");
}

/** The microphone's echo return loss and its enhancement, when reported. */
export function describeEcho(stats: Stats): string | null {
  const source = entries(stats).find(
    (entry) =>
      entry.type === "media-source" &&
      entry.kind === "audio" &&
      (typeof entry.echoReturnLoss === "number" ||
        typeof entry.echoReturnLossEnhancement === "number"),
  );
  if (!source) return null;
  const db = (value: unknown) =>
    typeof value === "number" ? `${value.toFixed(1)} dB` : "not reported";
  return `echoReturnLoss ${db(source.echoReturnLoss)}, echoReturnLossEnhancement ${db(source.echoReturnLossEnhancement)}`;
}

/** Running audio energies of both legs, and the echo return loss. */
export type EchoLevels = {
  microphone: { energy: number; seconds: number } | null;
  replies: { energy: number; seconds: number } | null;
  echoReturnLoss?: number;
  echoReturnLossEnhancement?: number;
};

/** The microphone leg's running energy as sent, when reported. */
export function microphoneEnergy(
  stats: Stats,
): { energy: number; seconds: number } | null {
  return echoLevels(stats, new Map()).microphone;
}

/** What `heard` (the microphone leg) and `played` (the replies) report. */
export function echoLevels(heard: Stats, played: Stats): EchoLevels {
  const running = (entry: Record<string, unknown> | undefined) =>
    typeof entry?.totalAudioEnergy === "number" &&
    typeof entry.totalSamplesDuration === "number"
      ? {
          energy: entry.totalAudioEnergy,
          seconds: entry.totalSamplesDuration,
        }
      : null;
  const source = entries(heard).find(
    (entry) => entry.type === "media-source" && entry.kind === "audio",
  );
  const inbound = entries(played).find(
    (entry) => entry.type === "inbound-rtp" && entry.kind === "audio",
  );
  return {
    microphone: running(source),
    replies: running(inbound),
    ...(typeof source?.echoReturnLoss === "number"
      ? { echoReturnLoss: source.echoReturnLoss }
      : {}),
    ...(typeof source?.echoReturnLossEnhancement === "number"
      ? { echoReturnLossEnhancement: source.echoReturnLossEnhancement }
      : {}),
  };
}

/**
 * Over a reply, from `from` to `to`: its level as received, the
 * microphone's level meanwhile, how far below the reply that is, and the
 * echo return loss at its end. Null when a leg reports no levels.
 */
export function describeReplyEcho(
  from: EchoLevels,
  to: EchoLevels,
): string | null {
  const level = (
    a: EchoLevels["microphone"],
    b: EchoLevels["microphone"],
  ): number | null => {
    if (!a || !b || b.seconds - a.seconds <= 0) return null;
    const power = (b.energy - a.energy) / (b.seconds - a.seconds);
    return 10 * Math.log10(Math.max(power, 1e-10));
  };
  const replies = level(from.replies, to.replies);
  const microphone = level(from.microphone, to.microphone);
  if (replies === null || microphone === null) return null;
  const db = (value: number | undefined) =>
    value === undefined ? "not reported" : `${value.toFixed(1)} dB`;
  return `the reply at ${replies.toFixed(1)} dBFS, the microphone at ${microphone.toFixed(1)} dBFS meanwhile (${(replies - microphone).toFixed(1)} dB below it), echoReturnLoss ${db(to.echoReturnLoss)}, echoReturnLossEnhancement ${db(to.echoReturnLossEnhancement)}`;
}

/** The received audio's jitter buffer delay, in ms, if reported. */
export function jitterMs(stats: Stats | null): number | null {
  if (!stats) return null;
  const inbound = entries(stats).find(
    (entry) => entry.type === "inbound-rtp" && entry.kind === "audio",
  );
  const delay = inbound?.jitterBufferDelay;
  const count = inbound?.jitterBufferEmittedCount;
  if (typeof delay !== "number" || typeof count !== "number" || count <= 0)
    return null;
  return (delay / count) * 1000;
}
