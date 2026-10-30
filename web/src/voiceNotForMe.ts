/**
 * What voice chat says when the router took what was said as meant for
 * nobody (talk in the room, a remark to oneself): a few words, in the
 * language it was said in, so a sentence left unsent does not look like
 * the voice was not recognized. At most once in a while, so chatter in
 * the background does not make it talk all the time; the card always
 * shows what was not sent.
 */

import { type AckLanguage, ackLanguage } from "./voiceAck";

/** Said when a sentence was taken as not for the agent. */
export const NOT_FOR_ME_PHRASES: Record<AckLanguage, string> = {
  en: "I took that as not for me.",
  fr: "J'ai compris que ce n'était pas pour moi.",
  es: "Entendí que no era para mí.",
};

/** Said at most once this often; shown every time. */
export const NOT_FOR_ME_GAP_MS = 30_000;

export type NotForMeLine = { text: string; language: AckLanguage };

/**
 * When to say it: `next(said)` gives the words to say for a sentence taken
 * as not for the agent, or null when they were said less than `gapMs` ago.
 */
export function createNotForMeNotice({
  gapMs = NOT_FOR_ME_GAP_MS,
  now = () => performance.now(),
}: {
  gapMs?: number;
  now?: () => number;
} = {}) {
  let saidAt: number | null = null;
  return {
    next(said: string): NotForMeLine | null {
      const at = now();
      if (saidAt !== null && at - saidAt < gapMs) return null;
      saidAt = at;
      const language = ackLanguage(said);
      return { text: NOT_FOR_ME_PHRASES[language], language };
    },
  };
}

export type NotForMeNotice = ReturnType<typeof createNotForMeNotice>;
