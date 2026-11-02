import { describe, expect, jest, test } from "bun:test";
import {
  ACK_CUT_MS,
  ACK_DELAY_MS,
  ACK_LATEST_MS,
  cannedAck,
  ACK_PHRASES,
  STILL_PHRASES,
  STILL_WORKING_MS,
  ackDue,
  ackLanguage,
  pickPhrase,
  startTurnAck,
} from "./voiceAck";

describe("ackLanguage", () => {
  test("knows English, French and Spanish, English when unclear", () => {
    expect(ackLanguage("Can you fix the build please")).toBe("en");
    expect(ackLanguage("Est-ce que tu peux corriger le build")).toBe("fr");
    expect(ackLanguage("j'ai cassé la branche")).toBe("fr");
    expect(ackLanguage("¿Puedes arreglar la compilación?")).toBe("es");
    expect(ackLanguage("cargo build")).toBe("en");
    expect(ackLanguage("")).toBe("en");
  });
});

describe("phrases", () => {
  test("are short and never say checking", () => {
    for (const set of [ACK_PHRASES, STILL_PHRASES])
      for (const phrases of Object.values(set))
        for (const phrase of phrases) {
          expect(phrase.toLowerCase()).not.toContain("check");
          expect(phrase.split(" ").length).toBeLessThanOrEqual(10);
        }
  });
});

describe("pickPhrase", () => {
  test("never the same one twice in a row", () => {
    const phrases = ACK_PHRASES.en;
    let last: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const next = pickPhrase(phrases, last);
      expect(next).not.toBe(last);
      expect(phrases).toContain(next);
      last = next;
    }
  });

  test("covers every choice and keeps a lone phrase", () => {
    expect(pickPhrase(["a", "b", "c"], "a", () => 0)).toBe("b");
    expect(pickPhrase(["a", "b", "c"], "a", () => 0.999)).toBe("c");
    expect(pickPhrase(["a"], "a", () => 0.5)).toBe("a");
  });
});

describe("ackDue", () => {
  const base = {
    sinceSent: 0,
    sinceActivity: 0,
    started: false,
    busy: false,
    working: true,
    acked: false,
    stillSaid: false,
  };

  test("acks after the delay while nothing is read", () => {
    expect(ackDue({ ...base, sinceSent: ACK_DELAY_MS - 1 })).toBeNull();
    expect(ackDue({ ...base, sinceSent: ACK_DELAY_MS })).toBe("ack");
  });

  test("not when the answer started, already acked, busy, or too late", () => {
    const due = { ...base, sinceSent: ACK_DELAY_MS };
    expect(ackDue({ ...due, started: true })).toBeNull();
    expect(ackDue({ ...due, acked: true })).toBeNull();
    expect(ackDue({ ...due, busy: true })).toBeNull();
    expect(ackDue({ ...due, sinceSent: ACK_LATEST_MS })).toBeNull();
  });

  test("still working once, after a long quiet while the agent works", () => {
    const long = {
      ...base,
      acked: true,
      sinceSent: STILL_WORKING_MS,
      sinceActivity: STILL_WORKING_MS,
    };
    expect(ackDue(long)).toBe("still");
    expect(ackDue({ ...long, stillSaid: true })).toBeNull();
    expect(ackDue({ ...long, working: false })).toBeNull();
    expect(ackDue({ ...long, sinceActivity: 1000 })).toBeNull();
  });
});

