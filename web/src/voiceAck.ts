/**
 * Voice chat's acknowledgements: when the agent's answer is slow to come,
 * a few words say the message was heard ("Got it, on it."), in the language
 * it was said in, never the same twice in a row, once per turn; and once,
 * on a long turn with nothing read for a while, that it is still going.
 * Only played: never sent, never shown.
 */

export type AckLanguage = "en" | "fr" | "es";

/** Said once the message was heard, when the answer is not read yet. */
export const ACK_PHRASES: Record<AckLanguage, readonly string[]> = {
  en: [
    "Got it, on it.",
    "On it.",
    "I heard you, I'll come back when it's done.",
    "Okay, working on it.",
    "Got it. I'll get back to you.",
    "Alright, I'm on it.",
    "Heard you. Give me a moment.",
  ],
  fr: [
    "Compris, je m'en occupe.",
    "Je t'ai entendu, je reviens vers toi quand c'est fait.",
    "C'est parti.",
    "D'accord, je m'en occupe.",
    "Bien reçu, je reviens vers toi.",
    "Ok, j'y vais.",
  ],
  es: [
    "Entendido, me pongo con ello.",
    "Vale, voy.",
    "Te escuché, te aviso cuando termine.",
    "De acuerdo, en ello.",
  ],
};

/** Said once on a long turn with nothing read for a while. */
export const STILL_PHRASES: Record<AckLanguage, readonly string[]> = {
  en: ["Still working on it.", "Still on it."],
  fr: ["Je suis toujours dessus.", "Toujours en cours."],
  es: ["Sigo con ello.", "Todavía estoy en ello."],
};

/** The answer not read this long after the message: the ack is said. */
export const ACK_DELAY_MS = 1200;
/** Later than this (the user kept talking), the ack would come too late. */
export const ACK_LATEST_MS = 6000;
/** Nothing read this long while the agent works: still working, once. */
export const STILL_WORKING_MS = 45_000;
/** An ack playing when the answer comes ends its words, cut past this. */
export const ACK_CUT_MS = 2500;
/** How often whether an ack is due is looked at. */
const ACK_TICK_MS = 200;

// Words common in what is said to an agent, by language.
const WORDS: Record<AckLanguage, ReadonlySet<string>> = {
  en: new Set(
    "the a an is are i you it this that what can could do does please and to of in on for with my me be have how why make fix check run".split(
      " ",
    ),
  ),
  fr: new Set(
    "le la les un une des du de est et je tu il elle on nous vous ce ça ca que qui quoi pas pour avec dans sur mon ma mes peux fais faire est-ce c'est j'ai qu'il n'est oui non merci aussi mais".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las un una es y yo tú tu que qué por para con en mi puedes hacer haz está esto eso pero gracias sí también como".split(
      " ",
    ),
  ),
};

