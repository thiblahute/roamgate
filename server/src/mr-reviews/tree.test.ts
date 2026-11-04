import { describe, expect, test } from "bun:test";
import type { WorkspaceTree } from "../../../shared/workspaceTree";
import { reviewPlacementOps } from "./tree";

const ref = {
  connection_id: "desktop",
  path: "/src/gst.worktrees/review",
  label: "Reviews · gstreamer",
};
let n = 0;
const newId = () => `new${++n}`;

const tree: WorkspaceTree = {
  version: 1,
  nodes: [
    {
      id: "gst",
      kind: "workspace",
      parent: null,
      ref: { connection_id: "desktop", path: "/src/gst", label: "gst" },
    },
    {
      id: "gstMac",
      kind: "workspace",
      parent: null,
      ref: { connection_id: "local", path: "/Users/me/gst", label: "gst" },
    },
    { id: "rev", kind: "group", parent: "gst", label: "reviews" },
    { id: "up", kind: "group", parent: "gst", label: "upstreaming" },
  ],
};

describe("review workspace placement", () => {
  test("a set path reuses what exists, by name, case-insensitively", () => {
    expect(
      reviewPlacementOps(
        tree,
        {
          ref,
          connectionId: "desktop",
          clonePath: "/src/gst",
          path: ["GST", "Reviews"],
        },
        newId,
      ),
    ).toEqual([
      { op: "move", subject: { workspace: ref }, parent: { node: "rev" } },
    ]);
  });

  test("missing groups of a set path are created", () => {
    n = 0;
    expect(
      reviewPlacementOps(
        tree,
        {
          ref,
          connectionId: "desktop",
          clonePath: "/x",
          path: ["gst", "reviews", "rs"],
        },
        newId,
      ),
    ).toEqual([
      { op: "create_group", id: "new1", label: "rs", parent: { node: "rev" } },
      { op: "move", subject: { workspace: ref }, parent: { node: "new1" } },
    ]);
    n = 0;
    expect(
      reviewPlacementOps(
        tree,
        {
          ref,
          connectionId: "desktop",
          clonePath: "/x",
          path: ["Work", "Reviews"],
        },
        newId,
      ),
    ).toEqual([
      {
        op: "create_group",
        id: "new1",
        label: "Work",
        parent: { root: "top" },
      },
      {
        op: "create_group",
        id: "new2",
        label: "Reviews",
        parent: { node: "new1" },
      },
      { op: "move", subject: { workspace: ref }, parent: { node: "new2" } },
    ]);
  });

  test("by default: a Reviews group under the clone's workspace, else at the top", () => {
    n = 0;
    expect(
      reviewPlacementOps(
        tree,
        { ref, connectionId: "desktop", clonePath: "/src/gst" },
        newId,
      ),
    ).toEqual([
      { op: "move", subject: { workspace: ref }, parent: { node: "rev" } },
    ]);
    expect(
      reviewPlacementOps(
        tree,
        { ref, connectionId: "desktop", clonePath: "/elsewhere" },
        newId,
      ),
    ).toEqual([
      {
        op: "create_group",
        id: "new1",
        label: "Reviews",
        parent: { root: "top" },
      },
      { op: "move", subject: { workspace: ref }, parent: { node: "new1" } },
    ]);
  });
});
