import { describe, expect, test } from "bun:test";
import {
  cannotReadNotice,
  KOKORO_VOICES,
  kokoroCannotRead,
  lightCannotRead,
  lightLanguages,
  unvoicedLanguage,
} from "./voice-kokoro-language";

describe("Kokoro's languages", () => {
  test("French and English each have their own voice", () => {
    expect(KOKORO_VOICES.fr).toBe("ff_siwis");
    expect(KOKORO_VOICES.en).toBe("af_heart");
    // One language a voice: its first letter says which.
    expect(KOKORO_VOICES.fr?.[0]).toBe("f");
    expect(KOKORO_VOICES.en?.[0]).toBe("a");
  });

  test("French, English and French with English terms are read", () => {
    for (const text of [
      "Bonjour, je lance la partie et je reviens vers toi dans cinq minutes.",
      "The build passed and I pushed the fix to the branch.",
      "J'ai relancé le pipeline GitLab CI, le merge request est prêt.",
      "OK, cargo build --release est passé.",
      "Ich",
      "",
    ]) {
      expect(unvoicedLanguage(text)).toBeNull();
      expect(kokoroCannotRead(text, undefined)).toBeNull();
    }
  });

  test("a language Kokoro has no voice for is caught", () => {
    expect(
      unvoicedLanguage(
        "Ich habe den Build gestartet und das ist jetzt fertig.",
      ),
    ).toBe("de");
    expect(
      unvoicedLanguage("Het is goed, maar de build is nog niet klaar."),
    ).toBe("nl");
    expect(unvoicedLanguage("Сборка прошла, я отправил исправление.")).toBe(
      "ru",
    );
    expect(unvoicedLanguage("빌드가 통과했습니다.")).toBe("ko");
    // A Russian name in a French sentence is still French.
    expect(unvoicedLanguage("J'ai parlé à Дмитрий de la build.")).toBeNull();
  });

  test("a language given wins over the text", () => {
    expect(kokoroCannotRead("Bonjour", "fr")).toBeNull();
    expect(kokoroCannotRead("Bonjour", "fr-FR")).toBeNull();
    expect(kokoroCannotRead("Hello", "en_GB")).toBeNull();
    expect(kokoroCannotRead("Guten Tag", "de")).toBe("de");
    expect(kokoroCannotRead("Anything", "xx")).toBe("xx");
  });

  test("the notice says which language, in English", () => {
    expect(cannotReadNotice("de")).toBe(
      "This reply is in German, which this voice cannot read.",
    );
    expect(cannotReadNotice("xx")).toBe(
      "This reply is in a language this voice cannot read.",
    );
  });
});

describe("the light voice's languages", () => {
  const pocket = [
    { model: "pocket-tts", languages: "fr" },
    { model: "pocket-tts", languages: "en" },
  ];
  test("Pocket TTS reads its own, Kokoro its voices', Kokoro alone its voices'", () => {
    expect([...lightLanguages(pocket)].sort()).toEqual(["en", "fr"]);
    expect(lightLanguages([...pocket, { model: "kokoro" }]).has("es")).toBe(
      true,
    );
    expect([...lightLanguages(undefined)].sort()).toEqual(
      Object.keys(KOKORO_VOICES).sort(),
    );
  });

  test("a language none of its voices reads is caught, never another's accent", () => {
    expect(lightCannotRead("Bonjour.", "fr-FR", pocket)).toBeNull();
    expect(lightCannotRead("Hola.", "es", pocket)).toBe("es");
    expect(
      lightCannotRead("Hola.", "es", [...pocket, { model: "kokoro" }]),
    ).toBeNull();
    expect(
      lightCannotRead(
        "Ich habe den Build gestartet und er ist jetzt fertig.",
        undefined,
        pocket,
      ),
    ).toBe("de");
    // Unclear text goes to the helper, which reads it in its language.
    expect(
      lightCannotRead("J'ai relancé le pipeline GitLab CI.", undefined, pocket),
    ).toBeNull();
  });
});