/** A turn's acks with fake time, recording what is fetched and played. */
function turn(
  said: string,
  options: {
    started?: () => boolean;
    synthesized?: Promise<void>;
    opening?: string;
    acked?: boolean;
    fronted?: boolean;
  } = {},
) {
  let clock = 0;
  const fetched: string[] = [];
  const played: string[] = [];
  let ending: (() => void) | null = null;
  let playSignal: AbortSignal | null = null;
  const controller = new AbortController();
  const ack = startTurnAck({
    said,
    signal: controller.signal,
    started: options.started ?? (() => false),
    busy: () => ending !== null,
    working: () => true,
    now: () => clock,
    ...(options.opening ? { opening: options.opening } : {}),
    ...(options.acked ? { acked: true } : {}),
    ...(options.fronted ? { fronted: true } : {}),
    speech: {
      fetchAudio: async (text, language) => {
        fetched.push(`${language}:${text}`);
        await options.synthesized;
        return new Blob([text]);
      },
      playAudio: async (audio, signal) => {
        played.push(await audio.text());
        playSignal = signal;
        await new Promise<void>((resolve) => {
          ending = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        ending = null;
      },
    },
  });
  const advance = async (ms: number) => {
    for (let step = 0; step < ms; step += 100) {
      clock += 100;
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
  };
  const finishPlaying = async () => {
    ending?.();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return {
    ack,
    controller,
    fetched,
    played,
    advance,
    finishPlaying,
    playSignal: () => playSignal,
  };
}

describe("startTurnAck", () => {
  test("fetches at once, plays once after the delay, in the language said", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Est-ce que tu peux regarder le build");
      expect(t.fetched).toHaveLength(1);
      expect(t.fetched[0]!.startsWith("fr:")).toBe(true);
      await t.advance(ACK_DELAY_MS - 200);
      expect(t.played).toHaveLength(0);
      await t.advance(400);
      expect(t.played).toHaveLength(1);
      expect(ACK_PHRASES.fr).toContain(t.played[0]!);
      await t.finishPlaying();
      await t.advance(5000);
      expect(t.played).toHaveLength(1);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("says nothing when the answer starts first", async () => {
    jest.useFakeTimers();
    try {
      let started = false;
      const t = turn("fix it", { started: () => started });
      await t.advance(500);
      started = true;
      await t.advance(3000);
      expect(t.played).toHaveLength(0);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("drops an ack synthesized only after the answer started", async () => {
    jest.useFakeTimers();
    try {
      let started = false;
      let synthesized = () => {};
      const t = turn("fix it", {
        started: () => started,
        synthesized: new Promise<void>((resolve) => {
          synthesized = resolve;
        }),
      });
      await t.advance(ACK_DELAY_MS + 400);
      started = true;
      synthesized();
      await t.advance(500);
      expect(t.played).toHaveLength(0);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("the next turn says another phrase", async () => {
    jest.useFakeTimers();
    try {
      const said: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const t = turn("fix the build");
        await t.advance(ACK_DELAY_MS + 200);
        await t.finishPlaying();
        said.push(t.played[0]!);
        await t.ack.end();
      }
      for (let i = 1; i < said.length; i += 1)
        expect(said[i]).not.toBe(said[i - 1]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("quiet waits for the words, cutting them past the limit", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("fix the build");
      await t.advance(ACK_DELAY_MS + 200);
      expect(t.played).toHaveLength(1);
      let quiet = false;
      void t.ack.quiet().then(() => {
        quiet = true;
      });
      await t.advance(500);
      expect(quiet).toBe(false);
      await t.finishPlaying();
      expect(quiet).toBe(true);

      const long = turn("fix the build");
      await long.advance(ACK_DELAY_MS + 200);
      let cut = false;
      void long.ack.quiet().then(() => {
        cut = true;
      });
      await long.advance(ACK_CUT_MS + 200);
      expect(cut).toBe(true);
      expect(long.playSignal()?.aborted).toBe(true);
      await t.ack.end();
      await long.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("talking over it stops it; stopping voice chat says nothing more", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("fix the build");
      await t.advance(ACK_DELAY_MS + 200);
      t.ack.hush();
      expect(t.playSignal()?.aborted).toBe(true);

      const stopped = turn("fix the build");
      stopped.controller.abort();
      await stopped.advance(STILL_WORKING_MS + 1000);
      expect(stopped.played).toHaveLength(0);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("still working, once, on a long quiet turn", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("fix the build");
      await t.advance(ACK_DELAY_MS + 200);
      await t.finishPlaying();
      await t.advance(STILL_WORKING_MS);
      expect(t.played).toHaveLength(2);
      expect(STILL_PHRASES.en).toContain(t.played[1]!);
      await t.finishPlaying();
      await t.advance(STILL_WORKING_MS * 2);
      expect(t.played).toHaveLength(2);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("the front's words are said at once, in place of a canned ack", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("rebase sur main", {
        opening: "OK, je transmets à la session Roamgate.",
      });
      expect(t.fetched).toEqual(["fr:OK, je transmets à la session Roamgate."]);
      await t.advance(300);
      expect(t.played).toEqual(["OK, je transmets à la session Roamgate."]);
      await t.finishPlaying();
      await t.advance(ACK_LATEST_MS);
      expect(t.played).toHaveLength(1);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("with a front and no words of its own, no canned ack is said", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("Ok vas-y lance les tests", { fronted: true });
      expect(t.fetched).toHaveLength(0);
      await t.advance(ACK_LATEST_MS + 1000);
      expect(t.played).toHaveLength(0);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("with a front, its words are said and never a canned ack after them", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("lance les tests", {
        fronted: true,
        opening: "Je lance les tests de voice-front.",
      });
      await t.advance(300);
      expect(t.played).toEqual(["Je lance les tests de voice-front."]);
      await t.finishPlaying();
      await t.advance(ACK_LATEST_MS);
      expect(t.played).toHaveLength(1);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("with a front, still working only when it said nothing", async () => {
    jest.useFakeTimers();
    try {
      const silent = turn("fix the build", { fronted: true });
      await silent.advance(STILL_WORKING_MS + 400);
      expect(silent.played).toHaveLength(1);
      expect(STILL_PHRASES.en).toContain(silent.played[0]!);
      await silent.finishPlaying();
      await silent.ack.end();

      const spoke = turn("fix the build", {
        fronted: true,
        opening: "I'm asking roamgate to fix the build.",
      });
      await spoke.advance(300);
      await spoke.finishPlaying();
      await spoke.advance(STILL_WORKING_MS * 2);
      expect(spoke.played).toEqual(["I'm asking roamgate to fix the build."]);
      await spoke.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });

  test("acked already by the front's stand-in: no first ack", async () => {
    jest.useFakeTimers();
    try {
      const t = turn("fix the build", { acked: true });
      expect(t.fetched).toHaveLength(0);
      await t.advance(ACK_LATEST_MS);
      expect(t.played).toHaveLength(0);
      await t.ack.end();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("cannedAck", () => {
  test("is in the language said, and differs from the one before", () => {
    const first = cannedAck("Est-ce que tu peux regarder le build", () => 0);
    expect(first.language).toBe("fr");
    expect(ACK_PHRASES.fr).toContain(first.text);
    expect(cannedAck("Est-ce que tu peux regarder", () => 0).text).not.toBe(
      first.text,
    );
  });
});
