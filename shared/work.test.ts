import { expect, test } from "bun:test";
import {
  filterWorkItems,
  parseWorkQuery,
  provisionalWorkTitle,
  readableWorkLink,
  summarizeWorkLinks,
  type WorkItem,
  type WorkLink,
  workPrRef,
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

// The item behind the user's screenshot (2026-11-21): six links drawn as
// six boxes of raw ids on the card.
const upstreamed: WorkLink[] = [
  { kind: "review", id: "d22a2f86aaaaaaaa", thread: "cf35a5acbbbbbbbb" },
  { kind: "effort", id: "emwqgkha97zmf" },
  { kind: "branch", name: "webrtc-signaller-tls-verify", root: "/src/gst" },
  { kind: "branch", name: "webrtcsrc-no-decodebin3-panic", root: "/src/gst" },
  {
    kind: "commit",
    sha: "f9b1e8695000000000",
    subject: "webrtc: Verify the signalling server's certificate",
    root: "/src/gst-plugins-rs/",
  },
  {
    kind: "commit",
    sha: "62d3530630000000",
    subject: "webrtcsrc: Post an error",
  },
];

test("a card's links: a chip per kind with its count, no raw ids", () => {
  const chips = summarizeWorkLinks(upstreamed);
  expect(chips.map((chip) => chip.label)).toEqual([
    "effort",
    "thread",
    "2 branches",
    "2 commits",
  ]);
  expect(chips.map((chip) => chip.count)).toEqual([1, 1, 2, 2]);
  const said = chips.map((chip) => `${chip.label} ${chip.title}`).join("\n");
  for (const id of ["d22a2f86", "cf35a5ac", "emwqgkha97zmf", "f9b1e8695"])
    expect(said).not.toContain(id);
  expect(chips[2]!.title).toBe(
    "webrtc-signaller-tls-verify\nwebrtcsrc-no-decodebin3-panic",
  );
  // A request says its number; several say how many.
  const mr =
    "https://gitlab.freedesktop.org/gstreamer/gstreamer/-/merge_requests/123";
  expect(summarizeWorkLinks([{ kind: "pr", url: mr }])[0]!.label).toBe(
    "PR !123",
  );
  expect(
    summarizeWorkLinks([
      { kind: "pr", url: mr },
      { kind: "pr", url: "https://github.com/o/r/pull/7" },
    ])[0]!.label,
  ).toBe("2 PRs");
  expect(summarizeWorkLinks([])).toEqual([]);
});

test("a request's number as its forge writes it", () => {
  expect(workPrRef("https://gitlab.com/a/b/-/merge_requests/42")).toBe("!42");
  expect(workPrRef("https://github.com/a/b/pull/9")).toBe("#9");
  expect(workPrRef("https://example.com/x")).toBeNull();
});

test("the detail's links: labels one reads, named from what the page knows", () => {
  const names = {
    effort: (id: string) =>
      id === "emwqgkha97zmf" ? "gst-plugins-rs webrtc fixes" : undefined,
    review: () => ({ title: "Work board", thread: "Upstream these two" }),
  };
  expect(upstreamed.map((link) => readableWorkLink(link, names))).toEqual([
    { label: '"Upstream these two"', detail: "Thread in Work board" },
    { label: "gst-plugins-rs webrtc fixes", detail: "Upstreaming effort" },
    { label: "webrtc-signaller-tls-verify", detail: "Branch in gst" },
    { label: "webrtcsrc-no-decodebin3-panic", detail: "Branch in gst" },
    {
      label: "webrtc: Verify the signalling server's certificate",
      detail: "Commit f9b1e86950 in gst-plugins-rs",
    },
    { label: "webrtcsrc: Post an error", detail: "Commit 62d3530630" },
  ]);
  // Nothing known: still words, not ids.
  expect(readableWorkLink(upstreamed[0]!)).toEqual({
    label: "The review thread",
    detail: "Thread in a review",
  });
  expect(readableWorkLink(upstreamed[1]!).label).toBe("An upstreaming effort");
  expect(
    readableWorkLink(
      { kind: "pr", url: "https://github.com/o/r/pull/7" },
      { pr: () => "Fix the caps" },
    ),
  ).toEqual({ label: "Fix the caps", detail: "Pull request #7 on github.com" });
  expect(
    readableWorkLink({
      kind: "pr",
      url: "https://gitlab.com/a/-/merge_requests/3",
    }),
  ).toEqual({ label: "Request !3", detail: "Merge request on gitlab.com" });
});
