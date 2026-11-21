import { serverLogger } from "../utils/logger";
import type { CleanSession, VoiceCleaner } from "../voice/voice-cleaner";
import {
  type Dictated,
  dictated,
  dictationSession,
  dictationTarget,
} from "../voice/voice-dictation";
import {
  CALL_REPLY_LOUDNESS,
  type CallBackground,
  type CallHandle,
  type ListenOptions,
  LONGEST_PAUSE_MS,
  MAX_PAUSE_MS,
  maxPauseMs,
  type VoiceEvent,
  type VoiceHelper,
  type VoiceSession,
} from "../voice/voice-helper";

/**
 * /api/voice/ws: a browser streams its microphone to the voice helper and
 * hears back when speech starts and what was said.
 *
 * From the browser, JSON: `{"op": "listen", "hold": true, "language": "es",
 * "end_silence_ms": 2500, "new_speaker": true}` starts a session (ending
 * the one before; with `new_speaker`, whoever speaks first is the voice
 * kept from then on),
 * With a cleaner set up, `"context"` (the conversation's end) goes with it
 * and what was said is cleaned before it is told:
 * `{"event": "final", "text": "clean", "raw": "as heard", "for_agent": false}`.
 * `{"op": "release"}`, `{"op": "finish"}` and `{"op": "stop"}` act on it;
 * binary messages are its audio, 16 kHz mono S16LE. To the browser, JSON:
 * `{"event": "listening", "session": 4, "resume": "token"}`, then the
 * helper's events for it (`speech_start`, `text`, `final`, `error`).
 *
 * A session outlives its socket: a phone changing networks drops the
 * socket mid-sentence, and what was heard must not go with it. Detached,
 * the session waits DETACHED_MS for `{"op": "resume", "session": 4,
 * "resume": "token"}` on a new socket, which gets `{"event": "resumed",
 * "received": bytes}` (the audio that came, for the page to send the rest
 * again) and the events it missed, then goes on streaming; past that, it ends
 * the utterance (`finish`) and keeps its text KEPT_MS for a late resume.
 * A socket that sends no audio for STALL_MS while listening is taken as
 * gone the same way: a stalled stream is neither silence nor the end of a
 * sentence, and it does not hold the session forever either. Any message
 * from it brings it what it missed.
 *
 * `{"event": "error", "session": 4, "recoverable": true}` says the helper
 * stopped under the session: it is over (never finished), and the page
 * listens again.
 *
 * When the voice sounds finished but the words do not, a pause of
 * `max_pause_ms` (voice.json, MAX_PAUSE_MS by default) ends the utterance;
 * any pause ends it at LONGEST_PAUSE_MS (SilenceCap).
 *
 * A call (voice/helper/src/call.rs) is a WebRTC call between the page and
 * the voice helper, signalled with GStreamer's WebRTC signalling protocol:
 * `{"op": "call_audio", "on": true}` starts it, answered `{"event":
 * "call_audio", "call": 7, "resume": "token", "music": true, "webrtc":
 * true}`. The page then opens
 * /api/voice/call/signalling?call=7&call_token=... (signalling below; not
 * `token`, the generated login token's parameter), which fronts the
 * helper's signalling server for that
 * call: it consumes the producer whose meta is `{"call": 7, "role":
 * "replies"}` (the replies mixed with voice.json's `call_background`), and
 * publishes its microphone, telling its peer id with `{"op":
 * "call_microphone", "peer": "<id>", "echo": "here"}` (`"echo": "here"`
 * when it plays the replies without its own echo canceller, its
 * loudspeaker mode: the helper cancels their echo; answered `{"event":
 * "call_microphone", "call": 7, "ok": true}`, or an `error`). A `listen`
 * with `"call": 7` then hears that microphone instead of the socket's
 * audio; the helper says how much came (`audio` events, kept here), which
 * times the pauses as the socket's audio does. Speech asked for that call
 * (POST /api/voice/speak with `"call": 7`) goes into the mix. With a helper
 * that cannot, the answer is `{"event": "call_audio", "error": "..."}` and
 * the page plays each sentence itself and streams its microphone here.
 * `{"op": "call_hush"}` drops the voice queued in the mix (the user talks
 * over it); `{"op": "call_audio", "on": false}` ends it. The call follows
 * the socket's resume: `{"op": "call_resume", "call": 7, "resume":
 * "token"}` on a new socket within DETACHED_MS moves it there (`{"event":
 * "call_audio", "call": 7, "resumed": true, "restarts": 1, "waiting":
 * false}`, with how many times a restarted helper made it again so far);
 * past that, it stops. Its
 * WebRTC media does not go through the socket and goes on meanwhile.
 * `{"event": "call_error", "error": "..."}` says the background or the
 * microphone failed (the call goes on); `{"event": "call_restarted",
 * "call": 7, "restarts": 1}` says a restarted helper made it again, with a
 * new signalling server: the page's signalling sockets are closed, and it
 * opens them again. A helper that cannot make it again ends it
 * (`call_audio` with an `error`). `{"event": "call_music", "call": 7,
 * "waiting": true}` says the call's music waits, silent, while the helper
 * learns the speaker's voice, and `"waiting": false` that it may play; the
 * call's answer and a resume's answer say it too (`"waiting"`), as it may
 * be told before the page set the call up, or while no socket held it.
 * `{"op": "call_audio", "on": false, "call": 7}` ends that call only.
 * `{"op": "call_ice", "line": "..."}` is the page's word on a leg's ICE
 * path: the pair it took, or why it failed (its candidates, what each
 * pair sent and got back). Logged always, ROAMGATE_VOICE_DEBUG or not, at
 * most CALL_ICE_LINES lines a call, so a call that fails on the road tells
 * why afterwards.
 *
 * A call can be carried by the Roamgate Android app (its native call
 * service keeps the microphone with the screen off, which Chrome does
 * not): the owning page asks `{"op": "call_handoff", "call": 7}`, answered
 * `{"event": "call_handoff", "call": 7, "handoff": "<token>",
 * "expires_ms": 60000}`, a single-use token the app exchanges at POST
 * /api/voice/call/handoff (redeemHandoff) for the call's carrier token and
 * a login. On its own socket the app then sends `{"op": "call_carry",
 * "call": 7, "carrier": "<token>", "legs": ["microphone"]}` (answered
 * `call_carry`, with `"replies_peer"`: the peer id of the helper's replies
 * producer, null until it registered; a later or changed one is told
 * `{"event": "call_replies_peer", "call": 7, "peer": "<id>"}`, learned by
 * a listener on the call's signalling server from the handoff on), signals
 * with `call_token=<carrier token>` (as many sockets as it needs: one for
 * its webrtcsink, one for its webrtcsrc), and may send
 * `call_microphone`, `call_ice`, `call_output_state` and `call_audio` off
 * (hang-up). The page, still the call's owner, is told `{"event":
 * "call_carrier", "call": 7, "state": "joined", "legs": [...], "heard":
 * true}` and lets the legs the app carries go; `"state": "left"` gives
 * them back (`call_carry_end`, a newer carrier, or the app's socket gone
 * DETACHED_MS). `call_output` from the page goes to the app, its
 * `call_output_state` to the page. The page's Mute (nothing listened to,
 * replies still read) is the app's too: the page reports it `{"op":
 * "call_mute_state", "call": 7, "muted": true}`, each change told to the
 * app `{"event": "call_mute", "call": 7, "muted": true}` (and once right
 * after its call_carry answer); the app's `{"op": "call_mute", "call": 7,
 * "muted": true}` goes to the page as that same event, which mutes as its
 * button does and reports it. docs/ARCHITECTURE.md tells it all.
 *
 * A listening on a call's microphone whose stream stops for STALL_MS stays
 * on its socket, which is alive: the page is told `{"event": "stalled",
 * "session": 4}`, and past DETACHED_MS more the utterance ends with what
 * was heard.
 */
/** The voice's timing lines (debug). */
const voiceLog = serverLogger.child("voice");

export type VoiceSocket = {
  send: (message: string) => unknown;
};

