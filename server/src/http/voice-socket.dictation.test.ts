import { describe, expect, jest, test } from "bun:test";
import { type CleanerReply, VoiceCleaner } from "../voice/voice-cleaner";
import { DICTATION_CLEAN_MS } from "../voice/voice-dictation";
import type {
  CallHandle,
  ListenOptions,
  VoiceEvent,
  VoiceHelper,
} from "../voice/voice-helper";
import {
  createVoiceSocket,
  DETACHED_MS,
  FINISH_DEADLINE_MS,
  STALL_MS,
} from "./voice-socket";

/**
 * A helper listening to one session at a time, as the real one: each
 * listen gets a new id, and only the latest one hears.
 */
function fakeHelper() {
  let next = 1;
  const sessions: {
    id: number;
    onEvent: (event: VoiceEvent) => void;
    options: ListenOptions;
    calls: string[];
    bytes: number;
  }[] = [];
  const helper = {
    listen(onEvent: (event: VoiceEvent) => void, options: ListenOptions = {}) {
      const session = { id: next++, onEvent, options, calls: [], bytes: 0 };
      sessions.push(session as (typeof sessions)[number]);
      const own = sessions.at(-1)!;
      return {
        id: own.id,
        audio(samples: Uint8Array) {
          own.bytes += samples.length;
        },
        release() {},
        finish() {
          own.calls.push("finish");
        },
        stop() {
          own.calls.push("stop");
        },
      };
    },
    async startCall(): Promise<CallHandle> {
      return {
        id: 7,
        music: false,
        musicOn: () => false,
        musicWaiting: () => false,
        signallingPort: () => 0,
        stop() {},
        hush() {},
        microphone: async () => {},
      } as unknown as CallHandle;
    },
  } as unknown as VoiceHelper;
  const latest = () => sessions.at(-1)!;
  return {
    helper,
    sessions,
    latest,
    /** Tells the latest session `event`. */
    emit: (event: Omit<VoiceEvent, "session">) =>
      latest().onEvent({ ...event, session: latest().id } as VoiceEvent),
  };
}

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    ws: { send: (message: string) => sent.push(JSON.parse(message)) },
    events: () => sent.map((message) => message.event),
  };
}

/** A dictation cleaner that drops "euh" and capitalizes; or as told. */
function fakeCleaner(
  answer: (rest: string) => CleanerReply | Promise<CleanerReply> = (rest) => ({
    text: `${rest.replaceAll("euh ", "").charAt(0).toUpperCase()}${rest
      .replaceAll("euh ", "")
      .slice(1)}.`,
  }),
) {
  const prompts: string[] = [];
  let warmed = 0;
  const cleaner = new VoiceCleaner(() => {
    throw new Error("no process");
  });
  cleaner.warm = () => {
    warmed += 1;
  };
  cleaner.ask = async (prompt) => {
    prompts.push(prompt);
    const at = prompt.lastIndexOf("Rest: ");
    return answer(
      at >= 0
        ? prompt.slice(at + 6)
        : prompt.slice(prompt.lastIndexOf("PIECE\n") + 6),
    );
  };
  return { cleaner, prompts, warmed: () => warmed };
}

/** The voice chat's own cleaner: never used by a dictation. */
function chatCleaner() {
  const cleaner = new VoiceCleaner(() => {
    throw new Error("no process");
  });
  cleaner.warm = () => {};
  cleaner.ask = async () => {
    throw new Error("the voice chat's cleaner was asked");
  };
  return cleaner;
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const audio = (ms: number) => new Uint8Array(ms * 32);

function dictationSocket(cleaner: VoiceCleaner | null = fakeCleaner().cleaner) {
  const fake = fakeHelper();
  const socket = createVoiceSocket(
    fake.helper,
    () => chatCleaner(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => cleaner,
  );
  return { ...fake, socket };
}

const listen = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ op: "listen", mode: "dictation", ...extra });

