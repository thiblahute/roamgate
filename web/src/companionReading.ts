/**
 * What the companion reads aloud on a call, sentence by sentence, so the
 * page can show where it is (CompanionReading.tsx under the call's strip,
 * the line in its conversation view, an agent's answer in its chat).
 *
 * The sentences are the ones its voice makes and plays one at a time
 * (voiceFront.ts spokenSentences): the one shown is the one heard.
 */

export type CompanionReading = {
  /** Bumped by each thing said. */
  id: number;
  /** Its line in the companion's conversation view (companionCall.ts log). */
  logId: number | null;
  sentences: readonly string[];
  /** The sentence playing now, or the last one played once it is over. */
  index: number;
  /** Said to its end, or stopped. */
  done: boolean;
  /** An agent's answer read word for word: whose, and its chat entries. */
  answer?: { agent: string; ids: readonly string[] };
};

let reading: CompanionReading | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: CompanionReading | null) {
  reading = next;
  for (const listener of [...listeners]) listener();
}

export function companionReading(): CompanionReading | null {
  return reading;
}

export function subscribeCompanionReading(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Something starts being said, at its first sentence; its id back. */
export function beginCompanionReading(
  sentences: readonly string[],
  {
    logId = null,
    answer,
  }: {
    logId?: number | null;
    answer?: { agent: string; ids: readonly string[] };
  } = {},
): number {
  const id = nextId++;
  publish({
    id,
    logId,
    sentences: [...sentences],
    index: 0,
    done: false,
    ...(answer
      ? { answer: { agent: answer.agent, ids: [...answer.ids] } }
      : {}),
  });
  return id;
}

/** Reading `id` is at sentence `index` now. */
export function companionReadingAt(id: number, index: number) {
  if (reading?.id !== id || reading.index === index) return;
  publish({ ...reading, index, done: false });
}

/** Reading `id` is over: it stays shown, as said, until the next one. */
export function endCompanionReading(id: number) {
  if (reading?.id !== id || reading.done) return;
  publish({ ...reading, done: true });
}

/** The call is over: nothing is shown. */
export function clearCompanionReading() {
  if (reading) publish(null);
}

/** Whether `logId`'s line is the one being said now. */
export function isBeingSaid(
  current: CompanionReading | null,
  logId: number,
): boolean {
  return !!current && !current.done && current.logId === logId;
}

export function __resetCompanionReadingForTests() {
  reading = null;
  nextId = 1;
  listeners.clear();
}
