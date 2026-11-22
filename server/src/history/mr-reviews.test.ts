import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableJson } from "./format";
import {
  exportReviews,
  mrReviewsArea,
  mrReviewsFromHistory,
} from "./mr-reviews";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("the mr-reviews area splits the export by effort and reads back to it", async () => {
  const data = mkdtempSync(join(tmpdir(), "roamgate-mr-"));
  dirs.push(data);
  const settings = join(data, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      mr_reviews: {
        order: ["a", "b"],
        efforts: [{ id: "e1", name: "Big" }],
        hints: "token glpat-abcdefghijklmnopqrst",
        clones: { x: 1 },
      },
    }),
  );
  const effort = join(data, "mr-reviews", "efforts", "e1");
  mkdirSync(effort, { recursive: true });
  writeFileSync(
    join(effort, "ledger.json"),
    JSON.stringify({
      version: 3,
      entries: [{ id: "x" }],
      journal: [{ undo: 1 }],
    }),
  );
  writeFileSync(
    join(effort, "history.jsonl"),
    '{"at":"1","what":"a"}\n{"at":"2","what":"b"}\n',
  );
  writeFileSync(join(effort, "derived.json"), "{}");
  const area = mrReviewsArea({ settings, data });
  const render = await area.render(null);
  expect([...render.files.keys()].sort()).toEqual([
    "mr-reviews/efforts/e1/history.jsonl",
    "mr-reviews/efforts/e1/ledger.json",
    "mr-reviews/export.json",
  ]);
  const head = render.files.get("mr-reviews/export.json") as string;
  expect(head).not.toContain("exported_at");
  expect(head).not.toContain("glpat-");
  expect(head).not.toContain("clones");
  expect(render.files.get("mr-reviews/efforts/e1/ledger.json")).not.toContain(
    "journal",
  );
  expect(area.watch?.()).toContain(join(effort, "ledger.json"));
  const back = mrReviewsFromHistory(render.files as Map<string, string>);
  const direct = exportReviews({
    stored: JSON.parse(readFileSync(settings, "utf8")).mr_reviews,
    effortsRoot: join(data, "mr-reviews", "efforts"),
  });
  expect(stableJson({ ...back, exported_at: "" })).toBe(
    stableJson({ ...direct, exported_at: "" }),
  );
  expect(
    area.describe?.([
      "mr-reviews/export.json",
      "mr-reviews/efforts/e1/ledger.json",
    ]),
  ).toBe("the Reviews' settings, 1 effort");
});
