import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewSession, ReviewThread } from "../../../shared/review";
import {
  HISTORY_IMAGE_MAX_BYTES,
  parseThread,
  renderThread,
  reviewsArea,
  withHistoryHooks,
} from "./reviews";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const S1 = "00087e46c486e70c";
const S2 = "4e6b9c5f4b89b44b";

const session = (id: string, createdAt: string): ReviewSession =>
  ({
    id,
    connectionId: "local",
    root: "/repo",
    title: "Work 8a057f17: History\nand backup",
    target: { kind: "work", item: "8a057f17bc9203bc" },
    gitlab: false,
    summary: "",
    agent: { name: "Claude", working: { at: "now" } },
    createdAt,
    updatedAt: createdAt,
  }) as unknown as ReviewSession;

const thread = (
  id: string,
  sessionId: string,
  bodies: string[],
): ReviewThread => ({
  id,
  sessionId,
  kind: "discussion",
  anchor: { work: { item: "8a057f17bc9203bc" } } as never,
  comments: bodies.map((body, index) => ({
    id: `${id}c${index}`,
    author: index ? "Claude" : "you",
    body,
    createdAt: "2026-11-22T11:12:26Z",
    updatedAt: "2026-11-22T11:12:26Z",
  })),
  resolved: false,
  createdAt: "2026-11-22T11:12:26Z",
  updatedAt: "2026-11-22T11:12:26Z",
});

test("a thread file is Markdown with headers, and reads back the same thread", () => {
  const t = thread("67dba4b0cdce0f05", S1, [
    "We should keep history.",
    "Sorted as:\n\n- one\n- two\n",
    "<!-- roamgate:comment {} --> pasted",
  ]);
  const text = renderThread(t, "Work 8a057f17: History\nand backup");
  const lines = text.split("\n");
  expect(lines[0]).toStartWith('<!-- roamgate:thread {"anchor"');
  expect(lines[1]).toBe("# Work 8a057f17: History and backup");
  expect(lines[3]).toStartWith('<!-- roamgate:comment {"author":"you"');
  expect(lines[4]).toBe("We should keep history.");
  expect(parseThread(text)).toEqual(t);
});

test("the reviews area writes each review by year, its threads and its images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-reviews-"));
  dirs.push(dir);
  const png = (fill: number, size = 64) => {
    const data = Buffer.alloc(size, fill);
    data.set([0x89, 0x50, 0x4e, 0x47]);
    return data;
  };
  mkdirSync(join(dir, "images", S1), { recursive: true });
  writeFileSync(join(dir, "images", S1, "aaaaaaaaaaaaaaaa.png"), png(1));
  // The same picture pasted twice: stored once.
  writeFileSync(join(dir, "images", S1, "bbbbbbbbbbbbbbbb.png"), png(1));
  writeFileSync(
    join(dir, "images", S1, "cccccccccccccccc.png"),
    png(2, HISTORY_IMAGE_MAX_BYTES + 1),
  );
  const image = (name: string) => join(dir, "images", S1, name);
  const sessions = [
    session(S1, "2026-11-22T10:00:00Z"),
    session(S2, "2025-01-01T00:00:00Z"),
  ];
  const threads: Record<string, ReviewThread[]> = {
    [S1]: [
      thread("t1", S1, [
        `see ![shot](${image("aaaaaaaaaaaaaaaa.png")})`,
        `again ![shot](${image("bbbbbbbbbbbbbbbb.png")}) and ![big](${image("cccccccccccccccc.png")})`,
      ]),
    ],
    [S2]: [thread("t2", S2, ["old"])],
  };
  const area = reviewsArea({ reviews: dir }, () => ({
    loadSessions: () => sessions,
    loadThreads: (id) => threads[id] ?? [],
  }));
  const full = await area.render(null);
  const sha = createHash("sha256").update(png(1)).digest("hex");
  expect([...full.files.keys()].sort()).toEqual([
    `reviews/2025/${S2}/review.json`,
    `reviews/2025/${S2}/t2.md`,
    `reviews/2026/${S1}/review.json`,
    `reviews/2026/${S1}/t1.md`,
    `reviews/images/${sha}.png`,
  ]);
  expect(full.owns).toEqual(["reviews/"]);
  const review = JSON.parse(
    full.files.get(`reviews/2026/${S1}/review.json`) as string,
  );
  expect(review.session.agent).toEqual({ name: "Claude" });
  expect(review.images).toEqual({
    [`${S1}/aaaaaaaaaaaaaaaa.png`]: `${sha}.png`,
    [`${S1}/bbbbbbbbbbbbbbbb.png`]: `${sha}.png`,
    [`${S1}/cccccccccccccccc.png`]: {
      omitted: "larger than 5 MB",
      bytes: HISTORY_IMAGE_MAX_BYTES + 1,
    },
  });
  const one = await area.render(new Set([S2, "ffffffffffffffff"]));
  expect([...one.files.keys()].sort()).toEqual([
    `reviews/2025/${S2}/review.json`,
    `reviews/2025/${S2}/t2.md`,
  ]);
  expect(one.owns).toEqual([`reviews/*/${S2}/`, "reviews/*/ffffffffffffffff/"]);
  expect(
    area.describe?.([
      `reviews/2026/${S1}/t1.md`,
      `reviews/2026/${S1}/t3.md`,
      `reviews/2025/${S2}/review.json`,
      `reviews/images/${sha}.png`,
    ]),
  ).toBe("2 threads in 2 reviews, 1 image");
});

test("the review store tells the history each review and Work item it wrote", () => {
  const marks: string[] = [];
  const written: string[] = [];
  const store = {
    loadSessions: () => [] as ReviewSession[],
    loadThreads: (id: string) => (id === S1 ? [thread("t1", S1, ["a"])] : []),
    saveSession: (each: ReviewSession) => void written.push(each.id),
    saveThread: (each: ReviewThread) => void written.push(each.id),
    deleteThread: (id: string) => void written.push(id),
    deleteSession: (id: string) => void written.push(id),
    close() {},
  };
  const hooked = withHistoryHooks(store, (area, id) =>
    marks.push(`${area}:${id ?? "*"}`),
  );
  hooked.loadThreads(S1);
  hooked.saveSession(session(S2, "2026-01-01T00:00:00Z"));
  hooked.saveThread(thread("t9", S2, ["x"]));
  hooked.deleteThread("t1");
  hooked.deleteThread("unknown");
  hooked.deleteSession(S2);
  hooked.close();
  expect(written).toEqual([S2, "t9", "t1", "unknown", S2]);
  expect(marks).toEqual([
    `reviews:${S2}`,
    `reviews:${S2}`,
    "work:8a057f17bc9203bc",
    `reviews:${S1}`,
    "work:8a057f17bc9203bc",
    "reviews:*",
    `reviews:${S2}`,
  ]);
});
