import { describe, expect, jest, test } from "bun:test";
import { musicRoute } from "../http/voice";
import { parseFrontReply } from "./voice-front";
import {
  createVoiceSocket,
  CALL_ICE_LINES,
  DETACHED_MS,
  STALL_MS,
  rewriteCandidates,
  sameSiteSocket,
  type SignallingSocket,
  type UpstreamSocket,
} from "../http/voice-socket";
import {
  type CallBackground,
  type CallEvent,
  type CallHandle,
  callBackground,
  encodeFrame,
  FRAME_JSON,
  type Frame,
  FrameReader,
  readVoiceConfig,
  PING_MS,
  SPEAK_COLD_MS,
  SPEAK_STUCK_MS,
  type VoiceConfig,
  VoiceHelper,
  type VoiceHelperProcess,
} from "./voice-helper";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG: VoiceConfig = {
  helper: "/bin/roamgate-voice",
  whisper_model: "whisper.bin",
  kokoro_model: "kokoro.onnx",
  kokoro_voices: "voices.bin",
};

const BACKGROUND: CallBackground = {
  background: "audiotestsrc is-live=true",
  volume: 0.6,
  ducked: 0.15,
  release_ms: 3000,
  muted: true,
  reply_loudness: -16,
};

const json = (message: object) =>
  encodeFrame(FRAME_JSON, new TextEncoder().encode(JSON.stringify(message)));

/** A helper answering requests with `answer`; `push` sends it frames. */
function fakeHelper(
  answer: (request: Record<string, unknown>) => object[] = () => [],
) {
  const requests: Record<string, unknown>[] = [];
  let push: (bytes: Uint8Array) => void = () => {};
  const spawn = (): VoiceHelperProcess => {
    const queue: Frame[] = [];
    let wake: (() => void) | null = null;
    push = (bytes) => {
      queue.push(...new FrameReader().push(bytes));
      wake?.();
    };
    const reader = new FrameReader();
    async function* out() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
    return {
      write: (bytes) => {
        for (const frame of reader.push(bytes)) {
          if (frame.kind !== FRAME_JSON) continue;
          const request = JSON.parse(new TextDecoder().decode(frame.payload));
          requests.push(request);
          for (const reply of answer(request)) push(json(reply));
        }
      },
      frames: out(),
      exited: new Promise(() => {}),
      kill: () => {},
    };
  };
  return { spawn, requests, push: (bytes: Uint8Array) => push(bytes) };
}

/** A helper that makes WebRTC calls (call.rs). */
const mixing = (request: Record<string, unknown>): object[] =>
  request.op === "call_start"
    ? [
        {
          id: request.id,
          ok: true,
          rate: 48000,
          channels: 2,
          music: true,
          signalling_port: 41234,
        },
      ]
    : request.op === "call_microphone"
      ? [{ id: request.id, ok: true }]
      : request.op === "speak"
        ? [
            {
              id: request.id,
              queued: true,
              start_ms: 1035,
              duration_ms: 1970,
              now_ms: 1200,
              language: "en",
              rate: 1.5,
            },
          ]
        : request.op === "call_music"
          ? [
              {
                id: request.id,
                ok: true,
                volume:
                  typeof request.volume === "number" ? request.volume : 0.6,
                muted: request.muted === true,
              },
            ]
          : [];

/** Lets the helper's frames through: microtasks only, fake timers or not. */
async function settle() {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

/** A socket keeping its JSON messages. */
function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    ws: { send: (message: string) => sent.push(JSON.parse(message)) },
  };
}

