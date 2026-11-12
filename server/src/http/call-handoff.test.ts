import { describe, expect, jest, test } from "bun:test";
import {
  encodeFrame,
  FRAME_JSON,
  type Frame,
  FrameReader,
  type VoiceConfig,
  VoiceHelper,
  type VoiceHelperProcess,
} from "../voice/voice-helper";
import {
  CALL_HANDOFF_PATH,
  createCallHandoffRedeem,
  HANDOFF_MAX_FAILURES,
} from "./call-handoff";
import {
  createVoiceSocket,
  DETACHED_MS,
  HANDOFF_MS,
  type SignallingSocket,
  type UpstreamSocket,
} from "./voice-socket";

const CONFIG: VoiceConfig = {
  helper: "/bin/roamgate-voice",
  whisper_model: "whisper.bin",
  kokoro_model: "kokoro.onnx",
  kokoro_voices: "voices.bin",
};

const json = (message: object) =>
  encodeFrame(FRAME_JSON, new TextEncoder().encode(JSON.stringify(message)));

/** A helper that makes WebRTC calls and listens to any microphone. */
function fakeHelper() {
  const requests: Record<string, unknown>[] = [];
  let push: (bytes: Uint8Array) => void = () => {};
  const answer = (request: Record<string, unknown>): object[] =>
    request.op === "call_start"
      ? [
          {
            id: request.id,
            ok: true,
            rate: 48000,
            channels: 2,
            music: false,
            signalling_port: 41234,
          },
        ]
      : request.op === "call_microphone"
        ? [{ id: request.id, ok: true }]
        : [];
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

async function settle() {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    ws: { send: (message: string) => sent.push(JSON.parse(message)) },
  };
}

function fakeUpstream(): (url: string) => UpstreamSocket {
  return () => ({
    readyState: 0,
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  });
}

function fakeSignalling() {
  const closed: { code?: number; reason?: string }[] = [];
  const ws: SignallingSocket = {
    send: () => {},
    close: (code?: number, reason?: string) => closed.push({ code, reason }),
  };
  return { ws, closed };
}

/** A call started by a page, and the app's way in. */
async function started() {
  const fake = fakeHelper();
  const helper = new VoiceHelper(() => CONFIG, fake.spawn);
  const socket = createVoiceSocket(
    helper,
    () => null,
    () => undefined,
    () => null,
    () => null,
    fakeUpstream(),
  );
  const page = fakeSocket();
  socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
  await settle();
  const token = String(page.sent[0]!.resume);
  const handoff = () => {
    socket.message(page.ws, JSON.stringify({ op: "call_handoff", call: 1 }));
    return String(page.sent.at(-1)!.handoff);
  };
  /** The app redeems a handoff and carries `legs` on its own socket. */
  const carry = (legs: string[] = ["microphone"]) => {
    const taken = socket.redeemHandoff(handoff())!;
    const app = fakeSocket();
    socket.message(
      app.ws,
      JSON.stringify({
        op: "call_carry",
        call: taken.call,
        carrier: taken.carrier,
        legs,
      }),
    );
    return { app, carrier: taken.carrier };
  };
  return { fake, socket, page, token, handoff, carry };
}

