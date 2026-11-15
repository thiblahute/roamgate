import { describe, expect, test } from "bun:test";
import {
  lastChangesRepo,
  rememberChangesRepo,
  repoResourceKey,
  repoFeedback,
  repoRootOf,
  workspaceRepoDirs,
} from "./changesRepo";
import type { ReviewThread } from "../../shared/review";
import type { ReviewAnnotation } from "./annotations";
import type { Pane } from "./types";

const note = (id: string, root?: string): ReviewAnnotation => ({
  id,
  source: "diff",
  path: "README.md",
  kind: "unstaged",
  side: "new",
  line: 1,
  hunk: "",
  quote: "x",
  comment: id,
  createdAt: 1,
  ...(root ? { root } : {}),
});
const threadOf = (id: string, sessionId: string) =>
  ({ id, sessionId }) as unknown as ReviewThread;

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

describe("the comments of the repository Changes shows", () => {
  // Two repositories of a workspace, both with a README.md.
  const roots: Record<string, string> = { sa: "/w/a", sb: "/w/b/" };
  const rootOf = (sessionId: string) => roots[sessionId];
  const annotations = [
    note("ta"),
    note("tb"),
    note("kept-b", "/w/b"),
    note("kept-own"),
  ];
  const threads = [threadOf("ta", "sa"), threadOf("tb", "sb")];

  test("a thread of another repository's file of the same path is not the shown one's", () => {
    const shownB = repoFeedback(annotations, threads, rootOf, {
      root: "/w/b",
      own: false,
    });
    expect(shownB.threads.map((each) => each.id)).toEqual(["tb"]);
    expect(shownB.annotations.map((each) => each.id)).toEqual(["tb", "kept-b"]);
    const shownA = repoFeedback(annotations, threads, rootOf, {
      root: "/w/a/",
      own: true,
    });
    expect(shownA.threads.map((each) => each.id)).toEqual(["ta"]);
    expect(shownA.annotations.map((each) => each.id)).toEqual([
      "ta",
      "kept-own",
    ]);
  });

  test("without a repository named, every comment stays", () => {
    const all = repoFeedback(annotations, threads, rootOf, undefined);
    expect(all.threads).toHaveLength(2);
    expect(all.annotations).toHaveLength(4);
  });
});
