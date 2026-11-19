/**
 * The voice socket's transport (/api/voice/ws, server/src/http/voice-socket.ts)
 * as a phone moving between networks needs it: a socket that closes, or
 * stalls with what it was given unsent, is opened again and the listening
 * session resumed (`{"op": "resume"}`), the audio the server did not get
 * sent again from what it says it received, and what was asked meanwhile
 * sent once it is back. Whoever listens sees one unbroken session. In a
 * WebRTC call (webrtcCall.ts) the microphone does not come this way: its
 * audio lost to the network is not sent again.
 */

/** What of a WebSocket the channel uses. */
export type ChannelSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBufferView<ArrayBuffer>): void;
  close(): void;
};

export type ChannelEvent = {
  event: string;
  session?: number;
  text?: string;
  speech_ms?: number;
  error?: string;
  raw?: string;
  for_agent?: boolean;
  /** On a final: whose voice (the helper's voices), passed on to the route. */
  voice?: unknown;
  /** On a final: that voice's label, as the companion reads it. */
  voice_label?: string;
  /** On a session's error: the helper stopped under it, nothing else. */
  recoverable?: boolean;
  resume?: string;
  received?: number;
  /** A call (webrtcCall.ts). */
  call?: number;
  resumed?: boolean;
  /** Times a restarted helper made the call again. */
  restarts?: number;
  music?: boolean;
  /** call_music: the music waits for the speaker's voice to be learnt. */
  waiting?: boolean;
  webrtc?: boolean;
  ok?: boolean;
  /** call_carrier: whether the Android app "joined" the call or "left" it. */
  state?: string;
  /** call_carrier: the legs the app carries. */
  legs?: unknown;
  /** call_carrier: the helper hears the app's microphone. */
  heard?: boolean;
  /** call_carrier left: why. */
  why?: string;
  /** call_handoff: the single-use token the app joins with. */
  handoff?: string;
  /** call_output_state: the app's outputs, and the one it plays on. */
  outputs?: unknown;
  current?: unknown;
};

const OPEN = 1;
/** How long the channel tries to come back: the server keeps it as long. */
export const RECONNECT_MS = 20_000;
/** Waits between tries to open the socket again. */
const RETRY_MS = [0, 250, 500, 1000, 2000, 3000];
/**
 * This much audio given to a socket and still not sent: the network under
 * it is gone (a phone that changed networks keeps the old socket open).
 */
export const STALL_BYTES = 3 * 16_000 * 2;
/** The audio kept to send again on a resume, in bytes (30 s). */
const REPLAY_BYTES = 30 * 16_000 * 2;

export type ChannelOptions = {
  connect: () => ChannelSocket;
  /** The channel is coming back: audio waits meanwhile. */
  onReconnecting?: (why: string) => void;
  /** It came back; `resumed` when a listening session went on. */
  onReconnected?: (resumed: boolean) => void;
  trace?: (line: string) => void;
};

export class VoiceChannel {
  private socket: ChannelSocket;
  private listeners = new Set<(event: ChannelEvent) => void>();
  /** The call controlled on this channel, to move it to a new socket. */
  private call: { call: number; resume: string } | null = null;
  private closedError: Error | null = null;
  private closedByUs = false;
  /** The session listening, its resume token, and whether it is over. */
  private session: number | null = null;
  private token: string | null = null;
  private over = true;
  /** Audio of the session sent so far, and the last of it, to send again. */
  private sent = 0;
  private replay: { at: number; data: Uint8Array<ArrayBuffer> }[] = [];
  /** Coming back: what is asked waits. */
  private reconnecting = false;
  private queued: object[] = [];
  private give: ((event: ChannelEvent) => void) | null = null;

  private constructor(
    socket: ChannelSocket,
    private readonly options: ChannelOptions,
  ) {
    this.socket = socket;
    this.adopt(socket);
  }

