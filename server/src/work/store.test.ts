import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterWorkItems,
  normalizeWorkTags,
  parseWorkTitle,
  workDescriptionThread,
  workTagsOf,
} from "../../../shared/work";
import {
  mergeWorkLinks,
  openWorkStore,
  parseWorkLink,
  parseWorkOwner,
  parseWorkState,
  WorkError,
} from "./store";

const dirs: string[] = [];
function dir() {
  const made = mkdtempSync(join(tmpdir(), "roamgate-work-"));
  dirs.push(made);
  return made;
}
afterEach(() => {
  for (const each of dirs.splice(0))
    rmSync(each, { recursive: true, force: true });
});

describe("work description thread", () => {
  test("the thread made with the item, else the earliest bare one within a minute", () => {
    const item = { createdAt: "2026-11-20T10:00:00.000Z" };
    const thread = (
      id: string,
      createdAt: string,
      work: Record<string, unknown>,
    ) => ({ id, createdAt, anchor: { work } });
    const marked = thread("m", "2026-11-20T12:00:00.000Z", {
      item: "x",
      description: true,
    });
    const early = thread("e", "2026-11-20T10:00:03.000Z", { item: "x" });
    const quoted = thread("q", "2026-11-20T10:00:01.000Z", {
      item: "x",
      quote: "words",
    });
    const adopted = thread("a", "2026-11-20T09:59:30.000Z", {
      item: "x",
      from: { review: "r", thread: "t" },
    });
    const late = thread("l", "2026-11-20T10:02:00.000Z", { item: "x" });
    expect(workDescriptionThread([late, early, marked], item)?.id).toBe("m");
    expect(
      workDescriptionThread([late, quoted, adopted, early], item)?.id,
    ).toBe("e");
    expect(workDescriptionThread([late, quoted, adopted], item)).toBeNull();
    expect(workDescriptionThread([early], { createdAt: "nope" })).toBeNull();
  });
});

describe("work store", () => {
  test("keeps items and projects across reopen, with a history line per change", () => {
    const where = dir();
    const store = openWorkStore(where);
    store.saveProject({
      id: "roamgate",
      name: "roamgate",
      roots: [{ connectionId: "local", path: "/r" }],
      done: { kind: "deployed" },
      coordinator: { session: "desktop/w35:p1" },
    });
    store.saveItem(
      {
        id: "0123456789abcdef",
        project: "roamgate",
        title: "Fix the thing",
        state: "open",
        tags: ["reviews"],
        links: [],
        createdAt: "2026-11-20T10:00:00.000Z",
        updatedAt: "2026-11-20T10:00:00.000Z",
        by: "user",
      },
      { state: "open" },
    );
    const again = openWorkStore(where);
    expect(again.projects().map((p) => p.id)).toEqual(["roamgate"]);
    expect(again.project("roamgate")?.coordinator).toEqual({
      session: "desktop/w35:p1",
    });
    expect(again.item("0123456789abcdef")?.title).toBe("Fix the thing");
    expect(again.find("01234567")?.id).toBe("0123456789abcdef");
    expect(again.find("0123")).toBeUndefined();
    const history = readFileSync(join(where, "history.jsonl"), "utf8");
    expect(JSON.parse(history.trim()).change).toEqual({ state: "open" });
    expect(existsSync(join(where, "work.json"))).toBe(true);
  });

  test("a broken file reads as empty and is not overwritten until saved", () => {
    const where = dir();
    const bad = join(where, "work.json");
    Bun.write(bad, "{not json");
    const store = openWorkStore(where);
    expect(store.items()).toEqual([]);
    expect(store.projects()).toEqual([]);
  });

  test("parses states, owners and links, refusing what is not one", () => {
    expect(parseWorkState("for you")).toBe("you");
    expect(parseWorkState("doing")).toBe("doing");
    expect(() => parseWorkState("later")).toThrow(WorkError);
    expect(parseWorkOwner("desktop/w35:p1")).toEqual({
      session: "desktop/w35:p1",
    });
    expect(parseWorkOwner({ session: "desktop/w35:p1", task: "a1b2" })).toEqual(
      {
        session: "desktop/w35:p1",
        task: "a1b2",
      },
    );
    expect(() => parseWorkOwner("nowhere")).toThrow(/CONNECTION\/PANE/);
    expect(
      parseWorkLink({ kind: "commit", sha: "ABCDEF1", subject: "x" }),
    ).toEqual({ kind: "commit", sha: "abcdef1", subject: "x" });
    expect(() => parseWorkLink({ kind: "commit", sha: "zz" })).toThrow(
      WorkError,
    );
    expect(() => parseWorkLink({ kind: "pr", url: "ftp://x" })).toThrow(
      WorkError,
    );
    expect(
      parseWorkLink({ kind: "decision", path: "rfcs/0052.md", id: "D13" }),
    ).toEqual({ kind: "decision", path: "rfcs/0052.md", id: "D13" });
    expect(() => parseWorkLink({ kind: "what" })).toThrow(/link kind/);
  });

  test("merges links by place: one commit per sha, one review thread each", () => {
    const merged = mergeWorkLinks(
      [{ kind: "commit", sha: "abcdef1" }],
      [
        { kind: "commit", sha: "abcdef1", subject: "same" },
        { kind: "review", id: "r1", thread: "t1" },
        { kind: "review", id: "r1", thread: "t1" },
      ],
    );
    expect(merged).toEqual([
      { kind: "commit", sha: "abcdef1" },
      { kind: "review", id: "r1", thread: "t1" },
    ]);
  });
});

