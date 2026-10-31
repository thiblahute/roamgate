import { describe, expect, test } from "bun:test";
import { blockLevel, encodeWav } from "./voiceLibrary";

describe("voice recordings", () => {
  test("are 16-bit mono WAV files", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -1, 2]), 48_000);
    const view = new DataView(wav.buffer);
    const text = (at: number, length: number) =>
      String.fromCharCode(...wav.slice(at, at + length));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.length).toBe(44 + 8);
    // Clipped to the 16-bit range.
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 16384, -32767, 32767,
    ]);
  });

  test("a meter's level grows with the voice, up to 1", () => {
    expect(blockLevel(new Float32Array(128))).toBe(0);
    const quiet = blockLevel(new Float32Array(128).fill(0.01));
    const loud = blockLevel(new Float32Array(128).fill(0.1));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    expect(blockLevel(new Float32Array(128).fill(1))).toBe(1);
  });
});
