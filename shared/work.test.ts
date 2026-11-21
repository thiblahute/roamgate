import { expect, test } from "bun:test";
import {
  filterWorkItems,
  parseWorkQuery,
  provisionalWorkTitle,
  type WorkItem,
  workQueryWithTag,
  workTagCompletions,
} from "./work";

const item = (id: string, title: string, tags: string[]): WorkItem => ({
  id,
  project: "roamgate",
  title,
  state: "open",
  tags,
  links: [],
  createdAt: "2026-11-21T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
  by: "user",
});

test("a provisional title: the first line with words, 80 characters at most", () => {
  expect(provisionalWorkTitle("Fix the header\nmore")).toBe("Fix the header");
  expect(provisionalWorkTitle("\n![shot](<work-image:1>)\n# - Fix it")).toBe(
    "Fix it",
  );
  const long = provisionalWorkTitle("a".repeat(200));
  expect(long).toHaveLength(80);
  expect(long.endsWith("…")).toBe(true);
  expect(provisionalWorkTitle("![only](<work-image:1>)")).toBe("New item");
});

test("the search names tags as #tag or tag:tag, all of them kept; the rest are words", () => {
  expect(parseWorkQuery("#Voice tag:phone header # ")).toEqual({
    words: ["header"],
    tags: ["voice", "phone"],
  });
  // The tag still being typed: the tags it begins.
  expect(parseWorkQuery("header #vo")).toEqual({
    words: ["header"],
    tags: [],
    partial: "vo",
  });
  const items = [
    item("1", "Header scrolls", ["voice", "phone"]),
    item("2", "Header voice", ["phone"]),
    item("3", "Other", ["voice"]),
  ];
  const ids = (query: string) =>
    filterWorkItems(items, { query }).map((each) => each.id);
  expect(ids("#phone ")).toEqual(["1", "2"]);
  expect(ids("#pho")).toEqual(["1", "2"]);
  expect(ids("#pho ")).toEqual([]);
  expect(ids("#phone #voice")).toEqual(["1"]);
  // A word still finds a tag's name; #voice only the tag.
  expect(ids("voice")).toEqual(["1", "2", "3"]);
  expect(ids("#voice header")).toEqual(["1"]);
});

test("the search's last #word completes to the tags, those it begins first", () => {
  const tags = ["voice", "reviews", "phone", "work-board", "android-voice"];
  expect(workTagCompletions("header #vo", tags)).toEqual([
    { tag: "voice", insert: "header #voice " },
    { tag: "android-voice", insert: "header #android-voice " },
  ]);
  expect(workTagCompletions("tag:ph", tags)).toEqual([
    { tag: "phone", insert: "#phone " },
  ]);
  // A tag named already is not offered again; nothing after a space.
  expect(
    workTagCompletions("#voice #", tags).map((each) => each.tag),
  ).not.toContain("voice");
  expect(workTagCompletions("#voice ", tags)).toEqual([]);
  expect(workTagCompletions("voice", tags)).toEqual([]);
});

test("a card's tag adds #tag to the search once", () => {
  expect(workQueryWithTag("", "voice")).toBe("#voice ");
  expect(workQueryWithTag("header", "voice")).toBe("header #voice ");
  expect(workQueryWithTag("#voice header", "voice")).toBe("#voice header");
});
