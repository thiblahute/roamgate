import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import {
  fetchSpeech,
  parkVoiceLink,
  takeParkedVoiceLink,
  VoiceLink,
} from "./voiceChat";
import { holdVoiceContext } from "./voiceOutput";
import {
  activeCall,
  RELEASE_MS,
  type CallOptions,
  type SignallingConfig,
} from "./webrtcCall";

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

/** The voice socket, as the server would answer it. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: unknown[] = [];
  /** Audio sent on the socket, in bytes. */
  audio = 0;
  closed = false;
  constructor() {
    FakeWebSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }
  send(data: unknown) {
    if (typeof data === "string") this.sent.push(JSON.parse(data));
    else this.audio += (data as Uint8Array).byteLength;
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  tell(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

const saved: Record<string, unknown> = {};
const globals = globalThis as Record<string, unknown>;
beforeAll(() => {
  for (const name of [
    "WebSocket",
    "AudioContext",
    "AudioWorkletNode",
    "requestAnimationFrame",
    "location",
    "navigator",
    "MediaStream",
  ])
    saved[name] = globals[name];
  globals.WebSocket = FakeWebSocket;
  globals.location = { href: "http://roamgate.test/" };
  globals.requestAnimationFrame = () => 0;
  globals.navigator = {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    },
  };
  globals.AudioContext = class {
    sampleRate = 16_000;
    state = "running";
    onstatechange = null;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = async () => {};
    createGain() {
      return {
        gain: { value: 1 },
        connect: (next: unknown) => next,
        disconnect() {},
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
  };
  globals.MediaStream = class {
    constructor(readonly tracks: unknown[]) {}
    getAudioTracks() {
      return this.tracks;
    }
    getTracks() {
      return this.tracks;
    }
    removeTrack(track: unknown) {
      this.tracks.splice(this.tracks.indexOf(track), 1);
    }
  };
  globals.AudioWorkletNode = class {
    static last: { port: { onmessage: ((e: unknown) => void) | null } };
    port = { onmessage: null };
    constructor() {
      (globals.AudioWorkletNode as { last: unknown }).last = this;
    }
    connect(next: unknown) {
      return next;
    }
    disconnect() {}
  };
});
afterAll(() => {
  // A call let go by its link waits for another: none comes, it ends now
  // rather than in the next file.
  activeCall()?.stop();
  for (const [name, value] of Object.entries(saved)) globals[name] = value;
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

async function listening() {
  const link = await VoiceLink.open();
  const socket = FakeWebSocket.last!;
  const heard: string[] = [];
  const owner = new AbortController();
  const result = link.listen(owner.signal, { onHeard: (t) => heard.push(t) });
  await settle();
  socket.tell({ event: "listening", session: 7, resume: "token" });
  socket.tell({ event: "speech_start", session: 7 });
  socket.tell({ event: "partial", session: 7, text: "I was saying" });
  return { link, socket, heard, owner, result };
}

describe("a listening kept over a rebuild of the chat", () => {
  test("goes on for the chat built next: nothing heard is lost", async () => {
    const { link, socket, owner, result } = await listening();
    expect(parkVoiceLink("local/w2:p2", link)).toBe(true);
    // The old chat's wait ends, and its abort stops nothing.
    expect(await result).toBeNull();
    owner.abort();
    link.close();
    expect(socket.closed).toBe(false);
    expect(socket.sent).not.toContainEqual({ op: "stop" });

    expect(takeParkedVoiceLink("local/other")).toBeNull();
    const kept = takeParkedVoiceLink("local/w2:p2");
    expect(kept).toBe(link);
    const heard: string[] = [];
    const adopted = kept!.adopt(new AbortController().signal, {
      onHeard: (t) => heard.push(t),
    });
    // What was heard meanwhile shows at once.
    expect(heard).toEqual(["I was saying"]);
    socket.tell({
      event: "partial",
      session: 7,
      text: "I was saying the conversation",
    });
    socket.tell({
      event: "final",
      session: 7,
      text: "I was saying the conversation was good.",
      speech_ms: 4000,
    });
    expect(await adopted).toEqual({
      text: "I was saying the conversation was good.",
      speechMs: 4000,
    });
    expect(last(heard)).toBe("I was saying the conversation");
    expect(socket.sent).not.toContainEqual({ op: "stop" });
    kept!.close();
  });

  test("not taken, it is stopped", async () => {
    jest.useFakeTimers();
    try {
      const { link, socket, result } = await listening();
      parkVoiceLink("local/w2:p2", link);
      expect(await result).toBeNull();
      jest.advanceTimersByTime(10_000);
      expect(socket.sent).toContainEqual({ op: "stop" });
      expect(socket.closed).toBe(true);
      expect(takeParkedVoiceLink("local/w2:p2")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("with no listening, there is nothing to keep", async () => {
    const link = await VoiceLink.open();
    expect(parkVoiceLink("local/w2:p2", link)).toBe(false);
    link.close();
    expect(FakeWebSocket.last!.closed).toBe(true);
  });
});

describe("a listening whose helper stopped", () => {
  test("ends with what was heard, and the link goes on", async () => {
    const { link, socket, result } = await listening();
    // Another listening's error is not this one's.
    socket.tell({ event: "error", session: 6, error: "Gone" });
    socket.tell({
      event: "error",
      session: 7,
      error: "The voice helper stopped",
      recoverable: true,
    });
    expect(await result).toEqual({ text: "I was saying", speechMs: 0 });
    expect(socket.closed).toBe(false);
    // It listens again on the same link.
    const next = link.listen(new AbortController().signal);
    await settle();
    expect(last(socket.sent)).toMatchObject({ op: "listen" });
    socket.tell({ event: "listening", session: 8 });
    socket.tell({ event: "final", session: 8, text: "Again.", speech_ms: 500 });
    expect(await next).toEqual({ text: "Again.", speechMs: 500 });
    // Nothing heard: nothing said.
    const quiet = link.listen(new AbortController().signal);
    await settle();
    socket.tell({ event: "listening", session: 9 });
    socket.tell({ event: "error", session: 9, recoverable: true });
    expect(await quiet).toBeNull();
    // The channel's own failure fails it.
    const failing = link.listen(new AbortController().signal);
    await settle();
    socket.tell({ event: "listening", session: 10 });
    socket.tell({ event: "error", error: "The voice helper is not set up" });
    await expect(failing).rejects.toThrow("The voice helper is not set up");
    link.close();
  });
});

/**
 * A link whose call carries the microphone (call 7): the socket, the
 * microphone leg's connection, and the trace.
 */
async function linkInCall(
  lines: string[] = [],
  extra: Partial<CallOptions> = {},
  early: (link: VoiceLink) => void = () => {},
) {
  const held = new AbortController();
  holdVoiceContext(held.signal, () => {});
  const connection = Object.assign(new EventTarget(), {
    iceConnectionState: "connected",
    getStats: async () => new Map(),
  });
  const published = { enabled: true, stop() {} };
  const track = { enabled: true, clone: () => published, stop() {} };
  const listeners: {
    connected?: (id: string) => void;
    producer?: EventTarget & { state: number };
  } = {};
  const call: CallOptions = {
    trace: (line) => lines.push(line),
    api: async () => ({
      registerConnectionListener: (listener) => {
        listeners.connected = listener.connected;
        return true;
      },
      registerPeerListener: () => true,
      createProducerSession: () => {
        const producer = Object.assign(new EventTarget(), {
          state: 0,
          start: () => true,
          close() {},
        });
        listeners.producer = producer;
        return producer;
      },
      createConsumerSession: () => null,
      getAvailableProducers: () => [],
    }),
    microphone: async () =>
      new (globals.MediaStream as typeof MediaStream)([
        track as unknown as MediaStreamTrack,
      ]),
    player: () =>
      ({ play: async () => {}, pause() {} }) as unknown as HTMLAudioElement,
    ...extra,
  };
  const link = await VoiceLink.open({ call });
  const socket = FakeWebSocket.last!;
  early(link);
  await settle();
  socket.tell({
    event: "call_audio",
    call: 7,
    resume: "secret",
    music: false,
    webrtc: true,
  });
  await settle();
  listeners.connected!("page-peer");
  // The page's microphone, when it opens one (not in the app's WebView).
  const producer = listeners.producer;
  if (producer) {
    producer.state = 2;
    producer.dispatchEvent(new Event("stateChanged"));
    producer.dispatchEvent(
      new CustomEvent("clientConsumerAdded", {
        detail: Object.assign(new EventTarget(), {
          rtcPeerConnection: connection,
          close() {},
        }),
      }),
    );
    socket.tell({ event: "call_microphone", call: 7, ok: true });
  }
  return { link, socket, held };
}

describe("a link's call", () => {
  test("a listening whose call microphone stalls ends once its leg is down", async () => {
    activeCall()?.stop();
    const lines: string[] = [];
    const { link, socket, held } = await linkInCall(lines);
    const result = link.listen(new AbortController().signal);
    await settle();
    expect(last(socket.sent)).toMatchObject({ op: "listen", call: 7 });
    socket.tell({ event: "listening", session: 3 });
    // Its leg still up: it may come back, nothing is ended.
    socket.tell({ event: "stalled", session: 3 });
    expect(last(socket.sent)).toMatchObject({ op: "listen" });
    expect(lines).toContain(
      "call 7: the microphone stopped coming: waiting for it",
    );
    // Its leg gone: the utterance ends with what was heard.
    socket.tell({ event: "call_microphone", call: 7, error: "no peer" });
    socket.tell({ event: "stalled", session: 3 });
    expect(last(socket.sent)).toEqual({ op: "finish" });
    socket.tell({ event: "final", session: 3, text: "Hi", speech_ms: 400 });
    expect(await result).toEqual({ text: "Hi", speechMs: 400 });
    activeCall()?.stop();
    link.close();
    held.abort();
  });

  test("a listening opens no capture of its own while the app carries the microphone", async () => {
    activeCall()?.stop();
    const { link, socket, held } = await linkInCall();
    const navigator = globals.navigator;
    let captures = 0;
    globals.navigator = {
      mediaDevices: {
        getUserMedia: async () => {
          captures += 1;
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    };
    try {
      socket.tell({
        event: "call_carrier",
        call: 7,
        state: "joined",
        legs: ["microphone", "replies"],
        heard: true,
      });
      await settle();
      let replying = true;
      for (const words of ["Hi", "Again"]) {
        const result = link.listen(new AbortController().signal, {
          holding: () => replying,
        });
        await settle();
        expect(last(socket.sent)).toMatchObject({
          op: "listen",
          call: 7,
          hold: true,
        });
        socket.tell({ event: "listening", session: 3 });
        // The hold lets go with no audio coming here to notice it.
        replying = false;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(last(socket.sent)).toEqual({ op: "release" });
        replying = true;
        socket.tell({
          event: "final",
          session: 3,
          text: words,
          speech_ms: 400,
        });
        expect(await result).toEqual({ text: words, speechMs: 400 });
      }
      // No second recorder started and stopped on the phone at each turn.
      expect(captures).toBe(0);
      expect(socket.audio).toBe(0);
    } finally {
      globals.navigator = navigator;
      activeCall()?.stop();
      link.close();
      held.abort();
    }
  });

  test("in the app's WebView, a listening as the call starts waits for it and opens no capture", async () => {
    activeCall()?.stop();
    const navigator = globals.navigator;
    let captures = 0;
    globals.navigator = {
      mediaDevices: {
        getUserMedia: async () => {
          captures += 1;
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    };
    const lines: string[] = [];
    let opened = 0;
    let result: Promise<unknown> | null = null;
    const app = {
      known: () => true,
      embedded: () => true,
      open() {},
      handOff() {},
      took() {},
      missed: () => false,
    };
    try {
      const { link, socket, held } = await linkInCall(
        lines,
        {
          app,
          microphone: async () => {
            opened += 1;
            return new (globals.MediaStream as typeof MediaStream)([]);
          },
        },
        (link) => {
          result = link.listen(new AbortController().signal);
        },
      );
      await settle();
      const listen = socket.sent.find(
        (each) => (each as { op?: string }).op === "listen",
      );
      expect(listen).toMatchObject({ op: "listen", call: 7 });
      expect(lines).toContain(
        "call 7: in the Roamgate app: the app's microphone is the call's, none opened here",
      );
      socket.tell({ event: "listening", session: 3 });
      socket.tell({ event: "final", session: 3, text: "Hi", speech_ms: 400 });
      expect(await result).toEqual({ text: "Hi", speechMs: 400 });
      expect(captures).toBe(0);
      expect(opened).toBe(0);
      expect(socket.audio).toBe(0);
      activeCall()?.stop();
      link.close();
      held.abort();
    } finally {
      globals.navigator = navigator;
      activeCall()?.stop();
    }
  });

  test("closing a link with a call that nobody adopts ends the call on the server", async () => {
    activeCall()?.stop();
    jest.useFakeTimers();
    try {
      const { link, socket, held } = await linkInCall();
      link.close();
      await settle();
      // Kept open for a rebuilt chat's link to take the call.
      expect(socket.closed).toBe(false);
      jest.advanceTimersByTime(RELEASE_MS);
      await settle();
      // Nobody did: its end reaches the server, then the socket closes.
      expect(last(socket.sent)).toEqual({
        op: "call_audio",
        on: false,
        call: 7,
      });
      expect(socket.closed).toBe(true);
      expect(activeCall()).toBeNull();
      held.abort();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a voice chat in a WebRTC call", () => {
  test("listens to the call's microphone: nothing goes on the socket", async () => {
    const held = new AbortController();
    holdVoiceContext(held.signal, () => {});
    const connection = Object.assign(new EventTarget(), {
      iceConnectionState: "connected",
      getStats: async () => new Map(),
    });
    const track = {
      enabled: true,
      clone: () => published,
      stop() {},
    };
    const published = { enabled: true, stop() {} };
    let configured: SignallingConfig | null = null;
    const listeners: {
      connected?: (id: string) => void;
      producer?: EventTarget & { state: number };
    } = {};
    const link = await VoiceLink.open({
      call: {
        api: async (config) => {
          configured = config;
          return {
            registerConnectionListener: (listener) => {
              listeners.connected = listener.connected;
              return true;
            },
            registerPeerListener: () => true,
            createProducerSession: () => {
              const producer = Object.assign(new EventTarget(), {
                state: 0,
                start: () => true,
                close() {},
              });
              listeners.producer = producer;
              return producer;
            },
            createConsumerSession: () => null,
            getAvailableProducers: () => [],
          };
        },
        microphone: async () =>
          new (globals.MediaStream as typeof MediaStream)([
            track as unknown as MediaStreamTrack,
          ]),
        player: () =>
          ({ play: async () => {}, pause() {} }) as unknown as HTMLAudioElement,
      },
    });
    const socket = FakeWebSocket.last!;
    await settle();
    expect(socket.sent).toContainEqual({ op: "call_audio", on: true });
    socket.tell({
      event: "call_audio",
      call: 7,
      resume: "secret",
      music: false,
      webrtc: true,
    });
    await settle();
    expect(configured!.meta).toEqual({ call: 7, role: "microphone" });
    listeners.connected!("page-peer");
    listeners.producer!.state = 2;
    listeners.producer!.dispatchEvent(new Event("stateChanged"));
    expect(socket.sent).toContainEqual({
      op: "call_microphone",
      peer: "page-peer",
      echo: "page",
    });
    listeners.producer!.dispatchEvent(
      new CustomEvent("clientConsumerAdded", {
        detail: Object.assign(new EventTarget(), {
          rtcPeerConnection: connection,
          close() {},
        }),
      }),
    );
    socket.tell({ event: "call_microphone", call: 7, ok: true });
    // Silent until it listens.
    expect(published.enabled).toBe(false);
    const result = link.listen(new AbortController().signal);
    await settle();
    expect(last(socket.sent)).toMatchObject({ op: "listen", call: 7 });
    expect(published.enabled).toBe(true);
    // The level is shown, and no audio goes on the socket.
    const tap = (
      globals.AudioWorkletNode as unknown as {
        last: { port: { onmessage: (e: unknown) => void } };
      }
    ).last;
    tap.port.onmessage({ data: new Float32Array(4096).fill(0.1) });
    expect(socket.audio).toBe(0);
    socket.tell({ event: "listening", session: 3 });
    socket.tell({ event: "speech_start", session: 3 });
    socket.tell({ event: "final", session: 3, text: "Hello", speech_ms: 900 });
    expect(await result).toEqual({ text: "Hello", speechMs: 900 });
    // Done listening: silent again, the microphone still open.
    expect(published.enabled).toBe(false);
    link.close();
    held.abort();
  });

  test("a listening while the call is being made goes on the socket at once", async () => {
    activeCall()?.stop();
    const held = new AbortController();
    holdVoiceContext(held.signal, () => {});
    const link = await VoiceLink.open({
      call: {
        api: async () => ({
          registerConnectionListener: () => true,
          registerPeerListener: () => true,
          createProducerSession: () => null,
          createConsumerSession: () => null,
          getAvailableProducers: () => [],
        }),
        microphone: async () =>
          new (globals.MediaStream as typeof MediaStream)([]),
        player: () =>
          ({ play: async () => {}, pause() {} }) as unknown as HTMLAudioElement,
      },
    });
    const socket = FakeWebSocket.last!;
    await settle();
    expect(socket.sent).toContainEqual({ op: "call_audio", on: true });
    // No answer yet (it once took 3.4 s): the user may be talking already.
    const result = link.listen(new AbortController().signal);
    for (let round = 0; round < 5; round += 1) await settle();
    expect(last(socket.sent)).toMatchObject({ op: "listen" });
    expect(last(socket.sent)).not.toHaveProperty("call");
    const tap = (
      globals.AudioWorkletNode as unknown as {
        last: { port: { onmessage: (e: unknown) => void } };
      }
    ).last;
    tap.port.onmessage({ data: new Float32Array(4096).fill(0.1) });
    expect(socket.audio).toBeGreaterThan(0);
    socket.tell({ event: "listening", session: 4 });
    socket.tell({ event: "final", session: 4, text: "", speech_ms: 0 });
    expect(await result).toBeNull();
    link.close();
    held.abort();
  });

  test("a call that carries neither leg says so: listening streams on the socket and replies play here", async () => {
    // The call before, let go by its link, is not taken up by this one.
    activeCall()?.stop();
    const held = new AbortController();
    holdVoiceContext(held.signal, () => {});
    const lines: string[] = [];
    const track = {
      enabled: true,
      stopped: false,
      clone: () => track,
      stop() {
        this.stopped = true;
      },
    };
    let opened = 0;
    const mediaDevices = (globals.navigator as { mediaDevices: object })
      .mediaDevices as { getUserMedia: () => Promise<unknown> };
    const savedOpen = mediaDevices.getUserMedia;
    mediaDevices.getUserMedia = async () => {
      opened += 1;
      return { getTracks: () => [{ stop() {} }] };
    };
    const link = await VoiceLink.open({
      call: {
        trace: (line) => lines.push(line),
        // Its signalling never answers: no leg ever connects.
        api: async () => ({
          registerConnectionListener: () => true,
          registerPeerListener: () => true,
          createProducerSession: () => null,
          createConsumerSession: () => null,
          getAvailableProducers: () => [],
        }),
        microphone: async () =>
          new (globals.MediaStream as typeof MediaStream)([
            track as unknown as MediaStreamTrack,
          ]),
        player: () =>
          ({ play: async () => {}, pause() {} }) as unknown as HTMLAudioElement,
      },
    });
    const socket = FakeWebSocket.last!;
    await settle();
    socket.tell({
      event: "call_audio",
      call: 7,
      resume: "secret",
      music: true,
      webrtc: true,
    });
    await settle();
    const result = link.listen(new AbortController().signal);
    // The microphone opens for the socket first: a few more awaits.
    for (let round = 0; round < 5; round += 1) await settle();
    expect(last(socket.sent)).toMatchObject({ op: "listen" });
    expect(last(socket.sent)).not.toHaveProperty("call");
    const tap = (
      globals.AudioWorkletNode as unknown as {
        last: { port: { onmessage: (e: unknown) => void } };
      }
    ).last;
    tap.port.onmessage({ data: new Float32Array(4096).fill(0.1) });
    expect(socket.audio).toBeGreaterThan(0);
    expect(lines).toContain(
      "call 7: listening on the socket: the call carries no microphone",
    );

    const fetched: Record<string, unknown>[] = [];
    const savedFetch = globals.fetch;
    globals.fetch = async (_url: unknown, init?: RequestInit) => {
      fetched.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/ogg" },
      });
    };
    try {
      const speech = await fetchSpeech("Bonjour", new AbortController().signal);
      expect(speech).toBeInstanceOf(Blob);
    } finally {
      globals.fetch = savedFetch;
    }
    expect(fetched[0]).not.toHaveProperty("call");
    expect(lines).toContain(
      "call 7: a reply plays here: the call carries no replies",
    );
    // The call never carried the replies: it never said it did.
    expect(lines.some((line) => line.includes("from the Mac"))).toBe(false);

    socket.tell({ event: "listening", session: 3 });
    socket.tell({ event: "final", session: 3, text: "", speech_ms: 0 });
    expect(await result).toBeNull();
    // The socket's audio came from the call's own microphone, which stays
    // open: no second capture, opened late for each listening.
    expect(opened).toBe(0);
    expect(track.stopped).toBe(false);
    mediaDevices.getUserMedia = savedOpen;
    link.close();
    held.abort();
  });

  test("after its call ends, or while its capture is gone, a listening opens its own capture", async () => {
    activeCall()?.stop();
    const held = new AbortController();
    holdVoiceContext(held.signal, () => {});
    // As a MediaStreamTrack: stopped, it is "ended" for good.
    const fakeTrack = () => {
      const track = {
        enabled: true,
        readyState: "live",
        clone: () => track,
        stop() {
          track.readyState = "ended";
        },
      };
      return track;
    };
    const track = fakeTrack();
    const captures: ReturnType<typeof fakeTrack>[] = [];
    const mediaDevices = (globals.navigator as { mediaDevices: object })
      .mediaDevices as { getUserMedia: () => Promise<unknown> };
    const savedOpen = mediaDevices.getUserMedia;
    mediaDevices.getUserMedia = async () => {
      const capture = fakeTrack();
      captures.push(capture);
      return { getTracks: () => [capture] };
    };
    const link = await VoiceLink.open({
      call: {
        // Its signalling never answers: the socket carries the listening.
        api: async () => ({
          registerConnectionListener: () => true,
          registerPeerListener: () => true,
          createProducerSession: () => null,
          createConsumerSession: () => null,
          getAvailableProducers: () => [],
        }),
        microphone: async () =>
          new (globals.MediaStream as typeof MediaStream)([
            track as unknown as MediaStreamTrack,
          ]),
        player: () =>
          ({ play: async () => {}, pause() {} }) as unknown as HTMLAudioElement,
      },
    });
    const socket = FakeWebSocket.last!;
    await settle();
    socket.tell({
      event: "call_audio",
      call: 7,
      resume: "secret",
      music: false,
      webrtc: true,
    });
    await settle();
    const listenOnce = async (session: number) => {
      const result = link.listen(new AbortController().signal);
      for (let round = 0; round < 5; round += 1) await settle();
      socket.tell({ event: "listening", session });
      socket.tell({ event: "final", session, text: "", speech_ms: 0 });
      return result;
    };
    // The call going on: its own microphone, no capture of its own.
    await listenOnce(3);
    expect(captures).toHaveLength(0);
    // Its capture went (a headset unplugged): the call's track is ended.
    track.readyState = "ended";
    await listenOnce(4);
    expect(captures).toHaveLength(1);
    expect(captures[0]!.readyState).toBe("ended");
    track.readyState = "live";
    // The server ended the call: the call's microphone is stopped.
    socket.tell({ event: "call_audio", call: 7, error: "The call ended" });
    await settle();
    expect(track.readyState).toBe("ended");
    await listenOnce(5);
    expect(captures).toHaveLength(2);
    // Opened for that listening, stopped at its end.
    expect(captures[1]!.readyState).toBe("ended");
    mediaDevices.getUserMedia = savedOpen;
    link.close();
    held.abort();
  });
});
