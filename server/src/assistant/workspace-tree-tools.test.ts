import { describe, expect, test } from "bun:test";
import {
  applyWorkspaceTreeOp,
  emptyWorkspaceTree,
  type WorkspaceTree,
  type WorkspaceTreeOp,
} from "../../../shared/workspaceTree";
import { createRangerMcp } from "./claude-mcp";
import { rangerTools } from "./ranger-tools";
import {
  callWorkspaceTreeTool,
  createWorkspaceTreeToolHandler,
  type TreeToolConnection,
  type TreeToolWorkspace,
  workspaceTreeTools,
} from "./workspace-tree-tools";

function workspace(
  workspace_id: string,
  label: string,
  path: string,
  extra: { linked?: boolean; branch?: string; number?: number } = {},
): TreeToolWorkspace {
  return {
    workspace_id,
    label,
    number: extra.number ?? Number(workspace_id.slice(1)),
    cwd: path,
    worktree: {
      repo_key: "gst",
      repo_name: "gstreamer",
      checkout_path: path,
      is_linked_worktree: extra.linked ?? true,
      git_status: { branch: extra.branch ?? label },
    },
  };
}

function connections(): TreeToolConnection[] {
  return [
    {
      connection_id: "desktop",
      label: "Desktop",
      state: "ready",
      workspaces: [
        workspace("w1", "gstreamer", "/src/gstreamer", {
          linked: false,
          branch: "main",
        }),
        workspace("w2", "gstreamer-ocio-a", "/src/gstreamer-ocio-a"),
        workspace("w3", "gstreamer-ocio-b", "/src/gstreamer-ocio-b"),
      ],
    },
    {
      connection_id: "laptop",
      label: "Laptop",
      state: "ready",
      workspaces: [workspace("w1", "ocio-c", "/home/me/ocio-c")],
    },
    { connection_id: "nas", label: "NAS", state: "offline", workspaces: [] },
  ];
}

/** The server store in memory: one write per apply, as the real one. */
function setup(initial: WorkspaceTree = emptyWorkspaceTree()) {
  const store = {
    tree: initial,
    writes: 0,
    batches: [] as WorkspaceTreeOp[][],
  };
  const handle = createWorkspaceTreeToolHandler({
    connections: async () => connections(),
    read: async () => store.tree,
    apply: async (ops) => {
      let tree = store.tree;
      for (const op of ops) tree = applyWorkspaceTreeOp(tree, op);
      store.tree = tree;
      store.writes += 1;
      store.batches.push(ops);
      return tree;
    },
  });
  const call = async (name: string, params: unknown) =>
    JSON.parse(
      (await callWorkspaceTreeTool(name, params, handle)).text,
    ) as Record<string, any>;
  const get = () => call("workspace_tree_get", {});
  return { store, handle, call, get };
}

const ocioA = { connection_id: "desktop", path: "/src/gstreamer-ocio-a" };
const ocioB = { connection_id: "desktop", workspace_id: "w3" };
const ocioC = { connection_id: "laptop", workspace_id: "w1" };

