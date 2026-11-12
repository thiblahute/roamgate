import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import type { ChannelEvent } from "./voiceChannel";
import {
  activeCall,
  activeMicrophoneConstraints,
  BACKOFF_MS,
  type CallChannel,
  callOutputs,
  type CallOptions,
  chooseCallMode,
  type ConsumerSession,
  describeEcho,
  describeFailure,
  describeReplyEcho,
  echoLevels,
  describePath,
  FAST_RETRIES,
  HANDOFF_WAIT_MS,
  jitterMs,
  LATE_MS,
  MICROPHONE_CHECK_MS,
  MICROPHONE_PAUSED,
  MICROPHONE_TRIES,
  microphoneConstraints,
  microphoneEnergy,
  NEVER_OPENED_TRIES,
  nextCallOutput,
  OUTPUT_CLOSE_MS,
  RELEASE_MARGIN_MS,
  REOPEN_MS,
  type ScreenLock,
  type SignallingApi,
  SILENT_MS,
  type SignallingConfig,
  type SignallingPeer,
  START_MS,
  WebRtcCall,
} from "./webrtcCall";

const saved: Record<string, unknown> = {};
const globals = globalThis as Record<string, unknown>;

/** A microphone track: its clones are what gets published. */
class FakeTrack extends EventTarget {
  enabled = true;
  stopped = false;
  muted = false;
  readyState: MediaStreamTrackState = "live";
  kind = "audio";
  clones: FakeTrack[] = [];
  constructor(readonly deviceId = "default") {
    super();
  }
  /** The phone muted, unmuted or ended it (not the page). */
  phone(event: "mute" | "unmute" | "ended") {
    if (event === "ended") this.readyState = "ended";
    else this.muted = event === "mute";
    this.dispatchEvent(new Event(event));
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  clone() {
    const clone = new FakeTrack();
    this.clones.push(clone);
    return clone;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack) {
    this.tracks.splice(this.tracks.indexOf(track), 1);
  }
}

beforeAll(() => {
  for (const name of ["location", "MediaStream"]) saved[name] = globals[name];
  globals.location = { href: "https://mac.example/" };
  globals.MediaStream = FakeStream;
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) globals[name] = value;
});

/** A peer connection whose ICE state the test sets. */
class FakeConnection extends EventTarget {
  iceConnectionState: RTCIceConnectionState = "new";
  /** What the leg sends: the microphone's clone, replaced in place. */
  sent: unknown[] = [];
  getSenders() {
    return [
      {
        track: { kind: "audio" },
        replaceTrack: async (track: unknown) => {
          this.sent.push(track);
        },
      },
    ];
  }
  set(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }
  /** What getStats reports: the microphone's media-source, if set. */
  stats = new Map<string, Record<string, unknown>>();
  async getStats() {
    return this.stats;
  }
  /** The microphone's running energy as sent, as Chrome reports it. */
  captured(energy: number, seconds: number) {
    this.stats.set("source", {
      type: "media-source",
      kind: "audio",
      totalAudioEnergy: energy,
      totalSamplesDuration: seconds,
    });
  }
}

class FakeConsumer extends EventTarget {
  mungeStereoHack = false;
  streams: unknown[] = [];
  connected = false;
  closed = false;
  rtcPeerConnection: FakeConnection | null = null;
  constructor(readonly producer: string) {
    super();
  }
  connect() {
    this.connected = true;
    return true;
  }
  close() {
    this.closed = true;
  }
  /** Its connection comes, then its stream. */
  up() {
    this.rtcPeerConnection = new FakeConnection();
    this.dispatchEvent(new Event("rtcPeerConnectionChanged"));
    this.streams = [{ stream: this.producer }];
    this.dispatchEvent(new Event("streamsChanged"));
  }
}