describe("a call handed to the Android app", () => {
  test("only the owning page gets a handoff token, single use", async () => {
    const { socket, page, handoff } = await started();
    const other = fakeSocket();
    socket.message(other.ws, JSON.stringify({ op: "call_handoff", call: 1 }));
    expect(other.sent).toEqual([
      { event: "call_handoff", call: 1, error: "No such call" },
    ]);
    const token = handoff();
    expect(page.sent.at(-1)).toEqual({
      event: "call_handoff",
      call: 1,
      handoff: token,
      expires_ms: HANDOFF_MS,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const taken = socket.redeemHandoff(token);
    expect(taken).toEqual({ call: 1, carrier: expect.any(String) });
    expect(socket.redeemHandoff(token)).toBeNull();
    expect(socket.redeemHandoff("guess")).toBeNull();
    expect(socket.redeemHandoff(undefined)).toBeNull();
  });

  test("a handoff expires, and a newer one replaces it", async () => {
    jest.useFakeTimers();
    try {
      const { socket, handoff } = await started();
      const first = handoff();
      const second = handoff();
      expect(socket.redeemHandoff(first)).toBeNull();
      jest.advanceTimersByTime(HANDOFF_MS + 1);
      expect(socket.redeemHandoff(second)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a call's end voids its handoff", async () => {
    const { socket, page, handoff } = await started();
    const token = handoff();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: false }));
    expect(socket.redeemHandoff(token)).toBeNull();
  });

  test("the app carries the legs it says, and the page is told", async () => {
    const { socket, page, carry } = await started();
    const { app } = carry(["microphone", "bogus"]);
    expect(app.sent).toEqual([
      {
        event: "call_carry",
        call: 1,
        ok: true,
        legs: ["microphone"],
        restarts: 0,
        waiting: false,
      },
    ]);
    expect(page.sent.at(-1)).toEqual({
      event: "call_carrier",
      call: 1,
      state: "joined",
      legs: ["microphone"],
      heard: false,
    });
    // A wrong carrier token carries nothing.
    const intruder = fakeSocket();
    socket.message(
      intruder.ws,
      JSON.stringify({ op: "call_carry", call: 1, carrier: "guess" }),
    );
    expect(intruder.sent).toEqual([
      { event: "call_carry", call: 1, error: "No such call" },
    ]);
  });

  test("the app's microphone is listened to, the page's no longer", async () => {
    const { fake, socket, page, carry } = await started();
    const { app } = carry();
    socket.message(
      app.ws,
      JSON.stringify({ op: "call_microphone", peer: "app-peer", echo: "here" }),
    );
    await settle();
    expect(app.sent.at(-1)).toEqual({
      event: "call_microphone",
      call: 1,
      ok: true,
    });
    expect(page.sent.at(-1)).toMatchObject({
      event: "call_carrier",
      state: "joined",
      heard: true,
    });
    socket.message(
      page.ws,
      JSON.stringify({ op: "call_microphone", peer: "page-peer" }),
    );
    await settle();
    expect(page.sent.at(-1)).toEqual({
      event: "call_microphone",
      call: 1,
      error: "The Roamgate app carries the microphone",
    });
    expect(
      fake.requests
        .filter((request) => request.op === "call_microphone")
        .map((request) => request.peer),
    ).toEqual(["app-peer"]);
  });

  test("the carrier token opens the call's signalling; its leaving closes it", async () => {
    const { socket, page, token, carry } = await started();
    const { app, carrier } = carry();
    expect(socket.ownsCall(1, carrier)).toBe(true);
    const appSignalling = fakeSignalling();
    const pageSignalling = fakeSignalling();
    socket.openSignalling(appSignalling.ws, 1, carrier);
    socket.openSignalling(pageSignalling.ws, 1, token);
    socket.message(app.ws, JSON.stringify({ op: "call_carry_end" }));
    expect(appSignalling.closed).toEqual([
      { code: 4000, reason: "The Roamgate app gave the call back" },
    ]);
    expect(pageSignalling.closed).toEqual([]);
    expect(page.sent.at(-1)).toEqual({
      event: "call_carrier",
      call: 1,
      state: "left",
      why: "The Roamgate app gave the call back",
    });
    expect(socket.ownsCall(1, carrier)).toBe(false);
    expect(socket.ownsCall(1, token)).toBe(true);
  });

  test("the app hanging up ends the call for the page", async () => {
    let ended = 0;
    const fake = fakeHelper();
    const helper = new VoiceHelper(() => CONFIG, fake.spawn);
    const socket = createVoiceSocket(
      helper,
      () => null,
      () => undefined,
      () => null,
      () => null,
      fakeUpstream(),
      () => {
        ended += 1;
      },
    );
    const page = fakeSocket();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: true }));
    await settle();
    socket.message(page.ws, JSON.stringify({ op: "call_handoff", call: 1 }));
    const taken = socket.redeemHandoff(page.sent.at(-1)!.handoff)!;
    const app = fakeSocket();
    socket.message(
      app.ws,
      JSON.stringify({ op: "call_carry", call: 1, carrier: taken.carrier }),
    );
    socket.message(
      app.ws,
      JSON.stringify({ op: "call_audio", on: false, call: 1 }),
    );
    expect(page.sent.at(-1)).toEqual({
      event: "call_audio",
      call: 1,
      error: "Hung up in the Roamgate app",
    });
    expect(ended).toBe(1);
    expect(socket.currentCall()).toBeNull();
  });

  test("the page hanging up tells the app", async () => {
    const { socket, page, carry } = await started();
    const { app } = carry();
    socket.message(page.ws, JSON.stringify({ op: "call_audio", on: false }));
    expect(app.sent.at(-1)).toEqual({
      event: "call_audio",
      call: 1,
      error: "The call ended",
    });
  });

  test("outputs: the app's go to the page, the page's choice to the app", async () => {
    const { socket, page, carry } = await started();
    const { app } = carry(["microphone", "replies"]);
    socket.message(
      app.ws,
      JSON.stringify({
        op: "call_output_state",
        current: "speaker",
        outputs: [
          { id: "speaker", kind: "speaker", label: "Loudspeaker" },
          { id: "bt:AA", kind: "bluetooth", label: "Car" },
          { id: "x", kind: "teleport", label: "Nope" },
        ],
      }),
    );
    expect(page.sent.at(-1)).toEqual({
      event: "call_output_state",
      call: 1,
      current: "speaker",
      outputs: [
        { id: "speaker", kind: "speaker", label: "Loudspeaker" },
        { id: "bt:AA", kind: "bluetooth", label: "Car" },
      ],
    });
    socket.message(
      page.ws,
      JSON.stringify({ op: "call_output", call: 1, output: "bt:AA" }),
    );
    expect(app.sent.at(-1)).toEqual({
      event: "call_output",
      call: 1,
      output: "bt:AA",
    });
    // A page's new socket learns who carries the call.
    socket.close(page.ws);
    const again = fakeSocket();
    socket.message(
      again.ws,
      JSON.stringify({
        op: "call_resume",
        call: 1,
        resume: page.sent[0]!.resume,
      }),
    );
    expect(again.sent.map((each) => each.event)).toEqual([
      "call_audio",
      "call_carrier",
      "call_output_state",
    ]);
  });

  test("restarts and music reach the app too", async () => {
    const { fake, page, carry } = await started();
    const { app } = carry();
    fake.push(json({ event: "call_restarted", call: 1 }));
    fake.push(json({ event: "call_music", call: 1, waiting: true }));
    await settle();
    for (const sent of [page.sent, app.sent])
      expect(sent.slice(-2)).toEqual([
        { event: "call_restarted", call: 1, restarts: 1 },
        { event: "call_music", call: 1, waiting: true },
      ]);
  });

  test("an app that never joins, or whose socket goes, gives the call back", async () => {
    jest.useFakeTimers();
    try {
      const { socket, page, handoff, carry } = await started();
      const unused = socket.redeemHandoff(handoff())!;
      jest.advanceTimersByTime(DETACHED_MS + 1);
      expect(socket.ownsCall(1, unused.carrier)).toBe(false);
      const { app, carrier } = carry();
      socket.close(app.ws);
      jest.advanceTimersByTime(DETACHED_MS - 1);
      // Back within DETACHED_MS on a new socket: still carried.
      const back = fakeSocket();
      socket.message(
        back.ws,
        JSON.stringify({ op: "call_carry", call: 1, carrier }),
      );
      expect(back.sent[0]).toMatchObject({ event: "call_carry", ok: true });
      socket.close(back.ws);
      jest.advanceTimersByTime(DETACHED_MS + 1);
      expect(page.sent.at(-1)).toEqual({
        event: "call_carrier",
        call: 1,
        state: "left",
        why: "The Roamgate app's link went",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a newer app's handoff drops the one before", async () => {
    const { socket, carry } = await started();
    const first = carry();
    const second = carry();
    expect(first.app.sent.at(-1)).toEqual({
      event: "call_audio",
      call: 1,
      error: "The call went to another app",
    });
    expect(socket.ownsCall(1, first.carrier)).toBe(false);
    expect(socket.ownsCall(1, second.carrier)).toBe(true);
  });
});

describe("the handoff's redeem route", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://example.test${CALL_HANDOFF_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  test("exchanges a valid token for the call and a login, once", async () => {
    const valid = new Set(["good"]);
    const redeem = createCallHandoffRedeem({
      redeem: (token) =>
        typeof token === "string" && valid.delete(token)
          ? { call: 3, carrier: "carrier-token" }
          : null,
      sessionCookie: () => "herdr_auth=signed; HttpOnly",
    });
    const ok = await redeem(post({ handoff: "good" }), "1.2.3.4");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ call: 3, carrier: "carrier-token" });
    expect(ok.headers.get("set-cookie")).toBe("herdr_auth=signed; HttpOnly");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const again = await redeem(post({ handoff: "good" }), "1.2.3.4");
    expect(again.status).toBe(410);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  test("refuses other methods, other sites, and too many failures", async () => {
    let now = 0;
    const redeem = createCallHandoffRedeem({
      redeem: () => null,
      sessionCookie: () => "herdr_auth=x",
      now: () => now,
    });
    const get = new Request(`https://example.test${CALL_HANDOFF_PATH}`);
    expect((await redeem(get, "ip")).status).toBe(405);
    expect(
      (
        await redeem(
          post({ handoff: "x" }, { "sec-fetch-site": "cross-site" }),
          "ip",
        )
      ).status,
    ).toBe(403);
    for (let i = 0; i < HANDOFF_MAX_FAILURES; i += 1)
      expect((await redeem(post({ handoff: "x" }), "ip")).status).toBe(410);
    expect((await redeem(post({ handoff: "x" }), "ip")).status).toBe(429);
    expect((await redeem(post({ handoff: "x" }), "other")).status).toBe(410);
    now += 10 * 60_000 + 1;
    expect((await redeem(post({ handoff: "x" }), "ip")).status).toBe(410);
  });
});
