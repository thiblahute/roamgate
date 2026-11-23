import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, FrameReader } from "./voice-helper";

// The vectors the Rust codec (crates/roamgate-protocol/src/frames.rs, used
// by the voice helper and the parity fake) is held to as well: both codecs
// read the same file.
type Vectors = {
  max_frame: number;
  frames: {
    name: string;
    kind: number;
    payload_text?: string;
    payload_hex?: string;
    frame_hex: string;
  }[];
  invalid: { name: string; bytes_hex: string }[];
};

const vectors = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../contract/vectors/voice-frames.json"),
    "utf8",
  ),
) as Vectors;

const fromHex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

for (const frame of vectors.frames) {
  test(`voice frame vector: ${frame.name}`, () => {
    const payload =
      frame.payload_text !== undefined
        ? new TextEncoder().encode(frame.payload_text)
        : fromHex(frame.payload_hex ?? "");
    expect(Buffer.from(encodeFrame(frame.kind, payload)).toString("hex")).toBe(
      frame.frame_hex,
    );
    const read = new FrameReader().push(fromHex(frame.frame_hex));
    expect(read).toEqual([{ kind: frame.kind, payload }]);
  });
}

for (const invalid of vectors.invalid) {
  test(`voice frame vector refused: ${invalid.name}`, () => {
    const reader = new FrameReader();
    expect(reader.push(fromHex(invalid.bytes_hex))).toEqual([]);
    expect(reader.error).not.toBeNull();
  });
}
