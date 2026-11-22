import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { ReviewThread } from "../../../shared/review";
import type { WorkItem } from "../../../shared/work";
import type { ReviewSource } from "./area";
import {
  parseWorkItem,
  renderWorkItem,
  workArea,
  workCommit,
  workItemPath,
} from "./work";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const item: WorkItem = {
  id: "8a057f17bc9203bc",
  project: "roamgate",
  title: "History and backup",
  state: "doing",
  tags: ["history"],
  owner: { session: "desktop/w35:p1" },
  links: [{ kind: "file", path: "plans/data-history.md" }],
  createdAt: "2026-11-22T11:12:26.494Z",
  updatedAt: "2026-11-22T12:00:00.000Z",
  by: "agent",
  review: "696679c25b617a96",
};

const description = "# History\n\nKeep what you do.\n";

function reviews(threads: Record<string, ReviewThread[]>): ReviewSource {
  return {
    loadSessions: () => [],
    loadThreads: (id) => threads[id] ?? [],
  };
}

const descriptionThread: ReviewThread = {
  id: "t1",
  sessionId: "696679c25b617a96",
  kind: "discussion",
  anchor: { work: { item: item.id, description: true } } as never,
  comments: [
    {
      id: "c1",
      author: "Claude",
      body: description,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    },
  ],
  resolved: false,
  createdAt: item.createdAt,
  updatedAt: item.createdAt,
};

test("an item's file is its header, then its description, and reads back", () => {
  const text = renderWorkItem(item, description);
  expect(text.split("\n")[0]).toStartWith('<!-- roamgate:item {"by":"agent"');
  expect(text.endsWith(`${description}\n`)).toBe(true);
  expect(parseWorkItem(text)).toEqual({ item, description });
  expect(parseWorkItem(renderWorkItem(item, null))).toEqual({
    item,
    description: "",
  });
});

test("the Work area writes items with their description, projects and history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-work-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "work.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "roamgate",
          name: "Roamgate",
          roots: [],
          done: { kind: "deployed" },
        },
      ],
      items: [item, { ...item, id: "0000000000000001", review: undefined }],
    }),
  );
  writeFileSync(
    join(dir, "history.jsonl"),
    `${JSON.stringify({ at: "x", item: item.id, by: "user", change: { state: "doing" } })}\n`,
  );
  const area = workArea({ work: dir }, () =>
    reviews({ [item.review!]: [descriptionThread] }),
  );
  const full = await area.render(null);
  expect([...full.files.keys()].sort()).toEqual([
    "work/history.jsonl",
    "work/items/0000000000000001.md",
    "work/items/8a057f17bc9203bc.md",
    "work/projects/roamgate.json",
  ]);
  expect(full.owns).toEqual(["work/"]);
  expect(
    parseWorkItem(full.files.get(workItemPath(item.id)) as string).description,
  ).toBe(description);
  const some = await area.render(new Set([item.id, "ffffffffffffffff"]));
  expect([...some.files.keys()]).toEqual([workItemPath(item.id)]);
  // A removed item's file goes.
  expect(some.owns).toContain("work/items/ffffffffffffffff.md");
  expect(
    area.describe?.([
      "work/items/a.md",
      "work/items/b.md",
      "work/history.jsonl",
    ]),
  ).toBe("2 items, its history");
});

test("a change is committed as its author at its time", () => {
  const byAgent = workCommit(
    {
      item,
      id: item.id,
      change: { state: "doing", previous_description: "old", tags: ["x"] },
      actor: {
        by: "agent",
        address: "desktop/w35:p1",
        caller: "Claude in roamgate",
      },
      at: item.updatedAt,
    },
    description,
    "desk",
  );
  expect(byAgent).toMatchObject({
    path: "work/items/8a057f17bc9203bc.md",
    author: { name: "Claude (desktop/w35:p1)", email: "agent@desk" },
    date: "2026-11-22T12:00:00.000Z",
    subject: 'work 8a057f17: state doing, tags "History and backup"',
    body: "By Claude in roamgate at desktop/w35:p1.",
  });
  expect(byAgent.content).toBe(renderWorkItem(item, description));
  const user = userInfo().username;
  const removed = workCommit(
    {
      item: null,
      id: item.id,
      change: { removed: true },
      actor: { by: "user" },
      at: "2026-11-22T13:00:00.000Z",
    },
    null,
    "desk",
  );
  expect(removed).toMatchObject({
    content: null,
    author: { name: user, email: `${user}@desk` },
    subject: "work 8a057f17: removed",
  });
});
