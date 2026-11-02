import type { CleanSession, VoiceCleaner } from "../voice/voice-cleaner";
import {
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
 */
export type VoiceSocket = {
  send: (message: string) => unknown;
};

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
 * sounded finished, at LONGEST_PAUSE_MS whatever it sounded like. A
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
    return !this.holding &&
      this.turn !== null &&
      this.turn >= TURN_SOUNDS_FINISHED
      ? this.capMs
      : this.longestMs;
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
  closeCleaning: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  stall: ReturnType<typeof setTimeout> | null;
};

const debug = (line: string) => {
  if (process.env.ROAMGATE_VOICE_DEBUG) console.error(`[voice] ${line}`);
};

export function createVoiceSocket(
  helper: VoiceHelper,
  cleaner: () => VoiceCleaner | null = () => null,
  /** voice.json's `max_pause_ms`, read at each listen. */
  maxPause: () => unknown = () => undefined,
) {
  const bySocket = new Map<VoiceSocket, Listening>();
  const byId = new Map<number, Listening>();

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

  const watchStall = (listening: Listening) => {
    if (listening.stall) clearTimeout(listening.stall);
    listening.stall =
      listening.ws && !listening.over
        ? setTimeout(() => detach(listening, "no audio"), STALL_MS)
        : null;
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
            const started = helper.listen(relayed.onEvent, {
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
            });
            const created: Listening = {
              session: started,
              token: crypto.randomUUID(),
              ws: null,
              backlog: [],
              cap: new SilenceCap(maxPauseMs(maxPause())),
              received: 0,
              over: false,
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
      }
    },
    close(ws: VoiceSocket) {
      const listening = bySocket.get(ws);
      if (listening) detach(listening, "socket closed");
    },
  };
}
