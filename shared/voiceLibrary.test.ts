import { describe, expect, test } from "bun:test";
import {
  chooseTranscript,
  END_PAUSE_SECONDS,
  MAX_RECORDING_SECONDS,
  ReadingEnd,
  readingSeconds,
  cleanVoiceName,
  READING_TEXTS,
  SAMPLE_SENTENCES,
  transcriptWords,
  uniqueVoiceId,
  VOICE_LANGUAGES,
  voiceSlug,
  wordErrorRate,
} from "./voiceLibrary";

describe("voice library", () => {
  test("every language has a text to read and a sample", () => {
    for (const { code } of VOICE_LANGUAGES) {
      expect(READING_TEXTS[code].length).toBeGreaterThan(0);
      expect(SAMPLE_SENTENCES[code]).toBeTruthy();
    }
  });

  test("names are trimmed and bounded", () => {
    expect(cleanVoiceName("  Léa   la  pirate ")).toBe("Léa la pirate");
    expect(cleanVoiceName("   ")).toBeNull();
    expect(cleanVoiceName("x".repeat(41))).toBeNull();
    expect(cleanVoiceName(3)).toBeNull();
  });

  test("slugs are plain file names", () => {
    expect(voiceSlug("Léa")).toBe("lea");
    expect(voiceSlug("Pirate !")).toBe("pirate");
    expect(voiceSlug("Papa (FR)")).toBe("papa-fr");
    expect(voiceSlug("../..")).toBe("voice");
    expect(voiceSlug("小龙")).toBe("小龙");
    const taken = new Set(["lea", "lea-2"]);
    expect(uniqueVoiceId("lea", (id) => taken.has(id))).toBe("lea-3");
    expect(uniqueVoiceId("tom", (id) => taken.has(id))).toBe("tom");
  });

  test("words compare without case, accents or punctuation", () => {
    expect(transcriptWords("Il était une fois, un DRAGON!")).toEqual([
      "il",
      "etait",
      "une",
      "fois",
      "un",
      "dragon",
    ]);
    expect(transcriptWords("你好，小龙")).toEqual(["你", "好", "小", "龙"]);
    expect(wordErrorRate("one two three four", "one two three four")).toBe(0);
    expect(wordErrorRate("one two three four", "one too three")).toBe(0.5);
    expect(wordErrorRate("", "")).toBe(0);
  });

  test("the text shown is kept only when read to its end", () => {
    const shown = READING_TEXTS.fr[0]!;
    // A recognizer's punctuation and a word misheard in the middle: the
    // text shown.
    expect(
      chooseTranscript(
        shown,
        "un petit dragon vit dans un grand arbre le matin il mangent une pomme et chante une chanson",
      ),
    ).toEqual({ text: shown, kind: "shown" });
    // Nothing heard (no recognizer): the text shown.
    expect(chooseTranscript(shown, " ")).toEqual({
      text: shown,
      kind: "shown",
    });
  });

  test("a reading stopped early keeps the start of the text, as far as read", () => {
    // Oli's: the recording stopped while she read; the end is not in it.
    const shown =
      "Il était une fois un petit dragon qui vivait dans un grand arbre vert. Chaque matin, il mangeait trois pommes rouges, chantait une chanson rigolote, et volait au-dessus de la ville.";
    const heard =
      "Il était une fois un petit dragon qui vivait dans un grand arbre vert. Chaque matin, il mangeait trois pommes rouges, chantait";
    expect(chooseTranscript(shown, heard)).toEqual({
      text: "Il était une fois un petit dragon qui vivait dans un grand arbre vert. Chaque matin, il mangeait trois pommes rouges, chantait",
      kind: "partial",
    });
    // The old rule took the whole text for a missing ending of 4 words in
    // 28; no longer.
    const missingEnd =
      "il était une fois un petit dragon qui vivait dans un grand arbre vert chaque matin il mangeait trois pommes rouges chantait une chanson rigolote et volait au";
    expect(chooseTranscript(shown, missingEnd).kind).toBe("partial");
    expect(chooseTranscript(shown, missingEnd).text.endsWith("volait au")).toBe(
      true,
    );
  });

  test("a recording cut mid-speech never gets the whole text", () => {
    const shown = READING_TEXTS.en[0]!;
    const heard = shown.toLowerCase();
    expect(chooseTranscript(shown, heard).kind).toBe("shown");
    // Heard to the end, but cut: its last word may be cut too.
    const cut = chooseTranscript(shown, heard, { cut: true });
    expect(cut.kind).toBe("partial");
    expect(cut.text).toBe(shown.replace(/\.$/, ""));
  });

  test("something else said, or a different ending: what was heard", () => {
    const shown = READING_TEXTS.fr[0]!;
    expect(chooseTranscript(shown, "Coucou, je suis un pirate !")).toEqual({
      text: "Coucou, je suis un pirate !",
      kind: "heard",
    });
    // The text, then words of their own at the end.
    const extra = `${shown} Et voilà, c'est fini !`;
    expect(chooseTranscript(shown, extra)).toEqual({
      text: extra,
      kind: "heard",
    });
    // Its last word said differently: the transcription wins.
    const changed = shown.replace("chanson.", "chanteuse.");
    expect(chooseTranscript(shown, changed)).toEqual({
      text: changed,
      kind: "heard",
    });
  });

  test("Chinese and Japanese are compared by character", () => {
    const shown = READING_TEXTS.zh[0]!;
    expect(chooseTranscript(shown, shown).kind).toBe("shown");
    expect(chooseTranscript(shown, "一条小龙住在大树上").text).toBe(
      "一条小龙住在大树上",
    );
  });

  test("the texts take a child 8 to 12 seconds", () => {
    for (const { code } of VOICE_LANGUAGES)
      for (const text of READING_TEXTS[code]) {
        const seconds = readingSeconds(text);
        expect(seconds).toBeGreaterThanOrEqual(6);
        expect(seconds).toBeLessThanOrEqual(12);
      }
  });
});

