/**
 * Keeps a sentence playing when something outside the page pauses it.
 *
 * On a phone, a reply's audio element is paused by the system: Android
 * takes the audio focus away (a navigation prompt, the car's head unit,
 * Bluetooth switching profiles when the microphone opens), and Chrome
 * pauses the page's media; it does not always give it back. Nothing then
 * ends the sentence and the reading sits silent. A pause the page did not
 * ask for is that, unless it came from the media controls (the car's or a
 * headset's pause button, the lock screen), which go through the media
 * session's action handlers (holdAudioFocus): those are the user's and are
 * honoured until they press play.
 *
 * Any other pause is retried after RETRY_MS, from where it was, then from
 * the sentence's start; the tries are the sentence's, whether a try played
 * a moment or not, so past the last one the sentence is skipped and the
 * reading goes on: a pause that keeps coming back never loops.
 *
 * A pause just after another of the page's own media elements was asked to
 * play (noteOwnPlay) is not from outside: the system gave that one the
 * focus. The other one is told to yield (the voice call's silent focus
 * holder goes quiet), and the sentence plays on. While a guarded sentence
 * plays (readingPlays), the holder stays quiet, so they never take turns.
 */

/** What of an audio element the guard uses. */
export type GuardedPlayer = {
  readonly ended: boolean;
  readonly paused: boolean;
  readonly duration: number;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "pause" | "playing", listener: () => void): void;
};

/** Waits before each try to play a paused sentence again. */
export const RETRY_MS = [300, 1000, 2500, 5000];
/** From this try on, the sentence starts again. */
const FROM_START_TRY = 2;

type Trace = (line: string) => void;

/** How soon after one of the page's own elements plays a pause is its doing. */
export const OWN_PAUSE_MS = 500;

/** The last of the page's own media elements asked to play, and when. */
let ownPlay: { player: unknown; at: number; yieldFocus?: () => void } | null =
  null;

/**
 * One of the page's own media elements is asked to play: a pause of
 * another one just after is the system handing it the focus. `yieldFocus`
 * makes it give the focus back (the holder going quiet).
 */
export function noteOwnPlay(
  player: unknown,
  yieldFocus?: () => void,
  now = Date.now(),
) {
  ownPlay = { player, at: now, ...(yieldFocus ? { yieldFocus } : {}) };
}

/** The own element whose play paused `player`, if one did. */
function ownPauser(player: unknown, now = Date.now()) {
  return ownPlay && ownPlay.player !== player && now - ownPlay.at < OWN_PAUSE_MS
    ? ownPlay
    : null;
}

/** The sentences playing now, as elements; listeners hear each change. */
const readings = new Set<GuardedPlayer>();
const readingListeners = new Set<() => void>();

/** Whether a sentence plays now as a media element. */
export function readingPlays() {
  return readings.size > 0;
}

export function subscribeReadings(listener: () => void): () => void {
  readingListeners.add(listener);
  return () => readingListeners.delete(listener);
}

function readingsChanged() {
  for (const listener of [...readingListeners]) listener();
}

/** The media controls' pause, and the sentence playing now. */
const controls: {
  userPaused: boolean;
  current: GuardedPlayer | null;
  trace: Trace;
} = { userPaused: false, current: null, trace: () => {} };

/** The media controls (car, headset, lock screen) asked for a pause. */
export function mediaControlPause(trace: Trace) {
  controls.userPaused = true;
  trace("pause from the media controls (car or headset): honoured");
  controls.current?.pause();
}

/** The media controls asked to play again. */
export function mediaControlPlay(trace: Trace) {
  const was = controls.userPaused;
  controls.userPaused = false;
  trace(
    was
      ? "play from the media controls: the reading goes on"
      : "play from the media controls",
  );
  const player = controls.current;
  if (player?.paused && !player.ended)
    player.play().catch((error) => trace(`play refused: ${error}`));
}

/** Whether the media controls hold the reading paused. */
export function pausedByControls() {
  return controls.userPaused;
}

/** A voice chat starts or ends: an old pause from the controls is gone. */
export function resetMediaControls() {
  controls.userPaused = false;
  ownPlay = null;
}

/**
 * Watches `player` while it plays a sentence. Call `release()` before the
 * page pauses it itself (the sentence is over or stopped); `onGiveUp` ends
 * the sentence when it cannot play again.
 */
export function guardPlayback(
  player: GuardedPlayer,
  { trace, onGiveUp }: { trace: Trace; onGiveUp: () => void },
): { release: () => void } {
  let released = false;
  // This sentence's tries, all its pauses together.
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let externallyPaused = false;
  controls.current = player;
  readings.add(player);
  readingsChanged();
  const at = () =>
    `${player.currentTime.toFixed(2)}/${player.duration.toFixed(2)}`;
  const atEnd = () =>
    player.ended ||
    (Number.isFinite(player.duration) &&
      player.currentTime >= player.duration - 0.05);

  const retry = () => {
    timer = null;
    if (released || controls.userPaused || !player.paused) return;
    if (tries >= RETRY_MS.length) {
      trace(
        `the sentence kept being paused from outside the page: skipped after ${tries} tries`,
      );
      released = true;
      if (readings.delete(player)) readingsChanged();
      onGiveUp();
      return;
    }
    const delay = RETRY_MS[tries]!;
    tries += 1;
    timer = setTimeout(() => {
      timer = null;
      if (released || controls.userPaused) return;
      if (!player.paused) return;
      if (tries > FROM_START_TRY) {
        trace(`playing the sentence again from its start (try ${tries})`);
        player.currentTime = 0;
      } else
        trace(`playing on after an outside pause at ${at()} (try ${tries})`);
      player.play().catch((error) => {
        trace(`play refused (try ${tries}): ${error}`);
        retry();
      });
    }, delay);
  };

  player.addEventListener("pause", () => {
    if (released || atEnd()) return;
    if (controls.userPaused) {
      trace(`paused by the media controls at ${at()}: waits for play`);
      return;
    }
    externallyPaused = true;
    const own = ownPauser(player);
    if (own) {
      // The system gave the focus to our other element: it yields.
      trace(
        `paused at ${at()} as another of the page's own media started: not an outside pause, it yields`,
      );
      own.yieldFocus?.();
    } else
      trace(
        `paused from outside the page at ${at()} (audio focus or routing): playing on`,
      );
    if (!timer) retry();
  });
  player.addEventListener("playing", () => {
    if (released || !externallyPaused) return;
    externallyPaused = false;
    trace(`playing again at ${at()}`);
    // A later pause goes on with the tries left: they are the sentence's.
    if (timer) clearTimeout(timer);
    timer = null;
  });
  return {
    release: () => {
      released = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (controls.current === player) controls.current = null;
      if (readings.delete(player)) readingsChanged();
    },
  };
}
