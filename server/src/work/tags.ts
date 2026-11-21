import { normalizeWorkTag, normalizeWorkTags } from "../../../shared/work";

/**
 * The tags a new item gets by itself when it is given none: read from its
 * words, deterministic and cheap (no model). A tag the project already
 * uses (its own list, or one of its items') is taken when the text names
 * it, or one of its synonyms; an area of the app (the phone, reviews,
 * voice, the Files pane...) when the text names it, spelt as the project
 * spells it when it uses a word of the same group. Its owner (the
 * coordinator, sorting an item the user added as free text) adds or
 * removes some afterwards.
 */

/** At most this many tags are given by themselves. */
export const WORK_AUTO_TAGS = 4;

/**
 * Areas of the app and their words: the first word is the tag given
 * when the project spells it no other way. A phrase is matched as
 * consecutive words; a word also in its plural.
 */
export const WORK_TAG_AREAS: readonly (readonly string[])[] = [
  ["phone", "mobile", "touch screen", "touchscreen", "smartphone"],
  ["android", "apk"],
  ["reviews", "review", "mr", "merge request", "pull request", "pr", "gitlab"],
  ["voice", "tts", "stt", "speech", "microphone", "mic", "call"],
  ["chat", "conversation", "transcript"],
  ["files", "files pane", "files view", "file tree", "file browser"],
  ["changes", "changes view", "changes pane"],
  ["work-board", "work board", "work view", "work item", "kanban"],
  ["terminal", "xterm"],
  ["notifications", "notification", "notify", "push notification"],
  ["mac", "macos"],
];

/**
 * Words of an area that name it only as part of a phrase or as the
 * project's own tag: "changes" or "files" alone are too common to mean
 * the Changes view or the Files pane, "call" or "pr" too short to trust.
 */
const WEAK_WORDS = new Set(["changes", "files", "call", "pr", "mic", "push"]);

/** The words of a text: lower case, letters and digits, in order. */
export function workWords(text: string): string[] {
  return (
    text
      // An image's Markdown is not words.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : word;
}

/** Where a phrase (words, dash or space separated) first stands, or -1. */
function phraseAt(words: readonly string[], phrase: string): number {
  const parts = workWords(phrase.replace(/-/g, " ")).map(singular);
  if (!parts.length) return -1;
  for (let at = 0; at + parts.length <= words.length; at++) {
    let ok = true;
    for (let i = 0; i < parts.length; i++)
      if (singular(words[at + i]!) !== parts[i]) {
        ok = false;
        break;
      }
    if (ok) return at;
  }
  return -1;
}

/**
 * The tags a text calls for, in the order the text names them, at most
 * WORK_AUTO_TAGS: `vocabulary` is the project's tags (its list and its
 * items', most used first).
 */
export function autoWorkTags(
  text: string,
  vocabulary: readonly string[],
): string[] {
  const words = workWords(text);
  if (!words.length) return [];
  const known = normalizeWorkTags(vocabulary.slice(0, 500));
  const found = new Map<string, number>();
  const take = (tag: string, at: number) => {
    const before = found.get(tag);
    if (at >= 0 && (before === undefined || at < before)) found.set(tag, at);
  };
  const grouped = new Set<string>();
  for (const group of WORK_TAG_AREAS) {
    const terms = group.map(normalizeWorkTag);
    // The project's spelling of the area, else the area's own.
    const tag = known.find((each) => terms.includes(each)) ?? terms[0]!;
    for (const term of terms) grouped.add(term);
    let at = -1;
    for (const term of group) {
      const strong =
        !WEAK_WORDS.has(term) || known.includes(normalizeWorkTag(term));
      if (!strong) continue;
      const here = phraseAt(words, term);
      if (here >= 0 && (at < 0 || here < at)) at = here;
    }
    take(tag, at);
  }
  // The project's other tags, named by their words.
  for (const tag of known) {
    if (grouped.has(tag) || tag.length < 2) continue;
    take(tag, phraseAt(words, tag));
  }
  return [...found.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([tag]) => tag)
    .slice(0, WORK_AUTO_TAGS);
}
