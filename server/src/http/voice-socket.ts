import { serverLogger } from "../utils/logger";
import type { CleanSession, VoiceCleaner } from "../voice/voice-cleaner";
import {
  CALL_REPLY_LOUDNESS,
  type CallBackground,
  type CallHandle,
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

/** A call, and the socket that owns it, if any. */
type CallState = {
  handle: CallHandle | null;
  token: string;
  ws: VoiceSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Times a restarted helper made it again: told on call_resume too. */
  restarts: number;
  /** The page's ICE lines logged for it (`call_ice`). */
  iceLines?: number;
};

/** A page's signalling socket and its way to the helper. */
type Signalling = {
  call: CallState;
  upstream: UpstreamSocket | null;
  /** What the page said before the helper's socket opened. */
  queue: string[];
};

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

/** A listening session and the socket it reports to, if any. */
type Listening = {
  session: VoiceSession;
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
) {
  const bySocket = new Map<VoiceSocket, Listening>();
  const byId = new Map<number, Listening>();
  /** The helper runs one call at a time. */
  let call: CallState | null = null;
  /** The pages' signalling sockets, fronted to the helper's server. */
  const signalling = new Map<SignallingSocket, Signalling>();

  /** Why `token` does not own call `id` now, or null when it does. */
  const notOwner = (id: unknown, token: unknown): string | null => {
    if (!call) return "no call goes on";
    if (!call.handle) return "the call is still starting";
    if (call.stopped) return `call ${call.handle.id} is over`;
    if (call.handle.id !== id) return `the call going on is ${call.handle.id}`;
    if (typeof token !== "string" || !token) return "no call_token";
    if (call.token !== token) return "not the call's call_token";
    return null;
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
          starting.ws?.send(
            JSON.stringify({
              event: "call_restarted",
              call: event.call,
              restarts: starting.restarts,
            }),
          );
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
          starting.ws?.send(
            JSON.stringify({
              event: "call_music",
              call: event.call,
              waiting: event.waiting,
            }),
          );
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
    byId.delete(listening.session.id);
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
    debug(
      `session ${listening.session.id} detached (${why}): kept for a resume`,
    );
    listening.timer = setTimeout(() => {
      if (!listening.over) {
        debug(
          `session ${listening.session.id}: no resume, the utterance ends with what was heard`,
        );
        listening.session.finish();
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
    const id = listening.session.id;
    debug(`session ${id}: the call's microphone stalled`);
    ws.send(JSON.stringify({ event: "stalled", session: id }));
    if (listening.timer) clearTimeout(listening.timer);
    listening.timer = setTimeout(() => {
      listening.timer = null;
      if (listening.over) return;
      debug(
        `session ${id}: no audio from the call's microphone, the utterance ends with what was heard`,
      );
      listening.session.finish();
    }, DETACHED_MS);
  };

  const watchStall = (listening: Listening) => {
    if (listening.stall) clearTimeout(listening.stall);
    listening.stall =
      listening.ws && !listening.over
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
        session: listening.session.id,
        limit_ms: listening.cap.limitMs(),
      });
      debug(
        `session ${listening.session.id}: a pause of ${listening.cap.limitMs()} ms ends the utterance`,
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
  const deliver = (listening: Listening, event: VoiceEvent) => {
    // Its helper stopped under it: nothing more comes for it (no finish
    // either), and the page listens again on a new session.
    const gone = event.event === "error" && event.recoverable === true;
    if (event.event === "final")
      // When each turn was heard whole (debug): its route and speech follow.
      voiceLog.debug("voice turn heard", {
        session: listening.session.id,
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
      debug(`session ${listening.session.id}: ended with the helper`);
      end(listening);
    }
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
    const send = (event: VoiceEvent) => {
      if (holder.listening) deliver(holder.listening, event);
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
              // Held words are shown as they were heard when nothing is left.
              if (!cleaned.forAgent && !cleaned.text) cleaned.text = event.text;
              debug(
                `cleaned in ${Math.round(performance.now() - started)} ms${cleaned.forAgent ? "" : ", not for the agent"}: ${cleaned.text}\n[voice]   heard: ${event.text}`,
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
        if (listening.cap.audio(message.length)) {
          voiceLog.debug("voice pause ends the turn", {
            session: listening.session.id,
            limit_ms: listening.cap.limitMs(),
          });
          debug(
            `session ${listening.session.id}: a pause of ${listening.cap.limitMs()} ms ends the utterance`,
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
              (event) =>
                event.event === "audio"
                  ? callAudioCame(holder.listening, event.bytes ?? 0)
                  : relayed.onEvent(event),
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
            ws.send(
              JSON.stringify({
                event: "resume_failed",
                session: request.session,
              }),
            );
            return;
          }
          debug(`session ${found.session.id} resumed on a new socket`);
          ws.send(
            JSON.stringify({
              event: "resumed",
              session: found.session.id,
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
          listening?.session.finish();
          return;
        case "stop":
          stop(ws);
          return;
        case "call_audio":
          if (request.on === false) {
            // With its number, that call only (a late answer's page).
            if (
              call?.ws === ws &&
              (typeof request.call !== "number" ||
                call.handle?.id === request.call)
            )
              stopCall(call);
          } else void startCall(ws);
          return;
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
          return;
        }
        case "call_ice": {
          const found = call?.ws === ws ? call : null;
          const line = request.line;
          if (!found?.handle || typeof line !== "string" || !line) return;
          found.iceLines = (found.iceLines ?? 0) + 1;
          if (found.iceLines > CALL_ICE_LINES) return;
          console.error(
            `[voice] call ${found.handle.id} (page): ${line
              .replace(/[\r\n]+/g, " | ")
              .slice(0, CALL_ICE_CHARS)}`,
          );
          return;
        }
        case "call_microphone": {
          const handle = call?.ws === ws ? call.handle : null;
          const peer = request.peer;
          if (!handle || typeof peer !== "string" || !peer || peer.length > 128)
            return;
          // Who cancels the replies' echo: the helper ("here"), or the page.
          const echo = request.echo === "here" ? "here" : "page";
          debug(
            `call ${handle.id}: the page's microphone is ${peer}, the echo cancelled ${echo === "here" ? "by the helper" : "by the page"}`,
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
            },
            (error) => {
              debug(`call ${handle.id}: the helper cannot listen: ${error}`);
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
      const held: Signalling = { call: of, upstream: null, queue: [] };
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
