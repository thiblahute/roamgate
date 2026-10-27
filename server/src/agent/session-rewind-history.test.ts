import { describe, expect, test } from "bun:test";
import type { AgentSessionFileAccess } from "./session-file-access";
import { readSessionProjection } from "./session-projection-cache";
import { rewoundAfterQueuedRecords } from "./session-rewind.fixture";
import {
  keptRecords,
  REWOUND_PROMPT,
  rewoundRecordIds,
} from "./session-rewind";

const path = "/tmp/rewound.jsonl";

function access(text: string) {
  const bytes = Buffer.from(text);
  return {
    file: { path, mtimeMs: 1000, size: bytes.length },
    files: {
      readText: async () => text,
      readRange: async (_: string, start: number, end: number) =>
        new Uint8Array(bytes.subarray(start, end)),
    } as unknown as AgentSessionFileAccess,
  };
}

const jsonl = (records: Record<string, unknown>[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

const cutTexts = [
  "I think you should check out his last messages.",
  "No, I'm telling you to look at Romate last messages.",
];

describe("a rewind past messages sent through Claude Code's queue", () => {
  test("keeps the cut prompts as stand-ins, without their uuids", () => {
    const records = rewoundAfterQueuedRecords;
    const kept = keptRecords(records, rewoundRecordIds(records));
    const stand = kept.filter((record) => record.type === REWOUND_PROMPT);
    expect(stand.map((record) => record.content)).toEqual(cutTexts);
    expect(stand.every((record) => record.uuid === undefined)).toBe(true);
    // Nothing of the abandoned branch is left as the conversation's.
    const uuids = new Set(kept.map((record) => record.uuid));
    for (const cut of ["f7f8aeb9", "2ee463be", "dc0ae100"])
      expect([...uuids].some((uuid) => String(uuid).startsWith(cut))).toBe(
        false,
      );
  });

  test("the history shows the current branch only, and none of it queued", async () => {
    const { file, files } = access(jsonl(rewoundAfterQueuedRecords));
    const { entries } = await readSessionProjection("claude", file, files);
    expect(entries.some((entry) => entry.queued)).toBe(false);
    const messages = entries.filter((entry) => entry.kind === "message");
    for (const text of cutTexts)
      expect(messages.some((entry) => entry.text === text)).toBe(false);
    expect(
      messages.some((entry) => entry.text.startsWith("I'm not sure")),
    ).toBe(false);
    expect(messages.slice(-2).map((entry) => entry.text.slice(0, 26))).toEqual([
      "whether the um mcp the sou",
      "Yes, there are two levels:",
    ]);
  });

  test("a rewind empties what the history still counted as queued", async () => {
    const { file, files } = access(
      jsonl([
        {
          type: "queue-operation",
          operation: "enqueue",
          timestamp: "2026-11-05T00:28:03.652Z",
          content: "left behind",
        },
        { type: "last-prompt", rewound: true, cutUuid: "unknown" },
      ]),
    );
    const projection = await readSessionProjection("claude", file, files);
    expect(projection.entries.some((entry) => entry.queued)).toBe(false);
  });
});
