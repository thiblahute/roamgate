/**
 * Voices that read replies: those cloned from a recording (Qwen3-TTS Base,
 * server/src/voice/voice-library.ts), and Kokoro's own. What the page and
 * the server both need: the languages, what to read aloud when recording,
 * what a voice says when heard, and how a recording's transcript is chosen.
 */

/** The languages a voice can be recorded in and assigned to. */
export const VOICE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]["code"];

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return VOICE_LANGUAGES.some((language) => language.code === value);
}

export function voiceLanguageLabel(code: string): string {
  return (
    VOICE_LANGUAGES.find((language) => language.code === code)?.label ?? code
  );
}

/**
 * What to read aloud for a new voice: two short sentences of easy words, 8
 * to 12 seconds read by a child (who reads about two words a second), so
 * the reading ends well before the recording has to.
 */
export const READING_TEXTS: Record<VoiceLanguage, readonly string[]> = {
  en: [
    "A little dragon lives in a big green tree. Every morning, he eats a red apple and sings a song.",
    "Today the sun is shining. My best friend is coming to play, and we will build a big castle.",
  ],
  fr: [
    "Un petit dragon vit dans un grand arbre. Le matin, il mange une pomme et chante une chanson.",
    "Aujourd'hui, il fait beau. Mon ami vient jouer, et nous allons faire un grand château.",
  ],
  es: [
    "Un pequeño dragón vive en un árbol grande. Cada mañana come una manzana y canta una canción.",
    "Hoy hace sol. Mi amigo viene a jugar, y vamos a hacer un castillo enorme.",
  ],
  it: [
    "Un piccolo drago vive in un grande albero. Ogni mattina mangia una mela e canta una canzone.",
    "Oggi c'è il sole. Il mio amico viene a giocare, e facciamo un castello enorme.",
  ],
  pt: [
    "Um pequeno dragão mora numa árvore grande. Todas as manhãs ele come uma maçã e canta uma canção.",
    "Hoje está sol. O meu amigo vem brincar, e vamos fazer um castelo enorme.",
  ],
  ja: [
    "小さなドラゴンが大きな木に住んでいます。毎朝、りんごを食べて歌を歌います。",
    "今日はいい天気です。友だちと大きなお城を作ります。",
  ],
  zh: [
    "一条小龙住在大树上。每天早上，它吃一个苹果，唱一首歌。",
    "今天天气很好。我的朋友来玩，我们一起搭一个大城堡。",
  ],
};

/** What a voice says when heard before it is chosen. */
export const SAMPLE_SENTENCES: Record<VoiceLanguage, string> = {
  en: "Hello! This is my voice. Shall we have an adventure together?",
  fr: "Bonjour ! Voici ma voix. On part à l'aventure ensemble ?",
  es: "¡Hola! Esta es mi voz. ¿Vamos juntos de aventura?",
  it: "Ciao! Questa è la mia voce. Partiamo insieme per un'avventura?",
  pt: "Olá! Esta é a minha voz. Vamos viver uma aventura juntos?",
  ja: "こんにちは！これが私の声です。一緒に冒険しましょう！",
  zh: "你好！这是我的声音。我们一起去冒险吧！",
};

/** The shortest a recording may be, in seconds. */
export const MIN_RECORDING_SECONDS = 5;
/**
 * The longest: the helper's limit. Only a last resort; a reading ends on
 * its own at the pause after it, or with the stop button.
 */
export const MAX_RECORDING_SECONDS = 30;
export const MAX_VOICE_NAME_LENGTH = 40;

/** A voice's name as given, or null when it cannot be one. */
export function cleanVoiceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_VOICE_NAME_LENGTH ? name : null;
}

/** A file name for a voice named `name`: "Léa" is "lea", "Pirate !" "pirate". */
export function voiceSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "voice";
}

/** `slug`, or with a number after it when `taken` has it. */
export function uniqueVoiceId(slug: string, taken: (id: string) => boolean) {
  if (!taken(slug)) return slug;
  for (let n = 2; ; n += 1) if (!taken(`${slug}-${n}`)) return `${slug}-${n}`;
}

/** A word of a text, as compared, and where it ends in the text. */
type WordSpan = { word: string; end: number };

// Chinese and Japanese go without spaces: each character is a word.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const start = match.index ?? 0;
    const plain = match[0]
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .toLowerCase();
    if (!plain) continue;
    if (CJK.test(plain)) {
      let at = start;
      for (const char of match[0]) {
        at += char.length;
        spans.push({ word: char, end: at });
      }
    } else spans.push({ word: plain, end: start + match[0].length });
  }
  return spans;
}

/** The words of `text`, to compare: no case, accents or punctuation. */
export function transcriptWords(text: string): string[] {
  return wordSpans(text).map((span) => span.word);
}