describe("a call, helper side", () => {
  test("starts a WebRTC call, speaks into it, and points its microphone", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const errors: string[] = [];
    const call = await helper.startCall(BACKGROUND, (event) => {
      if (event.event === "call_error") errors.push(event.error);
    });
    expect(fake.requests[0]).toMatchObject({
      op: "call_start",
      call: call.id,
      background: "audiotestsrc is-live=true",
      volume: 0.6,
      ducked: 0.15,
      release_ms: 3000,
      // Off until asked for.
      muted: true,
    });
    expect(call.music).toBe(true);
    expect(call.signallingPort()).toBe(41234);
    fake.push(json({ event: "call_error", call: call.id, error: "no music" }));
    await settle();
    expect(errors).toEqual(["no music"]);
    await call.microphone("peer-1");
    expect(fake.requests.at(-1)).toMatchObject({
      op: "call_microphone",
      call: call.id,
      peer: "peer-1",
    });
    expect(fake.requests.at(-1)).not.toHaveProperty("echo");
    // The page plays the replies without its echo canceller: the helper's.
    await call.microphone("peer-1", "here");
    expect(fake.requests.at(-1)).toMatchObject({
      op: "call_microphone",
      peer: "peer-1",
      echo: "here",
    });
    const queued = await helper.speakInCall(
      call.id,
      "Hello.",
      "en",
      undefined,
      1.5,
    );
    expect(fake.requests.at(-1)).toMatchObject({
      op: "speak",
      call: call.id,
      rate: 1.5,
    });
    expect(queued).toMatchObject({
      queued: true,
      startMs: 1035,
      durationMs: 1970,
      nowMs: 1200,
    });
    call.hush();
    call.stop();
    expect(fake.requests.slice(-2).map((r) => r.op)).toEqual([
      "call_hush",
      "call_stop",
    ]);
    await expect(call.microphone("peer-2")).rejects.toThrow("no call");
  });

  test("a listening session on the call hears its microphone and its progress", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const heard: unknown[] = [];
    const session = helper.listen((event) => heard.push(event), { call: 3 });
    expect(fake.requests[0]).toMatchObject({
      op: "listen_start",
      session: session.id,
      call: 3,
    });
    fake.push(json({ event: "audio", session: session.id, bytes: 6400 }));
    await settle();
    expect(heard).toEqual([
      { event: "audio", session: session.id, bytes: 6400 },
    ]);
  });

  test("a call's error reaches no listening session", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const heard: unknown[] = [];
    helper.listen((event) => heard.push(event));
    const call = await helper.startCall(BACKGROUND, () => {});
    fake.push(json({ event: "call_error", call: call.id, error: "x" }));
    await settle();
    expect(heard).toEqual([]);
  });

  test("muted call music is not on until call_music puts it on", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    // Off at the start (no call_music_at_start): configured, not playing.
    const call = await helper.startCall(BACKGROUND, () => {});
    expect(call.music).toBe(true);
    expect(call.musicOn()).toBe(false);
    await call.music_level({ muted: false });
    expect(call.musicOn()).toBe(true);
    await call.music_level({ volume: 0.3 });
    expect(call.musicOn()).toBe(true);
    await call.music_level({ muted: true });
    expect(call.musicOn()).toBe(false);
    const playing = await helper.startCall(
      { ...BACKGROUND, muted: false },
      () => {},
    );
    expect(playing.musicOn()).toBe(true);
  });

  test("call music waits for a voice while the helper says so", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const events: unknown[] = [];
    const call = await helper.startCall({ ...BACKGROUND, muted: false }, (e) =>
      events.push(e),
    );
    expect(call.musicWaiting()).toBe(false);
    // An event already newer than call_start's answer is kept.
    const waiting = (request: Record<string, unknown>) =>
      request.op === "call_start"
        ? [
            { event: "call_music", call: request.call, waiting: false },
            { ...(mixing(request)[0] as object), waiting: true },
          ]
        : mixing(request);
    const told = await new VoiceHelper(
      () => CONFIG,
      fakeHelper(waiting).spawn,
    ).startCall({ ...BACKGROUND, muted: false }, () => {});
    expect(told.musicWaiting()).toBe(false);
    const answered = await new VoiceHelper(
      () => CONFIG,
      fakeHelper((request) =>
        request.op === "call_start"
          ? [{ ...(mixing(request)[0] as object), waiting: true }]
          : mixing(request),
      ).spawn,
    ).startCall({ ...BACKGROUND, muted: false }, () => {});
    expect(answered.musicWaiting()).toBe(true);
    fake.push(json({ event: "call_music", call: call.id, waiting: true }));
    await settle();
    expect(call.musicOn()).toBe(true);
    expect(call.musicWaiting()).toBe(true);
    expect(events).toEqual([
      { event: "call_music", call: call.id, waiting: true },
    ]);
    // Off, it waits for nothing: there is nothing to play.
    await call.music_level({ muted: true });
    expect(call.musicWaiting()).toBe(false);
    await call.music_level({ muted: false });
    expect(call.musicWaiting()).toBe(true);
    fake.push(json({ event: "call_music", call: call.id, waiting: false }));
    await settle();
    expect(call.musicWaiting()).toBe(false);
  });

  test("an older helper without call_start refuses it", async () => {
    const fake = fakeHelper((request) => [
      { id: request.id, error: `unknown op ${String(request.op)}` },
    ]);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    await expect(helper.startCall(BACKGROUND, () => {})).rejects.toThrow(
      "unknown op call_start",
    );
  });

  test("a helper that mixes but makes no WebRTC call is not used", async () => {
    const fake = fakeHelper((request) =>
      request.op === "call_start"
        ? [{ id: request.id, ok: true, music: true }]
        : [],
    );
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    await expect(helper.startCall(BACKGROUND, () => {})).rejects.toThrow(
      "no WebRTC call",
    );
    expect(fake.requests.at(-1)).toMatchObject({ op: "call_stop" });
  });
});

