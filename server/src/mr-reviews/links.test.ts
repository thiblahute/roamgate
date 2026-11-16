import { describe, expect, test } from "bun:test";
import type { MrConnection } from "./clones";
import {
  createWorkspaceLinker,
  matchWorkspaces,
  parseWorkspaceScan,
  type ScannedWorkspace,
  workspaceScript,
} from "./links";

const item = {
  key: "gitlab:gitlab.example.org/group/app#12",
  host: "gitlab.example.org",
  project: "group/app",
  provider: "gitlab" as const,
  number: 12,
  sourceBranch: "fix-pitch",
  targetBranch: "main",
};

const ws = (over: Partial<ScannedWorkspace>): ScannedWorkspace => ({
  connectionId: "local",
  connectionLabel: "Desktop",
  workspaceId: "w1",
  label: "work",
  remotes: ["git@gitlab.example.org:group/app.git"],
  ...over,
});

describe("a request's workspaces", () => {
  test("on its branch in a clone of the project, or tracking it", () => {
    const links = matchWorkspaces(item, [
      ws({ workspaceId: "a", branch: "fix-pitch" }),
      ws({ workspaceId: "b", branch: "local-name", upstream: "me/fix-pitch" }),
      // Same branch name in another project: not it.
      ws({
        workspaceId: "c",
        branch: "fix-pitch",
        remotes: ["https://github.com/other/thing.git"],
      }),
      // A fork of the project, by its repository name on the same host.
      ws({
        workspaceId: "d",
        connectionId: "mac",
        connectionLabel: "Mac",
        branch: "fix-pitch",
        remotes: ["https://gitlab.example.org/me/app.git"],
      }),
      ws({ workspaceId: "e", branch: "main" }),
    ]);
    expect(links.map((link) => [link.workspaceId, link.why])).toEqual([
      ["a", ["branch"]],
      ["b", ["branch"]],
      ["d", ["branch"]],
    ]);
    expect(links[2]!.connectionLabel).toBe("Mac");
  });

  test("by its name, its review workspace; the target branch never", () => {
    const links = matchWorkspaces(
      { ...item, sourceBranch: "main" },
      [
        ws({ workspaceId: "a", label: "app !12 pitch", branch: "main" }),
        ws({ workspaceId: "b", label: "app !123" }),
        ws({ workspaceId: "c", label: "mr-12 scratch", remotes: [] }),
        ws({ workspaceId: "r", label: "Reviews · app" }),
        ws({
          workspaceId: "x",
          label: "!12 elsewhere",
          remotes: ["https://github.com/other/thing.git"],
        }),
      ],
      { connectionId: "local", workspaceId: "r" },
    );
    expect(links.map((link) => [link.workspaceId, link.why])).toEqual([
      ["a", ["name"]],
      ["c", ["name"]],
      ["r", ["review"]],
    ]);
  });

  test("none: nothing", () => {
    expect(matchWorkspaces(item, [ws({ branch: "other" })])).toEqual([]);
  });
});

describe("scanning the connections", () => {
  test("the script and its parse", () => {
    expect(workspaceScript(["/a b"])).toContain("'/a b'");
    const scan = parseWorkspaceScan(
      "W\t/r/app\nB\tfix-pitch\nU\torigin/fix-pitch\nM\tgit@h:g/app.git\nW\t/tmp\n",
    );
    expect(scan.get("/r/app")).toEqual({
      branch: "fix-pitch",
      upstream: "origin/fix-pitch",
      remotes: ["git@h:g/app.git"],
    });
    expect(scan.get("/tmp")).toEqual({ remotes: [] });
  });

  test("every connection, its workspaces read once a minute", async () => {
    let now = 0;
    const runs: string[] = [];
    const connection = (id: string, label: string): MrConnection => ({
      id,
      label,
      dirs: async () => [],
      // The Mac's workspace is no checkout itself: its pane's folder is.
      herdr: async (method: string) =>
        method === "pane.list"
          ? { panes: [{ workspace_id: `${id}-w`, cwd: `/${id}/app` }] }
          : {
              workspaces: [
                {
                  workspace_id: `${id}-w`,
                  label: "pitch",
                  ...(id === "mac"
                    ? {}
                    : { worktree: { checkout_path: `/${id}/app` } }),
                },
              ],
            },
      run: async () => {
        runs.push(id);
        return {
          code: 0,
          stderr: "",
          stdout: `W\t/${id}/app\nB\tfix-pitch\nM\thttps://gitlab.example.org/group/app\n`,
        };
      },
    });
    const broken: MrConnection = {
      ...connection("down", "Down"),
      herdr: async () => {
        throw new Error("gone");
      },
    };
    const linker = createWorkspaceLinker({
      connections: () => [
        connection("local", "Desktop"),
        broken,
        connection("mac", "Mac"),
      ],
      now: () => now,
    });
    const full = {
      ...item,
      url: "u",
      title: "t",
      author: "me",
      draft: false,
      state: "open" as const,
      updatedAt: "",
      headSha: "",
      pipeline: null,
      notes: 0,
      reasons: [],
    };
    const links = await linker.links([full], {});
    expect(links[item.key]!.map((link) => link.workspaceId)).toEqual([
      "local-w",
      "mac-w",
    ]);
    await linker.links([full], {});
    expect(runs).toEqual(["local", "mac"]);
    now += 61_000;
    await linker.links([full], {});
    expect(runs).toEqual(["local", "mac", "local", "mac"]);
  });
});