function editDistance(expected: string[], got: string[]): number {
  let previous = Array.from({ length: got.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= got.length; j += 1)
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (expected[i - 1] === got[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return previous[got.length]!;
}

/** The share of `reference`'s words that `heard` gets wrong (WER). */
export function wordErrorRate(reference: string, heard: string): number {
  const expected = transcriptWords(reference);
  const got = transcriptWords(heard);
  if (!expected.length) return got.length ? 1 : 0;
  return editDistance(expected, got) / expected.length;
}

/**
 * Up to this share of words may differ between the text shown and what
 * the speech recognizer heard for the text to count as read: a recognizer
 * mishears a word now and then. Its last words must be heard too.
 */
export const TRANSCRIPT_TOLERANCE = 0.15;
/** Heard this differently from the text, the user is offered to record again. */
export const RERECORD_RATE = 0.4;

/**
 * Which words go with the recording, which Qwen3-TTS must have exactly to
 * clone it well (words the audio does not say make a bad voice):
 * - "shown": the text shown, read whole (its spelling and punctuation);
 * - "partial": the start of the text shown, as far as it was read, when
 *   the reading stopped early or the recording was cut;
 * - "heard": what the recognizer heard, when it was not the text.
 * A recording cut while speech went on (`cut`) never gets the whole text:
 * its last word may not be in it. Without a recognizer, the text shown.
 */
export function chooseTranscript(
  shown: string,
  heard: string,
  { cut = false }: { cut?: boolean } = {},
): { text: string; kind: "shown" | "partial" | "heard" } {
  const said = heard.replace(/\s+/g, " ").trim();
  const text = shown.replace(/\s+/g, " ").trim();
  if (!said) return { text, kind: "shown" };
  const spans = wordSpans(text);
  const got = transcriptWords(said);
  if (!spans.length || !got.length) return { text: said, kind: "heard" };
  const expected = spans.map((span) => span.word);
  // How far into the text the reading went: the prefix it matches best,
  // the longest of those that match as well.
  let best = { length: 0, distance: Number.POSITIVE_INFINITY };
  for (let length = 1; length <= expected.length; length += 1) {
    const distance = editDistance(expected.slice(0, length), got);
    if (distance <= best.distance) best = { length, distance };
  }
  const read = expected.slice(0, best.length);
  const close = best.distance <= Math.floor(read.length * TRANSCRIPT_TOLERANCE);
  // The reading's last word is the text's: it stopped there, not elsewhere.
  const endsAlike = got[got.length - 1] === read[read.length - 1];
  if (close && endsAlike && best.length === expected.length && !cut)
    return { text, kind: "shown" };
  if (close && endsAlike) {
    const partial = text
      .slice(0, spans[best.length - 1]!.end)
      .replace(/[\s,;:]+$/u, "");
    return { text: partial, kind: "partial" };
  }
  return { text: said, kind: "heard" };
}

/** Below this RMS, a moment of the microphone is silence. */
export const SPEECH_RMS = 0.015;
/** This long a silence after the reading ends it. */
export const END_PAUSE_SECONDS = 1.6;
/** Speech in the last this many seconds of a recording means it was cut. */
export const CUT_SECONDS = 0.5;
/** A child reads about this many words a second, or characters in CJK. */
const WORDS_PER_SECOND = 1.8;
const CJK_CHARS_PER_SECOND = 3;

/** About how long reading `text` aloud takes a child, in seconds. */
export function readingSeconds(text: string): number {
  const words = transcriptWords(text);
  const cjk = words.some((word) => CJK.test(word));
  return words.length / (cjk ? CJK_CHARS_PER_SECOND : WORDS_PER_SECOND);
}

/**
 * Follows a recording as it goes, in moments of its level, to say when it
 * is over: at a pause once most of the text has likely been read, or at
 * MAX_RECORDING_SECONDS as a last resort; and whether it ended mid-speech.
 * A pause before that (a breath, a hard word) does not end it.
 */
export class ReadingEnd {
  private seconds = 0;
  private speech = 0;
  private lastSpeech = Number.NEGATIVE_INFINITY;
  /** Speech this long means most of the text was read. */
  private readonly enough: number;

  constructor(text: string) {
    this.enough = Math.max(2, readingSeconds(text) * 0.6);
  }

  /** `seconds` more of the recording at `rms`: whether it is over. */
  push(rms: number, seconds: number): "go on" | "pause" | "limit" {
    this.seconds += seconds;
    if (rms >= SPEECH_RMS) {
      this.speech += seconds;
      this.lastSpeech = this.seconds;
    }
    if (this.seconds >= MAX_RECORDING_SECONDS) return "limit";
    if (
      this.speech >= this.enough &&
      this.seconds - this.lastSpeech >= END_PAUSE_SECONDS
    )
      return "pause";
    return "go on";
  }

  /** Whether the recording ends while speech goes on. */
  cut(): boolean {
    return this.seconds - this.lastSpeech < CUT_SECONDS;
  }
}
