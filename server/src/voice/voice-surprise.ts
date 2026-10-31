/**
 * Surprise: each reply is read by one of the user's voices, picked at
 * random (never the one that read the reply before when there is another),
 * whatever language the reply is in: a voice recorded in French reads
 * English too, with its own timbre. One voice per reply, not per sentence,
 * so a reply sounds like one person; the helper switches voices once, at
 * the reply's first sentence.
 */

/** A voice to pick from. */
export type SurpriseVoice = { id: string };

/** A voice for a reply: any, but not `last` when another one may read. */
export function pickSurpriseVoice(
  voices: readonly SurpriseVoice[],
  last: string | null,
  random: () => number = Math.random,
): string | null {
  const fresh = voices.filter((voice) => voice.id !== last);
  const choices = fresh.length ? fresh : voices;
  if (!choices.length) return null;
  const index = Math.min(
    choices.length - 1,
    Math.floor(random() * choices.length),
  );
  return choices[index]!.id;
}

/** Readings remembered, so each sentence of a reply keeps its voice. */
const REMEMBERED = 64;

/**
 * Who reads each reply: picked at its first sentence, kept for the rest
 * (`reading` names the reply; without one, each sentence is a reply).
 */
export class SurprisePicker {
  private readonly readings = new Map<string, string>();
  private last: string | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  pick(voices: readonly SurpriseVoice[], reading?: string): string | null {
    const known = reading ? this.readings.get(reading) : undefined;
    if (known && voices.some((voice) => voice.id === known)) return known;
    const id = pickSurpriseVoice(voices, this.last, this.random);
    if (!id) return null;
    this.last = id;
    if (reading) {
      this.readings.set(reading, id);
      if (this.readings.size > REMEMBERED)
        this.readings.delete(this.readings.keys().next().value!);
    }
    return id;
  }
}
