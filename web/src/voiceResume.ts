/**
 * Voice chat's readings cut short by speech: speaking up stops the reading
 * at once, before what was said is known. When it comes to nothing sent
 * (no words, noise, words said to someone else), the reading goes on from
 * the sentence it stopped at, or from its start when none had played. A
 * message sent, or "stop", leaves it stopped.
 */

/** What became of the speech that cut a reading short. */
export type CutOutcome =
  /** Nothing came of it: the helper heard no words. */
  | "nothing"
  /** Words, but noise: nothing to send. */
  | "noise"
  /** Said to someone else (the cleaner's reading, or the router's). */
  | "not-for-agent"
  /** A message, sent to an agent. */
  | "sent"
  /** "Stop", said or tapped. */
  | "stop"
  /** Taken elsewhere: a question asked back, an errand, another session. */
  | "elsewhere";

/** Whether a reading cut by speech that came to `outcome` goes on. */
export function resumesReading(outcome: CutOutcome): boolean {
  return (
    outcome === "nothing" || outcome === "noise" || outcome === "not-for-agent"
  );
}

/** Where a cut reading goes on: sentences to skip, and the one cut. */
export type ReadingCut = { skip: number; sentence: string | null };

/** The cut to go on from after `outcome`, or null when it stays stopped. */
export function resumeAfter<T extends ReadingCut>(
  cut: T | null,
  outcome: CutOutcome,
): T | null {
  return cut && resumesReading(outcome) ? cut : null;
}

/**
 * Follows a reading a sentence at a time (speak's and speakStream's
 * `onSentence`: each sentence as it starts, then null at the end), to know
 * where it was cut. `skip` is how many sentences the reading skipped: a
 * reading going on from a cut counts from there.
 */
export function createReadingPlace(skip = 0) {
  let started = 0;
  let playing: string | null = null;
  let cut: ReadingCut | null = null;
  return {
    /** A sentence starts playing, or (null) the reading is over. */
    sentence(sentence: string | null) {
      if (cut) return;
      if (sentence === null) playing = null;
      else {
        started += 1;
        playing = sentence;
      }
    },
    /**
     * The reading is cut now: where it goes on, the sentence playing read
     * again from its start. Taken once; later calls give the same place.
     */
    cut(): ReadingCut {
      cut ??= {
        skip: skip + (playing === null ? started : started - 1),
        sentence: playing,
      };
      return cut;
    },
  };
}

export type ReadingPlace = ReturnType<typeof createReadingPlace>;