  /** Opens the socket; rejects when it does not open. */
  static open(options: ChannelOptions): Promise<VoiceChannel> {
    const socket = options.connect();
    socket.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      socket.onopen = () => resolve(new VoiceChannel(socket, options));
      socket.onerror = () => reject(new Error("The voice connection failed"));
    });
  }

  get closed() {
    return this.closedError;
  }

  /** Whether it is coming back from a lost socket now. */
  get away() {
    return this.reconnecting;
  }

  listen(listener: (event: ChannelEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The call `call` (webrtcCall.ts) is controlled on this channel: moved to
   * each new socket (`call_resume`). Only a call the page took: one it gave
   * up on (answered too late) is not.
   */
  holdCall(call: number, resume: string) {
    this.call = { call, resume };
  }

  close() {
    this.closedByUs = true;
    this.reconnecting = false;
    this.socket.onclose = null;
    this.socket.onmessage = null;
    this.socket.close();
  }

  send(message: object) {
    const { op, on, call, resume } = message as {
      op?: unknown;
      on?: unknown;
      call?: unknown;
      resume?: unknown;
    };
    // Its end: not resumed any more (another call's end leaves it).
    if (
      op === "call_audio" &&
      on === false &&
      (call === undefined || call === this.call?.call)
    )
      this.call = null;
    // A call taken over from another link: this one resumes it from now on.
    if (
      op === "call_resume" &&
      typeof call === "number" &&
      typeof resume === "string"
    )
      this.call = { call, resume };
    if (this.reconnecting) {
      this.queued.push(message);
      return;
    }
    if (this.socket.readyState === OPEN)
      this.socket.send(JSON.stringify(message));
  }

  audio(samples: Int16Array<ArrayBuffer>) {
    const data = new Uint8Array(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    );
    if (this.session !== null && !this.over) {
      this.replay.push({ at: this.sent, data });
      this.sent += data.length;
      while (
        this.replay.length > 1 &&
        this.sent - this.replay[0]!.at > REPLAY_BYTES
      )
        this.replay.shift();
    }
    if (this.reconnecting || this.socket.readyState !== OPEN) return;
    if (this.socket.bufferedAmount > STALL_BYTES && this.session !== null) {
      this.lost("the audio is not going out");
      return;
    }
    this.socket.send(data);
  }

  private adopt(socket: ChannelSocket) {
    socket.binaryType = "arraybuffer";
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      let event: ChannelEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (this.give) {
        this.give(event);
        return;
      }
      this.seen(event);
      for (const listener of [...this.listeners]) listener(event);
    };
    socket.onclose = () => this.lost("the socket closed");
  }

  private seen(event: ChannelEvent) {
    if (
      event.event === "call_audio" &&
      event.error &&
      event.call === this.call?.call
    )
      this.call = null;
    if (event.event === "listening") {
      this.session = event.session ?? null;
      this.token = event.resume ?? null;
      this.over = false;
      this.sent = 0;
      this.replay = [];
    } else if (
      (event.event === "final" || event.event === "error") &&
      event.session === this.session
    ) {
      // Over: nothing to resume (an error's session ended on the server).
      this.over = true;
      this.replay = [];
    }
  }

  /** The socket is gone: another one, and the session resumed on it. */
  private lost(why: string) {
    if (this.closedByUs || this.reconnecting) return;
    const old = this.socket;
    old.onclose = null;
    old.onmessage = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      // Gone already.
    }
    this.reconnecting = true;
    this.options.trace?.(`voice connection lost (${why}): reconnecting`);
    this.options.onReconnecting?.(why);
    void this.comeBack();
  }

  private async comeBack() {
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      if (this.closedByUs) return;
      if (Date.now() - started > RECONNECT_MS) break;
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]),
      );
      if (this.closedByUs) return;
      const socket = this.options.connect();
      socket.binaryType = "arraybuffer";
      const opened = await new Promise<boolean>((resolve) => {
        socket.onopen = () => resolve(true);
        socket.onerror = () => resolve(false);
        socket.onclose = () => resolve(false);
      });
      if (!opened || this.closedByUs) {
        if (this.closedByUs) socket.close();
        continue;
      }
      const resuming = this.session !== null && !this.over;
      let received = 0;
      if (resuming) {
        const answer = await new Promise<ChannelEvent | null>((resolve) => {
          this.give = resolve;
          socket.onclose = () => resolve(null);
          socket.onmessage = (message) => {
            if (typeof message.data !== "string") return;
            try {
              this.give?.(JSON.parse(message.data));
            } catch {
              // Not for us.
            }
          };
          socket.send(
            JSON.stringify({
              op: "resume",
              session: this.session,
              resume: this.token,
            }),
          );
        });
        this.give = null;
        if (!answer) continue;
        if (answer.event !== "resumed") {
          socket.close();
          break;
        }
        received = answer.received ?? 0;
      }
      this.socket = socket;
      this.adopt(socket);
      this.reconnecting = false;
      if (resuming) {
        // What the server did not get, again, in order.
        for (const { at, data } of this.replay) {
          const end = at + data.length;
          if (end <= received) continue;
          socket.send(at >= received ? data : data.subarray(received - at));
        }
      }
      // The call is controlled from this socket (voice-socket.ts).
      if (this.call)
        socket.send(
          JSON.stringify({
            op: "call_resume",
            call: this.call.call,
            resume: this.call.resume,
          }),
        );
      for (const message of this.queued.splice(0))
        socket.send(JSON.stringify(message));
      this.options.trace?.(
        resuming
          ? `voice connection back: the session goes on, ${Math.round((this.sent - received) / 32)} ms of audio sent again`
          : "voice connection back",
      );
      this.options.onReconnected?.(resuming);
      return;
    }
    this.reconnecting = false;
    this.closedError = new Error("The voice connection closed");
    this.options.trace?.("voice connection lost for good");
    for (const listener of [...this.listeners])
      listener({ event: "error", error: this.closedError.message });
  }
}