describe("Ranger's Workspaces arrangement tools", () => {
  test("get lists every workspace on every connection with its place", async () => {
    const { get } = setup();
    const view = await get();
    expect(view.connections).toEqual([
      { connection_id: "desktop", label: "Desktop", state: "ready" },
      { connection_id: "laptop", label: "Laptop", state: "ready" },
      { connection_id: "nas", label: "NAS", state: "offline" },
    ]);
    expect(view.workspaces).toHaveLength(4);
    expect(view.workspaces[1]).toEqual({
      connection_id: "desktop",
      workspace_id: "w2",
      label: "gstreamer-ocio-a",
      path: "/src/gstreamer-ocio-a",
      branch: "gstreamer-ocio-a",
      repository: "gstreamer",
      usually_under: { workspace_id: "w1", label: "gstreamer" },
      placement: "usual",
      herdr_number: 2,
    });
    expect(view.groups).toEqual([]);
    expect(view.outline).toContain("Nothing is arranged");
  });

  test("move nests workspaces under another, across connections, in one write", async () => {
    const { call, get, store } = setup();
    const result = await call("workspace_tree_move", {
      moves: [
        {
          items: [ocioC, ocioB],
          to: { connection_id: "desktop", workspace_id: "w2" },
        },
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      'Moved "ocio-c" (laptop) from its usual place to under "gstreamer-ocio-a" (desktop) (position 0 of 2).',
      'Moved "gstreamer-ocio-b" (desktop) from its usual place to under "gstreamer-ocio-a" (desktop) (position 1 of 2).',
    ]);
    expect(store.writes).toBe(1);
    const view = await get();
    const laptop = view.workspaces.find(
      (each: any) => each.connection_id === "laptop",
    );
    expect(laptop).toMatchObject({
      placement: "under",
      parent: {
        connection_id: "desktop",
        workspace_id: "w2",
        label: "gstreamer-ocio-a",
      },
      position: 0,
    });
    expect(view.outline).toContain(
      "  gstreamer-ocio-a (desktop/w2)\n    ocio-c (laptop/w1)\n    gstreamer-ocio-b (desktop/w3)",
    );
  });

  test("move to the top level, at a position, and back to the usual place", async () => {
    const { call, get, store } = setup();
    await call("workspace_tree_move", {
      moves: [
        { items: [ocioA, ocioB], to: { root: "top" } },
        { items: [ocioC], to: { root: "top" }, before: ocioB },
        {
          items: [{ connection_id: "desktop", workspace_id: "w1" }],
          to: { root: "bottom" },
        },
      ],
    });
    expect(store.writes).toBe(1);
    let view = await get();
    const top = view.workspaces
      .filter((each: any) => each.placement === "top")
      .sort((a: any, b: any) => a.position - b.position)
      .map((each: any) => each.label);
    expect(top).toEqual(["gstreamer-ocio-a", "ocio-c", "gstreamer-ocio-b"]);
    expect(view.workspaces[0].placement).toBe("bottom");

    await call("workspace_tree_move", {
      moves: [{ items: [ocioA], to: { root: "top" }, after: ocioB }],
    });
    view = await get();
    expect(
      view.workspaces
        .filter((each: any) => each.placement === "top")
        .sort((a: any, b: any) => a.position - b.position)
        .map((each: any) => each.label),
    ).toEqual(["ocio-c", "gstreamer-ocio-b", "gstreamer-ocio-a"]);

    const result = await call("workspace_tree_move", {
      moves: [{ items: [ocioC], to: { usual: true } }],
    });
    expect(result.changes).toEqual([
      'Moved "ocio-c" (laptop) from the top level, above the list to its usual place.',
    ]);
    view = await get();
    expect(
      view.workspaces.find((each: any) => each.connection_id === "laptop")
        .placement,
    ).toBe("usual");
  });

  test("a position in Herdr's order is noted, not applied", async () => {
    const { call } = setup();
    const result = await call("workspace_tree_move", {
      moves: [{ items: [ocioA], to: { root: "list" }, position: 0 }],
    });
    expect(result.changed).toBe(true);
    expect(result.notes[0]).toContain("follow Herdr's order");
  });

  test("group create takes its children in the same change", async () => {
    const { call, get, store } = setup();
    const result = await call("workspace_tree_group", {
      actions: [
        { action: "create", label: "OCIO", children: [ocioA, ocioB, ocioC] },
      ],
    });
    expect(store.writes).toBe(1);
    expect(result.groups_created).toEqual([
      { group: expect.stringMatching(/^g/), label: "OCIO" },
    ]);
    expect(result.changes[0]).toMatch(
      /^Created group "OCIO" \(g\w+\) in the top level, above the list\.$/,
    );
    expect(result.changes).toHaveLength(4);
    const view = await get();
    expect(view.groups).toEqual([
      {
        group: result.groups_created[0].group,
        label: "OCIO",
        placement: "top",
        position: 0,
        children: 3,
      },
    ]);
    expect(
      view.workspaces.filter((each: any) => each.parent?.label === "OCIO"),
    ).toHaveLength(3);
  });

  test("group rename, collapse, nesting by name and delete moving children up", async () => {
    const { call, get } = setup();
    await call("workspace_tree_group", {
      actions: [
        { action: "create", label: "Upstream" },
        {
          action: "create",
          label: "OCIO",
          parent: { group: "upstream" },
          children: [ocioA],
        },
        { action: "collapse", group: "OCIO" },
      ],
    });
    let view = await get();
    const ocio = view.groups.find((each: any) => each.label === "OCIO");
    expect(ocio).toMatchObject({
      placement: "under",
      parent: { label: "Upstream" },
      collapsed: true,
    });

    const renamed = await call("workspace_tree_group", {
      actions: [
        { action: "rename", group: ocio.group, label: "Color" },
        { action: "expand", group: "Color" },
      ],
    });
    expect(renamed.changes).toEqual([
      'Renamed group "OCIO" to "Color".',
      'Expanded group "Color".',
    ]);

    const deleted = await call("workspace_tree_group", {
      actions: [{ action: "delete", group: "Color" }],
    });
    expect(deleted.changes).toEqual([
      'Deleted group "Color"; its 1 item moved up a level, under group "Upstream".',
    ]);
    view = await get();
    expect(
      view.workspaces.find((each: any) => each.workspace_id === "w2"),
    ).toMatchObject({ placement: "under", parent: { label: "Upstream" } });
  });

  test("refusals name the problem and change nothing", async () => {
    const { call, store } = setup();
    await call("workspace_tree_move", {
      moves: [{ items: [ocioB], to: ocioA }],
    });
    const writes = store.writes;
    const before = store.tree;
    const refuse = (name: string, params: unknown) =>
      call(name, params).then(
        () => {
          throw new Error("expected a refusal");
        },
        (error: Error) => error.message,
      );

    expect(
      await refuse("workspace_tree_move", {
        moves: [{ items: [ocioA], to: ocioB }],
      }),
    ).toBe(
      'Refused to move "gstreamer-ocio-a" (desktop) to "gstreamer-ocio-b" (desktop): A workspace cannot go inside itself or what is under it. Nothing was changed.',
    );
    expect(
      await refuse("workspace_tree_move", {
        moves: [
          { items: [ocioC], to: { root: "top" } },
          { items: [{ workspace_id: "w9" }], to: { root: "top" } },
        ],
      }),
    ).toContain('Unknown workspace: no open workspace matches workspace "w9"');
    expect(
      await refuse("workspace_tree_move", {
        moves: [{ items: [{ workspace_id: "w1" }], to: { root: "top" } }],
      }),
    ).toBe(
      'workspace "w1" matches several workspaces (on desktop, laptop); add connection_id.',
    );
    expect(
      await refuse("workspace_tree_move", {
        moves: [{ items: [{ group: "Nope" }], to: { root: "top" } }],
      }),
    ).toBe('Unknown group "Nope". There are no groups.');
    expect(
      await refuse("workspace_tree_move", {
        moves: [{ items: [ocioC], to: { root: "top", usual: true } }],
      }),
    ).toContain("exactly one of");
    expect(
      await refuse("workspace_tree_move", {
        moves: [
          {
            items: [{ connection_id: "mars", path: "/x" }],
            to: { root: "top" },
          },
        ],
      }),
    ).toBe('Unknown connection "mars". Connections: desktop, laptop, nas.');
    expect(
      await refuse("workspace_tree_group", {
        actions: [{ action: "delete", group: "Nope" }],
      }),
    ).toContain('Unknown group "Nope"');
    expect(await refuse("workspace_tree_move", { moves: [], extra: 1 })).toBe(
      "Invalid workspace tree tool parameters.",
    );
    expect(store.writes).toBe(writes);
    expect(store.tree).toBe(before);
  });

  test("the tools are in Ranger's MCP list, executing directly in manual mode", async () => {
    const { handle, store } = setup();
    const tools = rangerTools(
      {
        read: async () => ({ text: "{}" }),
        arrange: handle,
      },
      false,
    );
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(workspaceTreeTools.map((tool) => tool.name)),
    );
    // No proposer was given: arranging never goes through confirmation.
    expect(names.some((name) => name.startsWith("propose_"))).toBe(false);
    for (const tool of tools.filter((each) =>
      each.name.startsWith("workspace_tree_"),
    ))
      expect(tool.description).not.toContain("pending proposal");

    const mcp = createRangerMcp(() => ({
      url: "http://127.0.0.1:1/mcp",
      stop: () => {},
    }));
    const lease = mcp.open({ tools, signal: new AbortController().signal });
    const server = JSON.parse(lease.config).mcpServers.ranger;
    const rpc = async (body: unknown) =>
      (
        await mcp.handle(
          new Request(server.url, {
            method: "POST",
            headers: {
              authorization: server.headers.Authorization,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        )
      ).json();
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listed = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(listed).toEqual(
      expect.arrayContaining([
        "workspace_tree_get",
        "workspace_tree_move",
        "workspace_tree_group",
      ]),
    );
    const called = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "workspace_tree_group",
        arguments: {
          actions: [{ action: "create", label: "OCIO", children: [ocioA] }],
        },
      },
    });
    expect(called.result.isError).toBeUndefined();
    expect(JSON.parse(called.result.content[0].text).changed).toBe(true);
    // Applied at once: no pending action waits for a click.
    expect(store.writes).toBe(1);
    const refused = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "workspace_tree_move",
        arguments: {
          moves: [{ items: [{ workspace_id: "w9" }], to: { root: "top" } }],
        },
      },
    });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("Unknown workspace");
    lease.close();
  });

  test("tree tools are absent without a handler, and moves run one at a time", () => {
    const read = async () => ({ text: "{}" });
    expect(
      rangerTools({ read }, true).some((tool) =>
        tool.name.startsWith("workspace_tree_"),
      ),
    ).toBe(false);
    const { handle } = setup();
    const tools = rangerTools({ read, arrange: handle }, true);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("workspace_tree_get")).toMatchObject({
      replay: "safe",
      sequential: false,
    });
    expect(byName.get("workspace_tree_move")).toMatchObject({
      replay: "unsafe",
      sequential: true,
    });
    expect(byName.get("workspace_tree_group")?.sequential).toBe(true);
  });
});
