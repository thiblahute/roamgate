import { expect, test } from "bun:test";
import { compactedSince } from "./session-compaction";

const line = (record: Record<string, unknown>) => JSON.stringify(record);

test("a compaction after the time is found in Claude's, Codex's and Pi's transcripts", () => {
  const since = "2026-11-22T10:00:00.000Z";
  const claude = [
    line({ type: "user", timestamp: "2026-11-22T09:59:00.000Z" }),
    line({
      type: "user",
      isCompactSummary: true,
      timestamp: "2026-11-22T10:05:00.000Z",
    }),
    line({ type: "assistant", timestamp: "2026-11-22T10:06:00.000Z" }),
  ].join("\n");
  expect(compactedSince(claude, since)).toBe(true);
  const boundary = line({
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-11-22T10:01:00.000Z",
  });
  expect(compactedSince(boundary, since)).toBe(true);
  const codex = line({
    type: "compacted",
    timestamp: "2026-11-22T10:02:00.000Z",
    payload: {},
  });
  expect(compactedSince(codex, since)).toBe(true);
  const pi = line({ type: "compaction", timestamp: "2026-11-22T10:03:00Z" });
  expect(compactedSince(pi, since)).toBe(true);
});

test("one before the time, none at all, or a cut first line is not", () => {
  const since = "2026-11-22T10:00:00.000Z";
  const before = [
    line({
      type: "user",
      isCompactSummary: true,
      timestamp: "2026-11-22T09:00:00.000Z",
    }),
    line({ type: "assistant", timestamp: "2026-11-22T10:30:00.000Z" }),
  ].join("\n");
  expect(compactedSince(before, since)).toBe(false);
  expect(compactedSince(line({ type: "user", timestamp: since }), since)).toBe(
    false,
  );
  expect(compactedSince('pactSummary":true}\n', since)).toBe(false);
  expect(compactedSince("", since)).toBe(false);
});
