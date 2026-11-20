import { cosine, unit } from "../voice-profiles";

/** Voice prints made up for tests (voice-profiles.test.ts). */

/** One of a few voices that score about 0 against each other. */
export function person(n: number): number[] {
  return unit(Array.from({ length: 256 }, (_, i) => (i % 8 === n ? 1 : 0.05)))!;
}

/** A print `noise` away from `base`, made from a seed. */
export function near(base: number[], noise: number, seed: number): number[] {
  let state = (seed * 2654435761 + 1) >>> 0;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state / 0xffffffff) * 2 - 1;
  };
  return unit(base.map((value) => value + noise * next()))!;
}

/** A print scoring about `score` against `a`, the rest towards `b`. */
export function between(a: number[], b: number[], score: number): number[] {
  // a and b are about orthogonal (person()): mix so the cosine is `score`.
  const other = unit(b.map((value, i) => value - cosine(a, b) * a[i]!))!;
  const rest = Math.sqrt(1 - score * score);
  return unit(a.map((value, i) => value * score + other[i]! * rest))!;
}
