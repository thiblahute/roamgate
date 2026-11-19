import { describe, expect, jest, test } from "bun:test";
import { VoiceCleaner } from "../voice/voice-cleaner";
import { SpeakerTracker, type VoiceTag } from "../voice/voice-speakers";
import {
  LONGEST_PAUSE_MS,
  MAX_PAUSE_MS,
  type VoiceEvent,
  type VoiceHelper,
} from "../voice/voice-helper";
import {
  createVoiceSocket,
  DETACHED_MS,
  endsWithFiller,
  endsWithQuestion,
  KEPT_MS,
  QUESTION_PAUSE_MS,
  SilenceCap,
  SURE_PAUSE_MS,
  STALL_MS,
} from "./voice-socket";

/** A helper whose session's events the test sends. */
function fakeHelper() {
  let emit: (event: VoiceEvent) => void = () => {};
  const calls: string[] = [];
  let audioBytes = 0;
  const helper = {
    speakers: new SpeakerTracker(),
    listen(onEvent: (event: VoiceEvent) => void) {
      emit = onEvent;
      return {
        id: 1,
        audio(samples: Uint8Array) {
          audioBytes += samples.length;
        },
        release() {},
        finish() {
          calls.push("finish");
        },
        stop() {
          calls.push("stop");
        },
      };
    },
  } as unknown as VoiceHelper;
  return {
    helper,
    calls,
    audioBytes: () => audioBytes,
    emit: (event: VoiceEvent) => emit(event),
  };
}

/** A socket keeping what it is told. */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    ws: { send: (message: string) => sent.push(JSON.parse(message)) },
  };
}

/** `ms` of 16 kHz mono S16LE audio. */
const audio = (ms: number) => new Uint8Array(ms * 32);

