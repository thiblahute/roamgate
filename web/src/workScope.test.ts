import { expect, test } from "bun:test";
import type { WorkItem, WorkProject } from "../../shared/work";
import {
  projectForWorkspace,
  readWorkScopeMemory,
  rememberWorkScope,
  type WorkWorkspace,
  workScopeFor,
  workTagCounts,
  workTopTags,
  workspaceScopeKey,
} from "./workScope";

const projects: WorkProject[] = [
  {
    id: "gst2",
    name: "gst2",
    roots: [
      { connectionId: "desktop", path: "/home/me/gstreamer/2.0/gstreamer" },
      { connectionId: "desktop", path: "/home/me/gstreamer/2.0" },
    ],
    done: {
      kind: "branch",
      root: "/home/me/gstreamer/2.0/gstreamer",
      branch: "main",
    },
  },
  {
    id: "roamgate",
    name: "roamgate",
    roots: [{ connectionId: "desktop", path: "/home/me/misc/roamgate" }],
    done: { kind: "deployed" },
  },
];

function workspace(
  checkoutPath: string,
  repoRoot: string | null = null,
  connectionId = "desktop",
): WorkWorkspace {
  return {
    connectionId,
    workspaceId: "w1",
    label: checkoutPath.split("/").pop() ?? checkoutPath,
    checkoutPath,
    repoRoot,
  };
}

function item(
  id: string,
  project: string,
  tags: string[],
  state: WorkItem["state"] = "open",
): WorkItem {
  return {
    id,
    project,
    title: id,
    state,
    tags,
    links: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    by: "user",
  };
}

test("a workspace's project is the one whose root holds its checkout, a linked worktree by its repository", () => {
  expect(
    projectForWorkspace(workspace("/home/me/gstreamer/2.0/gst2-caps"), projects)
      ?.id,
  ).toBe("gst2");
  expect(
    projectForWorkspace(
      workspace(
        "/home/me/misc/roamgate.worktrees/work-view",
        "/home/me/misc/roamgate",
      ),
      projects,
    )?.id,
  ).toBe("roamgate");
  // Not a prefix of the path's words: roamgate.worktrees is not roamgate.
  expect(
    projectForWorkspace(
      workspace("/home/me/misc/roamgate.worktrees/work-view"),
      projects,
    ),
  ).toBeNull();
  // Another connection's same path is another checkout.
  expect(
    projectForWorkspace(
      workspace("/home/me/misc/roamgate", null, "mac"),
      projects,
    ),
  ).toBeNull();
  expect(projectForWorkspace(null, projects)).toBeNull();
});

test("the scope: the item's project, else the workspace's choice, its project, the last choice, all", () => {
  const memory = { byWorkspace: {} };
  const gst = workspace("/home/me/gstreamer/2.0/gst2-caps");
  expect(workScopeFor({ workspace: gst, projects, memory })).toEqual({
    scope: "gst2",
    why: "workspace",
  });
  expect(
    workScopeFor({
      workspace: gst,
      projects,
      memory,
      item: item("i1", "roamgate", []),
    }),
  ).toEqual({ scope: "roamgate", why: "item" });
  const chosenAll = { byWorkspace: { [workspaceScopeKey(gst)]: "all" } };
  expect(workScopeFor({ workspace: gst, projects, memory: chosenAll })).toEqual(
    {
      scope: null,
      why: "chosen",
    },
  );
  const chosenOther = {
    byWorkspace: { [workspaceScopeKey(gst)]: "roamgate" },
  };
  expect(
    workScopeFor({ workspace: gst, projects, memory: chosenOther }),
  ).toEqual({ scope: "roamgate", why: "chosen" });
  // A choice of a project gone since is not one.
  const chosenGone = { byWorkspace: { [workspaceScopeKey(gst)]: "old" } };
  expect(
    workScopeFor({ workspace: gst, projects, memory: chosenGone }),
  ).toEqual({ scope: "gst2", why: "workspace" });
  // A workspace in no project, and no workspace: the last choice, else all.
  const elsewhere = workspace("/home/me/other");
  expect(workScopeFor({ workspace: elsewhere, projects, memory })).toEqual({
    scope: null,
    why: "all",
  });
  expect(
    workScopeFor({
      workspace: elsewhere,
      projects,
      memory: { last: "gst2", byWorkspace: {} },
    }),
  ).toEqual({ scope: "gst2", why: "last" });
  expect(
    workScopeFor({
      workspace: null,
      projects,
      memory: { last: "all", byWorkspace: {} },
    }),
  ).toEqual({ scope: null, why: "last" });
  expect(workScopeFor({ workspace: null, projects, memory })).toEqual({
    scope: null,
    why: "all",
  });
});

test("a choice is remembered for the workspace and as the last one", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const gst = workspace("/home/me/gstreamer/2.0/gst2-caps");
  let memory = readWorkScopeMemory(storage);
  expect(memory).toEqual({ byWorkspace: {} });
  memory = rememberWorkScope(memory, gst, null, storage);
  memory = rememberWorkScope(memory, null, "roamgate", storage);
  expect(readWorkScopeMemory(storage)).toEqual({
    last: "roamgate",
    byWorkspace: { [workspaceScopeKey(gst)]: "all" },
  });
  expect(workScopeFor({ workspace: gst, projects, memory })).toEqual({
    scope: null,
    why: "chosen",
  });
  expect(workScopeFor({ workspace: null, projects, memory })).toEqual({
    scope: "roamgate",
    why: "last",
  });
  // Garbage in the storage is no memory.
  storage.setItem("roamgate.work.scope", "{not json");
  expect(readWorkScopeMemory(storage)).toEqual({ byWorkspace: {} });
  storage.setItem(
    "roamgate.work.scope",
    '{"last":3,"byWorkspace":{"a":1,"b":"gst2"}}',
  );
  expect(readWorkScopeMemory(storage)).toEqual({ byWorkspace: { b: "gst2" } });
});

test("the tags by count, and the row's top tags without the selected ones", () => {
  const items = [
    item("a", "gst2", ["caps", "pads", "docs"]),
    item("b", "gst2", ["caps", "rfc-0047"]),
    item("c", "gst2", ["caps", "pads"]),
    item("d", "gst2", ["bin"], "done"),
  ];
  expect(workTagCounts(items)).toEqual([
    { tag: "caps", count: 3 },
    { tag: "pads", count: 2 },
    { tag: "bin", count: 1 },
    { tag: "docs", count: 1 },
    { tag: "rfc-0047", count: 1 },
  ]);
  expect(workTopTags(workTagCounts(items), ["pads"], 3)).toEqual([
    "caps",
    "bin",
    "docs",
  ]);
  expect(workTopTags(workTagCounts(items), [])).toHaveLength(5);
  const many = Array.from({ length: 20 }, (_, index) =>
    item(`m${index}`, "gst2", [`tag-${index}`]),
  );
  expect(workTopTags(workTagCounts(many), [])).toHaveLength(8);
});
