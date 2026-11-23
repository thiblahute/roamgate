/**
 * Length-prefixed frames: the little-endian u32 length of what follows, a
 * kind byte, then the payload. The voice helper's stdin and stdout
 * (voice/helper/src/frames.rs, contract/vectors/voice-frames.json) and the
 * internal channel to the Rust core (contract/wire/core-channel.md) use it.
 */

/** A JSON object, UTF-8. */
export const FRAME_JSON = 0;
/** A listening session's audio: its u32 id, then 16 kHz mono S16LE. */
export const FRAME_AUDIO = 1;
/** The kinds of frame the voice helper writes. */
const FRAME_KINDS: ReadonlySet<number> = new Set([FRAME_JSON, FRAME_AUDIO]);
/** The largest frame the helper writes or reads (frames.rs's MAX_FRAME). */
export const MAX_FRAME = 16 * 1024 * 1024;

export type Frame = { kind: number; payload: Uint8Array };

export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length + 1, true);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
}

/**
 * What came is not a frame: something else wrote on the stream (a library
 * printing on the voice helper's stdout). `bytes` are the first of
 * what came there, escaped, to tell what wrote it.
 */
export class FrameError extends Error {
  constructor(readonly bytes: string) {
    super(`not a frame: ${bytes}`);
  }
}

/** The first `count` of `bytes` as text: other bytes as \xNN. */
export function escapeBytes(bytes: Uint8Array, count = 200): string {
  let text = "";
  for (const byte of bytes.subarray(0, count))
    text +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`;
  return bytes.length > count ? `${text}...` : text;
}

/**
 * Splits a byte stream into frames, however it arrives. What cannot be a
 * frame (a length of 0 or past the maximum, MAX_FRAME unless given, a kind
 * not in `kinds`) breaks the stream for good: `error` says what came, and nothing
 * after it is read.
 */
export class FrameReader {
  private buffer = new Uint8Array(0);
  /** What is not read yet: buffer[start, end). */
  private start = 0;
  private end = 0;
  error: FrameError | null = null;

  constructor(
    private readonly kinds: ReadonlySet<number> = FRAME_KINDS,
    private readonly maxFrame = MAX_FRAME,
  ) {}

  /** The frames `chunk` completes, up to what is not a frame, if any. */
  push(chunk: Uint8Array): Frame[] {
    if (this.error) return [];
    this.append(chunk);
    const frames: Frame[] = [];
    while (this.end - this.start >= 4) {
      const at = this.start;
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + at,
      ).getUint32(0, true);
      if (
        length === 0 ||
        length > this.maxFrame ||
        (this.end - at > 4 && !this.kinds.has(this.buffer[at + 4]!))
      ) {
        this.error = new FrameError(
          escapeBytes(this.buffer.subarray(at, this.end)),
        );
        this.buffer = new Uint8Array(0);
        this.start = this.end = 0;
        break;
      }
      if (this.end - at - 4 < length) break;
      frames.push({
        kind: this.buffer[at + 4]!,
        payload: this.buffer.slice(at + 5, at + 4 + length),
      });
      this.start = at + 4 + length;
    }
    if (this.start === this.end) this.start = this.end = 0;
    return frames;
  }

  /** Keeps `chunk` after what is not read, copying that only to grow. */
  private append(chunk: Uint8Array) {
    if (this.end + chunk.length > this.buffer.length) {
      const kept = this.end - this.start;
      const needed = kept + chunk.length;
      if (needed <= this.buffer.length)
        this.buffer.copyWithin(0, this.start, this.end);
      else {
        const grown = new Uint8Array(
          Math.max(needed, this.buffer.length * 2, 64 * 1024),
        );
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      }
      this.start = 0;
      this.end = kept;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }
}