class FakeProducer extends EventTarget {
  state = 0;
  closed = false;
  constructor(readonly stream: FakeStream) {
    super();
  }
  start() {
    this.state = 1;
    return true;
  }
  /** The signalling registered it. */
  registered() {
    this.state = 2;
    this.dispatchEvent(new Event("stateChanged"));
  }
  sessions: { close(): void }[] = [];
  /** The helper's webrtcsrc started a session: its client connection. */
  client() {
    // Closed, it says so at once, as gstwebrtc-api's sessions do.
    const session = Object.assign(new EventTarget(), {
      rtcPeerConnection: new FakeConnection(),
      closed: false,
      close() {
        if (session.closed) return;
        session.closed = true;
        session.dispatchEvent(new Event("closed"));
      },
      /** The helper ended it. */
      end() {
        session.close();
      },
    });
    this.sessions.push(session);
    this.dispatchEvent(
      new CustomEvent("clientConsumerAdded", { detail: session }),
    );
    return session;
  }
  /**
   * As gstwebrtc-api's ProducerSession.close(): its state, its client
   * sessions and "closed" all go out before it returns.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.state = 3;
    this.dispatchEvent(new Event("stateChanged"));
    for (const session of this.sessions.splice(0)) session.close();
    this.dispatchEvent(new Event("closed"));
  }
}

/** gstwebrtc-api, as the page's call drives it. */
function fakeApis() {
  const made: {
    config: SignallingConfig;
    connection: { connected(id: string): void; disconnected(): void };
    peers: {
      producerAdded?(peer: SignallingPeer): void;
      producerRemoved?(peer: SignallingPeer): void;
    };
    producers: FakeProducer[];
    consumers: FakeConsumer[];
    available: SignallingPeer[];
    /** Times its socket was closed from the page. */
    closed: number;
  }[] = [];
  const api = async (config: SignallingConfig): Promise<SignallingApi> => {
    const entry = {
      config,
      connection: { connected() {}, disconnected() {} },
      peers: {},
      producers: [] as FakeProducer[],
      consumers: [] as FakeConsumer[],
      available: [] as SignallingPeer[],
      closed: 0,
    };
    made.push(entry);
    // Its socket, closed: it says it disconnected, as gstwebrtc-api does.
    const socket = {
      close() {
        entry.closed += 1;
        queueMicrotask(() => entry.connection.disconnected());
      },
    };
    return Object.assign(Object.create({ _channel: socket }), {
      registerConnectionListener(listener: typeof entry.connection) {
        entry.connection = listener;
        return true;
      },
      registerPeerListener(listener: typeof entry.peers) {
        entry.peers = listener;
        return true;
      },
      createProducerSession(stream: MediaStream) {
        const producer = new FakeProducer(stream as unknown as FakeStream);
        entry.producers.push(producer);
        return producer;
      },
      createConsumerSession(id: string) {
        const consumer = new FakeConsumer(id);
        entry.consumers.push(consumer);
        return consumer as unknown as ConsumerSession;
      },
      getAvailableProducers: () => entry.available,
    });
  };
  return { made, api };
}

/** The voice channel: what the page sent, and the server's answers. */
function fakeChannel(answer: (message: Record<string, unknown>) => object[]) {
  const sent: Record<string, unknown>[] = [];
  const held: { call: number; resume: string }[] = [];
  const listeners = new Set<(event: ChannelEvent) => void>();
  const channel: CallChannel = {
    holdCall(call, resume) {
      held.push({ call, resume });
    },
    send(message) {
      sent.push(message as Record<string, unknown>);
      for (const reply of answer(message as Record<string, unknown>))
        queueMicrotask(() => {
          for (const listener of [...listeners])
            listener(reply as ChannelEvent);
        });
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const tell = (event: object) => {
    for (const listener of [...listeners]) listener(event as ChannelEvent);
  };
  return { channel, sent, tell, held };
}

const answering = (message: Record<string, unknown>) =>
  message.op === "call_audio" && message.on === true
    ? [
        {
          event: "call_audio",
          call: 7,
          resume: "secret",
          music: true,
          webrtc: true,
        },
      ]
    : [];

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
/** Fake time goes by, the page's awaits settling as it does. */
const pass = async (ms: number) => {
  for (let gone = 0; gone < ms; gone += 50) {
    jest.advanceTimersByTime(50);
    await settle();
  }
};

/** What the server answers the page's messages, in the fake channel. */
type Answers = (message: Record<string, unknown>) => object[];

async function started(options: CallOptions = {}, answer: Answers = answering) {
  const { made, api } = fakeApis();
  const { channel, sent, tell, held } = fakeChannel(answer);
  const microphone = new FakeTrack();
  const played: unknown[] = [];
  const player = {
    autoplay: false,
    srcObject: null as unknown,
    play: async () => {
      played.push(player.srcObject);
    },
    pause() {},
  };
  const lines: string[] = [];
  const call = (await WebRtcCall.start(channel, {
    api,
    microphone: async () =>
      new FakeStream([microphone]) as unknown as MediaStream,
    player: () => player as unknown as HTMLAudioElement,
    trace: (line) => lines.push(line),
    ...options,
  }))!;
  return { call, made, sent, tell, held, microphone, player, played, lines };
}

describe("a WebRTC call's setup", () => {
  test("signals for its own call only, with call_token and no `token` parameter, and no servers on the web", async () => {
    const { call, made } = await started();
    expect(call.id).toBe(7);
    expect(call.music).toBe(true);
    const { config } = made[0]!;
    const url = new URL(config.signalingServerUrl);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      "wss://mac.example/api/voice/call/signalling",
    );
    expect(url.searchParams.get("call")).toBe("7");
    expect(url.searchParams.get("call_token")).toBe("secret");
    // `token` is the login token's: URL login would take the socket.
    expect(url.searchParams.has("token")).toBe(false);
    expect(config.meta).toEqual({ call: 7, role: "microphone" });
    expect(config.reconnectionTimeout).toBe(0);
    expect(config.webrtcConfig.iceServers).toEqual([]);
    call.stop();
  });

  test("consumes the helper's producer of this call only, and plays it", async () => {
    const { call, made, played, lines } = await started();
    const api = made[0]!;
    api.connection.connected("page-peer");
    api.peers.producerAdded?.({
      id: "other-call",
      meta: { call: 8, role: "replies" },
    });
    api.peers.producerAdded?.({
      id: "another-page",
      meta: { call: 7, role: "microphone" },
    });
    expect(api.consumers).toEqual([]);
    api.peers.producerAdded?.({
      id: "helper",
      meta: { call: 7, role: "replies" },
    });
    expect(api.consumers.map((c) => c.producer)).toEqual(["helper"]);
    const consumer = api.consumers[0]!;
    expect(consumer.mungeStereoHack).toBe(true);
    expect(consumer.connected).toBe(true);
    consumer.up();
    await settle();
    expect(played).toEqual([{ stream: "helper" }]);
    // Heard once its connection is up: sentences go into the mix then.
    expect(call.carriesReplies()).toBe(false);
    const fromTheMac = () => lines.filter((l) => l.includes("from the Mac"));
    expect(fromTheMac()).toEqual([]);
    consumer.rtcPeerConnection!.set("connected");
    expect(call.carriesReplies()).toBe(true);
    expect(fromTheMac()).toEqual([
      "call 7: WebRTC, music and replies from the Mac",
    ]);
    call.stop();
    expect(consumer.closed).toBe(true);
  });

  test("says the music waits for a voice, and not that it plays meanwhile", async () => {
    const { call, made, tell, lines } = await started();
    const api = made[0]!;
    api.connection.connected("page-peer");
    tell({ event: "call_music", call: 8, waiting: true });
    tell({ event: "call_music", call: 7, waiting: true });
    api.peers.producerAdded?.({
      id: "helper",
      meta: { call: 7, role: "replies" },
    });
    const consumer = api.consumers[0]!;
    consumer.up();
    await settle();
    consumer.rtcPeerConnection!.set("connected");
    tell({ event: "call_music", call: 7, waiting: false });
    expect(
      lines.filter((l) => l.includes("music") || l.includes("from the Mac")),
    ).toEqual([
      "call 7: the music waits for a voice",
      "call 7: WebRTC, replies from the Mac",
      "call 7: a voice was taken: the music plays",
    ]);
    call.stop();
  });

  test("music said to wait before the call was set up is not lost", async () => {
    const connect = async (answer: Answers) => {
      const { call, made, lines } = await started({}, answer);
      const api = made[0]!;
      api.connection.connected("page-peer");
      api.peers.producerAdded?.({
        id: "helper",
        meta: { call: 7, role: "replies" },
      });
      const consumer = api.consumers[0]!;
      consumer.up();
      await settle();
      consumer.rtcPeerConnection!.set("connected");
      call.stop();
      return lines.filter(
        (l) => l.includes("music") || l.includes("from the Mac"),
      );
    };
    const waits = [
      "call 7: the music waits for a voice",
      "call 7: WebRTC, replies from the Mac",
    ];
    // The server's answer says it waits.
    expect(
      await connect((m) =>
        answering(m).map((answer) => ({ ...answer, waiting: true })),
      ),
    ).toEqual(waits);
    // The helper said so right after the answer, while the call was being
    // set up (its microphone opening).
    expect(
      await connect((m) =>
        answering(m).flatMap((answer) => [
          answer,
          { event: "call_music", call: 7, waiting: true },
        ]),
      ),
    ).toEqual(waits);
    // Told while its microphone opens.
    const { api } = fakeApis();
    const { channel, tell } = fakeChannel(answering);
    const lines: string[] = [];
    const call = (await WebRtcCall.start(channel, {
      api,
      microphone: async () => {
        tell({ event: "call_music", call: 7, waiting: true });
        return new FakeStream([new FakeTrack()]) as unknown as MediaStream;
      },
      player: () => ({ play: async () => {}, pause() {} }) as never,
      trace: (line) => lines.push(line),
    }))!;
    expect(lines).toContain("call 7: the music waits for a voice");
    call.stop();
    // A voice was taken meanwhile: the answer's waiting is behind it.
    expect(
      await connect((m) =>
        answering(m).flatMap((answer) => [
          { ...answer, waiting: true },
          { event: "call_music", call: 7, waiting: false },
        ]),
      ),
    ).toEqual(["call 7: WebRTC, music and replies from the Mac"]);
  });

  test("publishes a clone of the microphone, and tells its peer id once registered", async () => {
    const { call, made, sent, microphone } = await started();
    const api = made[0]!;
    api.connection.connected("page-peer");
    const producer = api.producers[0]!;
    const published = producer.stream.tracks[0]!;
    expect(published).toBe(microphone.clones[0]!);
    // Nothing leaves the phone until it listens.
    expect(published.enabled).toBe(false);
    expect(sent.some((m) => m.op === "call_microphone")).toBe(false);
    producer.registered();
    expect(sent.slice(-1)[0]).toEqual({
      op: "call_microphone",
      peer: "page-peer",
      echo: "page",
    });
    call.listening(true);
    expect(published.enabled).toBe(true);
    call.listening(false);
    expect(published.enabled).toBe(false);
    call.stop();
    expect(producer.closed).toBe(true);
    expect(published.stopped).toBe(true);
    expect(microphone.stopped).toBe(true);
    expect(sent.slice(-1)[0]).toEqual({ op: "call_audio", on: false, call: 7 });
  });

  test("carries the microphone once the Mac hears it on a connected leg", async () => {
    const { call, made, tell } = await started();
    const api = made[0]!;
    api.connection.connected("page-peer");
    api.producers[0]!.registered();
    const client = api.producers[0]!.client();
    expect(call.carriesMicrophone()).toBe(false);
    tell({ event: "call_microphone", call: 7, ok: true });
    expect(call.carriesMicrophone()).toBe(false);
    client.rtcPeerConnection.set("connected");
    expect(call.carriesMicrophone()).toBe(true);
    call.stop();
    expect(call.carriesMicrophone()).toBe(false);
  });

  test("a leg that keeps failing waits between tries, and a network change tries it at once", async () => {
    jest.useFakeTimers();
    try {
      const changes: (() => void)[] = [];
      const { call, made, sent, lines } = await started({
        networkChanges: (changed) => {
          changes.push(changed);
          return () => {};
        },
      });
      const api = made[0]!;
      api.connection.connected("page-peer");
      api.peers.producerAdded?.({
        id: "helper",
        meta: { call: 7, role: "replies" },
      });
      const fail = (index: number) => {
        api.consumers[index]!.up();
        api.consumers[index]!.rtcPeerConnection!.set("checking");
        api.consumers[index]!.rtcPeerConnection!.set("failed");
      };
      // At once, FAST_RETRIES times.
      for (let index = 0; index < FAST_RETRIES; index += 1) fail(index);
      expect(api.consumers).toHaveLength(FAST_RETRIES + 1);
      // Then it waits.
      fail(FAST_RETRIES);
      expect(api.consumers).toHaveLength(FAST_RETRIES + 1);
      expect(
        lines.some((line) =>
          line.includes(`negotiating it again in ${BACKOFF_MS[0]! / 1000} s`),
        ),
      ).toBe(true);
      jest.advanceTimersByTime(BACKOFF_MS[0]!);
      expect(api.consumers).toHaveLength(FAST_RETRIES + 2);
      // Failing again, it waits longer; a new network does not wait.
      fail(FAST_RETRIES + 1);
      expect(api.consumers).toHaveLength(FAST_RETRIES + 2);
      jest.advanceTimersByTime(BACKOFF_MS[0]!);
      expect(api.consumers).toHaveLength(FAST_RETRIES + 2);
      changes[0]!();
      expect(api.consumers).toHaveLength(FAST_RETRIES + 3);
      // Each failure was told to the server, for its log.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const told = sent.filter((message) => message.op === "call_ice");
      expect(told.length).toBeGreaterThanOrEqual(FAST_RETRIES + 2);
      expect(told[0]).toMatchObject({
        op: "call_ice",
        call: 7,
        line: "replies: ICE failed (1 in a row)",
      });
      // Connected, it starts again from nothing.
      api.consumers[FAST_RETRIES + 2]!.up();
      api.consumers[FAST_RETRIES + 2]!.rtcPeerConnection!.set("connected");
      fail(FAST_RETRIES + 2);
      expect(api.consumers).toHaveLength(FAST_RETRIES + 4);
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a failed ICE leg is negotiated again, each on its own", async () => {
    const { call, made, sent, lines } = await started();
    const api = made[0]!;
    api.connection.connected("page-peer");
    api.peers.producerAdded?.({
      id: "helper",
      meta: { call: 7, role: "replies" },
    });
    api.consumers[0]!.up();
    api.consumers[0]!.rtcPeerConnection!.set("connected");
    api.consumers[0]!.rtcPeerConnection!.set("failed");
    expect(api.consumers[0]!.closed).toBe(true);
    expect(api.consumers.map((c) => c.producer)).toEqual(["helper", "helper"]);
    // The microphone's leg: published again, its id told again.
    api.producers[0]!.registered();
    api.producers[0]!.client().rtcPeerConnection.set("failed");
    expect(api.producers[0]!.closed).toBe(true);
    expect(api.producers).toHaveLength(2);
    api.producers[1]!.registered();
    expect(sent.filter((m) => m.op === "call_microphone")).toHaveLength(2);
    expect(lines.some((line) => line.includes("negotiating it again"))).toBe(
      true,
    );
    call.stop();
  });

  test("a producer the signalling closes is published again, once", async () => {
    jest.useFakeTimers();
    try {
      const { call, made, lines } = await started();
      const api = made[0]!;
      api.connection.connected("page-peer");
      api.producers[0]!.registered();
      api.producers[0]!.close();
      await pass(3000);
      expect(api.producers).toHaveLength(2);
      expect(
        lines.filter((line) =>
          line.includes("producer closed: publishing it again"),
        ),
      ).toHaveLength(1);
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a lost signalling opens again, with both legs", async () => {
    jest.useFakeTimers();
    try {
      const { call, made } = await started();
      made[0]!.connection.connected("page-peer");
      made[0]!.connection.disconnected();
      await pass(400);
      expect(made).toHaveLength(2);
      const again = made[1]!;
      again.available = [
        { id: "helper-2", meta: { call: 7, role: "replies" } },
      ];
      again.connection.connected("page-peer-2");
      expect(again.producers).toHaveLength(1);
      expect(again.consumers.map((c) => c.producer)).toEqual(["helper-2"]);
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a signalling that never opens stops after six tries and says why; one that was up and dropped still retries", async () => {
    jest.useFakeTimers();
    try {
      const notices: string[] = [];
      const { call, made, sent, lines } = await started({
        notice: (text) => notices.push(text),
      });
      // Each socket closes before it opens: the bridge refused it.
      for (let at = 0; at < made.length && at < 20; at += 1) {
        made[at]!.connection.disconnected();
        await pass(3000);
      }
      expect(made).toHaveLength(NEVER_OPENED_TRIES);
      await pass(60_000);
      expect(made).toHaveLength(NEVER_OPENED_TRIES);
      expect(
        lines.some((line) =>
          line.startsWith("call 7: the signalling never opened (6 tries"),
        ),
      ).toBe(true);
      expect(sent.slice(-1)[0]).toEqual({
        op: "call_audio",
        on: false,
        call: 7,
      });
      expect(activeCall()).toBeNull();
      expect(call.carriesReplies()).toBe(false);
      expect(notices).toHaveLength(1);

      // Up once, then lost: tried again for as long as the call lasts.
      const kept = await started();
      kept.made[0]!.connection.connected("page-peer");
      kept.made[0]!.connection.disconnected();
      for (let at = 1; at < 12; at += 1) {
        await pass(3000);
        expect(kept.made).toHaveLength(at + 1);
        kept.made[at]!.connection.disconnected();
      }
      expect(activeCall()).toBe(kept.call);
      expect(
        kept.lines.filter((line) => line.includes("did not open again")),
      ).toHaveLength(11);
      kept.call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("release waits for the reply's real end on the device; stopped, it is hushed", async () => {
    jest.useFakeTimers();
    try {
      // A Bluetooth headset: 250 ms more before it is heard.
      const { call, sent } = await started({ outputLatency: () => 0.25 });
      const speech = {
        queued: true as const,
        call: 7,
        start_ms: 1000,
        duration_ms: 100,
        now_ms: 1000,
      };
      // Its 100 ms, the playout's 120 and the jitter buffer's 40, the
      // output's 250, and the margin.
      const end = 100 + 120 + 40 + 250 + RELEASE_MARGIN_MS;
      const asked = performance.now();
      let done = false;
      void call
        .playQueued(speech, asked, new AbortController().signal)
        .then(() => {
          done = true;
        });
      await pass(end - 100);
      expect(call.over(speech, asked)).toBe(false);
      expect(done).toBe(false);
      await pass(150);
      expect(call.over(speech, asked)).toBe(true);
      expect(done).toBe(true);
      const stop = new AbortController();
      const long = { ...speech, duration_ms: 5000 };
      const playing = call.playQueued(long, performance.now(), stop.signal);
      stop.abort();
      await playing;
      expect(sent.slice(-1)[0]).toEqual({ op: "call_hush" });
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a late call answer is ended; only a call taken is held by the channel", async () => {
    jest.useFakeTimers();
    try {
      const { api } = fakeApis();
      const { channel, sent, tell, held } = fakeChannel(() => []);
      const lines: string[] = [];
      const starting = WebRtcCall.start(channel, {
        api,
        trace: (line) => lines.push(line),
      });
      await pass(START_MS);
      expect(await starting).toBeNull();
      // The server answers at last: that call is ended, by its number.
      tell({
        event: "call_audio",
        call: 9,
        resume: "late",
        music: true,
        webrtc: true,
      });
      expect(sent.slice(-1)[0]).toEqual({
        op: "call_audio",
        on: false,
        call: 9,
      });
      expect(held).toEqual([]);
      expect(lines.some((line) => line.includes("answered too late"))).toBe(
        true,
      );
      // Past LATE_MS, nothing is listened to any more.
      await pass(LATE_MS);
      tell({ event: "call_audio", call: 10, resume: "x", webrtc: true });
      expect(sent.filter((m) => m.op === "call_audio")).toHaveLength(2);

      // A call taken: its channel holds it, to resume it.
      const taken = await started();
      expect(taken.held).toEqual([{ call: 7, resume: "secret" }]);
      taken.call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("the microphone leg comes back when its session closes, and a microphone error clears it", async () => {
    jest.useFakeTimers();
    try {
      const { call, made, sent, tell, lines } = await started();
      const api = made[0]!;
      api.connection.connected("page-peer");
      api.producers[0]!.registered();
      const client = api.producers[0]!.client();
      tell({ event: "call_microphone", call: 7, ok: true });
      client.rtcPeerConnection.set("connected");
      expect(call.carriesMicrophone()).toBe(true);
      const told = () => sent.filter((m) => m.op === "call_microphone").length;
      expect(told()).toBe(1);

      // The helper made a new session for it at once (it listens to it
      // again): nothing to publish.
      client.end();
      const again = api.producers[0]!.client();
      again.rtcPeerConnection.set("connected");
      await pass(3000);
      expect(api.producers).toHaveLength(1);
      expect(call.carriesMicrophone()).toBe(true);

      // It ended its session and made none: published again, told again.
      again.end();
      expect(call.carriesMicrophone()).toBe(false);
      await pass(3000);
      expect(api.producers).toHaveLength(2);
      expect(api.producers[0]!.closed).toBe(true);
      api.producers[1]!.registered();
      expect(told()).toBe(2);
      // Closing the producer before was the page's own doing, not the
      // signalling's: one new producer, not one every 250 ms.
      await pass(3000);
      expect(api.producers).toHaveLength(2);
      expect(lines.some((line) => line.includes("producer closed"))).toBe(
        false,
      );

      // Its microphone failed: not carried, published again.
      const third = api.producers[1]!.client();
      tell({ event: "call_microphone", call: 7, ok: true });
      third.rtcPeerConnection.set("connected");
      expect(call.carriesMicrophone()).toBe(true);
      tell({
        event: "call_error",
        error:
          "the microphone failed: GStreamer encountered a general stream error.",
      });
      expect(call.carriesMicrophone()).toBe(false);
      await pass(3000);
      expect(api.producers).toHaveLength(3);
      // Not forever: after MICROPHONE_TRIES in a row, the socket.
      for (let at = 3; at <= MICROPHONE_TRIES + 1; at += 1) {
        tell({ event: "call_error", error: "the microphone failed: again" });
        await pass(3000);
      }
      expect(api.producers).toHaveLength(MICROPHONE_TRIES + 1);
      expect(
        lines.some((line) => line.includes("listening goes on the socket")),
      ).toBe(true);
      // A background failing is not the microphone.
      const before = call.carriesMicrophone();
      tell({ event: "call_error", error: "the background failed: no tap" });
      expect(call.carriesMicrophone()).toBe(before);
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a helper restarted while the page was away: adopting the call opens its signalling again", async () => {
    jest.useFakeTimers();
    try {
      const { call, made } = await started();
      made[0]!.connection.connected("page-peer");
      made[0]!.producers[0]!.registered();
      const next = fakeChannel((message) =>
        message.op === "call_resume"
          ? [{ event: "call_audio", call: 7, resumed: true, restarts: 1 }]
          : [],
      );
      const adopting = call.adopt(next.channel);
      await pass(50);
      expect(await adopting).toBe(true);
      // Not the old microphone id to a helper that never knew it: the
      // signalling opens again, and both legs with it.
      expect(next.sent).toEqual([
        { op: "call_resume", call: 7, resume: "secret" },
      ]);
      expect(made[0]!.closed).toBe(1);
      await pass(400);
      expect(made).toHaveLength(2);
      made[1]!.connection.connected("page-peer-2");
      expect(made[1]!.producers).toHaveLength(1);
      // The same number again: nothing restarted, the microphone is told.
      const third = fakeChannel((message) =>
        message.op === "call_resume"
          ? [{ event: "call_audio", call: 7, resumed: true, restarts: 1 }]
          : [],
      );
      made[1]!.producers[0]!.registered();
      expect(await call.adopt(third.channel)).toBe(true);
      expect(third.sent.slice(-1)[0]).toEqual({
        op: "call_microphone",
        peer: "page-peer-2",
        echo: "page",
      });
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("without a WebRTC call, the page goes on without one", async () => {
    const { api } = fakeApis();
    const { channel, sent } = fakeChannel(() => [
      { event: "call_audio", error: "unknown op call_start" },
    ]);
    expect(await WebRtcCall.start(channel, { api })).toBeNull();
    expect(sent).toEqual([{ op: "call_audio", on: true }]);
  });

  test("a rebuilt chat's link controls the call, and is the one told the microphone", async () => {
    const { call, made } = await started();
    made[0]!.connection.connected("page-peer");
    made[0]!.producers[0]!.registered();
    const next = fakeChannel((message) =>
      message.op === "call_resume"
        ? [{ event: "call_audio", call: 7, resumed: true }]
        : [],
    );
    expect(await call.adopt(next.channel)).toBe(true);
    expect(next.sent).toEqual([
      { op: "call_resume", call: 7, resume: "secret" },
      { op: "call_microphone", peer: "page-peer", echo: "page" },
    ]);
    call.hush();
    expect(next.sent.slice(-1)[0]).toEqual({ op: "call_hush" });
    call.stop();
  });
});

describe("a call's trace", () => {
  const stats = (entries: Record<string, unknown>[]) =>
    new Map(entries.map((entry) => [String(entry.id), entry]));

  test("says what a failed leg tried, the busiest pairs first", () => {
    expect(
      describeFailure(
        stats([
          {
            id: "P1",
            type: "candidate-pair",
            state: "failed",
            localCandidateId: "L1",
            remoteCandidateId: "R",
            requestsSent: 3,
            responsesReceived: 0,
            requestsReceived: 0,
          },
          {
            id: "P2",
            type: "candidate-pair",
            state: "failed",
            localCandidateId: "L2",
            remoteCandidateId: "R",
            requestsSent: 9,
            responsesReceived: 0,
            requestsReceived: 0,
          },
          {
            id: "L1",
            type: "local-candidate",
            candidateType: "host",
            protocol: "udp",
            port: 50000,
            networkType: "cellular",
          },
          {
            id: "L2",
            type: "local-candidate",
            candidateType: "host",
            protocol: "udp",
            address: "100.76.190.105",
            port: 50001,
            networkType: "vpn",
          },
          {
            id: "R",
            type: "remote-candidate",
            candidateType: "host",
            protocol: "udp",
            address: "100.91.101.22",
            port: 40123,
          },
        ]),
      ),
    ).toBe(
      "here: host udp port 50000 (cellular), host udp 100.76.190.105:50001 (vpn); helper: host udp 100.91.101.22:40123; pairs: host udp 100.76.190.105:50001 (vpn) -> host udp 100.91.101.22:40123 failed, sent 9, got 0 back, heard 0; host udp port 50000 (cellular) -> host udp 100.91.101.22:40123 failed, sent 3, got 0 back, heard 0",
    );
    expect(describeFailure(stats([]))).toBeNull();
  });

  test("says the ICE path taken", () => {
    expect(
      describePath(
        stats([
          { id: "T", type: "transport", selectedCandidatePairId: "P" },
          {
            id: "P",
            type: "candidate-pair",
            localCandidateId: "L",
            remoteCandidateId: "R",
          },
          {
            id: "L",
            type: "local-candidate",
            candidateType: "host",
            protocol: "udp",
            address: "100.76.190.105",
            port: 50123,
            networkType: "vpn",
          },
          {
            id: "R",
            type: "remote-candidate",
            candidateType: "host",
            protocol: "udp",
            address: "100.71.231.65",
            port: 40012,
          },
        ]),
      ),
    ).toBe(
      "host udp 100.76.190.105:50123 (vpn) -> host udp 100.71.231.65:40012, not relayed",
    );
    expect(describePath(stats([]))).toBeNull();
    // An address the browser keeps to itself: its port.
    expect(
      describePath(
        stats([
          {
            id: "P",
            type: "candidate-pair",
            state: "succeeded",
            nominated: true,
            localCandidateId: "L",
            remoteCandidateId: "R",
          },
          {
            id: "L",
            candidateType: "prflx",
            protocol: "udp",
            port: 49741,
            networkType: "unknown",
          },
          {
            id: "R",
            candidateType: "host",
            protocol: "udp",
            address: "100.71.231.65",
            port: 40023,
          },
        ]),
      ),
    ).toBe("prflx udp port 49741 -> host udp 100.71.231.65:40023, not relayed");
  });

  test("says how much of a reply the microphone heard back, over the reply", () => {
    const at = (microphone: number, replies: number, seconds: number) =>
      echoLevels(
        stats([
          {
            id: "S",
            type: "media-source",
            kind: "audio",
            totalAudioEnergy: microphone,
            totalSamplesDuration: seconds,
            echoReturnLoss: 9.5,
            echoReturnLossEnhancement: 31.25,
          },
        ]),
        stats([
          {
            id: "I",
            type: "inbound-rtp",
            kind: "audio",
            totalAudioEnergy: replies,
            totalSamplesDuration: seconds,
          },
        ]),
      );
    // Over 2 s: the reply at a mean power of 0.01 (-20 dBFS), the
    // microphone at 0.00001 (-50 dBFS): cancelled 30 dB below it.
    expect(describeReplyEcho(at(1, 3, 10), at(1.00002, 3.02, 12))).toBe(
      "the reply at -20.0 dBFS, the microphone at -50.0 dBFS meanwhile (30.0 dB below it), echoReturnLoss 9.5 dB, echoReturnLossEnhancement 31.3 dB",
    );
    // A leg that reports no levels: nothing to say.
    expect(
      describeReplyEcho(
        echoLevels(stats([]), stats([])),
        echoLevels(stats([]), stats([])),
      ),
    ).toBeNull();
  });

  test("says the microphone's echo return loss when reported", () => {
    expect(
      describeEcho(
        stats([
          {
            id: "S",
            type: "media-source",
            kind: "audio",
            echoReturnLoss: 12.34,
            echoReturnLossEnhancement: 25.1,
          },
        ]),
      ),
    ).toBe("echoReturnLoss 12.3 dB, echoReturnLossEnhancement 25.1 dB");
    expect(
      describeEcho(stats([{ id: "S", type: "media-source", kind: "audio" }])),
    ).toBeNull();
    expect(
      jitterMs(
        stats([
          {
            id: "I",
            type: "inbound-rtp",
            kind: "audio",
            // Seconds summed over each sample: 50 ms each.
            jitterBufferDelay: 4800,
            jitterBufferEmittedCount: 96_000,
          },
        ]),
      ),
    ).toBeCloseTo(50);
  });
});

/** Chrome on Android's devices: its communication devices as microphones. */
const ANDROID_DEVICES = [
  { kind: "audioinput", label: "Par défaut", deviceId: "default" },
  { kind: "audioinput", label: "Speakerphone", deviceId: "spk" },
  { kind: "audioinput", label: "Headset earpiece", deviceId: "ear" },
  { kind: "audiooutput", label: "Par défaut", deviceId: "default" },
] as MediaDeviceInfo[];
/** The same in the car: its Bluetooth hands-free too. */
const CAR_DEVICES = [
  ...ANDROID_DEVICES,
  { kind: "audioinput", label: "Bluetooth headset", deviceId: "bt" },
] as MediaDeviceInfo[];
const DESKTOP_DEVICES = [
  { kind: "audioinput", label: "Built-in Microphone", deviceId: "a" },
  { kind: "audiooutput", label: "Speakers", deviceId: "b" },
] as MediaDeviceInfo[];
const ANDROID_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const DESKTOP_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

describe("a call's mode", () => {
  test("a phone without a headset plays on its loudspeaker, the echo cancelled on the server", () => {
    expect(chooseCallMode(ANDROID_DEVICES, ANDROID_AGENT)).toEqual({
      mode: "speaker",
      why: "no headset connected: the replies play as media on the loudspeaker, their echo cancelled on the server",
    });
    // Its devices not named yet (no microphone permission so far).
    expect(chooseCallMode([], ANDROID_AGENT).mode).toBe("speaker");
  });

  test("a headset plays the call, and so does any other browser", () => {
    expect(chooseCallMode(CAR_DEVICES, ANDROID_AGENT)).toEqual({
      mode: "call",
      why: "a Bluetooth headset is connected: it plays the call, the phone cancelling the echo",
    });
    const wired = [
      ...ANDROID_DEVICES,
      { kind: "audioinput", label: "Wired headset", deviceId: "w" },
    ] as MediaDeviceInfo[];
    expect(chooseCallMode(wired, ANDROID_AGENT).mode).toBe("call");
    expect(chooseCallMode(DESKTOP_DEVICES, DESKTOP_AGENT)).toEqual({
      mode: "call",
      why: "the browser cancels the echo itself, on its default output",
    });
  });

  test("the loudspeaker mode opens the microphone with none of the browser's processing", () => {
    expect(microphoneConstraints("speaker")).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(microphoneConstraints("call", "ear")).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: "ear" },
    });
    // Without a call, a capture of its own keeps the browser's.
    expect(activeMicrophoneConstraints().echoCancellation).toBe(true);
  });

  test("starts in the mode the devices say, and tells the helper who cancels the echo", async () => {
    const opened: unknown[] = [];
    const { call, made, sent, lines } = await started({
      microphone: async (request) => {
        opened.push(request);
        return new FakeStream([new FakeTrack()]) as unknown as MediaStream;
      },
      devices: async () => ANDROID_DEVICES,
      userAgent: ANDROID_AGENT,
    });
    expect(call.mode).toBe("speaker");
    expect(opened).toEqual([{ mode: "speaker" }]);
    expect(lines).toContain(
      "call 7: loudspeaker mode: no headset connected: the replies play as media on the loudspeaker, their echo cancelled on the server",
    );
    // A capture of its own during the call is opened as the call's.
    expect(activeMicrophoneConstraints().echoCancellation).toBe(false);
    made[0]!.connection.connected("page-peer");
    made[0]!.producers[0]!.registered();
    expect(sent.slice(-1)[0]).toEqual({
      op: "call_microphone",
      peer: "page-peer",
      echo: "here",
    });
    call.stop();
  });
});

describe("a call's output on a phone", () => {
  test("offers the loudspeaker and the phone's other devices", () => {
    expect(callOutputs(ANDROID_DEVICES, "default", "speaker")).toEqual({
      choices: [
        { kind: "speaker", mode: "speaker" },
        { kind: "earpiece", mode: "call", deviceId: "ear" },
      ],
      current: "speaker",
    });
    expect(callOutputs(ANDROID_DEVICES, "ear", "call").current).toBe(
      "earpiece",
    );
    // In call mode on the default device: the earpiece without a headset.
    expect(callOutputs(ANDROID_DEVICES, "default", "call").current).toBe(
      "earpiece",
    );
    // A Bluetooth headset is the default while it is there, as in Chromium.
    expect(callOutputs(CAR_DEVICES, "default", "call").current).toBe(
      "bluetooth",
    );
    expect(
      callOutputs(CAR_DEVICES, "default", "call").choices.map((c) => c.kind),
    ).toEqual(["speaker", "earpiece", "bluetooth"]);
    expect(
      nextCallOutput(callOutputs(CAR_DEVICES, "default", "call"))?.kind,
    ).toBe("speaker");
    expect(
      nextCallOutput(callOutputs(ANDROID_DEVICES, "default", "speaker")),
    ).toEqual({ kind: "earpiece", mode: "call", deviceId: "ear" });
    expect(
      nextCallOutput(callOutputs(ANDROID_DEVICES, "ear", "call"))?.kind,
    ).toBe("speaker");
  });

  test("offers nothing where the browser names no such device", () => {
    expect(callOutputs(DESKTOP_DEVICES, "a")).toEqual({
      choices: [],
      current: null,
    });
    expect(nextCallOutput(callOutputs(DESKTOP_DEVICES, "a"))).toBeNull();
  });

  test("moves to the other mode with the microphone and the replies made again", async () => {
    jest.useFakeTimers();
    try {
      const opened: unknown[] = [];
      const { call, made, sent, player, played, lines } = await started({
        microphone: async (request) => {
          opened.push(request);
          return new FakeStream([
            new FakeTrack(request.deviceId ?? "default"),
          ]) as unknown as MediaStream;
        },
        devices: async () => ANDROID_DEVICES,
        userAgent: ANDROID_AGENT,
      });
      await settle();
      expect(lines).toContain(
        "call 7: plays on the speaker (speaker mode); can move to speaker, earpiece",
      );
      const api = made[0]!;
      api.connection.connected("page-peer");
      api.peers.producerAdded?.({
        id: "helper",
        meta: { call: 7, role: "replies" },
      });
      api.consumers[0]!.up();
      api.consumers[0]!.rtcPeerConnection!.set("connected");
      api.producers[0]!.registered();
      const stream = call.microphone as unknown as FakeStream;
      const before = stream.tracks[0]!;
      const replies = player.srcObject;
      expect(replies).toEqual({ stream: "helper" });
      call.listening(true);
      const moved = call.useOutput({
        kind: "earpiece",
        mode: "call",
        deviceId: "ear",
      });
      await settle();
      // Everything of the microphone stops, and the replies' output goes.
      expect(before.stopped).toBe(true);
      expect(before.clones[0]!.stopped).toBe(true);
      expect(stream.tracks).toEqual([]);
      expect(player.srcObject).toBeNull();
      expect(call.isSwitching()).toBe(true);
      // Meanwhile the replies still go into the call's mix, never here.
      expect(call.carriesReplies()).toBe(true);
      expect(call.liveMicrophone()).toBeNull();
      expect(activeMicrophoneConstraints().echoCancellation).toBe(true);
      // Chrome's idle output is closed: nothing opens before.
      await pass(OUTPUT_CLOSE_MS - 100);
      expect(opened).toEqual([{ mode: "speaker" }]);
      await pass(200);
      expect(await moved).toBe(true);
      expect(opened).toEqual([
        { mode: "speaker" },
        { mode: "call", deviceId: "ear" },
      ]);
      expect(call.mode).toBe("call");
      expect(stream.tracks.map((t) => t.deviceId)).toEqual(["ear"]);
      expect(player.srcObject).toBe(replies);
      expect(played.slice(-1)[0]).toBe(replies);
      // Published again: the helper is told the page cancels the echo now.
      const producer = api.producers.slice(-1)[0]!;
      expect(producer).not.toBe(api.producers[0]);
      expect(producer.stream.tracks[0]).toBe(stream.tracks[0]!.clones[0]);
      expect(producer.stream.tracks[0]!.enabled).toBe(true);
      producer.registered();
      expect(sent.slice(-1)[0]).toEqual({
        op: "call_microphone",
        peer: "page-peer",
        echo: "page",
      });
      expect(lines).toContain(
        "call 7: moving to the earpiece: call mode, the phone cancelling the echo; the replies pause 5.5 s",
      );
      expect(lines).toContain("call 7: moved to the earpiece");
      expect((await call.outputs()).current).toBe("earpiece");
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("goes back to its mode when the new one does not open", async () => {
    jest.useFakeTimers();
    try {
      const opened: unknown[] = [];
      const { call, lines } = await started({
        microphone: async (request) => {
          opened.push(request);
          if (request.mode === "call") throw new Error("NotReadableError");
          return new FakeStream([new FakeTrack()]) as unknown as MediaStream;
        },
        devices: async () => ANDROID_DEVICES,
        userAgent: ANDROID_AGENT,
      });
      const moved = call.useOutput({
        kind: "earpiece",
        mode: "call",
        deviceId: "ear",
      });
      await pass(OUTPUT_CLOSE_MS + 100);
      expect(await moved).toBe(false);
      expect(call.mode).toBe("speaker");
      expect(opened.slice(-1)[0]).toEqual({ mode: "speaker" });
      expect(
        (call.microphone as unknown as FakeStream).tracks[0]!.stopped,
      ).toBe(false);
      expect(lines.some((line) => line.includes("could not move"))).toBe(true);
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("moves between call devices by opening the microphone on that device, its track replacing the old", async () => {
    const opened: unknown[] = [];
    const { call, made, lines } = await started({
      microphone: async (request) => {
        opened.push(request);
        return new FakeStream([
          new FakeTrack(request.deviceId ?? "default"),
        ]) as unknown as MediaStream;
      },
      devices: async () => CAR_DEVICES,
      userAgent: ANDROID_AGENT,
    });
    await settle();
    expect(call.mode).toBe("call");
    expect(lines).toContain(
      "call 7: plays on the bluetooth (call mode); can move to speaker, earpiece, bluetooth",
    );
    const api = made[0]!;
    api.connection.connected("page-peer");
    api.producers[0]!.registered();
    const client = api.producers[0]!.client();
    const stream = call.microphone as unknown as FakeStream;
    const before = stream.tracks[0]!;
    call.listening(true);
    expect(
      await call.useOutput({ kind: "earpiece", mode: "call", deviceId: "ear" }),
    ).toBe(true);
    expect(opened).toEqual([
      { mode: "call" },
      { mode: "call", deviceId: "ear" },
    ]);
    expect(before.stopped).toBe(true);
    const now = stream.tracks[0]!;
    expect(stream.tracks).toEqual([now]);
    expect(now.deviceId).toBe("ear");
    // The leg sends a clone of the new track, as it did of the old.
    const sent = (client.rtcPeerConnection as FakeConnection).sent;
    expect(sent).toEqual([now.clones[0]]);
    expect(now.clones[0]!.enabled).toBe(true);
    expect(before.clones[0]!.stopped).toBe(true);
    expect((await call.outputs()).current).toBe("earpiece");
    expect(lines).toContain("call 7: moved to the earpiece");
    call.stop();
    expect(now.stopped).toBe(true);
  });

  test("stays where it was when that device does not open", async () => {
    const { call, lines } = await started({
      microphone: async (request) => {
        if (request.deviceId) throw new Error("NotReadableError");
        return new FakeStream([new FakeTrack()]) as unknown as MediaStream;
      },
      devices: async () => CAR_DEVICES,
      userAgent: ANDROID_AGENT,
    });
    const stream = call.microphone as unknown as FakeStream;
    const before = stream.tracks[0]!;
    expect(
      await call.useOutput({ kind: "earpiece", mode: "call", deviceId: "ear" }),
    ).toBe(false);
    expect(stream.tracks).toEqual([before]);
    expect(before.stopped).toBe(false);
    expect(lines.some((line) => line.includes("could not move"))).toBe(true);
    call.stop();
  });
});

/** The page's visibility and the screen wake lock, as the test sets them. */
function fakeScreen({ hidden = false, wakeLock = true } = {}) {
  const listeners = new Set<() => void>();
  const locks: (ScreenLock & { released: boolean; lose(): void })[] = [];
  const screen = {
    hidden: () => state.hidden,
    visibility(changed: () => void) {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    wakeLock: wakeLock
      ? async () => {
          if (state.hidden) throw new Error("NotAllowedError: hidden");
          const target = new EventTarget();
          const lock = {
            released: false,
            async release() {
              lock.lose();
            },
            addEventListener(type: "release", listener: () => void) {
              target.addEventListener(type, listener);
            },
            /** Released, by the page or by the browser (page hidden). */
            lose() {
              if (lock.released) return;
              lock.released = true;
              target.dispatchEvent(new Event("release"));
            },
          };
          locks.push(lock);
          return lock;
        }
      : null,
  };
  const state = { hidden };
  /** The page is hidden (its wake lock let go) or shown. */
  const show = (shown: boolean) => {
    state.hidden = !shown;
    if (!shown) for (const lock of locks) lock.lose();
    for (const listener of [...listeners]) listener();
  };
  return { screen, locks, show, listeners };
}

/** A call whose microphone leg is up: its connection, its client. */
async function connectedCall(options: CallOptions = {}) {
  const call = await started(options);
  const api = call.made[0]!;
  api.connection.connected("page-peer");
  api.producers[0]!.registered();
  const client = api.producers[0]!.client();
  const connection = client.rtcPeerConnection as FakeConnection;
  connection.set("connected");
  return { ...call, connection };
}

describe("a call's screen and microphone on a phone", () => {
  test("holds the screen on while the call lasts, and lets it go at hang-up", async () => {
    const { screen, locks, listeners } = fakeScreen();
    const { call, lines } = await started({ screen });
    await settle();
    expect(locks).toHaveLength(1);
    expect(call.holdsScreen()).toBe(true);
    expect(lines).toContain(
      "call 7: the screen stays on during the call (a wake lock)",
    );
    call.stop();
    expect(locks[0]!.released).toBe(true);
    expect(call.holdsScreen()).toBe(false);
    expect(listeners.size).toBe(0);
  });

  test("takes the wake lock again each time the page shows, never while hidden", async () => {
    const { screen, locks, show } = fakeScreen({ hidden: true });
    const { call, lines } = await started({ screen });
    await settle();
    // A hidden page gets none.
    expect(locks).toHaveLength(0);
    show(true);
    await settle();
    expect(locks).toHaveLength(1);
    // Hidden, the browser lets it go; shown, it is taken again.
    show(false);
    await settle();
    expect(call.holdsScreen()).toBe(false);
    expect(locks).toHaveLength(1);
    show(true);
    await settle();
    expect(locks).toHaveLength(2);
    expect(call.holdsScreen()).toBe(true);
    expect(lines).toContain(
      "call 7: the page is hidden (the screen off, or another app in front)",
    );
    expect(lines).toContain("call 7: the page shows again");
    call.stop();
    expect(locks[1]!.released).toBe(true);
  });

  test("says when the browser gives no wake lock, and goes on", async () => {
    const { screen } = fakeScreen({ wakeLock: false });
    const { call } = await started({
      screen: {
        ...screen,
        wakeLock: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    await settle();
    expect(call.holdsScreen()).toBe(false);
    call.stop();
  });

  test("says a microphone the phone mutes is paused, and that it is back once unmuted", async () => {
    const { screen } = fakeScreen();
    const notices: string[] = [];
    const paused: boolean[] = [];
    const { call, microphone, lines, sent } = await started({
      screen,
      notice: (text) => notices.push(text),
      microphonePaused: (on) => paused.push(on),
    });
    microphone.phone("mute");
    expect(call.microphonePausedByPhone()).toBe("its track muted");
    expect(notices).toEqual([MICROPHONE_PAUSED]);
    expect(paused).toEqual([true]);
    expect(lines).toContain(
      "call 7: the microphone is paused by the phone: its track muted",
    );
    microphone.phone("unmute");
    expect(call.microphonePausedByPhone()).toBeNull();
    expect(paused).toEqual([true, false]);
    expect(lines).toContain(
      "call 7: the microphone is back: its track unmuted",
    );
    // Never hung up for it.
    expect(sent.some((m) => m.op === "call_audio" && m.on === false)).toBe(
      false,
    );
    call.stop();
  });

  test("opens a microphone ended while hidden again once the page shows, the call going on", async () => {
    jest.useFakeTimers();
    try {
      const { screen, show } = fakeScreen();
      const opened: unknown[] = [];
      const notices: string[] = [];
      const microphone = new FakeTrack();
      const { call, connection, lines, sent } = await connectedCall({
        screen,
        notice: (text) => notices.push(text),
        microphone: async (request) => {
          opened.push(request);
          return new FakeStream([
            opened.length === 1 ? microphone : new FakeTrack("again"),
          ]) as unknown as MediaStream;
        },
      });
      call.listening(true);
      show(false);
      microphone.phone("ended");
      expect(call.microphonePausedByPhone()).toBe("its track ended");
      expect(notices).toEqual([`${MICROPHONE_PAUSED}: turn the screen on.`]);
      expect(call.liveMicrophone()).toBeNull();
      // Nothing opens while hidden.
      await pass(REOPEN_MS * 3);
      expect(opened).toHaveLength(1);
      show(true);
      await pass(REOPEN_MS + 100);
      expect(opened).toEqual([
        { mode: "call" },
        { mode: "call", deviceId: "default" },
      ]);
      const stream = call.microphone as unknown as FakeStream;
      const now = stream.tracks[0]!;
      expect(stream.tracks).toEqual([now]);
      expect(now.deviceId).toBe("again");
      expect(microphone.stopped).toBe(true);
      // The leg sends the new track's clone, listening as before.
      expect(connection.sent).toEqual([now.clones[0]]);
      expect(now.clones[0]!.enabled).toBe(true);
      expect(call.microphonePausedByPhone()).toBeNull();
      expect(call.liveMicrophone()).toBe(call.microphone);
      expect(lines).toContain("call 7: the microphone is back: opened again");
      expect(sent.some((m) => m.op === "call_audio" && m.on === false)).toBe(
        false,
      );
      // The new track is watched in turn.
      now.phone("mute");
      expect(call.microphonePausedByPhone()).toBe("its track muted");
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("says a capture the phone silences while listening is paused, and that it is back with sound", async () => {
    jest.useFakeTimers();
    try {
      const { screen, show } = fakeScreen();
      const paused: boolean[] = [];
      const { call, connection, lines } = await connectedCall({
        screen,
        microphonePaused: (on) => paused.push(on),
      });
      call.listening(true);
      let energy = 0.5;
      let seconds = 1;
      const tick = async (grows: boolean) => {
        seconds += MICROPHONE_CHECK_MS / 1000;
        if (grows) energy += 0.01;
        connection.captured(energy, seconds);
        await pass(MICROPHONE_CHECK_MS);
      };
      for (let i = 0; i < 4; i += 1) await tick(true);
      expect(call.microphonePausedByPhone()).toBeNull();
      // The screen goes off: the phone gives the page exact silence.
      show(false);
      for (
        let i = 0;
        i * MICROPHONE_CHECK_MS < SILENT_MS - MICROPHONE_CHECK_MS;
        i += 1
      )
        await tick(false);
      expect(call.microphonePausedByPhone()).toBeNull();
      await tick(false);
      await tick(false);
      expect(call.microphonePausedByPhone()).toBe("its capture went silent");
      expect(lines).toContain(
        "call 7: the microphone is paused by the phone: its capture went silent, the page hidden",
      );
      // Shown again, the capture has sound: back, without opening again.
      show(true);
      await tick(true);
      expect(call.microphonePausedByPhone()).toBeNull();
      expect(paused).toEqual([true, false]);
      expect(lines).toContain(
        "call 7: the microphone is back: its capture has sound again",
      );
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("takes no silence for a pause while not listening (nothing sent then)", async () => {
    jest.useFakeTimers();
    try {
      const { call, connection } = await connectedCall({
        screen: fakeScreen().screen,
      });
      connection.captured(0.5, 1);
      await pass(SILENT_MS * 3);
      expect(call.microphonePausedByPhone()).toBeNull();
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("reads the microphone's running energy as sent", () => {
    expect(microphoneEnergy(new Map())).toBeNull();
    expect(
      microphoneEnergy(
        new Map([
          [
            "s",
            {
              type: "media-source",
              kind: "audio",
              totalAudioEnergy: 2,
              totalSamplesDuration: 3,
            },
          ],
        ]),
      ),
    ).toEqual({ energy: 2, seconds: 3 });
  });
});

/** The Android app, as a call sees it: what it was asked to open. */
function fakeApp(known = true) {
  const app = {
    opened: [] as string[],
    took: 0,
    missed: 0,
    known: () => known,
    open: (url: string) => {
      app.opened.push(url);
    },
  };
  return {
    app,
    options: {
      known: app.known,
      open: app.open,
      took: () => {
        app.took += 1;
      },
      missed: () => {
        app.missed += 1;
        return false;
      },
    },
  };
}

/** The server's answers, handing out a handoff token too. */
const handing = (message: Record<string, unknown>) =>
  message.op === "call_handoff"
    ? [
        {
          event: "call_handoff",
          call: 7,
          handoff: "one-use",
          expires_ms: 60000,
        },
      ]
    : answering(message);

describe("a call handed to the Android app", () => {
  test("a browser without the app keeps its call and asks no handoff", async () => {
    const { app, options } = fakeApp(false);
    const { call, sent } = await started({ app: options }, handing);
    expect(sent.some((m) => m.op === "call_handoff")).toBe(false);
    expect(call.canHandOff()).toBe(false);
    expect(app.opened).toEqual([]);
    call.stop();
  });

  test("on a phone with the app, the call is handed to it once set up", async () => {
    const { app, options } = fakeApp();
    const { call, sent } = await started({ app: options }, handing);
    await settle();
    expect(sent.filter((m) => m.op === "call_handoff")).toEqual([
      { op: "call_handoff", call: 7 },
    ]);
    expect(app.opened).toEqual([
      "intent://mac.example/call/7?handoff=one-use#Intent;scheme=https;package=net.ts.roamgate;action=android.intent.action.VIEW;end",
    ]);
    expect(call.handingOff()).toBe(true);
    expect(call.canHandOff()).toBe(false);
    call.stop();
    expect(call.handingOff()).toBe(false);
  });

  test("the app carrying the microphone: the page's closes, the screen may turn off, and it comes back when the app leaves", async () => {
    const { app, options } = fakeApp();
    const { screen, locks } = fakeScreen();
    const { call, made, sent, tell, microphone, lines } = await connectedCall({
      app: options,
      screen,
    });
    await settle();
    expect(call.holdsScreen()).toBe(true);
    const api = made[0]!;
    const producer = api.producers[0]!;
    const published = producer.stream.tracks[0]!;
    tell({
      event: "call_carrier",
      call: 7,
      state: "joined",
      legs: ["microphone"],
      heard: false,
    });
    expect(app.took).toBe(1);
    expect(call.inApp()).toBe(true);
    expect(call.appCarries("microphone")).toBe(true);
    expect(call.appCarries("replies")).toBe(false);
    expect(producer.closed).toBe(true);
    expect(published.stopped).toBe(true);
    expect(microphone.stopped).toBe(true);
    expect(call.liveMicrophone()).toBeNull();
    // Listenings ask for the call's microphone, the app's: none opened here.
    expect(call.carriesMicrophone()).toBe(true);
    expect(locks[0]!.released).toBe(true);
    expect(call.holdsScreen()).toBe(false);
    expect(lines).toContain("call 7: the Roamgate app carries the microphone");
    const producers = api.producers.length;
    // The signalling coming back publishes nothing behind the app's back.
    api.connection.connected("page-peer");
    expect(api.producers).toHaveLength(producers);
    tell({
      event: "call_carrier",
      call: 7,
      state: "left",
      why: "The Roamgate app gave the call back",
    });
    await settle();
    expect(call.inApp()).toBe(false);
    expect(api.producers).toHaveLength(producers + 1);
    expect(lines).toContain(
      "call 7: the Roamgate app gave the call back (The Roamgate app gave the call back): it goes on here",
    );
    expect(call.holdsScreen()).toBe(true);
    call.stop();
    expect(sent.slice(-1)[0]).toEqual({ op: "call_audio", on: false, call: 7 });
  });

  test("the app carrying the replies plays them and moves them between its outputs", async () => {
    const { options } = fakeApp(false);
    const { call, made, sent, tell, player } = await started({ app: options });
    const api = made[0]!;
    api.connection.connected("page-peer");
    api.peers.producerAdded?.({
      id: "helper",
      meta: { call: 7, role: "replies" },
    });
    const consumer = api.consumers[0]!;
    consumer.up();
    await settle();
    expect(player.srcObject).not.toBeNull();
    tell({
      event: "call_carrier",
      call: 7,
      state: "joined",
      legs: ["microphone", "replies"],
      heard: true,
    });
    expect(consumer.closed).toBe(true);
    expect(player.srcObject).toBeNull();
    expect(call.carriesReplies()).toBe(true);
    // The helper's producer seen again consumes nothing while the app has it.
    api.peers.producerAdded?.({
      id: "helper",
      meta: { call: 7, role: "replies" },
    });
    expect(api.consumers).toHaveLength(1);
    expect(await call.outputs()).toEqual({ choices: [], current: null });
    tell({
      event: "call_output_state",
      call: 7,
      current: "speaker",
      outputs: [
        { id: "speaker", kind: "speaker", label: "Loudspeaker" },
        { id: "bt:AA", kind: "bluetooth", label: "Car" },
      ],
    });
    const outputs = await call.outputs();
    expect(outputs.current).toBe("speaker");
    const next = nextCallOutput(outputs)!;
    expect(next).toMatchObject({ kind: "bluetooth", deviceId: "bt:AA" });
    expect(await call.useOutput(next)).toBe(true);
    expect(sent.slice(-1)[0]).toEqual({
      op: "call_output",
      call: 7,
      output: "bt:AA",
    });
    call.stop();
  });

  test("an app that does not join leaves the call here, and is told it missed", async () => {
    jest.useFakeTimers();
    try {
      const { app, options } = fakeApp();
      const notices: string[] = [];
      const { call } = await started(
        { app: options, notice: (text) => notices.push(text) },
        handing,
      );
      await settle();
      expect(call.handingOff()).toBe(true);
      jest.advanceTimersByTime(HANDOFF_WAIT_MS);
      expect(app.missed).toBe(1);
      expect(call.handingOff()).toBe(false);
      expect(call.inApp()).toBe(false);
      expect(notices).toEqual([
        "The Roamgate app did not take the call: it goes on here.",
      ]);
      // Offered again, by hand.
      expect(call.canHandOff()).toBe(true);
      call.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
