import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  type ChannelEvent,
  type ChannelSocket,
  RECONNECT_MS,
  STALL_BYTES,
  VoiceChannel,
} from "./voiceChannel";

const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

/** A socket the test opens, closes and answers. */
class FakeSocket implements ChannelSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  send(data: string | ArrayBufferView<ArrayBuffer>) {
    this.sent.push(
      typeof data === "string"
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  drop() {
    this.readyState = 3;
    this.onclose?.(new Event("close") as CloseEvent);
  }
  tell(event: ChannelEvent) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
  json() {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data));
  }
  bytes() {
    return this.sent
      .filter((data): data is Uint8Array => typeof data !== "string")
      .reduce((total, data) => total + data.length, 0);
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** 40 ms of audio. */
const chunk = () => new Int16Array(640);

async function opened() {
  const sockets: FakeSocket[] = [];
  const reconnected: boolean[] = [];
  const connect = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const opening = VoiceChannel.open({
    connect,
    onReconnected: (resumed) => reconnected.push(resumed),
  });
  sockets[0]!.open();
  const channel = await opening;
  const events: ChannelEvent[] = [];
  channel.listen((event) => events.push(event));
  return { channel, sockets, events, reconnected };
}

afterEach(() => jest.useRealTimers());

describe("voice channel", () => {
  test("a closed socket comes back, the session resumed, the audio it missed sent again", async () => {
    jest.useFakeTimers();
    const { channel, sockets, events, reconnected } = await opened();
    const first = sockets[0]!;
    channel.send({ op: "listen" });
    first.tell({ event: "listening", session: 3, resume: "secret" });
    for (let i = 0; i < 5; i += 1) channel.audio(chunk());
    first.drop();
    // Said while the network was away: kept.
    for (let i = 0; i < 3; i += 1) channel.audio(chunk());
    channel.send({ op: "release" });
    jest.advanceTimersByTime(0);
    await flush();
    const second = sockets[1]!;
    second.open();
    await flush();
    expect(second.json()).toEqual([
      { op: "resume", session: 3, resume: "secret" },
    ]);
    // The server got four of the five chunks sent before the loss.
    second.tell({ event: "resumed", session: 3, received: 4 * 1280 });
    await flush();
    expect(second.bytes()).toBe(4 * 1280);
    expect(last(second.json())).toEqual({ op: "release" });
    expect(reconnected).toEqual([true]);
    second.tell({ event: "final", session: 3, text: "Pretty good." });
    expect(last(events)).toEqual({
      event: "final",
      session: 3,
      text: "Pretty good.",
    });
    expect(channel.closed).toBeNull();
  });

  test("a socket that keeps what it is given unsent is taken as gone", async () => {
    jest.useFakeTimers();
    const { channel, sockets } = await opened();
    const first = sockets[0]!;
    first.tell({ event: "listening", session: 1, resume: "t" });
    channel.audio(chunk());
    first.bufferedAmount = STALL_BYTES + 1;
    channel.audio(chunk());
    expect(first.closed).toBe(true);
    jest.advanceTimersByTime(0);
    await flush();
    expect(sockets.length).toBe(2);
  });

  test("with no way back, it says the connection closed", async () => {
    jest.useFakeTimers();
    const { sockets, events, channel } = await opened();
    sockets[0]!.tell({ event: "listening", session: 1, resume: "t" });
    sockets[0]!.drop();
    for (let elapsed = 0; elapsed <= RECONNECT_MS + 5000; elapsed += 250) {
      jest.advanceTimersByTime(250);
      await flush();
      const newest = last(sockets)!;
      if (newest.readyState === 0 && newest.onerror)
        newest.onerror(new Event("e"));
      await flush();
    }
    expect(last(events)).toEqual({
      event: "error",
      error: "The voice connection closed",
    });
    expect(channel.closed).not.toBeNull();
  });

  test("a session its helper ended is not resumed", async () => {
    jest.useFakeTimers();
    const { sockets, events, reconnected } = await opened();
    sockets[0]!.tell({ event: "listening", session: 2, resume: "t" });
    sockets[0]!.tell({
      event: "error",
      session: 2,
      error: "The voice helper stopped",
      recoverable: true,
    });
    sockets[0]!.drop();
    jest.advanceTimersByTime(0);
    await flush();
    sockets[1]!.open();
    await flush();
    expect(sockets[1]!.json()).toEqual([]);
    expect(reconnected).toEqual([false]);
    expect(last(events)?.event).toBe("error");
  });

  test("a resume the server refuses ends it", async () => {
    jest.useFakeTimers();
    const { sockets, events } = await opened();
    sockets[0]!.tell({ event: "listening", session: 1, resume: "t" });
    sockets[0]!.drop();
    jest.advanceTimersByTime(0);
    await flush();
    sockets[1]!.open();
    await flush();
    sockets[1]!.tell({ event: "resume_failed", session: 1 });
    await flush();
    expect(last(events)?.event).toBe("error");
  });
});