describe("work shared helpers", () => {
  test("reads the TODO title line: **state** Title", () => {
    expect(parseWorkTitle("**doing** Fix the keys\nmore")).toEqual({
      state: "doing",
      title: "Fix the keys",
    });
    expect(parseWorkTitle("**you**: Decide the color")).toEqual({
      state: "you",
      title: "Decide the color",
    });
    expect(parseWorkTitle("**For-you** Something")).toEqual({
      state: "you",
      title: "Something",
    });
    expect(parseWorkTitle("Plain first line")).toEqual({
      state: null,
      title: "Plain first line",
    });
    expect(parseWorkTitle("**bold** not a state")).toEqual({
      state: null,
      title: "**bold** not a state",
    });
  });

  test("normalizes tags and filters items by project, tags and state", () => {
    expect(
      normalizeWorkTags(["Reviews", " voice calls ", "#android", "reviews"]),
    ).toEqual(["reviews", "voice-calls", "android"]);
    const items = [
      item("a", {
        project: "roamgate",
        tags: ["reviews", "phone"],
        state: "you",
      }),
      item("b", { project: "roamgate", tags: ["voice"], state: "doing" }),
      item("c", { project: "gst2", tags: ["reviews"], state: "open" }),
    ];
    expect(
      filterWorkItems(items, { project: "roamgate" }).map((i) => i.id),
    ).toEqual(["a", "b"]);
    expect(
      filterWorkItems(items, { tags: ["reviews"] }).map((i) => i.id),
    ).toEqual(["a", "c"]);
    expect(
      filterWorkItems(items, { tags: ["reviews", "phone"] }).map((i) => i.id),
    ).toEqual(["a"]);
    expect(
      filterWorkItems(items, { states: ["doing", "open"] }).map((i) => i.id),
    ).toEqual(["b", "c"]);
    expect(
      filterWorkItems(items, { query: "title b" }).map((i) => i.id),
    ).toEqual(["b"]);
    expect(workTagsOf(items)).toEqual(["reviews", "phone", "voice"]);
  });
});

function item(
  id: string,
  over: Partial<Parameters<typeof filterWorkItems>[0][number]>,
) {
  return {
    id,
    project: "roamgate",
    title: `title ${id}`,
    state: "open" as const,
    tags: [],
    links: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    by: "user" as const,
    ...over,
  };
}
