import { describe, expect, test } from "bun:test";
import type { HistoryEntry } from "./components/agentHistory";
import {
  Downsampler,
  isStopCommand,
  nextHeard,
  parseVoiceMessage,
  replyAfter,
  type SentenceVoice,
  sentences,
  speakWith,
  voiceMessage,
} from "./voiceChat";
import { markdownToSpeech } from "./markdownToSpeech";

/** What voice reads of a reply, sentence by sentence. */
const spoken = (markdown: string) => sentences(markdownToSpeech(markdown));

const entry = (
  role: HistoryEntry["role"],
  text: string,
  kind: HistoryEntry["kind"] = "message",
  extra: Partial<HistoryEntry> = {},
): HistoryEntry => ({
  id: `${role}-${text}`,
  role,
  kind,
  text,
  sent_at: "2026-10-25T12:00:00Z",
  ...extra,
});

describe("voice chat text", () => {
  test("reads prose and announces what it leaves out", () => {
    const reply = [
      "## Done",
      "I fixed **the bug** in `store.ts`, see [the PR](https://example.com/1).",
      "```ts",
      "const a = 1;",
      "```",
      "| a | b |",
      "| - | - |",
      "- Tests pass.",
      "More at https://example.com/docs",
    ].join("\n");
    expect(spoken(reply)).toEqual([
      "Done",
      "I fixed the bug in store.ts, see the PR.",
      "ts code block omitted.",
      // A table with no rows says only that there is one.
      "Table.",
      "Tests pass.",
      "More at link to example.com",
    ]);
  });

  test("keeps a list item's number and a task's state with its sentence", () => {
    expect(
      spoken("1. First step.\n2. Second one. Done.\n\n- [x] ok\n- [ ] not"),
    ).toEqual([
      "1. First step.",
      "2. Second one.",
      "Done.",
      "Completed. ok",
      "Not completed. not",
    ]);
  });

  test("splits sentences, dropping ones with nothing to say", () => {
    expect(sentences("First one. Second? Third!\nFourth…  Fifth\n—")).toEqual([
      "First one.",
      "Second?",
      "Third!",
      "Fourth…",
      "Fifth",
    ]);
  });

  test("keeps underscores in names and reads pipelines as one sentence", () => {
    const reply =
      "It answers `forwards_upstream() == true`, so `plan_pull` sets up `source ! effect` to pull, _really_.";
    expect(spoken(reply)).toEqual([
      "It answers forwards_upstream() == true, so plan_pull sets up source ! effect to pull, really.",
    ]);
  });

  test("reads with the voice it is given, preparing the next sentence ahead", async () => {
    const log: string[] = [];
    const voice: SentenceVoice<string> = {
      prepare: async (text) => {
        log.push(`prepare ${text}`);
        return text.toUpperCase();
      },
      play: async (speech) => {
        log.push(`play ${speech}`);
      },
    };
    const heard: (string | null)[] = [];
    await speakWith(
      voice,
      "One. Two.\n```sh\nls\n```",
      new AbortController().signal,
      (sentence) => heard.push(sentence),
    );
    expect(log).toEqual([
      "prepare One.",
      "prepare Two.",
      "play ONE.",
      "prepare sh code block omitted.",
      "play TWO.",
      "play SH CODE BLOCK OMITTED.",
    ]);
    expect(heard).toEqual(["One.", "Two.", "sh code block omitted.", null]);
  });

  test("the reply is what the agent said after the message sent", () => {
    const entries = [
      entry("user", "old question"),
      entry("assistant", "old answer"),
      entry("user", "what changed?"),
      entry("tool", "git diff", "tool_call"),
      entry("assistant", "Two files."),
      entry("assistant", "Both tests pass."),
    ];
    expect(replyAfter(entries, "what changed?")).toBe(
      "Two files.\n\nBoth tests pass.",
    );
    // Not in the history yet: no reply, not the previous one.
    expect(replyAfter(entries.slice(0, 2), "what changed?")).toBeNull();
    expect(replyAfter(entries.slice(0, 3), "what changed?")).toBeNull();
    // A message still queued is not the one answered.
    expect(
      replyAfter(
        [...entries, entry("user", "and now?", "message", { queued: true })],
        "what changed?",
      ),
    ).toBe("Two files.\n\nBoth tests pass.");
  });

  test("a voice message says so, and where it cut the reading", () => {
    expect(voiceMessage("hello")).toBe("[Voice] hello");
    const cut = voiceMessage("wait", 'He said "go".');
    expect(cut).toBe('[Voice, interrupted you at: "He said \\"go\\"."] wait');
    expect(parseVoiceMessage(cut)).toEqual({
      text: "wait",
      voice: true,
      interruptedAt: 'He said "go".',
    });
    expect(parseVoiceMessage("[Voice] hello")).toEqual({
      text: "hello",
      voice: true,
      interruptedAt: null,
    });
    expect(parseVoiceMessage("typed")).toEqual({
      text: "typed",
      voice: false,
      interruptedAt: null,
    });
    // The reply is found after the message as sent, note and all.
    const entries = [
      { id: "u", role: "user", kind: "message", text: cut, sent_at: "" },
      {
        id: "a",
        role: "assistant",
        kind: "message",
        text: "Waiting.",
        sent_at: "",
      },
    ] as const;
    expect(replyAfter(entries as never, cut)).toBe("Waiting.");
  });

  test("the microphone becomes 16 kHz samples, however blocks are cut", () => {
    const rate = 48_000;
    const tone = Float32Array.from(
      { length: 4800 },
      (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5,
    );
    const whole = new Downsampler(rate).push(tone);
    const pieces = new Downsampler(rate);
    const joined: number[] = [];
    for (let at = 0; at < tone.length; at += 128)
      joined.push(...pieces.push(tone.subarray(at, at + 128)));
    expect(whole.length).toBe(1600);
    expect(joined).toEqual([...whole]);
    expect(Math.max(...whole)).toBeGreaterThan(0.45 * 0x7fff);
  });

  test("the microphone at 16 kHz keeps speech and leaves out what folds back into it", () => {
    // In dB against the tone's own level, once the filter is filled.
    const level = (rate: number, hz: number) => {
      const tone = Float32Array.from(
        { length: rate },
        (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * 0.5,
      );
      const out = [...new Downsampler(rate).push(tone)].slice(200);
      const rms = Math.sqrt(
        out.reduce((sum, x) => sum + (x / 0x7fff) ** 2, 0) / out.length,
      );
      return 20 * Math.log10(Math.max(rms, 1e-9) / (0.5 / Math.SQRT2));
    };
    for (const rate of [48_000, 44_100]) {
      // Speech passes as it is.
      for (const hz of [200, 1000, 3000, 5000])
        expect(Math.abs(level(rate, hz))).toBeLessThan(0.5);
      // An "s" at 10 kHz would come back at 6 kHz: averaging three
      // samples let it through 6 dB down.
      for (const hz of [9000, 10_000, 12_000, 16_000])
        expect(level(rate, hz)).toBeLessThan(-60);
    }
  });

  test("saying only stop ends voice chat, in each language", () => {
    for (const said of [
      "Stop.",
      "Okay, stop!",
      "stop listening please",
      "Arrête.",
      "Bon, arrête-toi.",
      "Arrête d’écouter.",
      "¡Para!",
      "Basta, por favor.",
    ])
      expect(isStopCommand(said)).toBe(true);
    for (const said of [
      "Stop, reply with the single word pong.",
      "Don't stop.",
      "Para qué sirve esto?",
      "",
    ])
      expect(isStopCommand(said)).toBe(false);
  });
});

describe("words heard so far", () => {
  test("Whisper's pieces add up", () => {
    let heard = { text: "", whole: false };
    heard = nextHeard(heard, "text", " I think ");
    heard = nextHeard(heard, "text", "we should");
    expect(heard.text).toBe("I think we should");
  });

  test("Parakeet's finished text replaces its partials, not doubles them", () => {
    let heard = { text: "", whole: false };
    heard = nextHeard(heard, "partial", "I think");
    heard = nextHeard(heard, "partial", "I think we should");
    heard = nextHeard(heard, "text", "I think we should go.");
    expect(heard.text).toBe("I think we should go.");
    // An empty one keeps what was heard.
    expect(nextHeard(heard, "text", " ").text).toBe("I think we should go.");
  });
});