/** A page's signalling socket (Bun's ServerWebSocket). */
export type SignallingSocket = {
  send: (message: string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

/** The socket to the helper's signalling server (a WebSocket client). */
export type UpstreamSocket = {
  readonly readyState: number;
  send: (message: string) => unknown;
  close: () => unknown;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

/**
 * Whether a socket's opening comes from this site, as the bridge checks
 * its other state-changing requests: browsers say `Sec-Fetch-Site`, and a
 * page elsewhere is refused even with the user's cookie. (No Origin
 * comparison: it breaks behind reverse proxies.)
 */
export function sameSiteSocket(req: Request): boolean {
  return req.headers.get("sec-fetch-site") !== "cross-site";
}

/** What a page's signalling socket messages keep, waiting for upstream. */
const SIGNALLING_QUEUE = 256;

/**
 * The helper's ICE candidates on 127.0.0.1, given to the page with
 * `address` (voice.json's `call_ice_address`): Tailscale's userspace
 * networking forwards UDP sent to this machine's Tailscale address to
 * 127.0.0.1 on the same port, where the helper's agents listen. Candidates
 * in SDP (`a=candidate:`) and trickled ones (`ice.candidate`) alike; other
 * messages go unchanged.
 */
export function rewriteCandidates(text: string, address: string | null) {
  if (!address) return text;
  const swap = (candidate: string) =>
    candidate.replace(
      /^((?:a=)?candidate:\S+ \d+ udp \d+ )127\.0\.0\.1( \d+ typ host)/i,
      `$1${address}$2`,
    );
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text);
  } catch {
    return text;
  }
  if (message.type !== "peer") return text;
  const ice = message.ice as { candidate?: unknown } | undefined;
  if (ice && typeof ice.candidate === "string") {
    const candidate = swap(ice.candidate);
    if (candidate === ice.candidate) return text;
    return JSON.stringify({ ...message, ice: { ...ice, candidate } });
  }
  const sdp = message.sdp as { sdp?: unknown } | undefined;
  if (sdp && typeof sdp.sdp === "string") {
    const lines = sdp.sdp.split("\r\n").map(swap);
    const changed = lines.join("\r\n");
    if (changed === sdp.sdp) return text;
    return JSON.stringify({ ...message, sdp: { ...sdp, sdp: changed } });
  }
  return text;
}

/** What of a call the Android app may carry instead of the page. */
export type CarriedLeg = "microphone" | "replies";
const CARRIED_LEGS: readonly CarriedLeg[] = ["microphone", "replies"];
/**
 * What an output may be, as the page draws it (CallOutputKind). Only a
 * kind is checked here: the app picks the echo for each (`"echo":
 * "here"` on the loudspeaker and on "bluetooth-music", a headset's media
 * profile with the phone's own microphone), and the music goes with the
 * replies wherever they play.
 */
const OUTPUT_KINDS = new Set([
  "speaker",
  "earpiece",
  "bluetooth",
  "bluetooth-music",
  "wired",
  "usb",
]);
/** How long a handoff token may be redeemed. */
export const HANDOFF_MS = 60_000;

/** The Android app carrying a call (call_carry), or about to. */
type Carrier = {
  token: string;
  ws: VoiceSocket | null;
  legs: CarriedLeg[];
  /** It sent call_carry: the page was told it took its legs. */
  joined: boolean;
  /** The helper listens to its microphone. */
  heard: boolean;
  /** Its last call_output_state, as relayed to the page. */
  outputs: Record<string, unknown> | null;
  /** The replies producer it was last told (call_carry, call_replies_peer). */
  toldPeer?: string | null;
  /** Never joined, or its socket gone: it lets the call go. */
  timer: ReturnType<typeof setTimeout> | null;
};

/** A call, and the socket that owns it, if any. */
type CallState = {
  /** The Android app carrying some of its legs, if any. */
  carrier?: Carrier | null;
  handle: CallHandle | null;
  token: string;
  ws: VoiceSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Times a restarted helper made it again: told on call_resume too. */
  restarts: number;
  /** The page's ICE lines logged for it (`call_ice`). */
  iceLines?: number;
  /** Who the replies' producer is, watched while the app carries it. */
  replies?: RepliesWatch | null;
  /** The page's Mute, as it last reported it (call_mute_state). */
  muted?: boolean;
  /** Watches the replies again after the helper's server closed. */
  repliesRetry?: ReturnType<typeof setTimeout> | null;
};

/**
 * A listener on the call's signalling server (a peer with the `listener`
 * role): it learns the peer id of the helper's replies producer (meta
 * `{"call": 7, "role": "replies"}`) from `list` and `peerStatusChanged`,
 * for the Android app's webrtcsrc to consume it by id.
 */
type RepliesWatch = {
  upstream: UpstreamSocket;
  /** The replies producer's peer id, once registered. */
  peer: string | null;
};

/** How long after the helper's server closed its replies are watched again. */
export const REPLIES_WATCH_RETRY_MS = 1000;

/** A page's signalling socket and its way to the helper. */
type Signalling = {
  call: CallState;
  /** Opened with the carrier's token: the app's, closed when it leaves. */
  carrier?: Carrier;
  upstream: UpstreamSocket | null;
  /** What the page said before the helper's socket opened. */
  queue: string[];
};

/** A 256-bit random token, URL-safe. */
const randomToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** The reason given to a call a newer one stops. */
const REPLACED_CALL = "Replaced by a newer call";
/** How long a session whose socket went waits for it to come back. */
export const DETACHED_MS = 20_000;
/** How long what a detached session heard is kept, once it ended. */
export const KEPT_MS = 120_000;
/** No audio this long from a socket that listens: it is gone. */
export const STALL_MS = 5_000;
/**
 * How finished the voice must sound (speechgate's `turn`, Smart Turn) for
 * MAX_PAUSE_MS to apply. Finished sentences scored 0.67 and 0.86 at 2.5
 * and 3.5 s of pause; pauses mid-thought, looking for a word, 0.01 to 0.16.
 */
export const TURN_SOUNDS_FINISHED = 0.5;
/**
 * The helper reads the words this far into a pause (speechgate's
 * EARLY_READ): the first `partial` with `pause` comes this late, when the
 * helper does not say (`pause_ms`).
 */
const FIRST_PAUSE_READ_MS = 500;
/** 16 kHz mono S16LE. */
const BYTES_PER_MS = 32;
/**
 * Words said while looking for the next ones: words ending with one are
 * not finished, whatever the models say. speechgate knows most of them,
 * and also takes a short voice that added no word for one (`thinking`).
 * Parakeet writes a trailing "euh" as "eux" ("je pense que eux."): taken
 * for one here, it only keeps a vetoed turn open longer.
 */
const FILLERS = new Set([
  "um",
  "umm",
  "uh",
  "uhh",
  "uhm",
  "er",
  "erm",
  "hmm",
  "hm",
  "mm",
  "euh",
  "eux",
  "heu",
  "hum",
  "eh",
  "ben",
  "bah",
  "alors",
  "em",
]);

/**
 * The longest pause after a question asked whole: words ending in "?", in
 * a voice that sounded finished. A short noise that added no word (a car,
 * the street) is taken for the speaker thinking, which held "Compagnon,
 * est-ce que tu m'entends ?" for 18 s on a call from a car: a question
 * asked waits for its answer, not for more words.
 */
export const QUESTION_PAUSE_MS = 2500;
/**
 * A voice this finished (Smart Turn) ends its turn at SURE_PAUSE_MS,
 * whatever its words read like or a short noise taken for thinking: on
 * the first calls from the desktop, turns scored 0.94 to 0.99 at 2.5 and
 * 3.5 s were held 8 to 15 s ("Ouais, vas-y.", the text model reading 0.03),
 * while every turn the speaker went on with scored 0.54 or less.
 */
export const TURN_SURELY_FINISHED = 0.9;
export const SURE_PAUSE_MS = 3000;

/** The words end with a question mark. */
export function endsWithQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text);
}

/** The words end with a filler ("... and then euh"). */
export function endsWithFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  return FILLERS.has(words.at(-1) ?? "");
}

/**
 * The cap on a pause. speechgate's turn models keep a turn open on words
 * that read unfinished, even when the voice sounds finished, up to its
 * give-up (LONGEST_PAUSE_MS); a pause to look for a word sounds unfinished
 * too, and must not end the turn. The helper reads the words at each pause
 * (`partial` with `pause`, `pause_ms` into it), with the voice's score at
 * speechgate's checks (`turn`) and whether the speaker sounds to be
 * thinking (`thinking`). From the first reading, the audio that comes after
 * is counted: at `maxPauseMs` the utterance is finished if the voice
 * sounded finished, at LONGEST_PAUSE_MS whatever it sounded like, and at
 * QUESTION_PAUSE_MS for a question asked whole in a finished voice, at
 * SURE_PAUSE_MS when the voice sounded surely finished. A
 * trailing filler ("euh") holds the turn to LONGEST_PAUSE_MS. Any voice,
 * a filler too, starts the count again: a partial without `pause`, more
 * words, or a reading earlier into a new pause. Only audio that came
 * counts: a stall is not silence.
 */
