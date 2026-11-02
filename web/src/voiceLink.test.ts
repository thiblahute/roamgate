import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { parkVoiceLink, takeParkedVoiceLink, VoiceLink } from "./voiceChat";

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
  globals.AudioWorkletNode = class {
    port = { onmessage: null };
    connect(next: unknown) {
      return next;
    }
    disconnect() {}
  };
});
afterAll(() => {
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