/** A fake helper signalling server's socket, and what it was told. */
function fakeUpstream() {
  const made: { url: string; socket: UpstreamSocket; told: string[] }[] = [];
  const connect = (url: string): UpstreamSocket => {
    const told: string[] = [];
    const socket: UpstreamSocket = {
      readyState: 0,
      send: (message: string) => told.push(message),
      close: () => {
        (socket as { readyState: number }).readyState = 3;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    made.push({ url, socket, told });
    return socket;
  };
  const open = (index = made.length - 1) => {
    const { socket } = made[index]!;
    (socket as { readyState: number }).readyState = 1;
    socket.onopen?.({});
  };
  return { made, connect, open };
}

/** A page's signalling socket: what it got, and how it closed. */
function fakePageSignalling() {
  const got: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws: SignallingSocket = {
    send: (message: string) => got.push(message),
    close: (code?: number, reason?: string) => closed.push({ code, reason }),
  };
  return { ws, got, closed };
}

describe("a call, socket side", () => {
  const started = async (
    answer: (request: Record<string, unknown>) => object[] = mixing,
    iceAddress: string | null = "100.71.231.65",
  ) => {
    const fake = fakeHelper(answer);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const upstream = fakeUpstream();
    const socket = createVoiceSocket(
      helper,
      () => null,
      () => undefined,
      () => BACKGROUND,
      () => iceAddress,
      upstream.connect,
    );
    const page = fakeSocket();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    return { fake, helper, socket, page, upstream };
  };

  test("starts a WebRTC call for its page", async () => {
    const { page, socket } = await started();
    expect(page.sent[0]).toEqual({
      event: "call_audio",
      call: 1,
      resume: expect.any(String),
      music: true,
      waiting: false,
      webrtc: true,
    });
    expect(socket.currentCall()?.id).toBe(1);
  });

  test("hanging up tells the end of the call, a newer call does not", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    let ended = 0;
    const socket = createVoiceSocket(
      helper,
      () => null,
      () => undefined,
      () => BACKGROUND,
      () => null,
      undefined,
      () => {
        ended += 1;
      },
    );
    const page = fakeSocket();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    expect(ended).toBe(0);
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: false }));
    await settle();
    expect(ended).toBe(1);
  });

  test("a call without music is a call all the same", async () => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const socket = createVoiceSocket(
      helper,
      () => null,
      () => undefined,
      () => null,
    );
    const page = fakeSocket();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    expect(page.sent[0]).toMatchObject({ event: "call_audio", call: 1 });
    expect(fake.requests[0]).toMatchObject({
      op: "call_start",
      background: "",
    });
  });

  test("the call's answer, and a resume's, say whether its music waits", async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeHelper((request) =>
        request.op === "call_start"
          ? [{ ...(mixing(request)[0] as object), waiting: true }]
          : mixing(request),
      );
      const helper = new VoiceHelper(() => CONFIG, fake.spawn);
      const socket = createVoiceSocket(
        helper,
        () => null,
        () => undefined,
        () => ({ ...BACKGROUND, muted: false }),
      );
      const page = fakeSocket();
      socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
      await settle();
      expect(page.sent[0]).toMatchObject({
        event: "call_audio",
        call: 1,
        music: true,
        waiting: true,
      });
      // A voice taken while no socket holds the call: its resume says so.
      socket.close(page.ws);
      fake.push(json({ event: "call_music", call: 1, waiting: false }));
      await settle();
      const again = fakeSocket();
      socket.message(
        again.ws,
        JSON.stringify({
          op: "call_resume",
          call: 1,
          resume: page.sent[0]!.resume,
        }),
      );
      expect(again.sent[0]).toMatchObject({
        event: "call_audio",
        resumed: true,
        waiting: false,
      });
      socket.message(again.ws, JSON.stringify({ op: "call_audio", on: false }));
    } finally {
      jest.useRealTimers();
    }
  });

  test("only the page owning the call points its microphone", async () => {
    const { fake, socket, page } = await started();
    const other = fakeSocket();
    socket.message(
      other.ws,
      JSON.stringify({ op: "call_microphone", peer: "intruder" }),
    );
    socket.message(
      page.ws,
      JSON.stringify({ op: "call_microphone", peer: "peer-7" }),
    );
    await settle();
    const asked = fake.requests.filter((r) => r.op === "call_microphone");
    expect(asked).toEqual([
      {
        op: "call_microphone",
        call: 1,
        peer: "peer-7",
        id: expect.any(Number),
      },
    ]);
    expect(page.sent.at(-1)).toEqual({
      event: "call_microphone",
      call: 1,
      ok: true,
    });
    expect(other.sent).toEqual([]);
  });

  test("the page's ICE lines are logged always, its own call's only", async () => {
    const { socket, page } = await started();
    const logged: string[] = [];
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => {
        logged.push(String(line));
      });
    try {
      const other = fakeSocket();
      socket.message(
        other.ws,
        JSON.stringify({ op: "call_ice", line: "not this one's" }),
      );
      socket.message(
        page.ws,
        JSON.stringify({
          op: "call_ice",
          line: "replies: ICE failed\nhost udp (vpn) -> host udp",
        }),
      );
      expect(logged).toEqual([
        "[voice] call 1 (page): replies: ICE failed | host udp (vpn) -> host udp",
      ]);
      for (let i = 0; i < CALL_ICE_LINES + 5; i += 1)
        socket.message(page.ws, JSON.stringify({ op: "call_ice", line: "x" }));
      expect(logged).toHaveLength(CALL_ICE_LINES);
    } finally {
      spy.mockRestore();
    }
  });

  test("a listening on the call hears its microphone, timed by what came", async () => {
    const { fake, socket, page } = await started();
    socket.message(
      page.ws,
      JSON.stringify({ op: "listen", call: 1, new_speaker: true }),
    );
    const start = fake.requests.find((r) => r.op === "listen_start")!;
    expect(start).toMatchObject({ call: 1 });
    const session = start.session as number;
    // A pause read at its start, then the call's microphone comes: its
    // audio counts as the socket's did, and is never told to the page.
    fake.push(
      json({
        event: "partial",
        session,
        text: "and then",
        pause: true,
        pause_ms: 500,
        turn: 0.9,
      }),
    );
    for (let i = 0; i < 40; i += 1)
      fake.push(json({ event: "audio", session, bytes: 6400 }));
    await settle();
    expect(page.sent.some((m) => m.event === "audio")).toBe(false);
    expect(fake.requests.at(-1)).toMatchObject({
      op: "listen_finish",
      session,
    });
  });

  test("a call listening whose stream stalls stays on its socket", async () => {
    jest.useFakeTimers();
    try {
      const { fake, socket, page } = await started();
      socket.message(page.ws, JSON.stringify({ op: "listen", call: 1 }));
      const session = fake.requests.find((r) => r.op === "listen_start")!
        .session as number;
      fake.push(json({ event: "audio", session, bytes: 6400 }));
      await settle();
      jest.advanceTimersByTime(STALL_MS);
      // The socket is alive: told, and what is heard still comes.
      expect(page.sent.at(-1)).toEqual({ event: "stalled", session });
      fake.push(json({ event: "speech_start", session }));
      await settle();
      expect(page.sent.at(-1)).toEqual({ event: "speech_start", session });
      // Its stream back: the utterance goes on.
      fake.push(json({ event: "audio", session, bytes: 6400 }));
      await settle();
      jest.advanceTimersByTime(DETACHED_MS);
      expect(fake.requests.some((r) => r.op === "listen_finish")).toBe(false);
      // Stalled for good: it ends with what was heard, told on the socket.
      jest.advanceTimersByTime(STALL_MS);
      expect(page.sent.at(-1)).toEqual({ event: "stalled", session });
      jest.advanceTimersByTime(DETACHED_MS);
      expect(fake.requests.at(-1)).toMatchObject({
        op: "listen_finish",
        session,
      });
      fake.push(json({ event: "final", session, text: "Hello" }));
      await settle();
      expect(page.sent.at(-1)).toEqual({
        event: "final",
        session,
        text: "Hello",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("another socket's listening, or another call's, hears the socket", async () => {
    const { fake, socket } = await started();
    const other = fakeSocket();
    socket.message(other.ws, JSON.stringify({ op: "listen", call: 1 }));
    expect(
      fake.requests.find((r) => r.op === "listen_start")!.call,
    ).toBeUndefined();
  });

  test("moves to a new socket within DETACHED_MS, stops past it", async () => {
    jest.useFakeTimers();
    try {
      const { fake, socket, page } = await started();
      const token = page.sent[0]!.resume;
      socket.close(page.ws);
      jest.advanceTimersByTime(DETACHED_MS - 1000);
      const again = fakeSocket();
      socket.message(
        again.ws,
        JSON.stringify({ op: "call_resume", call: 1, resume: token }),
      );
      expect(again.sent).toEqual([
        {
          event: "call_audio",
          call: 1,
          resumed: true,
          restarts: 0,
          waiting: false,
        },
      ]);
      // Detached past DETACHED_MS: the call stops.
      socket.close(again.ws);
      jest.advanceTimersByTime(DETACHED_MS);
      expect(fake.requests.at(-1)).toMatchObject({ op: "call_stop", call: 1 });
      const late = fakeSocket();
      socket.message(
        late.ws,
        JSON.stringify({ op: "call_resume", call: 1, resume: token }),
      );
      expect(late.sent[0]).toMatchObject({
        event: "call_audio",
        error: expect.any(String),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a rebuilt chat's new socket takes the call over; the old one's stop and close leave it", async () => {
    const { fake, socket, page } = await started();
    const token = page.sent[0]!.resume;
    const again = fakeSocket();
    socket.message(
      again.ws,
      JSON.stringify({ op: "call_resume", call: 1, resume: token }),
    );
    expect(again.sent[0]).toMatchObject({ event: "call_audio", resumed: true });
    // The old link lets go: its stop and its close end nothing.
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: false }));
    socket.close(page.ws);
    await settle();
    expect(fake.requests.some((r) => r.op === "call_stop")).toBe(false);
    // The new owner points the microphone.
    socket.message(
      again.ws,
      JSON.stringify({ op: "call_microphone", peer: "peer-9", echo: "here" }),
    );
    expect(fake.requests.at(-1)).toMatchObject({
      op: "call_microphone",
      peer: "peer-9",
      echo: "here",
    });
  });

  test("a wrong token resumes nothing", async () => {
    const { socket } = await started();
    const other = fakeSocket();
    socket.message(
      other.ws,
      JSON.stringify({ op: "call_resume", call: 1, resume: "nope" }),
    );
    expect(other.sent[0]).toMatchObject({
      event: "call_audio",
      error: expect.any(String),
    });
  });

  test("a newer call ends the one before, and tells its page", async () => {
    const { fake, socket, page } = await started();
    const other = fakeSocket();
    socket.message(other.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    expect(page.sent.at(-1)).toEqual({
      event: "call_audio",
      call: 1,
      error: "Replaced by a newer call",
    });
    expect(other.sent[0]).toMatchObject({ event: "call_audio", call: 2 });
    expect(fake.requests.filter((r) => r.op === "call_stop")).toEqual([
      { op: "call_stop", call: 1 },
    ]);
  });

  test("hush and stop go to the helper", async () => {
    const { fake, socket, page } = await started();
    socket.message(page.ws, JSON.stringify({ op: "call_hush" }));
    // Another call's end (a late answer's) leaves this one.
    socket.message(
      page.ws,
      JSON.stringify({ op: "call_audio", on: false, call: 2 }),
    );
    expect(socket.currentCall()?.id).toBe(1);
    socket.message(
      page.ws,
      JSON.stringify({ op: "call_audio", on: false, call: 1 }),
    );
    expect(fake.requests.slice(-2).map((r) => r.op)).toEqual([
      "call_hush",
      "call_stop",
    ]);
    expect(socket.currentCall()).toBeNull();
  });

  test("an older helper: the page plays each sentence itself", async () => {
    const { page, socket } = await started((request) => [
      { id: request.id, error: `unknown op ${String(request.op)}` },
    ]);
    expect(page.sent).toEqual([
      { event: "call_audio", error: "unknown op call_start" },
    ]);
    expect(socket.currentCall()).toBeNull();
  });
});

describe("a call's signalling, fronted", () => {
  const started = async (iceAddress: string | null = "100.71.231.65") => {
    const fake = fakeHelper(mixing);
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const upstream = fakeUpstream();
    const socket = createVoiceSocket(
      helper,
      () => null,
      () => undefined,
      () => BACKGROUND,
      () => iceAddress,
      upstream.connect,
    );
    const page = fakeSocket();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    const token = String(page.sent[0]!.resume);
    return { fake, socket, page, upstream, token };
  };

  test("only the token of the page owning the call opens it", async () => {
    const { socket, token } = await started();
    expect(socket.ownsCall(1, token)).toBe(true);
    expect(socket.ownsCall(1, "guess")).toBe(false);
    expect(socket.ownsCall(2, token)).toBe(false);
    expect(socket.ownsCall("1", token)).toBe(false);
    const late = fakePageSignalling();
    socket.message(
      fakeSocket().ws,
      JSON.stringify({ op: "call_audio", on: true }),
    );
    await settle();
    // A newer call replaced it: the old token opens nothing.
    expect(socket.ownsCall(1, token)).toBe(false);
    socket.openSignalling(late.ws, 1, token);
    expect(late.closed).toEqual([{ code: 4004, reason: "No such call" }]);
  });

  test("relays both ways to the call's own server, waiting for it to open", async () => {
    const { socket, upstream, token } = await started();
    const page = fakePageSignalling();
    socket.openSignalling(page.ws, 1, token);
    expect(upstream.made.map((m) => m.url)).toEqual(["ws://127.0.0.1:41234"]);
    socket.signallingMessage(page.ws, '{"type":"setPeerStatus"}');
    expect(upstream.made[0]!.told).toEqual([]);
    upstream.open();
    expect(upstream.made[0]!.told).toEqual(['{"type":"setPeerStatus"}']);
    socket.signallingMessage(page.ws, '{"type":"list"}');
    expect(upstream.made[0]!.told.at(-1)).toBe('{"type":"list"}');
    upstream.made[0]!.socket.onmessage?.({ data: '{"type":"welcome"}' });
    expect(page.got).toEqual(['{"type":"welcome"}']);
  });

  test("gives the helper's loopback candidates at the call's address", async () => {
    const { socket, upstream, token } = await started();
    const page = fakePageSignalling();
    socket.openSignalling(page.ws, 1, token);
    upstream.open();
    const tell = (message: object) =>
      upstream.made[0]!.socket.onmessage?.({ data: JSON.stringify(message) });
    tell({
      type: "peer",
      sessionId: "s",
      ice: {
        candidate: "candidate:1 1 UDP 2015363327 127.0.0.1 40012 typ host",
        sdpMLineIndex: 0,
      },
    });
    tell({
      type: "peer",
      sessionId: "s",
      ice: {
        candidate: "candidate:2 1 UDP 2015363327 192.168.1.82 40014 typ host",
        sdpMLineIndex: 0,
      },
    });
    expect(page.got.map((m) => JSON.parse(m).ice.candidate)).toEqual([
      "candidate:1 1 UDP 2015363327 100.71.231.65 40012 typ host",
      "candidate:2 1 UDP 2015363327 192.168.1.82 40014 typ host",
    ]);
  });

  test("the helper's socket closing closes the page's, and the other way", async () => {
    const { socket, upstream, token } = await started();
    const first = fakePageSignalling();
    socket.openSignalling(first.ws, 1, token);
    upstream.open(0);
    upstream.made[0]!.socket.onclose?.({});
    expect(first.closed).toEqual([
      { code: 1011, reason: "The call's signalling closed" },
    ]);
    const second = fakePageSignalling();
    socket.openSignalling(second.ws, 1, token);
    upstream.open(1);
    socket.closeSignalling(second.ws);
    expect(upstream.made[1]!.socket.readyState).toBe(3);
  });

  test("the call ending, or its helper restarting, closes its signalling", async () => {
    const { fake, socket, page, upstream, token } = await started();
    const signalling = fakePageSignalling();
    socket.openSignalling(signalling.ws, 1, token);
    upstream.open();
    fake.push(json({ event: "call_restarted", call: 1 }));
    await settle();
    expect(signalling.closed).toEqual([
      { code: 4000, reason: "The voice helper restarted" },
    ]);
    expect(page.sent.at(-1)).toEqual({
      event: "call_restarted",
      call: 1,
      restarts: 1,
    });
    const again = fakePageSignalling();
    socket.openSignalling(again.ws, 1, token);
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: false }));
    expect(again.closed).toEqual([{ code: 4000, reason: "The call ended" }]);
  });

  test("call restarts reach the page even across a socket change, and a dead call is not owned", async () => {
    jest.useFakeTimers();
    try {
      const { fake, socket, page, token } = await started();
      // The page's socket is gone when the helper makes the call again.
      socket.close(page.ws);
      fake.push(json({ event: "call_restarted", call: 1 }));
      await settle();
      expect(page.sent.some((m) => m.event === "call_restarted")).toBe(false);
      // Its new socket learns it from the resume.
      const again = fakeSocket();
      socket.message(
        again.ws,
        JSON.stringify({ op: "call_resume", call: 1, resume: token }),
      );
      expect(again.sent).toEqual([
        {
          event: "call_audio",
          call: 1,
          resumed: true,
          restarts: 1,
          waiting: false,
        },
      ]);
      // A helper that cannot make it again ends it: told, not owned, and
      // its signalling refused instead of dialled.
      fake.push(
        json({
          event: "call_ended",
          call: 1,
          error: "The voice helper stopped: the call did not start",
        }),
      );
      await settle();
      expect(again.sent.at(-1)).toEqual({
        event: "call_audio",
        call: 1,
        error: "The voice helper stopped: the call did not start",
      });
      expect(socket.ownsCall(1, token)).toBe(false);
      expect(socket.currentCall()).toBeNull();
      const late = fakePageSignalling();
      socket.openSignalling(late.ws, 1, token);
      expect(late.closed).toEqual([{ code: 4004, reason: "No such call" }]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a page elsewhere is refused, this site's is not", () => {
    const request = (site?: string) =>
      new Request("https://mac.example/api/voice/call/signalling", {
        headers: site ? { "sec-fetch-site": site } : {},
      });
    expect(sameSiteSocket(request("cross-site"))).toBe(false);
    expect(sameSiteSocket(request("same-origin"))).toBe(true);
    expect(sameSiteSocket(request())).toBe(true);
  });

  test("rewrites only host UDP candidates on 127.0.0.1, in SDP too", () => {
    const sdp = [
      "v=0",
      "a=candidate:1 1 UDP 2015363327 127.0.0.1 40012 typ host",
      "a=candidate:2 1 TCP 1015022079 127.0.0.1 9 typ host tcptype active",
      "a=candidate:3 1 UDP 1677722111 127.0.0.1 40020 typ srflx raddr 0.0.0.0 rport 0",
      "",
    ].join("\r\n");
    const out = JSON.parse(
      rewriteCandidates(
        JSON.stringify({
          type: "peer",
          sessionId: "s",
          sdp: { type: "offer", sdp },
        }),
        "100.71.231.65",
      ),
    ).sdp.sdp as string;
    expect(out.split("\r\n").slice(1, 4)).toEqual([
      "a=candidate:1 1 UDP 2015363327 100.71.231.65 40012 typ host",
      "a=candidate:2 1 TCP 1015022079 127.0.0.1 9 typ host tcptype active",
      "a=candidate:3 1 UDP 1677722111 127.0.0.1 40020 typ srflx raddr 0.0.0.0 rport 0",
    ]);
    // No address set: as it is.
    const message = JSON.stringify({
      type: "peer",
      sdp: { type: "offer", sdp },
    });
    expect(rewriteCandidates(message, null)).toBe(message);
    expect(rewriteCandidates("not json", "100.71.231.65")).toBe("not json");
  });
});

describe("call music", () => {
  const handle = (music = true) => {
    const changes: object[] = [];
    let volume = 0.6;
    const call: CallHandle = {
      id: 1,
      signallingPort: () => 41234,
      microphone: async () => {},
      music,
      musicOn: () => music,
      musicWaiting: () => false,
      hush: () => {},
      stop: () => {},
      music_level: async (change) => {
        changes.push(change);
        if (change.volume !== undefined) volume = change.volume;
        return { volume, muted: change.muted === true };
      },
    };
    return { call, changes };
  };

  test("down, up, off and on change the call's music", async () => {
    const { call, changes } = handle();
    expect(
      await musicRoute(
        { to: "music", music: "down", reply: "Je baisse." },
        call,
      ),
    ).toEqual({ to: "self", reply: "Je baisse." });
    expect(changes.at(-1)).toEqual({ muted: false, volume: 0.6 / 1.6 });
    await musicRoute({ to: "music", music: "up" }, call);
    expect((changes.at(-1) as { volume: number }).volume).toBeCloseTo(0.6);
    await musicRoute({ to: "music", music: "off" }, call);
    expect(changes.at(-1)).toEqual({ muted: true });
    await musicRoute({ to: "music", music: "on" }, call);
    expect(changes.at(-1)).toEqual({ muted: false });
  });

  test("each change is logged, the music before and after", async () => {
    const { call } = handle();
    const logged: string[] = [];
    const error = jest
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => {
        logged.push(String(line));
      });
    try {
      await musicRoute({ to: "music", music: "up" }, call);
      await musicRoute({ to: "music", music: "off" }, call);
    } finally {
      error.mockRestore();
    }
    expect(logged).toEqual([
      "[voice] the call's music up: volume 0.60 -> volume 0.96",
      "[voice] the call's music off: volume 0.96 -> off",
    ]);
  });

  test("with no music, it says so", async () => {
    expect(
      await musicRoute(
        { to: "music", music: "off", reply: "Ok." },
        handle(false).call,
      ),
    ).toEqual({ to: "self", reply: "No music is playing on this call." });
    expect(await musicRoute({ to: "music", music: "off" }, null)).toMatchObject(
      {
        to: "self",
      },
    );
  });
});

describe("call background settings", () => {
  const write = (extra: object) => {
    const dir = mkdtempSync(join(tmpdir(), "voice-call-"));
    const path = join(dir, "voice.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...CONFIG,
        helper: "/bin/sh",
        whisper_model: undefined,
        kokoro_model: undefined,
        kokoro_voices: undefined,
        parakeet_model: undefined,
        tts_models: [{ model: "kokoro" }],
        ...extra,
      }),
    );
    return path;
  };

  test("default to no background, 0.6, 0.15, 3 s and the music off at first", () => {
    expect(callBackground(CONFIG)).toEqual({
      background: "",
      volume: 0.6,
      ducked: 0.15,
      release_ms: 3000,
      muted: true,
      reply_loudness: -16,
    });
    expect(callBackground({ ...CONFIG, call_music_at_start: true }).muted).toBe(
      false,
    );
  });

  test("brings the replies to call_reply_loudness, or leaves them on false", () => {
    expect(
      callBackground({ ...CONFIG, call_reply_loudness: -14 }).reply_loudness,
    ).toBe(-14);
    expect(
      callBackground({ ...CONFIG, call_reply_loudness: false }).reply_loudness,
    ).toBeNull();
    for (const call_reply_loudness of [-3, -50, "loud", true])
      expect(
        readVoiceConfig(
          write({ whisper_model: "/bin/sh", call_reply_loudness }),
        ),
      ).toEqual({ error: expect.stringContaining("call_reply_loudness") });
    expect(
      readVoiceConfig(
        write({ whisper_model: "/bin/sh", call_reply_loudness: false }),
      ),
    ).toMatchObject({ call_reply_loudness: false });
  });

  test("voice.json takes call_music_at_start as a boolean only", () => {
    expect(
      readVoiceConfig(
        write({ whisper_model: "/bin/sh", call_music_at_start: "yes" }),
      ),
    ).toMatchObject({ error: expect.stringContaining("call_music_at_start") });
  });

  test("voice.json refuses levels out of range", () => {
    const config = readVoiceConfig(
      write({ whisper_model: "/bin/sh", call_background_ducked: 2 }),
    );
    expect(config).toEqual({
      error: expect.stringContaining("call_background_ducked"),
    });
    const fine = readVoiceConfig(
      write({
        whisper_model: "/bin/sh",
        call_background: "osxprocesstapsrc bundle-id=com.spotify.client",
        call_background_volume: 0.5,
      }),
    );
    expect(fine).toMatchObject({ call_background_volume: 0.5 });
  });
});

