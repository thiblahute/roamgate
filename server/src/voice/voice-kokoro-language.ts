/**
 * Which language the light voice (Kokoro, Pocket TTS) reads a sentence in,
 * and when it cannot. Their voices speak one language each: the helper tags
 * each sentence with its language (the one asked, else Lingua's guess among
 * the languages Kokoro has a voice for, voice/helper/src/language.rs) and
 * kokorosynthesizer, anyttssynthesizer or pocketsynthesizer take that
 * language's voice (ff_siwis or Pocket TTS's estelle for French, af_heart
 * or alba for English...). A sentence in a language none has a voice for
 * would be guessed as one they have and read with its accent: here it is
 * caught first, and a short notice is read in its place.
 */

/**
 * Kokoro's voice for each language it speaks (one language a voice): a
 * Kokoro entry naming none reads a language with its own.
 */
export const KOKORO_VOICES: Readonly<Record<string, string>> = {
  en: "af_heart",
  es: "ef_dora",
  fr: "ff_siwis",
  hi: "hf_alpha",
  it: "if_sara",
  ja: "jf_alpha",
  pt: "pf_dora",
  zh: "zf_xiaobei",
};

/** Names for the notices, in English (the notice is read in English). */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ar: "Arabic",
  de: "German",
  el: "Greek",
  he: "Hebrew",
  ko: "Korean",
  nl: "Dutch",
  ru: "Russian",
  th: "Thai",
  uk: "Ukrainian",
};

/** Scripts no Kokoro voice reads, and the language each one says. */
const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Cyrillic}/gu, "ru"],
  [/\p{Script=Hangul}/gu, "ko"],
  [/\p{Script=Arabic}/gu, "ar"],
  [/\p{Script=Hebrew}/gu, "he"],
  [/\p{Script=Greek}/gu, "el"],
  [/\p{Script=Thai}/gu, "th"],
];

/**
 * Words only German or Dutch use (none of them an English, French,
 * Spanish, Italian or Portuguese word): Lingua, given only Kokoro's
 * languages, would read such a sentence as one of those.
 */
const WORDS: [Set<string>, string][] = [
  [
    new Set([
      "und",
      "ist",
      "nicht",
      "ich",
      "eine",
      "einen",
      "für",
      "auch",
      "sind",
      "wird",
      "werden",
      "haben",
      "oder",
      "aber",
      "wenn",
      "dass",
      "nach",
      "noch",
      "schon",
      "heute",
      "jetzt",
      "mit",
      "auf",
      "wir",
      "bitte",
      "danke",
    ]),
    "de",
  ],
  [
    new Set([
      "het",
      "een",
      "niet",
      "maar",
      "zijn",
      "wordt",
      "ook",
      "naar",
      "wij",
      "jij",
      "bedankt",
      "alsjeblieft",
      "goed",
      "nog",
    ]),
    "nl",
  ],
];

/**
 * The language of `text` when it is clearly one no Kokoro voice reads: a
 * script of its own (Cyrillic, Hangul...) for most of its letters, or
 * German or Dutch words making up a good part of it. Null otherwise,
 * names and terms in another language included ("le pipeline GitLab CI").
 */
export function unvoicedLanguage(text: string): string | null {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return null;
  for (const [script, language] of SCRIPTS)
    if ((text.match(script)?.length ?? 0) * 2 > letters) return language;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 2) return null;
  for (const [known, language] of WORDS) {
    const hits = words.filter((word) => known.has(word));
    if (new Set(hits).size >= 2 && hits.length * 5 >= words.length)
      return language;
  }
  return null;
}

/**
 * The language Kokoro cannot read `text` in, if any: `language` when it
 * was given and Kokoro has no voice for it, else the one the text is
 * clearly in (unvoicedLanguage). Null when Kokoro reads it.
 */
export function kokoroCannotRead(
  text: string,
  language: string | undefined,
): string | null {
  if (language) {
    const code = language.split(/[-_]/)[0]!.toLowerCase();
    return KOKORO_VOICES[code] ? null : code;
  }
  return unvoicedLanguage(text);
}

/** A `tts_models` entry, as far as the light voice's languages go. */
type LightEntry = { model: string; languages?: string | number };

/**
 * The languages the light voice reads: each Pocket TTS entry's own (its
 * `languages`, a model per language), Kokoro's voices' for Kokoro (alone
 * without `tts_models`, or an entry of its own).
 */
export function lightLanguages(
  models: readonly LightEntry[] | undefined,
): Set<string> {
  if (!models) return new Set(Object.keys(KOKORO_VOICES));
  const languages = new Set<string>();
  for (const entry of models) {
    if (typeof entry.languages === "string")
      for (const code of entry.languages.split(","))
        languages.add(code.trim().split(/[-_]/)[0]!.toLowerCase());
    else if (entry.model === "kokoro")
      for (const code of Object.keys(KOKORO_VOICES)) languages.add(code);
  }
  return languages;
}

/**
 * The language the light voice (`models`: Pocket TTS's and Kokoro's
 * entries, or Kokoro alone) cannot read `text` in, if any: `language` when
 * it was given and none of its voices reads it, else the one the text is
 * clearly in (unvoicedLanguage) when none does. Each voice reads its own
 * language only: one of another language would read it with its accent.
 */
export function lightCannotRead(
  text: string,
  language: string | undefined,
  models: readonly LightEntry[] | undefined,
): string | null {
  const readable = lightLanguages(models);
  const code = language
    ? language.split(/[-_]/)[0]!.toLowerCase()
    : unvoicedLanguage(text);
  return code && !readable.has(code) ? code : null;
}

/** What is read in place of a sentence Kokoro cannot read, in English. */
export function cannotReadNotice(language: string): string {
  const name = LANGUAGE_NAMES[language];
  return name
    ? `This reply is in ${name}, which this voice cannot read.`
    : "This reply is in a language this voice cannot read.";
}
