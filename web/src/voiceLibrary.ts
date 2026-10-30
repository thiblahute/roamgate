import { playbackRateFor } from "../../shared/speechRate";
import type { VoiceLanguage } from "../../shared/voiceLibrary";
import { getSpeechRate } from "./voiceChat";

/**
 * The voices replies are read with (server/src/voice/voice-library.ts):
 * listing, recording, choosing and hearing them.
 */

const VOICE_HEADERS = { "x-roamgate-voice": "1" };

export type VoiceInfo = {
  id: string;
  name: string;
  languages: string[];
  owned: boolean;
  created?: string;
};

export type VoiceAssignments = {
  all: string | null;
  languages: Partial<Record<VoiceLanguage, string>>;
};

export type VoiceLibraryState = {
  voices: VoiceInfo[];
  kokoro: boolean;
  assignments: VoiceAssignments;
  can_clone: boolean;
  clone_detail?: string;
};

/** Kokoro's built-in voices, as a voice id. */
export const KOKORO = "kokoro";

async function answer<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? response.statusText);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { ...VOICE_HEADERS, "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchVoiceLibrary(): Promise<VoiceLibraryState> {
  return answer(await fetch("/api/voice/voices"));
}

export type NewVoice = {
  voice: VoiceInfo;
  /** What the speech recognizer heard. */
  heard: string;
  /** The words kept with the voice. */
  transcript: string;
  /** The text shown read whole, part of it, or something else heard. */
  kind: "shown" | "partial" | "heard";
};

export async function createVoice(input: {
  name: string;
  language: VoiceLanguage;
  text: string;
  recording: Blob;
  /** It ended while speech went on. */
  cut?: boolean;
}): Promise<NewVoice> {
  const form = new FormData();
  form.set("name", input.name);
  form.set("language", input.language);
  form.set("text", input.text);
  form.set("audio", input.recording, "recording.wav");
  if (input.cut) form.set("cut", "1");
  return answer(
    await fetch("/api/voice/voices", {
      method: "POST",
      headers: VOICE_HEADERS,
      body: form,
    }),
  );
}

/** `voice` reads `language`, or every language (null); null voice: none. */
export async function assignVoice(
  voice: string | null,
  language: VoiceLanguage | null,
): Promise<VoiceLibraryState> {
  return answer(
    await fetch(
      "/api/voice/voices/assign",
      jsonRequest("POST", { voice, language }),
    ),
  );
}

export async function renameVoice(id: string, name: string) {
  return answer<VoiceInfo>(
    await fetch(
      `/api/voice/voices/${encodeURIComponent(id)}`,
      jsonRequest("PATCH", { name }),
    ),
  );
}

