import { describe, expect, test } from "bun:test";
import {
  lastChangesRepo,
  rememberChangesRepo,
  repoResourceKey,
  repoRootOf,
  workspaceRepoDirs,
} from "./changesRepo";
import type { Pane } from "./types";

describe("the repository Changes shows", () => {
  test("another repository's changes have their own key, which names it", () => {
    expect(repoResourceKey("ws", undefined)).toBe("ws");
    const key = repoResourceKey("ws", "/repo/b");
    expect(key).not.toBe("ws");
    expect(repoRootOf(key)).toBe("/repo/b");
    expect(repoRootOf("ws")).toBeUndefined();
    expect(repoRootOf(undefined)).toBeUndefined();
  });

  test("the panes' directories, and the agents' own", () => {
    const panes = [
      { pane_id: "a", cwd: "/repo/a", foreground_cwd: "/repo/a/sub" },
      { pane_id: "b", cwd: "/repo/b", agent: "claude" },
      { pane_id: "c", cwd: "relative" },
      { pane_id: "d", cwd: "/repo/b" },
    ] as unknown as Pane[];
    expect(workspaceRepoDirs(panes)).toEqual({
      dirs: ["/repo/a/sub", "/repo/b"],
      agentDirs: ["/repo/b"],
    });
  });

  test("the last one shown is remembered, the workspace's own as empty", () => {
    expect(lastChangesRepo("k")).toBeUndefined();
    rememberChangesRepo("k", "/repo/b");
    expect(lastChangesRepo("k")).toBe("/repo/b");
    rememberChangesRepo("k", undefined);
    expect(lastChangesRepo("k")).toBe("");
  });
});
