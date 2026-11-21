/**
 * Dictation into the message box: the microphone streams to the voice
 * socket in its dictation mode (server/src/http/voice-socket.ts), the raw
 * words come back while they are said, and the cleaned text when the user
 * stops (voice-dictation.ts on the server). Outside voice chat: nothing is
 * routed or read aloud, the text only goes into the box.
 */
import { type ChannelEvent, VoiceChannel } from "./voiceChannel";
import { Downsampler, STREAM_RATE, TAP_WORKLET } from "./voiceChat";
import { activeMicrophoneConstraints } from "./webrtcCall";

/** Audio is sent in pieces this long. */
const CHUNK_MS = 40;

/** What a field takes, as the server's cleaner knows them (voice-dictation.ts). */
export type DictationKind =
  | "chat"
  | "email_body"
  | "email_subject"
  | "search"
  | "url"
  | "code"
  | "name"
  | "email_address"
  | "address"
  | "number"
  | "text";

export type DictationTarget = {
  /** chat (a message to an agent), code (a shell command), text... */
  kind: DictationKind;
  /** The field's label or placeholder; by default from its kind. */
  hint?: string;
  /** Whether the field takes several lines; by default all but code. */
  multiLine?: boolean;
  /** The box's text before and after the cursor. */
  before: string;
  after: string;
};

export type DictationResult = {
  text: string;
  /** False: the words as heard (no cleaner, or it failed). */
  cleaned: boolean;
  /** The server heard no words at all: nothing is typed. */
  nothingHeard?: boolean;
};

export type Dictating = {
  /** Stops listening: resolves to the text to put in the box. */
  finish: () => Promise<DictationResult>;
  /** Drops it: nothing is typed. */
  cancel: () => void;
};

/**
 * Where `text` goes in a box holding `value`, the cursor from `start` to
 * `end`: a space before it unless the cursor follows a space, a line start
 * or an opening bracket; one after it when a word follows. The caret ends
 * after the text.
 */
export function insertDictation(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  if (!text) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/[\s([{"'«¿¡]$/.test(before) ? " " : "";
  const trail = /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  const inserted = `${lead}${text}${trail}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + lead.length + text.length,
  };
}

/** The voice socket's URL from this page. */
function socketUrl(): URL {
  const url = new URL("/api/voice/ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/** The field's hint when it names none. */
function defaultHint(kind: DictationKind): string {
  if (kind === "code") return "Shell command";
  if (kind === "chat") return "Message to the agent";
  return "";
}

/**
 * Starts dictating: resolves once the microphone streams. `onHeard` gets
 * the words as heard so far, whole each time; `onLoading` whether the
 * server's listening models are still loading (what is said meanwhile is
 * heard once they are).
 */
export async function startDictation(
  target: DictationTarget,
  onHeard: (text: string) => void,
  onLoading?: (loading: boolean) => void,
): Promise<Dictating> {
  const channel = await VoiceChannel.open({
    connect: () => new WebSocket(socketUrl()),
  });
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let tapUrl: string | null = null;
  const release = () => {
    channel.close();
    for (const track of stream?.getTracks() ?? []) track.stop();
    void context?.close().catch(() => {});
    if (tapUrl) URL.revokeObjectURL(tapUrl);
  };
  let session: number | null = null;
  let heard = "";
  let nothingHeard = false;
  let settle: (result: DictationResult) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const result = new Promise<DictationResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Never left unhandled: cancel drops it.
  result.catch(() => {});
  channel.listen(
    (event: ChannelEvent & { cleaned?: boolean; nothing_heard?: boolean }) => {
      if (event.event === "listening") {
        session = event.session ?? null;
        return;
      }
      if (event.session !== undefined && event.session !== session) return;
      if (event.event === "loading") onLoading?.(true);
      else if (event.event === "ready") onLoading?.(false);
      else if (event.event === "partial") {
        heard = event.text ?? "";
        onHeard(heard);
      } else if (event.event === "final")
        settle({ text: event.text ?? "", cleaned: event.cleaned === true });
      else if (event.event === "error") {
        nothingHeard = event.nothing_heard === true;
        fail(new Error(event.error ?? "Dictation failed"));
      }
    },
  );
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: activeMicrophoneConstraints(),
    });
    context = new AudioContext();
    await context.resume();
    tapUrl = URL.createObjectURL(
      new Blob([TAP_WORKLET], { type: "text/javascript" }),
    );
    await context.audioWorklet.addModule(tapUrl);
    const tap = new AudioWorkletNode(context, "roamgate-tap");
    const mute = context.createGain();
    mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(tap);
    tap.connect(mute).connect(context.destination);
    const downsampler = new Downsampler(context.sampleRate);
    const chunkSamples = (STREAM_RATE * CHUNK_MS) / 1000;
    let chunk: number[] = [];
    let streaming = true;
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!streaming) return;
      for (const sample of downsampler.push(event.data)) chunk.push(sample);
      if (chunk.length >= chunkSamples) {
        channel.audio(Int16Array.from(chunk));
        chunk = [];
      }
    };
    channel.send({
      op: "listen",
      mode: "dictation",
      language: navigator.language.slice(0, 2).toLowerCase(),
      field: {
        app: "roamgate",
        app_label: "Roamgate",
        kind: target.kind,
        hint: target.hint || defaultHint(target.kind),
        multi_line: target.multiLine ?? target.kind !== "code",
      },
      before: target.before,
      after: target.after,
    });
    const stopStreaming = () => {
      streaming = false;
      tap.port.onmessage = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
    return {
      finish: async () => {
        if (chunk.length) channel.audio(Int16Array.from(chunk));
        chunk = [];
        stopStreaming();
        channel.send({ op: "finish" });
        try {
          return await result;
        } catch {
          if (nothingHeard) return { text: "", cleaned: false, nothingHeard };
          // What was heard is still the user's: typed as heard.
          return { text: heard.trim(), cleaned: false };
        } finally {
          release();
        }
      },
      cancel: () => {
        stopStreaming();
        channel.send({ op: "stop" });
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