export class SilenceCap {
  private pausedMs: number | null = null;
  /** `pause_ms` of the pause's last reading. */
  private readMs = 0;
  private words = 0;
  /** The voice's best score this pause; null before speechgate's checks. */
  private turn: number | null = null;
  private holding = false;
  private fired = false;
  /** The pause's last reading ends in a question mark, or in a filler. */
  private question = false;
  private filler = false;

  constructor(
    private readonly capMs = MAX_PAUSE_MS,
    private readonly longestMs = Math.max(LONGEST_PAUSE_MS, capMs),
  ) {}

  /** What the helper said of the utterance. */
  event(event: VoiceEvent): void {
    switch (event.event) {
      case "speech_start":
        this.pausedMs = null;
        this.words = 0;
        this.fired = false;
        return;
      case "partial": {
        const text = event.text ?? "";
        const words = countWords(text);
        if (event.pause !== true) {
          this.pausedMs = null;
          this.words = words;
          return;
        }
        const at =
          typeof event.pause_ms === "number"
            ? event.pause_ms
            : FIRST_PAUSE_READ_MS;
        const voiceCame =
          this.pausedMs === null ||
          words > this.words ||
          (typeof event.pause_ms === "number" && at < this.readMs);
        if (voiceCame) {
          this.pausedMs = at;
          this.turn = null;
          this.holding = false;
        } else this.pausedMs = Math.max(this.pausedMs ?? at, at);
        this.readMs = at;
        this.words = words;
        if (typeof event.turn === "number")
          this.turn = Math.max(this.turn ?? 0, event.turn);
        this.holding ||= event.thinking === true || endsWithFiller(text);
        this.question = endsWithQuestion(text);
        this.filler = endsWithFiller(text);
        return;
      }
      case "speech_end":
      case "final":
        this.pausedMs = null;
        this.fired = true;
        return;
    }
  }

  /** How long the pause may go now. */
  limitMs(): number {
    const turn = this.turn ?? 0;
    const finished = this.turn !== null && turn >= TURN_SOUNDS_FINISHED;
    if (!this.filler) {
      // A question asked whole, or a voice surely done: answered soon,
      // noise taken for thinking or not.
      if (finished && this.question)
        return Math.min(this.capMs, QUESTION_PAUSE_MS);
      if (turn >= TURN_SURELY_FINISHED)
        return Math.min(this.capMs, SURE_PAUSE_MS);
    }
    return !this.holding && finished ? this.capMs : this.longestMs;
  }

  /** Audio that came: true once, when it takes the pause to its limit. */
  audio(bytes: number): boolean {
    if (this.pausedMs === null || this.fired) return false;
    this.pausedMs += bytes / BYTES_PER_MS;
    if (this.pausedMs < this.limitMs()) return false;
    this.fired = true;
    return true;
  }
}

