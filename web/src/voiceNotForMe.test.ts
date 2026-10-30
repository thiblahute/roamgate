import { describe, expect, jest, test } from "bun:test";
import {
  createNotForMeNotice,
  NOT_FOR_ME_GAP_MS,
  NOT_FOR_ME_PHRASES,
} from "./voiceNotForMe";

describe("NOT_FOR_ME_PHRASES", () => {
  test("are short", () => {
    for (const phrase of Object.values(NOT_FOR_ME_PHRASES))
      expect(phrase.split(" ").length).toBeLessThanOrEqual(10);
  });
});

describe("createNotForMeNotice", () => {
  test("says it in the language of the sentence", () => {
    const notice = createNotForMeNotice({ gapMs: 0 });
    expect(
      notice.next("C'est bizarre ça, un animal qui peut pas dormir."),
    ).toEqual({ text: NOT_FOR_ME_PHRASES.fr, language: "fr" });
    expect(notice.next("That is a weird animal, it cannot sleep")).toEqual({
      text: NOT_FOR_ME_PHRASES.en,
      language: "en",
    });
  });

  test("at most once per gap, again once it passed", () => {
    jest.useFakeTimers();
    try {
      let clock = 0;
      const notice = createNotForMeNotice({ now: () => clock });
      const tick = (ms: number) => {
        clock += ms;
        jest.advanceTimersByTime(ms);
      };
      expect(notice.next("talk in the room")).not.toBeNull();
      tick(1_000);
      expect(notice.next("more talk")).toBeNull();
      tick(NOT_FOR_ME_GAP_MS - 1_001);
      expect(notice.next("still talking")).toBeNull();
      tick(1);
      expect(notice.next("and again")).not.toBeNull();
      // A sentence kept quiet does not push the next one back.
      tick(NOT_FOR_ME_GAP_MS / 2);
      expect(notice.next("chatter")).toBeNull();
      tick(NOT_FOR_ME_GAP_MS / 2);
      expect(notice.next("chatter")).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
