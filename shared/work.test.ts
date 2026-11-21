import { expect, test } from "bun:test";
import {
  filterWorkItems,
  normalizeWorkAnswers,
  parseWorkQuery,
  provisionalWorkTitle,
  readableWorkLink,
  summarizeWorkLinks,
  type WorkItem,
  type WorkLink,
  workPrRef,
  workQueryWithTag,
  workAskOf,
  workStateAsks,
  workTagCompletions,
  type WorkProject,
  workPlaceScope,
  workPlaceTagFor,
  workProjectFamily,
  workProjectForPaths,
  workProjectTree,
  workTagLabel,
  workTopProject,
  workWorkspaceTag,
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
    owners: [],
  });
  // The tag still being typed: the tags it begins.
  expect(parseWorkQuery("header #vo")).toEqual({
    words: ["header"],
    tags: [],
    owners: [],
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

test("owner:ADDRESS keeps the items that session owns, its subagents' too", () => {
  expect(parseWorkQuery("owner:desktop/w36:p2 header").owners).toEqual([
    "desktop/w36:p2",
  ]);
  const items: WorkItem[] = [
    { ...item("1", "Header", []), owner: { session: "desktop/w36:p2" } },
    {
      ...item("2", "Footer", []),
      owner: { session: "desktop/w36:p2", task: "a1b2" },
    },
    { ...item("3", "Header", []), owner: { session: "desktop/w35:p1" } },
    item("4", "Header", []),
  ];
  const ids = (query: string) =>
    filterWorkItems(items, { query }).map((each) => each.id);
  expect(ids("owner:desktop/w36:p2 ")).toEqual(["1", "2"]);
  expect(ids("owner:desktop/w36:p2 header")).toEqual(["1"]);
  // The address, not a word: w36 alone is only searched for.
  expect(ids("owner:w36 ")).toEqual([]);
});

test("a chat link: a message chip, and the message it came from", () => {
  const link: WorkLink = {
    kind: "chat",
    session: "desktop/w36:p2",
    chat: "c0ffee",
    entry: "msg-7",
  };
  expect(summarizeWorkLinks([link])).toEqual([
    {
      kind: "chat",
      label: "message",
      count: 1,
      title: "a message in desktop/w36:p2's chat",
    },
  ]);
  expect(readableWorkLink(link, { session: () => "Fix the header" })).toEqual({
    label: "The message it came from",
    detail: "Agent chat of Fix the header (desktop/w36:p2)",
  });
  expect(
    readableWorkLink({ kind: "chat", session: "desktop/w36:p2" }).label,
  ).toBe("The chat it came from");
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

test("a card says what the user has to do only in For you and Verify", () => {
  expect(["you", "verify"].every((s) => workStateAsks(s as never))).toBe(true);
  expect(workStateAsks("doing")).toBe(false);
  const asked = {
    state: "you" as const,
    ask: " Choose: A or B ",
    answers: ["A", "B"],
  };
  expect(workAskOf(asked)).toEqual({
    ask: "Choose: A or B",
    answers: ["A", "B"],
  });
  expect(workAskOf({ ...asked, state: "verify", answers: undefined })).toEqual({
    ask: "Choose: A or B",
    answers: [],
  });
  expect(workAskOf({ ...asked, state: "doing" })).toBeNull();
  // "I will write it" answers are the card's Reply box: not drawn.
  expect(
    workAskOf({
      ...asked,
      answers: [
        "A",
        "Something else (I will write it)",
        "Other",
        "Otherwise B",
      ],
    })?.answers,
  ).toEqual(["A", "Otherwise B"]);
  expect(workAskOf({ state: "you", ask: "  " })).toBeNull();
  expect(workAskOf({ state: "you" })).toBeNull();
});

test("answers: one line each, short, no empty nor repeated ones, 6 at most", () => {
  expect(normalizeWorkAnswers([" Yes ", "yes", "", "No\nway"])).toEqual([
    "Yes",
    "No way",
  ]);
  const long = normalizeWorkAnswers(["x".repeat(200)])[0]!;
  expect(long.length).toBe(80);
  expect(long.endsWith("\u2026")).toBe(true);
  expect(
    normalizeWorkAnswers(["1", "2", "3", "4", "5", "6", "7", "8"]),
  ).toHaveLength(6);
});

const project = (
  id: string,
  roots: string[],
  extra: Partial<WorkProject> = {},
): WorkProject => ({
  id,
  name: id,
  roots: roots.map((path) => ({ connectionId: "desktop", path })),
  done: { kind: "deployed" },
  ...extra,
});

const projects = [
  project("gst2", ["/g/2.0"], {
    parent: "gstreamer",
    coordinator: { session: "desktop/w32:p1" },
  }),
  project("gstreamer", ["/g/gstreamer", "/g"]),
  project("roamgate", ["/r"], { coordinator: { session: "desktop/w35:p1" } }),
  project("gst2-docs", ["/g/2.0/docs"], { parent: "gst2" }),
];

test("a project's family: itself and its subprojects at any depth", () => {
  expect(workProjectFamily(projects, "gstreamer")).toEqual([
    "gstreamer",
    "gst2",
    "gst2-docs",
  ]);
  expect(workProjectFamily(projects, "gst2")).toEqual(["gst2", "gst2-docs"]);
  expect(workProjectFamily(projects, "nope")).toEqual(["nope"]);
  expect(workTopProject(projects, "gst2-docs")).toBe("gstreamer");
  expect(workTopProject(projects, "roamgate")).toBe("roamgate");
  // A cycle stops.
  const cycle = [
    project("a", [], { parent: "b" }),
    project("b", [], { parent: "a" }),
  ];
  expect(workProjectFamily(cycle, "a")).toEqual(["a", "b"]);
  expect(["a", "b"]).toContain(workTopProject(cycle, "a"));
  expect(
    workProjectTree(cycle)
      .map((each) => each.project.id)
      .sort(),
  ).toEqual(["a", "b"]);
  expect(
    workProjectTree(projects).map(
      ({ project, depth }) => `${depth}${project.id}`,
    ),
  ).toEqual(["0gstreamer", "1gst2", "2gst2-docs", "0roamgate"]);
});

test("a path's project: the closest root", () => {
  const at = (path: string) =>
    workProjectForPaths(projects, "desktop", [path])?.id ?? null;
  expect(at("/g/2.0/gst2-video")).toBe("gst2");
  expect(at("/g/2.0/docs/x")).toBe("gst2-docs");
  expect(at("/g/upstreaming/ocio")).toBe("gstreamer");
  expect(at("/g2")).toBeNull();
  expect(workProjectForPaths(projects, "mac", ["/g/2.0"])).toBeNull();
  // The first path a project holds decides.
  expect(
    workProjectForPaths(projects, "desktop", [null, "/x", "/r/w", "/g"])?.id,
  ).toBe("roamgate");
});

test("a workspace's tag: its name as a slug", () => {
  expect(workWorkspaceTag("gst2-video")).toBe("ws:gst2-video");
  expect(workWorkspaceTag("Reviews \u00b7 OpenColorIO")).toBe(
    "ws:reviews-opencolorio",
  );
  expect(workWorkspaceTag("!7031 ges: timeline: synchronize flushing")).toBe(
    "ws:7031-ges-timeline-synchronize-flushin",
  );
  expect(workWorkspaceTag("\u00e9t\u00e9")).toBe("ws:ete");
  expect(workWorkspaceTag("!!")).toBeNull();
  expect(workTagLabel("ws:gst2-video")).toBe("gst2-video");
  expect(workTagLabel("voice")).toBe("voice");
  // Searchable as any tag.
  expect(parseWorkQuery("#ws:gst2-video ").tags).toEqual(["ws:gst2-video"]);
});

test("a workspace's place: coordinator, project, the tag its items get", () => {
  const place = (paneIds: string[], paths: string[], label = "w") => ({
    connectionId: "desktop",
    label,
    paths,
    paneIds,
  });
  const coordinator = workPlaceScope(
    place(["w32:p1"], ["/elsewhere"]),
    projects,
  );
  expect(coordinator?.project.id).toBe("gst2");
  expect(coordinator?.coordinator).toBe(true);
  const video = place(["w36:p1"], ["/g/2.0/gst2-video"], "gst2-video");
  expect(workPlaceScope(video, projects)).toMatchObject({
    project: { id: "gst2" },
    tag: "ws:gst2-video",
    coordinator: false,
  });
  expect(workPlaceScope(place(["x"], ["/nowhere"]), projects)).toBeNull();
  expect(workPlaceTagFor(video, projects, "gst2")).toBe("ws:gst2-video");
  expect(workPlaceTagFor(video, projects, "gstreamer")).toBe("ws:gst2-video");
  expect(workPlaceTagFor(video, projects, "roamgate")).toBeNull();
  expect(
    workPlaceTagFor(place(["w32:p1"], [], "gst2"), projects, "gst2"),
  ).toBeNull();
});

test("a filter by a project's tree", () => {
  const items = [
    { ...item("a", "A", []), project: "gst2" },
    { ...item("b", "B", []), project: "gstreamer" },
    { ...item("c", "C", []), project: "roamgate" },
  ];
  expect(
    filterWorkItems(items, {
      projects: workProjectFamily(projects, "gstreamer"),
    }).map((each) => each.id),
  ).toEqual(["a", "b"]);
});