/** The language of what was said, among those acks are in; English when unclear. */
export function ackLanguage(text: string): AckLanguage {
  const lower = text.toLowerCase().replace(/[’]/g, "'");
  const scores: Record<AckLanguage, number> = { en: 0, fr: 0, es: 0 };
  for (const word of lower.match(/[\p{L}'-]+/gu) ?? []) {
    for (const language of ["en", "fr", "es"] as const)
      if (WORDS[language].has(word)) scores[language] += 1;
    // Elisions (j'ai, c'est, l'erreur) are French.
    if (/^(?:[jcdlmnst]|qu)'\p{L}/u.test(word)) scores.fr += 1;
  }
  if (/[çèêàùœ]/.test(lower)) scores.fr += 2;
  if (/[ñ¿¡]/.test(lower)) scores.es += 2;
  let best: AckLanguage = "en";
  for (const language of ["fr", "es"] as const)
    if (scores[language] > scores[best]) best = language;
  return best;
}

// The last phrase said, so the next one differs.
let lastPhrase: string | null = null;

/** One of `phrases` at random, never `last` when there is a choice. */
export function pickPhrase(
  phrases: readonly string[],
  last: string | null,
  random: () => number = Math.random,
): string {
  const choices =
    phrases.length > 1 ? phrases.filter((phrase) => phrase !== last) : phrases;
  const index = Math.min(
    choices.length - 1,
    Math.floor(random() * choices.length),
  );
  return choices[index]!;
}

export type AckDue = "ack" | "still" | null;

/** Whether an ack is to be said now, and which. */
export function ackDue(state: {
  /** Since the message was sent. */
  sinceSent: number;
  /** Since something was last read (or the message sent). */
  sinceActivity: number;
  /** The answer started being written or read. */
  started: boolean;
  /** Something plays, or the user talks: not now. */
  busy: boolean;
  /** The agent is still at work. */
  working: boolean;
  acked: boolean;
  stillSaid: boolean;
}): AckDue {
  if (state.busy) return null;
  if (
    !state.acked &&
    !state.started &&
    state.sinceSent >= ACK_DELAY_MS &&
    state.sinceSent < ACK_LATEST_MS
  )
    return "ack";
  if (
    !state.stillSaid &&
    state.working &&
    state.sinceSent >= STILL_WORKING_MS &&
    state.sinceActivity >= STILL_WORKING_MS
  )
    return "still";
  return null;
}

export type AckSpeech<Speech = Blob> = {
  /** The speech of `text`, in `language`, as replies are made. */
  fetchAudio: (
    text: string,
    language: AckLanguage,
    signal: AbortSignal,
  ) => Promise<Speech>;
  /** Plays it at the replies' speed; resolves when it ends or `signal` aborts. */
  playAudio: (audio: Speech, signal: AbortSignal) => Promise<void>;
};

export type TurnAck = {
  /** Something is read now or was just read: the answer has started. */
  activity(): void;
  /** The user talks over it: the ack playing stops. */
  hush(): void;
  /** Whether an ack plays (or is about to) now. */
  playing(): boolean;
  /** Resolves when no ack plays: the one playing ends, cut past ACK_CUT_MS. */
  quiet(): Promise<void>;
  /** No ack anymore this turn; resolves as quiet() does. */
  end(): Promise<void>;
};

/**
 * The acks of one turn, from the message sent (`said`, its words) until
 * end() or `signal` aborts. Each is fetched as soon as it is chosen, so it
 * plays at once when due.
 */
export function startTurnAck<Speech>({
  said,
  signal,
  started,
  busy,
  working = () => false,
  speech,
  now = () => performance.now(),
  random = Math.random,
}: {
  said: string;
  signal: AbortSignal;
  /** The answer is being written or read. */
  started: () => boolean;
  /** Something plays or the user talks. */
  busy: () => boolean;
  working?: () => boolean;
  speech: AckSpeech<Speech>;
  now?: () => number;
  random?: () => number;
}): TurnAck {
  const language = ackLanguage(said);
  const sentAt = now();
  let activityAt = sentAt;
  let acked = false;
  let stillSaid = false;
  let ended = signal.aborted;
  const life = new AbortController();
  const stopLife = () => life.abort();
  if (ended) life.abort();
  else signal.addEventListener("abort", stopLife, { once: true });
  let playing: { controller: AbortController; done: Promise<void> } | null =
    null;
  type Chosen = {
    text: string;
    audio: Promise<Speech>;
    fetching: AbortController;
  };
  const choose = (kind: "ack" | "still"): Chosen => {
    const text = pickPhrase(
      (kind === "ack" ? ACK_PHRASES : STILL_PHRASES)[language],
      lastPhrase,
      random,
    );
    const fetching = new AbortController();
    const audio = speech.fetchAudio(
      text,
      language,
      AbortSignal.any([fetching.signal, life.signal]),
    );
    audio.catch(() => {});
    return { text, audio, fetching };
  };
  // The first ack, fetched now to play the moment it is due.
  let ready: Chosen | null = ended ? null : choose("ack");
  // The answer came first: the first ack is not needed.
  const dropReady = () => {
    ready?.fetching.abort();
    ready = null;
  };
  const say = (kind: "ack" | "still") => {
    const chosen = kind === "ack" && ready ? ready : choose(kind);
    if (kind === "ack") ready = null;
    lastPhrase = chosen.text;
    const controller = new AbortController();
    const stop = AbortSignal.any([controller.signal, life.signal]);
    const done = chosen.audio
      .then((audio) =>
        // Synthesis took long and the answer started meanwhile: an ack
        // would only come after it.
        stop.aborted || (kind === "ack" && started())
          ? undefined
          : speech.playAudio(audio, stop),
      )
      .catch(() => {})
      .finally(() => {
        if (playing?.controller === controller) playing = null;
        activityAt = now();
      });
    playing = { controller, done };
  };
  const tick = () => {
    if (ended || life.signal.aborted) return;
    if (!acked && (started() || now() - sentAt >= ACK_LATEST_MS)) {
      acked = true;
      dropReady();
    }
    const due = playing
      ? null
      : ackDue({
          sinceSent: now() - sentAt,
          sinceActivity: now() - activityAt,
          started: started(),
          busy: busy(),
          working: working(),
          acked,
          stillSaid,
        });
    if (due === "ack") {
      acked = true;
      say("ack");
    } else if (due === "still") {
      stillSaid = true;
      say("still");
    }
  };
  const timer = setInterval(tick, ACK_TICK_MS);
  const stopTimer = () => clearInterval(timer);
  life.signal.addEventListener("abort", stopTimer, { once: true });
  const quiet = async () => {
    const current = playing;
    if (!current) return;
    let cut: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      current.done,
      new Promise<void>((resolve) => {
        cut = setTimeout(() => {
          current.controller.abort();
          resolve();
        }, ACK_CUT_MS);
      }),
    ]);
    clearTimeout(cut);
  };
  return {
    activity() {
      acked = true;
      dropReady();
      activityAt = now();
    },
    hush() {
      playing?.controller.abort();
    },
    playing: () => playing !== null,
    quiet,
    async end() {
      ended = true;
      stopTimer();
      dropReady();
      await quiet();
      signal.removeEventListener("abort", stopLife);
      life.abort();
    },
  };
}