function countWords(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * A dictation (`"mode": "dictation"`): one text, from `listen` to the
 * client's `finish`, over as many of the helper's utterances as its pauses
 * make.
 */
type Dictation = {
  /** The helper's finals so far, and what it hears now. */
  segments: string[];
  current: string;
  clean: CleanSession | null;
  /** When the client said `finish`; null before. */
  finishedAt: number | null;
  /** The final is being made: the helper's last utterance came. */
  concluding: boolean;
  /** FINISH_DEADLINE_MS after `finish`: a final, whatever came. */
  deadline: ReturnType<typeof setTimeout> | null;
  /** The helper loads its listening models: the audio waits for them. */
  loading: boolean;
  /** Starts the helper's next utterance. */
  next: () => VoiceSession;
};

/** A listening session and the socket it reports to, if any. */
type Listening = {
  /** The id the socket knows it by: its first helper session's. */
  id: number;
  session: VoiceSession;
  dictation?: Dictation;
  token: string;
  ws: VoiceSocket | null;
  /** What was told while no socket was there, sent on resume. */
  backlog: string[];
  cap: SilenceCap;
  /** Audio bytes it got: a resumed page sends again what came after. */
  received: number;
  /** Its final text was told: nothing more is waited for. */
  over: boolean;
  /** It hears a call's microphone (WebRTC), not the socket's audio. */
  viaCall: boolean;
  closeCleaning: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  stall: ReturnType<typeof setTimeout> | null;
};

/** The page's ICE lines (`call_ice`) logged for one call, at most. */
export const CALL_ICE_LINES = 200;
/** The longest ICE line kept. */
const CALL_ICE_CHARS = 2000;

/**
 * After a dictation's `finish`, its final (or an error) comes within this,
 * whatever the helper or the cleaner do: the words heard so far, as heard.
 */
export const FINISH_DEADLINE_MS = 15_000;
/**
 * While the helper loads its listening models (a helper just started), a
 * finished dictation waits this long for them, then FINISH_DEADLINE_MS.
 */
export const LOADING_DEADLINE_MS = 90_000;
/** A dictation's final when nothing was heard: an error the client shows. */
export const NOTHING_HEARD = "Nothing was heard";
/** A dictation's pauses never end it: the client says when it is over. */
const DICTATION_END_SILENCE_MS = 10_000;

/** Told to a socket: the helper's events, and dictation's own fields. */
type Told = Omit<VoiceEvent, "event"> & {
  /** A dictation's `loading` and `ready`: the helper's listening models. */
  event: VoiceEvent["event"] | "loading" | "ready";
  mode?: "dictation";
  nothing_heard?: boolean;
  cleaned?: boolean;
  timing?: { stt_ms: number; clean_ms: number };
};

const debug = (line: string) => {
  if (process.env.ROAMGATE_VOICE_DEBUG) console.error(`[voice] ${line}`);
};

export function createVoiceSocket(
  helper: VoiceHelper,
  cleaner: () => VoiceCleaner | null = () => null,
  /** voice.json's `max_pause_ms`, read at each listen. */
  maxPause: () => unknown = () => undefined,
  /** voice.json's call background, read as a call starts. */
  background: () => CallBackground | null = () => null,
  /** voice.json's `call_ice_address`, read as each signalling opens. */
  iceAddress: () => string | null = () => null,
  /** Opens a socket to the helper's signalling server. */
  connectUpstream: (url: string) => UpstreamSocket = (url) =>
    new WebSocket(url) as unknown as UpstreamSocket,
  /** A call is over, for good: not replaced by a newer one. */
  onCallEnded: () => void = () => {},
  /** The dictation cleaner (voice-dictation.ts), null to type raw words. */
  dictation: () => VoiceCleaner | null = () => null,
  /**
   * Whether a companion (voice-front.ts) hears what is said: it judges
   * other voices by their label; without one, a voice that is clearly not
   * the user's is not for the agent.
   */
  fronted: () => boolean = () => false,
) {
  const bySocket = new Map<VoiceSocket, Listening>();
  const byId = new Map<number, Listening>();
  /** The helper runs one call at a time. */
  let call: CallState | null = null;
  /** The pages' signalling sockets, fronted to the helper's server. */
  const signalling = new Map<SignallingSocket, Signalling>();

  /** The handoff tokens given, single use, to the call they hand. */
  const handoffs = new Map<string, { call: CallState; expires: number }>();

  /**
   * Why `token` does not own call `id` now, or null when it does: the
   * page's token, or the carrying app's.
   */
  const notOwner = (id: unknown, token: unknown): string | null => {
    if (!call) return "no call goes on";
    if (!call.handle) return "the call is still starting";
    if (call.stopped) return `call ${call.handle.id} is over`;
    if (call.handle.id !== id) return `the call going on is ${call.handle.id}`;
    if (typeof token !== "string" || !token) return "no call_token";
    if (call.token !== token && call.carrier?.token !== token)
      return "not the call's call_token";
    return null;
  };

  const send = (ws: VoiceSocket | null | undefined, message: object) =>
    ws?.send(JSON.stringify(message));

  /** Tells the call's page and its carrying app alike. */
  const tellBoth = (of: CallState, message: object) => {
    send(of.ws, message);
    if (of.carrier?.ws && of.carrier.ws !== of.ws) send(of.carrier.ws, message);
  };

  /** Where the carrier stands, as told to the page. */
  const carrierState = (of: CallState, carrier: Carrier) => ({
    event: "call_carrier",
    call: of.handle?.id,
    state: "joined",
    legs: carrier.legs,
    heard: carrier.heard,
  });

  /** Closes the app's signalling sockets for `carrier`. */
  const closeCarrierSignalling = (carrier: Carrier, why: string) => {
    for (const [ws, held] of [...signalling]) {
      if (held.carrier !== carrier) continue;
      signalling.delete(ws);
      if (held.upstream) {
        held.upstream.onclose = null;
        held.upstream.close();
      }
      ws.close(4000, why);
    }
  };

  /**
   * The app lets the call's legs go (`why`): the page takes them back,
   * the app's signalling closes, and a dropped app (`dropped`) is told the
   * call is over for it.
   */
  const carrierLeft = (of: CallState, why: string, dropped = false) => {
    const carrier = of.carrier;
    if (!carrier) return;
    of.carrier = null;
    if (carrier.timer) clearTimeout(carrier.timer);
    carrier.timer = null;
    debug(`call ${of.handle?.id}: the app lets the call go: ${why}`);
    if (carrier.joined)
      send(of.ws, {
        event: "call_carrier",
        call: of.handle?.id,
        state: "left",
        why,
      });
    if (dropped)
      send(carrier.ws, {
        event: "call_audio",
        call: of.handle?.id,
        error: why,
      });
    closeCarrierSignalling(carrier, why);
    unwatchReplies(of);
  };

  /** The call `ws` carries for the app, if it does. */
  const carried = (ws: VoiceSocket): CallState | null =>
    call?.carrier?.ws === ws && call.carrier.joined ? call : null;

  /** Stops watching who the replies' producer of `of` is. */
  const unwatchReplies = (of: CallState) => {
    if (of.repliesRetry) clearTimeout(of.repliesRetry);
    of.repliesRetry = null;
    const watch = of.replies;
    of.replies = null;
    if (!watch) return;
    watch.upstream.onclose = null;
    watch.upstream.onerror = null;
    watch.upstream.onmessage = null;
    watch.upstream.close();
  };

  /** Tells the joined app a replies producer it was not told yet. */
  const tellRepliesPeer = (of: CallState) => {
    const carrier = of.carrier;
    const peer = of.replies?.peer ?? null;
    if (!of.handle || !carrier?.joined || !carrier.ws || !peer) return;
    if (carrier.toldPeer === peer) return;
    carrier.toldPeer = peer;
    send(carrier.ws, { event: "call_replies_peer", call: of.handle.id, peer });
  };

  /**
   * Watches who the replies' producer of `of` is, as a listener on its
   * signalling server (RepliesWatch): from a handoff on, and again on a
   * restarted helper's new server.
   */
  const watchReplies = (of: CallState) => {
    unwatchReplies(of);
    const handle = of.handle;
    if (!handle || of.stopped || call !== of) return;
    const id = handle.id;
    const port = handle.signallingPort();
    if (!port) return;
    let upstream: UpstreamSocket;
    try {
      upstream = connectUpstream(`ws://127.0.0.1:${port}`);
    } catch (error) {
      debug(`call ${id}: cannot watch the replies on port ${port}: ${error}`);
      return;
    }
    const watch: RepliesWatch = { upstream, peer: null };
    of.replies = watch;
    const isReplies = (meta: unknown) =>
      !!meta &&
      typeof meta === "object" &&
      (meta as { call?: unknown }).call === id &&
      (meta as { role?: unknown }).role === "replies";
    const found = (peer: string) => {
      if (watch.peer === peer) return;
      watch.peer = peer;
      debug(`call ${id}: the replies' producer is ${peer}`);
      tellRepliesPeer(of);
    };
    upstream.onmessage = (event) => {
      if (of.replies !== watch || typeof event.data !== "string") return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "welcome") {
        upstream.send(
          JSON.stringify({
            type: "setPeerStatus",
            roles: ["listener"],
            meta: { call: id, role: "roamgate" },
          }),
        );
        upstream.send(JSON.stringify({ type: "list" }));
      } else if (message.type === "list") {
        const producers = Array.isArray(message.producers)
          ? (message.producers as { id?: unknown; meta?: unknown }[])
          : [];
        const replies = producers.find(
          (each) =>
            !!each &&
            typeof each.id === "string" &&
            each.id.length > 0 &&
            isReplies(each.meta),
        );
        if (replies) found(replies.id as string);
      } else if (message.type === "peerStatusChanged") {
        const peer = message.peerId;
        if (typeof peer !== "string" || !peer) return;
        const producing =
          Array.isArray(message.roles) && message.roles.includes("producer");
        if (producing && isReplies(message.meta)) found(peer);
        else if (watch.peer === peer) watch.peer = null;
      }
    };
    const gone = () => {
      if (of.replies !== watch) return;
      of.replies = null;
      debug(`call ${id}: the replies' watch on port ${port} closed`);
      // A restarted helper's new server is watched on call_restarted.
      of.repliesRetry = setTimeout(() => {
        of.repliesRetry = null;
        if (of.carrier && !of.replies) watchReplies(of);
      }, REPLIES_WATCH_RETRY_MS);
    };
    upstream.onclose = gone;
    upstream.onerror = gone;
  };

  /** Closes the signalling sockets of `of`: the page opens them again. */
  const closeSignalling = (of: CallState, why: string) => {
    for (const [ws, held] of [...signalling]) {
      if (held.call !== of) continue;
      signalling.delete(ws);
      if (held.upstream) {
        held.upstream.onclose = null;
        held.upstream.close();
      }
      ws.close(4000, why);
    }
  };

  /** Ends `ending`, telling its page why (it stops trying to signal). */
  const stopCall = (ending: CallState | null, why = "The call ended") => {
    if (!ending || ending.stopped) return;
    ending.stopped = true;
    if (ending.timer) clearTimeout(ending.timer);
    ending.timer = null;
    ending.handle?.stop();
    for (const [token, given] of handoffs)
      if (given.call === ending) handoffs.delete(token);
    const carrier = ending.carrier;
    ending.carrier = null;
    if (carrier) {
      if (carrier.timer) clearTimeout(carrier.timer);
      if (ending.handle)
        send(carrier.ws, {
          event: "call_audio",
          call: ending.handle.id,
          error: why,
        });
    }
    if (ending.handle)
      ending.ws?.send(
        JSON.stringify({
          event: "call_audio",
          call: ending.handle.id,
          error: why,
        }),
      );
    ending.ws = null;
    closeSignalling(ending, why);
    unwatchReplies(ending);
    if (call === ending) call = null;
    // Told after the call is gone: hanging up never waits for what follows.
    if (ending.handle && why !== REPLACED_CALL) onCallEnded();
  };

  const startCall = async (ws: VoiceSocket) => {
    stopCall(call, REPLACED_CALL);
    // A call without music still is one: the replies go through it.
    const wanted: CallBackground = background() ?? {
      background: "",
      volume: 0.6,
      ducked: 0.15,
      release_ms: 3000,
      muted: true,
      reply_loudness: CALL_REPLY_LOUDNESS,
    };
    const starting: CallState = {
      handle: null,
      token: crypto.randomUUID(),
      ws,
      timer: null,
      stopped: false,
      restarts: 0,
    };
    call = starting;
    try {
      const handle = await helper.startCall(wanted, (event) => {
        if (event.event === "call_restarted") {
          // The helper restarted and made the call again, with another
          // signalling server: the page's sessions start again on it. A
          // page away meanwhile learns it from its resume.
          starting.restarts += 1;
          debug(`call ${event.call}: made again after the helper restarted`);
          closeSignalling(starting, "The voice helper restarted");
          tellBoth(starting, {
            event: "call_restarted",
            call: event.call,
            restarts: starting.restarts,
          });
          // The app learns the new server's replies producer once known.
          if (starting.carrier) watchReplies(starting);
          return;
        }
        if (event.event === "call_ended") {
          // Not made again by a restarted helper: over, not owned any more.
          debug(`call ${event.call}: ended: ${event.error}`);
          stopCall(starting, event.error);
          return;
        }
        if (event.event === "call_music") {
          debug(
            `call ${event.call}: ${event.waiting ? "the music waits for a voice" : "a voice was taken: the music plays"}`,
          );
          tellBoth(starting, {
            event: "call_music",
            call: event.call,
            waiting: event.waiting,
          });
          return;
        }
        if (event.error === "Replaced") return;
        starting.ws?.send(
          JSON.stringify({ event: "call_error", error: event.error }),
        );
      });
      starting.handle = handle;
      if (starting.stopped) {
        handle.stop();
        return;
      }
      debug(
        `call ${handle.id}: started, music ${handle.music ? (handle.musicOn() ? (handle.musicWaiting() ? "waiting for a voice" : "on") : "off") : "none"}, signalling on port ${handle.signallingPort()}`,
      );
      starting.ws?.send(
        JSON.stringify({
          event: "call_audio",
          call: handle.id,
          resume: starting.token,
          music: handle.music,
          waiting: handle.musicWaiting(),
          webrtc: true,
        }),
      );
    } catch (error) {
      if (call === starting) call = null;
      starting.stopped = true;
      ws.send(
        JSON.stringify({
          event: "call_audio",
          error: (error as Error).message,
        }),
      );
    }
  };

  const clearTimers = (listening: Listening) => {
    if (listening.timer) clearTimeout(listening.timer);
    if (listening.stall) clearTimeout(listening.stall);
    listening.timer = null;
    listening.stall = null;
  };

  const end = (listening: Listening) => {
    clearTimers(listening);
    listening.session.stop();
    listening.closeCleaning();
    byId.delete(listening.id);
    for (const [ws, held] of bySocket)
      if (held === listening) bySocket.delete(ws);
    listening.ws = null;
  };

  const stop = (ws: VoiceSocket) => {
    const listening = bySocket.get(ws);
    if (listening) end(listening);
  };

  /**
   * No socket for it now: wait for one, then end the utterance. A stalled
   * socket stays known, in case its stream comes back.
   */
  const detach = (listening: Listening, why: "socket closed" | "no audio") => {
    if (
      why === "socket closed" &&
      listening.ws &&
      bySocket.get(listening.ws) === listening
    )
      bySocket.delete(listening.ws);
    listening.ws = null;
    clearTimers(listening);
    if (listening.over && !listening.backlog.length) {
      if (why === "socket closed") end(listening);
      return;
    }
    debug(`session ${listening.id} detached (${why}): kept for a resume`);
    listening.timer = setTimeout(() => {
      if (!listening.over) {
        debug(
          `session ${listening.id}: no resume, the utterance ends with what was heard`,
        );
        finishListening(listening);
      }
      listening.timer = setTimeout(() => end(listening), KEPT_MS);
    }, DETACHED_MS);
  };

  /**
   * No audio for STALL_MS. The socket's own: it is gone (detach). A call's
   * microphone: the socket is alive, only its WebRTC stream stopped; the
   * page is told and still gets what is heard, and past DETACHED_MS more
   * the utterance ends with what was heard.
   */
  const stalled = (listening: Listening) => {
    listening.stall = null;
    const ws = listening.ws;
    if (!listening.viaCall || !ws) {
      detach(listening, "no audio");
      return;
    }
    const id = listening.id;
    debug(`session ${id}: the call's microphone stalled`);
    ws.send(JSON.stringify({ event: "stalled", session: id }));
    if (listening.timer) clearTimeout(listening.timer);
    listening.timer = setTimeout(() => {
      listening.timer = null;
      if (listening.over) return;
      debug(
        `session ${id}: no audio from the call's microphone, the utterance ends with what was heard`,
      );
      finishListening(listening);
    }, DETACHED_MS);
  };

  const watchStall = (listening: Listening) => {
    if (listening.stall) clearTimeout(listening.stall);
    // A finished dictation waits for its final, sending no more audio.
    listening.stall =
      listening.ws && !listening.over && listening.dictation?.finishedAt == null
        ? setTimeout(() => stalled(listening), STALL_MS)
        : null;
  };

  /**
   * A call's microphone came for `listening` (the helper's `audio`): it
   * times the pause as the socket's audio does, and the stream is alive.
   */
  const callAudioCame = (listening: Listening | null, bytes: number) => {
    if (!listening) return;
    if (listening.ws) {
      clearTimers(listening);
      watchStall(listening);
    }
    if (listening.cap.audio(bytes)) {
      voiceLog.debug("voice pause ends the turn", {
        session: listening.id,
        limit_ms: listening.cap.limitMs(),
      });
      debug(
        `session ${listening.id}: a pause of ${listening.cap.limitMs()} ms ends the utterance`,
      );
      listening.session.finish();
    }
  };

  const attach = (listening: Listening, ws: VoiceSocket) => {
    const old = bySocket.get(ws);
    if (old && old !== listening) end(old);
    for (const [other, held] of bySocket)
      if (held === listening && other !== ws) bySocket.delete(other);
    clearTimers(listening);
    listening.ws = ws;
    bySocket.set(ws, listening);
    for (const message of listening.backlog.splice(0)) ws.send(message);
    watchStall(listening);
  };

  /** Tells the session's socket, or keeps it for the next one. */
  const deliver = (listening: Listening, event: Told) => {
    // Its helper stopped under it: nothing more comes for it (no finish
    // either), and the page listens again on a new session.
    const gone = event.event === "error" && event.recoverable === true;
    if (event.event === "final")
      // When each turn was heard whole (debug): its route and speech follow.
      voiceLog.debug("voice turn heard", {
        session: listening.id,
        chars: event.text?.length ?? 0,
        speech_ms: event.speech_ms,
        via: listening.viaCall ? "call" : "socket",
      });
    if (event.event === "final" || gone) {
      listening.over = true;
      if (listening.stall) clearTimeout(listening.stall);
      listening.stall = null;
    }
    const message = JSON.stringify(event);
    if (listening.ws) listening.ws.send(message);
    else listening.backlog.push(message);
    if (gone && listening.ws) {
      debug(`session ${listening.id}: ended with the helper`);
      end(listening);
    }
  };

  /** A dictation's words so far, as heard. */
  const heardSoFar = (state: Dictation) =>
    [...state.segments, state.current]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");

  /** A dictation's one final: later ones (a late cleaner) are dropped. */
  const dictationFinal = (
    listening: Listening,
    result: Dictated,
    raw: string,
    sttMs: number,
    cleanMs: number,
  ) => {
    const state = listening.dictation;
    if (!state || listening.over) return;
    if (state.deadline) clearTimeout(state.deadline);
    state.deadline = null;
    state.clean?.close();
    // Timings and sizes only: never the words.
    debug(
      `dictation ${listening.id}: heard ${sttMs} ms after finish, ${result.cleaned ? `cleaned in ${cleanMs} ms` : "typed as heard"}, ${raw.length} chars heard, ${result.text.length} typed`,
    );
    if (!raw) {
      // Said as such: an empty final types nothing, and a client waiting
      // on its cleaning shows nothing either.
      listening.over = true;
      if (listening.stall) clearTimeout(listening.stall);
      listening.stall = null;
      deliver(listening, {
        event: "error",
        session: listening.id,
        error: NOTHING_HEARD,
        nothing_heard: true,
        recoverable: false,
      });
      return;
    }
    deliver(listening, {
      event: "final",
      session: listening.id,
      text: result.text,
      raw,
      cleaned: result.cleaned,
      timing: { stt_ms: sttMs, clean_ms: cleanMs },
    });
  };

  /** The helper's last utterance came after `finish`: clean and tell. */
  const concludeDictation = async (listening: Listening) => {
    const state = listening.dictation;
    if (!state || state.concluding || listening.over) return;
    state.concluding = true;
    const now = performance.now();
    const sttMs = Math.round(now - (state.finishedAt ?? now));
    const raw = heardSoFar(state);
    const result = await dictated(state.clean, raw);
    dictationFinal(
      listening,
      result,
      raw,
      sttMs,
      Math.round(performance.now() - now),
    );
  };

  /** A finished dictation's final comes within `ms`, whatever comes. */
  const armDeadline = (listening: Listening, ms: number) => {
    const state = listening.dictation;
    if (!state) return;
    if (state.deadline) clearTimeout(state.deadline);
    state.deadline = setTimeout(() => {
      state.deadline = null;
      debug(`dictation ${listening.id}: no final in time, the words as heard`);
      dictationFinal(
        listening,
        { text: heardSoFar(state), cleaned: false },
        heardSoFar(state),
        Math.round(performance.now() - (state.finishedAt ?? 0)),
        0,
      );
    }, ms);
  };

  /**
   * The client is done: the helper ends what it hears, and the final
   * comes within FINISH_DEADLINE_MS whatever happens.
   */
  const finishDictation = (listening: Listening) => {
    const state = listening.dictation;
    if (!state || state.finishedAt !== null || listening.over) return;
    state.finishedAt = performance.now();
    if (listening.stall) clearTimeout(listening.stall);
    listening.stall = null;
    armDeadline(
      listening,
      state.loading ? LOADING_DEADLINE_MS : FINISH_DEADLINE_MS,
    );
    listening.session.finish();
  };

  /** Ends the utterance, or the dictation, with what was heard. */
  const finishListening = (listening: Listening) => {
    if (listening.dictation) finishDictation(listening);
    else listening.session.finish();
  };

  /** The helper's events for a dictation, as the socket is told them. */
  const dictationEvent = (listening: Listening | null, event: VoiceEvent) => {
    const state = listening?.dictation;
    if (!listening || !state || listening.over) return;
    // The utterance before this one may still say how it ended.
    if (event.session !== undefined && event.session !== listening.session.id)
      return;
    switch (event.event) {
      case "listen_loading":
        // A helper just started: what is said now is heard once its
        // models are loaded, and the client may say so meanwhile.
        state.loading = true;
        deliver(listening, {
          event: "loading",
          session: listening.id,
          mode: "dictation",
        });
        return;
      case "listen_ready":
        state.loading = false;
        deliver(listening, {
          event: "ready",
          session: listening.id,
          mode: "dictation",
        });
        // Finished while they loaded: the helper hears it all only now.
        if (state.finishedAt !== null && !state.concluding)
          armDeadline(listening, FINISH_DEADLINE_MS);
        return;
      case "speech_start":
        deliver(listening, { event: "speech_start", session: listening.id });
        return;
      case "partial": {
        if (!event.text) return;
        state.current = event.text;
        const whole = heardSoFar(state);
        state.clean?.partial(whole, event.pause === true);
        deliver(listening, {
          event: "partial",
          session: listening.id,
          text: whole,
          ...(event.pause === true ? { pause: true } : {}),
        });
        return;
      }
      case "final": {
        // A voice the helper doubts is the speaker's is typed too: the
        // phone is held by the one dictating.
        const text = event.text?.trim() ?? "";
        if (text) state.segments.push(text);
        state.current = "";
        if (state.finishedAt !== null) {
          void concludeDictation(listening);
          return;
        }
        // A pause ended the helper's utterance, not the dictation: it
        // listens again at once, the same socket's audio going on.
        const before = listening.session;
        try {
          listening.session = state.next();
        } catch (error) {
          deliver(listening, {
            event: "error",
            session: listening.id,
            error: (error as Error).message,
            recoverable: true,
          });
          return;
        }
        before.stop();
        return;
      }
      case "error":
        deliver(listening, {
          event: "error",
          session: listening.id,
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.recoverable !== undefined
            ? { recoverable: event.recoverable }
            : {}),
        });
        if (event.recoverable === true) listening.over = true;
        return;
    }
  };

  /**
   * The helper listens to one session at a time: a newer listening takes
   * it from a dictation, which ends with what it heard.
   */
  const preemptDictations = () => {
    for (const listening of [...byId.values()]) {
      const state = listening.dictation;
      if (!state || listening.over) continue;
      debug(`dictation ${listening.id}: another listening took the helper`);
      const raw = heardSoFar(state);
      dictationFinal(listening, { text: raw, cleaned: false }, raw, 0, 0);
      listening.session.stop();
    }
  };

  /** `{"op": "listen", "mode": "dictation"}`. */
  const startDictation = (
    ws: VoiceSocket,
    request: Record<string, unknown>,
  ) => {
    if (call && !call.stopped) {
      ws.send(
        JSON.stringify({
          event: "error",
          session: null,
          error: "A voice call is going on",
          busy: true,
        }),
      );
      return;
    }
    preemptDictations();
    const target = dictationTarget(request);
    const using = dictation();
    using?.warm();
    const holder: { listening: Listening | null } = { listening: null };
    const options: ListenOptions = {
      ...(target.language ? { language: target.language } : {}),
      endSilenceMs: DICTATION_END_SILENCE_MS,
    };
    const next = () =>
      helper.listen(
        (event) => dictationEvent(holder.listening, event),
        options,
      );
    const state: Dictation = {
      segments: [],
      current: "",
      clean: using ? dictationSession(using, target) : null,
      finishedAt: null,
      concluding: false,
      deadline: null,
      loading: false,
      next,
    };
    let started: VoiceSession;
    try {
      started = next();
    } catch (error) {
      state.clean?.close();
      ws.send(
        JSON.stringify({ event: "error", error: (error as Error).message }),
      );
      return;
    }
    const created: Listening = {
      id: started.id,
      session: started,
      dictation: state,
      token: crypto.randomUUID(),
      ws: null,
      backlog: [],
      cap: new SilenceCap(),
      received: 0,
      over: false,
      viaCall: false,
      closeCleaning: () => {
        state.clean?.close();
        if (state.deadline) clearTimeout(state.deadline);
        state.deadline = null;
      },
      timer: null,
      stall: null,
    };
    holder.listening = created;
    byId.set(created.id, created);
    ws.send(
      JSON.stringify({
        event: "listening",
        session: created.id,
        resume: created.token,
        mode: "dictation",
      }),
    );
    attach(created, ws);
  };

  /**
   * The helper's events to whoever listens, the words cleaned on the way:
   * the final text waits for its cleaning, so events keep their order.
   */
  const relay = (
    holder: { listening: Listening | null },
    context: string | null,
  ) => {
    const using = context === null ? null : cleaner();
    // A final's voice, labelled for the page to pass on (voice-speakers.ts).
    const labelled = (event: VoiceEvent): VoiceEvent => {
      if (event.event !== "final" || !event.voice) return event;
      const label = helper.speakers.label(event.voice);
      return label ? { ...event, voice_label: label } : event;
    };
    const send = (event: VoiceEvent) => {
      if (holder.listening) deliver(holder.listening, labelled(event));
    };
    const observe = (event: VoiceEvent) => holder.listening?.cap.event(event);
    if (!using)
      return {
        onEvent: (event: VoiceEvent) => {
          observe(event);
          send(event);
        },
        close: () => {},
      };
    using.warm();
    let session: CleanSession = using.session(context ?? "");
    let chain = Promise.resolve();
    return {
      close: () => session.close(),
      onEvent: (event: VoiceEvent) => {
        observe(event);
        chain = chain
          .then(async () => {
            if (event.event === "partial" && event.text)
              session.partial(event.text, event.pause === true);
            if (event.event === "final" && event.text) {
              const started = performance.now();
              const cleaned = await session.final(event.text);
              // Not surely the speaker's voice (the helper): not for the
              // agent, whatever the cleaner made of it.
              if (event.for_agent === false) cleaned.forAgent = false;
              // Clearly another voice, and no companion to judge it.
              const other =
                event.voice !== undefined &&
                !fronted() &&
                helper.speakers.isOther(event.voice);
              if (other) cleaned.forAgent = false;
              const label = event.voice
                ? helper.speakers.label(event.voice)
                : "";
              // Held words are shown as they were heard when nothing is left.
              if (!cleaned.forAgent && !cleaned.text) cleaned.text = event.text;
              debug(
                `cleaned in ${Math.round(performance.now() - started)} ms${cleaned.forAgent ? "" : other ? ", not for the agent (another voice)" : ", not for the agent"}${label ? ` [${label}]` : ""}: ${cleaned.text}\n[voice]   heard: ${event.text}`,
              );
              session = using.session(context ?? "");
              event = {
                ...event,
                text: cleaned.text,
                raw: event.text,
                for_agent: cleaned.forAgent,
              };
            }
            send(event);
          })
          .catch(() => {});
      },
    };
  };

  return {
    message(ws: VoiceSocket, message: string | Uint8Array) {
      if (typeof message !== "string") {
        const listening = bySocket.get(ws);
        if (!listening) return;
        // The stream came back on this socket after a stall.
        if (listening.ws !== ws) attach(listening, ws);
        else watchStall(listening);
        listening.received += message.length;
        listening.session.audio(message);
        if (!listening.dictation && listening.cap.audio(message.length)) {
          voiceLog.debug("voice pause ends the turn", {
            session: listening.id,
            limit_ms: listening.cap.limitMs(),
          });
          debug(
            `session ${listening.id}: a pause of ${listening.cap.limitMs()} ms ends the utterance`,
          );
          listening.session.finish();
        }
        return;
      }
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(message);
      } catch {
        return;
      }
      const listening = bySocket.get(ws);
      // Its socket speaks: a session stalled on it gets what it missed.
      if (listening && listening.ws !== ws) attach(listening, ws);
      switch (request.op) {
        case "listen": {
          stop(ws);
          if (request.mode === "dictation") {
            startDictation(ws, request);
            return;
          }
          preemptDictations();
          try {
            const holder: { listening: Listening | null } = {
              listening: null,
            };
            const relayed = relay(
              holder,
              typeof request.context === "string"
                ? request.context.slice(-4000)
                : null,
            );
            // Its call's microphone (WebRTC), when the page says it
            // carries the audio: only on the socket owning that call.
            const viaCall =
              typeof request.call === "number" &&
              call?.ws === ws &&
              call.handle?.id === request.call
                ? request.call
                : undefined;
            const started = helper.listen(
              (event) => {
                if (event.event === "audio")
                  callAudioCame(holder.listening, event.bytes ?? 0);
                // The voice chat's audio waits for the models as well.
                else if (
                  event.event !== "listen_loading" &&
                  event.event !== "listen_ready"
                )
                  relayed.onEvent(event);
              },
              {
                ...(viaCall !== undefined ? { call: viaCall } : {}),
                hold: request.hold === true,
                newSpeaker: request.new_speaker === true,
                language:
                  typeof request.language === "string" &&
                  /^[a-z]{2}$/.test(request.language)
                    ? request.language
                    : undefined,
                endSilenceMs:
                  typeof request.end_silence_ms === "number" &&
                  request.end_silence_ms >= 300 &&
                  request.end_silence_ms <= 10_000
                    ? request.end_silence_ms
                    : undefined,
              },
            );
            const created: Listening = {
              id: started.id,
              session: started,
              token: crypto.randomUUID(),
              ws: null,
              backlog: [],
              cap: new SilenceCap(maxPauseMs(maxPause())),
              received: 0,
              over: false,
              viaCall: viaCall !== undefined,
              closeCleaning: relayed.close,
              timer: null,
              stall: null,
            };
            holder.listening = created;
            byId.set(started.id, created);
            ws.send(
              JSON.stringify({
                event: "listening",
                session: started.id,
                resume: created.token,
              }),
            );
            attach(created, ws);
          } catch (error) {
            ws.send(
              JSON.stringify({
                event: "error",
                error: (error as Error).message,
              }),
            );
          }
          return;
        }
        case "resume": {
          const found =
            typeof request.session === "number"
              ? byId.get(request.session)
              : undefined;
          if (!found || found.token !== request.resume) {
            if (request.mode === "dictation") {
              ws.send(
                JSON.stringify({
                  event: "error",
                  session: request.session,
                  error: "unknown session",
                  recoverable: false,
                }),
              );
              return;
            }
            ws.send(
              JSON.stringify({
                event: "resume_failed",
                session: request.session,
              }),
            );
            return;
          }
          debug(`session ${found.id} resumed on a new socket`);
          ws.send(
            JSON.stringify({
              event: "resumed",
              session: found.id,
              received: found.received,
            }),
          );
          attach(found, ws);
          return;
        }
        case "release":
          listening?.session.release();
          return;
        case "finish":
          if (listening) finishListening(listening);
          return;
        case "warm": {
          if (request.mode !== "dictation") return;
          const using = dictation();
          using?.warm();
          ws.send(
            JSON.stringify({
              event: "warm",
              mode: "dictation",
              cleaner: using !== null,
            }),
          );
          return;
        }
        case "stop":
          stop(ws);
          return;
        case "call_audio":
          if (request.on === false) {
            // With its number, that call only (a late answer's page).
            const numbered =
              typeof request.call !== "number" ||
              call?.handle?.id === request.call;
            if (call?.ws === ws && numbered) stopCall(call);
            // The app's hang-up ends the call for the page too.
            else if (carried(ws) && numbered)
              stopCall(call, "Hung up in the Roamgate app");
          } else if (!carried(ws)) void startCall(ws);
          return;
        case "call_handoff": {
          // The page hands its call to the Android app: a token to give it.
          const found = call?.ws === ws ? call : null;
          if (
            !found?.handle ||
            found.stopped ||
            found.handle.id !== request.call
          ) {
            send(ws, {
              event: "call_handoff",
              call: request.call,
              error: "No such call",
            });
            return;
          }
          for (const [token, given] of handoffs)
            if (given.call === found) handoffs.delete(token);
          const handoff = randomToken();
          handoffs.set(handoff, {
            call: found,
            expires: Date.now() + HANDOFF_MS,
          });
          debug(`call ${found.handle.id}: a handoff to the app is offered`);
          send(ws, {
            event: "call_handoff",
            call: found.handle.id,
            handoff,
            expires_ms: HANDOFF_MS,
          });
          return;
        }
        case "call_carry": {
          // The app takes the legs it carries, with its carrier token.
          const found = call;
          const carrier = found?.carrier;
          if (
            !found?.handle ||
            found.stopped ||
            !carrier ||
            found.handle.id !== request.call ||
            carrier.token !== request.carrier
          ) {
            send(ws, {
              event: "call_carry",
              call: request.call,
              error: "No such call",
            });
            return;
          }
          const legs = Array.isArray(request.legs)
            ? CARRIED_LEGS.filter((leg) =>
                (request.legs as unknown[]).includes(leg),
              )
            : ["microphone" as const];
          if (!legs.length) {
            send(ws, {
              event: "call_carry",
              call: found.handle.id,
              error: "No leg to carry",
            });
            return;
          }
          if (carrier.timer) clearTimeout(carrier.timer);
          carrier.timer = null;
          if (!legs.includes("microphone")) carrier.heard = false;
          carrier.ws = ws;
          carrier.legs = legs;
          carrier.joined = true;
          debug(
            `call ${found.handle.id}: the app carries ${legs.join(" and ")}`,
          );
          // Null until the helper's replies producer registered: a
          // call_replies_peer follows then.
          const repliesPeer = found.replies?.peer ?? null;
          carrier.toldPeer = repliesPeer;
          if (!found.replies && !found.repliesRetry) watchReplies(found);
          send(ws, {
            event: "call_carry",
            call: found.handle.id,
            ok: true,
            legs,
            restarts: found.restarts,
            waiting: found.handle.musicWaiting(),
            replies_peer: repliesPeer,
          });
          send(ws, {
            event: "call_mute",
            call: found.handle.id,
            muted: found.muted === true,
          });
          send(found.ws, carrierState(found, carrier));
          if (carrier.outputs) send(found.ws, carrier.outputs);
          return;
        }
        case "call_mute_state": {
          // The page's Mute changed (its button, the app's, anything that
          // mutes): the app carrying the call shows it.
          const found = call?.ws === ws ? call : null;
          if (
            !found?.handle ||
            found.stopped ||
            found.handle.id !== request.call ||
            typeof request.muted !== "boolean"
          )
            return;
          found.muted = request.muted;
          if (found.carrier?.joined)
            send(found.carrier.ws, {
              event: "call_mute",
              call: found.handle.id,
              muted: request.muted,
            });
          return;
        }
        case "call_mute": {
          // The app's Mute (its notification, a headset, the car): the
          // page mutes as its own button does, and reports it back.
          const found = carried(ws);
          if (
            !found?.handle ||
            found.stopped ||
            found.handle.id !== request.call ||
            typeof request.muted !== "boolean"
          )
            return;
          debug(
            `call ${found.handle.id}: the app ${request.muted ? "mutes" : "unmutes"} the call`,
          );
          send(found.ws, {
            event: "call_mute",
            call: found.handle.id,
            muted: request.muted,
          });
          return;
        }
        case "call_carry_end": {
          const found = carried(ws);
          if (found) carrierLeft(found, "The Roamgate app gave the call back");
          return;
        }
        case "call_output": {
          // The page picks where the app plays the call.
          const found = call?.ws === ws ? call : null;
          const output = request.output;
          const carrier = found?.carrier;
          if (
            !found?.handle ||
            !carrier?.joined ||
            typeof output !== "string" ||
            !output ||
            output.length > 128
          )
            return;
          send(carrier.ws, {
            event: "call_output",
            call: found.handle.id,
            output,
          });
          return;
        }
        case "call_output_state": {
          // Where the app plays the call, and what else it could: for the page.
          const found = carried(ws);
          if (!found?.handle || !found.carrier) return;
          const outputs = Array.isArray(request.outputs)
            ? request.outputs
                .filter(
                  (
                    each,
                  ): each is { id: string; kind: string; label?: unknown } =>
                    !!each &&
                    typeof each === "object" &&
                    typeof each.id === "string" &&
                    each.id.length > 0 &&
                    each.id.length <= 128 &&
                    OUTPUT_KINDS.has(each.kind),
                )
                .slice(0, 16)
                .map((each) => ({
                  id: each.id,
                  kind: each.kind,
                  label:
                    typeof each.label === "string"
                      ? each.label.slice(0, 64)
                      : "",
                }))
            : [];
          const current =
            typeof request.current === "string" &&
            outputs.some((each) => each.id === request.current)
              ? request.current
              : null;
          found.carrier.outputs = {
            event: "call_output_state",
            call: found.handle.id,
            current,
            outputs,
          };
          send(found.ws, found.carrier.outputs);
          return;
        }
        case "call_hush":
          if (call?.ws === ws) call.handle?.hush();
          return;
        case "call_resume": {
          const found = call;
          if (
            !found?.handle ||
            found.handle.id !== request.call ||
            found.token !== request.resume
          ) {
            ws.send(
              JSON.stringify({
                event: "call_audio",
                call: request.call,
                error: "The call's audio ended",
              }),
            );
            return;
          }
          if (found.timer) clearTimeout(found.timer);
          found.timer = null;
          found.ws = ws;
          debug(`call ${found.handle.id}: moved to a new socket`);
          ws.send(
            JSON.stringify({
              event: "call_audio",
              call: found.handle.id,
              resumed: true,
              restarts: found.restarts,
              waiting: found.handle.musicWaiting(),
            }),
          );
          // The app still carries it: the page's new socket learns so.
          if (found.carrier?.joined) {
            send(ws, carrierState(found, found.carrier));
            if (found.carrier.outputs) send(ws, found.carrier.outputs);
          }
          return;
        }
        case "call_ice": {
          const found = call?.ws === ws ? call : carried(ws);
          const line = request.line;
          if (!found?.handle || typeof line !== "string" || !line) return;
          found.iceLines = (found.iceLines ?? 0) + 1;
          if (found.iceLines > CALL_ICE_LINES) return;
          console.error(
            `[voice] call ${found.handle.id} (${found.ws === ws ? "page" : "app"}): ${line
              .replace(/[\r\n]+/g, " | ")
              .slice(0, CALL_ICE_CHARS)}`,
          );
          return;
        }
        case "call_microphone": {
          const app = carried(ws);
          const from = app ? "app" : "page";
          const carrier = app?.carrier ?? null;
          const handle = (call?.ws === ws ? call : app)?.handle ?? null;
          const peer = request.peer;
          if (!handle || typeof peer !== "string" || !peer || peer.length > 128)
            return;
          if (
            !app &&
            call?.carrier?.joined &&
            call.carrier.legs.includes("microphone")
          ) {
            // The app carries the microphone: the page's is not listened to.
            send(ws, {
              event: "call_microphone",
              call: handle.id,
              error: "The Roamgate app carries the microphone",
            });
            return;
          }
          if (app && !carrier?.legs.includes("microphone")) return;
          // Who cancels the replies' echo: the helper ("here"), or the page.
          const echo = request.echo === "here" ? "here" : "page";
          debug(
            `call ${handle.id}: the ${from}'s microphone is ${peer}, the echo cancelled ${echo === "here" ? "by the helper" : `by the ${from}`}`,
          );
          handle.microphone(peer, echo).then(
            () => {
              debug(`call ${handle.id}: the helper listens to ${peer}`);
              ws.send(
                JSON.stringify({
                  event: "call_microphone",
                  call: handle.id,
                  ok: true,
                }),
              );
              // The page's listenings hear the app's microphone now.
              if (app && carrier && app.carrier === carrier) {
                carrier.heard = true;
                send(app.ws, carrierState(app, carrier));
              }
            },
            (error) => {
              debug(`call ${handle.id}: the helper cannot listen: ${error}`);
              if (app && carrier && app.carrier === carrier && carrier.heard) {
                carrier.heard = false;
                send(app.ws, carrierState(app, carrier));
              }
              ws.send(
                JSON.stringify({
                  event: "call_microphone",
                  call: handle.id,
                  error: (error as Error).message,
                }),
              );
            },
          );
          return;
        }
      }
    },
    close(ws: VoiceSocket) {
      const listening = bySocket.get(ws);
      if (listening) detach(listening, "socket closed");
      const app = call?.carrier?.ws === ws ? call : null;
      const carrier = app?.carrier;
      if (app && carrier) {
        // The app may come back on a new socket (call_carry again).
        carrier.ws = null;
        if (carrier.timer) clearTimeout(carrier.timer);
        carrier.timer = setTimeout(() => {
          carrier.timer = null;
          if (app.carrier === carrier)
            carrierLeft(app, "The Roamgate app's link went");
        }, DETACHED_MS);
      }
      const held = call;
      if (held?.ws === ws) {
        // Its packets are dropped until a resume, or it stops.
        held.ws = null;
        if (held.timer) clearTimeout(held.timer);
        held.timer = setTimeout(() => {
          debug("a call ends: no resume");
          stopCall(held);
        }, DETACHED_MS);
      }
    },
    /** The call going on now, for its music's level. */
    currentCall(): CallHandle | null {
      return call?.handle ?? null;
    },
    /**
     * Exchanges a handoff token (call_handoff) for the call's carrier
     * token, once: null when it is unknown, used, expired, or its call
     * over. A newer carrier replaces the one before, which is told the
     * call is over for it.
     */
    redeemHandoff(token: unknown): { call: number; carrier: string } | null {
      if (typeof token !== "string" || !token) return null;
      const given = handoffs.get(token);
      if (!given) return null;
      handoffs.delete(token);
      const of = given.call;
      if (given.expires < Date.now() || of !== call || of.stopped || !of.handle)
        return null;
      carrierLeft(of, "The call went to another app", true);
      const carrier: Carrier = {
        token: randomToken(),
        ws: null,
        legs: [],
        joined: false,
        heard: false,
        outputs: null,
        timer: null,
      };
      // Never joined: let go, the page keeps the call.
      carrier.timer = setTimeout(() => {
        carrier.timer = null;
        if (of.carrier === carrier)
          carrierLeft(of, "The Roamgate app never joined");
      }, DETACHED_MS);
      of.carrier = carrier;
      // Who the replies' producer is, known by the time the app joins.
      watchReplies(of);
      debug(`call ${of.handle.id}: the handoff was taken`);
      return { call: of.handle.id, carrier: carrier.token };
    },
    /** Whether `token` owns call `id` now: its page may signal it. */
    ownsCall(id: unknown, token: unknown): boolean {
      return notOwner(id, token) === null;
    },
    /**
     * Why a page may not open the signalling of call `id` with `token`
     * (/api/voice/call/signalling answers 403), or null for the call's
     * owner on this site. Traced with ROAMGATE_VOICE_DEBUG.
     */
    signallingRefused(
      req: Request,
      id: unknown,
      token: unknown,
    ): string | null {
      const why = sameSiteSocket(req)
        ? notOwner(id, token)
        : "it comes from another site";
      if (why) debug(`call ${String(id)}: signalling refused (403): ${why}`);
      return why;
    },
    /**
     * A page's signalling socket for call `id` (/api/voice/call/signalling),
     * owned by `token`: fronted to the helper's signalling server for it,
     * the helper's loopback candidates given with `call_ice_address`.
     */
    openSignalling(ws: SignallingSocket, id: number, token: string) {
      const of = call;
      const refused = notOwner(id, token);
      if (refused || !of?.handle) {
        debug(`call ${id}: signalling closed (4004): ${refused}`);
        ws.close(4004, "No such call");
        return;
      }
      const port = of.handle.signallingPort();
      if (!port) {
        debug(`call ${id}: signalling closed (1011): the helper gives no port`);
        ws.close(1011, "The call's signalling is not there");
        return;
      }
      const held: Signalling = {
        call: of,
        upstream: null,
        queue: [],
        ...(of.carrier && of.carrier.token === token
          ? { carrier: of.carrier }
          : {}),
      };
      signalling.set(ws, held);
      let upstream: UpstreamSocket;
      try {
        upstream = connectUpstream(`ws://127.0.0.1:${port}`);
      } catch (error) {
        signalling.delete(ws);
        debug(`call ${id}: no signalling on port ${port}: ${error}`);
        ws.close(1011, "The call's signalling is not there");
        return;
      }
      held.upstream = upstream;
      const address = iceAddress();
      debug(
        `call ${id}: a page signals on port ${port}${address ? `, candidates given at ${address}` : ""}`,
      );
      let opened = false;
      upstream.onopen = () => {
        opened = true;
        for (const message of held.queue.splice(0)) upstream.send(message);
      };
      upstream.onmessage = (event) => {
        if (typeof event.data === "string")
          ws.send(rewriteCandidates(event.data, address));
      };
      const gone = () => {
        if (signalling.get(ws) !== held) return;
        signalling.delete(ws);
        debug(
          `call ${id}: signalling closed (1011): the helper's signalling on port ${port} ${opened ? "closed" : "did not answer"}`,
        );
        ws.close(1011, "The call's signalling closed");
      };
      upstream.onclose = gone;
      upstream.onerror = gone;
    },
    signallingMessage(ws: SignallingSocket, message: string | Uint8Array) {
      const held = signalling.get(ws);
      if (!held?.upstream) return;
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      if (held.upstream.readyState === 1) held.upstream.send(text);
      else if (held.queue.length < SIGNALLING_QUEUE) held.queue.push(text);
    },
    closeSignalling(ws: SignallingSocket) {
      const held = signalling.get(ws);
      if (!held) return;
      signalling.delete(ws);
      if (held.upstream) {
        held.upstream.onclose = null;
        held.upstream.onerror = null;
        held.upstream.close();
      }
    },
  };
}
