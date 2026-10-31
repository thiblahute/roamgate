import { describe, expect, test } from "bun:test";
import type { GitStatusSummary, Workspace } from "./types";
import {
  connectionDotColor,
  shortWorkspaceName,
  showWorkspaceBranchBadge,
  workspaceBranchLine,
  workspaceChangeIndicator,
  workspaceDisplayName,
} from "./workspaceTreeBadges";

function workspace({
  label,
  branch,
  linked = true,
}: {
  label: string;
  branch?: string;
  linked?: boolean;
}): Workspace {
  const gitStatus: GitStatusSummary = {
    branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    dirty: false,
  };
  return {
    workspace_id: "w1",
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown",
    worktree: {
      repo_key: "/repo/.git",
      repo_name: "repo",
      repo_root: "/repo",
      checkout_path: linked ? "/repo-worktree" : "/repo",
      is_linked_worktree: linked,
      git_status: gitStatus,
    },
  };
}

describe("workspace tree badges", () => {
  test("hides a redundant branch badge for matching linked worktree names", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "feature", branch: "feature" }),
      ),
    ).toBe(false);
  });

  test("normalizes incidental whitespace before comparing names", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "feature ", branch: " feature" }),
      ),
    ).toBe(false);
  });

  test("keeps branch badges when the visible name differs", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "Feature workspace", branch: "feature" }),
      ),
    ).toBe(true);
  });

  test("keeps branch badges for main checkouts and missing branch names", () => {
    expect(
      showWorkspaceBranchBadge(
        workspace({ label: "main", branch: "main", linked: false }),
      ),
    ).toBe(true);
    expect(showWorkspaceBranchBadge(workspace({ label: "feature" }))).toBe(
      true,
    );
  });

  test("falls back to the workspace id for the visible name", () => {
    const target = workspace({ label: "", branch: "w1" });
    expect(workspaceDisplayName(target)).toBe("w1");
    expect(showWorkspaceBranchBadge(target)).toBe(false);
  });
});

describe("what a narrow row shows", () => {
  test("a worktree drops the prefix it repeats from its parent", () => {
    expect(shortWorkspaceName("gstreamer-ocio", "gstreamer")).toBe("ocio");
    expect(shortWorkspaceName("gstreamer_up/color", "gstreamer")).toBe(
      "up/color",
    );
    expect(shortWorkspaceName("Roamgate.tree", "roamgate")).toBe("tree");
  });

  test("anything else is shown whole", () => {
    // Not at a separator: a different word.
    expect(shortWorkspaceName("gstreamerocio", "gstreamer")).toBe(
      "gstreamerocio",
    );
    expect(shortWorkspaceName("gst-ocio", "gstreamer")).toBe("gst-ocio");
    expect(shortWorkspaceName("gstreamer", "gstreamer")).toBe("gstreamer");
    // Nothing left after the separator.
    expect(shortWorkspaceName("gstreamer--", "gstreamer")).toBe("gstreamer--");
    expect(shortWorkspaceName("notes")).toBe("notes");
    expect(shortWorkspaceName("notes", "  ")).toBe("notes");
  });

  test("the branch line appears only when it says something new", () => {
    expect(
      workspaceBranchLine(workspace({ label: "ocio", branch: "ocio" })),
    ).toBe(null);
    expect(
      workspaceBranchLine(
        workspace({ label: "gstreamer-ocio", branch: "ocio" }),
        "ocio",
      ),
    ).toBe(null);
    expect(
      workspaceBranchLine(workspace({ label: "gstreamer", branch: "main" })),
    ).toBe("main");
    expect(workspaceBranchLine(workspace({ label: "notes" }))).toBe(null);
  });

  test("one change indicator: changes first, else ahead and behind", () => {
    const status = (over: Partial<GitStatusSummary>): GitStatusSummary => ({
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      dirty: false,
      ...over,
    });
    expect(
      workspaceChangeIndicator(status({ staged: 2, untracked: 10, ahead: 1 })),
    ).toEqual({ text: "Δ12", kind: "dirty" });
    expect(workspaceChangeIndicator(status({ ahead: 1 }))).toEqual({
      text: "↑1",
      kind: "ahead",
    });
    expect(workspaceChangeIndicator(status({ behind: 4 }))).toEqual({
      text: "↓4",
      kind: "behind",
    });
    expect(workspaceChangeIndicator(status({ ahead: 1, behind: 4 }))).toEqual({
      text: "↑1↓4",
      kind: "behind",
    });
    expect(workspaceChangeIndicator(status({}))).toBeNull();
    expect(workspaceChangeIndicator(undefined)).toBeNull();
    expect(workspaceChangeIndicator(status({ error: "boom" }))?.kind).toBe(
      "error",
    );
  });

  test("a connection keeps its dot colour", () => {
    expect(connectionDotColor("desktop")).toBe(connectionDotColor("desktop"));
    const colors = new Set(
      ["desktop", "laptop", "win10", "server"].map(connectionDotColor),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