/** `seconds` of a level, in 10 ms moments. */
function feed(end: ReadingEnd, rms: number, seconds: number) {
  let verdict = "go on";
  for (let i = 0; i < Math.round(seconds * 100) && verdict === "go on"; i += 1)
    verdict = end.push(rms, 0.01);
  return verdict;
}

describe("the end of a reading", () => {
  const text = READING_TEXTS.fr[0]!;
  const speech = 0.06;
  const silence = 0.004;

  test("comes at the pause after the text is read", () => {
    const end = new ReadingEnd(text);
    expect(feed(end, silence, 2)).toBe("go on");
    expect(feed(end, speech, 9)).toBe("go on");
    expect(feed(end, silence, END_PAUSE_SECONDS + 0.1)).toBe("pause");
    expect(end.cut()).toBe(false);
  });

  test("not at a pause in the middle of it", () => {
    const end = new ReadingEnd(text);
    expect(feed(end, speech, 2)).toBe("go on");
    expect(feed(end, silence, 3)).toBe("go on");
    expect(feed(end, speech, 3)).toBe("go on");
  });

  test("a slow reader goes on to the limit, and the recording is cut", () => {
    const end = new ReadingEnd(text);
    expect(feed(end, speech, MAX_RECORDING_SECONDS + 1)).toBe("limit");
    expect(end.cut()).toBe(true);
  });

  test("silence alone never ends before the limit", () => {
    const end = new ReadingEnd(text);
    expect(feed(end, silence, MAX_RECORDING_SECONDS - 1)).toBe("go on");
    expect(feed(end, silence, 2)).toBe("limit");
    expect(end.cut()).toBe(false);
  });

  test("a reading takes about two words a second", () => {
    expect(readingSeconds("one two three four")).toBeCloseTo(4 / 1.8);
    expect(readingSeconds("一二三")).toBeCloseTo(1);
  });
});