export async function deleteVoice(id: string) {
  await answer<null>(
    await fetch(`/api/voice/voices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: VOICE_HEADERS,
    }),
  );
}

/**
 * Plays a sentence in `voice`, at the reading speed, until it ends or
 * `signal` aborts.
 */
export async function playVoiceSample(
  voice: string,
  signal: AbortSignal,
  language?: VoiceLanguage,
): Promise<void> {
  const response = await fetch(
    "/api/voice/voices/sample",
    jsonRequest("POST", { voice, ...(language ? { language } : {}) }),
  );
  if (!response.ok) await answer(response);
  const native = Number(response.headers.get("x-voice-native-rate")) || 1;
  await playBlob(await response.blob(), signal, (player) => {
    player.preservesPitch = true;
    player.defaultPlaybackRate = playbackRateFor(getSpeechRate(), native);
    player.playbackRate = player.defaultPlaybackRate;
  });
}

/** Plays `audio` until it ends or `signal` aborts. */
export function playBlob(
  audio: Blob,
  signal: AbortSignal,
  prepare?: (player: HTMLAudioElement) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(audio);
    const player = new Audio(url);
    prepare?.(player);
    const done = () => {
      signal.removeEventListener("abort", done);
      player.pause();
      URL.revokeObjectURL(url);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    player.onended = done;
    player.onerror = () => {
      done();
      reject(new Error("The sound could not be played"));
    };
    player.play().catch((error: Error) => {
      done();
      reject(error);
    });
  });
}

/** Mono samples as a 16-bit WAV file. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const wav = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1)
      wav.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  wav.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  text(36, "data");
  wav.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    wav.setInt16(44 + i * 2, Math.round(sample * 0x7fff), true);
  }
  return new Uint8Array(wav.buffer);
}

/** The root mean square of `block`. */
export function blockRms(block: Float32Array): number {
  let sum = 0;
  for (const sample of block) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, block.length));
}

/** The level of `block` for a meter, 0 to 1. */
export function blockLevel(block: Float32Array): number {
  const rms = blockRms(block);
  // Speech sits around 0.02 to 0.2: spread it over the meter.
  return Math.min(1, Math.sqrt(rms * 8));
}

// Hands the microphone's samples to the page, block by block.
const RECORDER_WORKLET = `
class RoamgateRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("roamgate-recorder", RoamgateRecorder);
`;
let workletUrl: string | null = null;

const recordingListeners = new Set<(recording: boolean) => void>();
let recordingNow = false;

function setRecordingNow(recording: boolean) {
  if (recording === recordingNow) return;
  recordingNow = recording;
  for (const listener of [...recordingListeners]) listener(recording);
}

/**
 * Follows whether a voice is being recorded, so a voice conversation stops
 * listening meanwhile (what is read aloud is not for the agent).
 */
export function subscribeVoiceRecording(
  listener: (recording: boolean) => void,
): () => void {
  recordingListeners.add(listener);
  return () => recordingListeners.delete(listener);
}

export type Recording = {
  /** Ends the recording: its WAV, and how long it is. */
  stop: () => Promise<{ wav: Blob; seconds: number }>;
  /** Drops it. */
  cancel: () => void;
};

/**
 * Records the microphone as it is, for a voice to be cloned from it: no
 * noise suppression or echo cancellation, which a clone would copy.
 * `onLevel` follows the voice for a meter, `onSeconds` the time so far,
 * `onBlock` each moment's RMS and length (ReadingEnd).
 */
export async function startRecording({
  onLevel,
  onSeconds,
  onBlock,
}: {
  onLevel?: (level: number) => void;
  onSeconds?: (seconds: number) => void;
  onBlock?: (rms: number, seconds: number) => void;
} = {}): Promise<Recording> {
  setRecordingNow(true);
  const stream = await navigator.mediaDevices
    .getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    .catch((error: Error) => {
      setRecordingNow(false);
      throw error;
    });
  const context = new AudioContext();
  const blocks: Float32Array[] = [];
  let length = 0;
  const close = () => {
    setRecordingNow(false);
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  try {
    await context.resume();
    workletUrl ??= URL.createObjectURL(
      new Blob([RECORDER_WORKLET], { type: "text/javascript" }),
    );
    await context.audioWorklet.addModule(workletUrl);
    const tap = new AudioWorkletNode(context, "roamgate-recorder");
    const mute = context.createGain();
    mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(tap);
    tap.connect(mute).connect(context.destination);
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      blocks.push(event.data);
      length += event.data.length;
      onLevel?.(blockLevel(event.data));
      onBlock?.(blockRms(event.data), event.data.length / context.sampleRate);
      onSeconds?.(length / context.sampleRate);
    };
  } catch (error) {
    close();
    throw error;
  }
  return {
    stop: async () => {
      const rate = context.sampleRate;
      close();
      const samples = new Float32Array(length);
      let at = 0;
      for (const block of blocks) {
        samples.set(block, at);
        at += block.length;
      }
      return {
        wav: new Blob([encodeWav(samples, rate) as BlobPart], {
          type: "audio/wav",
        }),
        seconds: length / rate,
      };
    },
    cancel: close,
  };
}