/** A cleaner that drops "um" and holds what mentions the salt. */
function fakeCleaner() {
  const prompts: string[] = [];
  const cleaner = new VoiceCleaner(() => {
    throw new Error("no process");
  });
  cleaner.warm = () => {};
  cleaner.ask = async (prompt) => {
    prompts.push(prompt);
    const rest = prompt.slice(prompt.lastIndexOf("Rest: ") + 6);
    return {
      for_agent: !rest.includes("salt"),
      text: rest.replaceAll("um ", ""),
    };
  };
  return { cleaner, prompts };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("voice socket", () => {
  test("without a context, events pass as they are", () => {
    const { helper, emit } = fakeHelper();
    const { cleaner } = fakeCleaner();
    const socket = createVoiceSocket(helper, () => cleaner);
    const sent: string[] = [];
    const ws = { send: (message: string) => sent.push(message) };
    socket.message(ws, JSON.stringify({ op: "listen" }));
    emit({ event: "final", session: 1, text: "Do um it.", speech_ms: 900 });
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      { event: "listening", session: 1, resume: expect.any(String) },
      { event: "final", session: 1, text: "Do um it.", speech_ms: 900 },
    ]);
  });

  test("with a context, the final text is cleaned, in order", async () => {
    const { helper, emit } = fakeHelper();
    const { cleaner, prompts } = fakeCleaner();
    const socket = createVoiceSocket(helper, () => cleaner);
    const sent: Record<string, unknown>[] = [];
    const ws = { send: (message: string) => sent.push(JSON.parse(message)) };
    socket.message(
      ws,
      JSON.stringify({ op: "listen", context: "Agent: Ready?" }),
    );
    emit({ event: "speech_end", session: 1 });
    emit({ event: "final", session: 1, text: "Do um it.", speech_ms: 900 });
    emit({
      event: "final",
      session: 1,
      text: "Pass the salt.",
      speech_ms: 800,
    });
    await settle();
    expect(sent.slice(1)).toEqual([
      { event: "speech_end", session: 1 },
      {
        event: "final",
        session: 1,
        text: "Do it.",
        raw: "Do um it.",
        for_agent: true,
        speech_ms: 900,
      },
      {
        event: "final",
        session: 1,
        text: "Pass the salt.",
        raw: "Pass the salt.",
        for_agent: false,
        speech_ms: 800,
      },
    ]);
    expect(prompts[0]).toContain("Agent: Ready?");
  });

  test("words not surely the speaker's stay not for the agent, cleaned or not", async () => {
    const { helper, emit } = fakeHelper();
    const { cleaner } = fakeCleaner();
    const socket = createVoiceSocket(helper, () => cleaner);
    const sent: Record<string, unknown>[] = [];
    const ws = { send: (message: string) => sent.push(JSON.parse(message)) };
    socket.message(
      ws,
      JSON.stringify({ op: "listen", context: "Agent: Ready?" }),
    );
    // The cleaner takes it for the agent; the helper's speaker check did
    // not take it as the speaker's voice.
    emit({
      event: "final",
      session: 1,
      text: "Et um puis je disais.",
      speech_ms: 680,
      for_agent: false,
    });
    await settle();
    expect(sent.at(-1)).toEqual({
      event: "final",
      session: 1,
      text: "Et puis je disais.",
      raw: "Et um puis je disais.",
      for_agent: false,
      speech_ms: 680,
    });
  });

  test("a final carries its voice's label; clearly another voice is not for the agent without a companion", async () => {
    const tag = (id: string, similarity: Record<string, number>): VoiceTag => ({
      voices: 3,
      id,
      share: 1,
      mixed: false,
      mix: [{ id, share: 1 }],
      similarity,
    });
    for (const fronted of [false, true]) {
      const { helper, emit } = fakeHelper();
      helper.speakers.learn(tag("A", { A: 0.6 }), "self");
      const { cleaner } = fakeCleaner();
      const socket = createVoiceSocket(
        helper,
        () => cleaner,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => fronted,
      );
      const { sent, ws } = fakeSocket();
      socket.message(
        ws,
        JSON.stringify({ op: "listen", context: "Agent: Ready?" }),
      );
      emit({
        event: "final",
        session: 1,
        text: "Bonjour à tous.",
        speech_ms: 900,
        voice: tag("B", { A: 0.04, B: 0.7 }),
      });
      emit({
        event: "final",
        session: 1,
        text: "Do it.",
        speech_ms: 900,
        voice: tag("A", { A: 0.58, B: 0.1 }),
      });
      await settle();
      const finals = sent.filter((event) => event.event === "final");
      expect(
        finals.map((event) => [event.voice_label, event.for_agent]),
      ).toEqual([
        // A companion judges another voice by its label.
        ["voice B, 0.04 like you", fronted],
        ["you 0.58", true],
      ]);
    }
  });

  test("a session outlives its socket: a new one resumes it, missing nothing", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls, audioBytes } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const first = fakeSocket();
      socket.message(first.ws, JSON.stringify({ op: "listen" }));
      const token = first.sent[0]!.resume;
      emit({ event: "speech_start", session: 1 });
      socket.message(first.ws, audio(400));
      socket.close(first.ws);
      // Heard while no socket was there.
      emit({ event: "partial", session: 1, text: "I was saying the" });
      jest.advanceTimersByTime(DETACHED_MS - 1000);
      expect(calls).toEqual([]);
      const second = fakeSocket();
      socket.message(
        second.ws,
        JSON.stringify({ op: "resume", session: 1, resume: token }),
      );
      expect(second.sent).toEqual([
        { event: "resumed", session: 1, received: 400 * 32 },
        { event: "partial", session: 1, text: "I was saying the" },
      ]);
      socket.message(second.ws, audio(400));
      expect(audioBytes()).toBe(800 * 32);
      emit({ event: "final", session: 1, text: "I was saying the end." });
      expect(second.sent.at(-1)).toEqual({
        event: "final",
        session: 1,
        text: "I was saying the end.",
      });
      // The old timer is gone: nothing ends it meanwhile.
      jest.advanceTimersByTime(DETACHED_MS * 2);
      expect(calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a resume with the wrong token is refused", () => {
    const { helper } = fakeHelper();
    const socket = createVoiceSocket(helper);
    const first = fakeSocket();
    socket.message(first.ws, JSON.stringify({ op: "listen" }));
    socket.close(first.ws);
    const second = fakeSocket();
    socket.message(
      second.ws,
      JSON.stringify({ op: "resume", session: 1, resume: "guess" }),
    );
    expect(second.sent).toEqual([{ event: "resume_failed", session: 1 }]);
  });

  test("with no resume, the utterance ends with what was heard, kept for later", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const first = fakeSocket();
      socket.message(first.ws, JSON.stringify({ op: "listen" }));
      const token = first.sent[0]!.resume;
      emit({ event: "speech_start", session: 1 });
      socket.close(first.ws);
      jest.advanceTimersByTime(DETACHED_MS);
      expect(calls).toEqual(["finish"]);
      emit({ event: "final", session: 1, text: "Pretty decent." });
      jest.advanceTimersByTime(60_000);
      const late = fakeSocket();
      socket.message(
        late.ws,
        JSON.stringify({ op: "resume", session: 1, resume: token }),
      );
      expect(late.sent.at(-1)).toEqual({
        event: "final",
        session: 1,
        text: "Pretty decent.",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a stalled stream is not silence: it is taken as a gone socket", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const first = fakeSocket();
      socket.message(first.ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      emit({ event: "partial", session: 1, text: "pretty g" });
      socket.message(first.ws, audio(200));
      // No audio: no pause is counted, and nothing ends at once.
      jest.advanceTimersByTime(STALL_MS);
      expect(calls).toEqual([]);
      emit({ event: "text", session: 1, text: "missed" });
      expect(first.sent.at(-1)).not.toEqual({
        event: "text",
        session: 1,
        text: "missed",
      });
      // The stream comes back on the same socket: what it missed comes.
      socket.message(first.ws, audio(40));
      expect(first.sent.at(-1)).toEqual({
        event: "text",
        session: 1,
        text: "missed",
      });
      expect(calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("its socket speaking again brings a stalled session what it missed", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const first = fakeSocket();
      socket.message(first.ws, JSON.stringify({ op: "listen" }));
      socket.message(first.ws, audio(200));
      jest.advanceTimersByTime(STALL_MS);
      emit({ event: "final", session: 1, text: "Kept meanwhile." });
      expect(first.sent.at(-1)).not.toMatchObject({ event: "final" });
      // A message, not audio: the socket is there.
      socket.message(first.ws, JSON.stringify({ op: "release" }));
      expect(first.sent.at(-1)).toEqual({
        event: "final",
        session: 1,
        text: "Kept meanwhile.",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a helper exit ends each listening on its own session: told, never finished", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const first = fakeSocket();
      socket.message(first.ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      const stopped = {
        event: "error",
        session: 1,
        error: "The voice helper stopped",
        recoverable: true,
      } as const;
      emit(stopped);
      expect(first.sent.at(-1)).toEqual(stopped);
      // Over: dropped, and no finish for a session of a helper gone.
      expect(calls).toEqual(["stop"]);
      jest.advanceTimersByTime(DETACHED_MS + KEPT_MS);
      socket.close(first.ws);
      jest.advanceTimersByTime(DETACHED_MS + KEPT_MS);
      expect(calls).toEqual(["stop"]);

      // Its socket away meanwhile: kept for a resume, told then.
      const away = fakeHelper();
      const other = createVoiceSocket(away.helper);
      const second = fakeSocket();
      other.message(second.ws, JSON.stringify({ op: "listen" }));
      const token = second.sent[0]!.resume;
      other.close(second.ws);
      away.emit(stopped);
      jest.advanceTimersByTime(DETACHED_MS);
      expect(away.calls).toEqual([]);
      const third = fakeSocket();
      other.message(
        third.ws,
        JSON.stringify({ op: "resume", session: 1, resume: token }),
      );
      expect(third.sent.at(-1)).toEqual(stopped);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a finished voice the words veto ends at the cap; a search for a word does not", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const { ws } = fakeSocket();
      const pause = pauseIn(socket, ws);
      socket.message(ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      // Looking for a word: nothing read, the voice sounds unfinished.
      reading(emit, "", 500);
      reading(emit, "", 1500, 0.01, 0.4);
      pause(1000);
      reading(emit, "", 2500, 0.16, 0.4);
      reading(emit, "", 3500, 0.12, 0.4);
      pause(LONGEST_PAUSE_MS - 3500 - 100);
      expect(calls).toEqual([]);
      // The word comes, then the sentence ends; its words read unfinished.
      emit({ event: "partial", session: 1, text: "I would like the" });
      reading(emit, "I would like the blue one", 500);
      reading(emit, "I would like the blue one", 1500, 0.34, 0.013);
      pause(1000);
      reading(emit, "I would like the blue one", 2500, 0.67, 0.013);
      pause(1000);
      reading(emit, "I would like the blue one", 3500, 0.86, 0.013);
      pause(MAX_PAUSE_MS - 3500 - 40);
      expect(calls).toEqual([]);
      pause(40);
      expect(calls).toEqual(["finish"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a pause that never sounds finished ends at the longest pause", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const { ws } = fakeSocket();
      const pause = pauseIn(socket, ws);
      socket.message(ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      emit({ event: "partial", session: 1, text: "the conversation was" });
      // A stall mid-word reads unfinished, and sounds it.
      reading(emit, "the conversation was pretty g", 500);
      pause(1000);
      reading(emit, "the conversation was pretty g", 1500, 0.2, 0.001);
      pause(LONGEST_PAUSE_MS - 1500 - 40);
      expect(calls).toEqual([]);
      pause(40);
      expect(calls).toEqual(["finish"]);
      pause(4000);
      expect(calls).toEqual(["finish"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a trailing euh holds the turn past the cap, however finished it sounds", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const { ws } = fakeSocket();
      const pause = pauseIn(socket, ws);
      socket.message(ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      reading(emit, "on prend le train et puis euh", 500);
      pause(1000);
      reading(emit, "on prend le train et puis euh", 1500, 0.9, 0.2);
      pause(6000);
      expect(calls).toEqual([]);
      pause(LONGEST_PAUSE_MS - 7500 - 40);
      expect(calls).toEqual([]);
      pause(40);
      expect(calls).toEqual(["finish"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a filler mid-pause starts the count again, and holds the turn", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      const socket = createVoiceSocket(helper);
      const { ws } = fakeSocket();
      const pause = pauseIn(socket, ws);
      socket.message(ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      reading(emit, "and then", 500);
      reading(emit, "and then", 3500, 0.7, 0.013);
      pause(MAX_PAUSE_MS - 3500 - 1000);
      // "um", dropped by the transcriber: no new word, a reading early
      // into a new pause, which speechgate tells a thinking one.
      emit({
        event: "partial",
        session: 1,
        text: "and then",
        pause: true,
        pause_ms: 500,
        thinking: true,
      });
      pause(2000);
      expect(calls).toEqual([]);
      pause(LONGEST_PAUSE_MS - 2500 - 40);
      expect(calls).toEqual([]);
      pause(40);
      expect(calls).toEqual(["finish"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the longest pause is read from the settings at each listen", () => {
    jest.useFakeTimers();
    try {
      const { helper, emit, calls } = fakeHelper();
      let setting: unknown = 12_000;
      const socket = createVoiceSocket(helper, undefined, () => setting);
      const { ws } = fakeSocket();
      const pause = pauseIn(socket, ws);
      socket.message(ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      reading(emit, "that is all", 3500, 0.8, 0.01);
      pause(12_000 - 3500 - 40);
      expect(calls).toEqual([]);
      pause(40);
      expect(calls).toEqual(["finish"]);
      // Unusable: the default.
      setting = "soon";
      socket.message(ws, JSON.stringify({ op: "listen" }));
      emit({ event: "speech_start", session: 1 });
      reading(emit, "that is all", 3500, 0.8, 0.01);
      pause(MAX_PAUSE_MS - 3500);
      expect(calls.filter((call) => call === "finish")).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

/** Words read `pauseMs` into a pause, with the turn models' scores. */
function reading(
  emit: (event: VoiceEvent) => void,
  text: string,
  pauseMs: number,
  turn?: number,
  words?: number,
) {
  emit({
    event: "partial",
    session: 1,
    text,
    pause: true,
    pause_ms: pauseMs,
    ...(turn === undefined ? {} : { turn, words }),
  });
}

/** `ms` of quiet audio, streamed as it comes. */
function pauseIn(
  socket: ReturnType<typeof createVoiceSocket>,
  ws: { send: (message: string) => unknown },
) {
  return (ms: number) => {
    for (let at = 0; at < ms; at += 40) {
      const chunk = Math.min(40, ms - at);
      socket.message(ws, audio(chunk));
      jest.advanceTimersByTime(chunk);
    }
  };
}

describe("silence cap", () => {
  test("speech in the pause starts the count again", () => {
    const cap = new SilenceCap(4000);
    cap.event({ event: "speech_start" });
    cap.event({ event: "partial", text: "one two", pause: true, turn: 0.8 });
    expect(cap.audio(3000 * 32)).toBe(false);
    // More words at the next pause: the person spoke meanwhile.
    cap.event({
      event: "partial",
      text: "one two three",
      pause: true,
      turn: 0.8,
    });
    expect(cap.audio(3000 * 32)).toBe(false);
    expect(cap.audio(500 * 32)).toBe(true);
  });

  test("the same words at each check of a pause keep its count", () => {
    const cap = new SilenceCap(4000);
    cap.event({ event: "speech_start" });
    cap.event({
      event: "partial",
      text: "one two",
      pause: true,
      pause_ms: 500,
    });
    expect(cap.audio(1000 * 32)).toBe(false);
    cap.event({
      event: "partial",
      text: "one two",
      pause: true,
      pause_ms: 1500,
      turn: 0.6,
    });
    expect(cap.audio(2500 * 32)).toBe(true);
  });

  test("a question asked whole ends soon, even taken for thinking", () => {
    const cap = new SilenceCap(8000);
    cap.event({ event: "speech_start" });
    // A short noise in a car read as the speaker thinking.
    cap.event({
      event: "partial",
      text: "Compagnon, est-ce que tu m'entends?",
      pause: true,
      pause_ms: 1500,
      turn: 0.97,
      thinking: true,
    });
    expect(cap.limitMs()).toBe(QUESTION_PAUSE_MS);
    // Counted from its reading 1.5 s into the pause.
    expect(cap.audio(500 * 32)).toBe(false);
    expect(cap.audio(600 * 32)).toBe(true);
    // Not in a voice that sounded unfinished.
    const unsure = new SilenceCap(8000);
    unsure.event({ event: "speech_start" });
    unsure.event({
      event: "partial",
      text: "Comment ça s'appelle déjà?",
      pause: true,
      pause_ms: 1500,
      turn: 0.2,
    });
    expect(unsure.limitMs()).toBe(LONGEST_PAUSE_MS);
    expect(endsWithQuestion("tu m'entends ?")).toBe(true);
    // A voice surely done ends soon too, the words read unfinished or a
    // noise taken for thinking; never on a filler.
    const sure = new SilenceCap(8000);
    sure.event({ event: "speech_start" });
    sure.event({
      event: "partial",
      text: "Ouais, vas-y.",
      pause: true,
      pause_ms: 1500,
      turn: 0.98,
      thinking: true,
    });
    expect(sure.limitMs()).toBe(SURE_PAUSE_MS);
    const filler = new SilenceCap(8000);
    filler.event({ event: "speech_start" });
    filler.event({
      event: "partial",
      text: "et puis euh",
      pause: true,
      pause_ms: 1500,
      turn: 0.98,
    });
    expect(filler.limitMs()).toBe(LONGEST_PAUSE_MS);
    // A lower setting of its own still applies.
    const short = new SilenceCap(2000);
    short.event({ event: "speech_start" });
    short.event({
      event: "partial",
      text: "Ouais, vas-y.",
      pause: true,
      pause_ms: 1500,
      turn: 0.98,
    });
    expect(short.limitMs()).toBe(2000);
    expect(endsWithQuestion("je me demande si. ")).toBe(false);
  });

  test("a partial while speaking stops the count; none while no pause", () => {
    const cap = new SilenceCap(4000);
    expect(cap.audio(20_000 * 32)).toBe(false);
    cap.event({ event: "speech_start" });
    cap.event({ event: "partial", text: "one", pause: true, turn: 0.9 });
    cap.event({ event: "partial", text: "one two" });
    expect(cap.audio(20_000 * 32)).toBe(false);
  });

  test("fillers end the words: um, euh, heu, hmm, ben, alors", () => {
    for (const text of [
      "and then um",
      "et puis euh",
      "c'est heu",
      "so hmm",
      "ben",
      "et alors",
      "Et puis, euh...",
      // Parakeet's "euh".
      "je pense que eux.",
    ])
      expect(endsWithFiller(text)).toBe(true);
    for (const text of ["", "that is all", "the museum", "deuh"])
      expect(endsWithFiller(text)).toBe(false);
  });
});
