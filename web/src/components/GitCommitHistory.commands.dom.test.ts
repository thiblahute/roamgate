import { inIsolatedChild } from "../testIsolated";
import { describe, expect, mock, test } from "bun:test";

/*
 * Commits' `:` commands in the inspector's prompt: each does what a click
 * does there (Refresh, a commit's row), and `:files` hides the commit list
 * beside the commit, as `:files` hides the tree in Files and Changes.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "Commits' commands in an isolated DOM runtime",
    "ROAMGATE_COMMITS_COMMANDS_DOM_TEST",
    30_000,
  )
) {
  const { installChangesDom } = await import("./changesSurface.testkit");
  await installChangesDom();
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  mock.module("./DiffContentView", () => ({ DiffContentView: () => null }));
  const { inspectorCompletions, runInspectorCommand } = await import(
    "../inspectorCommands"
  );
  const { InspectorCommandsContext, InspectorViewContext } = await import(
    "../useInspectorCommands"
  );
  type Registry = import("../useInspectorCommands").InspectorCommandRegistry;
  type CommandSet = import("../useInspectorCommands").InspectorCommandSet;
  const { GitCommitHistory } = await import("./GitCommitHistory");

  const author = { name: "A", email: "a@example.com", date: "2026-11-01" };
  const commit = (sha: string, subject: string) => ({
    sha,
    short_sha: sha,
    subject,
    author: author.name,
    authored_at: author.date,
  });

  async function mountCommits(compact = false) {
    const parts = new Map<string, CommandSet>();
    const commands = () => [...parts.values()].flatMap((set) => set.commands);
    const registry: Registry = {
      set: (id, _view, set) => {
        if (set) parts.set(id, set);
        else parts.delete(id);
      },
      run: (input) => void runInspectorCommand(commands(), input),
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const client = {
      connectionId: "commits",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "git.commits")
          return {
            head: "aaa111",
            commits: [commit("aaa111", "First"), commit("bbb222", "Second")],
            has_more: false,
            shallow: false,
          };
        if (method === "git.commit")
          return {
            sha: params.sha,
            parents: [],
            base: null,
            message: "message",
            author,
            committer: author,
            entries: [],
          };
        throw new Error(method);
      },
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const settle = async () => {
      for (let round = 0; round < 6; round++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
        });
    };
    await act(async () =>
      root.render(
        createElement(
          InspectorCommandsContext.Provider,
          { value: registry },
          createElement(
            InspectorViewContext.Provider,
            { value: "commits" },
            createElement(GitCommitHistory, {
              client: client as never,
              workspaceId: "w1",
              resourceKey: "commits",
              compact,
              active: true,
            }),
          ),
        ),
      ),
    );
    await settle();
    return {
      calls,
      completions: (typed: string) =>
        inspectorCompletions(commands(), typed).map(([name]) => name),
      async run(input: string) {
        await act(async () => {
          expect(runInspectorCommand(commands(), input)).toBeNull();
        });
        await settle();
      },
      listHidden: () =>
        host
          .querySelector(".git-commit-history")!
          .classList.contains("is-list-hidden"),
      async unmount() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  describe("Commits' `:` commands", () => {
    test(":files hides the commit list beside the commit and shows it again, remembered; :e reads the commits again; :commit 2 picks the second", async () => {
      const commits = await mountCommits();
      try {
        expect(commits.completions("")).toEqual(["reload", "files", "commit"]);
        expect(commits.listHidden()).toBe(false);
        await commits.run("files");
        expect(commits.listHidden()).toBe(true);
        const before = commits.calls.filter(
          (call) => call.method === "git.commits",
        ).length;
        await commits.run("e");
        expect(
          commits.calls.filter((call) => call.method === "git.commits").length,
        ).toBe(before + 1);
        await commits.run("commit 2");
        expect(
          commits.calls
            .filter((call) => call.method === "git.commit")
            .slice(-1)[0]?.params,
        ).toMatchObject({ sha: "bbb222" });
      } finally {
        await commits.unmount();
      }
      // Remembered: the next Commits opens with the list hidden.
      const again = await mountCommits();
      try {
        expect(again.listHidden()).toBe(true);
        await again.run("files");
        expect(again.listHidden()).toBe(false);
      } finally {
        await again.unmount();
      }
      // Compact: the list and the commit are pages already, no :files.
      const compact = await mountCommits(true);
      try {
        expect(compact.completions("f")).toEqual([]);
      } finally {
        await compact.unmount();
      }
    });
  });
}