describe("the front's music route", () => {
  test("is read with its change, and only a known one", () => {
    expect(
      parseFrontReply(
        '{"to": "music", "music": "down", "reply": "Je baisse la musique."}',
        new Set(),
      ),
    ).toEqual({ to: "music", music: "down", reply: "Je baisse la musique." });
    expect(
      parseFrontReply('{"to": "music", "music": "skip"}', new Set()),
    ).toEqual({ to: "current" });
  });
});

describe("a stuck speaker", () => {
  const QWEN_AND_KOKORO: VoiceConfig = {
    ...CONFIG,
    tts_models: [
      { model: "qwen3-tts", path: "/models/qwen" },
      { model: "kokoro", path: "/models/kokoro" },
    ],
  };

  /**
   * Helpers that answer `speak` only when `answers(helper, request)`, and
   * `call_start` unless `refuses(helper)`; pings while not `deaf`.
   */
  const helpers = (
    answers: (spawned: number, request: Record<string, unknown>) => boolean,
    refuses: (spawned: number) => boolean = () => false,
  ) => {
    const made = {
      spawned: 0,
      killed: 0,
      requests: [] as Record<string, unknown>[],
      /** Sends the newest helper a message (its progress). */
      say: (() => {}) as (message: object) => void,
      /** The newest helper writes these bytes on its output as they are. */
      raw: (() => {}) as (bytes: Uint8Array) => void,
      /** The newest helper's output is not read: nothing, pings included. */
      deaf: false,
      /** Holds the newest helper's call_start answers until let go. */
      holdStarts: false,
      letStartsGo: () => {},
    };
    const spawn = (): VoiceHelperProcess => {
      made.spawned += 1;
      made.deaf = false;
      const number = made.spawned;
      let exit: () => void = () => {};
      const exited = new Promise<void>((resolve) => {
        exit = resolve;
      });
      const queue: Frame[] = [];
      let wake: (() => void) | null = null;
      const reader = new FrameReader();
      const output = new FrameReader();
      const raw = (bytes: Uint8Array) => {
        queue.push(...output.push(bytes));
        wake?.();
      };
      made.raw = raw;
      const reply = (message: object) => {
        if (!made.deaf || number !== made.spawned) raw(json(message));
      };
      made.say = reply;
      const held: object[] = [];
      made.letStartsGo = () => {
        for (const answer of held.splice(0)) reply(answer);
      };
      return {
        write: (bytes) => {
          for (const frame of reader.push(bytes)) {
            if (frame.kind !== FRAME_JSON) continue;
            const request = JSON.parse(new TextDecoder().decode(frame.payload));
            made.requests.push(request);
            if (request.op === "ping") reply({ id: request.id, ok: true });
            if (request.op === "call_start") {
              const answer = refuses(number)
                ? { id: request.id, error: "the call did not start" }
                : {
                    id: request.id,
                    ok: true,
                    music: true,
                    signalling_port: 41000 + number,
                  };
              if (made.holdStarts) held.push(answer);
              else reply(answer);
            }
            if (request.op === "call_music")
              reply({
                id: request.id,
                ok: true,
                volume: 0.6,
                muted: request.muted === true,
              });
            if (request.op === "speak" && answers(number, request))
              reply(
                request.call === undefined
                  ? { id: request.id, audio: "", language: "en" }
                  : {
                      id: request.id,
                      queued: true,
                      start_ms: 100,
                      duration_ms: 900,
                      language: "en",
                    },
              );
          }
        },
        frames: (async function* () {
          for (;;) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            if (output.error) throw output.error;
            const next = await Promise.race([
              exited.then(() => "exit" as const),
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
            ]);
            wake = null;
            if (next === "exit") return;
          }
        })(),
        exited,
        kill: () => {
          made.killed += 1;
          exit();
        },
      };
    };
    return { made, spawn };
  };

  const flush = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(0);
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };

  test("a stuck sentence is said again with Kokoro, by a new helper", async () => {
    jest.useFakeTimers();
    try {
      // The first helper never speaks; the second does.
      const { made, spawn } = helpers((spawned) => spawned > 1);
      const helper = new VoiceHelper(() => QWEN_AND_KOKORO, spawn);
      const said = helper.speak("Hello");
      await Promise.resolve();
      // Its first sentence may load the model.
      jest.advanceTimersByTime(SPEAK_COLD_MS - 1);
      await settle();
      expect(made.killed).toBe(0);
      jest.advanceTimersByTime(1);
      // It answers a ping: its speaker is what is stuck.
      await settle();
      expect(made.requests.some((r) => r.op === "ping")).toBe(true);
      expect(made.killed).toBe(1);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(0);
      await said;
      expect(made.spawned).toBe(2);
      const again = made.requests.filter((r) => r.op === "speak").at(-1)!;
      expect(String(again.tts_models)).toContain("kokoro");
      expect(String(again.tts_models)).not.toContain("qwen");
      // Kokoro reads the next ones too, for a while.
      await helper.speak("Next");
      const next = made.requests.filter((r) => r.op === "speak").at(-1)!;
      expect(String(next.tts_models)).toContain("kokoro");
      helper.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("once it spoke, a sentence may take 8 s", async () => {
    jest.useFakeTimers();
    try {
      // Answers the first sentence only.
      let answered = 0;
      const { made, spawn } = helpers(() => answered++ === 0);
      const helper = new VoiceHelper(() => CONFIG, spawn);
      await helper.speak("First");
      const stuck = helper.speak("Second").catch((error: Error) => error);
      await Promise.resolve();
      jest.advanceTimersByTime(SPEAK_STUCK_MS - 1);
      await settle();
      expect(made.killed).toBe(0);
      jest.advanceTimersByTime(1);
      await settle();
      expect(made.killed).toBe(1);
      // No Kokoro in voice.json: it fails, the next one starts a helper.
      expect(String(await stuck)).toContain("The voice helper stopped");
      helper.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a call's first sentence may load its model, even after one outside it", async () => {
    jest.useFakeTimers();
    try {
      // Speaks outside calls; never into one.
      const { made, spawn } = helpers(
        (_, request) => request.call === undefined,
      );
      const helper = new VoiceHelper(() => QWEN_AND_KOKORO, spawn);
      await helper.speak("Outside");
      const call = helper.startCall(BACKGROUND, () => {});
      await flush();
      const handle = await call;
      void helper.speakInCall(handle.id, "Inside").catch(() => {});
      await flush();
      jest.advanceTimersByTime(SPEAK_STUCK_MS);
      await settle();
      expect(made.killed).toBe(0);
      jest.advanceTimersByTime(SPEAK_COLD_MS - SPEAK_STUCK_MS);
      await settle();
      expect(made.killed).toBe(1);
      helper.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a restart during a call makes it again, with its new signalling, and says the reply there with Kokoro", async () => {
    jest.useFakeTimers();
    try {
      // The first helper never speaks; the second does.
      const { made, spawn } = helpers((spawned) => spawned > 1);
      const helper = new VoiceHelper(() => QWEN_AND_KOKORO, spawn);
      const events: CallEvent[] = [];
      const call = helper.startCall(BACKGROUND, (event) => events.push(event));
      await flush();
      const handle = await call;
      // The user put the music on: the call is made again with it on.
      const on = handle.music_level({ muted: false });
      await flush();
      await on;
      const said = helper.speakInCall(handle.id, "Yes, I'm here");
      await flush();
      jest.advanceTimersByTime(SPEAK_COLD_MS);
      await flush();
      const queued = await said;
      expect(queued).toMatchObject({ queued: true, startMs: 100 });
      expect(events).toEqual([{ event: "call_restarted", call: handle.id }]);
      // Its new signalling server, in the new helper.
      expect(handle.signallingPort()).toBe(41002);
      // In the new helper: the call first, under its number, then the
      // sentence into it, with Kokoro.
      const second = made.requests.slice(
        made.requests.findIndex((r) => r.op === "ping") + 1,
      );
      expect(second.map((r) => r.op)).toEqual(["call_start", "speak"]);
      expect(second[0]).toMatchObject({ call: handle.id, muted: false });
      expect(second[1]).toMatchObject({ call: handle.id });
      expect(String(second[1]!.tts_models)).toContain("kokoro");
      helper.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  /** What the voice helper logs meanwhile. */
  const logged = async (run: () => Promise<void>) => {
    const lines: string[] = [];
    const saved = console.error;
    console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
    try {
      await run();
    } finally {
      console.error = saved;
    }
    return lines.join("\n");
  };
  const LOG_LINE = new TextEncoder().encode(
    "\x1b[2m2026-11-07T03:44:05.099012Z\x1b[0m \x1b[33m WARN\x1b[0m any_tts::models::kokoro::style_encoder: Style encoder weights not found (voice cloning unavailable)\n",
  );

  test("a helper writing something not a frame is restarted at once, and says what it wrote", async () => {
    const { made, spawn } = helpers(() => true);
    const helper = new VoiceHelper(() => QWEN_AND_KOKORO, spawn);
    const events: CallEvent[] = [];
    const log = await logged(async () => {
      const handle = await helper.startCall(BACKGROUND, (event) =>
        events.push(event),
      );
      made.raw(LOG_LINE);
      await settle();
      expect(made.killed).toBe(1);
      expect(made.spawned).toBe(2);
      // Made again at once, in the new helper.
      expect(events).toEqual([{ event: "call_restarted", call: handle.id }]);
      expect(made.requests.at(-1)).toMatchObject({
        op: "call_start",
        call: handle.id,
      });
      helper.stop();
    });
    expect(log).toContain("not frames");
    expect(log).toContain("any_tts::models::kokoro::style_encoder");
    expect(log).not.toContain("made no speech");
  });

  test("a deaf helper is told from a stuck speaker: restarted, its sentence said again as it was", async () => {
    jest.useFakeTimers();
    try {
      // Speaks only once restarted.
      const { made, spawn } = helpers((spawned) => spawned > 1);
      const helper = new VoiceHelper(() => QWEN_AND_KOKORO, spawn);
      helper.sampleHangs = false;
      const log = await logged(async () => {
        const said = helper.speak("Hello");
        await settle();
        // Its output is lost from here: not even a ping comes back.
        made.deaf = true;
        jest.advanceTimersByTime(SPEAK_COLD_MS);
        await settle();
        expect(made.killed).toBe(0);
        jest.advanceTimersByTime(PING_MS);
        await settle();
        expect(made.killed).toBe(1);
        jest.advanceTimersByTime(0);
        await settle();
        await said;
        expect(made.spawned).toBe(2);
        // Said again as it was, with Qwen3-TTS: nothing was stuck.
        const again = made.requests.filter((r) => r.op === "speak").at(-1)!;
        expect(again.tts_models).toBeUndefined();
        helper.stop();
      });
      expect(log).toContain("answered no ping");
      expect(log).toContain("unreadable");
      expect(log).not.toContain("made no speech");
    } finally {
      jest.useRealTimers();
    }
  });

  test("a call whose start was never answered is not made again after a restart; a failed re-make ends the call", async () => {
    await logged(async () => {
      // Its call_start never answered when the helper goes.
      const pending = helpers(() => true);
      const first = new VoiceHelper(() => CONFIG, pending.spawn);
      const told: CallEvent[] = [];
      pending.made.holdStarts = true;
      const starting = first
        .startCall(BACKGROUND, (event) => told.push(event))
        .catch((error: Error) => error);
      await settle();
      pending.made.raw(LOG_LINE);
      await settle();
      expect(String(await starting)).toContain("The voice helper stopped");
      // No helper is started for it, nor told to make it.
      expect(pending.made.spawned).toBe(1);
      expect(told).toEqual([]);

      // Answered, then the restarted helper cannot make it again: it ends.
      const refused = helpers(
        () => true,
        (spawned) => spawned > 1,
      );
      const second = new VoiceHelper(() => CONFIG, refused.spawn);
      const ended: CallEvent[] = [];
      const handle = await second.startCall(BACKGROUND, (event) =>
        ended.push(event),
      );
      refused.made.raw(LOG_LINE);
      await settle();
      expect(ended).toEqual([
        {
          event: "call_ended",
          call: handle.id,
          error: "The voice helper stopped: the call did not start",
        },
      ]);
      expect(handle.signallingPort()).toBe(0);

      // Stopped while it was made again: not left in the new helper.
      const late = helpers(() => true);
      const third = new VoiceHelper(() => CONFIG, late.spawn);
      const heard: CallEvent[] = [];
      const going = await third.startCall(BACKGROUND, (event) =>
        heard.push(event),
      );
      late.made.holdStarts = true;
      late.made.raw(LOG_LINE);
      await settle();
      going.stop();
      late.made.letStartsGo();
      await settle();
      expect(heard).toEqual([]);
      expect(late.made.requests.at(-1)).toMatchObject({
        op: "call_stop",
        call: going.id,
      });
      first.stop();
      second.stop();
      third.stop();
    });
  });

  test("stopped on purpose, its calls end", async () => {
    const { spawn } = helpers(() => true);
    const helper = new VoiceHelper(() => CONFIG, spawn);
    const events: CallEvent[] = [];
    const handle = await helper.startCall(BACKGROUND, (event) =>
      events.push(event),
    );
    helper.stop();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(events).toEqual([
      {
        event: "call_ended",
        call: handle.id,
        error: "The voice helper stopped",
      },
    ]);
  });

  test("with progress, a sentence may go 15 s without any, 45 s while a model loads", async () => {
    jest.useFakeTimers();
    try {
      const { made, spawn } = helpers(() => false);
      const helper = new VoiceHelper(() => QWEN_AND_KOKORO, spawn);
      helper.sampleHangs = false;
      const said = helper.speak("Hello").catch(() => {});
      await flush();
      made.say({ event: "speak_progress", stage: "ready" });
      made.say({ event: "speak_progress", id: 1, stage: "started" });
      await flush();
      // Audio comes: the watch starts again from it.
      jest.advanceTimersByTime(SPEAK_STUCK_MS - 1000);
      made.say({ event: "speak_progress", id: 1, stage: "audio" });
      await flush();
      jest.advanceTimersByTime(SPEAK_STUCK_MS - 1000);
      expect(made.killed).toBe(0);
      // A voice loading: longer.
      made.say({ event: "speak_progress", id: 1, stage: "loading" });
      await flush();
      jest.advanceTimersByTime(SPEAK_COLD_MS - 1000);
      expect(made.killed).toBe(0);
      made.say({ event: "speak_progress", id: 1, stage: "audio" });
      await flush();
      jest.advanceTimersByTime(SPEAK_STUCK_MS);
      await flush();
      expect(made.killed).toBe(1);
      helper.stop();
      await said;
    } finally {
      jest.useRealTimers();
    }
  });
});
