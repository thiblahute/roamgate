/**
 * The channel against the real Rust core: only with ROAMGATE_CORE_BIN set
 * to a debug build of `roamgate` (parity/tests runs it so); skipped
 * otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  exerciseTestFamily,
  type Harness,
  shadowLines,
  startHarness,
} from "./testdata/test-family";

const bin = process.env.ROAMGATE_CORE_BIN;

describe.skipIf(!bin)("the Rust core", () => {
  let harness: Harness | null = null;
  afterAll(async () => {
    await harness?.front.stop();
    if (harness) rmSync(harness.dataDir, { recursive: true, force: true });
  });

  test("answers the test family through the channel", async () => {
    harness = await startHarness(bin!);
    await exerciseTestFamily(harness);
    expect(shadowLines(harness.dataDir)).toEqual([]);
    expect(harness.warnings).toEqual([]);
  }, 60_000);
});
