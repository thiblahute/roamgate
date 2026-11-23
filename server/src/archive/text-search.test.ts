import { describe, expect, test } from "bun:test";
import {
  grepArgs,
  historyPathspecs,
  lineFilter,
  nodeMatcher,
  nodeTerms,
  parseQuery,
  rankFiles,
  transcriptPathspecs,
} from "./text-search";

describe("queries", () => {
  test("words and phrases must all appear; operators as the index read them", () => {
    const words = parseQuery("git worktree")!;
    expect(grepArgs(words)).toEqual([
      "(",
      "-e",
      "git",
      "--and",
      "-e",
      "worktree",
      ")",
    ]);
    expect(grepArgs(parseQuery('"worktree prune"')!)).toEqual([
      "-e",
      "worktree prune",
    ]);
    expect(grepArgs(parseQuery("a OR b c")!)).toEqual([
      "(",
      "-e",
      "a",
      "--or",
      "(",
      "-e",
      "b",
      "--and",
      "-e",
      "c",
      ")",
      ")",
    ]);
    expect(grepArgs(parseQuery("a NOT b")!)).toEqual([
      "(",
      "-e",
      "a",
      "--and",
      "--not",
      "-e",
      "b",
      ")",
    ]);
    expect(parseQuery("  ")).toBeNull();
    expect(nodeTerms(parseQuery('x* "y z" NOT w'))).toEqual(["x", "y z"]);
  });

  test("the same query tests a text for the raw/ search", () => {
    const match = nodeMatcher(parseQuery("(alpha OR beta) NOT gamma")!);
    expect(match("an alpha here")).toBe(true);
    expect(match("beta and gamma")).toBe(false);
    expect(match("delta")).toBe(false);
  });
});

describe("filters", () => {
  test("host, agent and project are pathspecs; state and history excluded", () => {
    expect(transcriptPathspecs({})).toEqual([
      ":(exclude).roamgate",
      ":(exclude,glob)*/@history/**",
    ]);
    expect(transcriptPathspecs({ host: "mac" })[0]).toBe(":(glob)mac/*/**");
    expect(transcriptPathspecs({ agent: "codex" })[0]).toBe(
      ":(glob)*/codex/**",
    );
    expect(transcriptPathspecs({ project: "my proj*" })[0]).toBe(
      ":(glob)*/*/*my_proj_*/**",
    );
    expect(historyPathspecs("mac")).toEqual([":(glob)mac/@history/**"]);
  });

  test("role, kind and the time range are checked on each line", () => {
    const keep = lineFilter({ role: "user", since: "2026-11-02" });
    const line = (role: string, ts: string | null) => ({
      ts,
      role,
      kind: "text",
      tool: null,
      text: "",
    });
    expect(keep(line("user", "2026-11-03T00:00:00"))).toBe(true);
    expect(keep(line("assistant", "2026-11-03T00:00:00"))).toBe(false);
    expect(keep(line("user", "2026-11-01T00:00:00"))).toBe(false);
    expect(keep(line("user", null))).toBe(false);
  });

  test("ranked by matches, then recency; or recency first", () => {
    const files = [
      { path: "a", count: 1, lastTs: "2026-11-09", recent: [] },
      { path: "b", count: 3, lastTs: "2026-11-01", recent: [] },
      { path: "c", count: 3, lastTs: "2026-11-05", recent: [] },
    ];
    expect(rankFiles([...files], false).map((f) => f.path)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(rankFiles([...files], true).map((f) => f.path)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
});
