import { describe, expect, test } from "bun:test";
import { type CompanionLogEntry, companionRecent } from "./companionCall";

describe("the call lately, for the front", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  test("says what was heard, said and started, oldest first", () => {
    const log: CompanionLogEntry[] = [
      {
        id: 1,
        at: now - 3 * 60_000,
        kind: "heard",
        text: "Where is the Spotify connector?",
      },
      {
        id: 2,
        at: now - 3 * 60_000,
        kind: "job",
        session: "local/w2:p2",
        label: "roamgate",
        words: "Where is the Spotify connector?",
        status: "answered",
        answer: "It waits for its DNS step.",
      },
      {
        id: 3,
        at: now - 10_000,
        kind: "said",
        text: "Roamgate says the connector waits\nfor its DNS step.",
      },
      {
        id: 4,
        at: now,
        kind: "web",
        job: "w1",
        question: "librespot DNS",
        status: "searching",
        steps: [],
      },
    ];
    expect(companionRecent(log, now)).toBe(
      [
        '- The user (3 min ago): "Where is the Spotify connector?"',
        '- You gave roamgate (3 min ago): "Where is the Spotify connector?", answered: "It waits for its DNS step."',
        '- You said: "Roamgate says the connector waits for its DNS step."',
        '- You looked up: "librespot DNS", searching',
      ].join("\n"),
    );
  });

  test("keeps the last entries, a long reading cut", () => {
    const log: CompanionLogEntry[] = Array.from({ length: 12 }, (_, at) => ({
      id: at,
      at: now,
      kind: "said" as const,
      text: at === 11 ? "x".repeat(1000) : `line ${at}`,
    }));
    const lines = companionRecent(log, now).split("\n");
    expect(lines.length).toBe(8);
    expect(lines[0]).toBe('- You said: "line 4"');
    expect(lines[7]).toContain("... (1000 characters)");
    expect(companionRecent([], now)).toBe("");
  });
});
