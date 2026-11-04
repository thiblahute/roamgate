import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MrItem } from "../../../shared/mrReviews";
import {
  CURATION_MODEL,
  createMrCuration,
  parseRanking,
  topPaths,
} from "./curation";
import { openMrStore } from "./store";

const item = (n: number, extra: Partial<MrItem> = {}): MrItem => ({
  provider: "gitlab",
  host: "h",
  project: "g/p",
  number: n,
  key: `k${n}`,
  url: `https://h/g/p/-/merge_requests/${n}`,
  title: `MR ${n}`,
  author: "alice",
  draft: false,
  state: "open",
  updatedAt: `2026-11-0${n % 9}T00:00:00Z`,
  headSha: "a".repeat(40),
  sourceBranch: "x",
  targetBranch: "main",
  pipeline: null,
  notes: 0,
  reasons: [],
  files: [`src/f${n}.c`],
  ...extra,
});

describe("curation", () => {
  test("rankings: only given keys, a reason for each pick, few picks", () => {
    const keys = new Set(["k1", "k2", "k3"]);
    const text = `Here: [${[
      {
        key: "k1",
        pick: true,
        score: 90,
        reason: "touches src/f1.c you changed",
      },
      { key: "k2", pick: true, score: 50, reason: "" },
      { key: "zz", pick: true, score: 99, reason: "not a candidate" },
      { key: "k3", pick: false, score: 10, reason: "" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join(",")}]`;
    expect(parseRanking(text, keys)).toEqual([
      {
        key: "k1",
        pick: true,
        score: 90,
        reason: "touches src/f1.c you changed",
      },
      { key: "k2", pick: false, score: 50, reason: "" },
      { key: "k3", pick: false, score: 10, reason: "" },
    ]);
    expect(() => parseRanking("no json", keys)).toThrow();
  });

  test("top paths count files and their directories", () => {
    expect(topPaths(["a/b.c", "a/b.c", "a/d.c"])).toEqual([
      ["a/", 3],
      ["a/b.c", 2],
      ["a/d.c", 1],
    ]);
  });

  test("a batch: the user's own requests and dismissed ones are no candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-cur-"));
    try {
      const store = openMrStore(join(dir, "state.json"));
      store.update((state) => {
        state.feedback.push({
          key: "k3",
          verdict: "not_interested",
          at: "t",
          title: "MR 3",
          project: "g/p",
          author: "alice",
          files: [],
        });
      });
      const asked: { model: string; prompt: any }[] = [];
      const curation = createMrCuration({
        store,
        settings: async () => ({
          curation: true,
          hints: "I maintain GES",
          followed: [{}],
        }),
        connections: () => [],
        users: () => new Map([["h", "me"]]),
        run: async (model, _system, prompt) => {
          asked.push({ model, prompt: JSON.parse(prompt) });
          return {
            text: JSON.stringify([
              { key: "k1", pick: true, score: 80, reason: "touches src/f1.c" },
            ]),
            ms: 1,
          };
        },
      });
      const items = [
        item(1),
        item(2, { author: "Me" }),
        item(3),
        item(4, { reasons: ["assigned"] }),
      ];
      await curation.maybeRun(items, true);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.model).toBe(CURATION_MODEL);
      expect(asked[0]!.prompt.candidates.map((c: any) => c.key)).toEqual([
        "k1",
      ]);
      expect(asked[0]!.prompt.reviewer.hints).toBe("I maintain GES");
      expect(asked[0]!.prompt.reviewer.feedback[0].verdict).toBe(
        "not_interested",
      );
      expect(store.get().ranked.k1).toMatchObject({
        pick: true,
        reason: "touches src/f1.c",
      });
      // Ranked at its current state: not asked again until it changes.
      await curation.maybeRun(items, true);
      expect(asked).toHaveLength(1);
      // Rarely: not again before its period, even with new candidates.
      await curation.maybeRun([...items, item(5)]);
      expect(asked).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("off: nothing is asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mr-cur-"));
    try {
      let asked = 0;
      const curation = createMrCuration({
        store: openMrStore(join(dir, "state.json")),
        settings: async () => ({ curation: false, hints: "", followed: [{}] }),
        connections: () => [],
        run: async () => {
          asked++;
          return { text: "[]", ms: 0 };
        },
      });
      await curation.maybeRun([item(1)], true);
      expect(asked).toBe(0);
      expect(curation.state().state).toBe("off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
