import { describe, expect, test } from "bun:test";
import type { WorkspaceTree } from "../../../shared/workspaceTree";
import { subjectsFromSettings } from "./subject-settings";
import { treeExplicitGroups } from "./subject-tree";
import { subjectResolver } from "./subjects";

const ws = (connection_id: string, path: string | null, name = "w") => ({
  connection_id,
  path,
  name,
});

describe("subjects", () => {
  const roots = ["~/devel/clients", "~/devel/gstreamer", "/srv/work/"];
  const subjectOf = subjectResolver({ roots, home: "/Users/me" });

  test("the first folder under a root is the subject, on any host's home", () => {
    expect(
      subjectOf(
        ws("local", "/Users/me/devel/clients/sequence/cloud-project-system"),
      ),
    ).toEqual({
      id: "dir:~/devel/clients/sequence",
      label: "sequence",
      source: "directory",
      path: "/Users/me/devel/clients/sequence",
      groups: [
        { id: "dir:~/devel/clients", label: "clients" },
        { id: "dir:~/devel/clients/sequence", label: "sequence" },
      ],
    });
    // Another host's home: the same subject, by id and label.
    const remote = subjectOf(
      ws("desktop", "/var/home/me/devel/clients/sequence/cps-iga-184"),
    );
    expect(remote?.id).toBe("dir:~/devel/clients/sequence");
    expect(remote?.path).toBe("/var/home/me/devel/clients/sequence");
    expect(
      subjectOf(ws("box", "/home/me/devel/gstreamer/2.0/gst2"))?.label,
    ).toBe("2.0");
    expect(subjectOf(ws("box", "/srv/work/olmo"))?.id).toBe(
      "dir:/srv/work/olmo",
    );
  });

  test("worktrees are grouped by folder, never by their repository", () => {
    // gstreamer-ocio is a worktree of gstreamer: its own folder, its own subject.
    expect(
      subjectOf(ws("desktop", "/var/home/me/devel/gstreamer/gstreamer-ocio"))
        ?.label,
    ).toBe("gstreamer-ocio");
    expect(
      subjectOf(ws("desktop", "/var/home/me/devel/gstreamer/gstreamer"))?.label,
    ).toBe("gstreamer");
  });

  test("a root itself, a path outside every root or no path has no subject", () => {
    expect(subjectOf(ws("local", "/Users/me/devel/clients"))).toBeNull();
    expect(subjectOf(ws("local", "/Users/me/devel/clientsx/a"))).toBeNull();
    expect(subjectOf(ws("local", "/tmp/x"))).toBeNull();
    expect(subjectOf(ws("local", null))).toBeNull();
    expect(subjectResolver({ roots: [] })(ws("local", "/a/b"))).toBeNull();
  });

  test("the deepest root wins when roots nest", () => {
    const nested = subjectResolver({
      roots: ["~/devel", "~/devel/clients"],
      home: "/Users/me",
    });
    expect(nested(ws("local", "/Users/me/devel/clients/sequence"))?.label).toBe(
      "sequence",
    );
    expect(nested(ws("local", "/Users/me/devel/misc/roamgate"))?.label).toBe(
      "misc",
    );
  });

  test("a group of the Workspaces tree wins over the folder", () => {
    const tree: WorkspaceTree = {
      version: 1,
      nodes: [
        { id: "g1", kind: "group", parent: null, label: "upstreaming" },
        { id: "g2", kind: "group", parent: "g1", label: "ocio" },
        {
          id: "w1",
          kind: "workspace",
          parent: null,
          ref: {
            connection_id: "desktop",
            path: "/var/home/me/devel/gstreamer/gstreamer-ocio",
          },
        },
        {
          id: "w2",
          kind: "workspace",
          parent: "w1",
          ref: {
            connection_id: "desktop",
            path: "/var/home/me/devel/gstreamer/upstreaming/ocio-plugin",
          },
        },
        {
          id: "w3",
          kind: "workspace",
          parent: "g2",
          ref: {
            connection_id: "desktop",
            path: "/var/home/me/devel/gstreamer/upstreaming/ocio-tests",
          },
        },
        {
          id: "w4",
          kind: "workspace",
          parent: "g1",
          ref: { connection_id: "local", label: "notes" },
        },
      ],
    };
    const resolve = subjectResolver({
      roots,
      home: "/Users/me",
      explicit: treeExplicitGroups(tree),
    });
    expect(
      resolve(
        ws("desktop", "/var/home/me/devel/gstreamer/upstreaming/ocio-tests"),
      ),
    ).toEqual({
      id: "tree:g2",
      label: "ocio",
      source: "explicit",
      path: null,
      groups: [
        { id: "tree:g1", label: "upstreaming" },
        { id: "tree:g2", label: "ocio" },
      ],
    });
    // Under a workspace, not a group: the folder decides.
    expect(
      resolve(
        ws("desktop", "/var/home/me/devel/gstreamer/upstreaming/ocio-plugin"),
      ),
    ).toMatchObject({ source: "directory", label: "upstreaming" });
    // A workspace with no path is found by its name.
    expect(resolve(ws("local", null, "notes"))?.id).toBe("tree:g1");
    // Same path on another connection is another workspace.
    expect(
      resolve(
        ws("local", "/var/home/me/devel/gstreamer/upstreaming/ocio-tests"),
      )?.source,
    ).toBe("directory");
  });

  test("settings.json gives both sources", () => {
    const subjectOf = subjectsFromSettings({
      activity: { subject_roots: ["/srv/work"] },
      workspace_tree: {
        version: 1,
        nodes: [
          { id: "g1", kind: "group", parent: null, label: "clients" },
          {
            id: "w1",
            kind: "workspace",
            parent: "g1",
            ref: { connection_id: "local", path: "/srv/work/a" },
          },
        ],
      },
    });
    expect(subjectOf(ws("local", "/srv/work/a"))?.label).toBe("clients");
    expect(subjectOf(ws("local", "/srv/work/b"))?.label).toBe("b");
    expect(
      subjectsFromSettings(undefined)(ws("local", "/srv/work/b")),
    ).toBeNull();
  });
});