describe("dictation on the voice socket", () => {
  test("partials show the whole dictation; finish gives the cleaned text with its timing", async () => {
    const { cleaner, prompts } = fakeCleaner();
    const { socket, emit, sessions } = dictationSocket(cleaner);
    const { ws, sent } = fakeSocket();
    socket.message(
      ws,
      listen({
        language: "fr",
        field: { app: "com.whatsapp", kind: "chat", hint: "Message" },
        before: "Salut Gwenaëlle, ",
        after: "",
      }),
    );
    expect(sent[0]).toEqual({
      event: "listening",
      session: 1,
      resume: expect.any(String),
      mode: "dictation",
    });
    // No turn models cutting in: the longest pause, no new speaker.
    expect(sessions[0]?.options).toEqual({
      language: "fr",
      endSilenceMs: 10_000,
    });
    emit({ event: "speech_start" });
    emit({ event: "partial", text: "euh on se voit" });
    // A pause ends the helper's utterance, not the dictation: it listens
    // again at once, and the client is told nothing ended.
    emit({ event: "final", text: "euh on se voit", for_agent: false });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.calls).toEqual(["stop"]);
    emit({ event: "speech_start" });
    emit({ event: "partial", text: "demain" });
    socket.message(ws, JSON.stringify({ op: "finish" }));
    expect(sessions[1]?.calls).toEqual(["finish"]);
    emit({ event: "final", text: "demain" });
    await settle();
    expect(sent.slice(1)).toEqual([
      { event: "speech_start", session: 1 },
      { event: "partial", session: 1, text: "euh on se voit" },
      { event: "speech_start", session: 1 },
      { event: "partial", session: 1, text: "euh on se voit demain" },
      {
        event: "final",
        session: 1,
        text: "On se voit demain.",
        raw: "euh on se voit demain",
        cleaned: true,
        timing: { stt_ms: expect.any(Number), clean_ms: expect.any(Number) },
      },
    ]);
    expect(prompts.at(-1)).toContain('app: "(com.whatsapp)"');
    expect(prompts.at(-1)).toContain(
      'text before the cursor: "Salut Gwenaëlle, "',
    );
  });

  test("a pause never finishes a dictation, however long", () => {
    const { socket, emit, latest } = dictationSocket();
    const { ws } = fakeSocket();
    socket.message(ws, listen());
    emit({ event: "speech_start" });
    emit({ event: "partial", text: "I think.", pause: true, turn: 0.99 });
    for (let i = 0; i < 40; i += 1) socket.message(ws, audio(500));
    expect(latest().calls).toEqual([]);
    expect(latest().bytes).toBe(40 * 500 * 32);
  });

  test("a helper that never answers finish still gives a final, as heard", async () => {
    jest.useFakeTimers();
    try {
      const { socket, emit } = dictationSocket();
      const { ws, sent } = fakeSocket();
      socket.message(ws, listen());
      emit({ event: "partial", text: "hello there" });
      socket.message(ws, JSON.stringify({ op: "finish" }));
      // Done sending audio: waiting for the final is not a stall.
      jest.advanceTimersByTime(STALL_MS + 1);
      expect(sent.at(-1)?.event).toBe("partial");
      jest.advanceTimersByTime(FINISH_DEADLINE_MS);
      expect(sent.at(-1)).toEqual({
        event: "final",
        session: 1,
        text: "hello there",
        raw: "hello there",
        cleaned: false,
        timing: { stt_ms: FINISH_DEADLINE_MS, clean_ms: 0 },
      });
      // A late final from the helper adds nothing.
      emit({ event: "final", text: "hello there" });
      await settle();
      expect(sent.filter((m) => m.event === "final")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a cleaner that never answers gives the words as heard, in time", async () => {
    jest.useFakeTimers();
    try {
      const { cleaner } = fakeCleaner(() => new Promise(() => {}));
      const { socket, emit } = dictationSocket(cleaner);
      const { ws, sent } = fakeSocket();
      socket.message(ws, listen());
      socket.message(ws, JSON.stringify({ op: "finish" }));
      emit({ event: "final", text: "euh hello" });
      await settle();
      jest.advanceTimersByTime(DICTATION_CLEAN_MS);
      await settle();
      expect(sent.at(-1)).toMatchObject({
        event: "final",
        text: "euh hello",
        raw: "euh hello",
        cleaned: false,
      });
      expect(sent.filter((m) => m.event === "final")).toHaveLength(1);
      jest.advanceTimersByTime(FINISH_DEADLINE_MS);
      expect(sent.filter((m) => m.event === "final")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a failing cleaner, or none, types the words as heard", async () => {
    const failing = fakeCleaner(() => Promise.reject(new Error("down")));
    for (const cleaner of [failing.cleaner, null]) {
      const { socket, emit } = dictationSocket(cleaner);
      const { ws, sent } = fakeSocket();
      socket.message(ws, listen());
      socket.message(ws, JSON.stringify({ op: "finish" }));
      emit({ event: "final", text: "euh hello" });
      await settle();
      expect(sent.at(-1)).toMatchObject({
        event: "final",
        text: "euh hello",
        cleaned: false,
      });
      expect(sent.at(-1)).not.toHaveProperty("for_agent");
    }
  });

  test("nothing said is an empty final", async () => {
    const { socket, emit } = dictationSocket();
    const { ws, sent } = fakeSocket();
    socket.message(ws, listen());
    socket.message(ws, JSON.stringify({ op: "finish" }));
    emit({ event: "final", text: "", speech_ms: 0 });
    await settle();
    expect(sent.at(-1)).toMatchObject({ event: "final", text: "", raw: "" });
  });

  test("a helper that stops mid-dictation ends it with an error at once", () => {
    const { socket, emit } = dictationSocket();
    const { ws, sent } = fakeSocket();
    socket.message(ws, listen());
    emit({ event: "partial", text: "hello" });
    emit({ event: "error", error: "The helper stopped", recoverable: true });
    expect(sent.at(-1)).toEqual({
      event: "error",
      session: 1,
      error: "The helper stopped",
      recoverable: true,
    });
  });

  test("a resume of an unknown session is an error the phone stops on", () => {
    const { socket } = dictationSocket();
    const { ws, sent } = fakeSocket();
    socket.message(
      ws,
      JSON.stringify({
        op: "resume",
        mode: "dictation",
        session: 42,
        resume: "x",
      }),
    );
    socket.message(
      ws,
      JSON.stringify({ op: "resume", session: 42, resume: "x" }),
    );
    expect(sent).toEqual([
      {
        event: "error",
        session: 42,
        error: "unknown session",
        recoverable: false,
      },
      { event: "resume_failed", session: 42 },
    ]);
  });

  test("a dictation resumed after a network change gets its final", async () => {
    jest.useFakeTimers();
    try {
      const { socket, emit } = dictationSocket();
      const first = fakeSocket();
      socket.message(first.ws, listen());
      socket.message(first.ws, audio(100));
      const token = first.sent[0]?.resume;
      socket.message(first.ws, JSON.stringify({ op: "finish" }));
      socket.close(first.ws);
      emit({ event: "final", text: "euh hello" });
      await settle();
      jest.advanceTimersByTime(DETACHED_MS - 1000);
      const second = fakeSocket();
      socket.message(
        second.ws,
        JSON.stringify({
          op: "resume",
          mode: "dictation",
          session: 1,
          resume: token,
        }),
      );
      expect(second.sent).toEqual([
        { event: "resumed", session: 1, received: 3200 },
        expect.objectContaining({ event: "final", text: "Hello." }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("warm starts the dictation cleaner and says whether there is one", () => {
    const { cleaner, warmed } = fakeCleaner();
    for (const using of [cleaner, null]) {
      const { socket } = dictationSocket(using);
      const { ws, sent } = fakeSocket();
      socket.message(ws, JSON.stringify({ op: "warm", mode: "dictation" }));
      expect(sent).toEqual([
        { event: "warm", mode: "dictation", cleaner: using !== null },
      ]);
    }
    expect(warmed()).toBe(1);
  });

  test("refused while a voice call goes on", async () => {
    const { socket, sessions } = dictationSocket();
    const caller = fakeSocket();
    socket.message(caller.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    expect(caller.sent[0]).toMatchObject({ event: "call_audio", call: 7 });
    const phone = fakeSocket();
    socket.message(phone.ws, listen());
    expect(phone.sent).toEqual([
      {
        event: "error",
        session: null,
        error: "A voice call is going on",
        busy: true,
      },
    ]);
    expect(sessions).toHaveLength(0);
  });

  test("voice chat taking the helper ends a dictation with what it heard", async () => {
    const { socket, emit } = dictationSocket();
    const phone = fakeSocket();
    socket.message(phone.ws, listen());
    emit({ event: "partial", text: "hello there" });
    const page = fakeSocket();
    socket.message(page.ws, JSON.stringify({ op: "listen" }));
    expect(phone.sent.at(-1)).toMatchObject({
      event: "final",
      session: 1,
      text: "hello there",
      cleaned: false,
    });
    expect(page.sent[0]).toMatchObject({ event: "listening", session: 2 });
  });

  test("stop cancels: nothing is typed", async () => {
    const { socket, emit, latest } = dictationSocket();
    const { ws, sent } = fakeSocket();
    socket.message(ws, listen());
    emit({ event: "partial", text: "hello" });
    socket.message(ws, JSON.stringify({ op: "stop" }));
    expect(latest().calls).toEqual(["stop"]);
    emit({ event: "final", text: "hello" });
    await settle();
    expect(sent.some((message) => message.event === "final")).toBe(false);
  });

  test("the debug log has timings and sizes, never the words", async () => {
    const saved = process.env.ROAMGATE_VOICE_DEBUG;
    const lines: string[] = [];
    const error = console.error;
    process.env.ROAMGATE_VOICE_DEBUG = "1";
    console.error = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      const { socket, emit } = dictationSocket();
      const { ws } = fakeSocket();
      socket.message(ws, listen({ before: "private thread" }));
      emit({ event: "partial", text: "secret words" });
      socket.message(ws, JSON.stringify({ op: "finish" }));
      emit({ event: "final", text: "secret words" });
      await settle();
    } finally {
      console.error = error;
      if (saved === undefined) delete process.env.ROAMGATE_VOICE_DEBUG;
      else process.env.ROAMGATE_VOICE_DEBUG = saved;
    }
    expect(lines.some((line) => line.includes("dictation 1"))).toBe(true);
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.join("\n")).not.toContain("private");
  });
});
